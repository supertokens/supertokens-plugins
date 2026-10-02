import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { parseRowndCsv } from "./reconcileCsv";
import { DuckDBInstance } from "@duckdb/node-api";

const exec = promisify(execFile);
let home: string;
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "rownd-bundled-cli-"));
  await exec("npm", ["run", "build"]);
}, 30000);
afterAll(async () => { await rm(home, { recursive: true, force: true }); });

async function cli(args: string[], preload?: string) {
  try {
    const result = await exec(process.execPath, [...(preload ? ["--require", preload] : []),
      "dist/cli.js", ...args], {
      env: { ...process.env, HOME: home, ...(preload ? { NODE_OPTIONS: `--require=${preload}` } : {}) }, timeout: 15000,
    });
    return { ...result, code: 0 };
  } catch (error) {
    const failure = error as { stdout: string; stderr: string; code: number };
    return { stdout: failure.stdout, stderr: failure.stderr, code: failure.code };
  }
}

it("uses only snapshot sources in packaged dry-run and execution commands", async () => {
  const file = join(home, "snapshot.duckdb");
  const db = await DuckDBInstance.create(file);
  const connection = await db.connect();
  try {
    await connection.run("CREATE TABLE migration_runs (id VARCHAR)");
    await connection.run("INSERT INTO migration_runs VALUES ('snapshot-run')");
    await connection.run("CREATE TABLE migration_entries (run_id VARCHAR, source_key VARCHAR, source_payload VARCHAR)");
    await connection.run("INSERT INTO migration_entries VALUES ('snapshot-run', 'disabled', ?)",
      [JSON.stringify({ state: "disabled", data: { user_id: "disabled" } })]);
  } finally { connection.closeSync(); db.closeSync(); }
  const preload = join(home, "no-rownd.cjs");
  await writeFile(preload, `const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  if (new URL(String(input)).hostname !== '127.0.0.1') throw new Error('unexpected remote request');
  return originalFetch(input, options);
};
const Module = require('node:module');
const original = Module._load;
Module._load = function(id, ...args) {
  if (id === '@rownd/node') return { createInstance: () => { throw new Error('Rownd SDK must not be initialized'); } };
  return original.call(this, id, ...args);
};\n`);
  const unexpected: string[] = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url!, "http://localhost").pathname;
    const body = path === "/apiversion" ? { versions: ["5.4"] } :
      path === "/recipe/userid/map" ? { status: "UNKNOWN_MAPPING_ERROR" } :
      path === "/user" ? { status: "UNKNOWN_USER_ID_ERROR" } :
      path === "/recipe/user/metadata" ? { status: "OK", metadata: {} } : undefined;
    if (!body || req.method !== "GET") unexpected.push(`${req.method} ${path}`);
    res.writeHead(body ? 200 : 500, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body ?? {}));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No server address");
    expect((await cli(["profiles", "add", "--profile", "snapshot", "--app-id", "app", "--app-key", "unused-key",
      "--app-secret", "unused-secret", "--connection-uri", `http://127.0.0.1:${address.port}`])).code).toBe(0);
    const csv = join(home, "snapshot-users.csv");
    await writeFile(csv, "rownd_user_id\ndisabled\nmissing\n");
    for (const dryRun of [true, false]) {
      const result = await cli(["reconcile-csv", "--profile", "snapshot", "--file", csv, "--duckdb", file,
        "--concurrency", "2", ...(dryRun ? ["--dry-run"] : [])], preload);
      expect(result.code, result.stderr).toBe(1);
      const results = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
      expect(unexpected).toEqual([]);
      expect(results.find((entry) => entry.result?.rownd_user_id === "missing")?.result).toMatchObject({
        status: "BLOCKED", message: "SOURCE_NOT_IN_SNAPSHOT: required Rownd user is missing from the selected migration run",
      });
      expect(results.find((entry) => entry.result?.rownd_user_id === "disabled")?.result).toMatchObject({
        status: "BLOCKED", message: "Rownd source is not the requested enabled user",
      });
      expect(results.at(-1)).toMatchObject({ type: "summary", failed: 2 });
      expect(result.stderr).toContain('source=duckdb run-id="snapshot-run"');
    }
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}, 20000);

it("bundles plural commands and reports safe validation failures with nonzero exits", async () => {
  const args = ["profiles", "add", "--profile", "stardust", "--app-id", "app", "--app-key", 'key"\\value', "--app-secret", 'secret"\\value', "--connection-uri", "http://localhost:3567"];
  const added = await cli(args);
  expect(added.code).toBe(0);
  expect(added.stdout).not.toContain("value");
  const duplicate = await cli(args);
  expect(duplicate.code).toBe(1);
  expect(duplicate.stderr).toContain("Profile already exists");
  const missing = await cli(["profiles", "show", "--profile", "missing"]);
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain("Profile not found");
  const invalid = await cli(["reconcile-user", "--profile", "stardust", "--email", "a", "--rownd-user-id", "b"]);
  expect(invalid.code).toBe(1);
  expect(invalid.stderr).toContain("exactly one");
  const unknown = await cli(["unknown-command"]);
  expect(unknown.code).toBe(1);
  expect(unknown.stderr).toContain("Unknown command");
  const credentials = await cli(["profiles", "add", "--profile", "uri", "--app-id", "app", "--app-key", "key", "--app-secret", "secret", "--connection-uri", "http://user:pass%22word@localhost"]);
  expect(credentials.code).toBe(1);
  expect(credentials.stderr).toContain("without embedded credentials");
  expect(credentials.stdout + credentials.stderr).not.toContain("pass%22word");
  expect((await cli(["profiles", "list"])).stdout).toContain("stardust");
});

it("initializes packaged reconciliation against a local failing Core and emits safe JSON", async () => {
  // Prevent SDK construction from contacting Rownd; only the local Core is exercised.
  const preload = join(home, "rownd-stub.cjs");
  await writeFile(preload, `const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  if (!['127.0.0.1', 'localhost'].includes(new URL(String(input)).hostname)) throw new Error('unexpected remote request');
  return originalFetch(input, options);
};
const stub = { createInstance: () => ({ validateToken: async () => { throw new Error('unexpected token'); }, fetchUserInfo: async () => undefined }) };
const Module = require('node:module');
const original = Module._load;
Module._load = function(id, ...args) {
  if (id === '@rownd/node') return stub;
  return original.call(this, id, ...args);
};\n`);
  let requests = 0;
  const methods: string[] = [];
  const server = createServer((req, res) => { requests++; methods.push(req.method!); res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ message: 'secret"\\value http://user:pass%22word@localhost' })); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No local server address");
    const added = await cli(["profiles", "add", "--profile", "local", "--app-id", "app", "--app-key", "key", "--app-secret", 'secret"\\value', "--connection-uri", `http://127.0.0.1:${address.port}`]);
    expect(added.code).toBe(0);
    const result = await cli(["reconcile-user", "--profile", "local", "--supertokens-user-id", "missing"], preload);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "ERROR", changed: false });
    expect(result.stderr).toContain("[reconcile] discovery");
    expect(result.stdout).not.toContain("[reconcile]");
    expect(requests).toBeGreaterThan(0);
    expect(result.stdout + result.stderr).not.toContain("pass%22word");
    expect(result.stdout + result.stderr).not.toContain("secret");
    const dryRun = await cli(["reconcile-user", "--profile", "local", "--supertokens-user-id", "missing", "--dry-run"], preload);
    expect(dryRun.code, dryRun.stderr).toBe(1);
    expect(JSON.parse(dryRun.stdout)).toMatchObject({ status: "ERROR", dryRun: true, changed: false });
    expect(dryRun.stdout + dryRun.stderr).not.toContain("pass%22word");
    expect(dryRun.stdout + dryRun.stderr).not.toContain("secret");
    const override = await cli(["reconcile-user", "--profile", "local", "--rownd-user-id", "missing", "--dry-run", "--override-placeholder-provenance"], preload);
    expect(JSON.parse(override.stdout)).toMatchObject({ status: "ERROR", dryRun: true, changed: false });
    const csv = join(home, "users.csv");
    await writeFile(csv, 'note,Rownd ID\r\n"quoted, note",user_a\r\nsecond,user_b\r\nduplicate,user_a\r\n');
    const profilePath = join(home, ".config", "rownd-nodejs", "profiles.json");
    const before = await readFile(profilePath, "utf8");
    const mode = (await stat(profilePath)).mode;
    methods.length = 0;
    const failedFile = join(home, "failed.csv");
    const batch = await cli(["reconcile-csv", "--profile", "local", "--file", csv, "--id-column", "Rownd ID",
      "--concurrency", "2", "--failed-file", failedFile, "--dry-run", "--override-placeholder-provenance"], preload);
    expect(batch.code).toBe(1);
    const lines = batch.stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(3);
    expect(lines.slice(0, 2).sort((a, b) => a.index - b.index)).toMatchObject([
      { type: "result", result: { rownd_user_id: "user_a", status: "ERROR", dryRun: true, changed: false } },
      { type: "result", result: { rownd_user_id: "user_b", status: "ERROR", dryRun: true, changed: false } },
    ]);
    expect(lines[2]).toMatchObject({ type: "summary", total: 2, duplicatesSkipped: 1, failed: 2 });
    expect(methods.length).toBeGreaterThan(0);
    expect(methods.every((method) => method === "GET")).toBe(true);
    expect(await readFile(profilePath, "utf8")).toBe(before);
    expect((await stat(profilePath)).mode).toBe(mode);
    expect(batch.stdout + batch.stderr).not.toContain("secret");
    expect(batch.stdout + batch.stderr).not.toContain("pass%22word");
    expect(batch.stderr).toContain("[reconcile-csv] running | 0/2");
    expect(batch.stderr).toContain("[reconcile-csv] complete | 2/2 (100.0%)");
    expect(batch.stderr).toContain("users/s avg");
    expect(batch.stdout).not.toContain("[reconcile-csv]");
    const saved = await readFile(failedFile, "utf8");
    expect(saved.split("\n")[0]).toBe("rownd_user_id,status,error_code,error_message");
    expect(parseRowndCsv(saved).userIds.sort()).toEqual(["user_a", "user_b"]);
    expect(saved).toContain('"ERROR"');
    expect(saved).toContain("Reconciliation failed; check profile configuration and service availability");
    const beforeRejected = requests;
    const cannotOverwrite = await cli(["reconcile-csv", "--profile", "local", "--file", csv, "--id-column", "Rownd ID", "--failed-file", csv], preload);
    expect(cannotOverwrite.code).toBe(1);
    expect(cannotOverwrite.stderr).toContain("choose a new file");
    const invalidWorkers = await cli(["reconcile-csv", "--profile", "local", "--file", csv, "--concurrency", "0"], preload);
    expect(invalidWorkers.code).toBe(1);
    expect(invalidWorkers.stderr).toContain("positive integer");
    expect(requests).toBe(beforeRejected);
    await writeFile(csv, "rownd_user_id,note\nuser_a,valid\n,invalid");
    const requestsBefore = requests;
    const invalidCsv = await cli(["reconcile-csv", "--profile", "local", "--file", csv], preload);
    expect(invalidCsv.code).toBe(1);
    expect(invalidCsv.stderr).toContain("CSV record 3");
    expect(invalidCsv.stdout).toBe("");
    expect(requests).toBe(requestsBefore);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}, 20000);

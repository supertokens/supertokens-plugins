import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openDuckdbRowndClient } from "./duckdbRowndClient";
import { setRowndClient, withFreshRowndReads } from "../src/rownd-repository";
import { fetchAdministrativeMigrationSource, assertAuthenticatedMigrationSource } from "../src/migration-email";
import { inspectAdministrativeElection } from "../src/migration-election";

vi.mock("../src/migration-mapping", () => ({ assertMigrationSourceActive: vi.fn() }));

let directory: string;
let snapshot: Awaited<ReturnType<typeof openDuckdbRowndClient>> | undefined;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "rownd-duckdb-")); });
afterEach(async () => {
  setRowndClient(undefined);
  await snapshot?.close();
  snapshot = undefined;
  await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function fixture(runs: string[], entries: Array<[string, string, unknown]>) {
  const file = join(directory, "source.duckdb");
  const db = await DuckDBInstance.create(file);
  const connection = await db.connect();
  try {
    await connection.run("CREATE TABLE migration_runs (id VARCHAR)");
    await connection.run("CREATE TABLE migration_entries (run_id VARCHAR, source_key VARCHAR, source_payload VARCHAR)");
    for (const run of runs) await connection.run("INSERT INTO migration_runs VALUES (?)", [run]);
    for (const [run, key, payload] of entries) await connection.run("INSERT INTO migration_entries VALUES (?, ?, ?)",
      [run, key, typeof payload === "string" ? payload : JSON.stringify(payload)]);
  } finally { connection.closeSync(); db.closeSync(); }
  return file;
}

it("uses raw profiles for fresh reads, verification and additional election candidates without network access", async () => {
  const profile = { state: "enabled", data: { user_id: "winner", email: "shared@example.com", google_id: "old" },
    verified_data: { email: true, google_id: "verified-subject" }, meta: { last_active: "2026-09-30T00:00:00Z" } };
  const file = await fixture(["run"], [["run", "winner", profile], ["run", "other", {
    data: { user_id: "other", email: "shared@example.com" }, meta: { last_active: "2026-09-01T00:00:00Z" },
  }]]);
  const before = await readFile(file);
  const modified = (await stat(file)).mtimeMs;
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request"));
  snapshot = await openDuckdbRowndClient(file);
  setRowndClient(snapshot.client);
  await withFreshRowndReads(async () => {
    const source = (await fetchAdministrativeMigrationSource("winner", "public", {}))!;
    expect(source.loginMethods).toEqual(expect.arrayContaining([
      expect.objectContaining({ recipeId: "passwordless", email: "shared@example.com", isVerified: true }),
      expect.objectContaining({ thirdPartyId: "google", thirdPartyUserId: "verified-subject" }),
    ]));
    await expect(assertAuthenticatedMigrationSource(source, "public")).resolves.toEqual(profile);
    const election = await inspectAdministrativeElection([{ rownd_user_id: "winner" }, { rownd_user_id: "other" }]);
    expect(election.winner.rownd_user_id).toBe("winner");
  });
  const first = await snapshot.client.fetchUserInfo({ user_id: "winner" });
  first!.data.email = "modified@example.com";
  expect(await snapshot.client.fetchFreshUserInfo!({ user_id: "winner" })).toEqual(profile);
  expect(network).not.toHaveBeenCalled();
  await snapshot.close();
  expect(await readFile(file)).toEqual(before);
  expect((await stat(file)).mtimeMs).toBe(modified);
});

it("requires a run when ambiguous and keeps parameterized lookups within that run", async () => {
  const key = "key' OR true --";
  const file = await fixture(["first", "second"], [
    ["first", key, { data: { user_id: key, email: "first@example.com" } }],
    ["second", key, { data: { user_id: key, email: "second@example.com" } }],
  ]);
  await expect(openDuckdbRowndClient(file)).rejects.toThrow("multiple migration runs");
  await expect(openDuckdbRowndClient(file, "missing")).rejects.toThrow("No matching migration run");
  snapshot = await openDuckdbRowndClient(file, "second");
  expect((await snapshot.client.fetchUserInfo({ user_id: key }))!.data.email).toBe("second@example.com");
});

it("blocks missing, duplicate, mismatched and invalid sources without poisoning concurrent lookups", async () => {
  const file = await fixture(["run"], [
    ["run", "duplicate", { data: { user_id: "duplicate" } }], ["run", "duplicate", { data: { user_id: "duplicate" } }],
    ["run", "mismatch", { data: { user_id: "someone-else" } }], ["run", "json", "not json"],
    ["run", "shape", { raw_data: "not a Rownd profile" }], ["run", "ok", { data: { user_id: "ok" } }],
  ]);
  snapshot = await openDuckdbRowndClient(file);
  await Promise.all([
    ["missing", "SOURCE_NOT_IN_SNAPSHOT"], ["duplicate", "SNAPSHOT_SOURCE_AMBIGUOUS"],
    ["mismatch", "SOURCE_ID_MISMATCH"], ["json", "SNAPSHOT_PAYLOAD_INVALID"], ["shape", "SOURCE_PAYLOAD_INVALID"],
  ].map(async ([user_id, code]) => {
    await expect(snapshot!.client.fetchFreshUserInfo!({ user_id: user_id! })).rejects.toThrow(code);
  }));
  expect(await snapshot.client.fetchUserInfo({ user_id: "ok" })).toEqual({ data: { user_id: "ok" } });
});

it("does not create a database for a nonexistent path", async () => {
  const file = join(directory, "missing.duckdb");
  await expect(openDuckdbRowndClient(file)).rejects.toThrow("Cannot open DuckDB read-only");
  await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
});

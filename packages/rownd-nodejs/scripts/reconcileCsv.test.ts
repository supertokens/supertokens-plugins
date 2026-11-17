import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { expect, it } from "vitest";
import type { ReconcileUserInput, ReconcileUserResult } from "../src/reconcile-user";
import type { Profile } from "./profiles";
import { parseRowndCsv, reconcileCsv } from "./reconcileCsv";
import { createFailedIdsFile, type ReconcileFailure } from "./failedIds";

const profile: Profile = { rownd: { appId: "app", appKey: "secret-key", appSecret: 'secret"\\value' },
  supertokens: { connectionURI: "http://localhost:3567", tenantId: "public" } };

it("reads BOM, quoted commas, escaped quotes, multiline fields and CRLF while deduplicating IDs", () => {
  expect(parseRowndCsv('\uFEFFrownd_user_id,note\r\nuser_a,"first, entry"\r\nuser_b,"two\r\nlines and ""quotes"""\r\n\r\n user_a ,duplicate\r\n'))
    .toEqual({ userIds: ["user_a", "user_b"], duplicates: 1 });
  expect(parseRowndCsv('note,"Rownd ID"\n"",user_c', "Rownd ID"))
    .toEqual({ userIds: ["user_c"], duplicates: 0 });
});

it.each([
  ["", "empty"],
  ["email\na@example.com", "column not found"],
  ["rownd_user_id,rownd_user_id\na,b", "more than once"],
  ["rownd_user_id\n", "no Rownd IDs"],
  ["rownd_user_id,note\nuser_a,good\n,missing", "record 3 requires"],
  ["rownd_user_id\nuser_a,extra", "number of columns"],
  ['rownd_user_id\n"user_a', "unterminated"],
  ['rownd_user_id\n"user_a"suffix', "Malformed CSV"],
  ['rownd_user_id\nuser_"a', "Malformed CSV"],
  ['rownd_user_id\n"user_\na"', "without whitespace"],
  ['rownd_user_id\n"user_\u0000a"', "control characters"],
])("rejects invalid CSV before processing: %j", (csv, message) => {
  expect(() => parseRowndCsv(csv)).toThrow(message);
});

it("processes unique IDs sequentially, continues after failures and sanitizes each result", async () => {
  const lines: string[] = [];
  const calls: ReconcileUserInput[] = [];
  const events: string[] = [];
  const reconcile = async (input: ReconcileUserInput): Promise<ReconcileUserResult> => {
    calls.push(input);
    events.push(`start:${input.rownd_user_id}`);
    await Promise.resolve();
    events.push(`end:${input.rownd_user_id}`);
    if (input.rownd_user_id === "user_b") throw new Error(profile.rownd.appSecret);
    if (input.rownd_user_id === "user_c") return { status: "BLOCKED", changed: false, actions: [], message: profile.rownd.appKey };
    return { status: "OK", changed: true, actions: ["linked_method"] };
  };
  const code = await reconcileCsv({ ...parseRowndCsv("rownd_user_id\nuser_a\nuser_b\nuser_a\nuser_c\nuser_d"), profile, dryRun: false }, (line) => lines.push(line), reconcile);
  expect(code).toBe(1);
  expect(calls).toEqual(["user_a", "user_b", "user_c", "user_d"].map((rownd_user_id) => ({ rownd_user_id, tenantId: "public", dryRun: false })));
  expect(events).toEqual(["user_a", "user_b", "user_c", "user_d"].flatMap((id) => [`start:${id}`, `end:${id}`]));
  const results = lines.map((line) => JSON.parse(line));
  expect(results[1].result).toMatchObject({ status: "ERROR", rownd_user_id: "user_b", changed: null, partialProgress: true });
  expect(results.at(-1)).toEqual({ type: "summary", dryRun: false, total: 4, duplicatesSkipped: 1,
    succeeded: 2, failed: 2, statuses: { OK: 2, ERROR: 1, BLOCKED: 1 } });
  expect(lines.join("\n")).not.toContain("secret");
});

it.each([true, false])("propagates dry run and uses canReconcile for preview exit status: %s", async (canReconcile) => {
  const lines: string[] = [];
  const calls: ReconcileUserInput[] = [];
  const code = await reconcileCsv({ userIds: ["user_a"], duplicates: 0, profile, dryRun: true }, (line) => lines.push(line), async (input) => {
    calls.push(input);
    return { status: "PREVIEW", dryRun: true, changed: false, actions: [], canReconcile, snapshotOnly: true };
  });
  expect(calls).toEqual([{ rownd_user_id: "user_a", tenantId: "public", dryRun: true }]);
  expect(code).toBe(canReconcile ? 0 : 1);
  expect(JSON.parse(lines[0]!).result).toMatchObject({ dryRun: true, changed: false, actions: [], canReconcile });
});

it.each([true, false])("propagates the explicit placeholder override through CSV reconciliation (%s)", async (dryRun) => {
  const calls: ReconcileUserInput[] = [];
  await reconcileCsv({ userIds: ["user_a", "user_b"], duplicates: 0, profile, dryRun, overridePlaceholderProvenance: true }, () => {}, async (input) => {
    calls.push(input);
    return { status: "BLOCKED", changed: false, actions: [] };
  });
  expect(calls).toEqual(["user_a", "user_b"].map((rownd_user_id) => ({ rownd_user_id, tenantId: "public", dryRun, overridePlaceholderProvenance: true })));
});

it("preserves the dry-run contract after an unexpected rejected call", async () => {
  const lines: string[] = [];
  expect(await reconcileCsv({ userIds: ["user_a"], duplicates: 0, profile, dryRun: true }, (line) => lines.push(line), async () => {
    throw new Error("private request contents");
  })).toBe(1);
  expect(JSON.parse(lines[0]!).result).toMatchObject({ status: "ERROR", dryRun: true, changed: false,
    actions: [], canReconcile: false, snapshotOnly: true });
  expect(lines.join("\n")).not.toContain("private");
});

it("records sanitized failure messages, policy codes and execution-proof requirements", async () => {
  const failures: Array<{ id: string } & ReconcileFailure> = [];
  const results: ReconcileUserResult[] = [
    { status: "BLOCKED", changed: false, actions: [], message: "Rownd election owner changed", blockers: [{ code: "POLICY_BLOCKED" }] },
    { status: "PREVIEW", changed: false, actions: [], canReconcile: false,
      requiresExecutionProof: [{ code: "NATIVE_MAPPING_PUBLICATION_REQUIRES_EXECUTION_PROOF" }] },
    { status: "BLOCKED", changed: false, actions: [], message: "MAPPING_TARGET_MISSING: external mapping target does not exist" },
    { status: "ERROR", changed: false, actions: [], message: `Request included ${profile.rownd.appSecret}` },
  ];
  await reconcileCsv({ userIds: ["policy", "proof", "mapping", "transport"], duplicates: 0, profile, dryRun: true,
    recordFailure: async (id, failure) => { failures.push({ id, ...failure }); } }, () => {}, async () => results.shift()!);
  expect(failures).toEqual([
    { id: "policy", status: "BLOCKED", error_code: "POLICY_BLOCKED", error_message: "Rownd election owner changed" },
    { id: "proof", status: "PREVIEW", error_code: "NATIVE_MAPPING_PUBLICATION_REQUIRES_EXECUTION_PROOF",
      error_message: "Reconciliation requires execution-time proof; dry run cannot confirm success" },
    { id: "mapping", status: "BLOCKED", error_code: "MAPPING_TARGET_MISSING", error_message: "MAPPING_TARGET_MISSING: external mapping target does not exist" },
    { id: "transport", status: "ERROR", error_code: "ERROR", error_message: "Reconciliation failed; check profile configuration and service availability" },
  ]);
});

it("preserves elected canonical IDs and records the original CSV ID for retries", async () => {
  const lines: string[] = [];
  const failed: string[] = [];
  expect(await reconcileCsv({ userIds: ["older"], duplicates: 0, profile, dryRun: true,
    recordFailure: async (id) => { failed.push(id); } }, (line) => lines.push(line), async () => ({
    status: "PREVIEW", dryRun: true, changed: false, actions: [], canReconcile: false,
    rownd_user_id: "newer", requested_rownd_user_id: "older",
    election: { basis: "latest_valid_activity", candidates: [{ rownd_user_id: "newer", activity: profile.rownd.appSecret }] },
  }))).toBe(1);
  expect(JSON.parse(lines[0]!).result).toMatchObject({ rownd_user_id: "newer", requested_rownd_user_id: "older",
    election: { candidates: [{ activity: "***" }] } });
  expect(failed).toEqual(["older"]);
  expect(lines.join("\n")).not.toContain("secret");
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

it("bounds concurrent work, replenishes workers and emits results as they finish", async () => {
  const ids = ["a", "b", "c", "d"];
  const pending = ids.map(() => deferred<ReconcileUserResult>());
  const fourthStarted = deferred<void>();
  const started: string[] = [];
  const lines: string[] = [];
  const failures: string[] = [];
  const run = reconcileCsv({ userIds: ids, duplicates: 0, profile, dryRun: false, concurrency: 3,
    recordFailure: async (id) => { failures.push(id); } }, (line) => lines.push(line), async (input) => {
    started.push(input.rownd_user_id!);
    if (input.rownd_user_id === "d") fourthStarted.resolve();
    return pending[ids.indexOf(input.rownd_user_id!)]!.promise;
  });
  expect(started).toEqual(["a", "b", "c"]);
  pending[1]!.resolve({ status: "BLOCKED", changed: false, actions: [] });
  await fourthStarted.promise;
  expect(started).toEqual(ids);
  expect(JSON.parse(lines[0]!)).toMatchObject({ index: 2, result: { rownd_user_id: "b" } });
  for (const index of [0, 2, 3]) pending[index]!.resolve({ status: "OK", changed: false, actions: [] });
  expect(await run).toBe(1);
  expect(failures).toEqual(["b"]);
  expect(JSON.parse(lines.at(-1)!)).toMatchObject({ succeeded: 3, failed: 1, total: 4 });
});

it("stops scheduling on failure-file errors and drains in-flight users before returning", async () => {
  const second = deferred<ReconcileUserResult>();
  const started: string[] = [];
  let settled = false;
  const run = reconcileCsv({ userIds: ["a", "b", "c"], duplicates: 0, profile, dryRun: false, concurrency: 2,
    recordFailure: async () => { throw new Error("disk full"); } }, () => {}, async (input) => {
    started.push(input.rownd_user_id!);
    return input.rownd_user_id === "a" ? { status: "ERROR", changed: null, actions: [] } : second.promise;
  });
  const assertion = expect(run).rejects.toThrow("disk full");
  void run.then(() => { settled = true; }, () => { settled = true; });
  await setImmediate();
  expect(started).toEqual(["a", "b"]);
  expect(settled).toBe(false);
  second.resolve({ status: "OK", changed: false, actions: [] });
  await assertion;
  expect(started).toEqual(["a", "b"]);
});

it("writes concurrent failures as a private retryable CSV without overwriting files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rownd-failed-ids-"));
  try {
    const path = join(dir, "failed.csv");
    const file = await createFailedIdsFile(path);
    const failure = { status: "BLOCKED", error_code: "POLICY_BLOCKED", error_message: 'A "quoted", multiline\nreason' };
    try { await Promise.all(["user_a", 'user_"b', "user_c,d"].map((id) => file.append(id, failure))); } finally { await file.close(); }
    const text = await readFile(path, "utf8");
    expect(parseRowndCsv(text)).toEqual({ userIds: ["user_a", 'user_"b', "user_c,d"], duplicates: 0 });
    expect(text).toContain('"BLOCKED","POLICY_BLOCKED","A ""quoted"", multiline\nreason"');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(createFailedIdsFile(path)).rejects.toThrow("choose a new file");
    expect(await readFile(path, "utf8")).toBe(text);
    const emptyPath = join(dir, "no-failures.csv");
    await (await createFailedIdsFile(emptyPath)).close();
    expect(await readFile(emptyPath, "utf8")).toBe("rownd_user_id,status,error_code,error_message\n");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it.each([0, -1, 1.5, Infinity, NaN])("rejects invalid worker counts before processing: %s", async (concurrency) => {
  await expect(reconcileCsv({ userIds: ["a"], duplicates: 0, profile, dryRun: false, concurrency }, () => {}, async () => {
    throw new Error("should not reconcile");
  })).rejects.toThrow("positive integer");
});

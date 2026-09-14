import { readFile } from "node:fs/promises";
import { reconcileUser, type ReconcileUserInput, type ReconcileUserResult } from "../src/reconcile-user";
import { formatReconcileResult } from "./adminOutput";
import { CliValidationError } from "./cliError";
import type { Profile } from "./profiles";
import type { ReconcileProgress } from "./reconcileProgress";

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let state: "unquoted" | "quoted" | "closed" = "unquoted";
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (state === "quoted") {
      if (char === "\"") {
        if (text[i + 1] === "\"") { field += "\""; i++; } else state = "closed";
      } else field += char;
      continue;
    }
    if (char === "," || char === "\n" || char === "\r") {
      row.push(field);
      field = "";
      state = "unquoted";
      if (char !== ",") {
        rows.push(row);
        row = [];
        if (char === "\r" && text[i + 1] === "\n") i++;
      }
    } else if (char === "\"" && state === "unquoted" && field === "") {
      state = "quoted";
    } else {
      if (state === "closed" || char === "\"") throw new CliValidationError(`Malformed CSV quoting in record ${rows.length + 1}`);
      field += char;
    }
  }
  if (state === "quoted") throw new CliValidationError("CSV has an unterminated quoted field");
  if (row.length || field || state === "closed") rows.push([...row, field]);
  return rows;
}

export function parseRowndCsv(text: string, idColumn = "rownd_user_id") {
  const rows = parseCsv(text.replace(/^\uFEFF/, ""));
  const headerIndex = rows.findIndex((row) => row.length !== 1 || row[0]!.trim() !== "");
  if (headerIndex < 0) throw new CliValidationError("CSV is empty; a header and at least one Rownd ID are required");
  const header = rows[headerIndex]!.map((value) => value.trim());
  const column = header.indexOf(idColumn);
  if (column < 0) throw new CliValidationError("CSV ID column not found; use --id-column to select its header");
  if (header.lastIndexOf(idColumn) !== column) throw new CliValidationError("CSV ID column occurs more than once");
  const userIds = new Set<string>();
  let duplicates = 0;
  for (let i = headerIndex + 1; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.length === 1 && row[0]!.trim() === "") continue;
    if (row.length !== header.length) throw new CliValidationError(`CSV record ${i + 1} has a different number of columns than the header`);
    const id = row[column]!.trim();
    if (!id || /\s/.test(id) || [...id].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
      throw new CliValidationError(`CSV record ${i + 1} requires a non-empty Rownd ID without whitespace or control characters`);
    }
    if (userIds.has(id)) duplicates++;
    else userIds.add(id);
  }
  if (!userIds.size) throw new CliValidationError("CSV contains no Rownd IDs");
  return { userIds: [...userIds], duplicates };
}

export async function readRowndCsv(file: string, idColumn?: string) {
  let text: string;
  try { text = await readFile(file, "utf8"); } catch { throw new CliValidationError("Cannot read CSV file; check --file and file permissions"); }
  return parseRowndCsv(text, idColumn);
}

export async function reconcileCsv(
  input: { userIds: string[]; duplicates: number; profile: Profile; dryRun: boolean; concurrency?: number;
    recordFailure?: (id: string) => Promise<void>; onProgress?: (progress: ReconcileProgress) => void },
  output: (value: string) => void,
  reconcile: (input: ReconcileUserInput) => Promise<ReconcileUserResult> = reconcileUser,
) {
  const concurrency = input.concurrency ?? 1;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new CliValidationError("--concurrency must be a positive integer");
  let succeeded = 0;
  let completed = 0;
  let active = 0;
  const started = performance.now();
  const reportProgress = (state: ReconcileProgress["state"]) => {
    const elapsedSeconds = Math.max(0, (performance.now() - started) / 1000);
    const usersPerSecond = elapsedSeconds > 0 ? completed / elapsedSeconds : 0;
    input.onProgress?.({ state, completed, total: input.userIds.length, active, succeeded,
      failed: completed - succeeded, elapsedSeconds, usersPerSecond,
      etaSeconds: completed === input.userIds.length ? 0 : state === "running" && usersPerSecond > 0
        ? (input.userIds.length - completed) / usersPerSecond : null });
  };
  const statuses: Record<string, number> = {};
  const processUser = async (index: number) => {
    const id = input.userIds[index]!;
    let result: ReconcileUserResult;
    active++;
    try {
      result = await reconcile({ rownd_user_id: id, tenantId: input.profile.supertokens.tenantId, dryRun: input.dryRun });
    } catch {
      result = { status: "ERROR", changed: input.dryRun ? false : null, actions: [],
        ...(input.dryRun ? { dryRun: true, canReconcile: false, matchesSource: false, proposedActions: [],
          missingMethods: [], blockers: [{ code: "OBSERVATION_FAILED" }], requiresExecutionProof: [], snapshotOnly: true } : { partialProgress: true }) };
    } finally { active--; }
    completed++;
    const success = result.status === "OK" || (result.status === "PREVIEW" && result.canReconcile === true);
    if (success) succeeded++;
    statuses[result.status] = (statuses[result.status] ?? 0) + 1;
    output(JSON.stringify({ type: "result", index: index + 1,
      result: JSON.parse(formatReconcileResult({ ...result, rownd_user_id: result.rownd_user_id ?? id,
        requested_rownd_user_id: id }, input.profile)) }));
    if (!success) await input.recordFailure?.(id);
  };
  let next = 0;
  let stopped = false;
  const worker = async () => {
    try {
      while (!stopped && next < input.userIds.length) await processUser(next++);
    } catch (error) {
      stopped = true;
      throw error;
    }
  };
  reportProgress("running");
  const timer = input.onProgress ? setInterval(() => reportProgress("running"), 1000) : undefined;
  let finished = false;
  try {
    // Drain in-flight users before the caller closes the failure file, even on output errors.
    const workers = await Promise.allSettled(Array.from({ length: Math.min(concurrency, input.userIds.length) }, worker));
    for (const result of workers) if (result.status === "rejected") throw result.reason;
    const failed = input.userIds.length - succeeded;
    output(JSON.stringify({ type: "summary", dryRun: input.dryRun, total: input.userIds.length,
      duplicatesSkipped: input.duplicates, succeeded, failed, statuses }));
    finished = true;
    return failed ? 1 : 0;
  } finally {
    if (timer !== undefined) clearInterval(timer);
    reportProgress(finished ? "complete" : "stopped");
  }
}

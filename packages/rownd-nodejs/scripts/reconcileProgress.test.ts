import { afterEach, expect, it, vi } from "vitest";
import type { ReconcileUserResult } from "../src/reconcile-user";
import type { Profile } from "./profiles";
import { reconcileCsv } from "./reconcileCsv";
import { formatReconcileProgress, type ReconcileProgress } from "./reconcileProgress";

const profile: Profile = { rownd: { appId: "app", appKey: "key", appSecret: "secret" },
  supertokens: { connectionURI: "http://localhost:3567", tenantId: "public" } };

afterEach(() => { vi.useRealTimers(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

it("reports every second, calculates average throughput and ETA, and stops reporting on completion", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
  const first = deferred<ReconcileUserResult>();
  const second = deferred<ReconcileUserResult>();
  const progress: ReconcileProgress[] = [];
  const lines: string[] = [];
  const run = reconcileCsv({ userIds: ["a", "b"], duplicates: 4, profile, dryRun: false,
    onProgress: (value) => progress.push(value) }, (line) => lines.push(line),
  async (input) => input.rownd_user_id === "a" ? first.promise : second.promise);
  expect(progress[0]).toMatchObject({ completed: 0, total: 2, usersPerSecond: 0, etaSeconds: null });
  await vi.advanceTimersByTimeAsync(1000);
  expect(progress.at(-1)).toMatchObject({ state: "running", completed: 0, active: 1, elapsedSeconds: 1 });
  first.resolve({ status: "OK", changed: false, actions: [] });
  await vi.advanceTimersByTimeAsync(1000);
  expect(progress.at(-1)).toMatchObject({ completed: 1, total: 2, active: 1, succeeded: 1, failed: 0,
    elapsedSeconds: 2, usersPerSecond: 0.5, etaSeconds: 2 });
  expect(formatReconcileProgress(progress.at(-1)!)).toBe(
    "[reconcile-csv] running | 1/2 (50.0%) | 1 active | 1 succeeded, 0 failed | 0.50 users/s avg | elapsed 2s | ETA 2s",
  );
  second.resolve({ status: "BLOCKED", changed: false, actions: [] });
  expect(await run).toBe(1);
  expect(progress.at(-1)).toMatchObject({ state: "complete", completed: 2, active: 0, succeeded: 1, failed: 1,
    elapsedSeconds: 2, usersPerSecond: 1, etaSeconds: 0 });
  expect(vi.getTimerCount()).toBe(0);
  const count = progress.length;
  await vi.advanceTimersByTimeAsync(3000);
  expect(progress).toHaveLength(count);
  expect(lines.map((line) => JSON.parse(line).type)).toEqual(["result", "result", "summary"]);
});

it("reports stopped work and clears its timer when saving failures fails", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
  const progress: ReconcileProgress[] = [];
  await expect(reconcileCsv({ userIds: ["a", "b"], duplicates: 0, profile, dryRun: true,
    onProgress: (value) => progress.push(value), recordFailure: async () => { throw new Error("disk full"); } },
  () => {}, async () => ({ status: "ERROR", changed: false, actions: [] }))).rejects.toThrow("disk full");
  expect(progress.at(-1)).toMatchObject({ state: "stopped", completed: 1, total: 2, active: 0,
    succeeded: 0, failed: 1, usersPerSecond: 0, etaSeconds: null });
  expect(vi.getTimerCount()).toBe(0);
  expect(formatReconcileProgress(progress.at(-1)!)).not.toMatch(/NaN|Infinity/);
});

it("formats long durations and unknown ETA without logging user data", () => {
  expect(formatReconcileProgress({ state: "running", completed: 0, total: 10, active: 3,
    succeeded: 0, failed: 0, elapsedSeconds: 3661, usersPerSecond: 0, etaSeconds: null }))
    .toBe("[reconcile-csv] running | 0/10 (0.0%) | 3 active | 0 succeeded, 0 failed | 0.00 users/s avg | elapsed 1h 1m | ETA --");
});

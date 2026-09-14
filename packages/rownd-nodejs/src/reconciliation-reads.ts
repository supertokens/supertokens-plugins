import { AsyncLocalStorage } from "node:async_hooks";

type ReadKind = "rownd" | "user" | "mapping" | "metadata" | "search" | "verification";
export type ReconciliationProgress = { stage: "discovery" | "execution" | "verification"; action?: string };
type Context = { reads: Map<ReadKind, Map<string, Promise<unknown>>>; onProgress?: (event: ReconciliationProgress) => void };
const contexts = new AsyncLocalStorage<Context>();

export function withReconciliationReads<T>(action: () => Promise<T>, onProgress?: Context["onProgress"]) {
  return contexts.run({ reads: new Map(), onProgress }, action);
}

export function hasReconciliationReads() {
  return contexts.getStore() !== undefined;
}

export function reconciliationProgress(event: ReconciliationProgress) {
  contexts.getStore()?.onProgress?.(event);
}

export function reconciliationRead<T>(kind: ReadKind, key: string, load: () => Promise<T>): Promise<T> {
  const context = contexts.getStore();
  if (!context) return load();
  let cells = context.reads.get(kind);
  if (!cells) context.reads.set(kind, cells = new Map());
  const existing = cells.get(key);
  if (existing) return existing as Promise<T>;
  const pending = Promise.resolve().then(load);
  cells.set(key, pending);
  void pending.catch(() => { if (cells.get(key) === pending) cells.delete(key); });
  return pending;
}

export function invalidateReconciliationReads(kind?: ReadKind, key?: string) {
  const reads = contexts.getStore()?.reads;
  if (!kind) reads?.clear();
  else if (key === undefined) reads?.delete(kind);
  else reads?.get(kind)?.delete(key);
}

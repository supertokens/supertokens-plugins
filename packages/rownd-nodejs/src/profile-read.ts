import { randomUUID } from "crypto";
import { performance } from "perf_hooks";
import { PLUGIN_VERSION } from "./constants";
import { logDebugMessage } from "./logger";
import type { RowndTelemetryClient, RowndTelemetryEvent } from "./types";

export type ProfileReadMode = "legacy" | "lightweight-v1";
export type ProfileReadKind = "user" | "mapping" | "metadata" | "sessionList" | "sessionDetail";
export type ProfileReader = <T>(kind: ProfileReadKind, key: string, load: () => Promise<T>) => Promise<T>;

// Owned by one read-only assembly, never attached to a reusable request context.
export class ProfileReadOperation {
  readonly id = randomUUID();
  readonly counts = { user: 0, mapping: 0, metadata: 0, sessionList: 0, sessionDetail: 0 };
  private readonly startedAt = performance.now();
  private readonly reads = new Map<string, Promise<unknown>>();

  readonly read: ProfileReader = <T>(kind: ProfileReadKind, key: string, load: () => Promise<T>) => {
    const cacheKey = JSON.stringify([kind, key]);
    let result = this.reads.get(cacheKey);
    if (!result) {
      this.counts[kind]++;
      result = Promise.resolve().then(load);
      this.reads.set(cacheKey, result);
    }
    return result as Promise<T>;
  };

  finish(mode: ProfileReadMode, dynamicConfig: boolean, record?: RowndTelemetryClient["recordEvent"], failed = false) {
    const event: RowndTelemetryEvent = {
      operation: "profile_read", requestId: this.id, pluginVersion: PLUGIN_VERSION,
      durationMs: performance.now() - this.startedAt, stage: "profile_assembly", eventType: "terminal",
      profileMode: mode, profileConfig: dynamicConfig ? "dynamic" : "static",
      profileFallbackReason: mode === "legacy" ? "legacy_contract" : "activity_unavailable",
      sdkCalls: { ...this.counts },
      ...(failed ? { outcome: "error" as const, result: "error" as const, error: { message: "Profile read failed" } }
        : { outcome: "success" as const, result: "success" as const }),
    };
    logDebugMessage(JSON.stringify(event));
    try {
      Promise.resolve(record?.(event)).catch(() => logDebugMessage("Failed to record profile telemetry event."));
    } catch {
      logDebugMessage("Failed to record profile telemetry event.");
    }
    this.reads.clear();
  }
}

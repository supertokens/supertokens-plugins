import { randomUUID } from "crypto";
import { PLUGIN_VERSION } from "../constants";
import type { RowndTelemetryEvent } from "../types";
import { logDebugMessage } from "../logger";

export class MigrationTelemetry {
  readonly requestId = randomUUID();
  private readonly startedAt = Date.now();
  private currentStage = "configuration";
  private stageStartedAt = this.startedAt;
  tenantId?: string;
  rowndUserId?: string;
  canonicalRowndUserId?: string;
  conflictingRowndUserId?: string;
  superTokensUserId?: string;
  recipeId?: string;
  recipeUserId?: string;
  sessionCreated = false;

  constructor(
    private readonly record: (event: RowndTelemetryEvent) => void | Promise<void>,
  ) {}

  get stage() {
    return this.currentStage;
  }

  set stage(value: string) {
    this.currentStage = value;
    this.stageStartedAt = Date.now();
  }

  emit(
    eventType: "terminal" | "transition",
    reason: string,
    result: "success" | "skipped" | "error" = "success",
    error?: unknown,
    recipeIdentity: Pick<RowndTelemetryEvent, "recipeId" | "recipeUserId"> = {},
  ) {
    const now = Date.now();
    const details = {
      requestId: this.requestId,
      pluginVersion: PLUGIN_VERSION,
      durationMs: now - this.startedAt,
      stageDurationMs: now - this.stageStartedAt,
      stage: this.stage,
      tenantId: this.tenantId,
      rowndUserId: this.rowndUserId,
      canonicalRowndUserId: this.canonicalRowndUserId,
      conflictingRowndUserId: this.conflictingRowndUserId,
      superTokensUserId: this.superTokensUserId,
      recipeId: this.recipeId,
      recipeUserId: this.recipeUserId,
      ...recipeIdentity,
      sessionCreated: this.sessionCreated,
      eventType,
      result,
      reason,
    };
    const event: RowndTelemetryEvent = result === "error"
      ? {
        ...details,
        outcome: "error",
        error: {
          message: error instanceof Error ? error.message : "Unknown error",
          name: error instanceof Error ? error.name : undefined,
        },
      }
      : { ...details, outcome: "success" };
    logDebugMessage(JSON.stringify(event));
    try {
      Promise.resolve(this.record(event)).catch(() => {
        logDebugMessage("Failed to record migration telemetry event.");
      });
    } catch {
      logDebugMessage("Failed to record migration telemetry event.");
    }
  }
}

export function migrationTelemetry(
  userContext?: Record<string, any>,
): MigrationTelemetry | undefined {
  const telemetry = userContext?.rowndMigrationTelemetry;
  return telemetry instanceof MigrationTelemetry ? telemetry : undefined;
}

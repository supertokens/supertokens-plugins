import {
  RowndTelemetryClient,
  RowndTelemetryConfig,
  RowndTelemetryEvent,
  RowndTelemetryOperation,
} from "../types";
import { logDebugMessage } from "../logger";
import { AxiomTelemetryClient } from "./axiomTelemetryClient";
import { OpenTelemetryClient } from "./openTelemetryClient";

type SuccessEvent = Extract<RowndTelemetryEvent, { outcome: "success" }>;
type ErrorEvent = Extract<RowndTelemetryEvent, { outcome: "error" }>;

export function createClient(
  telemetryConfig: RowndTelemetryConfig | undefined,
) {
  let client: RowndTelemetryClient | undefined;

  if (telemetryConfig?.provider === "opentelemetry") {
    client = new OpenTelemetryClient();
  } else if (telemetryConfig?.provider === "axiom") {
    client = new AxiomTelemetryClient(
      telemetryConfig.token,
      telemetryConfig.dataset,
      telemetryConfig.url,
    );
  } else if (telemetryConfig?.provider === "custom") {
    client = telemetryConfig.factory();
  }

  return {
    recordSuccess: (event: SuccessEvent) => {
      if (!client) {
        return;
      }
      safeRecordEvent(client, event, "success");
    },
    recordError: (input: {
      operation: RowndTelemetryOperation;
      error: unknown;
      startedAt: number;
      tenantId?: string;
      rowndUserId?: string;
      superTokensUserId?: string;
    }) => {
      if (!client) {
        return;
      }

      const event: ErrorEvent = {
        outcome: "error",
        operation: input.operation,
        durationMs: Date.now() - input.startedAt,
        tenantId: input.tenantId,
        rowndUserId: input.rowndUserId,
        superTokensUserId: input.superTokensUserId,
        error: {
          message:
            input.error instanceof Error
              ? input.error.message
              : "Unknown error",
          name: input.error instanceof Error ? input.error.name : undefined,
        },
      };
      safeRecordEvent(client, event, "error");
    },
  };
}

function safeRecordEvent(
  client: RowndTelemetryClient,
  event: RowndTelemetryEvent,
  outcome: "success" | "error",
) {
  try {
    Promise.resolve(client.recordEvent(event)).catch((error) => {
      logDebugMessage(
        `Failed to record telemetry ${outcome} event. Error: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    });
  } catch (error) {
    logDebugMessage(
      `Failed to record telemetry ${outcome} event. Error: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
    );
  }
}

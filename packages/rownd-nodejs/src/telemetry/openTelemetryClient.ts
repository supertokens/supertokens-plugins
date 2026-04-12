import { SpanStatusCode, trace } from "@opentelemetry/api";
import { RowndTelemetryClient, RowndTelemetryEvent } from "../types";

export class OpenTelemetryClient implements RowndTelemetryClient {
  recordEvent(event: RowndTelemetryEvent): void {
    const tracer = trace.getTracer("supertokens-plugin-rownd", "0.1.0");
    const span = tracer.startSpan(`rownd.${event.operation}`);
    span.setAttributes({
      "rownd.operation": event.operation,
      "rownd.outcome": event.outcome,
      "rownd.duration_ms": event.durationMs,
      "rownd.tenant_id": event.tenantId ?? "",
      "rownd.rownd_user_id": event.rowndUserId ?? "",
      "rownd.supertokens_user_id": event.superTokensUserId ?? "",
      "rownd.migration_state": event.migrationState ?? "",
    });

    if (event.outcome === "error") {
      const err = new Error(event.error.message);
      if (event.error.name) {
        err.name = event.error.name;
      }
      span.recordException(err);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: event.error.message,
      });
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }

    span.end();
  }
}

import { SpanStatusCode, trace } from "@opentelemetry/api";
import { RowndTelemetryClient, RowndTelemetryEvent } from "../types";
import { PLUGIN_VERSION } from "../constants";

export class OpenTelemetryClient implements RowndTelemetryClient {
  recordEvent(event: RowndTelemetryEvent): void {
    const tracer = trace.getTracer("supertokens-plugin-rownd", PLUGIN_VERSION);
    const span = tracer.startSpan("rownd.migrate");
    span.setAttributes({
      "rownd.outcome": event.outcome,
      "rownd.duration_ms": event.durationMs,
      "rownd.tenant_id": event.tenantId ?? "",
      "rownd.rownd_user_id": event.rowndUserId ?? "",
      "rownd.supertokens_user_id": event.superTokensUserId ?? "",
      "rownd.request_id": event.requestId ?? "",
      "rownd.event_type": event.eventType ?? "terminal",
      "rownd.result": event.result ?? event.outcome,
      "rownd.stage": event.stage ?? "",
      ...(event.stageDurationMs !== undefined
        ? { "rownd.stage_duration_ms": event.stageDurationMs }
        : {}),
      "rownd.reason": event.reason ?? "",
      "rownd.plugin_version": event.pluginVersion ?? PLUGIN_VERSION,
      "rownd.recipe_id": event.recipeId ?? "",
      "rownd.recipe_user_id": event.recipeUserId ?? "",
      ...(event.sessionCreated !== undefined
        ? { "rownd.session_created": event.sessionCreated }
        : {}),
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

import { trace, type Tracer } from "@opentelemetry/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenTelemetryClient } from "./openTelemetryClient";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function captureSpan() {
  const span = {
    setAttributes: vi.fn(), setAttribute: vi.fn(), recordException: vi.fn(),
    setStatus: vi.fn(), end: vi.fn(),
  };
  const startSpan = vi.fn(() => span);
  vi.spyOn(trace, "getTracer").mockReturnValue({ startSpan } as unknown as Tracer);
  return { span, startSpan };
}

describe("OpenTelemetry profile timing", () => {
  it.each([false, true])("exports measured assembly duration with one captured endpoint (failed=%s)", (failed) => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { span, startSpan } = captureSpan();
    span.setAttributes.mockImplementation(() => { vi.setSystemTime(5000); });
    new OpenTelemetryClient().recordEvent({
      operation: "profile_read", durationMs: 125.5,
      profileMode: "lightweight-v1", profileConfig: "static",
      sdkCalls: { user: 1, mapping: 2, metadata: 1, sessionList: 0, sessionDetail: 0 },
      ...(failed ? { outcome: "error" as const, error: { message: "Profile read failed" } }
        : { outcome: "success" as const }),
    });
    expect(startSpan).toHaveBeenCalledWith("rownd.profile_read", { startTime: 874.5 });
    expect(span.end).toHaveBeenCalledWith(1000);
    expect(span.setAttributes).toHaveBeenCalledWith(expect.objectContaining({ "rownd.duration_ms": 125.5 }));
    expect(span.setAttribute).toHaveBeenCalledWith("rownd.profile.sdk_calls.sessionDetail", 0);
    expect(span.recordException).toHaveBeenCalledTimes(failed ? 1 : 0);
  });

  it("retains migration span timing", () => {
    const { span, startSpan } = captureSpan();
    new OpenTelemetryClient().recordEvent({ outcome: "success", durationMs: 125.5 });
    expect(startSpan).toHaveBeenCalledWith("rownd.migrate");
    expect(span.end).toHaveBeenCalledWith();
  });
});

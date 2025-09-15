import { SpanStatus } from "@opentelemetry/api";

export type OpenTelemetryLoggerPluginConfig = {} | undefined;

export type OTSpan = {
  end: () => void;
  addEvent: (eventName: string, attributes: Record<string, any>) => void;
  setAttributes: (attributes: Record<string, any>) => void;
  setStatus: (status: SpanStatus) => void;
};

export type OTTracer = {
  startSpan: (spanName: string, attributes: Record<string, any>) => OTSpan;
  startActiveSpan: (spanName: string, attributes: Record<string, any>, fn: (span: OTSpan) => void) => void;
};
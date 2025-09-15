import { OpenTelemetryLoggerPluginConfig } from "./types";
import { Tracer, Span, SpanStatus, AttributeValue } from "@opentelemetry/api";
import opentelemetry from "@opentelemetry/api";
import { getRequestFromUserContext } from "supertokens-node";
import { HttpRequest, UserContext } from "supertokens-node/types";

export class PluginImpl {
  constructor(private readonly config: OpenTelemetryLoggerPluginConfig) {}

  startSpan = function (this: PluginImpl, tracer: Tracer, spanName: string, attributes: Record<string, any>): {
    end: () => void;
    addEvent: (eventName: string, attributes: Record<string, AttributeValue>) => void;
    setAttributes: (attributes: Record<string, AttributeValue>) => void;
    setStatus: (status: SpanStatus) => void;
  } {
    return tracer.startSpan(spanName, { attributes });
  };

  startActiveSpan = function<T>(this: PluginImpl, tracer: Tracer, spanName: string, attributes: Record<string, any>, fn: (span: Span) => T): T {
    return tracer.startActiveSpan(spanName, { attributes }, fn);
  };

  getTracer = function (this: PluginImpl): Tracer {
    return opentelemetry.trace.getTracer("supertokens", "0.1.0");
  };

  transformInputToAttributes = function (this: PluginImpl, input: unknown): Record<string, AttributeValue> {
    return Object.fromEntries(transformObjectToEntryList(input, "input", this.getSensitiveFields(defaultSensitiveFields)));
  };

  transformResultToAttributes = function (this: PluginImpl, input: unknown): Record<string, AttributeValue> {
    return Object.fromEntries(transformObjectToEntryList(input, "input", this.getSensitiveFields(defaultSensitiveFields)));
  };

  transformErrorToAttributes = function (this: PluginImpl, error: unknown): Record<string, AttributeValue> {
    return {
        error: (typeof error === "object" && error !== null && "message" in error ? error?.message : "Unknown error") as string,
    };
  };

  getSensitiveFields = function (this: PluginImpl, defaultSensitiveFields: string[]): string[] {
    return defaultSensitiveFields;
  };

  getTracingHeadersForCoreCall = function (this: PluginImpl, req: HttpRequest, userContext: UserContext): Record<string, string> {
    return {
      "x-parent-trace-id": getRequestFromUserContext(userContext)?.getHeaderValue("x-trace-id") ?? "",
    };
  };
};


const defaultSensitiveFields = ["password", "email", "phoneNumber", "email", "emails", "phoneNumbers", "accessToken", "refreshToken", "phonenumber"];

function transformObjectToEntryList(obj: any | undefined, prefix: string, sensitiveFields: string[]): [string, AttributeValue][] {
  if (Array.isArray(obj)) {
    return obj.flatMap((item, index) => transformObjectToEntryList(item, prefix + ".[" + index + "]", sensitiveFields));
  }

  if (obj === null || typeof obj !== "object") {
    if (
      sensitiveFields.some(field => prefix.includes(field))
    ) {
      return [[prefix, "REDACTED"]];
    }
    return [[prefix, obj]];
  }
  if (prefix.endsWith("userContext._default") || prefix.endsWith("input.options")) {
    return [];
  }

  if ("id" in obj && "value" in obj) {
    if (sensitiveFields.includes(obj.id)) {
      return [
        [prefix + ".id", obj.id],
        [prefix + ".value", "REDACTED"],
      ];
    }
    return [
      [prefix + ".id", obj.id],
      [prefix + ".value", obj.value],
    ];
  }

  if (typeof obj.getAllSessionTokensDangerously === "function") {
    return [
      [prefix + ".accessToken", "REDACTED"],
      [prefix + ".refreshToken", "REDACTED"],
      [prefix + ".userId", obj.userId],
      [prefix + ".tenantId", obj.tenantId],
      [prefix + ".recipeUserId", obj.recipeUserId.getAsString()],
      [prefix + ".sessionHandle", obj.sessionHandle],
      [prefix + ".frontToken", obj.frontToken],
      [prefix + ".accessTokenUpdated", obj.accessTokenUpdated],
    ];
  }
  if (typeof obj.isPrimaryUser === "boolean") {
    return [
      [prefix + ".isPrimaryUser", obj.isPrimaryUser],
      [prefix + ".tenantIds", obj.tenantIds],
      [prefix + ".timeJoined", obj.timeJoined],
      [prefix + ".id", obj.id],
      ...transformObjectToEntryList(obj.loginMethods, prefix + ".loginMethods", sensitiveFields),
    ];
  }

  if (typeof obj.hasSameEmailAs === "function") {
    return [
      [prefix + ".recipeId", obj.recipeId],
      [prefix + ".recipeUserId", obj.recipeUserId.getAsString()],
      [prefix + ".email", "REDACTED"], // obj.email],
      [prefix + ".phoneNumber", "REDACTED"], // obj.phoneNumber],
      [prefix + ".thirdParty.id", obj.thirdParty?.id],
      [prefix + ".thirdParty.userId", obj.thirdParty?.userId],
      [prefix + ".webauthn.credentialIds", obj.webauthn?.credentialIds],
      [prefix + ".verified", obj.verified],
      [prefix + ".timeJoined", obj.timeJoined],
    ];
  }

  if (typeof obj.toJSON === "function") {
    return [[prefix, obj.toJSON()]];
  }

  const entries = Object.entries(obj);

  return entries.flatMap(([key, value]) => {
    if (typeof value === "object") {
      return transformObjectToEntryList(value, prefix + "." + key, sensitiveFields);
    }
    if (typeof value === "function") {
      return [];
    }
    if (sensitiveFields.some(field => key === field)) {
      return [[prefix + "." + key, "REDACTED"]];
    }
    return [[prefix + "." + key, value]];
  }) as [string, AttributeValue][];
}
import type { JSONObject, PluginRouteHandler } from "supertokens-node/types";

import { RowndPluginError } from "./errors";

type SuperTokensRequest = Parameters<PluginRouteHandler["handler"]>[0];
export type JsonRecord = JSONObject;
export type JsonValue = JsonRecord[string];

export function rewriteLinkPath(
  inputUrl: string,
  targetPath: string,
  searchParams?: Record<string, string>,
) {
  try {
    const url = new URL(inputUrl);
    url.pathname = `/${targetPath.replace(/^\//, "")}`;
    for (const [key, value] of Object.entries(searchParams ?? {})) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  } catch {
    const [path = inputUrl, query = ""] = inputUrl
      .replace(/auth\/verify[^?]*/, targetPath)
      .split("?");
    const params = new URLSearchParams(query);
    for (const [key, value] of Object.entries(searchParams ?? {})) {
      params.set(key, value);
    }
    const queryString = params.toString();
    return queryString ? `${path}?${queryString}` : path;
  }
}

export function rewriteLinkToMobileDeepLink(
  inputUrl: string,
  targetPath: string,
  baseUrl: string,
  searchParams?: Record<string, string>,
) {
  const normalizedBaseUrl = baseUrl.endsWith("://")
    ? baseUrl
    : baseUrl.replace(/\/+$/, "") + "/";
  const targetUrl = new URL(
    `${normalizedBaseUrl}${targetPath.replace(/^\//, "")}`,
  );

  try {
    const sourceUrl = new URL(inputUrl);
    targetUrl.search = sourceUrl.search;
    targetUrl.hash = sourceUrl.hash;
  } catch {
    const [, query = ""] = inputUrl.split("?");
    targetUrl.search = query ? `?${query.split("#")[0]}` : "";
    const hash = inputUrl.split("#")[1];
    targetUrl.hash = hash ? `#${hash}` : "";
  }

  for (const [key, value] of Object.entries(searchParams ?? {})) {
    targetUrl.searchParams.set(key, value);
  }

  return targetUrl.toString();
}

export async function parseRequest(req: SuperTokensRequest): Promise<{
  token: string;
}> {
  const authHeader = req.getHeaderValue("authorization");
  if (!authHeader) {
    throw new RowndPluginError("MISSING_AUTHORIZATION_HEADER");
  }

  const token = authHeader.replace(/^Bearer /i, "");
  if (!token) {
    throw new RowndPluginError("INVALID_TOKEN");
  }

  return {
    token,
  };
}

export async function getJsonBody(req: SuperTokensRequest): Promise<unknown> {
  return req.getJSONBody();
}

export function parseGuestBody(value: unknown) {
  if (!isJsonRecord(value)) {
    return {};
  }

  return {
    authLevel:
      typeof value.auth_level === "string" ? value.auth_level : undefined,
  };
}

export function parseUpdateUserBody(value: unknown): {
  data?: JsonRecord;
  context?: JsonRecord;
} {
  if (!isJsonRecord(value) || !isJsonRecord(value.data)) {
    return {};
  }

  return {
    data: value.data,
    ...(isJsonRecord(value.context) ? { context: value.context } : {}),
  };
}

export function parseUpdateMetaBody(value: unknown): { meta?: JsonRecord } {
  if (!isJsonRecord(value) || !isJsonRecord(value.meta)) {
    return {};
  }

  return { meta: value.meta };
}

export function parseUpdateFieldBody(value: unknown): { value?: JsonValue } {
  if (!isJsonRecord(value) || !hasOwn(value, "value")) {
    return {};
  }

  return { value: value.value as JsonValue };
}

export function missingFieldResponse() {
  return {
    status: "ERROR" as const,
    code: 400,
    message: "field is required",
  };
}

export function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasOwn<T extends object, K extends PropertyKey>(
  value: T,
  key: K,
): value is T & Record<K, unknown> {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function getStringList(value: unknown) {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }

  return typeof value === "string" ? [value] : [];
}

export function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error";
}

export function getRequestedAppVariantIdFromRequest(
  req: Pick<SuperTokensRequest, "getKeyValueFromQuery">,
) {
  return req.getKeyValueFromQuery("app_variant_id");
}

export function getRequestedDisplayContextFromRequest(
  req: Pick<SuperTokensRequest, "getKeyValueFromQuery">,
) {
  const displayContext = req.getKeyValueFromQuery("rownd_display_context");
  return displayContext === "browser" ||
    displayContext === "mobile_app" ||
    displayContext === "customer_web_view"
    ? displayContext
    : undefined;
}

export function getRequestedRedirectToPathFromRequest(
  req: Pick<SuperTokensRequest, "getKeyValueFromQuery">,
) {
  const redirectToPath = req.getKeyValueFromQuery("rownd_redirect_to_path");
  return typeof redirectToPath === "string" && redirectToPath.length > 0
    ? redirectToPath
    : undefined;
}

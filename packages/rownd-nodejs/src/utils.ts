import type { JSONObject, PluginRouteHandler, SuperTokensPublicConfig } from "supertokens-node/types";

import { HUB_LOGIN_PAGE_PATH } from "./constants";
import { RowndPluginError } from "./errors";
import type { RowndPluginNormalisedConfig } from "./types";

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

export function rewriteLinkToBaseUrl(
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

export function getAppInfoString(value: { getAsStringDangerous: () => string }) {
  return value.getAsStringDangerous();
}

export function getWebsiteDomain(input: {
  stConfig: SuperTokensPublicConfig;
  request?: any;
  userContext?: Record<string, any>;
}) {
  return getAppInfoString(input.stConfig.appInfo.getOrigin({
    request: input.request,
    userContext: (input.userContext ?? {}) as any,
  }));
}

export function normalizeClientDomain(value: string) {
  if (value.endsWith("://")) {
    return value;
  }

  const parsed = new URL(value);
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    return parsed.origin;
  }

  return `${parsed.protocol}//${parsed.host}`;
}

function resolveClientDomain(input: {
  clientDomain?: string;
  pluginConfig: RowndPluginNormalisedConfig;
  websiteDomain: string;
}) {
  if (!input.clientDomain) {
    return input.websiteDomain;
  }

  const resolved = input.pluginConfig.clientDomains?.[input.clientDomain];
  if (!resolved) {
    throw new Error(`Unknown clientDomain key: ${input.clientDomain}`);
  }

  return resolved;
}

export function resolveAllowedClientDomain(input: {
  clientDomain?: string;
  pluginConfig: RowndPluginNormalisedConfig;
  stConfig: SuperTokensPublicConfig;
  request?: any;
  userContext?: Record<string, any>;
}) {
  const websiteDomain = getWebsiteDomain(input);
  const resolvedClientDomain = resolveClientDomain({
    clientDomain: input.clientDomain,
    pluginConfig: input.pluginConfig,
    websiteDomain,
  });
  const normalizedClientDomain = normalizeClientDomain(resolvedClientDomain);
  const allowed = [
    websiteDomain,
    ...Object.values(input.pluginConfig.clientDomains ?? {}),
  ].map(normalizeClientDomain);

  if (!allowed.includes(normalizedClientDomain)) {
    throw new Error(`clientDomain is not allowed: ${resolvedClientDomain}`);
  }

  return normalizedClientDomain;
}

export function normalizeRedirectToPathForClientDomain(
  redirectToPath: string | undefined,
  clientDomain: string,
) {
  if (!redirectToPath) {
    return undefined;
  }

  if (redirectToPath === "NATIVE_APP") {
    return redirectToPath;
  }

  if (redirectToPath.startsWith("//")) {
    throw new Error("redirectToPath cannot be schemaless");
  }

  const normalizedClientDomain = normalizeClientDomain(clientDomain);
  const redirectUrl = new URL(
    redirectToPath,
    normalizedClientDomain.endsWith("://") ? "http://localhost" : normalizedClientDomain,
  );
  const hasExplicitScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(redirectToPath);

  if (hasExplicitScheme) {
    if (redirectUrl.protocol !== "http:" && redirectUrl.protocol !== "https:") {
      throw new Error("redirectToPath must be http(s) or relative");
    }

    if (redirectUrl.origin !== normalizedClientDomain) {
      throw new Error("redirectToPath must match clientDomain");
    }
  }

  return `${redirectUrl.pathname}${redirectUrl.search}${redirectUrl.hash}`;
}

export function assertAllowedBypassRedirectPath(
  pluginConfig: RowndPluginNormalisedConfig,
  redirectToPath: string | undefined,
) {
  if (!redirectToPath) {
    throw new Error("redirectToPath is required for confirmation bypass magic links");
  }

  const allowedRedirectPaths = pluginConfig.crossDeviceConfirmationBypass?.allowedRedirectPaths ?? [];
  if (allowedRedirectPaths.length === 0) {
    throw new Error("crossDeviceConfirmationBypass.allowedRedirectPaths must be configured");
  }

  if (!allowedRedirectPaths.includes(redirectToPath)) {
    throw new Error(`redirectToPath is not allowed for confirmation bypass: ${redirectToPath}`);
  }
}

export function getMagicLinkBootstrapParams(input: {
  appKey: string;
  apiDomain: string;
  apiBasePath: string;
  appVariantId?: string;
  displayContext?: "browser" | "mobile_app" | "customer_web_view";
  redirectToPath?: string;
  clientDomainKey?: string;
}) {
  return {
    appKey: input.appKey,
    apiDomain: input.apiDomain,
    apiBasePath: input.apiBasePath,
    ...(input.appVariantId ? { appVariantId: input.appVariantId } : {}),
    ...(input.displayContext ? { displayContext: input.displayContext } : {}),
    ...(input.redirectToPath ? { redirectToPath: input.redirectToPath } : {}),
    ...(input.clientDomainKey ? { clientDomain: input.clientDomainKey } : {}),
  };
}

export function rewriteMagicLink(input: {
  magicLink: string;
  clientDomain: string;
  bootstrapParams: Record<string, string>;
}) {
  return rewriteLinkToBaseUrl(
    input.magicLink,
    HUB_LOGIN_PAGE_PATH,
    input.clientDomain,
    input.bootstrapParams,
  );
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

export function getRequestedClientDomainFromRequest(
  req: Pick<SuperTokensRequest, "getKeyValueFromQuery">,
) {
  const clientDomain = req.getKeyValueFromQuery("rownd_client_domain");
  return typeof clientDomain === "string" && clientDomain.length > 0
    ? clientDomain
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

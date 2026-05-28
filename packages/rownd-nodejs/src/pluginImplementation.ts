import { randomUUID } from "crypto";
import SuperTokens from "supertokens-node";
import AccountLinking from "supertokens-node/recipe/accountlinking";
import EmailVerification from "supertokens-node/recipe/emailverification";
import Passwordless from "supertokens-node/recipe/passwordless";
import Session from "supertokens-node/recipe/session";
import { BooleanClaim } from "supertokens-node/recipe/session/claims";
import ThirdParty from "supertokens-node/recipe/thirdparty";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import {
  RowndUser,
  RowndUserMetadata,
  SuperTokensUserImport,
  IRowndClient,
  RowndPluginNormalisedConfig,
  RowndAuthConfig,
  RowndSignInMethod,
  RowndSchemaField,
  RowndSubBrandConfigInput,
} from "./types";
import { RowndPluginError } from "./errors";
import {
  ANONYMOUS_AUTH_METHOD_ID,
  DEFAULT_ROWND_SCHEMA,
  GUEST_AUTH_METHOD_ID,
  PUBLIC_TENANT_ID,
  ROWND_JWT_CLAIMS,
} from "./constants";
import type {
  JSONObject,
  PluginRouteHandler,
  SuperTokensPublicConfig,
} from "supertokens-node/types";
import { logDebugMessage } from "./logger";
import { createClient } from "./telemetry/createTelemetryClient";

type SuperTokensRequest = Parameters<PluginRouteHandler["handler"]>[0];
type SuperTokensResponse = Parameters<PluginRouteHandler["handler"]>[1];
type SuperTokensSession = Parameters<PluginRouteHandler["handler"]>[2];
type SuperTokensUserContext = Parameters<PluginRouteHandler["handler"]>[3];
type RequiredSuperTokensSession = NonNullable<SuperTokensSession>;
type JsonRecord = JSONObject;
type JsonValue = JsonRecord[string];
type TelemetryClient = ReturnType<typeof createClient>;

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

export type RowndRouteHandlerDeps = {
  pluginConfig: RowndPluginNormalisedConfig;
  stConfig: SuperTokensPublicConfig;
  telemetryClient: TelemetryClient;
};

let rowndClient: IRowndClient | undefined;
let pluginConfig: RowndPluginNormalisedConfig | undefined;

export function setRowndClient(client: IRowndClient) {
  rowndClient = client;
}

export function getRowndClient() {
  if (!rowndClient) {
    throw new Error("Rownd client not initialized");
  }
  return rowndClient;
}

export function setPluginConfig(config: RowndPluginNormalisedConfig) {
  pluginConfig = config;
}

export function getPluginConfig() {
  return pluginConfig;
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

export function handleGetAppConfig(deps: RowndRouteHandlerDeps) {
  return async (req: SuperTokensRequest) => {
    const appVariantId = getRequestedAppVariantIdFromRequest(req);
    const appConfig = buildAppConfig(
      deps.pluginConfig,
      deps.stConfig,
      appVariantId,
    );

    if (!appConfig) {
      return {
        status: "ERROR" as const,
        message: `Unknown Rownd app variant: ${appVariantId}`,
      };
    }

    return {
      status: "OK" as const,
      ...appConfig,
    };
  };
}

export function handleGuestLogin(deps: RowndRouteHandlerDeps) {
  return async (
    req: SuperTokensRequest,
    res: SuperTokensResponse,
    _session: SuperTokensSession,
    userContext: SuperTokensUserContext,
  ) => {
    const startedAt = Date.now();
    const guestId = `guest_${randomUUID()}`;

    try {
      const body = parseGuestBody(await getJsonBody(req));
      const appVariantId = getRequestedAppVariantIdFromRequest(req);
      assertRowndAppVariantIsConfigured(appVariantId);
      const thirdPartyId =
        body.authLevel === ANONYMOUS_AUTH_METHOD_ID
          ? ANONYMOUS_AUTH_METHOD_ID
          : GUEST_AUTH_METHOD_ID;
      const thirdPartyUserId =
        thirdPartyId === ANONYMOUS_AUTH_METHOD_ID
          ? `anon_${randomUUID()}`
          : guestId;

      const response = await ThirdParty.manuallyCreateOrUpdateUser(
        PUBLIC_TENANT_ID,
        thirdPartyId,
        thirdPartyUserId,
        `${thirdPartyUserId}@anonymous.local`,
        false,
        undefined,
        userContext,
      );

      if (response.status !== "OK") {
        throw new Error(
          `Guest user creation failed with status: ${response.status}`,
        );
      }

      await Session.createNewSession(
        req,
        res,
        PUBLIC_TENANT_ID,
        response.recipeUserId,
        {
          ...buildRowndAudience({}, appVariantId),
          auth_level: GUEST_AUTH_METHOD_ID,
          is_anonymous: true,
          app_user_id: response.user.id,
        },
        {},
        userContext,
      );

      logDebugMessage(`Guest session created for user: ${response.user.id}`);
      deps.telemetryClient.recordSuccess({
        outcome: "success",
        durationMs: Date.now() - startedAt,
        tenantId: PUBLIC_TENANT_ID,
        superTokensUserId: response.user.id,
      });

      return {
        status: "OK" as const,
        createdNewRecipeUser: response.createdNewRecipeUser,
      };
    } catch (error) {
      logDebugMessage(`Guest login failed. Error: ${getErrorMessage(error)}`);
      deps.telemetryClient.recordError({
        error,
        startedAt,
        tenantId: PUBLIC_TENANT_ID,
      });
      return {
        status: "ERROR" as const,
        message: "Guest login failed",
      };
    }
  };
}

export function handleMigrate(deps: RowndRouteHandlerDeps) {
  return async (
    req: SuperTokensRequest,
    res: SuperTokensResponse,
    _session: SuperTokensSession,
    userContext: SuperTokensUserContext,
  ) => {
    const startedAt = Date.now();
    let tenantId: string | undefined = PUBLIC_TENANT_ID;
    let rowndUserId: string | undefined;
    let superTokensUserId: string | undefined;
    let user: Awaited<ReturnType<typeof SuperTokens.getUser>>;
    let recipeUserId:
      | Parameters<typeof Session.createNewSession>[3]
      | undefined;

    try {
      if (!deps.stConfig.supertokens) {
        throw new Error("Supertokens config not found");
      }

      const parsed = await parseRequest(req);
      const appVariantId = getRequestedAppVariantIdFromRequest(req);
      assertRowndAppVariantIsConfigured(appVariantId);
      rowndUserId = await validateRowndToken(parsed.token);
      user = await SuperTokens.getUser(rowndUserId, userContext);

      if (!user) {
        const rowndUser = await fetchRowndUserInfo(rowndUserId);
        const stUserImport = mapRowndUserToSuperTokens(rowndUser);

        try {
          const importedUser = await importUser(
            stUserImport,
            deps.stConfig.supertokens,
          );
          superTokensUserId = importedUser.id;
          if (importedUser.loginMethods[0]?.recipeUserId) {
            recipeUserId = SuperTokens.convertToRecipeUserId(
              importedUser.loginMethods[0].recipeUserId,
            );
          }
        } catch (err) {
          user = await SuperTokens.getUser(rowndUserId, userContext);
          if (!user) {
            throw err;
          }
          superTokensUserId = user.id;
          recipeUserId = user.loginMethods[0]?.recipeUserId;
          logDebugMessage(
            `User already migrated (race condition). tenantId: ${PUBLIC_TENANT_ID}, rowndUserId: ${rowndUserId}`,
          );
        }

        logDebugMessage(
          `User migrated successfully. tenantId: ${PUBLIC_TENANT_ID}, rowndUserId: ${rowndUserId}`,
        );
      } else {
        superTokensUserId = user.id;
        recipeUserId = user.loginMethods[0]?.recipeUserId;
        logDebugMessage(
          `User already migrated. tenantId: ${PUBLIC_TENANT_ID}, rowndUserId: ${rowndUserId}`,
        );
      }

      if (superTokensUserId) {
        await recordRowndAppVariantForUser(superTokensUserId, appVariantId);
      }

      if (!recipeUserId) {
        throw new Error("User not found or has no login methods");
      }

      await Session.createNewSession(
        req,
        res,
        PUBLIC_TENANT_ID,
        recipeUserId,
        {
          ...buildRowndAudience({}, appVariantId),
        },
        {},
        userContext,
      );

      logDebugMessage(
        `Session migrated successfully. tenantId: ${PUBLIC_TENANT_ID}, userId: ${superTokensUserId}`,
      );

      deps.telemetryClient.recordSuccess({
        outcome: "success",
        durationMs: Date.now() - startedAt,
        tenantId,
        rowndUserId,
        superTokensUserId,
      });

      return { status: "OK" as const };
    } catch (error) {
      logDebugMessage(`Migration failed. Error: ${getErrorMessage(error)}`);
      deps.telemetryClient.recordError({
        error,
        startedAt,
        tenantId,
        rowndUserId,
        superTokensUserId,
      });
      return {
        status: "ERROR" as const,
        message:
          error instanceof RowndPluginError
            ? error.message
            : "Migration failed",
      };
    }
  };
}

export function handleGetUser() {
  return async (
    _req: SuperTokensRequest,
    _res: SuperTokensResponse,
    maybeSession: SuperTokensSession,
  ) => {
    const session = requireSession(maybeSession);
    return {
      status: "OK" as const,
      ...(await getUserById(session.getUserId())),
    };
  };
}

export function handleUpdateUser() {
  return async (
    req: SuperTokensRequest,
    _res: SuperTokensResponse,
    maybeSession: SuperTokensSession,
    userContext: SuperTokensUserContext,
  ) => {
    const session = requireSession(maybeSession);
    const appVariantId = getRequestedAppVariantIdFromRequest(req);
    assertRowndAppVariantIsConfigured(appVariantId);
    const payload = parseUpdateUserBody(await getJsonBody(req));
    const inputData = payload.data ?? {};
    const requestUserContext = {
      ...userContext,
      ...payload.context,
    };
    const { email, ...dataWithoutEmail } = inputData;
    const hasEmailUpdate =
      hasOwn(inputData, "email") && typeof email === "string";
    const permissionError = validateWritableFields(
      Object.keys(dataWithoutEmail),
    );

    if (permissionError) {
      return permissionError;
    }

    if (Object.keys(dataWithoutEmail).length > 0) {
      await updateUserData(session.getUserId(), dataWithoutEmail);
    }

    if (hasEmailUpdate) {
      return {
        status: "OK" as const,
        ...(await startPendingEmailVerification({
          userId: session.getUserId(),
          recipeUserId: session.getRecipeUserId(),
          tenantId: session.getTenantId(),
          email,
          pendingVerificationId: randomUUID(),
          userContext: appVariantId
            ? { ...requestUserContext, rowndAppVariantId: appVariantId }
            : requestUserContext,
        })),
      };
    }

    return {
      status: "OK" as const,
      ...(await getUserById(session.getUserId())),
    };
  };
}

export function handleDeleteUser() {
  return async (
    _req: SuperTokensRequest,
    _res: SuperTokensResponse,
    maybeSession: SuperTokensSession,
  ) => {
    const session = requireSession(maybeSession);
    await SuperTokens.deleteUser(session.getUserId(), true);
    return { status: "OK" as const };
  };
}

export function handleSignOut() {
  return async (
    _req: SuperTokensRequest,
    _res: SuperTokensResponse,
    maybeSession: SuperTokensSession,
    userContext: SuperTokensUserContext,
  ) => {
    const session = requireSession(maybeSession);
    await Session.revokeAllSessionsForUser(
      session.getUserId(),
      true,
      session.getTenantId(),
      userContext,
    );

    return { status: "OK" as const };
  };
}

export function handleGetUserMeta() {
  return async (
    _req: SuperTokensRequest,
    _res: SuperTokensResponse,
    maybeSession: SuperTokensSession,
  ) => {
    const session = requireSession(maybeSession);
    const metadata = await getUserMetadata(session.getUserId());
    return {
      status: "OK" as const,
      id: session.getUserId(),
      meta: Object.fromEntries(
        Object.entries(metadata).filter(
          ([key]) => !isInternalMetadataField(key),
        ),
      ),
    };
  };
}

export function handleUpdateUserMeta() {
  return async (
    req: SuperTokensRequest,
    _res: SuperTokensResponse,
    maybeSession: SuperTokensSession,
  ) => {
    const session = requireSession(maybeSession);
    const payload = parseUpdateMetaBody(await getJsonBody(req));
    const internalField = Object.keys(payload.meta ?? {}).find(
      isInternalMetadataField,
    );

    if (internalField) {
      return {
        status: "ERROR" as const,
        code: 403,
        message: `field is not writable: ${internalField}`,
      };
    }

    return {
      status: "OK" as const,
      ...(await updateUserMetadata(session.getUserId(), payload.meta ?? {})),
    };
  };
}

export function handleGetUserField() {
  return async (
    req: SuperTokensRequest,
    _res: SuperTokensResponse,
    maybeSession: SuperTokensSession,
  ) => {
    const session = requireSession(maybeSession);
    const field = req.getKeyValueFromQuery("field");
    if (!field) {
      return missingFieldResponse();
    }

    const user = await getUserById(session.getUserId());
    return {
      status: "OK" as const,
      value: user.data[field],
    };
  };
}

export function handleUpdateUserField() {
  return async (
    req: SuperTokensRequest,
    _res: SuperTokensResponse,
    maybeSession: SuperTokensSession,
    userContext: SuperTokensUserContext,
  ) => {
    const session = requireSession(maybeSession);
    const appVariantId = getRequestedAppVariantIdFromRequest(req);
    assertRowndAppVariantIsConfigured(appVariantId);
    const field = req.getKeyValueFromQuery("field");
    if (!field) {
      return missingFieldResponse();
    }

    const payload = parseUpdateFieldBody(await getJsonBody(req));
    if (field === "email" && typeof payload.value === "string") {
      return {
        status: "OK" as const,
        ...(await startPendingEmailVerification({
          userId: session.getUserId(),
          recipeUserId: session.getRecipeUserId(),
          tenantId: session.getTenantId(),
          email: payload.value,
          pendingVerificationId: randomUUID(),
          userContext: appVariantId
            ? { ...userContext, rowndAppVariantId: appVariantId }
            : userContext,
        })),
      };
    }

    const permissionError = validateWritableFields([field]);
    if (permissionError) {
      return permissionError;
    }

    return {
      status: "OK" as const,
      ...(await updateUserData(session.getUserId(), {
        [field]: payload.value,
      })),
    };
  };
}

function requireSession(
  session: SuperTokensSession,
): RequiredSuperTokensSession {
  if (!session) {
    throw new Error("Session not found");
  }

  return session;
}

async function getJsonBody(req: SuperTokensRequest): Promise<unknown> {
  return req.getJSONBody();
}

function parseGuestBody(value: unknown) {
  if (!isJsonRecord(value)) {
    return {};
  }

  return {
    authLevel:
      typeof value.auth_level === "string" ? value.auth_level : undefined,
  };
}

function parseUpdateUserBody(value: unknown): {
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

function parseUpdateMetaBody(value: unknown): { meta?: JsonRecord } {
  if (!isJsonRecord(value) || !isJsonRecord(value.meta)) {
    return {};
  }

  return { meta: value.meta };
}

function parseUpdateFieldBody(value: unknown): { value?: JsonValue } {
  if (!isJsonRecord(value) || !hasOwn(value, "value")) {
    return {};
  }

  return { value: value.value as JsonValue };
}

function validateWritableFields(fields: string[]) {
  const readOnlyField = fields.find((field) => !canUpdateUserDataField(field));

  if (!readOnlyField) {
    return undefined;
  }

  return {
    status: "ERROR" as const,
    code: 403,
    message: `field is not writable: ${readOnlyField}`,
  };
}

function missingFieldResponse() {
  return {
    status: "ERROR" as const,
    code: 400,
    message: "field is required",
  };
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn<T extends object, K extends PropertyKey>(
  value: T,
  key: K,
): value is T & Record<K, unknown> {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error";
}

export function mapRowndUserToSuperTokens(
  rowndUser: RowndUser,
): SuperTokensUserImport {
  const loginMethods: SuperTokensUserImport["loginMethods"] = [];
  const rowndUserData = rowndUser.data || {};
  const rowndUserVerifiedData = rowndUser.verified_data || {};
  if (!rowndUserData.user_id) {
    throw new Error("Rownd user has no user_id");
  }

  if (rowndUserData.google_id) {
    if (!rowndUserData.email) {
      throw new Error("Rownd Google user is missing email");
    }

    loginMethods.push({
      recipeId: "thirdparty",
      thirdPartyId: "google",
      thirdPartyUserId: rowndUserData.google_id,
      email: rowndUserData.email,
      isVerified: !!rowndUserVerifiedData.google_id,
    });
  }

  if (rowndUserData.apple_id) {
    if (!rowndUserData.email) {
      throw new Error("Rownd Apple user is missing email");
    }

    loginMethods.push({
      recipeId: "thirdparty",
      thirdPartyId: "apple",
      thirdPartyUserId: rowndUserData.apple_id,
      email: rowndUserData.email,
      isVerified: !!rowndUserVerifiedData.apple_id,
    });
  }

  if (rowndUserData.phone_number) {
    loginMethods.push({
      recipeId: "passwordless",
      phoneNumber: rowndUserData.phone_number,
      isVerified: !!rowndUserVerifiedData.phone_number,
    });
  }

  // Only add passwordless email if no thirdparty methods exist,
  // as thirdparty methods already include the email.
  if (
    rowndUserData.email &&
    !rowndUserData.google_id &&
    !rowndUserData.apple_id
  ) {
    loginMethods.push({
      recipeId: "passwordless",
      email: rowndUserData.email,
      isVerified: !!rowndUserVerifiedData.email,
    });
  }

  let authLevel = rowndUser.auth_level;
  if (loginMethods.length === 0) {
    const thirdPartyId =
      authLevel === GUEST_AUTH_METHOD_ID
        ? GUEST_AUTH_METHOD_ID
        : ANONYMOUS_AUTH_METHOD_ID;
    if (!authLevel) authLevel = thirdPartyId;
    loginMethods.push({
      recipeId: "thirdparty",
      thirdPartyId,
      thirdPartyUserId: rowndUserData.user_id,
      email: `${rowndUserData.user_id}@anonymous.local`,
      isVerified: false,
    });
  }

  const userMetadata = buildRowndUserMetadata(rowndUser);

  return {
    externalUserId: rowndUserData.user_id,
    loginMethods,
    userMetadata,
  };
}

export async function importUser(
  stUser: SuperTokensUserImport,
  config: NonNullable<SuperTokensPublicConfig["supertokens"]>,
): Promise<{
  id: string;
  loginMethods: Array<{
    recipeUserId: string;
  }>;
}> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.apiKey) {
    headers["api-key"] = config.apiKey;
  }

  const response = await fetch(`${config.connectionURI}/bulk-import/import`, {
    method: "POST",
    headers,
    body: JSON.stringify(stUser),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Bulk import failed with status ${response.status}: ${errorText}`,
    );
  }

  const importResponse = (await response.json()) as {
    status: string;
    message?: string;
    user?: {
      id: string;
      loginMethods: Array<{
        recipeUserId: string;
      }>;
    };
  };

  if (importResponse.status !== "OK" || !importResponse.user) {
    throw new Error(
      `Bulk import failed: ${importResponse.message || "Missing user in response"}`,
    );
  }

  return importResponse.user;
}

export async function validateRowndToken(token: string): Promise<string> {
  const client = getRowndClient();
  const tokenInfo = await client.validateToken(token);
  return tokenInfo.user_id;
}

export async function fetchRowndUserInfo(userId: string): Promise<RowndUser> {
  const client = getRowndClient();
  const rowndUser = await client.fetchUserInfo({ user_id: userId });
  if (!rowndUser) {
    throw new RowndPluginError("ROWND_USER_NOT_FOUND");
  }
  return rowndUser;
}

type RowndMetadata = RowndUserMetadata & JsonRecord;

const IDENTITY_USER_DATA_FIELDS = new Set([
  "user_id",
  "email",
  "phone_number",
  "google_id",
  "apple_id",
]);

const INTERNAL_METADATA_FIELDS = new Set([
  "original_rownd_user",
  "rownd_pending_verification",
]);

function isIdentityField(field: string) {
  return IDENTITY_USER_DATA_FIELDS.has(field);
}

function isInternalMetadataField(field: string) {
  return INTERNAL_METADATA_FIELDS.has(field);
}

function getStringList(value: unknown) {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }

  return typeof value === "string" ? [value] : [];
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

export function assertRowndAppVariantIsConfigured(appVariantId?: string) {
  if (!appVariantId) {
    return;
  }

  if (pluginConfig?.subBrands && !pluginConfig.subBrands[appVariantId]) {
    throw new Error(`Unknown Rownd app variant: ${appVariantId}`);
  }
}

export async function recordRowndAppVariantForUser(
  userId: string,
  appVariantId?: string,
) {
  if (!appVariantId) {
    return;
  }

  assertRowndAppVariantIsConfigured(appVariantId);

  const metadata = await getUserMetadata(userId);
  const originalRowndUser: JsonRecord = isJsonRecord(metadata.original_rownd_user)
    ? metadata.original_rownd_user
    : {};
  const attributes: JsonRecord = isJsonRecord(originalRowndUser.attributes)
    ? originalRowndUser.attributes
    : {};
  const appVariants = getStringList(attributes["rownd:app_variants"]);

  if (appVariants.includes(appVariantId)) {
    return;
  }

  await UserMetadata.updateUserMetadata(userId, {
    ...metadata,
    original_rownd_user: {
      ...originalRowndUser,
      data: isJsonRecord(originalRowndUser.data)
        ? originalRowndUser.data
        : { user_id: userId },
      verified_data: isJsonRecord(originalRowndUser.verified_data)
        ? originalRowndUser.verified_data
        : {},
      attributes: {
        ...attributes,
        "rownd:app_variants": [...appVariants, appVariantId],
      },
    },
  });
}

export function buildRowndUserMetadata(rowndUser: RowndUser): JSONObject {
  const metadata: JsonRecord = {
    ...((rowndUser.meta || {}) as JsonRecord),
    original_rownd_user: rowndUser as unknown as JsonValue,
  };

  for (const [key, value] of Object.entries(rowndUser.data || {})) {
    if (!isIdentityField(key) && value !== undefined) {
      metadata[key] = value as JsonValue;
    }
  }

  return metadata;
}

export const RowndIsAnonymousClaim = new BooleanClaim({
  key: "is_anonymous",
  fetchValue: async (userId) => {
    const user = await SuperTokens.getUser(userId);
    const effectiveAuthLevel = getEffectiveAuthLevel(user);
    return effectiveAuthLevel === GUEST_AUTH_METHOD_ID;
  },
});

export async function buildRowndSessionClaims(
  userId: string,
  currentPayload: JsonRecord = {},
  appVariantId?: string,
) {
  const user = await SuperTokens.getUser(userId);
  const metadata = user ? await getUserMetadata(user.id) : undefined;
  const originalRowndUser = metadata?.original_rownd_user;
  const verifiedData = originalRowndUser?.verified_data as
    | JsonRecord
    | undefined;
  const authLevel = getEffectiveAuthLevel(
    user,
    originalRowndUser?.auth_level,
    verifiedData,
  );
  const appUserId = getRowndAppUserId(userId, user, currentPayload, metadata);
  const isAnonymous = authLevel === GUEST_AUTH_METHOD_ID;
  const anonymousId = getAnonymousId(userId, user, metadata);
  const isVerifiedUser = authLevel !== "unverified";
  const audience = buildRowndAudience(currentPayload, appVariantId);
  const configuredClaims = buildConfiguredSessionClaims(metadata);

  return {
    ...audience,
    ...configuredClaims,
    app_user_id: appUserId,
    auth_level: authLevel,
    is_verified_user: isVerifiedUser,
    [ROWND_JWT_CLAIMS.AppUserId]: appUserId,
    [ROWND_JWT_CLAIMS.AuthLevel]: authLevel,
    [ROWND_JWT_CLAIMS.IsVerifiedUser]: isVerifiedUser,
    [ROWND_JWT_CLAIMS.IsAnonymous]: isAnonymous,
    ...(anonymousId ? { anonymous_id: anonymousId } : {}),
  };
}

function buildConfiguredSessionClaims(metadata?: RowndMetadata): JsonRecord {
  if (!metadata) {
    return {};
  }

  const schema = pluginConfig?.schema || DEFAULT_ROWND_SCHEMA;
  const claims: JsonRecord = {};

  for (const [key, field] of Object.entries(schema)) {
    if (field.include_in_session_claims !== true) {
      continue;
    }

    const value = metadata.original_rownd_user?.data?.[key] ?? metadata[key];
    if (value !== undefined) {
      claims[field.session_claim_name || key] = value as JsonValue;
    }
  }

  return claims;
}

function getRowndAppUserId(
  userId: string,
  user: Awaited<ReturnType<typeof SuperTokens.getUser>>,
  currentPayload: JsonRecord,
  metadata?: RowndMetadata,
) {
  const originalUserId = metadata?.original_rownd_user?.data?.user_id;
  if (typeof originalUserId === "string") {
    return originalUserId;
  }

  if (typeof currentPayload.app_user_id === "string") {
    return currentPayload.app_user_id;
  }

  return user?.id || userId;
}

function buildRowndAudience(currentPayload: JsonRecord, appVariantId?: string) {
  const audience = getStringList(currentPayload.aud);
  const appId = pluginConfig?.appConfig?.id;

  if (appId) {
    audience.push(`app:${appId}`);
  }

  if (appVariantId) {
    audience.push(`app_variant:${appVariantId}`);
  }

  return audience.length > 0 ? { aud: [...new Set(audience)] } : {};
}

function getAnonymousId(
  userId: string,
  user: Awaited<ReturnType<typeof SuperTokens.getUser>>,
  metadata?: RowndMetadata,
) {
  const originalAnonymousId = metadata?.original_rownd_user?.data?.anonymous_id;
  if (typeof originalAnonymousId === "string") {
    return originalAnonymousId;
  }

  const anonymousMethod = user?.loginMethods.find((loginMethod) => {
    return (
      loginMethod.recipeId === "thirdparty" &&
      getThirdPartyId(loginMethod) === ANONYMOUS_AUTH_METHOD_ID
    );
  });
  const thirdPartyUserId = anonymousMethod
    ? getThirdPartyUserId(anonymousMethod)
    : undefined;

  return thirdPartyUserId || (hasAnonymousLoginMethod(user) ? `anon_${userId}` : undefined);
}

export async function shouldLinkRowndAccounts(
  input: Parameters<
    NonNullable<
      NonNullable<
        Parameters<typeof AccountLinking.init>[0]
      >["shouldDoAutomaticAccountLinking"]
    >
  >,
) {
  const [newAccountInfo, , session] = input;

  if (!session) {
    return undefined;
  }

  const currentUser = await SuperTokens.getUser(session.getUserId());

  if (hasOnlyGuestLoginMethods(currentUser)) {
    return {
      shouldAutomaticallyLink: true,
      shouldRequireVerification: false,
    };
  }

  if (!currentUser || isGuestAccountInfo(newAccountInfo)) {
    return undefined;
  }

  if (doesAccountInfoMatchAuthMethod(currentUser, newAccountInfo)) {
    return {
      shouldAutomaticallyLink: true,
      shouldRequireVerification: true,
    };
  }

  return undefined;
}

export type RowndVerifiableField = string;

export type RowndPendingVerification = {
  id: string;
  field: RowndVerifiableField;
  value: string;
  created_at: string;
};

export type RowndCompatUserResponse = {
  rownd_user: string;
  data: JsonRecord;
  meta: JsonRecord;
  verified_data: JsonRecord;
  state: string;
  auth_level: string;
  redacted: string[];
  groups: JSONObject[];
  attributes?: JsonRecord;
};

export async function getUserMetadata(userId: string): Promise<RowndMetadata> {
  const metadata = await UserMetadata.getUserMetadata(userId);
  return (metadata.metadata || {}) as RowndMetadata;
}

function getPendingVerifications(
  metadata: RowndMetadata,
): RowndPendingVerification[] {
  const pendingVerification = metadata.rownd_pending_verification;

  if (Array.isArray(pendingVerification)) {
    return pendingVerification.filter(isPendingVerification);
  }

  return [];
}

function isPendingVerification(
  value: unknown,
): value is RowndPendingVerification {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.field === "string" &&
    typeof value.value === "string" &&
    typeof value.created_at === "string"
  );
}

export async function getUserById(
  userId: string,
): Promise<RowndCompatUserResponse> {
  const metadata = await getUserMetadata(userId);
  const stUser = await SuperTokens.getUser(userId);

  if (!stUser) {
    throw new RowndPluginError("ROWND_USER_NOT_FOUND");
  }

  const originalRowndUser = metadata.original_rownd_user;
  const rowndUser = originalRowndUser?.data?.user_id || userId;
  const state = originalRowndUser?.state || "enabled";
  const dataFieldKeys = new Set<string>();

  const data: JsonRecord = {
    user_id: userId,
  };

  for (const [key, value] of Object.entries(originalRowndUser?.data || {})) {
    if (!isIdentityField(key)) {
      data[key] = value as JsonValue;
      dataFieldKeys.add(key);
    }
  }

  const schema = pluginConfig?.schema || DEFAULT_ROWND_SCHEMA;
  for (const key of Object.keys(schema)) {
    dataFieldKeys.add(key);
    if (
      !isInternalMetadataField(key) &&
      !isIdentityField(key) &&
      metadata[key] !== undefined
    ) {
      data[key] = metadata[key];
    }
  }

  const verifiedData: JsonRecord = {
    ...((originalRowndUser?.verified_data || {}) as JsonRecord),
  };

  for (const method of stUser.loginMethods) {
    if (method.recipeId === "passwordless") {
      if (method.email) {
        verifiedData.email = method.email;
        if (data.email === undefined) data.email = method.email;
      }
      if (method.phoneNumber) {
        verifiedData.phone_number = method.phoneNumber;
        if (data.phone_number === undefined)
          data.phone_number = method.phoneNumber;
      }
    } else if (method.recipeId === "thirdparty") {
      const thirdPartyId = getThirdPartyId(method);
      const thirdPartyUserId = getThirdPartyUserId(method);
      if (method.verified && method.email) {
        verifiedData.email = method.email;
      }
      if (method.email && data.email === undefined) {
        data.email = method.email;
      }
      if (thirdPartyId === "google" && thirdPartyUserId) {
        data.google_id = thirdPartyUserId;
        verifiedData.google_id = thirdPartyUserId;
      }
      if (thirdPartyId === "apple" && thirdPartyUserId) {
        data.apple_id = thirdPartyUserId;
        verifiedData.apple_id = thirdPartyUserId;
      }
    } else if (method.recipeId === "emailpassword") {
      if (method.email && data.email === undefined) {
        data.email = method.email;
      }
    }
  }

  if (verifiedData.email === true && typeof data.email === "string") {
    verifiedData.email = data.email;
  }
  if (
    verifiedData.phone_number === true &&
    typeof data.phone_number === "string"
  ) {
    verifiedData.phone_number = data.phone_number;
  }

  const anonymousId = getAnonymousId(stUser.id, stUser, metadata);
  if (anonymousId && data.anonymous_id === undefined) {
    data.anonymous_id = anonymousId;
  }

  const authLevel = getEffectiveAuthLevel(
    stUser,
    originalRowndUser?.auth_level,
    verifiedData,
  );

  for (const [key, field] of Object.entries(schema)) {
    if (data[key] === undefined && field.type === "string") {
      data[key] = "";
    }
  }

  const sortedByJoined = [...stUser.loginMethods].sort(
    (a, b) => a.timeJoined - b.timeJoined,
  );
  const latestSessionInfo = await getLatestSessionInfo(stUser.id);
  const firstMethod = sortedByJoined[0];
  const latestSessionRecipeUserId = latestSessionInfo?.recipeUserId.getAsString();
  const lastMethod = latestSessionRecipeUserId
    ? stUser.loginMethods.find(
      (method) => method.recipeUserId.getAsString() === latestSessionRecipeUserId,
    )
    : [...stUser.loginMethods].sort((a, b) => b.timeJoined - a.timeJoined)[0];
  const lastSignInAt = latestSessionInfo?.timeCreated ?? stUser.timeJoined;

  const metadataMeta = Object.fromEntries(
    Object.entries(metadata).filter(
      ([key]) => !isInternalMetadataField(key) && !dataFieldKeys.has(key),
    ),
  );

  const meta = {
    ...metadataMeta,
    created: new Date(stUser.timeJoined).toISOString(),
    first_sign_in: new Date(stUser.timeJoined).toISOString(),
    last_sign_in: new Date(lastSignInAt).toISOString(),
    last_active: new Date(lastSignInAt).toISOString(),
    first_sign_in_method: firstMethod ? mapMethod(firstMethod) : "email",
    last_sign_in_method: lastMethod ? mapMethod(lastMethod) : "email",
  };

  return {
    rownd_user: rowndUser,
    data,
    meta,
    verified_data: verifiedData,
    state,
    auth_level: authLevel,
    redacted: [],
    groups: (originalRowndUser?.groups || []) as JSONObject[],
    attributes: (originalRowndUser?.attributes || {}) as JsonRecord,
  };
}

async function getLatestSessionInfo(userId: string) {
  const sessionHandles = await Session.getAllSessionHandlesForUser(
    userId,
    true,
    PUBLIC_TENANT_ID,
  );
  const sessionInfos = await Promise.all(
    sessionHandles.map((sessionHandle) =>
      Session.getSessionInformation(sessionHandle),
    ),
  );

  let latestSessionInfo: (typeof sessionInfos)[number];
  for (const sessionInfo of sessionInfos) {
    if (
      sessionInfo &&
      (!latestSessionInfo ||
        sessionInfo.timeCreated > latestSessionInfo.timeCreated)
    ) {
      latestSessionInfo = sessionInfo;
    }
  }

  return latestSessionInfo;
}

export async function updateUserData(userId: string, inputData: JsonRecord) {
  const metadata = await getUserMetadata(userId);
  const updatedMetadata: JSONObject = {
    ...metadata,
    ...inputData,
  };

  await UserMetadata.updateUserMetadata(userId, updatedMetadata);
  return getUserById(userId);
}

export async function startPendingEmailVerification(input: {
  userId: string;
  recipeUserId: Parameters<
    typeof EmailVerification.sendEmailVerificationEmail
  >[2];
  email: string;
  tenantId: string;
  pendingVerificationId: string;
  userContext?: JsonRecord;
}) {
  const metadata = await getUserMetadata(input.userId);
  const currentEmail = (await getUserById(input.userId)).data.email;
  const pendingVerifications = getPendingVerifications(metadata);
  const pendingEmailVerifications = pendingVerifications.filter(
    (pendingVerification) => pendingVerification.field === "email",
  );

  if (currentEmail === input.email) {
    for (const pendingVerification of pendingEmailVerifications) {
      await EmailVerification.revokeEmailVerificationTokens(
        input.tenantId,
        input.recipeUserId,
        pendingVerification.value,
        input.userContext,
      );
    }

    if (pendingEmailVerifications.length > 0) {
      await UserMetadata.updateUserMetadata(input.userId, {
        ...metadata,
        rownd_pending_verification: pendingVerifications.filter(
          (pendingVerification) => pendingVerification.field !== "email",
        ),
      });
    }

    return getUserById(input.userId);
  }

  for (const pendingVerification of pendingEmailVerifications) {
    await EmailVerification.revokeEmailVerificationTokens(
      input.tenantId,
      input.recipeUserId,
      pendingVerification.value,
      input.userContext,
    );
  }

  const pendingVerification: RowndPendingVerification = {
    id: input.pendingVerificationId,
    field: "email",
    value: input.email,
    created_at: new Date().toISOString(),
  };

  await UserMetadata.updateUserMetadata(input.userId, {
    ...metadata,
    rownd_pending_verification: [
      ...pendingVerifications.filter(
        (pendingVerification) => pendingVerification.field !== "email",
      ),
      pendingVerification,
    ],
  });

  const response = await EmailVerification.sendEmailVerificationEmail(
    input.tenantId,
    input.userId,
    input.recipeUserId,
    input.email,
    {
      ...input.userContext,
      rowndPendingVerificationId: pendingVerification.id,
    },
  );

  if (response.status === "EMAIL_ALREADY_VERIFIED_ERROR") {
    await completePendingEmailVerification({
      recipeUserId: input.recipeUserId,
      email: input.email,
      userContext: input.userContext,
    });
  }

  return getUserById(input.userId);
}

export async function completePendingEmailVerification(input: {
  recipeUserId: Parameters<typeof AccountLinking.createPrimaryUser>[0];
  email: string;
  userContext?: JsonRecord;
}) {
  const user = await SuperTokens.getUser(
    input.recipeUserId.getAsString(),
    input.userContext,
  );
  const userId = user?.id ?? input.recipeUserId.getAsString();
  const metadata = await getUserMetadata(userId);
  const pendingVerifications = getPendingVerifications(metadata);
  const pendingVerification = pendingVerifications.find(
    (pendingVerification) => isMatchingPendingEmailVerification(
      pendingVerification,
      input.email,
    ),
  );

  if (!pendingVerification) {
    return;
  }

  let metadataUserId = userId;
  const passwordlessEmailMethod = getPasswordlessEmailLoginMethod(user);
  if (passwordlessEmailMethod) {
    const updateResult = await Passwordless.updateUser({
      recipeUserId: passwordlessEmailMethod.recipeUserId,
      email: input.email,
      userContext: input.userContext,
    });

    if (updateResult.status !== "OK") {
      throw new Error(
        `Failed to update verified email method: ${updateResult.status}`,
      );
    }
  } else if (hasOnlyGuestLoginMethods(user)) {
    const isPasswordlessSignUpAllowed = await AccountLinking.isSignUpAllowed(
      PUBLIC_TENANT_ID,
      {
        recipeId: "passwordless",
        email: input.email,
      },
      true,
      undefined,
      input.userContext,
    );

    if (!isPasswordlessSignUpAllowed) {
      throw new Error("Passwordless sign up is not allowed for this email");
    }

    const passwordlessUser = await Passwordless.signInUp({
      email: input.email,
      tenantId: PUBLIC_TENANT_ID,
      userContext: input.userContext,
    });

    const primaryUserResult = await AccountLinking.createPrimaryUser(
      passwordlessUser.recipeUserId,
      input.userContext,
    );

    const primaryUserId =
      primaryUserResult.status === "OK"
        ? primaryUserResult.user.id
        : primaryUserResult.status ===
            "RECIPE_USER_ID_ALREADY_LINKED_WITH_PRIMARY_USER_ID_ERROR"
          ? primaryUserResult.primaryUserId
          : passwordlessUser.user.id;

    if (userId !== primaryUserId) {
      const linkResult = await AccountLinking.linkAccounts(
        input.recipeUserId,
        primaryUserId,
        input.userContext,
      );

      if (linkResult.status !== "OK") {
        throw new Error(
          `Failed to link verified email method: ${linkResult.status}`,
        );
      }
    }

    metadataUserId = primaryUserId;
  }

  const targetMetadata =
    metadataUserId === userId ? metadata : await getUserMetadata(metadataUserId);
  const originalRowndUser =
    targetMetadata.original_rownd_user ?? metadata.original_rownd_user;
  const targetPendingVerifications = getPendingVerifications(targetMetadata);
  const updatedMetadata: RowndMetadata = {
    ...targetMetadata,
    ...(originalRowndUser
      ? {
        original_rownd_user: {
          ...originalRowndUser,
          data: {
            ...originalRowndUser.data,
            email: input.email,
          },
          verified_data: {
            ...originalRowndUser.verified_data,
            email: input.email,
          },
        },
      }
      : {}),
    rownd_pending_verification: targetPendingVerifications.filter(
      (verification) => !isMatchingPendingEmailVerification(
        verification,
        input.email,
      ),
    ),
  };

  await UserMetadata.updateUserMetadata(metadataUserId, updatedMetadata);
}

function isMatchingPendingEmailVerification(
  verification: RowndPendingVerification,
  email: string,
) {
  return verification.field === "email" && verification.value === email;
}

export async function updateUserMetadata(
  userId: string,
  inputMeta: JsonRecord,
) {
  const metadata = await getUserMetadata(userId);
  const updatedMetadata: JSONObject = {
    ...metadata,
    ...inputMeta,
  };

  await UserMetadata.updateUserMetadata(userId, updatedMetadata);

  return {
    id: userId,
    meta: Object.fromEntries(
      Object.entries(updatedMetadata).filter(
        ([key]) => !isInternalMetadataField(key),
      ),
    ) as JsonRecord,
  };
}

type SuperTokensUser = NonNullable<Awaited<ReturnType<typeof SuperTokens.getUser>>>;
type SuperTokensLoginMethod = SuperTokensUser["loginMethods"][number];

function mapMethod(method: SuperTokensLoginMethod) {
  if (method.recipeId === "thirdparty") {
    if (getThirdPartyId(method) === "google") return "google";
    if (getThirdPartyId(method) === "apple") return "apple";
  } else if (method.recipeId === "passwordless") {
    if (method.email) return "email";
    if (method.phoneNumber) return "phone";
  } else if (method.recipeId === "emailpassword") {
    return "email";
  }

  return "email";
}

function getThirdPartyId(method: SuperTokensLoginMethod) {
  return method.thirdParty?.id;
}

function getThirdPartyUserId(method: SuperTokensLoginMethod) {
  return method.thirdParty?.userId;
}

function getGuestAuthLevel(
  user: Awaited<ReturnType<typeof SuperTokens.getUser>>,
) {
  const guestMethod = user?.loginMethods.find(isGuestLoginMethod);

  return guestMethod ? GUEST_AUTH_METHOD_ID : undefined;
}

function hasAnonymousLoginMethod(
  user: Awaited<ReturnType<typeof SuperTokens.getUser>>,
) {
  return !!user?.loginMethods.some((loginMethod) => {
    return (
      loginMethod.recipeId === "thirdparty" &&
      getThirdPartyId(loginMethod) === ANONYMOUS_AUTH_METHOD_ID
    );
  });
}

function getPasswordlessEmailLoginMethod(
  user: Awaited<ReturnType<typeof SuperTokens.getUser>>,
) {
  return user?.loginMethods.find((method) => {
    return method.recipeId === "passwordless" && !!method.email;
  });
}

function hasOnlyGuestLoginMethods(
  user: Awaited<ReturnType<typeof SuperTokens.getUser>>,
) {
  return (
    !!user?.loginMethods.length && user.loginMethods.every(isGuestLoginMethod)
  );
}

function isGuestLoginMethod(method: SuperTokensLoginMethod) {
  const thirdPartyId = getThirdPartyId(method);
  return (
    method.recipeId === "thirdparty" &&
    (thirdPartyId === GUEST_AUTH_METHOD_ID ||
      thirdPartyId === ANONYMOUS_AUTH_METHOD_ID)
  );
}

function isGuestAccountInfo(input?: {
  recipeId: string;
  thirdParty?: { id: string };
}) {
  return (
    input?.recipeId === "thirdparty" &&
    (input.thirdParty?.id === GUEST_AUTH_METHOD_ID ||
      input.thirdParty?.id === ANONYMOUS_AUTH_METHOD_ID)
  );
}

function doesAccountInfoMatchAuthMethod(
  user: Awaited<ReturnType<typeof SuperTokens.getUser>>,
  accountInfo: {
    recipeId: string;
    email?: string;
    phoneNumber?: string;
    thirdParty?: { id: string; userId: string };
  },
) {
  if (!user) {
    return false;
  }

  const normalizedEmail = accountInfo.email?.toLowerCase();
  if (normalizedEmail) {
    return user.loginMethods.some((method) => {
      if (isGuestLoginMethod(method) || !method.email) {
        return false;
      }

      return method.email.toLowerCase() === normalizedEmail;
    });
  }

  if (accountInfo.phoneNumber) {
    return user.loginMethods.some((method) => {
      return (
        !isGuestLoginMethod(method) &&
        method.phoneNumber === accountInfo.phoneNumber
      );
    });
  }

  return false;
}

function hasVerifiedRealLoginMethod(
  user: Awaited<ReturnType<typeof SuperTokens.getUser>>,
) {
  return !!user?.loginMethods.some((method) => {
    if (isGuestLoginMethod(method)) {
      return false;
    }

    if (method.recipeId === "passwordless") {
      return !!(method.email || method.phoneNumber);
    }

    if (method.recipeId === "thirdparty") {
      return !!getThirdPartyUserId(method) && method.verified === true;
    }

    if (method.recipeId === "emailpassword") {
      return !!method.email && method.verified === true;
    }

    return method.verified === true;
  });
}

export function getEffectiveAuthLevel(
  user: Awaited<ReturnType<typeof SuperTokens.getUser>>,
  originalAuthLevel?: string,
  verifiedData?: JsonRecord,
) {
  if (hasVerifiedRealLoginMethod(user)) {
    return "verified";
  }

  return (
    getGuestAuthLevel(user) ||
    originalAuthLevel ||
    (verifiedData && Object.keys(verifiedData).length > 0
      ? "verified"
      : "unverified")
  );
}

export function canUpdateUserDataField(field: string) {
  const schema = pluginConfig?.schema || DEFAULT_ROWND_SCHEMA;
  const schemaField = schema[field];

  if (!schemaField) {
    return false;
  }

  const ownedBy =
    field === "google_id" || field === "apple_id"
      ? "app"
      : schemaField.owned_by || "user";

  return ownedBy !== "app" && schemaField.read_only !== true;
}

const BUILTIN_SIGN_IN_METHOD_KEYS = [
  "email",
  "phone",
  "google",
  "apple",
  "anonymous",
];

function normalizeSchemaField(key: string, field: RowndSchemaField) {
  let ownedBy = field.owned_by;

  if (key === "google_id" || key === "apple_id") {
    ownedBy = "app";
  } else if (!ownedBy) {
    ownedBy = "user";
  }

  return {
    display_name: field.display_name,
    type: field.type,
    owned_by: ownedBy,
    user_visible: field.user_visible,
    read_only: field.read_only ?? ownedBy === "app",
    show_empty: field.show_empty ?? false,
  };
}

export const DEFAULT_PRIMARY_COLOR = "#5b5bd6";

function buildSignInMethodsConfig(
  methodsArray: RowndSignInMethod[] | undefined,
) {
  const methods = (methodsArray ?? []).reduce(
    (acc, curr) => {
      acc[curr.method] = curr;
      return acc;
    },
    {} as Record<string, RowndSignInMethod>,
  );

  const customProviders = Object.fromEntries(
    Object.entries(methods)
      .filter(([key]) => !BUILTIN_SIGN_IN_METHOD_KEYS.includes(key))
      .map(([key, val]) => {
        return val
          ? [
            key,
            {
              enabled: true,
              display_name:
                  getStringMethodProperty(val, "displayName") ?? key,
              icon_light_url: getStringMethodProperty(val, "iconLightUrl"),
              icon_dark_url: getStringMethodProperty(val, "iconDarkUrl"),
            },
          ]
          : [key, undefined];
      })
      .filter(([, v]) => v !== undefined),
  );

  const googleMethod = methods.google;
  const appleMethod = methods.apple;
  const anonymousMethod = methods.anonymous;
  const anonymousType = getAnonymousType(anonymousMethod);
  const googleOneTap = getOneTapConfig(googleMethod);

  return {
    email: { enabled: !!methods.email },
    phone: { enabled: !!methods.phone },
    google: {
      enabled: !!googleMethod,
      client_id: getStringMethodProperty(googleMethod, "clientId") ?? "",
      ios_client_id: getStringMethodProperty(googleMethod, "iosClientId") ?? "",
      scopes: getStringArrayMethodProperty(googleMethod, "scopes") ?? [],
      ...(getSignInFasterWithGoogle(googleMethod)
        ? { sign_in_faster_with_google: getSignInFasterWithGoogle(googleMethod) }
        : {}),
      one_tap: {
        browser: {
          auto_prompt: googleOneTap?.browser?.autoPrompt ?? false,
          delay: googleOneTap?.browser?.delay ?? 7000,
        },
        mobile_app: {
          auto_prompt: googleOneTap?.mobileApp?.autoPrompt ?? false,
          delay: googleOneTap?.mobileApp?.delay ?? 7000,
        },
      },
    },
    apple: {
      enabled: !!appleMethod,
      client_id: getStringMethodProperty(appleMethod, "clientId") ?? "",
    },
    anonymous: {
      enabled: !!anonymousMethod && anonymousType !== "instant",
      ...(anonymousMethod && anonymousType !== "instant" ? { type: anonymousType } : {}),
      ...(anonymousType !== "instant" &&
          getStringMethodProperty(anonymousMethod, "displayName") !== undefined
        ? {
          display_name: getStringMethodProperty(
            anonymousMethod,
            "displayName",
          ),
        }
        : {}),
      ...(anonymousType !== "instant" &&
          getStringMethodProperty(anonymousMethod, "iconLightUrl") !== undefined
        ? {
          icon_light_url: getStringMethodProperty(
            anonymousMethod,
            "iconLightUrl",
          ),
        }
        : {}),
      ...(anonymousType !== "instant" &&
          getStringMethodProperty(anonymousMethod, "iconDarkUrl") !== undefined
        ? {
          icon_dark_url: getStringMethodProperty(
            anonymousMethod,
            "iconDarkUrl",
          ),
        }
        : {}),
    },
    ...customProviders,
  };
}

function isInstantAnonymousMethod(methods: RowndSignInMethod[] | undefined) {
  return (methods ?? []).some(
    (method) => method.method === "anonymous" && getAnonymousType(method) === "instant",
  );
}

function getAnonymousType(method: RowndSignInMethod | undefined) {
  const type = getStringMethodProperty(method, "type");
  return type === "instant" ? "instant" : "guest";
}

function getSignInFasterWithGoogle(method: RowndSignInMethod | undefined) {
  const value = getStringMethodProperty(method, "signInFasterWithGoogle");
  return value === "enabled" || value === "disabled" ? value : undefined;
}

function getMethodProperty(
  method: RowndSignInMethod | undefined,
  property: string,
) {
  if (!method) {
    return undefined;
  }

  return (method as RowndSignInMethod & Record<string, unknown>)[property];
}

function getStringMethodProperty(
  method: RowndSignInMethod | undefined,
  property: string,
) {
  const value = getMethodProperty(method, property);
  return typeof value === "string" ? value : undefined;
}

function getStringArrayMethodProperty(
  method: RowndSignInMethod | undefined,
  property: string,
) {
  const value = getMethodProperty(method, property);
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "string")
    ? value
    : undefined;
}

function getOneTapConfig(method: RowndSignInMethod | undefined) {
  const oneTap = getMethodProperty(method, "oneTap");
  if (!isRecord(oneTap)) {
    return undefined;
  }

  return {
    browser: parseOneTapPlatform(oneTap.browser),
    mobileApp: parseOneTapPlatform(oneTap.mobileApp),
  };
}

function parseOneTapPlatform(value: unknown) {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    autoPrompt:
      typeof value.autoPrompt === "boolean" ? value.autoPrompt : undefined,
    delay: typeof value.delay === "number" ? value.delay : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getSubBrandVariant(app: unknown) {
  if (isRecord(app) && isRecord(app.variant) && typeof app.variant.id === "string") {
    return app.variant as RowndSubBrandConfigInput["variant"];
  }

  return undefined;
}

function mergeConfigInput<T extends Record<string, unknown>>(
  base: T,
  override: Record<string, unknown>,
): T {
  const result: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) {
      continue;
    }

    const existing = result[key];
    result[key] = isRecord(existing) && isRecord(value)
      ? mergeConfigInput(existing, value)
      : value;
  }

  return result as T;
}

export function buildAppConfig(
  config: RowndPluginNormalisedConfig,
  stConfig: SuperTokensPublicConfig,
  appVariantId?: string,
) {
  const userSchema = config.schema ?? DEFAULT_ROWND_SCHEMA;
  const baseApp = config.appConfig ?? {};
  const subBrand = appVariantId ? config.subBrands?.[appVariantId] : undefined;
  const app = appVariantId
    ? subBrand && mergeConfigInput(baseApp, subBrand as unknown as Record<string, unknown>)
    : baseApp;

  if (!app) {
    return undefined;
  }

  const branding = app.branding ?? {};
  const auth = app.auth ?? {};
  const signInMethods = buildSignInMethodsConfig(app.signInMethods);
  const variant = getSubBrandVariant(app);

  const finalSchema: Record<string, RowndSchemaField> = { ...userSchema };

  // Inject auth fields if not present
  if (signInMethods.email.enabled && !finalSchema.email) {
    finalSchema.email = {
      display_name: "Email",
      type: "string",
      user_visible: true,
    };
  }
  if (signInMethods.phone.enabled && !finalSchema.phone_number) {
    finalSchema.phone_number = {
      display_name: "Phone number",
      type: "string",
      user_visible: true,
    };
  }
  if (signInMethods.google.enabled && !finalSchema.google_id) {
    finalSchema.google_id = {
      display_name: "Google ID",
      type: "string",
      user_visible: false,
    };
  }
  if (signInMethods.apple.enabled && !finalSchema.apple_id) {
    finalSchema.apple_id = {
      display_name: "Apple ID",
      type: "string",
      user_visible: false,
    };
  }

  return {
    config_type: appVariantId ? "variant" : "app",
    ...(variant ? { variant } : {}),
    app: {
      id: app.id ?? "",
      name: app.name ?? stConfig.appInfo.appName,
      icon: app.icon ?? "",
      ...(app.userVerificationFields
        ? { user_verification_fields: app.userVerificationFields }
        : {}),
      schema: Object.fromEntries(
        Object.entries(finalSchema).map(([key, field]) => [
          key,
          normalizeSchemaField(key, field),
        ]),
      ),
      config: {
        ...(app.capabilities ? { capabilities: app.capabilities } : {}),
        ...(app.web ? { web: app.web } : {}),
        ...(app.bottomSheet ? { bottom_sheet: app.bottomSheet } : {}),
        ...(app.profileStorageVersion
          ? { profile_storage_version: app.profileStorageVersion }
          : {}),
        customizations: {
          primary_color: branding.primaryColor ?? DEFAULT_PRIMARY_COLOR,
          ...(branding.logo ? { logo: branding.logo } : {}),
          ...(branding.logoDarkMode
            ? { logo_dark_mode: branding.logoDarkMode }
            : {}),
          ...(branding.animations ? { animations: branding.animations } : {}),
        },
        hub: {
          ...(app.allowedWebOrigins
            ? { allowed_web_origins: app.allowedWebOrigins }
            : {}),
          customizations: {
            rounded_corners: branding.roundedCorners ?? true,
            ...(branding.containerBorderRadius !== undefined
              ? { container_border_radius: branding.containerBorderRadius }
              : {}),
            ...(branding.placement !== undefined
              ? { placement: branding.placement }
              : {}),
            ...(branding.hubPrimaryColor !== undefined
              ? { primary_color: branding.hubPrimaryColor }
              : {}),
            ...(branding.primaryColorDarkMode !== undefined
              ? { primary_color_dark_mode: branding.primaryColorDarkMode }
              : {}),
            ...(branding.backgroundColor !== undefined
              ? { background_color: branding.backgroundColor }
              : {}),
            ...(branding.fontFamily !== undefined
              ? { font_family: branding.fontFamily }
              : {}),
            ...(branding.hideVerificationIcons !== undefined
              ? { hide_verification_icons: branding.hideVerificationIcons }
              : {}),
            visual_swoops: branding.visualSwoops ?? true,
            blur_background: branding.blurBackground ?? true,
            ...(branding.blurBackgroundOpacity !== undefined
              ? { blur_background_opacity: branding.blurBackgroundOpacity }
              : {}),
            ...(branding.offsetX !== undefined ? { offset_x: branding.offsetX } : {}),
            ...(branding.offsetY !== undefined ? { offset_y: branding.offsetY } : {}),
            ...(branding.propertyOverrides
              ? { property_overrides: branding.propertyOverrides }
              : {}),
            dark_mode: branding.darkMode ?? "auto",
          },
          ...(branding.customScripts
            ? { custom_scripts: branding.customScripts }
            : {}),
          ...(branding.customStyles
            ? { custom_styles: branding.customStyles }
            : {}),
          auth: {
            email: buildAuthEmailConfig(auth.email),
            ...(auth.mobile ? { mobile: buildAuthMobileConfig(auth.mobile) } : {}),
            sign_in_methods: signInMethods,
            additional_fields: auth.additionalFields ?? [],
            ...(auth.rememberSignInMethod !== undefined
              ? { remember_sign_in_method: auth.rememberSignInMethod }
              : {}),
            ...(auth.useExplicitSignUpFlow !== undefined
              ? { use_explicit_sign_up_flow: auth.useExplicitSignUpFlow }
              : {}),
            ...(auth.allowUnverifiedUsers !== undefined
              ? { allow_unverified_users: auth.allowUnverifiedUsers }
              : {}),
            ...(auth.primarySignUpMethod
              ? { primary_sign_up_method: auth.primarySignUpMethod }
              : {}),
            ...(auth.preferredMethod
              ? { preferred_method: auth.preferredMethod }
              : {}),
            ...(auth.order ? { order: auth.order } : {}),
            ...(isInstantAnonymousMethod(app.signInMethods)
              ? { instant_user: { enabled: true } }
              : {}),
            show_app_icon: branding.showAppIcon ?? false,
          },
          legal: {
            ...(app.legal?.companyName
              ? { company_name: app.legal.companyName }
              : {}),
            ...(app.legal?.privacyPolicyUrl
              ? { privacy_policy_url: app.legal.privacyPolicyUrl }
              : {}),
            ...(app.legal?.termsConditionsUrl
              ? { terms_conditions_url: app.legal.termsConditionsUrl }
              : {}),
            ...(app.legal?.supportEmail
              ? { support_email: app.legal.supportEmail }
              : {}),
          },
          custom_content: {
            ...(app.customContent?.signInModal
              ? {
                sign_in_modal: {
                  ...(app.customContent.signInModal.title
                    ? { title: app.customContent.signInModal.title }
                    : {}),
                  ...(app.customContent.signInModal.subtitle
                    ? { subtitle: app.customContent.signInModal.subtitle }
                    : {}),
                  ...(app.customContent.signInModal.signInTitle
                    ? {
                      sign_in_title:
                            app.customContent.signInModal.signInTitle,
                    }
                    : {}),
                  ...(app.customContent.signInModal.signUpTitle
                    ? {
                      sign_up_title:
                            app.customContent.signInModal.signUpTitle,
                    }
                    : {}),
                  ...(app.customContent.signInModal.signInSubtitle
                    ? {
                      sign_in_subtitle:
                            app.customContent.signInModal.signInSubtitle,
                    }
                    : {}),
                  ...(app.customContent.signInModal.signUpSubtitle
                    ? {
                      sign_up_subtitle:
                            app.customContent.signInModal.signUpSubtitle,
                    }
                    : {}),
                  ...(app.customContent.signInModal.signInButton
                    ? {
                      sign_in_button:
                            app.customContent.signInModal.signInButton,
                    }
                    : {}),
                  ...(app.customContent.signInModal.signUpButton
                    ? {
                      sign_up_button:
                            app.customContent.signInModal.signUpButton,
                    }
                    : {}),
                },
              }
              : {}),
            ...(app.customContent?.profileModal
              ? { profile_modal: app.customContent.profileModal }
              : {}),
            ...(app.customContent?.verificationModal
              ? {
                verification_modal: {
                  ...(app.customContent.verificationModal.title
                    ? { title: app.customContent.verificationModal.title }
                    : {}),
                  ...(app.customContent.verificationModal.subtitle
                    ? { subtitle: app.customContent.verificationModal.subtitle }
                    : {}),
                },
              }
              : {}),
            ...(app.customContent?.signInFailureModal
              ? {
                sign_in_failure_modal: {
                  failure_message:
                      app.customContent.signInFailureModal.failureMessage,
                },
              }
              : {}),
            ...(app.customContent?.noAccountMessage
              ? { no_account_message: app.customContent.noAccountMessage }
              : {}),
            ...(app.customContent?.mobile
              ? { mobile: app.customContent.mobile }
              : {}),
          },
          profile: {
            ...(app.profile?.accountInformation
              ? { account_information: app.profile.accountInformation }
              : {}),
            ...(app.profile?.personalInformation
              ? { personal_information: app.profile.personalInformation }
              : {}),
            ...(app.profile?.preferences
              ? { preferences: app.profile.preferences }
              : {}),
            ...(app.profile?.signOutButton
              ? { sign_out_button: app.profile.signOutButton }
              : {}),
            ...(app.profile?.deleteAccountButton
              ? { delete_account_button: app.profile.deleteAccountButton }
              : {}),
            ...(app.profile?.addSignInMethodsButton
              ? { add_sign_in_methods_button: app.profile.addSignInMethodsButton }
              : {}),
          },
        },
      },
    },
  };
}

function buildAuthEmailConfig(authEmail?: RowndAuthConfig["email"]) {
  return {
    from_address: authEmail?.fromAddress ?? "no-reply@rownd.io",
    image: authEmail?.image ?? "",
    ...(authEmail?.subject ? { subject: authEmail.subject } : {}),
    ...(authEmail?.callToActionText
      ? { call_to_action_text: authEmail.callToActionText }
      : {}),
    ...(authEmail?.verifyTemplate
      ? { verify_template: authEmail.verifyTemplate }
      : {}),
    ...(authEmail?.customContent
      ? { custom_content: authEmail.customContent }
      : {}),
    ...(authEmail?.customClosingContent
      ? { custom_closing_content: authEmail.customClosingContent }
      : {}),
  };
}

function buildAuthMobileConfig(authMobile: RowndAuthConfig["mobile"]) {
  return {
    ...(authMobile?.title ? { title: authMobile.title } : {}),
    ...(authMobile?.image ? { image: authMobile.image } : {}),
    ...(authMobile?.callToActionText
      ? { call_to_action_text: authMobile.callToActionText }
      : {}),
    ...(authMobile?.hyperlinkText
      ? { hyperlink_text: authMobile.hyperlinkText }
      : {}),
    ...(authMobile?.hyperlinkRedirectUrl
      ? { hyperlink_redirect_url: authMobile.hyperlinkRedirectUrl }
      : {}),
    ...(authMobile?.customContent
      ? { custom_content: authMobile.customContent }
      : {}),
  };
}

import { randomUUID } from "crypto";
import SuperTokens from "supertokens-node";
import EmailVerification from "supertokens-node/recipe/emailverification";
import Session from "supertokens-node/recipe/session";
import { BooleanClaim } from "supertokens-node/recipe/session/claims";
import ThirdParty from "supertokens-node/recipe/thirdparty";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import {
  RowndUser,
  SuperTokensUserImport,
  IRowndClient,
  RowndPluginNormalisedConfig,
  RowndSignInMethod,
  RowndSchemaField,
} from "./types";
import { RowndPluginError } from "./errors";
import {
  ANONYMOUS_AUTH_METHOD_ID,
  DEFAULT_ROWND_SCHEMA,
  GUEST_AUTH_METHOD_ID,
  PUBLIC_TENANT_ID,
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
  return async () => ({
    status: "OK" as const,
    ...buildAppConfig(deps.pluginConfig, deps.stConfig),
  });
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
      const thirdPartyId =
        body.authLevel === ANONYMOUS_AUTH_METHOD_ID
          ? ANONYMOUS_AUTH_METHOD_ID
          : GUEST_AUTH_METHOD_ID;

      const response = await ThirdParty.manuallyCreateOrUpdateUser(
        PUBLIC_TENANT_ID,
        thirdPartyId,
        guestId,
        `${guestId}@anonymous.local`,
        false,
        undefined,
        userContext,
      );

      if (response.status !== "OK") {
        throw new Error(
          `Guest user creation failed with status: ${response.status}`,
        );
      }

      await UserMetadata.updateUserMetadata(response.user.id, {
        auth_level: thirdPartyId,
        is_anonymous: true,
      });

      await Session.createNewSession(
        req,
        res,
        PUBLIC_TENANT_ID,
        response.recipeUserId,
        {
          auth_level: thirdPartyId,
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

      if (!recipeUserId) {
        throw new Error("User not found or has no login methods");
      }

      await Session.createNewSession(
        req,
        res,
        PUBLIC_TENANT_ID,
        recipeUserId,
        {},
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
    const payload = parseUpdateUserBody(await getJsonBody(req));
    const inputData = payload.data ?? {};
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
          userContext,
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
      meta: metadata.meta,
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

    const metadata = await getUserMetadata(session.getUserId());
    return {
      status: "OK" as const,
      value: metadata.data[field],
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
          userContext,
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

function parseUpdateUserBody(value: unknown): { data?: JsonRecord } {
  if (!isJsonRecord(value) || !isJsonRecord(value.data)) {
    return {};
  }

  return { data: value.data };
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
  tenantIds?: string[],
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
      ...(tenantIds ? { tenantIds } : {}),
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
      ...(tenantIds ? { tenantIds } : {}),
    });
  }

  if (rowndUserData.phone_number) {
    loginMethods.push({
      recipeId: "passwordless",
      phoneNumber: rowndUserData.phone_number,
      isVerified: !!rowndUserVerifiedData.phone_number,
      ...(tenantIds ? { tenantIds } : {}),
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
      ...(tenantIds ? { tenantIds } : {}),
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
      ...(tenantIds ? { tenantIds } : {}),
    });
  }

  const rowndUserMeta = (rowndUser.meta || {}) as JSONObject;
  const rowndUserAttributes = (rowndUser.attributes || {}) as JSONObject;
  const rowndUserDataJson = rowndUserData as JSONObject;
  const rowndUserVerifiedDataJson = rowndUserVerifiedData as JSONObject;

  const userMetadata: JSONObject = {
    data: {
      ...rowndUserDataJson,
    },
    meta: {
      ...rowndUserMeta,
    },
    verified_data: {
      ...rowndUserVerifiedDataJson,
    },
    attributes: {
      ...rowndUserAttributes,
    },
    rownd_migrated: true,
    rownd_user_id: rowndUserData.user_id,
    state: rowndUser.state,
    auth_level: authLevel,
  };

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

type RowndMetadata = {
  data: JsonRecord;
  meta: JsonRecord;
  verified_data: JsonRecord;
  attributes: JsonRecord;
  rownd_pending_verification?: RowndPendingVerification | null;
  rownd_migrated?: boolean;
  rownd_user_id?: string;
  state?: string;
  auth_level?: string;
  is_anonymous?: boolean;
};

export const RowndIsAnonymousClaim = new BooleanClaim({
  key: "is_anonymous",
  fetchValue: async (userId) => {
    const metadata = await getUserMetadata(userId);
    return (
      metadata.is_anonymous === true ||
      metadata.auth_level === GUEST_AUTH_METHOD_ID ||
      metadata.auth_level === ANONYMOUS_AUTH_METHOD_ID
    );
  },
});

export type RowndPendingVerification = {
  id: string;
  field: "email";
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
  const rowndMetadata = (metadata.metadata || {}) as Partial<RowndMetadata>;

  return {
    data: rowndMetadata.data || {},
    meta: rowndMetadata.meta || {},
    verified_data: rowndMetadata.verified_data || {},
    attributes: rowndMetadata.attributes || {},
    rownd_pending_verification: rowndMetadata.rownd_pending_verification,
    rownd_migrated: rowndMetadata.rownd_migrated,
    rownd_user_id: rowndMetadata.rownd_user_id,
    state: rowndMetadata.state,
    auth_level: rowndMetadata.auth_level,
    is_anonymous: rowndMetadata.is_anonymous,
  };
}

export async function getUserById(
  userId: string,
): Promise<RowndCompatUserResponse> {
  const metadata = await getUserMetadata(userId);
  const stUser = await SuperTokens.getUser(userId);

  if (!stUser) {
    throw new RowndPluginError("ROWND_USER_NOT_FOUND");
  }

  const rowndUser = metadata.rownd_user_id || userId;
  const state = metadata.state || "enabled";

  const data: JsonRecord = {
    user_id: userId,
    ...metadata.data,
  };

  const verifiedData: JsonRecord = {
    ...metadata.verified_data,
  };

  let lastUsedAt = stUser.timeJoined;

  for (const method of stUser.loginMethods as RowndLoginMethod[]) {
    if (typeof method.lastUsed === "number" && method.lastUsed > lastUsedAt) {
      lastUsedAt = method.lastUsed;
    }

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
      if (method.verified && method.email) {
        verifiedData.email = method.email;
      }
      if (method.email && data.email === undefined) {
        data.email = method.email;
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

  const authLevel =
    metadata.auth_level ||
    (Object.keys(verifiedData).length > 0 ? "verified" : "unverified");

  const schema = pluginConfig?.schema || DEFAULT_ROWND_SCHEMA;
  for (const [key, field] of Object.entries(schema)) {
    if (data[key] === undefined && field.type === "string") {
      data[key] = "";
    }
  }

  const mapMethod = (method: RowndLoginMethod) => {
    if (method.recipeId === "thirdparty") {
      if (method.thirdPartyId === "google") return "google";
      if (method.thirdPartyId === "apple") return "apple";
    } else if (method.recipeId === "passwordless") {
      if (method.email) return "email";
      if (method.phoneNumber) return "phone";
    } else if (method.recipeId === "emailpassword") {
      return "email";
    }
    return "email";
  };

  const sortedByJoined = [...stUser.loginMethods].sort(
    (a, b) => a.timeJoined - b.timeJoined,
  );
  const sortedByLastUsed = [
    ...(stUser.loginMethods as RowndLoginMethod[]),
  ].sort((a, b) => (b.lastUsed || b.timeJoined) - (a.lastUsed || a.timeJoined));

  const firstMethod = sortedByJoined[0];
  const lastMethod = sortedByLastUsed[0];

  const meta = {
    ...metadata.meta,
    created: new Date(stUser.timeJoined).toISOString(),
    first_sign_in: new Date(stUser.timeJoined).toISOString(),
    last_sign_in: new Date(lastUsedAt).toISOString(),
    last_active: new Date(lastUsedAt).toISOString(),
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
    groups: [],
    attributes: metadata.attributes,
  };
}

export async function updateUserData(userId: string, inputData: JsonRecord) {
  const metadata = await getUserMetadata(userId);
  const updatedMetadata: JSONObject = {
    ...metadata,
    data: {
      ...metadata.data,
      ...inputData,
      user_id: userId,
    },
    meta: {
      ...metadata.meta,
    },
    verified_data: {
      ...metadata.verified_data,
    },
    attributes: {
      ...metadata.attributes,
    },
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
  const currentEmail = metadata.data.email;
  if (currentEmail === input.email) {
    return getUserById(input.userId);
  }

  if (metadata.rownd_pending_verification?.value) {
    await EmailVerification.revokeEmailVerificationTokens(
      input.tenantId,
      input.recipeUserId,
      metadata.rownd_pending_verification.value,
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
    rownd_pending_verification: pendingVerification,
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
  recipeUserId: { getAsString: () => string };
  email: string;
  userContext?: JsonRecord;
}) {
  const user = await SuperTokens.getUser(
    input.recipeUserId.getAsString(),
    input.userContext,
  );
  const userId = user?.id ?? input.recipeUserId.getAsString();
  const metadata = await getUserMetadata(userId);
  const pendingVerification = metadata.rownd_pending_verification;

  if (
    pendingVerification?.field !== "email" ||
    pendingVerification.value !== input.email
  ) {
    return;
  }

  const updatedMetadata: RowndMetadata = {
    ...metadata,
    data: {
      ...metadata.data,
      email: input.email,
      user_id: userId,
    },
    verified_data: {
      ...metadata.verified_data,
      email: input.email,
    },
    rownd_pending_verification: null,
  };

  await UserMetadata.updateUserMetadata(userId, updatedMetadata);
}

export async function updateUserMetadata(
  userId: string,
  inputMeta: JsonRecord,
) {
  const metadata = await getUserMetadata(userId);
  const updatedMetadata: JSONObject = {
    ...metadata,
    data: {
      ...metadata.data,
    },
    meta: {
      ...metadata.meta,
      ...inputMeta,
    },
    verified_data: {
      ...metadata.verified_data,
    },
    attributes: {
      ...metadata.attributes,
    },
  };

  await UserMetadata.updateUserMetadata(userId, updatedMetadata);

  return {
    id: userId,
    meta: (updatedMetadata.meta || {}) as JsonRecord,
  };
}

type RowndLoginMethod = {
  recipeId: string;
  timeJoined: number;
  lastUsed?: number;
  email?: string;
  phoneNumber?: string;
  verified?: boolean;
  thirdPartyId?: string;
};

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
  const googleOneTap = getOneTapConfig(googleMethod);

  return {
    email: { enabled: !!methods.email },
    phone: { enabled: !!methods.phone },
    google: {
      enabled: !!googleMethod,
      client_id: getStringMethodProperty(googleMethod, "clientId") ?? "",
      ios_client_id: getStringMethodProperty(googleMethod, "iosClientId") ?? "",
      scopes: getStringArrayMethodProperty(googleMethod, "scopes") ?? [],
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
      enabled: !!anonymousMethod,
      ...(getStringMethodProperty(anonymousMethod, "displayName") !== undefined
        ? {
            display_name: getStringMethodProperty(
              anonymousMethod,
              "displayName",
            ),
          }
        : {}),
      ...(getStringMethodProperty(anonymousMethod, "iconLightUrl") !== undefined
        ? {
            icon_light_url: getStringMethodProperty(
              anonymousMethod,
              "iconLightUrl",
            ),
          }
        : {}),
      ...(getStringMethodProperty(anonymousMethod, "iconDarkUrl") !== undefined
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

export function buildAppConfig(
  config: RowndPluginNormalisedConfig,
  stConfig: SuperTokensPublicConfig,
) {
  const userSchema = config.schema ?? DEFAULT_ROWND_SCHEMA;
  const app = config.appConfig ?? {};
  const branding = app.branding ?? {};
  const auth = app.auth ?? {};
  const signInMethods = buildSignInMethodsConfig(app.signInMethods);

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
    id: app.id ?? "",
    name: app.name ?? stConfig.appInfo.appName,
    icon: app.icon ?? "",
    schema: Object.fromEntries(
      Object.entries(finalSchema).map(([key, field]) => [
        key,
        normalizeSchemaField(key, field),
      ]),
    ),
    config: {
      customizations: {
        primary_color: branding.primaryColor ?? DEFAULT_PRIMARY_COLOR,
        ...(branding.logo ? { logo: branding.logo } : {}),
        ...(branding.logoDarkMode
          ? { logo_dark_mode: branding.logoDarkMode }
          : {}),
      },
      hub: {
        customizations: {
          rounded_corners: branding.roundedCorners ?? true,
          ...(branding.containerBorderRadius !== undefined
            ? { container_border_radius: branding.containerBorderRadius }
            : {}),
          ...(branding.placement !== undefined
            ? { placement: branding.placement }
            : {}),
          ...(branding.primaryColorDarkMode !== undefined
            ? { primary_color_dark_mode: branding.primaryColorDarkMode }
            : {}),
          visual_swoops: branding.visualSwoops ?? true,
          blur_background: branding.blurBackground ?? true,
          dark_mode: branding.darkMode ?? "auto",
        },
        ...(branding.customStyles
          ? { custom_styles: branding.customStyles }
          : {}),
        auth: {
          email: { from_address: "no-reply@rownd.io", image: "" },
          sign_in_methods: signInMethods,
          additional_fields: auth.additionalFields ?? [],
          ...(auth.rememberSignInMethod !== undefined
            ? { remember_sign_in_method: auth.rememberSignInMethod }
            : {}),
          ...(auth.useExplicitSignUpFlow !== undefined
            ? { use_explicit_sign_up_flow: auth.useExplicitSignUpFlow }
            : {}),
          ...(auth.primarySignUpMethod
            ? { primary_sign_up_method: auth.primarySignUpMethod }
            : {}),
          ...(auth.preferredMethod
            ? { preferred_method: auth.preferredMethod }
            : {}),
          ...(auth.order ? { order: auth.order } : {}),
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
                },
              }
            : {}),
          ...(app.customContent?.profileModal
            ? { profile_modal: app.customContent.profileModal }
            : {}),
          ...(app.customContent?.signInFailureModal
            ? {
                sign_in_failure_modal: {
                  failure_message:
                    app.customContent.signInFailureModal.failureMessage,
                },
              }
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
        },
      },
    },
  };
}

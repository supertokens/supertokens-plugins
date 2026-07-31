import SuperTokens from "supertokens-node";
import AccountLinking from "supertokens-node/recipe/accountlinking";
import EmailVerification from "supertokens-node/recipe/emailverification";
import Passwordless from "supertokens-node/recipe/passwordless";
import Session from "supertokens-node/recipe/session";
import ThirdParty from "supertokens-node/recipe/thirdparty";
import { BooleanClaim } from "supertokens-node/recipe/session/claims";
import type { SessionContainerInterface } from "supertokens-node/recipe/session/types";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import type { JSONObject, SuperTokensPublicConfig } from "supertokens-node/types";

import {
  DEFAULT_ROWND_SCHEMA,
  GUEST_AUTH_METHOD_ID,
  INSTANT_AUTH_METHOD_ID,
  PASSWORDLESS_BYPASS_DEVICE_CONFIRMATION_PARAM,
  PUBLIC_TENANT_ID,
} from "./constants";
import { RowndPluginError } from "./errors";
import { assertRowndAppVariantIsConfigured, getPluginConfig, getSuperTokensConfig } from "./config";
import type { SuperTokensUserImport } from "./types";
import {
  buildRowndSessionClaimPayload,
  getEffectiveAuthLevel,
  getAnonymousId,
  getThirdPartyId,
  getThirdPartyUserId,
  hasOnlyGuestLoginMethods,
  isIdentityField,
  isInternalMetadataField,
  isSuperTokensFakeEmail,
  mapMethod,
  type RowndCompatUserResponse,
  type RowndMetadata,
  type RowndPendingVerification,
} from "./rownd-compatibility";
import {
  assertAllowedBypassRedirectPath,
  getStringList,
  getAppInfoString,
  getMagicLinkBootstrapParams,
  getWebsiteDomain,
  isJsonRecord,
  isRecord,
  normalizeRedirectToPathForClientDomain,
  resolveAllowedClientDomain,
  rewriteMagicLink,
  type JsonRecord,
} from "./utils";

type BypassDisplayContext = "browser" | "mobile_app" | "customer_web_view";

export type CreateMagicLinkWithConfirmationBypassInput = {
  email?: string;
  phoneNumber?: string;
  tenantId?: string;
  request?: any;
  session?: SessionContainerInterface;
  userContext?: Record<string, any>;
  redirectToPath?: string;
  clientDomain?: string;
  displayContext?: BypassDisplayContext;
  appVariantId?: string;
};

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

type SuperTokensUser = NonNullable<Awaited<ReturnType<typeof SuperTokens.getUser>>>;
type SuperTokensLoginMethod = SuperTokensUser["loginMethods"][number];
type ImportLoginMethod = SuperTokensUserImport["loginMethods"][number];

function matchesImportLoginMethod(
  loginMethod: SuperTokensLoginMethod,
  importMethod: ImportLoginMethod,
) {
  if (loginMethod.recipeId !== importMethod.recipeId) {
    return false;
  }

  if (importMethod.recipeId === "thirdparty") {
    return loginMethod.hasSameThirdPartyInfoAs({
      id: importMethod.thirdPartyId,
      userId: importMethod.thirdPartyUserId,
    });
  }

  if (importMethod.recipeId === "passwordless") {
    return importMethod.email
      ? loginMethod.hasSameEmailAs(importMethod.email)
      : loginMethod.hasSamePhoneNumberAs(importMethod.phoneNumber);
  }

  return loginMethod.hasSameEmailAs(importMethod.email);
}

function getImportMethodAccountInfo(importMethod: ImportLoginMethod) {
  if (importMethod.recipeId === "thirdparty") {
    return {
      thirdParty: {
        id: importMethod.thirdPartyId,
        userId: importMethod.thirdPartyUserId,
      },
    };
  }

  if (importMethod.recipeId === "emailpassword") {
    return { email: importMethod.email };
  }

  return importMethod.email
    ? { email: importMethod.email }
    : { phoneNumber: importMethod.phoneNumber! };
}

async function findExistingImportMethod(
  importMethod: ImportLoginMethod,
  tenantId: string,
  userContext: JsonRecord,
) {
  const users = await SuperTokens.listUsersByAccountInfo(
    tenantId,
    getImportMethodAccountInfo(importMethod),
    false,
    userContext,
  );

  for (const user of users) {
    const loginMethod = user.loginMethods.find(
      (method) =>
        method.tenantIds.includes(tenantId) &&
        matchesImportLoginMethod(method, importMethod),
    );
    if (loginMethod) {
      return { user, loginMethod };
    }
  }

  return undefined;
}

async function createMissingLoginMethod(
  importMethod: ImportLoginMethod,
  tenantId: string,
  userContext: JsonRecord,
) {
  if (importMethod.recipeId === "thirdparty") {
    const result = await ThirdParty.manuallyCreateOrUpdateUser(
      tenantId,
      importMethod.thirdPartyId,
      importMethod.thirdPartyUserId,
      importMethod.email,
      importMethod.isVerified,
      undefined,
      userContext,
    );
    if (result.status !== "OK") {
      throw new Error(
        `Failed to create migrated third-party login method: ${result.status}`,
      );
    }
    return result.recipeUserId;
  }

  if (importMethod.recipeId === "passwordless") {
    const result = importMethod.email
      ? await Passwordless.signInUp({
        tenantId,
        email: importMethod.email,
        userContext,
      })
      : await Passwordless.signInUp({
        tenantId,
        phoneNumber: importMethod.phoneNumber!,
        userContext,
      });

    if (importMethod.email && !importMethod.isVerified) {
      await EmailVerification.unverifyEmail(
        result.recipeUserId,
        importMethod.email,
        userContext,
      );
    }
    return result.recipeUserId;
  }

  throw new Error(
    `Cannot reconcile unsupported login method: ${importMethod.recipeId}`,
  );
}

async function ensurePrimaryUser(
  user: SuperTokensUser,
  recipeUserId: SuperTokensLoginMethod["recipeUserId"],
  superTokensUserId: string,
  userContext: JsonRecord,
) {
  if (user.isPrimaryUser) {
    return superTokensUserId;
  }

  const result = await AccountLinking.createPrimaryUser(
    recipeUserId,
    userContext,
  );
  if (result.status === "OK") {
    return recipeUserId.getAsString();
  }
  if (
    result.status ===
    "RECIPE_USER_ID_ALREADY_LINKED_WITH_PRIMARY_USER_ID_ERROR"
  ) {
    return result.primaryUserId;
  }

  throw new Error(
    "A migrated login method belongs to a different primary user",
  );
}

async function resolveSuperTokensUserId(
  userId: string,
  userContext: JsonRecord,
) {
  const mapping = await SuperTokens.getUserIdMapping({
    userId,
    userIdType: "EXTERNAL",
    userContext,
  });
  return mapping.status === "OK" ? mapping.superTokensUserId : userId;
}

async function assertRowndUserIdCanBeMapped(
  superTokensUserId: string,
  rowndUserId: string,
  userContext: JsonRecord,
) {
  const externalMapping = await SuperTokens.getUserIdMapping({
    userId: rowndUserId,
    userIdType: "EXTERNAL",
    userContext,
  });
  if (externalMapping.status === "OK") {
    if (externalMapping.superTokensUserId !== superTokensUserId) {
      throw new Error(
        "The Rownd user ID is already mapped to another SuperTokens user",
      );
    }
    return true;
  }

  const internalMapping = await SuperTokens.getUserIdMapping({
    userId: superTokensUserId,
    userIdType: "SUPERTOKENS",
    userContext,
  });
  if (
    internalMapping.status === "OK" &&
    internalMapping.externalUserId !== rowndUserId
  ) {
    throw new Error(
      "The SuperTokens user is already mapped to another external user ID",
    );
  }
  if (internalMapping.status === "OK") {
    return true;
  }

  return false;
}

async function createRowndUserIdMapping(
  superTokensUserId: string,
  rowndUserId: string,
  userContext: JsonRecord,
) {
  const result = await SuperTokens.createUserIdMapping({
    superTokensUserId,
    externalUserId: rowndUserId,
    force: true,
    userContext,
  });
  if (result.status !== "OK") {
    throw new Error(
      `Failed to map migrated Rownd user ID: ${result.status}`,
    );
  }
}

export async function reconcileRowndUserWithExistingLoginMethods(
  stUser: SuperTokensUserImport,
  tenantId: string,
  userContext: JsonRecord,
) {
  if (!stUser.externalUserId) {
    throw new Error("Migrated Rownd user has no external user ID");
  }

  const matches = (await Promise.all(
    stUser.loginMethods.map((method) =>
      findExistingImportMethod(method, tenantId, userContext),
    ),
  )).filter(
    (match): match is NonNullable<Awaited<ReturnType<typeof findExistingImportMethod>>> =>
      !!match,
  );

  if (matches.length === 0) {
    return false;
  }

  const ownerIds = new Set(matches.map(({ user }) => user.id));
  if (ownerIds.size > 1) {
    throw new Error(
      "Migrated login methods belong to different SuperTokens users",
    );
  }

  const target = matches[0]!;
  const targetSuperTokensUserId = await resolveSuperTokensUserId(
    target.user.id,
    userContext,
  );
  const mappingAlreadyExists = await assertRowndUserIdCanBeMapped(
    targetSuperTokensUserId,
    stUser.externalUserId,
    userContext,
  );
  const primaryUserId = await ensurePrimaryUser(
    target.user,
    target.loginMethod.recipeUserId,
    targetSuperTokensUserId,
    userContext,
  );

  for (const importMethod of stUser.loginMethods) {
    const existingMethod = matches.find(({ loginMethod }) =>
      matchesImportLoginMethod(loginMethod, importMethod),
    );
    if (existingMethod) {
      continue;
    }

    const recipeUserId = await createMissingLoginMethod(
      importMethod,
      tenantId,
      userContext,
    );
    const createdUser = await SuperTokens.getUser(
      recipeUserId.getAsString(),
      userContext,
    );
    if (!createdUser) {
      throw new Error("Created migrated login method was not found");
    }
    if (createdUser.id === primaryUserId) {
      continue;
    }

    const linkResult = await AccountLinking.linkAccounts(
      recipeUserId,
      primaryUserId,
      userContext,
    );
    if (
      linkResult.status ===
      "RECIPE_USER_ID_ALREADY_LINKED_WITH_ANOTHER_PRIMARY_USER_ID_ERROR" &&
      linkResult.primaryUserId === primaryUserId
    ) {
      continue;
    }
    if (linkResult.status !== "OK") {
      throw new Error(
        `Failed to link migrated login method: ${linkResult.status}`,
      );
    }
  }

  await UserMetadata.updateUserMetadata(
    primaryUserId,
    stUser.userMetadata,
    userContext,
  );
  if (!mappingAlreadyExists) {
    await createRowndUserIdMapping(
      primaryUserId,
      stUser.externalUserId,
      userContext,
    );
  }

  return true;
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

export const RowndIsAnonymousClaim = new BooleanClaim({
  key: "is_anonymous",
  fetchValue: async (userId) => {
    const user = await SuperTokens.getUser(userId);
    const effectiveAuthLevel = getEffectiveAuthLevel(user);
    return [GUEST_AUTH_METHOD_ID, INSTANT_AUTH_METHOD_ID].includes(effectiveAuthLevel);
  },
});

export async function buildRowndSessionClaims(
  userId: string,
  currentPayload: JsonRecord = {},
  appVariantId?: string,
) {
  const user = await SuperTokens.getUser(userId);
  const metadata = user ? await getUserMetadata(user.id) : undefined;

  return buildRowndSessionClaimPayload({
    userId,
    user,
    metadata,
    currentPayload,
    appVariantId,
  });
}

export async function createMagicLinkWithConfirmationBypass(
  input: CreateMagicLinkWithConfirmationBypassInput,
) {
  const hasEmail = typeof input.email === "string" && input.email.length > 0;
  const hasPhoneNumber = typeof input.phoneNumber === "string" && input.phoneNumber.length > 0;

  if (hasEmail === hasPhoneNumber) {
    throw new Error("Exactly one of email or phoneNumber is required");
  }

  const stConfig = getSuperTokensConfig();
  if (!stConfig) {
    throw new Error("SuperTokens config is not initialized");
  }

  const pluginConfig = getPluginConfig();
  if (!pluginConfig) {
    throw new Error("Rownd plugin config is not initialized");
  }

  const tenantId = input.tenantId ?? PUBLIC_TENANT_ID;
  const appVariantId = input.appVariantId;
  assertRowndAppVariantIsConfigured(appVariantId);

  const clientDomain = resolveAllowedClientDomain({
    clientDomain: input.clientDomain,
    pluginConfig,
    stConfig,
    request: input.request,
    userContext: input.userContext,
  });
  const redirectToPath = normalizeRedirectToPathForClientDomain(input.redirectToPath, clientDomain);
  assertAllowedBypassRedirectPath(pluginConfig, redirectToPath);

  const userContext = {
    ...(input.userContext ?? {}),
    ...(input.displayContext ? { rowndDisplayContext: input.displayContext } : {}),
    rowndRedirectToPath: redirectToPath,
    ...(input.clientDomain ? { rowndClientDomain: input.clientDomain } : {}),
    ...(appVariantId ? { rowndAppVariantId: appVariantId } : {}),
  };
  const codeInfo = hasEmail
    ? await Passwordless.createCode({
      email: input.email!,
      tenantId,
      session: input.session,
      userContext,
    })
    : await Passwordless.createCode({
      phoneNumber: input.phoneNumber!,
      tenantId,
      session: input.session,
      userContext,
    });

  if (codeInfo.status !== "OK") {
    throw new Error("Failed to create magic link");
  }

  const magicLink = `${getWebsiteDomain({
    stConfig,
    request: input.request,
    userContext,
  })}${getAppInfoString(stConfig.appInfo.websiteBasePath)}/verify?preAuthSessionId=${encodeURIComponent(
    codeInfo.preAuthSessionId,
  )}&tenantId=${encodeURIComponent(tenantId)}#${encodeURIComponent(codeInfo.linkCode)}`;
  const oauthLoginChallenge = (userContext as Record<string, unknown>)
    .rowndOAuthLoginChallenge;
  const rewrittenUrl = new URL(rewriteMagicLink({
    magicLink,
    clientDomain,
    bootstrapParams: getMagicLinkBootstrapParams({
      appKey: pluginConfig.rowndAppKey,
      apiDomain: getAppInfoString(stConfig.appInfo.apiDomain),
      apiBasePath: getAppInfoString(stConfig.appInfo.apiBasePath),
      appVariantId,
      displayContext: input.displayContext,
      redirectToPath,
      clientDomainKey: input.clientDomain,
      oauthLoginChallenge: typeof oauthLoginChallenge === "string"
        ? oauthLoginChallenge
        : undefined,
    }),
  }));

  rewrittenUrl.searchParams.set(PASSWORDLESS_BYPASS_DEVICE_CONFIRMATION_PARAM, "true");

  return rewrittenUrl.toString();
}

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
  tenantId: string = PUBLIC_TENANT_ID,
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
      data[key] = value;
      dataFieldKeys.add(key);
    }
  }

  const schema = getPluginConfig()?.schema || DEFAULT_ROWND_SCHEMA;
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

  const tenantLoginMethods = stUser.loginMethods.filter((method) =>
    method.tenantIds.includes(tenantId),
  );
  for (const method of tenantLoginMethods) {
    if (method.recipeId === "passwordless") {
      if (method.email && !isSuperTokensFakeEmail(method.email)) {
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
      if (
        method.verified &&
        method.email &&
        !isSuperTokensFakeEmail(method.email)
      ) {
        verifiedData.email = method.email;
      }
      if (
        method.email &&
        !isSuperTokensFakeEmail(method.email) &&
        data.email === undefined
      ) {
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
      if (
        method.email &&
        !isSuperTokensFakeEmail(method.email) &&
        data.email === undefined
      ) {
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

  const tenantUser = {
    ...stUser,
    loginMethods: tenantLoginMethods,
  };
  const anonymousId = getAnonymousId(stUser.id, tenantUser, metadata);
  if (anonymousId && data.anonymous_id === undefined) {
    data.anonymous_id = anonymousId;
  }

  const authLevel = getEffectiveAuthLevel(
    tenantUser,
    originalRowndUser?.auth_level,
    verifiedData,
  );

  for (const [key, field] of Object.entries(schema)) {
    if (data[key] === undefined && field.type === "string") {
      data[key] = "";
    }
  }

  const sortedByJoined = [...tenantLoginMethods].sort(
    (a, b) => a.timeJoined - b.timeJoined,
  );
  const latestSessionInfo = await getLatestSessionInfo(stUser.id, tenantId);
  const firstMethod = sortedByJoined[0];
  const latestSessionRecipeUserId = latestSessionInfo?.recipeUserId.getAsString();
  const lastMethod = latestSessionRecipeUserId
    ? stUser.loginMethods.find(
      (method) => method.recipeUserId.getAsString() === latestSessionRecipeUserId,
    )
    : [...tenantLoginMethods].sort((a, b) => b.timeJoined - a.timeJoined)[0];
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

async function getLatestSessionInfo(userId: string, tenantId: string) {
  const sessionHandles = await Session.getAllSessionHandlesForUser(
    userId,
    true,
    tenantId,
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

export async function updateUserData(
  userId: string,
  inputData: JsonRecord,
  tenantId: string = PUBLIC_TENANT_ID,
) {
  const metadata = await getUserMetadata(userId);
  const updatedMetadata: JSONObject = {
    ...metadata,
    ...inputData,
  };

  await UserMetadata.updateUserMetadata(userId, updatedMetadata);
  return getUserById(userId, tenantId);
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
  const currentEmail = (await getUserById(input.userId, input.tenantId)).data.email;
  const pendingVerifications = getPendingVerifications(metadata);
  const pendingEmailVerifications = pendingVerifications.filter(
    (pendingVerification) =>
      pendingVerification.field === "email" &&
      (pendingVerification.tenantId ?? PUBLIC_TENANT_ID) === input.tenantId,
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
          (pendingVerification) =>
            pendingVerification.field !== "email" ||
            (pendingVerification.tenantId ?? PUBLIC_TENANT_ID) !== input.tenantId,
        ),
      });
    }

    return getUserById(input.userId, input.tenantId);
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
    tenantId: input.tenantId,
  };

  await UserMetadata.updateUserMetadata(input.userId, {
    ...metadata,
    rownd_pending_verification: [
      ...pendingVerifications.filter(
        (pendingVerification) =>
          pendingVerification.field !== "email" ||
          (pendingVerification.tenantId ?? PUBLIC_TENANT_ID) !== input.tenantId,
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
      tenantId: input.tenantId,
      userContext: input.userContext,
    });
  }

  return getUserById(input.userId, input.tenantId);
}

export async function completePendingEmailVerification(input: {
  recipeUserId: Parameters<typeof AccountLinking.createPrimaryUser>[0];
  email: string;
  tenantId?: string;
  userContext?: JsonRecord;
}): Promise<
  | {
      userId: string;
      recipeUserId: Parameters<typeof AccountLinking.createPrimaryUser>[0];
    }
  | undefined
> {
  const tenantId = input.tenantId ?? PUBLIC_TENANT_ID;
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
      tenantId,
    ),
  );

  if (!pendingVerification) {
    return;
  }

  let metadataUserId = userId;
  let verifiedRecipeUserId = input.recipeUserId;
  const tenantLoginMethods = user?.loginMethods.filter((method) =>
    method.tenantIds.includes(tenantId),
  ) ?? [];
  const passwordlessEmailMethod = getPasswordlessEmailLoginMethod(
    tenantLoginMethods,
  );
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

    verifiedRecipeUserId = passwordlessEmailMethod.recipeUserId;
  } else if (hasOnlyGuestLoginMethods(user
    ? { ...user, loginMethods: tenantLoginMethods }
    : user)) {
    const isPasswordlessSignUpAllowed = await AccountLinking.isSignUpAllowed(
      tenantId,
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
      tenantId,
      userContext: input.userContext,
    });
    verifiedRecipeUserId = passwordlessUser.recipeUserId;

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
        tenantId,
      ),
    ),
  };

  await UserMetadata.updateUserMetadata(metadataUserId, updatedMetadata);

  return {
    userId: metadataUserId,
    recipeUserId: verifiedRecipeUserId,
  };
}

function isMatchingPendingEmailVerification(
  verification: RowndPendingVerification,
  email: string,
  tenantId: string,
) {
  return verification.field === "email" &&
    verification.value === email &&
    (verification.tenantId ?? PUBLIC_TENANT_ID) === tenantId;
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

function getPasswordlessEmailLoginMethod(
  loginMethods: NonNullable<Awaited<ReturnType<typeof SuperTokens.getUser>>>["loginMethods"],
) {
  return loginMethods.find((method) => {
    return method.recipeId === "passwordless" && !!method.email;
  });
}

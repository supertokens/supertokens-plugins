import SuperTokens from "supertokens-node";
import AccountLinking from "supertokens-node/recipe/accountlinking";
import EmailVerification from "supertokens-node/recipe/emailverification";
import MultiTenancy from "supertokens-node/recipe/multitenancy";
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
import { RowndEmailChangeError, RowndPluginError } from "./errors";
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

async function inspectImportMethod(
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

  const owners = users.flatMap((user) =>
    user.loginMethods
      .filter(
        (method) =>
          method.tenantIds.includes(tenantId) &&
          matchesImportLoginMethod(method, importMethod),
      )
      .map((loginMethod) => ({ user, loginMethod })),
  );
  const match = owners.find(
    ({ loginMethod }) =>
      importMethod.recipeId === "thirdparty" ||
      (importMethod.isVerified && loginMethod.verified),
  );

  return { importMethod, owners, match };
}

async function createMissingLoginMethod(
  importMethod: ImportLoginMethod,
  tenantId: string,
  primaryUserId: string,
  userContext: JsonRecord,
) {
  const reconciliationUserContext = {
    ...userContext,
    rowndDisableAutomaticAccountLinking: true,
  };

  if (importMethod.recipeId === "thirdparty") {
    const result = await ThirdParty.manuallyCreateOrUpdateUser(
      tenantId,
      importMethod.thirdPartyId,
      importMethod.thirdPartyUserId,
      importMethod.email,
      importMethod.isVerified,
      undefined,
      reconciliationUserContext,
    );
    if (result.status !== "OK") {
      throw new Error(
        `Failed to create migrated third-party login method: ${result.status}`,
      );
    }
    if (!result.createdNewRecipeUser && result.user.id !== primaryUserId) {
      throw new Error(
        "Migrated third-party login method belongs to another SuperTokens user",
      );
    }
    return {
      recipeUserId: result.recipeUserId,
      createdNewRecipeUser: result.createdNewRecipeUser,
    };
  }

  if (importMethod.recipeId === "passwordless") {
    const result = importMethod.email
      ? await Passwordless.signInUp({
        tenantId,
        email: importMethod.email,
        userContext: reconciliationUserContext,
      })
      : await Passwordless.signInUp({
        tenantId,
        phoneNumber: importMethod.phoneNumber!,
        userContext: reconciliationUserContext,
      });

    if (!result.createdNewRecipeUser && result.user.id !== primaryUserId) {
      throw new Error(
        "Migrated passwordless login method belongs to another SuperTokens user",
      );
    }

    if (importMethod.email && !importMethod.isVerified) {
      try {
        await EmailVerification.unverifyEmail(
          result.recipeUserId,
          importMethod.email,
          userContext,
        );
      } catch (error) {
        if (result.createdNewRecipeUser) {
          await Promise.allSettled([
            SuperTokens.deleteUser(
              result.recipeUserId.getAsString(),
              false,
              userContext,
            ),
          ]);
        }
        throw error;
      }
    }
    return {
      recipeUserId: result.recipeUserId,
      createdNewRecipeUser: result.createdNewRecipeUser,
    };
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
    force: false,
    userContext,
  });
  if (result.status === "USER_ID_MAPPING_ALREADY_EXISTS_ERROR") {
    const existingMapping = await SuperTokens.getUserIdMapping({
      userId: rowndUserId,
      userIdType: "EXTERNAL",
      userContext,
    });
    if (
      existingMapping.status === "OK" &&
      existingMapping.superTokensUserId === superTokensUserId
    ) {
      return false;
    }
  }
  if (result.status !== "OK") {
    throw new Error(
      `Failed to map migrated Rownd user ID: ${result.status}`,
    );
  }
  return true;
}

async function runCompensations(compensations: Array<() => Promise<void>>) {
  for (const compensate of [...compensations].reverse()) {
    await Promise.allSettled([compensate()]);
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

  const inspections = await Promise.all(
    stUser.loginMethods.map((method) =>
      inspectImportMethod(method, tenantId, userContext),
    ),
  );
  const matches = inspections.flatMap(({ match }) =>
    match ? [match] : [],
  );

  if (matches.length === 0) {
    return false;
  }

  const target = matches[0]!;
  const targetSuperTokensUserId = await resolveSuperTokensUserId(
    target.user.id,
    userContext,
  );
  const ownerSuperTokensUserIds = await Promise.all(
    inspections.flatMap(({ owners }) =>
      owners.map(({ user }) =>
        resolveSuperTokensUserId(user.id, userContext),
      ),
    ),
  );
  if (
    ownerSuperTokensUserIds.some(
      (ownerId) => ownerId !== targetSuperTokensUserId,
    )
  ) {
    throw new Error(
      "A migrated login method belongs to a different SuperTokens user",
    );
  }
  const unsupportedMethod = inspections.find(
    ({ importMethod, match }) =>
      !match && importMethod.recipeId === "emailpassword",
  );
  if (unsupportedMethod) {
    throw new Error(
      `Cannot reconcile unsupported login method: ${unsupportedMethod.importMethod.recipeId}`,
    );
  }
  const mappingAlreadyExists =
    targetSuperTokensUserId === stUser.externalUserId ||
    await assertRowndUserIdCanBeMapped(
      targetSuperTokensUserId,
      stUser.externalUserId,
      userContext,
    );
  const compensations: Array<() => Promise<void>> = [];
  try {
    const primaryUserId = await ensurePrimaryUser(
      target.user,
      target.loginMethod.recipeUserId,
      targetSuperTokensUserId,
      userContext,
    );
    for (const { importMethod, match } of inspections) {
      if (match) {
        continue;
      }

      const verifiedMatchingEmailMethod =
        importMethod.recipeId === "passwordless" &&
        importMethod.email !== undefined &&
        target.user.loginMethods.find(
          (method) =>
            method.tenantIds.includes(tenantId) &&
            method.verified &&
            method.hasSameEmailAs(importMethod.email!),
        );
      const createdMethod = await createMissingLoginMethod(
        verifiedMatchingEmailMethod
          ? { ...importMethod, isVerified: true }
          : importMethod,
        tenantId,
        primaryUserId,
        userContext,
      );
      const { recipeUserId } = createdMethod;
      if (createdMethod.createdNewRecipeUser) {
        compensations.push(async () => {
          await SuperTokens.deleteUser(
            recipeUserId.getAsString(),
            false,
            userContext,
          );
        });
      }
      const createdUser = await SuperTokens.getUser(
        recipeUserId.getAsString(),
        userContext,
      );
      if (!createdUser) {
        throw new Error("Created migrated login method was not found");
      }
      if (createdUser.id !== primaryUserId) {
        const linkResult = await AccountLinking.linkAccounts(
          recipeUserId,
          primaryUserId,
          userContext,
        );
        const alreadyLinkedToTarget =
          linkResult.status ===
            "RECIPE_USER_ID_ALREADY_LINKED_WITH_ANOTHER_PRIMARY_USER_ID_ERROR" &&
          linkResult.primaryUserId === primaryUserId;
        if (linkResult.status !== "OK" && !alreadyLinkedToTarget) {
          throw new Error(
            `Failed to link migrated login method: ${linkResult.status}`,
          );
        }
      }
    }

    if (!mappingAlreadyExists) {
      const mappingCreated = await createRowndUserIdMapping(
        primaryUserId,
        stUser.externalUserId,
        userContext,
      );
      if (mappingCreated) {
        compensations.push(async () => {
          await SuperTokens.deleteUserIdMapping({
            userId: stUser.externalUserId!,
            userIdType: "EXTERNAL",
            force: false,
            userContext,
          });
        });
      }
    }
    await UserMetadata.updateUserMetadata(
      primaryUserId,
      stUser.userMetadata,
      userContext,
    );
  } catch (error) {
    await runCompensations(compensations);
    throw error;
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

export async function getUserMetadata(
  userId: string,
  userContext?: Record<string, any>,
): Promise<RowndMetadata> {
  const metadata = await UserMetadata.getUserMetadata(userId, userContext);
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

  const originalVerifiedData = (originalRowndUser?.verified_data || {}) as JsonRecord;
  const verifiedData: JsonRecord = Object.fromEntries(
    Object.entries(originalVerifiedData).filter(([key]) => key !== "email"),
  );

  const tenantLoginMethods = stUser.loginMethods
    .filter((method) => method.tenantIds.includes(tenantId))
    .sort((a, b) =>
      a.timeJoined - b.timeJoined ||
      a.recipeUserId.getAsString().localeCompare(b.recipeUserId.getAsString()),
    );
  const canonicalEmailMethod = tenantLoginMethods.find(
    (method) =>
      method.recipeUserId.getAsString() === metadata.rownd_email_recipe_user_id &&
      method.email &&
      !isSuperTokensFakeEmail(method.email),
  );
  if (canonicalEmailMethod?.email) {
    data.email = canonicalEmailMethod.email;
    if (canonicalEmailMethod.verified) {
      verifiedData.email = canonicalEmailMethod.email;
    }
  }

  for (const method of tenantLoginMethods) {
    if (method.recipeId === "passwordless") {
      if (method.email && !isSuperTokensFakeEmail(method.email)) {
        if (verifiedData.email === undefined && method.verified) {
          verifiedData.email = method.email;
        }
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
        !isSuperTokensFakeEmail(method.email) &&
        verifiedData.email === undefined
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
  initiatingSessionHandle: string;
  userContext?: JsonRecord;
}) {
  const metadata = await getUserMetadata(input.userId);
  const user = await SuperTokens.getUser(input.userId, input.userContext);
  if (!user) {
    throw new RowndPluginError("ROWND_USER_NOT_FOUND");
  }

  const normalizedEmail = normalizeEmail(input.email);
  if (!normalizedEmail) {
    throw new RowndEmailChangeError(
      "INVALID_EMAIL",
      400,
      "email must be a non-empty string",
    );
  }

  const currentEmail = (await getUserById(input.userId, input.tenantId)).data.email;
  const pendingVerifications = getPendingVerifications(metadata);
  const pendingEmailVerifications = pendingVerifications.filter(
    (pendingVerification) => pendingVerification.field === "email",
  );
  if (
    pendingEmailVerifications.some(
      (pendingVerification) => pendingVerification.status === "COMMITTING",
    )
  ) {
    throw new RowndEmailChangeError(
      "CONFLICT",
      409,
      "an email change is already being committed",
    );
  }

  if (
    typeof currentEmail === "string" &&
    normalizeEmail(currentEmail) === normalizedEmail
  ) {
    for (const pendingVerification of pendingEmailVerifications) {
      await revokePendingEmailVerificationTokens(
        user,
        pendingVerification,
        input.recipeUserId,
        input.userContext,
      );
    }

    const currentPasswordlessMethod = getPasswordlessEmailLoginMethods(
      user.loginMethods,
    ).find(
      (method) =>
        method.verified &&
        method.email &&
        normalizeEmail(method.email) === normalizedEmail,
    );
    const updatedMetadata = currentPasswordlessMethod
      ? buildVerifiedEmailMetadata(
        metadata,
        input.userId,
        normalizedEmail,
        currentPasswordlessMethod.recipeUserId.getAsString(),
      )
      : {
        ...metadata,
        rownd_pending_verification: pendingVerifications.filter(
          (pendingVerification) => pendingVerification.field !== "email",
        ),
      };
    if (pendingEmailVerifications.length > 0 || currentPasswordlessMethod) {
      await UserMetadata.updateUserMetadata(input.userId, updatedMetadata);
    }

    return getUserById(input.userId, input.tenantId);
  }

  await assertEmailAvailableForUser(normalizedEmail, user.id, input.userContext);

  const passwordlessEmailMethods = getPasswordlessEmailLoginMethods(user.loginMethods);
  if (passwordlessEmailMethods.length > 1) {
    throw new RowndEmailChangeError(
      "AMBIGUOUS",
      409,
      "the account has multiple email sign-in methods",
    );
  }

  const passwordlessEmailMethod = passwordlessEmailMethods[0];
  if (hasOnlyGuestLoginMethods(user)) {
    throw new RowndEmailChangeError(
      "CONFLICT",
      403,
      "guest accounts cannot change sign-in email",
    );
  }
  const purpose = passwordlessEmailMethod
    ? "UPDATE_PASSWORDLESS"
    : "ADD_PASSWORDLESS";
  const verificationRecipeUserId = passwordlessEmailMethod?.recipeUserId ?? input.recipeUserId;
  for (const pendingVerification of pendingEmailVerifications) {
    await revokePendingEmailVerificationTokens(
      user,
      pendingVerification,
      input.recipeUserId,
      input.userContext,
    );
  }

  const pendingVerification: RowndPendingVerification = {
    id: input.pendingVerificationId,
    field: "email",
    value: input.email,
    created_at: new Date().toISOString(),
    tenantId: input.tenantId,
    purpose,
    initiatingSessionHandle: input.initiatingSessionHandle,
    verificationRecipeUserId: verificationRecipeUserId.getAsString(),
    status: "PENDING",
  };

  await UserMetadata.updateUserMetadata(input.userId, {
    ...metadata,
    rownd_pending_verification: [
      ...pendingVerifications.filter(
        (pendingVerification) =>
          pendingVerification.field !== "email",
      ),
      pendingVerification,
    ],
  });

  try {
    await EmailVerification.revokeEmailVerificationTokens(
      input.tenantId,
      verificationRecipeUserId,
      normalizedEmail,
      input.userContext,
    );
    await EmailVerification.unverifyEmail(
      verificationRecipeUserId,
      normalizedEmail,
      input.userContext,
    );
    const response = await EmailVerification.sendEmailVerificationEmail(
      input.tenantId,
      input.userId,
      verificationRecipeUserId,
      normalizedEmail,
      input.userContext,
    );

    if (response.status !== "OK") {
      throw new Error("A fresh email verification could not be created");
    }
  } catch (error) {
    await EmailVerification.revokeEmailVerificationTokens(
      input.tenantId,
      verificationRecipeUserId,
      normalizedEmail,
      input.userContext,
    );
    await UserMetadata.updateUserMetadata(input.userId, {
      ...metadata,
      rownd_pending_verification: pendingVerifications.filter(
        (verification) => verification.field !== "email",
      ),
    });
    throw error;
  }

  return getUserById(input.userId, input.tenantId);
}

export async function completePendingEmailVerification(input: {
  recipeUserId: Parameters<typeof AccountLinking.createPrimaryUser>[0];
  email: string;
  tenantId?: string;
  sessionHandle?: string;
  userContext?: JsonRecord;
}): Promise<
  | {
      userId: string;
      recipeUserId: Parameters<typeof AccountLinking.createPrimaryUser>[0];
      initiatingSessionHandle: string;
      replaceSession: true;
    }
  | undefined
> {
  const tenantId = input.tenantId ?? PUBLIC_TENANT_ID;
  let user = await SuperTokens.getUser(
    input.recipeUserId.getAsString(),
    input.userContext,
  );
  const userId = user?.id ?? input.recipeUserId.getAsString();
  const metadata = await getUserMetadata(userId);
  const pendingVerifications = getPendingVerifications(metadata);
  const normalizedEmail = normalizeEmail(input.email);
  const pendingVerification = pendingVerifications.find(
    (pendingVerification) =>
      isMatchingPendingEmailVerification(
        pendingVerification,
        normalizedEmail,
        tenantId,
      ) &&
      (!pendingVerification.verificationRecipeUserId ||
        pendingVerification.verificationRecipeUserId === input.recipeUserId.getAsString()),
  );

  if (!pendingVerification) {
    return;
  }

  const pendingPurpose = (pendingVerification as { purpose?: unknown }).purpose;
  if (
    pendingPurpose !== undefined &&
    pendingPurpose !== "UPDATE_PASSWORDLESS" &&
    pendingPurpose !== "ADD_PASSWORDLESS"
  ) {
    return rejectInactivePendingEmailVerification(
      userId,
      pendingVerification,
      input.recipeUserId,
      normalizedEmail,
      input.userContext,
    );
  }

  const initiatingSessionHandle =
    pendingVerification.initiatingSessionHandle;
  if (
    (pendingVerification.status ?? "PENDING") !== "PENDING" ||
    !initiatingSessionHandle ||
    initiatingSessionHandle !== input.sessionHandle
  ) {
    return rejectInactivePendingEmailVerification(
      userId,
      pendingVerification,
      input.recipeUserId,
      normalizedEmail,
      input.userContext,
    );
  }

  type CompletionPhase = "PENDING" | "COMMITTING" | "COMPLETED";
  let completionPhase: CompletionPhase = "PENDING";
  let metadataUserId = userId;
  let rollbackCredentialChange: (() => Promise<void>) | undefined;
  try {
    await assertEmailAvailableForUser(normalizedEmail, userId, input.userContext);
    completionPhase = "COMMITTING";
    await markPendingEmailVerificationStatus(
      userId,
      pendingVerification.id,
      "COMMITTING",
      input.userContext,
    );

    const initiatingSession = await Session.getSessionInformation(
      initiatingSessionHandle,
      input.userContext,
    );
    if (
      !initiatingSession ||
      initiatingSession.userId !== userId ||
      initiatingSession.tenantId !== tenantId ||
      !(await Session.revokeSession(initiatingSessionHandle, input.userContext))
    ) {
      return rejectInactivePendingEmailVerification(
        userId,
        pendingVerification,
        input.recipeUserId,
        normalizedEmail,
        input.userContext,
      );
    }
    const currentUser = await SuperTokens.getUser(userId, input.userContext);
    const initiatingLoginMethod = currentUser?.loginMethods.find(
      (method) =>
        method.recipeUserId.getAsString() ===
          initiatingSession.recipeUserId.getAsString() &&
        method.tenantIds.includes(tenantId),
    );
    if (!currentUser || !initiatingLoginMethod) {
      return rejectInactivePendingEmailVerification(
        userId,
        pendingVerification,
        input.recipeUserId,
        normalizedEmail,
        input.userContext,
      );
    }
    user = currentUser;
    const initiatingRecipeUserId = initiatingLoginMethod.recipeUserId;
    await Session.revokeAllSessionsForUser(
      userId,
      true,
      undefined,
      input.userContext,
    );
    const committingMetadata = await getUserMetadata(userId);
    const committingVerification = getPendingVerifications(
      committingMetadata,
    ).find((verification) => verification.field === "email");
    if (
      committingVerification?.id !== pendingVerification.id ||
    committingVerification.status !== "COMMITTING"
    ) {
      return rejectInactivePendingEmailVerification(
        userId,
        pendingVerification,
        input.recipeUserId,
        normalizedEmail,
        input.userContext,
      );
    }

    let verifiedRecipeUserId = input.recipeUserId;
    let canonicalEmailRecipeUserId: string;
    const passwordlessEmailMethod = findPendingPasswordlessMethod(
      user,
      pendingVerification,
    );
    if (
      !pendingVerification.purpose &&
    user &&
    getPasswordlessEmailLoginMethods(user.loginMethods).length > 1
    ) {
      throw new RowndEmailChangeError(
        "AMBIGUOUS",
        409,
        "the account has multiple email sign-in methods",
      );
    }
    if (pendingVerification.purpose === "UPDATE_PASSWORDLESS" ||
      (!pendingVerification.purpose && passwordlessEmailMethod)) {
      if (!passwordlessEmailMethod) {
        throw new RowndEmailChangeError(
          "CONFLICT",
          409,
          "the email sign-in method changed before verification completed",
        );
      }
      const newlyAssociatedTenantIds = await associateRecipeUserToTenants(
        getAccountTenantIds(user!, tenantId).filter(
          (associatedTenantId) =>
            !passwordlessEmailMethod.tenantIds.includes(associatedTenantId),
        ),
        passwordlessEmailMethod.recipeUserId,
        input.userContext,
      );
      const previousEmail = passwordlessEmailMethod.email!;
      rollbackCredentialChange = async () => {
        try {
          await Passwordless.updateUser({
            recipeUserId: passwordlessEmailMethod.recipeUserId,
            email: previousEmail,
            userContext: input.userContext,
          });
        } finally {
          await rollbackTenantAssociations(
            newlyAssociatedTenantIds,
            passwordlessEmailMethod.recipeUserId,
            input.userContext,
          );
        }
      };
      const updateResult = await Passwordless.updateUser({
        recipeUserId: passwordlessEmailMethod.recipeUserId,
        email: normalizedEmail,
        userContext: input.userContext,
      });

      if (updateResult.status !== "OK") {
        throw emailOwnershipConflict();
      }

      canonicalEmailRecipeUserId = passwordlessEmailMethod.recipeUserId.getAsString();
      verifiedRecipeUserId = initiatingRecipeUserId;
    } else if (!pendingVerification.purpose && hasOnlyGuestLoginMethods(user)) {
      throw new RowndEmailChangeError(
        "CONFLICT",
        403,
        "guest email upgrades must be restarted through a supported sign-up flow",
      );
    } else {
      if (
        pendingVerification.purpose === "ADD_PASSWORDLESS" &&
        user &&
        getPasswordlessEmailLoginMethods(user.loginMethods).length > 0
      ) {
        throw new RowndEmailChangeError(
          "CONFLICT",
          409,
          "the email sign-in methods changed before verification completed",
        );
      }
      const primaryUserId = await ensureStablePrimaryUser(
        user,
        initiatingRecipeUserId,
        input.userContext,
      );
      const passwordlessUser = await Passwordless.signInUp({
        email: normalizedEmail,
        tenantId,
        userContext: {
          ...input.userContext,
          rowndDisableAutomaticAccountLinking: true,
        },
      });
      if (passwordlessUser.status !== "OK") {
        throw emailOwnershipConflict();
      }

      if (!passwordlessUser.createdNewRecipeUser && passwordlessUser.user.id !== primaryUserId) {
        throw emailOwnershipConflict();
      }

      let newlyAssociatedTenantIds: string[] = [];
      rollbackCredentialChange = async () => {
        if (passwordlessUser.createdNewRecipeUser) {
          await SuperTokens.deleteUser(
            passwordlessUser.recipeUserId.getAsString(),
            false,
            input.userContext,
          );
        } else {
          await rollbackTenantAssociations(
            newlyAssociatedTenantIds,
            passwordlessUser.recipeUserId,
            input.userContext,
          );
        }
      };
      newlyAssociatedTenantIds = await associateRecipeUserToTenants(
        getAccountTenantIds(user!, tenantId).filter(
          (associatedTenantId) =>
            !passwordlessUser.user.loginMethods.some(
              (method) =>
                method.recipeUserId.getAsString() ===
                  passwordlessUser.recipeUserId.getAsString() &&
                method.tenantIds.includes(associatedTenantId),
            ),
        ),
        passwordlessUser.recipeUserId,
        input.userContext,
      );

      if (passwordlessUser.user.id !== primaryUserId) {
        const linkResult = await AccountLinking.linkAccounts(
          passwordlessUser.recipeUserId,
          primaryUserId,
          input.userContext,
        );
        if (linkResult.status !== "OK") {
          throw emailOwnershipConflict();
        }
      }

      metadataUserId = primaryUserId;
      canonicalEmailRecipeUserId = passwordlessUser.recipeUserId.getAsString();
      verifiedRecipeUserId = initiatingRecipeUserId;
    }

    await Session.revokeAllSessionsForUser(
      metadataUserId,
      true,
      undefined,
      input.userContext,
    );
    const targetMetadata = await getUserMetadata(metadataUserId);
    const updatedMetadata = buildVerifiedEmailMetadata(
      targetMetadata,
      metadataUserId,
      normalizedEmail,
      canonicalEmailRecipeUserId,
      metadata.original_rownd_user,
    );

    await UserMetadata.updateUserMetadata(metadataUserId, updatedMetadata);
    completionPhase = "COMPLETED";

    return {
      userId: metadataUserId,
      recipeUserId: verifiedRecipeUserId,
      initiatingSessionHandle,
      replaceSession: true,
    };
  } catch (error) {
    if (completionPhase !== "COMPLETED") {
      if (rollbackCredentialChange) {
        await Promise.allSettled([rollbackCredentialChange()]);
      }
      if (completionPhase === "COMMITTING") {
        await Promise.allSettled(
          [...new Set([userId, metadataUserId])].map((sessionUserId) =>
            Session.revokeAllSessionsForUser(
              sessionUserId,
              true,
              undefined,
              input.userContext,
            ),
          ),
        );
      }
      await Promise.allSettled([
        cleanupPendingEmailVerification(
          userId,
          pendingVerification,
          input.recipeUserId,
          normalizedEmail,
          input.userContext,
        ),
      ]);
    }
    throw error;
  }
}

function isMatchingPendingEmailVerification(
  verification: RowndPendingVerification,
  email: string,
  tenantId: string,
) {
  return verification.field === "email" &&
    normalizeEmail(verification.value) === email &&
    (verification.tenantId ?? PUBLIC_TENANT_ID) === tenantId;
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function getPasswordlessEmailLoginMethods(loginMethods: SuperTokensLoginMethod[]) {
  return loginMethods.filter(
    (method) => method.recipeId === "passwordless" && !!method.email,
  );
}

function getAccountTenantIds(user: SuperTokensUser, currentTenantId: string) {
  return [...new Set([
    currentTenantId,
    ...user.loginMethods.flatMap((method) => method.tenantIds),
  ])];
}

async function associateRecipeUserToTenants(
  tenantIds: string[],
  recipeUserId: SuperTokensLoginMethod["recipeUserId"],
  userContext?: Record<string, any>,
) {
  const newlyAssociatedTenantIds: string[] = [];
  let associationWithUnknownOutcome: string | undefined;
  try {
    for (const tenantId of tenantIds) {
      associationWithUnknownOutcome = tenantId;
      const result = await MultiTenancy.associateUserToTenant(
        tenantId,
        recipeUserId,
        userContext,
      );
      associationWithUnknownOutcome = undefined;
      if (result.status !== "OK") {
        throw emailOwnershipConflict();
      }
      if (!result.wasAlreadyAssociated) {
        newlyAssociatedTenantIds.push(tenantId);
      }
    }
    return newlyAssociatedTenantIds;
  } catch (error) {
    await rollbackTenantAssociations(
      [...new Set([
        ...newlyAssociatedTenantIds,
        ...(associationWithUnknownOutcome
          ? [associationWithUnknownOutcome]
          : []),
      ])],
      recipeUserId,
      userContext,
    );
    throw error;
  }
}

async function rollbackTenantAssociations(
  tenantIds: string[],
  recipeUserId: SuperTokensLoginMethod["recipeUserId"],
  userContext?: Record<string, any>,
) {
  await Promise.all(
    tenantIds.map((tenantId) =>
      MultiTenancy.disassociateUserFromTenant(
        tenantId,
        recipeUserId,
        userContext,
      ),
    ),
  );
}

function getVerificationRecipeUserIds(
  user: SuperTokensUser,
  verification: RowndPendingVerification,
  fallback: SuperTokensLoginMethod["recipeUserId"],
) {
  const exactRecipeUserId = user.loginMethods.find(
    (method) =>
      method.recipeUserId.getAsString() === verification.verificationRecipeUserId,
  )?.recipeUserId;
  if (exactRecipeUserId) {
    return [exactRecipeUserId];
  }

  return [...new Map(
    [...user.loginMethods.map((method) => method.recipeUserId), fallback].map(
      (recipeUserId) => [recipeUserId.getAsString(), recipeUserId],
    ),
  ).values()];
}

async function revokePendingEmailVerificationTokens(
  user: SuperTokensUser,
  verification: RowndPendingVerification,
  fallback: SuperTokensLoginMethod["recipeUserId"],
  userContext?: Record<string, any>,
) {
  await Promise.all(
    getVerificationRecipeUserIds(user, verification, fallback).map(
      (recipeUserId) =>
        EmailVerification.revokeEmailVerificationTokens(
          verification.tenantId ?? PUBLIC_TENANT_ID,
          recipeUserId,
          verification.value,
          userContext,
        ),
    ),
  );
}

async function assertEmailAvailableForUser(
  email: string,
  userId: string,
  userContext?: Record<string, any>,
) {
  const tenants = await MultiTenancy.listAllTenants(userContext);
  const tenantIds = [...new Set([
    PUBLIC_TENANT_ID,
    ...tenants.tenants.map((tenant) => tenant.tenantId),
  ])];
  const users = await Promise.all(
    tenantIds.map((tenantId) =>
      SuperTokens.listUsersByAccountInfo(
        tenantId,
        { email },
        false,
        userContext,
      ),
    ),
  );

  if (users.flat().some((owner) => owner.id !== userId)) {
    throw emailOwnershipConflict();
  }
}

function emailOwnershipConflict() {
  return new RowndEmailChangeError(
    "CONFLICT",
    409,
    "email cannot be used for this account",
  );
}

function findPendingPasswordlessMethod(
  user: SuperTokensUser | undefined,
  pendingVerification: RowndPendingVerification,
) {
  if (!user) return undefined;

  const methods = getPasswordlessEmailLoginMethods(user.loginMethods);
  if (
    pendingVerification.purpose === "UPDATE_PASSWORDLESS" &&
    pendingVerification.verificationRecipeUserId
  ) {
    return methods.find(
      (method) =>
        method.recipeUserId.getAsString() === pendingVerification.verificationRecipeUserId,
    );
  }
  return methods.length === 1 ? methods[0] : undefined;
}

async function ensureStablePrimaryUser(
  user: SuperTokensUser | undefined,
  anchor: SuperTokensLoginMethod["recipeUserId"],
  userContext?: Record<string, any>,
) {
  if (!user) {
    throw new RowndPluginError("ROWND_USER_NOT_FOUND");
  }
  if (user.isPrimaryUser) {
    return user.id;
  }

  const primaryResult = await AccountLinking.createPrimaryUser(anchor, userContext);
  if (primaryResult.status === "OK") {
    return primaryResult.user.id;
  }
  if (
    primaryResult.status ===
    "RECIPE_USER_ID_ALREADY_LINKED_WITH_PRIMARY_USER_ID_ERROR"
  ) {
    return primaryResult.primaryUserId;
  }
  throw emailOwnershipConflict();
}

async function removePendingEmailVerification(
  userId: string,
  pendingVerificationId: string,
  userContext?: Record<string, any>,
) {
  const metadata = await getUserMetadata(userId, userContext);
  await UserMetadata.updateUserMetadata(
    userId,
    {
      rownd_pending_verification: getPendingVerifications(metadata).filter(
        (verification) => verification.id !== pendingVerificationId,
      ),
    },
    userContext,
  );
}

async function markPendingEmailVerificationStatus(
  userId: string,
  pendingVerificationId: string,
  status: NonNullable<RowndPendingVerification["status"]>,
  userContext?: Record<string, any>,
) {
  const metadata = await getUserMetadata(userId, userContext);
  await UserMetadata.updateUserMetadata(
    userId,
    {
      rownd_pending_verification: getPendingVerifications(metadata).map(
        (verification) =>
          verification.id === pendingVerificationId
            ? { ...verification, status }
            : verification,
      ),
    },
    userContext,
  );
}

async function rejectInactivePendingEmailVerification(
  userId: string,
  pendingVerification: RowndPendingVerification,
  recipeUserId: SuperTokensLoginMethod["recipeUserId"],
  email: string,
  userContext?: Record<string, any>,
): Promise<never> {
  await cleanupPendingEmailVerification(
    userId,
    pendingVerification,
    recipeUserId,
    email,
    userContext,
  );
  throw new RowndEmailChangeError(
    "CONFLICT",
    409,
    "email change session is no longer active; start the email change again",
  );
}

async function cleanupPendingEmailVerification(
  userId: string,
  pendingVerification: RowndPendingVerification,
  recipeUserId: SuperTokensLoginMethod["recipeUserId"],
  email: string,
  userContext?: Record<string, any>,
) {
  try {
    await EmailVerification.unverifyEmail(recipeUserId, email, userContext);
  } finally {
    await removePendingEmailVerification(
      userId,
      pendingVerification.id,
      userContext,
    );
  }
}

function buildVerifiedEmailMetadata(
  metadata: RowndMetadata,
  userId: string,
  email: string,
  canonicalEmailRecipeUserId: string,
  fallbackOriginalRowndUser?: RowndMetadata["original_rownd_user"],
): RowndMetadata {
  const compatibilityUser = metadata.original_rownd_user ?? fallbackOriginalRowndUser ?? {
    state: "enabled",
    auth_level: "verified",
    data: { user_id: userId },
    verified_data: {},
    groups: [],
    meta: {},
  };

  return {
    ...metadata,
    original_rownd_user: {
      ...compatibilityUser,
      data: {
        ...compatibilityUser.data,
        user_id: compatibilityUser.data.user_id ?? userId,
        email,
      },
      verified_data: {
        ...compatibilityUser.verified_data,
        email,
      },
    },
    rownd_email_recipe_user_id: canonicalEmailRecipeUserId,
    rownd_pending_verification: getPendingVerifications(metadata).filter(
      (verification) => verification.field !== "email",
    ),
  };
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

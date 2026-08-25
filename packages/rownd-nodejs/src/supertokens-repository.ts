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
import type {
  JSONObject,
  SuperTokensPublicConfig,
  UserContext,
} from "supertokens-node/types";

import {
  DEFAULT_ROWND_SCHEMA,
  GUEST_AUTH_METHOD_ID,
  INSTANT_AUTH_METHOD_ID,
  PASSWORDLESS_BYPASS_DEVICE_CONFIRMATION_PARAM,
  PENDING_EMAIL_VERIFICATION_QUERY_PARAM,
  PUBLIC_TENANT_ID,
} from "./constants";
import { RowndEmailChangeError, RowndPluginError } from "./errors";
import { logDebugMessage } from "./logger";
import {
  assertRowndAppVariantIsConfigured,
  getPluginConfig,
  getSuperTokensConfig,
} from "./config";
import type { SuperTokensUserImport } from "./types";
import {
  buildRowndSessionClaimPayload,
  getEffectiveAuthLevel,
  getAnonymousId,
  getThirdPartyId,
  getThirdPartyUserId,
  isIdentityField,
  isInternalMetadataField,
  isSuperTokensFakeEmail,
  mapMethod,
  type RowndCompatUserResponse,
  type RowndMetadata,
  type RowndPendingVerification,
  getCombinedUserMetadata,
  getRawUserMetadata,
  inspectLinkedUserMetadata,
  updatePrimaryUserMetadata,
} from "./rownd-compatibility";
import {
  assertAllowedBypassRedirectPath,
  clearSuperTokensCoreCallCache,
  getErrorMessage,
  getStringList,
  getAppInfoString,
  getMagicLinkBootstrapParams,
  getWebsiteDomain,
  isJsonRecord,
  isRecord,
  normalizeRedirectToPathForClientDomain,
  resolveAllowedClientDomain,
  rewriteMagicLink,
  createDerivedUserContext,
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

type SuperTokensUser = NonNullable<
  Awaited<ReturnType<typeof SuperTokens.getUser>>
>;
type SuperTokensLoginMethod = SuperTokensUser["loginMethods"][number];
type ImportLoginMethod = SuperTokensUserImport["loginMethods"][number];
const PENDING_EMAIL_VERIFICATION_USER_CONTEXT_KEY = Symbol(
  "rowndPendingEmailVerificationId",
);

export function getPendingEmailVerificationIdFromUserContext(
  userContext: Record<string, any>,
) {
  const pendingVerificationId = Reflect.get(
    userContext,
    PENDING_EMAIL_VERIFICATION_USER_CONTEXT_KEY,
  ) as unknown;
  return typeof pendingVerificationId === "string"
    ? pendingVerificationId
    : undefined;
}

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
      importMethod.recipeId === "passwordless" ||
      (importMethod.isVerified && loginMethod.verified),
  );

  return { importMethod, owners, match };
}

export async function createMissingLoginMethod(
  importMethod: ImportLoginMethod,
  tenantId: string,
  primaryUserId: string,
  userContext: JsonRecord,
) {
  const operationContext = createDerivedUserContext(
    userContext,
    { rowndDisableAutomaticAccountLinking: true },
  );
  if (importMethod.recipeId === "thirdparty") {
    const result = await ThirdParty.manuallyCreateOrUpdateUser(
      tenantId,
      importMethod.thirdPartyId,
      importMethod.thirdPartyUserId,
      importMethod.email,
      importMethod.isVerified,
      undefined,
      operationContext,
    );
    if (result.status !== "OK") {
      throw new Error(
        `Failed to create migrated third-party login method: ${result.status}`,
      );
    }
    if (
      !result.createdNewRecipeUser &&
      !(await sdkUserIdMatchesInternalTarget(
        result.user.id,
        primaryUserId,
        operationContext,
      ))
    ) {
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
        userContext: operationContext,
      })
      : await Passwordless.signInUp({
        tenantId,
        phoneNumber: importMethod.phoneNumber!,
        userContext: operationContext,
      });

    if (
      !result.createdNewRecipeUser &&
      !(await sdkUserIdMatchesInternalTarget(
        result.user.id,
        primaryUserId,
        operationContext,
      ))
    ) {
      throw new Error(
        "Migrated passwordless login method belongs to another SuperTokens user",
      );
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

export async function ensurePrimaryUser(
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
    return superTokensUserId;
  }
  if (
    result.status === "RECIPE_USER_ID_ALREADY_LINKED_WITH_PRIMARY_USER_ID_ERROR"
  ) {
    if (
      await sdkUserIdMatchesInternalTarget(
        result.primaryUserId,
        superTokensUserId,
        userContext,
      )
    ) {
      return superTokensUserId;
    }
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

async function freshlyResolveSdkUserIdToInternal(
  sdkUserId: string,
  userContext: JsonRecord,
) {
  clearSuperTokensCoreCallCache(userContext);
  return resolveSuperTokensUserId(sdkUserId, userContext);
}

async function sdkUserIdMatchesInternalTarget(
  sdkUserId: string,
  expectedInternalUserId: string,
  userContext: JsonRecord,
) {
  if (sdkUserId === expectedInternalUserId) {
    return true;
  }

  return (
    (await freshlyResolveSdkUserIdToInternal(sdkUserId, userContext)) ===
    expectedInternalUserId
  );
}

async function assertUserIsNotMappedToAnotherRowndUser(
  superTokensUserId: string,
  rowndUserId: string,
  userContext: JsonRecord,
) {
  const mapping = await SuperTokens.getUserIdMapping({
    userId: superTokensUserId,
    userIdType: "SUPERTOKENS",
    userContext,
  });
  if (mapping.status === "OK" && mapping.externalUserId !== rowndUserId) {
    throw new Error(
      "A migrated login method is already mapped to another Rownd user",
    );
  }
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

export async function createRowndUserIdMapping(
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
    // A preflight UNKNOWN_MAPPING_ERROR may still be cached after a sibling creates the mapping.
    clearSuperTokensCoreCallCache(userContext);
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
    throw new Error(`Failed to map migrated Rownd user ID: ${result.status}`);
  }
  return true;
}

export async function reconcileRowndUserWithExistingLoginMethods(
  stUser: SuperTokensUserImport,
  tenantId: string,
  userContext: JsonRecord,
) {
  if (!stUser.externalUserId) {
    throw new Error("Migrated Rownd user has no external user ID");
  }

  clearSuperTokensCoreCallCache(userContext);
  const resolvedUserIds = new Map<string, Promise<string>>();
  const resolveUserId = (userId: string) => {
    let resolved = resolvedUserIds.get(userId);
    if (!resolved) {
      resolved = resolveSuperTokensUserId(userId, userContext);
      resolvedUserIds.set(userId, resolved);
    }
    return resolved;
  };

  const inspections = await Promise.all(
    stUser.loginMethods.map((method) =>
      inspectImportMethod(method, tenantId, userContext),
    ),
  );
  const matches = inspections.flatMap(({ match }) => (match ? [match] : []));
  if (matches.length === 0) {
    return false;
  }

  const thirdPartyMatches = matches.filter(
    ({ loginMethod }) => loginMethod.recipeId === "thirdparty",
  );
  const target = thirdPartyMatches[0] ?? matches[0]!;
  const targetSuperTokensUserId = await resolveUserId(target.user.id);
  const inspectedOwners = await Promise.all(
    inspections.flatMap(({ importMethod, owners }) =>
      owners.map(async ({ user, loginMethod }) => ({
        importMethod,
        user,
        loginMethod,
        superTokensUserId: await resolveUserId(user.id),
      })),
    ),
  );
  const foreignOwners = inspectedOwners.filter(
    ({ superTokensUserId }) => superTokensUserId !== targetSuperTokensUserId,
  );
  const canLinkVerifiedEmailOwners =
    thirdPartyMatches.length > 0 &&
    inspectedOwners
      .filter(({ importMethod }) => importMethod.recipeId === "thirdparty")
      .every(
        ({ superTokensUserId }) =>
          superTokensUserId === targetSuperTokensUserId,
      ) &&
    foreignOwners.every(
      ({ importMethod, loginMethod, user }) =>
        importMethod.recipeId === "passwordless" &&
        importMethod.email !== undefined &&
        importMethod.isVerified &&
        loginMethod.recipeId === "passwordless" &&
        loginMethod.hasSameEmailAs(importMethod.email) &&
        !user.isPrimaryUser,
    );
  if (foreignOwners.length > 0 && !canLinkVerifiedEmailOwners) {
    throw new Error(
      "A migrated login method belongs to a different SuperTokens user",
    );
  }
  for (const foreignOwner of foreignOwners) {
    await assertUserIsNotMappedToAnotherRowndUser(
      foreignOwner.superTokensUserId,
      stUser.externalUserId,
      userContext,
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
  let mappingAlreadyExists = targetSuperTokensUserId === stUser.externalUserId;
  if (!mappingAlreadyExists) {
    clearSuperTokensCoreCallCache(userContext);
    mappingAlreadyExists = await assertRowndUserIdCanBeMapped(
      targetSuperTokensUserId,
      stUser.externalUserId,
      userContext,
    );
    if (!mappingAlreadyExists) {
      await createRowndUserIdMapping(
        targetSuperTokensUserId,
        stUser.externalUserId,
        userContext,
      );
    }
  }
  const primaryUserId = await ensurePrimaryUser(
    target.user,
    target.loginMethod.recipeUserId,
    targetSuperTokensUserId,
    userContext,
  );
  const foreignRecipeUserIds = new Map(
    foreignOwners.map(({ loginMethod }) => [
      loginMethod.recipeUserId.getAsString(),
      loginMethod.recipeUserId,
    ]),
  );
  for (const recipeUserId of foreignRecipeUserIds.values()) {
    const linkResult = await AccountLinking.linkAccounts(
      recipeUserId,
      primaryUserId,
      userContext,
    );
    if (linkResult.status !== "OK") {
      throw new Error(
        `Failed to link migrated login method: ${linkResult.status}`,
      );
    }
  }
  for (const { importMethod, match } of inspections) {
    let recipeUserId: SuperTokensLoginMethod["recipeUserId"];
    let currentLoginMethod: SuperTokensLoginMethod;
    let effectiveImportMethod: ImportLoginMethod = importMethod;
    if (match) {
      recipeUserId = match.loginMethod.recipeUserId;
      currentLoginMethod = match.loginMethod;
    } else {
      const verifiedMatchingEmailMethod =
        importMethod.recipeId === "passwordless" &&
        importMethod.email !== undefined &&
        target.user.loginMethods.find(
          (method) =>
            method.tenantIds.includes(tenantId) &&
            method.verified &&
            method.hasSameEmailAs(importMethod.email!),
        );
      effectiveImportMethod = verifiedMatchingEmailMethod
        ? { ...importMethod, isVerified: true }
        : importMethod;
      ({ recipeUserId } = await createMissingLoginMethod(
        effectiveImportMethod,
        tenantId,
        primaryUserId,
        userContext,
      ));
      const createdUser = await SuperTokens.getUser(
        recipeUserId.getAsString(),
        userContext,
      );
      if (!createdUser) {
        throw new Error("Created migrated login method was not found");
      }
      const createdLoginMethod = createdUser.loginMethods.find(
        (method) =>
          method.recipeUserId.getAsString() === recipeUserId.getAsString(),
      );
      if (!createdLoginMethod) {
        throw new Error("Created migrated login method was not found");
      }
      currentLoginMethod = createdLoginMethod;
      if (
        !(await sdkUserIdMatchesInternalTarget(
          createdUser.id,
          primaryUserId,
          userContext,
        ))
      ) {
        const linkResult = await AccountLinking.linkAccounts(
          recipeUserId,
          primaryUserId,
          userContext,
        );
        const alreadyLinkedToTarget =
          linkResult.status ===
            "RECIPE_USER_ID_ALREADY_LINKED_WITH_ANOTHER_PRIMARY_USER_ID_ERROR" &&
          (await sdkUserIdMatchesInternalTarget(
            linkResult.primaryUserId,
            primaryUserId,
            userContext,
          ));
        if (linkResult.status !== "OK" && !alreadyLinkedToTarget) {
          throw new Error(
            `Failed to link migrated login method: ${linkResult.status}`,
          );
        }
      }
    }

    if (
      effectiveImportMethod.recipeId === "passwordless" &&
      effectiveImportMethod.email &&
      !effectiveImportMethod.isVerified &&
      currentLoginMethod.verified
    ) {
      await EmailVerification.unverifyEmail(
        recipeUserId,
        effectiveImportMethod.email,
        userContext,
      );
    } else if (
      effectiveImportMethod.recipeId === "passwordless" &&
      effectiveImportMethod.email &&
      effectiveImportMethod.isVerified &&
      !currentLoginMethod.verified
    ) {
      const tokenResult = await EmailVerification.createEmailVerificationToken(
        tenantId,
        recipeUserId,
        effectiveImportMethod.email,
        userContext,
      );
      if (tokenResult.status === "OK") {
        const verificationResult =
          await EmailVerification.verifyEmailUsingToken(
            tenantId,
            tokenResult.token,
            false,
            userContext,
          );
        if (verificationResult.status !== "OK") {
          throw new Error("Failed to verify migrated email method");
        }
      }
    }
  }
  await UserMetadata.updateUserMetadata(
    primaryUserId,
    stUser.userMetadata,
    userContext,
  );

  return true;
}

export async function recordRowndAppVariantForUser(
  userId: string,
  appVariantId?: string,
  userContext?: JsonRecord,
) {
  if (!appVariantId) {
    return;
  }

  assertRowndAppVariantIsConfigured(appVariantId);

  const operationContext = userContext ?? {};
  const inspection = await inspectLinkedUserMetadata(userId, operationContext);
  const metadataUserId =
    inspection.rowndMetadataSourceUserId ?? inspection.primaryUserId;
  clearSuperTokensCoreCallCache(operationContext);
  const metadata = await getRawUserMetadata(metadataUserId, operationContext);
  const originalRowndUser: JsonRecord = isJsonRecord(
    metadata.original_rownd_user,
  )
    ? metadata.original_rownd_user
    : {};
  const attributes: JsonRecord = isJsonRecord(originalRowndUser.attributes)
    ? originalRowndUser.attributes
    : {};
  const appVariants = getStringList(attributes["rownd:app_variants"]);

  if (appVariants.includes(appVariantId)) {
    return;
  }

  await UserMetadata.updateUserMetadata(
    metadataUserId,
    {
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
    },
    operationContext,
  );
}

export const RowndIsAnonymousClaim = new BooleanClaim({
  key: "is_anonymous",
  fetchValue: async (
    userId,
    _recipeUserId,
    _tenantId,
    _payload,
    userContext,
  ) => {
    const user = await SuperTokens.getUser(userId, userContext);
    const effectiveAuthLevel = getEffectiveAuthLevel(user);
    return [GUEST_AUTH_METHOD_ID, INSTANT_AUTH_METHOD_ID].includes(
      effectiveAuthLevel,
    );
  },
});

export async function buildRowndSessionClaims(
  userId: string,
  currentPayload: JsonRecord = {},
  appVariantId?: string,
  userContext?: JsonRecord,
) {
  const inspection = await inspectLinkedUserMetadata(userId, userContext);
  const user = inspection.user;
  const metadata = user ? inspection.combinedMetadata : undefined;

  return buildRowndSessionClaimPayload({
    userId,
    user,
    metadata,
    currentPayload,
    appVariantId,
  });
}

export async function buildRowndSessionAndAnonymousClaims(
  userId: string,
  currentPayload: JsonRecord,
  appVariantId: string | undefined,
  userContext: UserContext,
) {
  const inspection = await inspectLinkedUserMetadata(userId, userContext);
  const user = inspection.user;
  const rowndSessionClaims = buildRowndSessionClaimPayload({
    userId,
    user,
    metadata: user ? inspection.combinedMetadata : undefined,
    currentPayload,
    appVariantId,
  });
  const isAnonymous = [GUEST_AUTH_METHOD_ID, INSTANT_AUTH_METHOD_ID].includes(
    getEffectiveAuthLevel(user),
  );
  return {
    rowndSessionClaims,
    rowndIsAnonymousClaim: RowndIsAnonymousClaim.addToPayload_internal(
      {},
      isAnonymous,
      userContext,
    ),
  };
}

export async function createMagicLinkWithConfirmationBypass(
  input: CreateMagicLinkWithConfirmationBypassInput,
) {
  const hasEmail = typeof input.email === "string" && input.email.length > 0;
  const hasPhoneNumber =
    typeof input.phoneNumber === "string" && input.phoneNumber.length > 0;

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
  const redirectToPath = normalizeRedirectToPathForClientDomain(
    input.redirectToPath,
    clientDomain,
  );
  assertAllowedBypassRedirectPath(pluginConfig, redirectToPath);

  const userContext = input.userContext ?? {};
  const operationContext = createDerivedUserContext(userContext, {
    rowndDisplayContext: input.displayContext,
    rowndRedirectToPath: redirectToPath,
    rowndClientDomain: input.clientDomain,
    rowndAppVariantId: appVariantId,
  });
  const codeInfo = hasEmail
    ? await Passwordless.createCode({
      email: input.email!,
      tenantId,
      session: input.session,
      userContext: operationContext,
    })
    : await Passwordless.createCode({
      phoneNumber: input.phoneNumber!,
      tenantId,
      session: input.session,
      userContext: operationContext,
    });

  if (codeInfo.status !== "OK") {
    throw new Error("Failed to create magic link");
  }

  const magicLink = `${getWebsiteDomain({
    stConfig,
    request: input.request,
    userContext: operationContext,
  })}${getAppInfoString(stConfig.appInfo.websiteBasePath)}/verify?preAuthSessionId=${encodeURIComponent(
    codeInfo.preAuthSessionId,
  )}&tenantId=${encodeURIComponent(tenantId)}#${encodeURIComponent(codeInfo.linkCode)}`;
  const oauthLoginChallenge = (operationContext as Record<string, unknown>)
    .rowndOAuthLoginChallenge;
  const rewrittenUrl = new URL(
    rewriteMagicLink({
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
        oauthLoginChallenge:
              typeof oauthLoginChallenge === "string"
                ? oauthLoginChallenge
                : undefined,
      }),
    }),
  );

  rewrittenUrl.searchParams.set(
    PASSWORDLESS_BYPASS_DEVICE_CONFIRMATION_PARAM,
    "true",
  );

  return rewrittenUrl.toString();
}

export async function getUserMetadata(
  userId: string,
  userContext?: Record<string, any>,
): Promise<RowndMetadata> {
  return getCombinedUserMetadata(userId, userContext);
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
  userContext?: JsonRecord,
): Promise<RowndCompatUserResponse> {
  const inspection = await inspectLinkedUserMetadata(userId, userContext);
  const metadata = inspection.combinedMetadata;
  const stUser = inspection.user;

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

  const originalVerifiedData = (originalRowndUser?.verified_data ||
    {}) as JsonRecord;
  const verifiedData: JsonRecord = Object.fromEntries(
    Object.entries(originalVerifiedData).filter(([key]) => key !== "email"),
  );

  const tenantLoginMethods = stUser.loginMethods
    .filter((method) => method.tenantIds.includes(tenantId))
    .sort(
      (a, b) =>
        a.timeJoined - b.timeJoined ||
        a.recipeUserId
          .getAsString()
          .localeCompare(b.recipeUserId.getAsString()),
    );
  const canonicalEmailRecipeUserId = getCanonicalEmailRecipeUserId(
    metadata,
    tenantId,
  );
  const canonicalEmailMethod = tenantLoginMethods.find(
    (method) =>
      method.recipeUserId.getAsString() === canonicalEmailRecipeUserId &&
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
  const latestSessionInfo = await getLatestSessionInfo(
    stUser.id,
    tenantId,
    userContext,
  );
  const firstMethod = sortedByJoined[0];
  const latestSessionRecipeUserId =
    latestSessionInfo?.recipeUserId.getAsString();
  const lastMethod = latestSessionRecipeUserId
    ? stUser.loginMethods.find(
      (method) =>
        method.recipeUserId.getAsString() === latestSessionRecipeUserId,
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

async function getLatestSessionInfo(
  userId: string,
  tenantId: string,
  userContext?: JsonRecord,
) {
  const sessionHandles = await Session.getAllSessionHandlesForUser(
    userId,
    true,
    tenantId,
    userContext,
  );
  const sessionInfos = await Promise.all(
    sessionHandles.map((sessionHandle) =>
      Session.getSessionInformation(sessionHandle, userContext),
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
  userContext?: JsonRecord,
) {
  const { primaryUserId } = await updatePrimaryUserMetadata(
    userId,
    inputData,
    userContext,
  );
  return getUserById(primaryUserId, tenantId, userContext);
}

export function addPendingEmailVerificationMarker(input: {
  pendingVerificationId: string;
  emailVerifyLink: string;
}) {
  const verificationUrl = new URL(input.emailVerifyLink);
  if (!verificationUrl.searchParams.get("token")) {
    throw new Error("Pending email verification link has no Core token");
  }
  verificationUrl.searchParams.set(
    PENDING_EMAIL_VERIFICATION_QUERY_PARAM,
    input.pendingVerificationId,
  );
  return verificationUrl.toString();
}

export async function resolvePendingEmailVerificationToken(input: {
  token: string;
  queryPendingVerificationId?: string;
  tenantId: string;
  session?: SessionContainerInterface;
  userContext?: Record<string, any>;
}) {
  if (input.queryPendingVerificationId === undefined) {
    return { status: "NOT_PENDING" } as const;
  }
  if (!input.session) {
    return { status: "INVALID_PENDING" } as const;
  }

  const sessionHandle = input.session.getHandle(input.userContext);
  const sessionUserId = input.session.getUserId(input.userContext);
  const sessionTenantId = input.session.getTenantId(input.userContext);
  if (sessionTenantId !== input.tenantId) {
    return { status: "INVALID_PENDING" } as const;
  }

  const sessionInformation = await Session.getSessionInformation(
    sessionHandle,
    input.userContext,
  );
  if (
    !sessionInformation ||
    sessionInformation.sessionHandle !== sessionHandle ||
    sessionInformation.userId !== sessionUserId ||
    sessionInformation.tenantId !== sessionTenantId
  ) {
    return { status: "INVALID_PENDING" } as const;
  }

  const metadata = await getRawUserMetadata(sessionUserId, input.userContext);
  const pendingVerification = getPendingVerifications(metadata).find(
    (verification) =>
      verification.id === input.queryPendingVerificationId &&
      verification.field === "email" &&
      verification.status === "PENDING" &&
      verification.initiatingSessionHandle === sessionHandle &&
      (verification.tenantId ?? PUBLIC_TENANT_ID) === input.tenantId &&
      (verification.purpose === "UPDATE_PASSWORDLESS" ||
        verification.purpose === "ADD_PASSWORDLESS"),
  );
  if (!pendingVerification) {
    return { status: "INVALID_PENDING" } as const;
  }

  return {
    status: "OK" as const,
    coreToken: input.token,
    pendingVerificationId: input.queryPendingVerificationId,
    userId: sessionUserId,
  };
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
  const userContext = input.userContext ?? {};
  let user = await SuperTokens.getUser(input.userId, input.userContext);
  if (!user) {
    throw new RowndPluginError("ROWND_USER_NOT_FOUND");
  }
  let metadata = await getRawUserMetadata(user.id, input.userContext);

  const committingVerifications = getPendingVerifications(metadata).filter(
    (verification) =>
      verification.field === "email" && verification.status === "COMMITTING",
  );
  if (committingVerifications.length > 0) {
    try {
      const committingVerification = committingVerifications[0];
      if (committingVerifications.length !== 1 || !committingVerification) {
        throw new Error("multiple committing email changes found");
      }
      await reconcileCommittingEmailVerification({
        userId: user.id,
        pendingVerification: committingVerification,
        userContext: input.userContext,
      });
    } catch (error) {
      logDebugMessage(
        `Email change reconciliation failed for user ${user.id}. Error: ${getErrorMessage(error)}`,
      );
      throw emailReconciliationRequired();
    }
    user = await SuperTokens.getUser(input.userId, input.userContext);
    if (!user) {
      throw new RowndPluginError("ROWND_USER_NOT_FOUND");
    }
    metadata = await getRawUserMetadata(user.id, input.userContext);
    const refreshedInitiatingLoginMethod = user.loginMethods.find(
      (method) =>
        method.recipeUserId.getAsString() ===
          input.recipeUserId.getAsString() &&
        method.tenantIds.includes(input.tenantId),
    );
    if (!refreshedInitiatingLoginMethod) {
      await Promise.allSettled([
        Session.revokeSession(
          input.initiatingSessionHandle,
          input.userContext,
        ),
      ]);
      throw new RowndEmailChangeError(
        "CONFLICT",
        409,
        "email change sign-in method was removed; sign in again",
      );
    }
  }

  const normalizedEmail = normalizeEmail(input.email);
  if (!normalizedEmail) {
    throw new RowndEmailChangeError(
      "INVALID_EMAIL",
      400,
      "email must be a non-empty string",
    );
  }

  const passwordlessMethod = findCanonicalPasswordlessMethod(
    user,
    metadata,
    input.tenantId,
  );
  const initiatingLoginMethod = user.loginMethods.find(
    (method) =>
      method.recipeUserId.getAsString() === input.recipeUserId.getAsString() &&
      method.tenantIds.includes(input.tenantId),
  );
  const canAddPasswordless =
    !passwordlessMethod &&
    initiatingLoginMethod !== undefined &&
    canRetainMethodWhenAddingEmail(initiatingLoginMethod) &&
    user.loginMethods
      .filter((method) => method.tenantIds.includes(input.tenantId))
      .every(canRetainMethodWhenAddingEmail);
  if (!passwordlessMethod && !canAddPasswordless) {
    throw new RowndEmailChangeError(
      "CONFLICT",
      409,
      "the account has no passwordless sign-in method",
    );
  }

  const currentEmail = (
    await getUserById(input.userId, input.tenantId, input.userContext)
  ).data.email;
  const pendingVerifications = getPendingVerifications(metadata);
  const pendingEmailVerifications = pendingVerifications.filter(
    (pendingVerification) => pendingVerification.field === "email",
  );
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

    const currentPasswordlessMethod = user.loginMethods.find(
      (method) =>
        method.recipeId === "passwordless" &&
        method.tenantIds.includes(input.tenantId) &&
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
        input.tenantId,
      )
      : {
        ...metadata,
        rownd_pending_verification: pendingVerifications.filter(
          (pendingVerification) => pendingVerification.field !== "email",
        ),
      };
    if (pendingEmailVerifications.length > 0 || currentPasswordlessMethod) {
      await updatePrimaryUserMetadata(
        input.userId,
        updatedMetadata,
        input.userContext,
      );
    }

    return getUserById(input.userId, input.tenantId, input.userContext);
  }

  await assertEmailAvailableForUser(
    normalizedEmail,
    user.id,
    input.userContext,
  );

  const purpose = passwordlessMethod
    ? "UPDATE_PASSWORDLESS"
    : "ADD_PASSWORDLESS";
  const verificationRecipeUserId =
    passwordlessMethod?.recipeUserId ?? input.recipeUserId;
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

  await updatePrimaryUserMetadata(
    input.userId,
    {
      ...metadata,
      rownd_pending_verification: [
        ...pendingVerifications.filter(
          (pendingVerification) => pendingVerification.field !== "email",
        ),
        pendingVerification,
      ],
    },
    input.userContext,
  );

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
    const operationContext = createDerivedUserContext(userContext, {
      [PENDING_EMAIL_VERIFICATION_USER_CONTEXT_KEY]:
        input.pendingVerificationId,
    });
    const response = await EmailVerification.sendEmailVerificationEmail(
      input.tenantId,
      input.userId,
      verificationRecipeUserId,
      normalizedEmail,
      operationContext,
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
    await removePendingEmailVerification(
      input.userId,
      input.pendingVerificationId,
      input.userContext,
    );
    throw error;
  }

  return getUserById(input.userId, input.tenantId, input.userContext);
}

export async function completePendingEmailVerification(input: {
  recipeUserId: Parameters<typeof AccountLinking.createPrimaryUser>[0];
  email: string;
  tenantId?: string;
  sessionHandle?: string;
  pendingVerificationId?: string;
  pendingUserId?: string;
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
  const userContext = input.userContext ?? {};
  let user = await SuperTokens.getUser(
    input.recipeUserId.getAsString(),
    input.userContext,
  );
  const userId = user?.id ?? input.recipeUserId.getAsString();
  if (input.pendingUserId && userId !== input.pendingUserId) {
    if (input.pendingVerificationId) {
      await removePendingEmailVerification(
        input.pendingUserId,
        input.pendingVerificationId,
        input.userContext,
      );
    }
    throw new RowndEmailChangeError(
      "CONFLICT",
      409,
      "email change session is no longer active; start the email change again",
    );
  }
  const metadata = await getRawUserMetadata(userId, input.userContext);
  const pendingVerifications = getPendingVerifications(metadata);
  const normalizedEmail = normalizeEmail(input.email);
  const pendingVerification = pendingVerifications.find(
    (pendingVerification) =>
      (!input.pendingVerificationId ||
        pendingVerification.id === input.pendingVerificationId) &&
      isMatchingPendingEmailVerification(
        pendingVerification,
        normalizedEmail,
        tenantId,
      ) &&
      (!pendingVerification.verificationRecipeUserId ||
        pendingVerification.verificationRecipeUserId ===
          input.recipeUserId.getAsString()),
  );

  if (!pendingVerification) {
    if (input.pendingVerificationId) {
      try {
        await EmailVerification.unverifyEmail(
          input.recipeUserId,
          normalizedEmail,
          input.userContext,
        );
      } finally {
        await removePendingEmailVerification(
          userId,
          input.pendingVerificationId,
          input.userContext,
        );
      }
      throw new RowndEmailChangeError(
        "CONFLICT",
        409,
        "email change session is no longer active; start the email change again",
      );
    }
    return;
  }

  if (
    pendingVerification.purpose !== "UPDATE_PASSWORDLESS" &&
    pendingVerification.purpose !== "ADD_PASSWORDLESS"
  ) {
    return rejectInactivePendingEmailVerification(
      userId,
      pendingVerification,
      input.recipeUserId,
      normalizedEmail,
      input.userContext,
    );
  }

  const initiatingSessionHandle = pendingVerification.initiatingSessionHandle;
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
  let rollbackCredentialChange: (() => Promise<void>) | undefined;
  let destructiveCleanupStarted = false;
  try {
    await assertEmailAvailableForUser(
      normalizedEmail,
      userId,
      input.userContext,
    );

    const initiatingSession = await Session.getSessionInformation(
      initiatingSessionHandle,
      input.userContext,
    );
    if (
      !initiatingSession ||
      initiatingSession.userId !== userId ||
      initiatingSession.tenantId !== tenantId
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
    const passwordlessMethod = findPendingPasswordlessMethod(
      currentUser,
      pendingVerification,
      tenantId,
    );
    const canAddPasswordless =
      pendingVerification.purpose === "ADD_PASSWORDLESS" &&
      currentUser.loginMethods
        .filter((method) => method.tenantIds.includes(tenantId))
        .every(canRetainMethodWhenAddingEmail) &&
      canRetainMethodWhenAddingEmail(initiatingLoginMethod) &&
      pendingVerification.verificationRecipeUserId ===
        initiatingLoginMethod.recipeUserId.getAsString();
    if (
      (pendingVerification.purpose === "UPDATE_PASSWORDLESS" &&
        !passwordlessMethod) ||
      (pendingVerification.purpose === "ADD_PASSWORDLESS" &&
        !canAddPasswordless)
    ) {
      return rejectInactivePendingEmailVerification(
        userId,
        pendingVerification,
        input.recipeUserId,
        normalizedEmail,
        input.userContext,
      );
    }

    completionPhase = "COMMITTING";
    await markPendingEmailVerificationStatus(
      userId,
      pendingVerification.id,
      "COMMITTING",
      input.userContext,
    );
    if (
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
    user = currentUser;
    const initiatingRecipeUserId = initiatingLoginMethod.recipeUserId;
    await Session.revokeAllSessionsForUser(
      userId,
      true,
      undefined,
      input.userContext,
    );
    const committingMetadata = await getRawUserMetadata(
      userId,
      input.userContext,
    );
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

    const operationContext = createDerivedUserContext(
      userContext,
      { rowndDisableAutomaticAccountLinking: true },
    );
    const passwordlessUser = await Passwordless.signInUp({
      email: normalizedEmail,
      tenantId,
      userContext: operationContext,
    });
    if (passwordlessUser.status !== "OK") {
      throw emailOwnershipConflict();
    }
    const targetMethodBeforeSignInUp = currentUser.loginMethods.find(
      (method) =>
        method.recipeUserId.getAsString() ===
        passwordlessUser.recipeUserId.getAsString(),
    );
    const reusesLinkedMethod =
      !passwordlessUser.createdNewRecipeUser &&
      passwordlessUser.user.id === userId &&
      passwordlessUser.user.loginMethods.some(
        (method) =>
          method.recipeUserId.getAsString() ===
            passwordlessUser.recipeUserId.getAsString() &&
          method.tenantIds.includes(tenantId),
      );
    if (!passwordlessUser.createdNewRecipeUser && !reusesLinkedMethod) {
      throw emailOwnershipConflict();
    }
    if (passwordlessUser.createdNewRecipeUser) {
      rollbackCredentialChange = async () => {
        await SuperTokens.deleteUser(
          passwordlessUser.recipeUserId.getAsString(),
          false,
          input.userContext,
        );
      };
      await assertEmailAvailableForUser(
        normalizedEmail,
        [userId, passwordlessUser.user.id],
        input.userContext,
      );
      const primaryUserId = await ensureStablePrimaryUser(
        currentUser,
        initiatingRecipeUserId,
        input.userContext,
      );
      if (primaryUserId !== userId) {
        throw new RowndEmailChangeError(
          "CONFLICT",
          409,
          "the account changed before email verification completed",
        );
      }
      const linkResult = await AccountLinking.linkAccounts(
        passwordlessUser.recipeUserId,
        primaryUserId,
        input.userContext,
      );
      if (linkResult.status !== "OK") {
        throw emailOwnershipConflict();
      }
    } else if (
      targetMethodBeforeSignInUp &&
      !targetMethodBeforeSignInUp.tenantIds.includes(tenantId)
    ) {
      rollbackCredentialChange = async () => {
        const result = await MultiTenancy.disassociateUserFromTenant(
          tenantId,
          passwordlessUser.recipeUserId,
          input.userContext,
        );
        if (result.status !== "OK") {
          throw new Error(
            `Failed to roll back target email tenant association: ${result.status}`,
          );
        }
      };
    }
    await assertEmailAvailableForUser(
      normalizedEmail,
      userId,
      input.userContext,
    );
    const canonicalEmailRecipeUserId =
      passwordlessUser.recipeUserId.getAsString();
    const replacedEmailMethods = currentUser.loginMethods.filter(
      (method) =>
        method.recipeId === "passwordless" &&
        method.email !== undefined &&
        method.tenantIds.includes(tenantId) &&
        method.recipeUserId.getAsString() !== canonicalEmailRecipeUserId,
    );

    const committingPlan: RowndPendingVerification = {
      ...pendingVerification,
      status: "COMMITTING",
      targetCanonicalRecipeUserId: canonicalEmailRecipeUserId,
      cleanupRecipeUserIds: [
        ...new Set(
          replacedEmailMethods.map((method) =>
            method.recipeUserId.getAsString(),
          ),
        ),
      ],
    };
    await persistPendingEmailReconciliationPlan(
      userId,
      committingPlan,
      input.userContext,
    );
    destructiveCleanupStarted = true;
    await reconcileCommittingEmailVerification({
      userId,
      pendingVerification: committingPlan,
      revokeSessions: true,
      userContext: input.userContext,
    });
    completionPhase = "COMPLETED";

    return {
      userId,
      recipeUserId: passwordlessUser.recipeUserId,
      initiatingSessionHandle,
      replaceSession: true,
    };
  } catch (error) {
    if (destructiveCleanupStarted) {
      await Promise.allSettled([
        Session.revokeAllSessionsForUser(
          userId,
          true,
          undefined,
          input.userContext,
        ),
      ]);
      logDebugMessage(
        `Email change cleanup incomplete for user ${userId}; reconciliation required. Error: ${getErrorMessage(error)}`,
      );
      throw new RowndEmailChangeError(
        "CONFLICT",
        409,
        "email change cleanup incomplete; account reconciliation is required",
      );
    }
    if (completionPhase !== "COMPLETED") {
      let rollbackError: unknown;
      if (rollbackCredentialChange) {
        try {
          await rollbackCredentialChange();
        } catch (caughtRollbackError) {
          rollbackError = caughtRollbackError;
        }
      }
      if (completionPhase === "COMMITTING") {
        await Promise.allSettled([
          Session.revokeAllSessionsForUser(
            userId,
            true,
            undefined,
            input.userContext,
          ),
        ]);
      }
      if (rollbackError !== undefined) {
        logDebugMessage(
          `Email change rollback failed for user ${userId}; reconciliation required. Error: ${getErrorMessage(rollbackError)}`,
        );
        throw new RowndEmailChangeError(
          "CONFLICT",
          409,
          "email change rollback failed; account reconciliation is required",
        );
      }
      const [cleanupResult] = await Promise.allSettled([
        cleanupPendingEmailVerification(
          userId,
          pendingVerification,
          input.recipeUserId,
          normalizedEmail,
          input.userContext,
        ),
      ]);
      if (
        completionPhase === "COMMITTING" &&
        cleanupResult.status === "rejected"
      ) {
        await Promise.allSettled([
          markPendingEmailVerificationStatus(
            userId,
            pendingVerification.id,
            "PENDING",
            input.userContext,
          ),
        ]);
      }
    }
    throw error;
  }
}

function isMatchingPendingEmailVerification(
  verification: RowndPendingVerification,
  email: string,
  tenantId: string,
) {
  return (
    verification.field === "email" &&
    normalizeEmail(verification.value) === email &&
    (verification.tenantId ?? PUBLIC_TENANT_ID) === tenantId
  );
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function isRealThirdPartyMethod(method: SuperTokensLoginMethod) {
  return (
    method.recipeId === "thirdparty" &&
    method.thirdParty?.id !== GUEST_AUTH_METHOD_ID &&
    method.thirdParty?.id !== INSTANT_AUTH_METHOD_ID
  );
}

function canRetainMethodWhenAddingEmail(method: SuperTokensLoginMethod) {
  return (
    isRealThirdPartyMethod(method) ||
    (method.recipeId === "passwordless" &&
      method.phoneNumber !== undefined &&
      method.email === undefined)
  );
}

async function removePasswordlessMethodFromTenant(
  recipeUserId: string,
  tenantId: string,
  expectedPrimaryUserId: string,
  userContext?: Record<string, any>,
) {
  const user = await SuperTokens.getUser(recipeUserId, userContext);
  const method = user?.loginMethods.find(
    (candidate) => candidate.recipeUserId.getAsString() === recipeUserId,
  );
  if (!method || !method.tenantIds.includes(tenantId)) {
    return;
  }
  if (
    user?.id !== expectedPrimaryUserId ||
    method.recipeId !== "passwordless" ||
    !method.email
  ) {
    throw new Error("Replaced email method no longer belongs to the account");
  }

  const result = await MultiTenancy.disassociateUserFromTenant(
    tenantId,
    method.recipeUserId,
    userContext,
  );
  if (result.status !== "OK") {
    throw new Error(
      `Failed to remove replaced email method from tenant: ${result.status}`,
    );
  }

  const refreshedOwner = await SuperTokens.getUser(recipeUserId, userContext);
  if (!refreshedOwner) return;
  const refreshedMethod = refreshedOwner.loginMethods.find(
    (candidate) => candidate.recipeUserId.getAsString() === recipeUserId,
  );
  if (!refreshedMethod) return;
  if (
    refreshedOwner.id !== expectedPrimaryUserId ||
    refreshedMethod.recipeId !== "passwordless" ||
    !refreshedMethod.email ||
    refreshedMethod.tenantIds.includes(tenantId)
  ) {
    throw new Error("Replaced email method changed during tenant removal");
  }
  if (refreshedMethod.tenantIds.length > 0) return;

  await SuperTokens.deleteUser(recipeUserId, false, userContext);
}

async function ensureStablePrimaryUser(
  user: SuperTokensUser,
  anchor: SuperTokensLoginMethod["recipeUserId"],
  userContext?: Record<string, any>,
) {
  if (user.isPrimaryUser) {
    return user.id;
  }

  const primaryResult = await AccountLinking.createPrimaryUser(
    anchor,
    userContext,
  );
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

function getVerificationRecipeUserIds(
  user: SuperTokensUser,
  verification: RowndPendingVerification,
  fallback: SuperTokensLoginMethod["recipeUserId"],
) {
  const exactRecipeUserId = user.loginMethods.find(
    (method) =>
      method.recipeUserId.getAsString() ===
      verification.verificationRecipeUserId,
  )?.recipeUserId;
  if (exactRecipeUserId) {
    return [exactRecipeUserId];
  }

  return [
    ...new Map(
      [...user.loginMethods.map((method) => method.recipeUserId), fallback].map(
        (recipeUserId) => [recipeUserId.getAsString(), recipeUserId],
      ),
    ).values(),
  ];
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
  allowedUserIds: string | string[],
  userContext?: Record<string, any>,
) {
  const allowedIds = new Set(
    Array.isArray(allowedUserIds) ? allowedUserIds : [allowedUserIds],
  );
  const tenants = await MultiTenancy.listAllTenants(userContext);
  const tenantIds = [
    ...new Set([
      PUBLIC_TENANT_ID,
      ...tenants.tenants.map((tenant) => tenant.tenantId),
    ]),
  ];
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

  if (users.flat().some((owner) => !allowedIds.has(owner.id))) {
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
  tenantId: string,
) {
  if (!user) return undefined;

  if (
    pendingVerification.purpose !== "UPDATE_PASSWORDLESS" ||
    !pendingVerification.verificationRecipeUserId
  )
    return undefined;
  const passwordlessMethod = user.loginMethods.find(
    (method) =>
      method.recipeId === "passwordless" &&
      method.recipeUserId.getAsString() ===
        pendingVerification.verificationRecipeUserId,
  );
  return passwordlessMethod?.tenantIds.includes(tenantId) &&
    passwordlessMethod.recipeUserId.getAsString() ===
      pendingVerification.verificationRecipeUserId
    ? passwordlessMethod
    : undefined;
}

function findCanonicalPasswordlessMethod(
  user: SuperTokensUser,
  metadata: RowndMetadata,
  tenantId: string,
) {
  const passwordlessMethods = user.loginMethods.filter(
    (method) =>
      method.recipeId === "passwordless" &&
      method.email !== undefined &&
      method.tenantIds.includes(tenantId),
  );
  const canonicalEmailRecipeUserId = getCanonicalEmailRecipeUserId(
    metadata,
    tenantId,
  );
  if (canonicalEmailRecipeUserId) {
    const canonicalMethod = passwordlessMethods.find(
      (method) =>
        method.recipeUserId.getAsString() === canonicalEmailRecipeUserId,
    );
    if (!canonicalMethod) {
      throw new RowndEmailChangeError(
        "CONFLICT",
        409,
        "the canonical email sign-in method is invalid",
      );
    }
    return canonicalMethod;
  }
  if (passwordlessMethods.length > 1) {
    throw new RowndEmailChangeError(
      "AMBIGUOUS",
      409,
      "the account has multiple email sign-in methods without a canonical method",
    );
  }
  return passwordlessMethods[0];
}

function getCanonicalEmailRecipeUserId(
  metadata: RowndMetadata,
  tenantId: string,
) {
  return (
    metadata.rownd_email_recipe_user_ids?.[tenantId] ??
    (metadata.rownd_email_recipe_user_ids === undefined
      ? metadata.rownd_email_recipe_user_id
      : undefined)
  );
}

async function removePendingEmailVerification(
  userId: string,
  pendingVerificationId: string,
  userContext?: Record<string, any>,
) {
  const metadata = await getRawUserMetadata(userId, userContext);
  await updatePrimaryUserMetadata(
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
  const metadata = await getRawUserMetadata(userId, userContext);
  await updatePrimaryUserMetadata(
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

async function persistPendingEmailReconciliationPlan(
  userId: string,
  plan: RowndPendingVerification,
  userContext?: Record<string, any>,
) {
  const metadata = await getRawUserMetadata(userId, userContext);
  let found = false;
  const pendingVerifications = getPendingVerifications(metadata).map(
    (verification) => {
      if (verification.id !== plan.id) return verification;
      found = true;
      return plan;
    },
  );
  if (!found) {
    throw new Error("pending email reconciliation state is missing");
  }
  await updatePrimaryUserMetadata(
    userId,
    { rownd_pending_verification: pendingVerifications },
    userContext,
  );
}

async function reconcileCommittingEmailVerification(input: {
  userId: string;
  pendingVerification: RowndPendingVerification;
  revokeSessions?: boolean;
  userContext?: Record<string, any>;
}) {
  const metadata = await getRawUserMetadata(input.userId, input.userContext);
  const pendingVerification = getPendingVerifications(metadata).find(
    (verification) => verification.id === input.pendingVerification.id,
  );
  const tenantId = pendingVerification?.tenantId ?? PUBLIC_TENANT_ID;
  const targetRecipeUserId = pendingVerification?.targetCanonicalRecipeUserId;
  const cleanupRecipeUserIds = pendingVerification?.cleanupRecipeUserIds;
  const normalizedEmail = pendingVerification
    ? normalizeEmail(pendingVerification.value)
    : "";
  if (
    !pendingVerification ||
    pendingVerification.field !== "email" ||
    pendingVerification.status !== "COMMITTING" ||
    !normalizedEmail ||
    !targetRecipeUserId ||
    !Array.isArray(cleanupRecipeUserIds) ||
    cleanupRecipeUserIds.some((id) => typeof id !== "string" || !id) ||
    new Set(cleanupRecipeUserIds).size !== cleanupRecipeUserIds.length ||
    cleanupRecipeUserIds.includes(targetRecipeUserId)
  ) {
    throw new Error("pending email reconciliation state is invalid");
  }

  const user = await SuperTokens.getUser(input.userId, input.userContext);
  const targetOwner = await SuperTokens.getUser(
    targetRecipeUserId,
    input.userContext,
  );
  const targetMethod = user?.loginMethods.find(
    (method) => method.recipeUserId.getAsString() === targetRecipeUserId,
  );
  if (
    !user ||
    user.id !== input.userId ||
    !targetOwner ||
    targetOwner.id !== input.userId ||
    !targetMethod ||
    targetMethod.recipeId !== "passwordless" ||
    !targetMethod.verified ||
    !targetMethod.tenantIds.includes(tenantId) ||
    !targetMethod.email ||
    normalizeEmail(targetMethod.email) !== normalizedEmail
  ) {
    throw new Error("pending email reconciliation target is invalid");
  }

  const currentCleanupRecipeUserIds = user.loginMethods
    .filter(
      (method) =>
        method.recipeId === "passwordless" &&
        method.email !== undefined &&
        method.tenantIds.includes(tenantId) &&
        method.recipeUserId.getAsString() !== targetRecipeUserId,
    )
    .map((method) => method.recipeUserId.getAsString());
  const updatedCleanupRecipeUserIds = [
    ...new Set([...cleanupRecipeUserIds, ...currentCleanupRecipeUserIds]),
  ];

  for (const cleanupRecipeUserId of updatedCleanupRecipeUserIds) {
    const owner = await SuperTokens.getUser(
      cleanupRecipeUserId,
      input.userContext,
    );
    if (!owner) continue;
    const method = owner.loginMethods.find(
      (candidate) =>
        candidate.recipeUserId.getAsString() === cleanupRecipeUserId,
    );
    if (!method || !method.tenantIds.includes(tenantId)) continue;
    if (
      owner.id !== input.userId ||
      method.recipeId !== "passwordless" ||
      !method.email
    ) {
      throw new Error("pending email reconciliation cleanup method is invalid");
    }
  }

  if (updatedCleanupRecipeUserIds.length !== cleanupRecipeUserIds.length) {
    await persistPendingEmailReconciliationPlan(
      input.userId,
      {
        ...pendingVerification,
        cleanupRecipeUserIds: updatedCleanupRecipeUserIds,
      },
      input.userContext,
    );
  }

  for (const cleanupRecipeUserId of updatedCleanupRecipeUserIds) {
    await removePasswordlessMethodFromTenant(
      cleanupRecipeUserId,
      tenantId,
      input.userId,
      input.userContext,
    );
  }
  if (input.revokeSessions) {
    await Session.revokeAllSessionsForUser(
      input.userId,
      true,
      undefined,
      input.userContext,
    );
  }

  const finalMetadata = await getRawUserMetadata(
    input.userId,
    input.userContext,
  );
  const finalPendingVerification = getPendingVerifications(finalMetadata).find(
    (verification) => verification.id === pendingVerification.id,
  );
  if (
    finalPendingVerification?.status !== "COMMITTING" ||
    finalPendingVerification.targetCanonicalRecipeUserId !==
      targetRecipeUserId ||
    JSON.stringify(finalPendingVerification.cleanupRecipeUserIds) !==
      JSON.stringify(updatedCleanupRecipeUserIds)
  ) {
    throw new Error("pending email reconciliation state changed");
  }

  const finalTargetOwner = await SuperTokens.getUser(
    targetRecipeUserId,
    input.userContext,
  );
  const finalTargetMethod = finalTargetOwner?.loginMethods.find(
    (method) => method.recipeUserId.getAsString() === targetRecipeUserId,
  );
  if (
    !finalTargetOwner ||
    finalTargetOwner.id !== input.userId ||
    !finalTargetMethod ||
    finalTargetMethod.recipeId !== "passwordless" ||
    !finalTargetMethod.verified ||
    !finalTargetMethod.tenantIds.includes(tenantId) ||
    normalizeEmail(finalTargetMethod.email ?? "") !== normalizedEmail
  ) {
    throw new Error("pending email reconciliation target changed");
  }
  if (
    finalTargetOwner.loginMethods.some(
      (method) =>
        method.recipeId === "passwordless" &&
        method.email !== undefined &&
        method.tenantIds.includes(tenantId) &&
        method.recipeUserId.getAsString() !== targetRecipeUserId,
    )
  ) {
    throw new Error("pending email reconciliation cleanup is incomplete");
  }

  await updatePrimaryUserMetadata(
    input.userId,
    buildVerifiedEmailMetadata(
      finalMetadata,
      input.userId,
      normalizedEmail,
      targetRecipeUserId,
      tenantId,
    ),
    input.userContext,
  );
}

function emailReconciliationRequired() {
  return new RowndEmailChangeError(
    "CONFLICT",
    409,
    "email change cleanup incomplete; account reconciliation is required",
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
  await EmailVerification.unverifyEmail(recipeUserId, email, userContext);
  await removePendingEmailVerification(
    userId,
    pendingVerification.id,
    userContext,
  );
}

function buildVerifiedEmailMetadata(
  metadata: RowndMetadata,
  userId: string,
  email: string,
  canonicalEmailRecipeUserId: string,
  tenantId: string,
  fallbackOriginalRowndUser?: RowndMetadata["original_rownd_user"],
): RowndMetadata {
  const compatibilityUser = metadata.original_rownd_user ??
    fallbackOriginalRowndUser ?? {
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
    rownd_email_recipe_user_ids: {
      ...metadata.rownd_email_recipe_user_ids,
      [tenantId]: canonicalEmailRecipeUserId,
    },
    rownd_pending_verification: getPendingVerifications(metadata).filter(
      (verification) => verification.field !== "email",
    ),
  };
}

export async function updateUserMetadata(
  userId: string,
  inputMeta: JsonRecord,
  userContext?: JsonRecord,
) {
  const { primaryUserId } = await updatePrimaryUserMetadata(
    userId,
    inputMeta,
    userContext,
  );
  const updatedMetadata = await getCombinedUserMetadata(
    primaryUserId,
    userContext,
  );

  return {
    id: primaryUserId,
    meta: Object.fromEntries(
      Object.entries(updatedMetadata).filter(
        ([key]) => !isInternalMetadataField(key),
      ),
    ) as JsonRecord,
  };
}

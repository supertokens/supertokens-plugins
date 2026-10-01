import SuperTokens from "supertokens-node";
import AccountLinking from "supertokens-node/recipe/accountlinking";
import EmailVerification from "supertokens-node/recipe/emailverification";
import Passwordless from "supertokens-node/recipe/passwordless";
import Session from "supertokens-node/recipe/session";
import { BooleanClaim } from "supertokens-node/recipe/session/claims";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import type { JSONObject, SuperTokensPublicConfig } from "supertokens-node/types";

import { DEFAULT_ROWND_SCHEMA, GUEST_AUTH_METHOD_ID, PUBLIC_TENANT_ID } from "./constants";
import { RowndPluginError } from "./errors";
import { assertRowndAppVariantIsConfigured, getPluginConfig } from "./config";
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
  mapMethod,
  type RowndCompatUserResponse,
  type RowndMetadata,
  type RowndPendingVerification,
} from "./rownd-compatibility";
import {
  getStringList,
  isJsonRecord,
  isRecord,
  type JsonRecord,
} from "./utils";

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

  return buildRowndSessionClaimPayload({
    userId,
    user,
    metadata,
    currentPayload,
    appVariantId,
  });
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

function getPasswordlessEmailLoginMethod(
  user: Awaited<ReturnType<typeof SuperTokens.getUser>>,
) {
  return user?.loginMethods.find((method) => {
    return method.recipeId === "passwordless" && !!method.email;
  });
}

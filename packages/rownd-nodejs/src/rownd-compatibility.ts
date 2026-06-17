import SuperTokens from "supertokens-node";
import AccountLinking from "supertokens-node/recipe/accountlinking";
import type { JSONObject } from "supertokens-node/types";

import {
  DEFAULT_ROWND_SCHEMA,
  GUEST_AUTH_METHOD_ID,
  INSTANT_AUTH_METHOD_ID,
  ROWND_JWT_CLAIMS,
} from "./constants";
import { getPluginConfig } from "./config";
import type {
  RowndUser,
  RowndUserMetadata,
  SuperTokensUserImport,
} from "./types";
import type { JsonRecord, JsonValue } from "./utils";
import { getStringList } from "./utils";

export type RowndMetadata = RowndUserMetadata & JsonRecord;

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

export type SuperTokensUser = NonNullable<Awaited<ReturnType<typeof SuperTokens.getUser>>>;
export type SuperTokensLoginMethod = SuperTokensUser["loginMethods"][number];

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

export function isIdentityField(field: string) {
  return IDENTITY_USER_DATA_FIELDS.has(field);
}

export function isInternalMetadataField(field: string) {
  return INTERNAL_METADATA_FIELDS.has(field);
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
        : INSTANT_AUTH_METHOD_ID;
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

export function buildRowndAudience(
  currentPayload: JsonRecord,
  appVariantId?: string,
) {
  const audience = getStringList(currentPayload.aud);
  const appId = getPluginConfig()?.appConfig?.id;

  if (appId) {
    audience.push(`app:${appId}`);
  }

  if (appVariantId) {
    audience.push(`app_variant:${appVariantId}`);
  }

  return audience.length > 0 ? { aud: [...new Set(audience)] } : {};
}

export function buildConfiguredSessionClaims(metadata?: RowndMetadata): JsonRecord {
  if (!metadata) {
    return {};
  }

  const schema = getPluginConfig()?.schema || DEFAULT_ROWND_SCHEMA;
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

export function getRowndAppUserId(
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

export function getAnonymousId(
  userId: string,
  user: Awaited<ReturnType<typeof SuperTokens.getUser>>,
  metadata?: RowndMetadata,
) {
  const originalAnonymousId = metadata?.original_rownd_user?.data?.anonymous_id;
  if (typeof originalAnonymousId === "string") {
    return originalAnonymousId;
  }

  const guestMethod = user?.loginMethods.find((loginMethod) => {
    return (
      loginMethod.recipeId === "thirdparty" &&
      getThirdPartyId(loginMethod) === GUEST_AUTH_METHOD_ID
    );
  });

  return guestMethod ? `anon_${user?.id || userId}` : undefined;
}

export function buildRowndSessionClaimPayload(input: {
  userId: string;
  user: Awaited<ReturnType<typeof SuperTokens.getUser>>;
  metadata?: RowndMetadata;
  currentPayload?: JsonRecord;
  appVariantId?: string;
}) {
  const currentPayload = input.currentPayload ?? {};
  const originalRowndUser = input.metadata?.original_rownd_user;
  const verifiedData = originalRowndUser?.verified_data as
    | JsonRecord
    | undefined;
  const authLevel = getEffectiveAuthLevel(
    input.user,
    typeof currentPayload.auth_level === "string"
      ? currentPayload.auth_level
      : originalRowndUser?.auth_level,
    verifiedData,
  );
  const appUserId = getRowndAppUserId(
    input.userId,
    input.user,
    currentPayload,
    input.metadata,
  );
  const isAnonymous =
    currentPayload.is_anonymous === true ||
    authLevel === GUEST_AUTH_METHOD_ID;
  const anonymousId = getAnonymousId(input.userId, input.user, input.metadata);
  const isVerifiedUser = authLevel !== "unverified";
  const audience = buildRowndAudience(currentPayload, input.appVariantId);
  const configuredClaims = buildConfiguredSessionClaims(input.metadata);

  return {
    ...audience,
    ...configuredClaims,
    app_user_id: appUserId,
    auth_level: authLevel,
    is_verified_user: isVerifiedUser,
    [ROWND_JWT_CLAIMS.AppUserId]: appUserId,
    [ROWND_JWT_CLAIMS.AuthLevel]: authLevel,
    [ROWND_JWT_CLAIMS.IsVerifiedUser]: isVerifiedUser,
    ...(isAnonymous ? { [ROWND_JWT_CLAIMS.IsAnonymous]: true } : {}),
    ...(anonymousId ? { anonymous_id: anonymousId } : {}),
  };
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

export function mapMethod(method: SuperTokensLoginMethod) {
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

export function getThirdPartyId(method: SuperTokensLoginMethod) {
  return method.thirdParty?.id;
}

export function getThirdPartyUserId(method: SuperTokensLoginMethod) {
  return method.thirdParty?.userId;
}

function getGuestAuthLevel(
  user: Awaited<ReturnType<typeof SuperTokens.getUser>>,
) {
  const guestMethod = user?.loginMethods.find((method) => {
    return (
      method.recipeId === "thirdparty" &&
      getThirdPartyId(method) === GUEST_AUTH_METHOD_ID
    );
  });
  if (guestMethod) {
    return GUEST_AUTH_METHOD_ID;
  }

  const instantMethod = user?.loginMethods.find((method) => {
    return (
      method.recipeId === "thirdparty" &&
      getThirdPartyId(method) === INSTANT_AUTH_METHOD_ID
    );
  });

  return instantMethod ? INSTANT_AUTH_METHOD_ID : undefined;
}

export function hasOnlyGuestLoginMethods(
  user: Awaited<ReturnType<typeof SuperTokens.getUser>>,
) {
  return (
    !!user?.loginMethods.length && user.loginMethods.every(isGuestLoginMethod)
  );
}

export function isGuestLoginMethod(method: SuperTokensLoginMethod) {
  const thirdPartyId = getThirdPartyId(method);
  return (
    method.recipeId === "thirdparty" &&
    (thirdPartyId === GUEST_AUTH_METHOD_ID ||
      thirdPartyId === INSTANT_AUTH_METHOD_ID)
  );
}

function isGuestAccountInfo(input?: {
  recipeId: string;
  thirdParty?: { id: string };
}) {
  return (
    input?.recipeId === "thirdparty" &&
    (input.thirdParty?.id === GUEST_AUTH_METHOD_ID ||
      input.thirdParty?.id === INSTANT_AUTH_METHOD_ID)
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
  if (originalAuthLevel === INSTANT_AUTH_METHOD_ID) {
    return INSTANT_AUTH_METHOD_ID;
  }

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
  const schema = getPluginConfig()?.schema || DEFAULT_ROWND_SCHEMA;
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

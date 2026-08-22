import { createHash } from "node:crypto";

import SuperTokens from "supertokens-node";
import AccountLinking from "supertokens-node/recipe/accountlinking";
import UserMetadata from "supertokens-node/recipe/usermetadata";
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
import { getStringList, isJsonRecord } from "./utils";

export type RowndMetadata = RowndUserMetadata & JsonRecord;

export type LinkedUserMetadataInspection = {
  user?: SuperTokensUser;
  primaryUserId: string;
  linkedUserIds: string[];
  primaryMetadata: RowndMetadata;
  combinedMetadata: RowndMetadata;
  metadataUpdate: JsonRecord;
  rowndMetadataSourceUserId?: string;
  rowndMetadataSourceMetadata?: RowndMetadata;
};

export type RowndVerifiableField = string;

export type RowndPendingVerification = {
  id: string;
  field: RowndVerifiableField;
  value: string;
  created_at: string;
  tenantId?: string;
  purpose?: "UPDATE_PASSWORDLESS" | "ADD_PASSWORDLESS";
  initiatingSessionHandle?: string;
  verificationRecipeUserId?: string;
  status?: "PENDING" | "COMMITTING";
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

export type SuperTokensUser = NonNullable<
  Awaited<ReturnType<typeof SuperTokens.getUser>>
>;
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
  "rownd_email_recipe_user_id",
  "rownd_email_recipe_user_ids",
  "rownd_migration_complete",
  "rownd_pending_verification",
]);

const LINKED_OPERATIONAL_METADATA_FIELDS = new Set([
  "rownd_email_recipe_user_id",
  "rownd_email_recipe_user_ids",
  "rownd_migration_complete",
  "rownd_pending_verification",
]);

const SUPERTOKENS_FAKE_EMAIL_DOMAIN = "stfakeemail.supertokens.com";

export async function getRawUserMetadata(
  userId: string,
  userContext?: Record<string, any>,
): Promise<RowndMetadata> {
  const result = await UserMetadata.getUserMetadata(userId, userContext);
  return (result.metadata || {}) as RowndMetadata;
}

function getOriginalRowndUserId(metadata: { original_rownd_user?: JsonValue }) {
  const originalRowndUser = metadata.original_rownd_user;
  const data = isJsonRecord(originalRowndUser)
    ? originalRowndUser.data
    : undefined;
  return isJsonRecord(data) && typeof data.user_id === "string"
    ? data.user_id
    : undefined;
}

function mergeMissingValues(primary: JsonRecord, secondary: JsonRecord) {
  const merged: JsonRecord = { ...primary };

  for (const [key, secondaryValue] of Object.entries(secondary)) {
    const primaryValue = merged[key];
    if (primaryValue === undefined) {
      merged[key] = secondaryValue;
    } else if (isJsonRecord(primaryValue) && isJsonRecord(secondaryValue)) {
      merged[key] = mergeMissingValues(primaryValue, secondaryValue);
    }
  }

  return merged;
}

export function combineLinkedMetadata(input: {
  primaryUserId: string;
  primaryMetadata: RowndMetadata;
  linkedMetadata: Array<{ userId: string; metadata: RowndMetadata }>;
  canonicalRowndUserId?: string;
}): LinkedUserMetadataInspection {
  const linkedMetadata = [...input.linkedMetadata].sort((a, b) => {
    const aMatchesCanonical =
      input.canonicalRowndUserId !== undefined &&
      getOriginalRowndUserId(a.metadata) === input.canonicalRowndUserId;
    const bMatchesCanonical =
      input.canonicalRowndUserId !== undefined &&
      getOriginalRowndUserId(b.metadata) === input.canonicalRowndUserId;
    if (aMatchesCanonical !== bMatchesCanonical) {
      return aMatchesCanonical ? -1 : 1;
    }
    return a.userId.localeCompare(b.userId);
  });
  const primaryRowndUserId = getOriginalRowndUserId(input.primaryMetadata);
  const canonicalLinkedMetadata =
    input.canonicalRowndUserId === undefined
      ? undefined
      : linkedMetadata.find(
        ({ metadata }) =>
          getOriginalRowndUserId(metadata) === input.canonicalRowndUserId,
      );
  const canonicalMetadataReplacesPrimary =
    canonicalLinkedMetadata !== undefined &&
    primaryRowndUserId !== input.canonicalRowndUserId;

  const metadataUpdate: JsonRecord = canonicalMetadataReplacesPrimary
    ? {
      original_rownd_user:
          canonicalLinkedMetadata.metadata.original_rownd_user!,
    }
    : {};
  for (const { metadata } of linkedMetadata) {
    for (const [key, value] of Object.entries(metadata)) {
      if (LINKED_OPERATIONAL_METADATA_FIELDS.has(key)) {
        continue;
      }
      if (
        key === "original_rownd_user" &&
        input.canonicalRowndUserId !== undefined &&
        (primaryRowndUserId === input.canonicalRowndUserId ||
          canonicalLinkedMetadata !== undefined) &&
        getOriginalRowndUserId(metadata) !== input.canonicalRowndUserId
      ) {
        continue;
      }

      const currentValue = Object.prototype.hasOwnProperty.call(
        metadataUpdate,
        key,
      )
        ? metadataUpdate[key]
        : input.primaryMetadata[key];
      if (currentValue === undefined) {
        metadataUpdate[key] = value;
      } else if (isJsonRecord(currentValue) && isJsonRecord(value)) {
        const mergedValue = mergeMissingValues(currentValue, value);
        if (JSON.stringify(mergedValue) !== JSON.stringify(currentValue)) {
          metadataUpdate[key] = mergedValue;
        }
      }
    }
  }

  return {
    primaryUserId: input.primaryUserId,
    linkedUserIds: linkedMetadata.map(({ userId }) => userId),
    primaryMetadata: input.primaryMetadata,
    combinedMetadata: {
      ...input.primaryMetadata,
      ...metadataUpdate,
    } as RowndMetadata,
    metadataUpdate,
    rowndMetadataSourceUserId:
      primaryRowndUserId !== undefined &&
      (input.canonicalRowndUserId === undefined ||
        primaryRowndUserId === input.canonicalRowndUserId ||
        canonicalLinkedMetadata === undefined)
        ? input.primaryUserId
        : (canonicalLinkedMetadata?.userId ??
          linkedMetadata.find(
            ({ metadata }) => getOriginalRowndUserId(metadata) !== undefined,
          )?.userId),
    rowndMetadataSourceMetadata:
      primaryRowndUserId !== undefined &&
      (input.canonicalRowndUserId === undefined ||
        primaryRowndUserId === input.canonicalRowndUserId ||
        canonicalLinkedMetadata === undefined)
        ? input.primaryMetadata
        : (canonicalLinkedMetadata?.metadata ??
          linkedMetadata.find(
            ({ metadata }) => getOriginalRowndUserId(metadata) !== undefined,
          )?.metadata),
  };
}

async function getPrimaryUserMapping(
  userId: string,
  userContext?: Record<string, any>,
) {
  const internalMapping = await SuperTokens.getUserIdMapping({
    userId,
    userIdType: "SUPERTOKENS",
    userContext,
  });
  if (internalMapping.status === "OK") {
    return internalMapping;
  }

  const externalMapping = await SuperTokens.getUserIdMapping({
    userId,
    userIdType: "EXTERNAL",
    userContext,
  });
  return externalMapping.status === "OK" ? externalMapping : undefined;
}

export async function inspectLinkedUserMetadata(
  userId: string,
  userContext?: Record<string, any>,
  userSnapshot?: SuperTokensUser,
): Promise<LinkedUserMetadataInspection> {
  const user = userSnapshot ?? (await SuperTokens.getUser(userId, userContext));
  if (!user) {
    const metadata = await getRawUserMetadata(userId, userContext);
    return {
      user: undefined,
      primaryUserId: userId,
      linkedUserIds: [],
      primaryMetadata: metadata,
      combinedMetadata: metadata,
      metadataUpdate: {},
      rowndMetadataSourceUserId:
        getOriginalRowndUserId(metadata) === undefined ? undefined : userId,
      rowndMetadataSourceMetadata:
        getOriginalRowndUserId(metadata) === undefined ? undefined : metadata,
    };
  }

  const mapping = await getPrimaryUserMapping(user.id, userContext);
  const primaryUserId = mapping?.superTokensUserId ?? user.id;
  const linkedUserIds = [
    ...new Set(
      user.loginMethods
        .map((method) => method.recipeUserId.getAsString())
        .filter((recipeUserId) => recipeUserId !== primaryUserId),
    ),
  ];
  const [primaryMetadata, linkedMetadata] = await Promise.all([
    getRawUserMetadata(primaryUserId, userContext),
    Promise.all(
      linkedUserIds.map(async (linkedUserId) => ({
        userId: linkedUserId,
        metadata: await getRawUserMetadata(linkedUserId, userContext),
      })),
    ),
  ]);

  return {
    ...combineLinkedMetadata({
      primaryUserId,
      primaryMetadata,
      linkedMetadata,
      canonicalRowndUserId: mapping?.externalUserId,
    }),
    user,
  };
}

export async function getCombinedUserMetadata(
  userId: string,
  userContext?: Record<string, any>,
) {
  return (await inspectLinkedUserMetadata(userId, userContext))
    .combinedMetadata;
}

export async function updatePrimaryUserMetadata(
  userId: string,
  metadataUpdate: JsonRecord,
  userContext?: Record<string, any>,
) {
  const user = await SuperTokens.getUser(userId, userContext);
  const primaryUserId = user?.id ?? userId;
  const result = await UserMetadata.updateUserMetadata(
    primaryUserId,
    metadataUpdate as JSONObject,
    userContext,
  );

  return {
    primaryUserId,
    metadata: result.metadata as RowndMetadata,
  };
}

export function isSuperTokensFakeEmail(email: unknown): email is string {
  return (
    typeof email === "string" &&
    email.toLowerCase().endsWith(`@${SUPERTOKENS_FAKE_EMAIL_DOMAIN}`)
  );
}

function buildSuperTokensFakeEmail(
  thirdPartyUserId: string,
  thirdPartyId: string,
) {
  const hash = createHash("sha256")
    .update(`${thirdPartyId}:${thirdPartyUserId}`)
    .digest("hex")
    .slice(0, 32);

  return `st-${thirdPartyId}-${hash}@${SUPERTOKENS_FAKE_EMAIL_DOMAIN}`;
}

export function isIdentityField(field: string) {
  return IDENTITY_USER_DATA_FIELDS.has(field);
}

export function isInternalMetadataField(field: string) {
  return INTERNAL_METADATA_FIELDS.has(field);
}

export function mapRowndUserToSuperTokens(
  rowndUser: RowndUser,
  tenantId?: string,
): SuperTokensUserImport {
  const loginMethods: SuperTokensUserImport["loginMethods"] = [];
  const rowndUserData = rowndUser.data || {};
  const rowndUserVerifiedData = rowndUser.verified_data || {};
  if (!rowndUserData.user_id) {
    throw new Error("Rownd user has no user_id");
  }

  if (rowndUserData.google_id) {
    loginMethods.push({
      recipeId: "thirdparty",
      thirdPartyId: "google",
      thirdPartyUserId: rowndUserData.google_id,
      email: buildSuperTokensFakeEmail(rowndUserData.google_id, "google"),
      isVerified: false,
      ...(tenantId ? { tenantIds: [tenantId] } : {}),
    });
  }

  if (rowndUserData.apple_id) {
    loginMethods.push({
      recipeId: "thirdparty",
      thirdPartyId: "apple",
      thirdPartyUserId: rowndUserData.apple_id,
      email: buildSuperTokensFakeEmail(rowndUserData.apple_id, "apple"),
      isVerified: false,
      ...(tenantId ? { tenantIds: [tenantId] } : {}),
    });
  }

  if (rowndUserData.phone_number) {
    loginMethods.push({
      recipeId: "passwordless",
      phoneNumber: rowndUserData.phone_number,
      isVerified: !!rowndUserVerifiedData.phone_number,
      ...(tenantId ? { tenantIds: [tenantId] } : {}),
    });
  }

  if (rowndUserData.email) {
    loginMethods.push({
      recipeId: "passwordless",
      email: rowndUserData.email,
      isVerified:
        rowndUserVerifiedData.email === true ||
        (typeof rowndUserVerifiedData.email === "string" &&
          rowndUserVerifiedData.email.toLowerCase() ===
            rowndUserData.email.toLowerCase()),
      ...(tenantId ? { tenantIds: [tenantId] } : {}),
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
      ...(tenantId ? { tenantIds: [tenantId] } : {}),
    });
  }

  if (loginMethods.length > 1) {
    loginMethods[0]!.isPrimary = true;
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
    rownd_migration_complete: true,
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

export function buildConfiguredSessionClaims(
  metadata?: RowndMetadata,
): JsonRecord {
  if (!metadata) {
    return {};
  }

  const schema = getPluginConfig()?.schema || DEFAULT_ROWND_SCHEMA;
  const claims: JsonRecord = {};

  for (const [key, field] of Object.entries(schema)) {
    if (field.include_in_session_claims !== true) {
      continue;
    }

    const claimName = field.session_claim_name || key;
    const value = metadata.original_rownd_user?.data?.[key] ?? metadata[key];
    if (value !== undefined) {
      claims[claimName] = value as JsonValue;
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
  currentPayload?: JsonRecord,
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

  if (!guestMethod) {
    return undefined;
  }

  return typeof currentPayload?.anonymous_id === "string"
    ? currentPayload.anonymous_id
    : `anon_${user?.id || userId}`;
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
    JsonRecord | undefined;
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
  const isAnonymous = [GUEST_AUTH_METHOD_ID, INSTANT_AUTH_METHOD_ID].includes(
    authLevel,
  );
  const anonymousId = getAnonymousId(
    input.userId,
    input.user,
    input.metadata,
    currentPayload,
  );
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

type OAuthClientLike = {
  audience?: string[];
};

export function normalizeRowndOAuthScopes(scopes: string[]) {
  return [...new Set(scopes.filter((scope) => scope.length > 0))];
}

export function getRowndOAuthAudience(input: {
  requestedAudience?: string;
  requestedResource?: string;
}) {
  const requested = input.requestedResource ?? input.requestedAudience;
  if (requested?.startsWith("app:")) {
    return requested;
  }

  return undefined;
}

export function applyRowndOAuthResourceParams(input: {
  params: Record<string, any>;
  userContext: Record<string, any>;
}) {
  const resource = firstString(input.params.resource);
  const audience = firstString(input.params.audience);
  const rowndAudience = getRowndOAuthAudience({
    requestedResource: resource,
    requestedAudience: audience,
  });

  if (!rowndAudience) {
    return undefined;
  }

  input.params.audience = audience ?? rowndAudience;
  delete input.params.resource;
  return rowndAudience;
}

export async function buildRowndOAuthPayload(input: {
  user: SuperTokensUser | undefined;
  client?: OAuthClientLike;
  scopes: string[];
  currentPayload?: JsonRecord;
  userContext?: Record<string, any>;
}) {
  const currentPayload = input.currentPayload ?? {};
  const metadata = input.user
    ? await getRowndMetadata(input.user, input.userContext)
    : undefined;
  const standardClaims = input.user
    ? buildStandardOAuthClaims(input.user, input.scopes, metadata!)
    : {};
  const rowndClaims = input.user
    ? buildRowndOAuthSessionClaims(input.user, currentPayload, metadata!)
    : {};
  const audience = getRowndOAuthAudience({
    requestedAudience:
      typeof input.userContext?.rowndOAuthAudience === "string"
        ? input.userContext.rowndOAuthAudience
        : undefined,
  });

  return {
    ...currentPayload,
    ...standardClaims,
    ...rowndClaims,
    ...(audience ? { aud: audience } : {}),
  };
}

export async function buildRowndOAuthUserInfo(input: {
  user: SuperTokensUser;
  accessTokenPayload: JsonRecord;
  scopes: string[];
  currentPayload?: JsonRecord;
  userContext?: Record<string, any>;
}) {
  const standardClaims = buildStandardOAuthClaims(
    input.user,
    input.scopes,
    await getRowndMetadata(input.user, input.userContext),
  );
  const rowndClaims = pickOAuthUserInfoRowndClaims(input.accessTokenPayload);

  return {
    ...input.currentPayload,
    ...standardClaims,
    ...rowndClaims,
  };
}

function buildStandardOAuthClaims(
  user: SuperTokensUser,
  scopes: string[],
  metadata: RowndMetadata,
) {
  const claims: JsonRecord = {};
  const rowndData = isJsonRecord(metadata.original_rownd_user?.data)
    ? metadata.original_rownd_user.data
    : ({} as JsonRecord);
  const verifiedData = isJsonRecord(metadata.original_rownd_user?.verified_data)
    ? metadata.original_rownd_user.verified_data
    : ({} as JsonRecord);

  if (scopes.includes("email")) {
    const email = firstRealEmail(firstString(rowndData.email), ...user.emails);
    if (email) {
      claims.email = email;
      claims.email_verified = isOAuthClaimVerified(
        verifiedData.email,
        email,
        user.loginMethods.some(
          (method) => method.hasSameEmailAs(email) && method.verified,
        ),
      );
    }
  }

  if (scopes.includes("phone")) {
    const phoneNumber =
      firstString(rowndData.phone_number) ?? user.phoneNumbers[0];
    if (phoneNumber) {
      claims.phone_number = phoneNumber;
      claims.phone_number_verified = isOAuthClaimVerified(
        verifiedData.phone_number,
        phoneNumber,
        user.loginMethods.some(
          (method) =>
            method.hasSamePhoneNumberAs(phoneNumber) && method.verified,
        ),
      );
    }
  }

  if (scopes.includes("profile")) {
    const givenName = firstString(rowndData.first_name);
    const familyName = firstString(rowndData.last_name);
    const name = [givenName, familyName].filter(Boolean).join(" ");

    if (name) claims.name = name;
    if (givenName) claims.given_name = givenName;
    if (familyName) claims.family_name = familyName;
    if (typeof metadata.original_rownd_user?.data?.updated_at === "string") {
      claims.updated_at = metadata.original_rownd_user.data.updated_at;
    }
  }

  return claims;
}

async function getRowndMetadata(
  user: SuperTokensUser,
  userContext?: Record<string, any>,
): Promise<RowndMetadata> {
  return (await inspectLinkedUserMetadata(user.id, userContext, user))
    .combinedMetadata;
}

function pickOAuthUserInfoRowndClaims(payload: JsonRecord) {
  const claims: JsonRecord = {};
  for (const key of [
    "app_user_id",
    "auth_level",
    "is_verified_user",
    "is_anonymous",
    "anonymous_id",
    "https://auth.rownd.io/app_user_id",
    "https://auth.rownd.io/auth_level",
    "https://auth.rownd.io/is_verified_user",
    "https://auth.rownd.io/is_anonymous",
  ]) {
    if (payload[key] !== undefined) {
      claims[key] = payload[key];
    }
  }

  return claims;
}

function firstString(value: unknown) {
  if (Array.isArray(value)) {
    return value.find((entry): entry is string => typeof entry === "string");
  }

  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function firstRealEmail(...values: unknown[]) {
  return values.find((entry): entry is string => {
    return (
      typeof entry === "string" &&
      entry.length > 0 &&
      !isSuperTokensFakeEmail(entry)
    );
  });
}

function isOAuthClaimVerified(
  value: unknown,
  expectedValue: string,
  fallback: boolean,
) {
  return value === true || value === expectedValue || fallback;
}

function buildRowndOAuthSessionClaims(
  user: SuperTokensUser,
  currentPayload: JsonRecord,
  metadata: RowndMetadata,
) {
  return buildRowndSessionClaimPayload({
    userId: user.id,
    user,
    metadata,
    currentPayload,
  });
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
  const [newAccountInfo, existingUser, session, tenantId, userContext] = input;

  if (session) {
    const currentUser = await SuperTokens.getUser(
      session.getUserId(userContext),
      userContext,
    );

    if (hasOnlyGuestLoginMethods(currentUser)) {
      return {
        shouldAutomaticallyLink: true,
        shouldRequireVerification: false,
      };
    }

    if (
      currentUser &&
      !isGuestAccountInfo(newAccountInfo) &&
      doesAccountInfoMatchAuthMethod(currentUser, newAccountInfo, tenantId)
    ) {
      return {
        shouldAutomaticallyLink: true,
        shouldRequireVerification: true,
      };
    }

    return undefined;
  }

  const email = newAccountInfo?.email;
  if (!email || isGuestAccountInfo(newAccountInfo)) {
    return undefined;
  }
  const accountInfo = { ...newAccountInfo, email };

  const matchingUsers = existingUser
    ? [existingUser]
    : await SuperTokens.listUsersByAccountInfo(
      tenantId,
      { email },
      true,
      userContext,
    );

  if (
    matchingUsers.some((user) =>
      hasVerifiedMatchingEmailLoginMethod(user, accountInfo, tenantId),
    )
  ) {
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
  tenantId: string,
) {
  if (!user) {
    return false;
  }

  const normalizedEmail = accountInfo.email?.toLowerCase();
  if (normalizedEmail) {
    return user.loginMethods.some((method) => {
      if (
        isGuestLoginMethod(method) ||
        !method.tenantIds.includes(tenantId) ||
        !method.email ||
        !method.verified
      ) {
        return false;
      }

      return method.email.toLowerCase() === normalizedEmail;
    });
  }

  if (accountInfo.phoneNumber) {
    return user.loginMethods.some((method) => {
      return (
        !isGuestLoginMethod(method) &&
        method.tenantIds.includes(tenantId) &&
        method.verified &&
        method.phoneNumber === accountInfo.phoneNumber
      );
    });
  }

  return false;
}

function hasVerifiedMatchingEmailLoginMethod(
  user: NonNullable<Awaited<ReturnType<typeof SuperTokens.getUser>>>,
  accountInfo: {
    recipeId: string;
    email: string;
    thirdParty?: { id: string; userId: string };
  },
  tenantId: string,
) {
  const normalizedEmail = accountInfo.email.toLowerCase();
  const thirdParty = accountInfo.thirdParty;

  if (
    accountInfo.recipeId === "thirdparty" &&
    thirdParty &&
    user.loginMethods.some((method) => {
      const existingThirdParty = method.thirdParty;
      return (
        method.recipeId === "thirdparty" &&
        method.tenantIds.includes(tenantId) &&
        existingThirdParty?.id === thirdParty.id &&
        existingThirdParty.userId !== thirdParty.userId
      );
    })
  ) {
    return false;
  }

  return user.loginMethods.some((method) => {
    if (
      isGuestLoginMethod(method) ||
      !method.tenantIds.includes(tenantId) ||
      !method.verified ||
      method.email?.toLowerCase() !== normalizedEmail
    ) {
      return false;
    }

    if (method.recipeId !== accountInfo.recipeId) {
      return true;
    }

    return (
      method.recipeId === "thirdparty" &&
      method.thirdParty?.id !== accountInfo.thirdParty?.id
    );
  });
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

  if (originalAuthLevel === INSTANT_AUTH_METHOD_ID) {
    return INSTANT_AUTH_METHOD_ID;
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

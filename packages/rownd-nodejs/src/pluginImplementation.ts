import SuperTokens from "supertokens-node";
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
import { DEFAULT_ROWND_SCHEMA } from "./constants";
import type {
  JSONObject,
  SuperTokensPublicConfig,
} from "supertokens-node/types";

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

export async function parseRequest(req: any): Promise<{
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

export function mapRowndUserToSuperTokens(
  rowndUser: RowndUser,
  tenantIds?: string[],
): SuperTokensUserImport {
  const loginMethods: SuperTokensUserImport["loginMethods"] = [];
  const rowndUserData = (rowndUser.data || {}) as Record<string, string>;
  const rowndUserVerifiedData = (rowndUser.verified_data || {}) as Record<
    string,
    any
  >;
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

  if (loginMethods.length === 0) {
    throw new Error("No valid login methods found in Rownd user data");
  }

  const rowndUserMeta = rowndUser.meta || {};
  const rowndUserAttributes = rowndUser.attributes || {};

  const userMetadata: JSONObject = {
    data: {
      ...rowndUserData,
    },
    meta: {
      ...rowndUserMeta,
    },
    verified_data: {
      ...rowndUserVerifiedData,
    },
    attributes: {
      ...rowndUserAttributes,
    },
    rownd_migrated: true,
    rownd_user_id: rowndUserData.user_id,
    state: rowndUser.state,
    auth_level: rowndUser.auth_level,
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
  data: Record<string, any>;
  meta: Record<string, any>;
  verified_data: Record<string, any>;
  attributes: Record<string, any>;
  rownd_migrated?: boolean;
  rownd_user_id?: string;
  state?: string;
  auth_level?: string;
};

export type RowndCompatUserResponse = {
  rownd_user: string;
  data: Record<string, any>;
  meta: Record<string, any>;
  verified_data: Record<string, any>;
  state: string;
  auth_level: string;
  redacted: string[];
  groups: any[];
  attributes?: Record<string, any>;
};

export async function getUserMetadata(userId: string): Promise<RowndMetadata> {
  const metadata = await UserMetadata.getUserMetadata(userId);
  const rowndMetadata = (metadata.metadata || {}) as Partial<RowndMetadata>;

  return {
    data: rowndMetadata.data || {},
    meta: rowndMetadata.meta || {},
    verified_data: rowndMetadata.verified_data || {},
    attributes: rowndMetadata.attributes || {},
    rownd_migrated: rowndMetadata.rownd_migrated,
    rownd_user_id: rowndMetadata.rownd_user_id,
    state: rowndMetadata.state,
    auth_level: rowndMetadata.auth_level,
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

  const rownd_user = metadata.rownd_user_id || userId;
  const state = metadata.state || "enabled";

  const data: Record<string, any> = {
    user_id: userId,
    ...metadata.data,
  };

  const verified_data: Record<string, any> = {
    ...metadata.verified_data,
  };

  let lastUsedAt = stUser.timeJoined;

  for (const method of stUser.loginMethods as any[]) {
    if (method.lastUsed > lastUsedAt) {
      lastUsedAt = method.lastUsed;
    }

    if (method.recipeId === "passwordless") {
      if (method.email) {
        verified_data.email = method.email;
        if (data.email === undefined) data.email = method.email;
      }
      if (method.phoneNumber) {
        verified_data.phone_number = method.phoneNumber;
        if (data.phone_number === undefined)
          data.phone_number = method.phoneNumber;
      }
    } else if (method.recipeId === "thirdparty") {
      if (method.verified && method.email) {
        verified_data.email = method.email;
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

  if (verified_data.email === true && typeof data.email === "string") {
    verified_data.email = data.email;
  }
  if (
    verified_data.phone_number === true &&
    typeof data.phone_number === "string"
  ) {
    verified_data.phone_number = data.phone_number;
  }

  const auth_level =
    metadata.auth_level ||
    (Object.keys(verified_data).length > 0 ? "verified" : "unverified");

  const schema = pluginConfig?.schema || DEFAULT_ROWND_SCHEMA;
  for (const [key, field] of Object.entries(schema)) {
    if (data[key] === undefined && field.type === "string") {
      data[key] = "";
    }
  }

  const mapMethod = (method: any) => {
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
  const sortedByLastUsed = [...(stUser.loginMethods as any[])].sort(
    (a, b) => (b.lastUsed || b.timeJoined) - (a.lastUsed || a.timeJoined),
  );

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
    rownd_user,
    data,
    meta,
    verified_data,
    state,
    auth_level,
    redacted: [],
    groups: [],
    attributes: metadata.attributes,
  };
}

export async function updateUserData(
  userId: string,
  inputData: Record<string, any>,
) {
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

export async function updateUserMetadata(
  userId: string,
  inputMeta: Record<string, any>,
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
    meta: (updatedMetadata.meta || {}) as Record<string, any>,
  };
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
    read_only: field.read_only ?? (ownedBy === "app"),
    show_empty: field.show_empty ?? false,
  };
}

export const DEFAULT_PRIMARY_COLOR = "#5b5bd6";

function buildSignInMethodsConfig(methodsArray: RowndSignInMethod[] | undefined) {
  const methods = (methodsArray ?? []).reduce((acc, curr) => {
    acc[curr.method] = curr;
    return acc;
  }, {} as Record<string, any>);

  const customProviders = Object.fromEntries(
    Object.entries(methods)
      .filter(([key]) => !BUILTIN_SIGN_IN_METHOD_KEYS.includes(key))
      .map(([key, val]) => {
        const v = val as Record<string, any> | undefined;
        return v
          ? [
              key,
              {
                enabled: true,
                display_name: v["displayName"] ?? key,
                icon_light_url: v["iconLightUrl"],
                icon_dark_url: v["iconDarkUrl"],
              },
            ]
          : [key, undefined];
      })
      .filter(([_, v]) => v !== undefined),
  );

  const googleMethod = methods.google;
  const appleMethod = methods.apple;
  const anonymousMethod = methods.anonymous;

  return {
    email: { enabled: !!methods.email },
    phone: { enabled: !!methods.phone },
    google: {
      enabled: !!googleMethod,
      client_id: googleMethod?.clientId ?? "",
      ios_client_id: googleMethod?.iosClientId ?? "",
      scopes: googleMethod?.scopes ?? [],
      one_tap: {
        browser: {
          auto_prompt: googleMethod?.oneTap?.browser?.autoPrompt ?? false,
          delay: googleMethod?.oneTap?.browser?.delay ?? 7000,
        },
        mobile_app: {
          auto_prompt: googleMethod?.oneTap?.mobileApp?.autoPrompt ?? false,
          delay: googleMethod?.oneTap?.mobileApp?.delay ?? 7000,
        },
      },
    },
    apple: {
      enabled: !!appleMethod,
      client_id: appleMethod?.clientId ?? "",
    },
    anonymous: {
      enabled: !!anonymousMethod,
      ...(anonymousMethod?.displayName !== undefined
        ? { display_name: anonymousMethod.displayName }
        : {}),
      ...(anonymousMethod?.iconLightUrl !== undefined
        ? { icon_light_url: anonymousMethod.iconLightUrl }
        : {}),
      ...(anonymousMethod?.iconDarkUrl !== undefined
        ? { icon_dark_url: anonymousMethod.iconDarkUrl }
        : {}),
    },
    ...customProviders,
  };
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

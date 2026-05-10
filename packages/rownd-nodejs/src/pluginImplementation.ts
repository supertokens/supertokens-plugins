import SuperTokens from "supertokens-node";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import SuperTokensCore from "supertokens-node/lib/build/supertokens";
import {
  RowndUser,
  SuperTokensUserImport,
  IRowndClient,
  RowndPluginNormalisedConfig,
  RowndSignInMethods,
} from "./types";
import { RowndPluginError } from "./errors";
import { DEFAULT_ROWND_SCHEMA, RowndSchemaField } from "./schema";
import type {
  JSONObject,
  SuperTokensPublicConfig,
} from "supertokens-node/types";

let rowndClient: IRowndClient | undefined;

export function setRowndClient(client: IRowndClient) {
  rowndClient = client;
}

export function getRowndClient() {
  if (!rowndClient) {
    throw new Error("Rownd client not initialized");
  }
  return rowndClient;
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

  if (rowndUserData.email && loginMethods.length === 0) {
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
};

export type RowndCompatUserResponse = {
  data: Record<string, any>;
  meta: Record<string, any>;
  verified_data: Record<string, any>;
  redacted: string[];
  groups: any[];
  attributes?: Record<string, any>;
};

export async function getRowndStyleMetadata(
  userId: string,
): Promise<RowndMetadata> {
  const metadata = await UserMetadata.getUserMetadata(userId);
  const rowndMetadata = (metadata.metadata || {}) as Partial<RowndMetadata>;

  return {
    data: rowndMetadata.data || {},
    meta: rowndMetadata.meta || {},
    verified_data: rowndMetadata.verified_data || {},
    attributes: rowndMetadata.attributes || {},
    rownd_migrated: rowndMetadata.rownd_migrated,
    rownd_user_id: rowndMetadata.rownd_user_id,
  };
}

export async function buildRowndStyleUserResponse(
  userId: string,
): Promise<RowndCompatUserResponse> {
  const metadata = await getRowndStyleMetadata(userId);
  const stUser = await SuperTokens.getUser(userId);
  const loginMethod = stUser?.loginMethods[0];

  const data: Record<string, any> = {
    user_id: userId,
    ...metadata.data,
  };

  if (
    data.email === undefined &&
    loginMethod &&
    "email" in loginMethod &&
    loginMethod.email
  ) {
    data.email = loginMethod.email;
  }

  if (
    data.phone_number === undefined &&
    loginMethod &&
    "phoneNumber" in loginMethod &&
    loginMethod.phoneNumber
  ) {
    data.phone_number = loginMethod.phoneNumber;
  }

  const verifiedData = {
    ...metadata.verified_data,
  };

  if (verifiedData.email === true && typeof data.email === "string") {
    verifiedData.email = data.email;
  }

  if (
    verifiedData.phone_number === true &&
    typeof data.phone_number === "string"
  ) {
    verifiedData.phone_number = data.phone_number;
  }

  if (
    loginMethod &&
    "email" in loginMethod &&
    loginMethod.email &&
    loginMethod.verified === true &&
    verifiedData.email === undefined
  ) {
    verifiedData.email = loginMethod.email;
  }

  if (
    loginMethod &&
    "phoneNumber" in loginMethod &&
    loginMethod.phoneNumber &&
    loginMethod.verified === true &&
    verifiedData.phone_number === undefined
  ) {
    verifiedData.phone_number = loginMethod.phoneNumber;
  }

  return {
    data,
    meta: metadata.meta,
    verified_data: verifiedData,
    redacted: [],
    groups: [],
    attributes: metadata.attributes,
  };
}

export async function updateRowndUserData(
  userId: string,
  inputData: Record<string, any>,
) {
  const metadata = await getRowndStyleMetadata(userId);
  const updatedMetadata: JSONObject = {
    ...metadata,
    data: {
      ...metadata.data,
      ...inputData,
      user_id: userId,
    },
  };

  await UserMetadata.updateUserMetadata(userId, updatedMetadata);
  return buildRowndStyleUserResponse(userId);
}

export async function updateRowndUserMetadata(
  userId: string,
  inputMeta: Record<string, any>,
) {
  const metadata = await getRowndStyleMetadata(userId);
  const updatedMetadata: JSONObject = {
    ...metadata,
    meta: {
      ...metadata.meta,
      ...inputMeta,
    },
  };

  await UserMetadata.updateUserMetadata(userId, updatedMetadata);

  return {
    id: userId,
    meta: (updatedMetadata.meta || {}) as Record<string, any>,
  };
}

// ---------------------------------------------------------------------------
// App config response builder (used by GET /plugin/rownd/app-config)
// ---------------------------------------------------------------------------

const BUILTIN_SIGN_IN_METHOD_KEYS = [
  "email",
  "phone",
  "google",
  "apple",
  "anonymous",
];

function normalizeSchemaField(field: RowndSchemaField) {
  return {
    display_name: field.display_name,
    type: field.type,
    data_category: field.data_category,
    owned_by: field.owned_by,
    required: field.required,
    unique: field.unique,
    user_visible: field.user_visible,
    read_only: field.read_only ?? false,
    show_empty: field.show_empty ?? false,
    revoke_after: field.revoke_after ?? "",
    required_retention: field.required_retention ?? "",
    collection_justification: field.collection_justification ?? "",
    opt_out_warning: field.opt_out_warning ?? "",
  };
}

function buildSignInMethodsConfig(methods: RowndSignInMethods | undefined) {
  let tpInstance: any;
  let plInstance: any;
  let epInstance: any;

  try {
    const stInstance = SuperTokensCore.getInstanceOrThrowError();
    tpInstance = stInstance.getRecipeInstance("thirdparty");
    plInstance = stInstance.getRecipeInstance("passwordless");
    epInstance = stInstance.getRecipeInstance("emailpassword");
  } catch (err) {
    // Ignore if SuperTokens is not fully initialized yet
  }

  let emailEnabled = !!epInstance;
  let phoneEnabled = false;

  if (plInstance?.config?.contactMethod) {
    const contactMethod = plInstance.config.contactMethod;
    if (contactMethod === "EMAIL" || contactMethod === "EMAIL_OR_PHONE") {
      emailEnabled = true;
    }
    if (contactMethod === "PHONE" || contactMethod === "EMAIL_OR_PHONE") {
      phoneEnabled = true;
    }
  }

  let googleEnabled = false;
  let googleClientId = "";
  let googleIosClientId = methods?.google?.iosClientId ?? "";
  let googleScopes: string[] = [];

  let appleEnabled = false;
  let appleClientId = "";

  if (tpInstance?.config?.signInAndUpFeature?.providers) {
    for (const providerInput of tpInstance.config.signInAndUpFeature.providers) {
      const config = providerInput.config;
      if (config.thirdPartyId === "google") {
        googleEnabled = true;
        if (config.scope) {
          googleScopes = config.scope;
        }
        if (config.clients && config.clients.length > 0) {
          for (const client of config.clients) {
            if (client.clientType === "ios") {
              if (!googleIosClientId) {
                googleIosClientId = client.clientId;
              }
            } else if (!client.clientType || client.clientType === "web") {
              googleClientId = client.clientId;
            }
          }
          if (!googleClientId && config.clientId) {
            googleClientId = config.clientId;
          }
        } else {
          googleClientId = config.clientId;
        }
      } else if (config.thirdPartyId === "apple") {
        appleEnabled = true;
        if (config.clients && config.clients.length > 0) {
          appleClientId = config.clients[0].clientId;
        } else {
          appleClientId = config.clientId;
        }
      }
    }
  }

  const customProviders = Object.fromEntries(
    Object.entries(methods ?? {})
      .filter(([key]) => !BUILTIN_SIGN_IN_METHOD_KEYS.includes(key))
      .map(([key, val]) => {
        const v = val as Record<string, any> | undefined;
        return v
          ? [
              key,
              {
                enabled: v["enabled"] ?? false,
                display_name: v["displayName"] ?? key,
                icon_light_url: v["iconLightUrl"],
                icon_dark_url: v["iconDarkUrl"],
              },
            ]
          : [key, undefined];
      }),
  );

  return {
    email: { enabled: emailEnabled },
    phone: { enabled: phoneEnabled },
    google: {
      enabled: googleEnabled,
      client_id: googleClientId,
      ios_client_id: googleIosClientId,
      scopes: googleScopes,
      one_tap: {
        browser: {
          auto_prompt: methods?.google?.oneTap?.browser?.autoPrompt ?? false,
          delay: methods?.google?.oneTap?.browser?.delay ?? 7000,
        },
      },
    },
    apple: {
      enabled: appleEnabled,
      client_id: appleClientId,
    },
    anonymous: {
      enabled: methods?.anonymous?.enabled ?? false,
      ...(methods?.anonymous?.displayName !== undefined
        ? { display_name: methods.anonymous.displayName }
        : {}),
      ...(methods?.anonymous?.iconLightUrl !== undefined
        ? { icon_light_url: methods.anonymous.iconLightUrl }
        : {}),
      ...(methods?.anonymous?.iconDarkUrl !== undefined
        ? { icon_dark_url: methods.anonymous.iconDarkUrl }
        : {}),
    },
    ...customProviders,
  };
}

export function buildAppConfigResponse(config: RowndPluginNormalisedConfig) {
  const schema = config.schema ?? DEFAULT_ROWND_SCHEMA;
  const app = config.appConfig ?? {};
  const branding = app.branding ?? {};
  const auth = app.auth ?? {};

  return {
    id: app.id ?? "",
    name: app.name ?? "",
    icon: app.icon ?? "",
    schema: Object.fromEntries(
      Object.entries(schema).map(([key, field]) => [
        key,
        normalizeSchemaField(field),
      ]),
    ),
    config: {
      customizations: {
        primary_color: branding.primaryColor ?? "#5b5bd6",
        ...(branding.logo ? { logo: branding.logo } : {}),
        ...(branding.logoDarkMode ? { logo_dark_mode: branding.logoDarkMode } : {}),
      },
      hub: {
        customizations: {
          rounded_corners: branding.roundedCorners ?? true,
          visual_swoops: branding.visualSwoops ?? true,
          blur_background: branding.blurBackground ?? true,
          dark_mode: branding.darkMode ?? "auto",
        },
        auth: {
          email: { from_address: "no-reply@rownd.io", image: "" },
          sign_in_methods: buildSignInMethodsConfig(app.signInMethods),
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
                    ? { sign_in_title: app.customContent.signInModal.signInTitle }
                    : {}),
                  ...(app.customContent.signInModal.signUpTitle
                    ? { sign_up_title: app.customContent.signInModal.signUpTitle }
                    : {}),
                  ...(app.customContent.signInModal.signInSubtitle
                    ? { sign_in_subtitle: app.customContent.signInModal.signInSubtitle }
                    : {}),
                  ...(app.customContent.signInModal.signUpSubtitle
                    ? { sign_up_subtitle: app.customContent.signInModal.signUpSubtitle }
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

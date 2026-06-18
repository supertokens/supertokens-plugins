import type { SuperTokensPublicConfig } from "supertokens-node/types";

import { DEFAULT_ROWND_SCHEMA } from "./constants";
import type {
  RowndAuthConfig,
  RowndPluginNormalisedConfig,
  RowndSchemaField,
  RowndSignInMethod,
  RowndSubBrandConfigInput,
} from "./types";
import { isRecord } from "./utils";

let pluginConfig: RowndPluginNormalisedConfig | undefined;
let superTokensConfig: SuperTokensPublicConfig | undefined;

export function setPluginConfig(config: RowndPluginNormalisedConfig) {
  pluginConfig = config;
}

export function getPluginConfig() {
  return pluginConfig;
}

export function setSuperTokensConfig(config: SuperTokensPublicConfig) {
  superTokensConfig = config;
}

export function getSuperTokensConfig() {
  return superTokensConfig;
}

export function assertRowndAppVariantIsConfigured(appVariantId?: string) {
  if (!appVariantId) {
    return;
  }

  if (pluginConfig?.subBrands && !pluginConfig.subBrands[appVariantId]) {
    throw new Error(`Unknown Rownd app variant: ${appVariantId}`);
  }
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
      ...(getStringMethodProperty(appleMethod, "webClientType") !== undefined
        ? { web_client_type: getStringMethodProperty(appleMethod, "webClientType") }
        : {}),
      ...(getStringMethodProperty(appleMethod, "iosClientType") !== undefined
        ? { ios_client_type: getStringMethodProperty(appleMethod, "iosClientType") }
        : {}),
      ...(getStringMethodProperty(appleMethod, "androidClientType") !== undefined
        ? { android_client_type: getStringMethodProperty(appleMethod, "androidClientType") }
        : {}),
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

export function buildRowndAppConfig(
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

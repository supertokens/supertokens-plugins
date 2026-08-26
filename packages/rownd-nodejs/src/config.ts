import type { SuperTokensPublicConfig } from "supertokens-node/types";

import { DEFAULT_ROWND_SCHEMA, RESERVED_SESSION_CLAIMS } from "./constants";
import type {
  RowndAuthConfig,
  RowndPluginNormalisedConfig,
  RowndSchemaField,
  RowndSignInMethod,
  RowndSubBrandConfigInput,
  RowndPluginDynamicConfig,
  RowndConfigResolverContext,
} from "./types";
import { RowndConfigResolutionError } from "./errors";
import { logDebugMessage } from "./logger";
import { createDerivedUserContext } from "./utils";
import { isRecord } from "./utils";

let pluginConfig: RowndPluginNormalisedConfig | undefined;
let superTokensConfig: SuperTokensPublicConfig | undefined;
const RESOLVED_CONFIG = Symbol("rowndResolvedConfig");

type ResolvedDynamicConfig = Pick<
  RowndPluginNormalisedConfig,
  | "clientDomains"
  | "crossDeviceConfirmationBypass"
  | "schema"
  | "appConfig"
  | "subBrands"
  | "emailChange"
>;

type ResolvedConfigSnapshot = {
  tenantId: string | undefined;
  config: ResolvedDynamicConfig;
};

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

export function assertRowndAppVariantIsConfigured(
  config: RowndPluginNormalisedConfig,
  appVariantId?: string,
) {
  if (!appVariantId) {
    return;
  }

  if (config.subBrands && !config.subBrands[appVariantId]) {
    throw new Error(`Unknown Rownd app variant: ${appVariantId}`);
  }
}

function requireRecord(
  value: unknown,
  field: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Rownd dynamic config ${field} must be an object`);
  }
}

function validateAppConfig(value: unknown, field: string): void {
  requireRecord(value, field);
  const config = value as Record<string, unknown>;

  for (const key of [
    "branding",
    "auth",
    "legal",
    "profile",
    "customContent",
    "capabilities",
    "web",
    "bottomSheet",
  ]) {
    if (config[key] !== undefined) {
      requireRecord(config[key], `${field}.${key}`);
    }
  }

  const branding = config.branding;
  if (isRecord(branding)) {
    for (const key of ["customStyles", "customScripts"]) {
      if (branding[key] !== undefined && !Array.isArray(branding[key])) {
        throw new Error(
          `Rownd dynamic config ${field}.branding.${key} must be an array`,
        );
      }
      for (const [index, item] of (Array.isArray(branding[key])
        ? branding[key]
        : []
      ).entries()) {
        requireRecord(item, `${field}.branding.${key}[${index}]`);
        if (typeof item.content !== "string") {
          throw new Error(
            `Rownd dynamic config ${field}.branding.${key}[${index}].content must be a string`,
          );
        }
      }
    }
  }

  const auth = config.auth;
  if (isRecord(auth)) {
    if (auth.order !== undefined) {
      const authOrder = auth.order;
      requireRecord(authOrder, `${field}.auth.order`);
      for (const platform of ["default", "ios", "android"]) {
        const order = authOrder[platform];
        if (order !== undefined && !Array.isArray(order)) {
          throw new Error(
            `Rownd dynamic config ${field}.auth.order.${platform} must be an array`,
          );
        }
        for (const [index, item] of (Array.isArray(order)
          ? order
          : []
        ).entries()) {
          requireRecord(item, `${field}.auth.order.${platform}[${index}]`);
          if (
            (item.type !== "button" && item.type !== "input") ||
            typeof item.name !== "string"
          ) {
            throw new Error(
              `Rownd dynamic config ${field}.auth.order.${platform}[${index}] requires a supported type and string name`,
            );
          }
        }
      }
    }
    if (
      auth.additionalFields !== undefined &&
      !Array.isArray(auth.additionalFields)
    ) {
      throw new Error(
        `Rownd dynamic config ${field}.auth.additionalFields must be an array`,
      );
    }
    for (const [index, item] of (Array.isArray(auth.additionalFields)
      ? auth.additionalFields
      : []
    ).entries()) {
      requireRecord(item, `${field}.auth.additionalFields[${index}]`);
      if (
        typeof item.name !== "string" ||
        typeof item.type !== "string" ||
        typeof item.label !== "string" ||
        !Array.isArray(item.options)
      ) {
        throw new Error(
          `Rownd dynamic config ${field}.auth.additionalFields[${index}] is malformed`,
        );
      }
      for (const [optionIndex, option] of item.options.entries()) {
        requireRecord(
          option,
          `${field}.auth.additionalFields[${index}].options[${optionIndex}]`,
        );
        if (
          typeof option.value !== "string" ||
          typeof option.label !== "string"
        ) {
          throw new Error(
            `Rownd dynamic config ${field}.auth.additionalFields[${index}].options[${optionIndex}] requires string value and label`,
          );
        }
      }
    }
  }

  for (const key of ["allowedWebOrigins", "userVerificationFields"]) {
    const item = config[key];
    if (
      item !== undefined &&
      (!Array.isArray(item) || item.some((entry) => typeof entry !== "string"))
    ) {
      throw new Error(
        `Rownd dynamic config ${field}.${key} must be a string array`,
      );
    }
  }

  if (config.signInMethods !== undefined) {
    if (!Array.isArray(config.signInMethods)) {
      throw new Error(
        `Rownd dynamic config ${field}.signInMethods must be an array`,
      );
    }
    const methodIds = new Set<string>();
    for (const [index, method] of config.signInMethods.entries()) {
      requireRecord(method, `${field}.signInMethods[${index}]`);
      if (
        typeof method.method !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(method.method)
      ) {
        throw new Error(
          `Rownd dynamic config ${field}.signInMethods[${index}].method is unsupported`,
        );
      }
      if (methodIds.has(method.method)) {
        throw new Error(
          `Rownd dynamic config ${field}.signInMethods[${index}].method is duplicated`,
        );
      }
      methodIds.add(method.method);
      for (const property of ["displayName", "iconLightUrl", "iconDarkUrl"]) {
        if (
          method[property] !== undefined &&
          typeof method[property] !== "string"
        ) {
          throw new Error(
            `Rownd dynamic config ${field}.signInMethods[${index}].${property} must be a string`,
          );
        }
      }
      if (method.method === "anonymous") {
        if (
          method.type !== undefined &&
          method.type !== "guest" &&
          method.type !== "instant"
        ) {
          throw new Error(
            `Rownd dynamic config ${field}.signInMethods[${index}].type is unsupported`,
          );
        }
      }
      if (method.method === "apple") {
        for (const property of [
          "clientId",
          "webClientType",
          "iosClientType",
          "androidClientType",
        ]) {
          if (
            method[property] !== undefined &&
            typeof method[property] !== "string"
          ) {
            throw new Error(
              `Rownd dynamic config ${field}.signInMethods[${index}].${property} must be a string`,
            );
          }
        }
      }
      if (method.method === "google") {
        for (const property of ["clientId", "iosClientId"]) {
          if (
            method[property] !== undefined &&
            typeof method[property] !== "string"
          ) {
            throw new Error(
              `Rownd dynamic config ${field}.signInMethods[${index}].${property} must be a string`,
            );
          }
        }
        if (
          method.signInFasterWithGoogle !== undefined &&
          method.signInFasterWithGoogle !== "enabled" &&
          method.signInFasterWithGoogle !== "disabled"
        ) {
          throw new Error(
            `Rownd dynamic config ${field}.signInMethods[${index}].signInFasterWithGoogle is unsupported`,
          );
        }
        const scopes = method.scopes;
        if (
          scopes !== undefined &&
          (!Array.isArray(scopes) ||
            scopes.some((scope: unknown) => typeof scope !== "string"))
        ) {
          throw new Error(
            `Rownd dynamic config ${field}.signInMethods[${index}].scopes must be a string array`,
          );
        }
        if (method.oneTap !== undefined) {
          requireRecord(
            method.oneTap,
            `${field}.signInMethods[${index}].oneTap`,
          );
          for (const platform of ["browser", "mobileApp"]) {
            const platformConfig = method.oneTap[platform];
            if (platformConfig === undefined) continue;
            requireRecord(
              platformConfig,
              `${field}.signInMethods[${index}].oneTap.${platform}`,
            );
            if (
              platformConfig.autoPrompt !== undefined &&
              typeof platformConfig.autoPrompt !== "boolean"
            ) {
              throw new Error(
                `Rownd dynamic config ${field}.signInMethods[${index}].oneTap.${platform}.autoPrompt must be a boolean`,
              );
            }
            if (
              platformConfig.delay !== undefined &&
              (typeof platformConfig.delay !== "number" ||
                !Number.isFinite(platformConfig.delay) ||
                platformConfig.delay < 0)
            ) {
              throw new Error(
                `Rownd dynamic config ${field}.signInMethods[${index}].oneTap.${platform}.delay must be a non-negative number`,
              );
            }
          }
        }
      }
    }
  }
}

export function validateDynamicConfig(
  config: RowndPluginDynamicConfig,
  options: { rejectReservedSessionClaims?: boolean } = {},
) {
  requireRecord(config, "result");
  if (
    config.emailChange?.maxSessionAgeSeconds !== undefined &&
    (!Number.isFinite(config.emailChange.maxSessionAgeSeconds) ||
      config.emailChange.maxSessionAgeSeconds <= 0)
  ) {
    throw new Error(
      "emailChange.maxSessionAgeSeconds must be a positive number",
    );
  }
  for (const [key, value] of Object.entries(config.clientDomains ?? {})) {
    validateClientDomainUrl(key, value);
  }
  if (config.crossDeviceConfirmationBypass !== undefined) {
    requireRecord(
      config.crossDeviceConfirmationBypass,
      "crossDeviceConfirmationBypass",
    );
    if (
      !Array.isArray(
        config.crossDeviceConfirmationBypass.allowedRedirectPaths,
      ) ||
      config.crossDeviceConfirmationBypass.allowedRedirectPaths.some(
        (path) => typeof path !== "string",
      )
    ) {
      throw new Error(
        "Rownd dynamic config crossDeviceConfirmationBypass.allowedRedirectPaths must be a string array",
      );
    }
  }
  if (config.schema !== undefined) {
    requireRecord(config.schema, "schema");
    for (const [key, field] of Object.entries(config.schema)) {
      requireRecord(field, `schema.${key}`);
      if (
        typeof field.display_name !== "string" ||
        typeof field.type !== "string"
      ) {
        throw new Error(
          `Rownd dynamic config schema.${key} requires string display_name and type`,
        );
      }
      const claimName = field.session_claim_name ?? key;
      if (
        options.rejectReservedSessionClaims &&
        field.include_in_session_claims === true &&
        RESERVED_SESSION_CLAIMS.has(claimName)
      ) {
        throw new Error(
          `Rownd dynamic config schema.${key}.session_claim_name is reserved`,
        );
      }
    }
  }
  if (config.appConfig !== undefined) {
    validateAppConfig(config.appConfig, "appConfig");
  }
  if (config.subBrands !== undefined) {
    requireRecord(config.subBrands, "subBrands");
    for (const [key, subBrand] of Object.entries(config.subBrands)) {
      validateAppConfig(subBrand, `subBrands.${key}`);
      if (subBrand.variant !== undefined) {
        requireRecord(subBrand.variant, `subBrands.${key}.variant`);
        if (subBrand.variant.id !== key) {
          throw new Error(
            `Rownd dynamic config subBrands.${key}.variant.id must match its key`,
          );
        }
      }
    }
  }
}

function dynamicConfigFrom(
  config: RowndPluginNormalisedConfig,
): ResolvedDynamicConfig {
  return {
    clientDomains: config.clientDomains,
    crossDeviceConfirmationBypass: config.crossDeviceConfirmationBypass,
    schema: config.schema,
    appConfig: config.appConfig,
    subBrands: config.subBrands,
    emailChange: {
      maxSessionAgeSeconds: config.emailChange?.maxSessionAgeSeconds ?? 600,
    },
  };
}

function configWithSnapshot(
  config: RowndPluginNormalisedConfig,
  snapshot: ResolvedDynamicConfig,
): RowndPluginNormalisedConfig {
  return { ...config, ...snapshot };
}

export async function resolvePluginConfigSnapshot<
  T extends RowndConfigResolverContext["userContext"],
>(
  config: RowndPluginNormalisedConfig,
  context: Omit<RowndConfigResolverContext, "userContext"> & {
    userContext: T;
  },
) {
  const authoritativeTenantId =
    context.tenantId === undefined ? undefined : context.tenantId.trim();
  const requestedTenantId =
    context.request?.getKeyValueFromQuery("tenantId")?.trim() || undefined;
  if (
    authoritativeTenantId !== undefined &&
    requestedTenantId !== undefined &&
    requestedTenantId !== authoritativeTenantId
  ) {
    throw new RowndConfigResolutionError(
      new Error("Authoritative and requested tenant IDs do not match"),
    );
  }
  const tenantId = authoritativeTenantId ?? requestedTenantId;
  const existing = Reflect.get(context.userContext, RESOLVED_CONFIG) as
    ResolvedConfigSnapshot | undefined;
  if (existing !== undefined && existing.tenantId === tenantId) {
    return {
      config: configWithSnapshot(config, existing.config),
      userContext: context.userContext,
    };
  }

  let dynamicConfig: RowndPluginDynamicConfig;
  try {
    dynamicConfig = config.resolveConfig
      ? await config.resolveConfig({ ...context, tenantId })
      : {};
    validateDynamicConfig(dynamicConfig, { rejectReservedSessionClaims: true });
  } catch (error) {
    logDebugMessage(
      `Rownd configuration resolution failed: ${
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      }`,
    );
    throw new RowndConfigResolutionError(error);
  }
  const resolvedConfig: RowndPluginNormalisedConfig = {
    ...config,
    clientDomains: dynamicConfig.clientDomains ?? config.clientDomains,
    crossDeviceConfirmationBypass:
      dynamicConfig.crossDeviceConfirmationBypass ??
      config.crossDeviceConfirmationBypass,
    schema: dynamicConfig.schema ?? config.schema,
    appConfig: dynamicConfig.appConfig ?? config.appConfig,
    subBrands: dynamicConfig.subBrands ?? config.subBrands,
    emailChange: {
      maxSessionAgeSeconds:
        dynamicConfig.emailChange?.maxSessionAgeSeconds ??
        config.emailChange?.maxSessionAgeSeconds ??
        600,
    },
  };
  const userContext = createDerivedUserContext(context.userContext, {});
  Object.defineProperty(userContext, RESOLVED_CONFIG, {
    enumerable: false,
    value: {
      tenantId,
      config: dynamicConfigFrom(resolvedConfig),
    } satisfies ResolvedConfigSnapshot,
  });
  return { config: resolvedConfig, userContext };
}

export function getConfigForUserContext(userContext?: Record<string, unknown>) {
  const snapshot = userContext
    ? (Reflect.get(userContext, RESOLVED_CONFIG) as
        ResolvedConfigSnapshot | undefined)
    : undefined;
  return snapshot && pluginConfig
    ? configWithSnapshot(pluginConfig, snapshot.config)
    : pluginConfig;
}

function validateClientDomainUrl(key: string, value: string) {
  try {
    if (
      typeof value !== "string" ||
      !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)
    ) {
      throw new Error();
    }
    new URL(value);
  } catch {
    throw new Error(`Invalid clientDomains.${key} in plugin config`);
  }
}

export function isEmailSignInEnabled(
  config: RowndPluginNormalisedConfig,
  appVariantId?: string,
) {
  const methods =
    appVariantId && config.subBrands?.[appVariantId]?.signInMethods
      ? config.subBrands[appVariantId].signInMethods
      : config.appConfig?.signInMethods;
  return methods?.some((method) => method.method === "email") === true;
}

export function isExplicitSignUpFlowEnabled(
  config: RowndPluginNormalisedConfig,
  appVariantId?: string,
) {
  return (
    ((appVariantId
      ? config.subBrands?.[appVariantId]?.auth?.useExplicitSignUpFlow
      : undefined) ?? config.appConfig?.auth?.useExplicitSignUpFlow) === true
  );
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
        ? {
          sign_in_faster_with_google: getSignInFasterWithGoogle(googleMethod),
        }
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
        ? {
          web_client_type: getStringMethodProperty(
            appleMethod,
            "webClientType",
          ),
        }
        : {}),
      ...(getStringMethodProperty(appleMethod, "iosClientType") !== undefined
        ? {
          ios_client_type: getStringMethodProperty(
            appleMethod,
            "iosClientType",
          ),
        }
        : {}),
      ...(getStringMethodProperty(appleMethod, "androidClientType") !==
      undefined
        ? {
          android_client_type: getStringMethodProperty(
            appleMethod,
            "androidClientType",
          ),
        }
        : {}),
    },
    anonymous: {
      enabled: !!anonymousMethod && anonymousType !== "instant",
      ...(anonymousMethod && anonymousType !== "instant"
        ? { type: anonymousType }
        : {}),
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
    (method) =>
      method.method === "anonymous" && getAnonymousType(method) === "instant",
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
  if (
    isRecord(app) &&
    isRecord(app.variant) &&
    typeof app.variant.id === "string"
  ) {
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
    result[key] =
      isRecord(existing) && isRecord(value)
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
    ? subBrand &&
      mergeConfigInput(baseApp, subBrand as unknown as Record<string, unknown>)
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
            ...(branding.offsetX !== undefined
              ? { offset_x: branding.offsetX }
              : {}),
            ...(branding.offsetY !== undefined
              ? { offset_y: branding.offsetY }
              : {}),
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
            ...(auth.mobile
              ? { mobile: buildAuthMobileConfig(auth.mobile) }
              : {}),
            sign_in_methods: signInMethods,
            additional_fields: auth.additionalFields ?? [],
            ...(auth.enforceSameDevicePasswordlessSignIn !== undefined
              ? {
                enforce_same_device_passwordless_sign_in:
                    auth.enforceSameDevicePasswordlessSignIn,
              }
              : {}),
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
                    ? {
                      subtitle:
                            app.customContent.verificationModal.subtitle,
                    }
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
              ? {
                add_sign_in_methods_button:
                    app.profile.addSignInMethodsButton,
              }
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

import * as fs from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig, fetchWithRetry } from "./scriptUtils";
import {
  RowndAppConfigInput,
  RowndAuthConfig,
  RowndPluginConfig,
  RowndSchema,
  RowndSubBrandConfigInput,
  RowndSignInMethod,
} from "../src/types";

type RowndConfigObject = Record<string, unknown>;
type RowndSignInMethodConfig = {
  enabled?: boolean;
  client_id?: string;
  ios_client_id?: string;
  scopes?: string[];
  one_tap?: {
    browser?: {
      auto_prompt?: boolean;
      delay?: number;
    };
    mobile_app?: {
      auto_prompt?: boolean;
      delay?: number;
    };
  };
  display_name?: string;
  icon_light_url?: string;
  icon_dark_url?: string;
};

type RowndSchemaExportField = {
  display_name: string;
  type: string;
  user_visible: boolean;
  read_only?: boolean;
  show_empty?: boolean;
};

type RowndVariant = {
  id: string;
  name?: string;
  config?: RowndConfigObject;
};

function convertRowndConfigToPluginConfig(
  rowndApp: RowndConfigObject,
  creds: { appKey: string; appSecret: string },
): RowndPluginConfig & { _instructions?: string[] } {
  const config = getObject(rowndApp.config);
  const customizations = getObject(config.customizations);
  const hub = getObject(config.hub);
  const hubCustomizations = getObject(hub.customizations);
  const hubAuth = getObject(hub.auth);
  const legal = getObject(hub.legal);
  const customContent = getObject(hub.custom_content);
  const profile = getObject(hub.profile);

  const instructions: string[] = [];

  const authTokens = getObject(getObject(config.auth).access_tokens);
  if (authTokens.custom_claims) {
    instructions.push(
      "Custom claims were found in your Rownd configuration. Please follow the SuperTokens documentation to add custom claims to your access token payload: https://supertokens.com/docs/additional-verification/session-verification/claim-validation#1-add-custom-claims-to-the-access-token-payload",
    );
  }

  const appConfig: RowndAppConfigInput = {
    id: getString(rowndApp.id),
    name: getString(rowndApp.name),
    icon: getString(rowndApp.icon),
    branding: {
      primaryColor: getString(customizations.primary_color),
      primaryColorDarkMode: getString(
        hubCustomizations.primary_color_dark_mode,
      ),
      logo: getString(customizations.logo),
      logoDarkMode: getString(customizations.logo_dark_mode),
      roundedCorners: getBoolean(hubCustomizations.rounded_corners),
      containerBorderRadius: getNumber(
        hubCustomizations.container_border_radius,
      ),
      placement: getString(hubCustomizations.placement),
      visualSwoops: getBoolean(hubCustomizations.visual_swoops),
      blurBackground: getBoolean(hubCustomizations.blur_background),
      darkMode: parseDarkMode(hubCustomizations.dark_mode),
      showAppIcon: getBoolean(hubAuth.show_app_icon),
      customStyles: parseCustomStyles(hub.custom_styles),
    },
    legal: {
      companyName: getString(legal.company_name),
      privacyPolicyUrl: getString(legal.privacy_policy_url),
      termsConditionsUrl: getString(legal.terms_conditions_url),
      supportEmail: getString(legal.support_email),
    },
    customContent: {
      signInModal: isRecord(customContent.sign_in_modal)
        ? {
          title: getString(customContent.sign_in_modal.title),
          subtitle: getString(customContent.sign_in_modal.subtitle),
          signInTitle: getString(customContent.sign_in_modal.sign_in_title),
          signUpTitle: getString(customContent.sign_in_modal.sign_up_title),
          signInSubtitle: getString(
            customContent.sign_in_modal.sign_in_subtitle,
          ),
          signUpSubtitle: getString(
            customContent.sign_in_modal.sign_up_subtitle,
          ),
        }
        : undefined,
      profileModal: isRecord(customContent.profile_modal)
        ? { title: getString(customContent.profile_modal.title) }
        : undefined,
      signInFailureModal: isRecord(customContent.sign_in_failure_modal)
        ? {
          failureMessage: getString(
            customContent.sign_in_failure_modal.failure_message,
          ),
        }
        : undefined,
    },
    profile: {
      accountInformation: getObject(profile.account_information),
      personalInformation: getObject(profile.personal_information),
      preferences: getObject(profile.preferences),
      signOutButton: getObject(profile.sign_out_button),
      deleteAccountButton: getObject(profile.delete_account_button),
    },
    auth: {
      additionalFields: parseAdditionalFields(hubAuth.additional_fields),
      rememberSignInMethod: getBoolean(hubAuth.remember_sign_in_method),
      useExplicitSignUpFlow: getBoolean(hubAuth.use_explicit_sign_up_flow),
      primarySignUpMethod: getString(hubAuth.primary_sign_up_method),
      preferredMethod: getString(hubAuth.preferred_method),
      order: parseAuthOrder(hubAuth.order),
    },
    signInMethods: (() => {
      const methods = getObject(hubAuth.sign_in_methods) as Record<
        string,
        RowndSignInMethodConfig
      >;
      const result: RowndSignInMethod[] = [];

      for (const [key, value] of Object.entries(methods)) {
        if (!value || !value.enabled) continue;

        if (key === "google") {
          result.push({
            method: "google",
            clientId: value.client_id,
            iosClientId: value.ios_client_id,
            scopes: value.scopes,
            oneTap: value.one_tap
              ? {
                browser: value.one_tap.browser
                  ? {
                    autoPrompt: value.one_tap.browser.auto_prompt,
                    delay: value.one_tap.browser.delay,
                  }
                  : undefined,
                mobileApp: value.one_tap.mobile_app
                  ? {
                    autoPrompt: value.one_tap.mobile_app.auto_prompt,
                    delay: value.one_tap.mobile_app.delay,
                  }
                  : undefined,
              }
              : undefined,
          });
          instructions.push(
            "Google sign-in was enabled. Please ensure you configure the \"google\" provider in your SuperTokens ThirdParty recipe. You will need to manually provide the Google 'clientSecret' as Rownd cannot export it.",
          );
        } else if (key === "apple") {
          result.push({
            method: "apple",
            clientId: value.client_id,
          });
          instructions.push(
            "Apple sign-in was enabled. Please ensure you configure the \"apple\" provider in your SuperTokens ThirdParty recipe. You will need to manually provide the Apple 'clientSecret' (or private key) as Rownd cannot export it.",
          );
        } else if (key === "email" || key === "phone") {
          result.push({ method: key as "email" | "phone" });
          instructions.push(
            `${key} sign-in was enabled. Please ensure you configure the SuperTokens Passwordless recipe with the appropriate contactMethod.`,
          );
        } else if (key === "anonymous") {
          result.push({
            method: "anonymous",
            displayName: value.display_name,
            iconLightUrl: value.icon_light_url,
            iconDarkUrl: value.icon_dark_url,
          });
        } else {
          result.push({
            method: key,
            displayName: value.display_name,
            iconLightUrl: value.icon_light_url,
            iconDarkUrl: value.icon_dark_url,
          });
          instructions.push(
            `Custom provider '${key}' was enabled. Please ensure you configure this provider in your SuperTokens ThirdParty recipe. You will need to manually provide the 'clientSecret' as Rownd cannot export it.`,
          );
        }
      }
      return result;
    })(),
  };

  const cleanSchema: RowndSchema = {};
  if (isRecord(rowndApp.schema)) {
    for (const [key, field] of Object.entries(
      rowndApp.schema as Record<string, RowndSchemaExportField>,
    )) {
      cleanSchema[key] = {
        display_name: field.display_name,
        type: field.type,
        user_visible: field.user_visible,
        read_only: field.read_only,
        show_empty: field.show_empty,
      };
      // Drop undefined properties
      const schemaField = cleanSchema[key];
      if (schemaField) {
        for (const fieldKey of Object.keys(schemaField) as Array<
          keyof RowndSchemaExportField
        >) {
          if (schemaField[fieldKey] === undefined) {
            delete schemaField[fieldKey];
          }
        }
      }
    }
  }

  // Ensure undefined fields are dropped so JSON.stringify is clean
  const cleanAppConfig = JSON.parse(JSON.stringify(appConfig));

  return {
    rowndAppKey: creds.appKey,
    rowndAppSecret: creds.appSecret,
    schema: cleanSchema,
    appConfig: cleanAppConfig,
    ...(instructions.length > 0 ? { _instructions: instructions } : {}),
  };
}

function mergeRowndAppWithVariant(
  rowndApp: RowndConfigObject,
  variant: RowndVariant,
): RowndConfigObject {
  return deepMerge(rowndApp, {
    name: variant.name,
    config: variant.config,
  });
}

function deepMerge<T extends RowndConfigObject>(
  base: T,
  overlay: RowndConfigObject,
): T {
  const result: RowndConfigObject = { ...base };

  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) {
      continue;
    }

    const existingValue = result[key];
    if (isRecord(existingValue) && isRecord(value)) {
      result[key] = deepMerge(existingValue, value);
    } else {
      result[key] = value;
    }
  }

  return result as T;
}

async function fetchRowndVariants(
  config: Awaited<ReturnType<typeof loadConfig>>,
) {
  const url = new URL(
    `/api/applications/${config.rownd.appId}/variants`,
    "https://app.rownd.io",
  );

  console.log(`Fetching Rownd sub-brands for app_id: ${config.rownd.appId}...`);

  const response = await fetchWithRetry({
    url: url.toString(),
    requestInit: {
      headers: {
        "x-rownd-app-key": config.rownd.appKey,
        "x-rownd-app-secret": config.rownd.appSecret,
      },
    },
    retryConfig: config.retry,
    operation: "Fetching Rownd sub-brands",
  });

  if (!response.ok) {
    throw new Error(
      `Rownd variants API error: ${response.status} ${await response.text()}`,
    );
  }

  const rawVariants = await response.json();
  const variants = Array.isArray(rawVariants)
    ? rawVariants
    : isRecord(rawVariants) && Array.isArray(rawVariants.results)
      ? rawVariants.results
      : [];

  return variants.flatMap((variant): RowndVariant[] => {
    if (!isRecord(variant) || typeof variant.id !== "string") {
      return [];
    }

    return [
      {
        id: variant.id,
        name: getString(variant.name),
        config: getObject(variant.config),
      },
    ];
  });
}

function getObject(value: unknown): RowndConfigObject {
  return isRecord(value) ? value : {};
}

function getString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function getBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function getNumber(value: unknown) {
  return typeof value === "number" ? value : undefined;
}

function parseDarkMode(value: unknown) {
  return value === "auto" || value === "light" || value === "dark"
    ? value
    : undefined;
}

function parseCustomStyles(value: unknown) {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.content !== "string") {
      return [];
    }

    return [{ content: entry.content }];
  });
}

function parseAdditionalFields(
  value: unknown,
): RowndAuthConfig["additionalFields"] {
  return Array.isArray(value)
    ? (value as RowndAuthConfig["additionalFields"])
    : undefined;
}

function parseAuthOrder(value: unknown): RowndAuthConfig["order"] {
  return isRecord(value) ? (value as RowndAuthConfig["order"]) : undefined;
}

function isRecord(value: unknown): value is RowndConfigObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function run() {
  const config = await loadConfig();

  if (!config.rownd.appId || !config.rownd.appKey || !config.rownd.appSecret) {
    throw new Error(
      "Missing rownd.appId, rownd.appKey, or rownd.appSecret in config.yaml",
    );
  }

  const url = new URL("/hub/app-config", "https://api.rownd.io");
  url.searchParams.set("app_id", config.rownd.appId);

  console.log(`Fetching Rownd app config for app_id: ${config.rownd.appId}...`);

  const response = await fetchWithRetry({
    url: url.toString(),
    requestInit: {
      headers: {
        "x-rownd-app-key": config.rownd.appKey,
        "x-rownd-app-secret": config.rownd.appSecret,
      },
    },
    retryConfig: config.retry,
    operation: "Fetching Rownd App Config",
  });

  if (!response.ok) {
    throw new Error(
      `Rownd API error: ${response.status} ${await response.text()}`,
    );
  }

  const rawConfig = await response.json();
  if (!isRecord(rawConfig) || !isRecord(rawConfig.app)) {
    throw new Error("Rownd API response is missing the 'app' property.");
  }

  const pluginConfig = convertRowndConfigToPluginConfig(rawConfig.app, {
    appKey: config.rownd.appKey,
    appSecret: config.rownd.appSecret,
  });

  const variants = await fetchRowndVariants(config);
  const subBrands: Record<string, RowndSubBrandConfigInput> = {};
  for (const variant of variants) {
    const variantPluginConfig = convertRowndConfigToPluginConfig(
      mergeRowndAppWithVariant(rawConfig.app, variant),
      {
        appKey: config.rownd.appKey,
        appSecret: config.rownd.appSecret,
      },
    );

    if (!variantPluginConfig.appConfig) {
      continue;
    }

    subBrands[variant.id] = {
      ...variantPluginConfig.appConfig,
      variant: {
        id: variant.id,
        name: variant.name,
        config: variant.config as RowndSubBrandConfigInput["variant"]["config"],
      },
    };

    if (variantPluginConfig._instructions) {
      pluginConfig._instructions = [
        ...(pluginConfig._instructions ?? []),
        ...variantPluginConfig._instructions.map(
          (instruction) => `Sub-brand ${variant.id}: ${instruction}`,
        ),
      ];
    }
  }

  if (Object.keys(subBrands).length > 0) {
    pluginConfig.subBrands = subBrands;
  }

  if (pluginConfig._instructions) {
    console.warn("\n=== IMPORTANT INSTRUCTIONS ===");
    pluginConfig._instructions.forEach((inst) => console.warn(`- ${inst}`));
    console.warn("==============================\n");
  }

  delete pluginConfig._instructions;

  const outputPath = resolve(process.cwd(), "rownd-plugin-config.json");
  await fs.writeFile(outputPath, JSON.stringify(pluginConfig, null, 2), "utf8");

  console.log(`Successfully generated config and saved to ${outputPath}`);
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

import * as fs from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig, fetchWithRetry } from "./scriptUtils";
import {
  RowndAppConfigInput,
  RowndPluginConfig,
  RowndSignInMethod,
} from "../src/types";

// Helper to convert snake_case to camelCase where needed
function convertRowndConfigToPluginConfig(
  rowndApp: any,
  creds: { appKey: string; appSecret: string },
): RowndPluginConfig & { _instructions?: string[] } {
  const config = rowndApp.config || {};
  const customizations = config.customizations || {};
  const hub = config.hub || {};
  const hubCustomizations = hub.customizations || {};
  const hubAuth = hub.auth || {};
  const legal = hub.legal || {};
  const customContent = hub.custom_content || {};
  const profile = hub.profile || {};

  const instructions: string[] = [];

  const authTokens = config.auth?.access_tokens || {};
  if (authTokens.custom_claims) {
    instructions.push(
      "Custom claims were found in your Rownd configuration. Please follow the SuperTokens documentation to add custom claims to your access token payload: https://supertokens.com/docs/additional-verification/session-verification/claim-validation#1-add-custom-claims-to-the-access-token-payload",
    );
  }

  const appConfig: RowndAppConfigInput = {
    id: rowndApp.id,
    name: rowndApp.name,
    icon: rowndApp.icon,
    branding: {
      primaryColor: customizations.primary_color,
      primaryColorDarkMode: hubCustomizations.primary_color_dark_mode,
      logo: customizations.logo,
      logoDarkMode: customizations.logo_dark_mode,
      roundedCorners: hubCustomizations.rounded_corners,
      containerBorderRadius: hubCustomizations.container_border_radius,
      placement: hubCustomizations.placement,
      visualSwoops: hubCustomizations.visual_swoops,
      blurBackground: hubCustomizations.blur_background,
      darkMode: hubCustomizations.dark_mode,
      showAppIcon: hubAuth.show_app_icon,
      customStyles: hub.custom_styles,
    },
    legal: {
      companyName: legal.company_name,
      privacyPolicyUrl: legal.privacy_policy_url,
      termsConditionsUrl: legal.terms_conditions_url,
      supportEmail: legal.support_email,
    },
    customContent: {
      signInModal: customContent.sign_in_modal
        ? {
            title: customContent.sign_in_modal.title,
            subtitle: customContent.sign_in_modal.subtitle,
            signInTitle: customContent.sign_in_modal.sign_in_title,
            signUpTitle: customContent.sign_in_modal.sign_up_title,
            signInSubtitle: customContent.sign_in_modal.sign_in_subtitle,
            signUpSubtitle: customContent.sign_in_modal.sign_up_subtitle,
          }
        : undefined,
      profileModal: customContent.profile_modal,
      signInFailureModal: customContent.sign_in_failure_modal
        ? {
            failureMessage: customContent.sign_in_failure_modal.failure_message,
          }
        : undefined,
    },
    profile: {
      accountInformation: profile.account_information,
      personalInformation: profile.personal_information,
      preferences: profile.preferences,
      signOutButton: profile.sign_out_button,
      deleteAccountButton: profile.delete_account_button,
    },
    auth: {
      additionalFields: hubAuth.additional_fields,
      rememberSignInMethod: hubAuth.remember_sign_in_method,
      useExplicitSignUpFlow: hubAuth.use_explicit_sign_up_flow,
      primarySignUpMethod: hubAuth.primary_sign_up_method,
      preferredMethod: hubAuth.preferred_method,
      order: hubAuth.order,
    },
    signInMethods: (() => {
      const methods = hubAuth.sign_in_methods || {};
      const result: RowndSignInMethod[] = [];

      for (const [key, value] of Object.entries<any>(methods)) {
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
            `Google sign-in was enabled. Please ensure you configure the "google" provider in your SuperTokens ThirdParty recipe. You will need to manually provide the Google 'clientSecret' as Rownd cannot export it.`,
          );
        } else if (key === "apple") {
          result.push({
            method: "apple",
            clientId: value.client_id,
          });
          instructions.push(
            `Apple sign-in was enabled. Please ensure you configure the "apple" provider in your SuperTokens ThirdParty recipe. You will need to manually provide the Apple 'clientSecret' (or private key) as Rownd cannot export it.`,
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
          // custom providers
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

  const cleanSchema: Record<string, any> = {};
  if (rowndApp.schema) {
    for (const [key, field] of Object.entries<any>(rowndApp.schema)) {
      cleanSchema[key] = {
        display_name: field.display_name,
        type: field.type,
        user_visible: field.user_visible,
        read_only: field.read_only,
        show_empty: field.show_empty,
      };
      // Drop undefined properties
      Object.keys(cleanSchema[key]).forEach(
        (k) => cleanSchema[key][k] === undefined && delete cleanSchema[key][k],
      );
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
  if (!rawConfig.app) {
    throw new Error("Rownd API response is missing the 'app' property.");
  }

  const pluginConfig = convertRowndConfigToPluginConfig(rawConfig.app, {
    appKey: config.rownd.appKey,
    appSecret: config.rownd.appSecret,
  });

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

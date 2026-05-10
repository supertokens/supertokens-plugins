import * as fs from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig, fetchWithRetry } from "./scriptUtils";
import { RowndAppConfigInput, RowndPluginConfig } from "../src/types";

// Helper to convert snake_case to camelCase where needed
function convertRowndConfigToPluginConfig(rowndApp: any): Partial<RowndPluginConfig> & { _instructions?: string[] } {
  const config = rowndApp.config || {};
  const customizations = config.customizations || {};
  const hub = config.hub || {};
  const hubCustomizations = hub.customizations || {};
  const hubAuth = hub.auth || {};
  const legal = hub.legal || {};
  const customContent = hub.custom_content || {};
  const profile = hub.profile || {};

  const instructions: string[] = [];

  const appConfig: RowndAppConfigInput = {
    id: rowndApp.id,
    name: rowndApp.name,
    icon: rowndApp.icon,
    branding: {
      primaryColor: customizations.primary_color,
      logo: customizations.logo,
      logoDarkMode: customizations.logo_dark_mode,
      roundedCorners: hubCustomizations.rounded_corners,
      visualSwoops: hubCustomizations.visual_swoops,
      blurBackground: hubCustomizations.blur_background,
      darkMode: hubCustomizations.dark_mode,
      showAppIcon: hubAuth.show_app_icon,
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
      const result: Record<string, any> = {};
      
      for (const [key, value] of Object.entries<any>(methods)) {
        if (!value) continue;
        
        if (key === "google") {
          result.google = {
            iosClientId: value.ios_client_id,
            oneTap: value.one_tap,
          };
          if (value.enabled) {
            instructions.push(
              `Google sign-in was enabled. Please ensure you configure the "google" provider in your SuperTokens ThirdParty recipe. You will need to manually provide the Google 'clientSecret' as Rownd cannot export it.`
            );
          }
        } else if (key === "apple") {
          if (value.enabled) {
            instructions.push(
              `Apple sign-in was enabled. Please ensure you configure the "apple" provider in your SuperTokens ThirdParty recipe. You will need to manually provide the Apple 'clientSecret' (or private key) as Rownd cannot export it.`
            );
          }
        } else if (key === "email" || key === "phone") {
          if (value.enabled) {
            instructions.push(
              `${key} sign-in was enabled. Please ensure you configure the SuperTokens Passwordless recipe with the appropriate contactMethod.`
            );
          }
        } else if (key === "anonymous") {
          result.anonymous = {
            enabled: value.enabled,
            displayName: value.display_name,
            iconLightUrl: value.icon_light_url,
            iconDarkUrl: value.icon_dark_url,
          };
        } else {
          // custom providers
          result[key] = {
            enabled: value.enabled,
            displayName: value.display_name,
            iconLightUrl: value.icon_light_url,
            iconDarkUrl: value.icon_dark_url,
          };
          if (value.enabled) {
             instructions.push(
               `Custom provider '${key}' was enabled. Please ensure you configure this provider in your SuperTokens ThirdParty recipe. You will need to manually provide the 'clientSecret' as Rownd cannot export it.`
             );
          }
        }
      }
      return result;
    })(),
  };

  // Ensure undefined fields are dropped so JSON.stringify is clean
  const cleanAppConfig = JSON.parse(JSON.stringify(appConfig));

  return {
    ...(instructions.length > 0 ? { _instructions: instructions } : {}),
    schema: rowndApp.schema,
    appConfig: cleanAppConfig,
  };
}

async function run() {
  const config = await loadConfig();

  if (!config.rownd.appId || !config.rownd.appKey || !config.rownd.appSecret) {
    throw new Error("Missing rownd.appId, rownd.appKey, or rownd.appSecret in config.yaml");
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
    throw new Error(`Rownd API error: ${response.status} ${await response.text()}`);
  }

  const rawConfig = await response.json();
  if (!rawConfig.app) {
    throw new Error("Rownd API response is missing the 'app' property.");
  }

  const pluginConfig = convertRowndConfigToPluginConfig(rawConfig.app);

  if (pluginConfig._instructions) {
    console.warn("\n=== IMPORTANT INSTRUCTIONS ===");
    pluginConfig._instructions.forEach(inst => console.warn(`- ${inst}`));
    console.warn("==============================\n");
  }

  const outputPath = resolve(process.cwd(), "rownd-plugin-config.json");
  await fs.writeFile(outputPath, JSON.stringify(pluginConfig, null, 2), "utf8");

  console.log(`Successfully generated config and saved to ${outputPath}`);
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

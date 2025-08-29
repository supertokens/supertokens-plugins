import { createPluginInitFunction } from "@shared/js";
import { buildContext, getQuerier } from "@shared/react";
import { useLayoutEffect } from "react";
import {
  SuperTokensPlugin,
  SuperTokensPublicConfig,
  SuperTokensPublicPlugin,
  getTranslationFunction,
} from "supertokens-auth-react";
import { AuthComponentProps } from "supertokens-auth-react/lib/build/types";
import { EmailPasswordPreBuiltUI } from "supertokens-auth-react/recipe/emailpassword/prebuiltui";

import { getApi } from "./api";
import { PLUGIN_ID, API_PATH } from "./constants";
import { enableDebugLogs } from "./logger";
import { SelectTenantPage } from "./pages";
import { getOverrideableTenantFunctionImplementation } from "./recipeImplementation";
import { defaultTranslationsTenantDiscovery } from "./translations";
import {
  OverrideableTenantFunctionImplementation,
  SuperTokensPluginTenantDiscoveryPluginConfig,
  SuperTokensPluginTenantDiscoveryPluginNormalisedConfig,
  TranslationKeys,
} from "./types";
import { hidePasswordInput, parseTenantId, populateEmailFromUrl, updateSignInSubmitBtn } from "./util";

const { usePluginContext, setContext } = buildContext<{
  plugins: SuperTokensPublicPlugin[];
  sdkVersion: string;
  appConfig: SuperTokensPublicConfig;
  pluginConfig: SuperTokensPluginTenantDiscoveryPluginNormalisedConfig;
  querier: ReturnType<typeof getQuerier>;
  api: ReturnType<typeof getApi>;
  t: (key: TranslationKeys) => string;
}>();
export { usePluginContext };

export const init = createPluginInitFunction<
  SuperTokensPlugin,
  SuperTokensPluginTenantDiscoveryPluginConfig,
  OverrideableTenantFunctionImplementation,
  SuperTokensPluginTenantDiscoveryPluginNormalisedConfig
>(
  (pluginConfig, implementation) => {
    let apiBasePath: string;
    let translations: ReturnType<typeof getTranslationFunction<TranslationKeys>>;
    return {
      id: PLUGIN_ID,
      init: async (config, plugins, sdkVersion) => {
        if (config.enableDebugLogs) {
          enableDebugLogs();
        }

        const querier = getQuerier(new URL(API_PATH, config.appInfo.apiDomain.getAsStringDangerous()).toString());
        const api = getApi(querier);

        // Set up the usePlugin hook
        apiBasePath = new URL(API_PATH, config.appInfo.apiDomain.getAsStringDangerous()).toString();
        translations = getTranslationFunction<TranslationKeys>(defaultTranslationsTenantDiscovery);

        setContext({
          plugins,
          sdkVersion,
          appConfig: config,
          pluginConfig,
          querier,
          api,
          t: translations,
        });

        // Check if the url matches any tenantId and accordingly
        // set the tenantId in the url and refresh the page.
        const tenantId = await implementation.determineTenantFromURL();
        if (tenantId) {
          implementation.setTenantId(tenantId);
          return;
        }

        // If the tenant was not determined from the URL and
        // tenant selector is enabled, we will redirect to the
        // select tenant page.
        const { shouldShowSelector } = parseTenantId();
        if (shouldShowSelector && pluginConfig.showTenantSelector && window.location.pathname !== "/select-tenant") {
          window.location.href = "/select-tenant";
        }
      },
      routeHandlers: (appConfig: any, plugins: any, sdkVersion: any) => {
        return {
          status: "OK",
          routeHandlers: [
            {
              path: "/select-tenant",
              handler: () => SelectTenantPage.call(null),
            },
          ],
        };
      },
      overrideMap: {
        emailpassword: {
          recipeInitRequired: true,
          functions: (originalImplementation, builder) => {
            return {
              ...originalImplementation,
              signIn: async (input) => {
                // If the `tenantId` is set, then we need to
                // call the original implementation.
                const { shouldShowSelector } = input.userContext;

                // If we are showing the selector, we need to parse the tenantId
                // else return the original response.
                if (!shouldShowSelector) {
                  return originalImplementation.signIn(input);
                }

                // If the selector is showing up, we will make a call to
                // determine the tenant from email instead.

                // Extract the email from fromFields
                const email = input.formFields.find((field) => field.id === "email")?.value;

                // Very unlikely that email will be undefined at this stage
                // but we will throw an error regardless
                if (!email) {
                  throw new Error("Email is undefined, should never come here");
                }

                const querier = getQuerier(apiBasePath);
                const response = await querier.post<
                  { status: "OK"; tenant: string } | { status: "ERROR"; message: string }
                >(
                  "/from-email",
                  {
                    email,
                  },
                  {
                    withSession: false,
                  },
                );

                if (response.status !== "OK") {
                  // Should never happens since we are passing the email
                  // but handle regardless
                  throw new Error("Should never come here");
                }

                const tenantId = response.tenant;
                const formFields = input.formFields;

                if (formFields.length < 1) {
                  // Very unlikely since we are setting the field above
                  // but we should still handle.
                  throw new Error("Should never come here");
                }
                const tenantValueEntered = formFields[0]?.value;

                // Set the tenantId in the current URL and refresh the page
                implementation.setTenantId(tenantId, tenantValueEntered);

                // return a SIGN_IN_NOT_ALLOWED error
                // if the code reached this point.
                // though it should not since we refresh the page right after the tenant
                // is set.
                return {
                  status: "SIGN_IN_NOT_ALLOWED",
                  fetchResponse: new Response(),
                  reason: "Tenant discovery plugin overridden method",
                };
              },
            };
          },
        },
      },
      generalAuthRecipeComponentOverrides: {
        AuthPageHeader_Override: ({ DefaultComponent, ...props }) => {
          const { shouldShowSelector } = parseTenantId();

          if (shouldShowSelector) {
            // eslint-disable-next-line react/jsx-no-literals
            return <div>Enter email to continue</div>;
          }

          // @ts-ignore
          return <DefaultComponent {...props} />;
        },
        AuthPageComponentList_Override: ({ DefaultComponent, ...props }) => {
          const { shouldShowSelector } = parseTenantId();

          // Update the auth component list to only keep email if we are showing
          // the selector.
          if (shouldShowSelector) {
            const emailPasswordSignInComponent = EmailPasswordPreBuiltUI.getInstanceOrInitAndGetInstance()
              .getAuthComponents()
              .find((comp) => comp.type === "SIGN_IN");

            // Unlikely that component will be undefined but still handle
            // the case.
            if (!emailPasswordSignInComponent) {
              throw new Error("Should never come here");
            }

            // Fix type error by ensuring the component matches expected type
            props.authComponents = [emailPasswordSignInComponent.component as React.FC<AuthComponentProps>];

            // Set the formField to hide the password field
            props.factorIds = ["emailpassword"];

            props.userContext = {
              ...props.userContext,
              shouldShowSelector: true,
            };
          }

          useLayoutEffect(() => {
            if (shouldShowSelector) {
              hidePasswordInput();
              updateSignInSubmitBtn(translations("PL_TD_EMAIL_DISCOVERY_CONTINUE_BUTTON"));
            }

            // Try to populate the email if it is present
            // in the URL.
            populateEmailFromUrl();
          }, [shouldShowSelector]);

          // @ts-ignore
          return <DefaultComponent {...props} />;
        },
      },
    };
  },
  (config) => getOverrideableTenantFunctionImplementation(config),
  (pluginConfig) => ({
    showTenantSelector: pluginConfig.showTenantSelector ?? false,
    extractTenantIdFromDomain: pluginConfig.extractTenantIdFromDomain ?? true,
  }),
);

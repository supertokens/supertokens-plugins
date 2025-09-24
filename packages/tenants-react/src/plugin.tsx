import { createPluginInitFunction } from "@shared/js";
import { buildContext, getQuerier } from "@shared/react";
import {
  getTranslationFunction,
  SuperTokensPlugin,
  SuperTokensPublicConfig,
  SuperTokensPublicPlugin,
} from "supertokens-auth-react";
import { BooleanClaim } from "supertokens-auth-react/recipe/session";

import { getApi } from "./api";
import { API_PATH, PLUGIN_ID } from "./constants";
import "./styles/global.css";
import { InvitationAcceptWrapper } from "./invitation-accept-wrapper";
import { enableDebugLogs } from "./logger";
import { TenantManagement } from "./pages/tenant-management/tenant-management";
import { SelectTenantPage } from "./select-tenant-page";
import { defaultTranslationsTenants } from "./translations";
import {
  SuperTokensPluginTenantsPluginConfig,
  SuperTokensPluginTenantsPluginNormalisedConfig,
  TranslationKeys,
} from "./types";

const { usePluginContext, setContext } = buildContext<{
  plugins: SuperTokensPublicPlugin[];
  sdkVersion: string;
  appConfig: SuperTokensPublicConfig;
  pluginConfig: SuperTokensPluginTenantsPluginNormalisedConfig;
  querier: ReturnType<typeof getQuerier>;
  api: ReturnType<typeof getApi>;
  t: (key: TranslationKeys) => string;
}>();
export { usePluginContext };

export const init = createPluginInitFunction<
  SuperTokensPlugin,
  SuperTokensPluginTenantsPluginConfig,
  undefined,
  SuperTokensPluginTenantsPluginNormalisedConfig
>(
  (pluginConfig) => {
    const MultipleTenantsPresentClaim = new BooleanClaim({
      id: `${PLUGIN_ID}-multiple-tenants-present`,
      refresh: async () => {},
      onFailureRedirection: async ({ reason }) => {
        return "/user/tenants/select";
      },
    });

    // TODO: Update this to parse it from the exports of that
    // plugin so that we don't have to depend on that plugin.
    // Essentially, if that plugin is enabled, only then we need to use
    // the ID.
    const PROGRESSIVE_PROFILING_COMPLETED_CLAIM_ID = "some-id";

    const extractCodeAndTenantId = (url: string) => {
      const urlParams = new URLSearchParams(url);
      const code = urlParams.get("code");
      const tenantId = urlParams.get("tenantId");
      return { code, tenantId, shouldAcceptInvite: Boolean(code) && Boolean(tenantId) };
    };

    const extractAndInjectCodeAndTenantId = (context: any) => {
      const { code, tenantId, shouldAcceptInvite } = extractCodeAndTenantId(context.url);

      if (!shouldAcceptInvite) {
        return {
          requestInit: context.requestInit,
          url: context.url,
        };
      }

      let requestInit = context.requestInit;
      let body = context.requestInit.body;
      if (body !== undefined) {
        let bodyJson = JSON.parse(body as string);
        bodyJson.code = code;
        bodyJson.tenantId = tenantId;
        requestInit.body = JSON.stringify(bodyJson);
      }

      return {
        requestInit,
        url: context.url,
      };
    };

    let translations: ReturnType<typeof getTranslationFunction<TranslationKeys>>;

    return {
      id: PLUGIN_ID,
      init: (config, plugins, sdkVersion) => {
        if (config.enableDebugLogs) {
          enableDebugLogs();
        }

        const baseProfilePlugin = plugins.find((plugin: any) => plugin.id === "supertokens-plugin-profile-base");
        if (!baseProfilePlugin) {
          console.warn("Base profile plugin not found. Not adding common details profile plugin.");
          return;
        }

        if (!baseProfilePlugin.exports) {
          console.warn("Base profile plugin does not export anything. Not adding common details profile plugin.");
          return;
        }

        const registerSection = baseProfilePlugin.exports?.registerSection;
        if (!registerSection) {
          console.warn(
            "Base profile plugin does not export registerSection. Not adding common details profile plugin.",
          );
          return;
        }

        registerSection(async () => ({
          id: "tenant-management",
          title: "Tenants",
          order: 1,
          component: () =>
            TenantManagement.call(null, {
              section: {
                id: "tenant-management",
                label: "Tenant Management",
                description: "Manage users and invitations for your tenants",
                fields: [],
              },
            }),
        }));

        const querier = getQuerier(new URL(API_PATH, config.appInfo.apiDomain.getAsStringDangerous()).toString());
        const api = getApi(querier);
        translations = getTranslationFunction<TranslationKeys>(defaultTranslationsTenants);

        setContext({
          plugins,
          sdkVersion,
          appConfig: config,
          pluginConfig,
          querier,
          api,
          t: translations,
        });
      },
      routeHandlers: (appConfig: any, plugins: any, sdkVersion: any) => {
        return {
          status: "OK",
          routeHandlers: [
            {
              path: "/user/tenants/create",
              handler: () => SelectTenantPage.call(null),
            },
            {
              path: "/user/invite/accept",
              handler: () => InvitationAcceptWrapper.call(null),
            },
          ],
        };
      },
      overrideMap: {
        session: {
          functions: (originalImplementation) => {
            return {
              ...originalImplementation,
              getGlobalClaimValidators(input) {
                // If the profile claim is present, make sure the tenant
                // one is added after it.
                const profileClaimValidators = input.claimValidatorsAddedByOtherRecipes.filter(
                  (validator) => validator.id === PROGRESSIVE_PROFILING_COMPLETED_CLAIM_ID,
                );
                const otherClaimValidators = input.claimValidatorsAddedByOtherRecipes.filter(
                  (validator) => validator.id !== PROGRESSIVE_PROFILING_COMPLETED_CLAIM_ID,
                );

                const claimValidators = [
                  ...otherClaimValidators,
                  ...profileClaimValidators,
                  ...(pluginConfig.requireTenantCreation ? [MultipleTenantsPresentClaim.validators.isTrue()] : []),
                ];

                return claimValidators;
              },
            };
          },
        },
        emailpassword: {
          config: (config) => ({
            ...config,
            preAPIHook: async (context) => {
              if (context.action === "EMAIL_PASSWORD_SIGN_IN" || context.action === "EMAIL_PASSWORD_SIGN_UP") {
                return extractAndInjectCodeAndTenantId(context);
              }
              return context;
            },
          }),
        },
        passwordless: {
          config: (config) => ({
            ...config,
            preAPIHook: async (context) => {
              if (context.action === "PASSWORDLESS_CONSUME_CODE") {
                return extractAndInjectCodeAndTenantId(context);
              }
              return context;
            },
          }),
        },
        thirdparty: {
          config: (config) => ({
            ...config,
            preAPIHook: async (context) => {
              if (context.action === "THIRD_PARTY_SIGN_IN_UP") {
                return extractAndInjectCodeAndTenantId(context);
              }
              return context;
            },
          }),
        },
      },
      generalAuthRecipeComponentOverrides: {
        AuthPageHeader_Override: ({ DefaultComponent, ...props }) => {
          // If the code and tenantId, we need to show the message that
          // the invitation will be accepted automatically.
          const { shouldAcceptInvite } = extractCodeAndTenantId((globalThis as any).location.search);

          return (
            <div>
              {shouldAcceptInvite && "If you authenticate, invitation will be accepted automatically."}
              {/* @ts-ignore */}
              <DefaultComponent {...props} />
            </div>
          );
        },
      },
      exports: {},
    };
  },
  undefined,
  (pluginConfig) => ({
    requireTenantCreation: pluginConfig.requireTenantCreation ?? true,
  }),
);

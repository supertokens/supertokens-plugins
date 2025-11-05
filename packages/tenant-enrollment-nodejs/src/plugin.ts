import { SuperTokensPlugin } from "supertokens-node";
import { createPluginInitFunction } from "@shared/js";
import { PLUGIN_ID, PLUGIN_SDK_VERSION } from "./constants";
import {
  OverrideableTenantFunctionImplementation,
  SuperTokensPluginTenantEnrollmentPluginConfig,
  SuperTokensPluginTenantEnrollmentPluginNormalisedConfig,
} from "./types";
import { getOverrideableTenantFunctionImplementation } from "./pluginImplementation";
import { logDebugMessage } from "supertokens-node/lib/build/logger";
import {
  AssociateAllLoginMethodsOfUserWithTenant,
  AssignRoleToUserInTenant,
  PLUGIN_ID as TENANTS_PLUGIN_ID,
  SendPluginEmail,
  GetAppUrl,
  GetUserIdsInTenantWithRole,
  init as baseTenantsPluginInit,
} from "@supertokens-plugins/tenants-nodejs";
import { NormalisedAppinfo } from "supertokens-node/types";
import { enableDebugLogs } from "./logger";
import { listCodesByPreAuthSessionId } from "supertokens-node/recipe/passwordless";

export const init = createPluginInitFunction<
  SuperTokensPlugin,
  SuperTokensPluginTenantEnrollmentPluginConfig,
  OverrideableTenantFunctionImplementation,
  SuperTokensPluginTenantEnrollmentPluginNormalisedConfig
>(
  (pluginConfig, implementation) => {
    let associateLoginMethodDef: AssociateAllLoginMethodsOfUserWithTenant;
    let assignRoleToUserInTenantDef: AssignRoleToUserInTenant;
    let getUserIdsInTenantWithRoleDef: GetUserIdsInTenantWithRole;

    let sendEmail: SendPluginEmail;
    let appInfo: NormalisedAppinfo;
    let getAppUrlDef: GetAppUrl;
    return {
      id: PLUGIN_ID,
      compatibleSDKVersions: PLUGIN_SDK_VERSION,
      dependencies: (config, pluginsAbove) => {
        const baseTenantsPlugin: SuperTokensPlugin | undefined = pluginsAbove.find(
          (plugin: any) => plugin.id === TENANTS_PLUGIN_ID,
        );

        if (baseTenantsPlugin) {
          return { status: "OK", pluginsToAdd: [] };
        }

        logDebugMessage("Base tenants plugin not found. Registering it.");
        return {
          status: "OK",
          pluginsToAdd: [baseTenantsPluginInit()],
        };
      },
      init: (appConfig, plugins) => {
        if (appConfig.debug) {
          enableDebugLogs();
        }

        const tenantsPlugin = plugins.find((plugin: any) => plugin.id === TENANTS_PLUGIN_ID);
        if (!tenantsPlugin) {
          throw new Error("Should never come here since we are initializing base tenants if not found.");
        }

        if (!tenantsPlugin.exports) {
          throw new Error("Base Tenants plugin does not export, cannot continue.");
        }

        const associateAllLoginMethodsOfUserWithTenant =
          tenantsPlugin.exports?.associateAllLoginMethodsOfUserWithTenant;
        if (!associateAllLoginMethodsOfUserWithTenant) {
          throw new Error("Tenants plugin does not export associateAllLoginMethodsOfUserWithTenant, cannot continue.");
        }

        const assignRoleToUserInTenant = tenantsPlugin.exports?.assignRoleToUserInTenant;
        if (!assignRoleToUserInTenant) {
          throw new Error("Tenants plugin does not export assignRoleToUserInTenant, cannot continue.");
        }

        const sendPluginEmail = tenantsPlugin.exports?.sendEmail;
        if (!sendPluginEmail) {
          throw new Error("Tenants plugin does not export sendEmail, cannot continue.");
        }

        const getUserIdsInTenantWithRole = tenantsPlugin.exports?.getUserIdsInTenantWithRole;
        if (!getUserIdsInTenantWithRole) {
          throw new Error("Tenants plugin does not export getUserIdsInTenantWithRole, cannot continue.");
        }

        associateLoginMethodDef = associateAllLoginMethodsOfUserWithTenant;
        assignRoleToUserInTenantDef = assignRoleToUserInTenant;
        sendEmail = sendPluginEmail;
        getUserIdsInTenantWithRoleDef = getUserIdsInTenantWithRole;

        const getAppUrl = tenantsPlugin.exports?.getAppUrl;
        if (!getAppUrl) {
          throw new Error("Tenants plugin does not export getAppUrl, cannot continue");
        }

        getAppUrlDef = getAppUrl;
        appInfo = appConfig.appInfo;
      },
      routeHandlers: () => {
        return {
          status: "OK",
          routeHandlers: [],
        };
      },
      overrideMap: {
        emailpassword: {
          apis: (originalImplementation) => {
            return {
              ...originalImplementation,
              signUpPOST: async (input) => {
                const emailAsUnknown = input.formFields.filter((f) => f.id === "email")[0]?.value as string;
                const { canJoin, reason } = await implementation.canUserJoinTenant(input.tenantId, {
                  type: "email",
                  email: emailAsUnknown,
                });
                logDebugMessage("Reason: " + reason);
                if (!canJoin) {
                  return {
                    status: "GENERAL_ERROR",
                    message: reason ?? "No reason provided",
                  };
                }

                const response = await originalImplementation.signUpPOST!(input);

                if (response.status !== "OK") {
                  return response;
                }

                logDebugMessage("Going ahead with checking tenant joining approval");
                const { wasAddedToTenant, reason: tenantJoiningReason } =
                  await implementation.handleTenantJoiningApproval(
                    response.user,
                    input.tenantId,
                    associateLoginMethodDef,
                    sendEmail,
                    getAppUrlDef(appInfo, undefined, input.userContext),
                    input.userContext,
                    assignRoleToUserInTenantDef,
                    getUserIdsInTenantWithRoleDef,
                  );
                logDebugMessage(`wasAdded: ${wasAddedToTenant}`);
                logDebugMessage(`reason: ${tenantJoiningReason}`);
                return {
                  wasAddedToTenant,
                  ...response,
                  reason: tenantJoiningReason,
                };
              },
            };
          },
        },
        thirdparty: {
          apis: (originalImplementation) => {
            return {
              ...originalImplementation,
              signInUpPOST: async (input) => {
                const { provider, userContext } = input;
                let oAuthTokensToUse = {};
                if ("redirectURIInfo" in input && input.redirectURIInfo !== undefined) {
                  oAuthTokensToUse = await provider.exchangeAuthCodeForOAuthTokens({
                    redirectURIInfo: input.redirectURIInfo,
                    userContext,
                  });
                } else if ("oAuthTokens" in input && input.oAuthTokens !== undefined) {
                  oAuthTokensToUse = input.oAuthTokens;
                } else {
                  throw Error("should never come here");
                }
                const userInfo = await provider.getUserInfo({ oAuthTokens: oAuthTokensToUse, userContext });

                // Check if the user is signing up (i.e doesn't exist already)
                // and only then apply the checks. Otherwise, we can skip.
                const isSignUp = await implementation.isUserSigningUpToTenant(
                  input.tenantId,
                  {
                    thirdParty: {
                      id: provider.id,
                      userId: userInfo.thirdPartyUserId,
                    },
                  },
                  "thirdparty",
                );

                if (!isSignUp) {
                  return originalImplementation.signInUpPOST!(input);
                }

                const { canJoin, reason } = await implementation.canUserJoinTenant(input.tenantId, {
                  type: "thirdParty",
                  thirdPartyId: userInfo.thirdPartyUserId,
                });
                logDebugMessage("Reason: " + reason);
                if (!canJoin) {
                  return {
                    status: "GENERAL_ERROR",
                    message: reason ?? "No reason provided",
                  };
                }

                const response = await originalImplementation.signInUpPOST!(input);

                if (response.status !== "OK") {
                  return response;
                }

                const { wasAddedToTenant, reason: tenantJoiningReason } =
                  await implementation.handleTenantJoiningApproval(
                    response.user,
                    input.tenantId,
                    associateLoginMethodDef,
                    sendEmail,
                    getAppUrlDef(appInfo, undefined, input.userContext),
                    input.userContext,
                    assignRoleToUserInTenantDef,
                    getUserIdsInTenantWithRoleDef,
                  );
                logDebugMessage(`wasAddedToTenant: ${wasAddedToTenant}`);
                logDebugMessage(`tenantJoiningReason: ${tenantJoiningReason}`);

                return {
                  ...response,
                  wasAddedToTenant,
                  tenantJoiningReason,
                };
              },
            };
          },
        },
        passwordless: {
          apis: (originalImplementation) => {
            return {
              ...originalImplementation,
              createCodePOST: async (input) => {
                // If this is a signup, we need to check if the user
                // can signup to the tenant.
                const isSignUp = implementation.isUserSigningUpToTenant(
                  input.tenantId,
                  {
                    email: "email" in input ? input.email : undefined,
                    phoneNumber: "phoneNumber" in input ? input.phoneNumber : undefined,
                  },
                  "passwordless",
                );

                if (!isSignUp) {
                  return originalImplementation.createCodePOST!(input);
                }

                const { canJoin, reason } = await implementation.canUserJoinTenant(
                  input.tenantId,
                  "email" in input
                    ? {
                      type: "email",
                      email: input.email,
                    }
                    : {
                      type: "phoneNumber",
                      phoneNumber: input.phoneNumber,
                    },
                );

                if (!canJoin) {
                  return {
                    status: "GENERAL_ERROR",
                    message: reason ?? "No reason provided",
                  } as any;
                }

                return await originalImplementation.createCodePOST!(input);
              },
              consumeCodePOST: async (input) => {
                // If this is a signup, we need to check if the user
                // can signup to the tenant.
                // We will need to fetch the details of the user from the
                // deviceId.
                const deviceInfo = await listCodesByPreAuthSessionId({
                  tenantId: input.tenantId,
                  preAuthSessionId: input.preAuthSessionId,
                  userContext: input.userContext,
                });

                if (!deviceInfo) {
                  // This is handled in the consumeCode but we can handle
                  // it here as well
                  return {
                    status: "RESTART_FLOW_ERROR",
                  };
                }

                const isSignUp = await implementation.isUserSigningUpToTenant(
                  input.tenantId,
                  deviceInfo.phoneNumber !== undefined
                    ? {
                      phoneNumber: deviceInfo.phoneNumber!,
                    }
                    : {
                      email: deviceInfo.email!,
                    },
                  "passwordless",
                );

                // TODO: Handle case for phone number

                if (!isSignUp) {
                  return originalImplementation.consumeCodePOST!(input);
                }

                // Since this is a signup, we need to check if the user
                // can signup to the tenant.
                const { canJoin, reason } = await implementation.canUserJoinTenant(
                  input.tenantId,
                  "email" in deviceInfo
                    ? {
                      type: "email",
                      email: deviceInfo.email!,
                    }
                    : {
                      type: "phoneNumber",
                      phoneNumber: deviceInfo.phoneNumber!,
                    },
                );
                logDebugMessage("Reason: " + reason);

                if (!canJoin) {
                  return {
                    status: "GENERAL_ERROR",
                    message: reason ?? "No reason provided",
                  };
                }

                // If they can join, call original implementation with it.
                const response = await originalImplementation.consumeCodePOST!(input);
                if (response.status !== "OK") {
                  return response;
                }

                logDebugMessage("Going ahead with checking tenant joining approval");
                const { wasAddedToTenant, reason: tenantJoiningReason } =
                  await implementation.handleTenantJoiningApproval(
                    response.user,
                    input.tenantId,
                    associateLoginMethodDef,
                    sendEmail,
                    getAppUrlDef(appInfo, undefined, input.userContext),
                    input.userContext,
                    assignRoleToUserInTenantDef,
                    getUserIdsInTenantWithRoleDef,
                  );
                logDebugMessage(`wasAdded: ${wasAddedToTenant}`);
                logDebugMessage(`reason: ${tenantJoiningReason}`);
                return {
                  wasAddedToTenant,
                  ...response,
                  reason: tenantJoiningReason,
                };
              },
            };
          },
        },
        webauthn: {
          apis: (originalImplementation) => ({
            ...originalImplementation,
            registerOptionsPOST: async (input) => {
              let userEmail: string | undefined;
              if ("email" in input) {
                // If `email` is in the input, this means the user is
                // signing-up
                userEmail = input.email;
              } else {
                // For the recovery case, continue with normal flow
                return originalImplementation.registerOptionsPOST!(input);
              }

              if (userEmail === undefined) {
                // Since the email is undefined, we cannot do anything, return
                // original implementation.
                // This will happen in the case of recovery.
                return originalImplementation.registerOptionsPOST!(input);
              }

              // If execution reaches this point, it means the user is
              // signing up so we will need to check if they are allowed to
              // do that.
              const { canJoin, reason } = await implementation.canUserJoinTenant(input.tenantId, {
                type: "email",
                email: userEmail,
              });
              logDebugMessage("Reason: " + reason);
              if (!canJoin) {
                return {
                  status: "GENERAL_ERROR",
                  message: reason ?? "No reason provided",
                };
              }

              return originalImplementation.registerOptionsPOST!(input);
            },
            signUpPOST: async (input) => {
              const response = await originalImplementation.signUpPOST!(input);

              if (response.status !== "OK") {
                return response;
              }

              logDebugMessage("Going ahead with checking tenant joining approval");
              const { wasAddedToTenant, reason: tenantJoiningReason } =
                await implementation.handleTenantJoiningApproval(
                  response.user,
                  input.tenantId,
                  associateLoginMethodDef,
                  sendEmail,
                  getAppUrlDef(appInfo, undefined, input.userContext),
                  input.userContext,
                  assignRoleToUserInTenantDef,
                  getUserIdsInTenantWithRoleDef,
                );
              logDebugMessage(`wasAdded: ${wasAddedToTenant}`);
              logDebugMessage(`reason: ${tenantJoiningReason}`);
              return {
                wasAddedToTenant,
                ...response,
                reason: tenantJoiningReason,
              };
            },
          }),
        },
        multitenancy: {
          apis: (originalImplementation) => ({
            ...originalImplementation,
            loginMethodsGET: async (input) => {
              const response = await originalImplementation.loginMethodsGET(input);

              if (response.status !== "OK") {
                return response;
              }

              const isTenantInviteOnly = implementation.isTenantInviteOnly(input.tenantId);

              // Inject the key into the response.
              return {
                ...response,
                isTenantInviteOnly,
              } as any;
            },
          }),
        },
      },
    };
  },
  getOverrideableTenantFunctionImplementation,
  (config) => ({
    emailDomainToTenantIdMap: config.emailDomainToTenantIdMap,
    inviteOnlyTenants: config.inviteOnlyTenants ?? [],
    requiresApprovalTenants: config.requiresApprovalTenants ?? [],
    allowSignUpToPublicTenant: config.allowSignUpToPublicTenant ?? true,
  }),
);

import { SuperTokensPlugin } from "supertokens-node";
import { createPluginInitFunction } from "@shared/js";
import { PLUGIN_ID, PLUGIN_SDK_VERSION } from "./constants";
import {
  OverrideableTenantFunctionImplementation,
  SuperTokensPluginTenantEnrollmentPluginConfig,
  SuperTokensPluginTenantEnrollmentPluginNormalisedConfig,
} from "./types";
import { getOverrideableTenantFunctionImplementation } from "./recipeImplementation";
import { logDebugMessage } from "supertokens-node/lib/build/logger";
import {
  AssociateAllLoginMethodsOfUserWithTenant,
  PLUGIN_ID as TENANTS_PLUGIN_ID,
  SendPluginEmail,
  GetAppUrl,
} from "@supertokens-plugins/tenants-nodejs";
import { listUsersByAccountInfo } from "supertokens-node";
import { NormalisedAppinfo } from "supertokens-node/types";
import { enableDebugLogs } from "./logger";

export const init = createPluginInitFunction<
  SuperTokensPlugin,
  SuperTokensPluginTenantEnrollmentPluginConfig,
  OverrideableTenantFunctionImplementation,
  SuperTokensPluginTenantEnrollmentPluginNormalisedConfig
>(
  (pluginConfig, implementation) => {
    let associateLoginMethodDef: AssociateAllLoginMethodsOfUserWithTenant;
    let sendEmail: SendPluginEmail;
    let appInfo: NormalisedAppinfo;
    let getAppUrlDef: GetAppUrl;
    return {
      id: PLUGIN_ID,
      compatibleSDKVersions: PLUGIN_SDK_VERSION,
      init: (appConfig, plugins) => {
        if (appConfig.debug) {
          enableDebugLogs();
        }

        const tenantsPlugin = plugins.find((plugin: any) => plugin.id === TENANTS_PLUGIN_ID);
        if (!tenantsPlugin) {
          throw new Error("Base Tenants plugin not initialized, cannot continue.");
        }

        if (!tenantsPlugin.exports) {
          throw new Error("Base Tenants plugin does not export, cannot continue.");
        }

        const associateAllLoginMethodsOfUserWithTenant =
          tenantsPlugin.exports?.associateAllLoginMethodsOfUserWithTenant;
        if (!associateAllLoginMethodsOfUserWithTenant) {
          throw new Error("Tenants plugin does not export associateAllLoginMethodsOfUserWithTenant, cannot continue.");
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
        sendEmail = sendPluginEmail;
        implementation.getUserIdsInTenantWithRole = getUserIdsInTenantWithRole;

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
          functions: (originalImplementation) => {
            return {
              ...originalImplementation,
              signUp: async (input) => {
                const { canJoin, reason } = await implementation.canUserJoinTenant(input.tenantId, {
                  type: "email",
                  email: input.email,
                });
                logDebugMessage("Reason: " + reason);
                if (!canJoin) {
                  return {
                    status: "LINKING_TO_SESSION_USER_FAILED",
                    reason: "EMAIL_VERIFICATION_REQUIRED",
                  };
                }

                return originalImplementation.signUp(input);
              },
            };
          },
          apis: (originalImplementation) => {
            return {
              ...originalImplementation,
              signUpPOST: async (input) => {
                const response = await originalImplementation.signUpPOST!(input);
                if (response.status === "SIGN_UP_NOT_ALLOWED" && response.reason.includes("ERR_CODE_013")) {
                  // There is a possibility that the user is not allowed
                  // to signup to the tenant so we will have to update the message
                  // accordingly.
                  return {
                    ...response,
                    reason: "Cannot sign in / sign up due to security reasons or tenant doesn't allow signup",
                  };
                }

                logDebugMessage(`Got response status for signup: ${response.status}`);
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
                  );
                logDebugMessage(`wasAdded: ${wasAddedToTenant}`);
                logDebugMessage(`reason: ${tenantJoiningReason}`);
                return {
                  status: "PENDING_APPROVAL",
                  wasAddedToTenant,
                  reason: tenantJoiningReason,
                };

                // return response;
              },
            };
          },
        },
        thirdparty: {
          apis: (originalImplementation) => {
            return {
              ...originalImplementation,
              signInUpPOST: async (input) => {
                const response = await originalImplementation.signInUpPOST!(input);
                if (response.status === "SIGN_IN_UP_NOT_ALLOWED" && response.reason.includes("ERR_CODE_020")) {
                  return {
                    ...response,
                    reason: "Cannot sign in / sign up due to security reasons or tenant doesn't allow signup",
                  };
                }

                return response;
              },
            };
          },
          functions: (originalImplementation) => {
            return {
              ...originalImplementation,
              signInUp: async (input) => {
                // Check if the user is signing up (i.e doesn't exist already)
                // and only then apply the checks. Otherwise, we can skip.
                const accountInfoResponse = await listUsersByAccountInfo(input.tenantId, {
                  thirdParty: {
                    id: input.thirdPartyId,
                    userId: input.thirdPartyUserId,
                  },
                });
                const isSignUp = accountInfoResponse.length === 0;

                if (!isSignUp) {
                  return originalImplementation.signInUp(input);
                }

                const { canJoin, reason } = await implementation.canUserJoinTenant(input.tenantId, {
                  type: "thirdParty",
                  thirdPartyId: input.thirdPartyId,
                });
                logDebugMessage("Reason: " + reason);
                if (!canJoin) {
                  return {
                    status: "LINKING_TO_SESSION_USER_FAILED",
                    reason: "EMAIL_VERIFICATION_REQUIRED",
                  };
                }

                const response = await originalImplementation.signInUp(input);
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
                  );
                return {
                  ...response,
                  wasAddedToTenant,
                  reason: tenantJoiningReason,
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
                const response = await originalImplementation.createCodePOST!(input);
                if (response.status === "SIGN_IN_UP_NOT_ALLOWED" && response.reason.includes("ERR_CODE_002")) {
                  return {
                    ...response,
                    reason: "Cannot sign in / sign up due to security reasons or tenant doesn't allow signup",
                  } as any;
                }

                return response;
              },
              consumeCodePOST: async (input) => {
                const response = await originalImplementation.consumeCodePOST!(input);
                if (response.status === "SIGN_IN_UP_NOT_ALLOWED" && response.reason.includes("ERR_CODE_002")) {
                  return {
                    ...response,
                    reason: "Cannot sign in / sign up due to security reasons or tenant doesn't allow signup",
                  } as any;
                }

                return response;
              },
            };
          },
          functions: (originalImplementation) => {
            return {
              ...originalImplementation,
              createCode: async (input) => {
                // If this is a signup, we need to check if the user
                // can signup to the tenant.
                const accountInfoResponse = await listUsersByAccountInfo(input.tenantId, {
                  email: "email" in input ? input.email : undefined,
                  phoneNumber: "phoneNumber" in input ? input.phoneNumber : undefined,
                });
                const isSignUp = accountInfoResponse.length === 0;

                if (!isSignUp) {
                  return originalImplementation.createCode(input);
                }

                // If this is a signup but its through phone number, we cannot
                // restrict it so we will let it go through.
                if ("phoneNumber" in input) {
                  return originalImplementation.createCode(input);
                }

                const { canJoin, reason } = await implementation.canUserJoinTenant(input.tenantId, {
                  type: "email",
                  email: input.email,
                });
                logDebugMessage("Reason: " + reason);

                if (!canJoin) {
                  return {
                    status: "SIGN_IN_UP_NOT_ALLOWED",
                  } as any;
                }

                return originalImplementation.createCode(input);
              },
              consumeCode: async (input) => {
                // If this is a signup, we need to check if the user
                // can signup to the tenant.
                // We will need to fetch the details of the user from the
                // deviceId.
                const deviceInfo = await originalImplementation.listCodesByPreAuthSessionId({
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

                const accountInfoResponse = await listUsersByAccountInfo(
                  input.tenantId,
                  deviceInfo.phoneNumber !== undefined
                    ? {
                        phoneNumber: deviceInfo.phoneNumber!,
                      }
                    : {
                        email: deviceInfo.email!,
                      },
                );
                const isSignUp = accountInfoResponse.length === 0;

                // If this is a signup or its through phone number, we cannot
                // restrict it so we will let it go through.
                if (!isSignUp || deviceInfo.phoneNumber !== undefined) {
                  return originalImplementation.consumeCode(input);
                }

                // Since this is a signup, we need to check if the user
                // can signup to the tenant.
                const { canJoin, reason } = await implementation.canUserJoinTenant(input.tenantId, {
                  type: "email",
                  email: deviceInfo.email!,
                });
                logDebugMessage("Reason: " + reason);

                if (!canJoin) {
                  return {
                    status: "SIGN_IN_UP_NOT_ALLOWED",
                  } as any;
                }

                return originalImplementation.consumeCode(input);
              },
            };
          },
        },
      },
    };
  },
  getOverrideableTenantFunctionImplementation,
  (config) => ({
    emailDomainToTenantIdMap: config.emailDomainToTenantIdMap,
    inviteOnlyTenants: config.inviteOnlyTenants ?? [],
    requiresApprovalTenants: config.requiresApprovalTenants ?? [],
  }),
);

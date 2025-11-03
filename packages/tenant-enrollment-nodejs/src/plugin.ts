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
    let assignRoleToUserInTenantDef: AssignRoleToUserInTenant;
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
                    // Use the `EMAIL_ALREADY_EXISTS_ERROR` since that is returned
                    // directly without modification from the `signUpPOST` method.
                    status: "EMAIL_ALREADY_EXISTS_ERROR",
                    reason,
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

                logDebugMessage(`Got response status for signup: ${response.status}`);

                // If the status is `EMAIL_ALREADY_EXISTS_ERROR`, we will have to pick that
                // up and return a GENERAL_ERROR instead to make the error passed along to
                // the FE
                if (response.status === "EMAIL_ALREADY_EXISTS_ERROR") {
                  return {
                    status: "GENERAL_ERROR",
                    message: (response as any).reason,
                  };
                }

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
                const response = await originalImplementation.signInUpPOST!(input);
                // If the status is `SIGN_IN_UP_NOT_ALLOWED`, we will have to pick that
                // up and return a GENERAL_ERROR instead to make the error passed along to
                // the FE
                if (response.status === "SIGN_IN_UP_NOT_ALLOWED") {
                  return {
                    status: "GENERAL_ERROR",
                    message: (response as any).reason,
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
                const isSignUp = await implementation.isUserSigningUpToTenant(input.tenantId, {
                  thirdParty: {
                    id: input.thirdPartyId,
                    userId: input.thirdPartyUserId,
                  },
                });

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
                    status: "SIGN_IN_UP_NOT_ALLOWED",
                    reason,
                  } as any;
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
                    assignRoleToUserInTenantDef,
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
                // If this is a signup, we need to check if the user
                // can signup to the tenant.
                const isSignUp = implementation.isUserSigningUpToTenant(input.tenantId, {
                  email: "email" in input ? input.email : undefined,
                  phoneNumber: "phoneNumber" in input ? input.phoneNumber : undefined,
                });

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
                logDebugMessage("Reason: " + reason);

                if (!canJoin) {
                  return {
                    status: "GENERAL_ERROR",
                    message: reason,
                  } as any;
                }

                return await originalImplementation.createCodePOST!(input);
              },
              consumeCodePOST: async (input) => {
                const response = await originalImplementation.consumeCodePOST!(input);
                if (response.status === "RESTART_FLOW_ERROR") {
                  // If reason is defined in response, return as GENERAL_ERROR
                  // instead with the error.
                  const reason = (response as any).reason;
                  if (reason === undefined) {
                    return response;
                  } else {
                    return {
                      status: "GENERAL_ERROR",
                      message: reason,
                    };
                  }
                }

                return response;
              },
            };
          },
          functions: (originalImplementation) => {
            return {
              ...originalImplementation,
              createCode: async (input) => {
                // NOTE: We are duplicating the code from createCodePOST
                // here because we want to ensure that the same checks
                // are applied to the API as well as the function.
                //
                // Ideally, we should check here and return a message to
                // createCodePOST but that is not possible since `createCodePOST`
                // modifies the response and adds a custom reason if it's a
                // non OK status so we won't be able to pass the actual reason
                // back to the FE.

                const isSignUp = implementation.isUserSigningUpToTenant(input.tenantId, {
                  email: "email" in input ? input.email : undefined,
                  phoneNumber: "phoneNumber" in input ? input.phoneNumber : undefined,
                });

                if (!isSignUp) {
                  return originalImplementation.createCode!(input);
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
                logDebugMessage("Reason: " + reason);

                if (!canJoin) {
                  return {
                    status: "GENERAL_ERROR",
                    message: reason,
                  } as any;
                }

                return await originalImplementation.createCode!(input);
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

                const isSignUp = await implementation.isUserSigningUpToTenant(
                  input.tenantId,
                  deviceInfo.phoneNumber !== undefined
                    ? {
                        phoneNumber: deviceInfo.phoneNumber!,
                      }
                    : {
                        email: deviceInfo.email!,
                      },
                );

                // If this is a signup or its through phone number, we cannot
                // restrict it so we will let it go through.
                if (!isSignUp || deviceInfo.phoneNumber !== undefined) {
                  return originalImplementation.consumeCode(input);
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
                    status: "RESTART_FLOW_ERROR",
                    reason,
                  } as any;
                }

                const response = await originalImplementation.consumeCode(input);

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
          functions: (originalImplementation) => ({
            ...originalImplementation,
            registerOptions: async (input) => {
              let userEmail: string | undefined;
              if ("email" in input) {
                // User's email is provided so we can check
                // if they are trying to signup in which case
                // we will block this accordingly.
                const isSignUp = await implementation.isUserSigningUpToTenant(input.tenantId, {
                  email: input.email,
                });
                if (!isSignUp) {
                  // If the user is not signing up, we can continue the original
                  // implementation
                  return originalImplementation.registerOptions(input);
                }

                userEmail = input.email;
              } else {
                // For the recovery case, continue with normal flow
                return originalImplementation.registerOptions(input);
              }

              if (userEmail === undefined) {
                // Since the email is undefined, we cannot do anything, return
                // original implementation.
                return originalImplementation.registerOptions(input);
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
                  message: reason,
                } as any;
              }

              return originalImplementation.registerOptions(input);
            },
          }),
          apis: (originalImplementation) => ({
            ...originalImplementation,
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
  }),
);

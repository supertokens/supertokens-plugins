import { isRecipeInitialized } from "supertokens-node";
import { SuperTokensPlugin } from "supertokens-node/types";

import { withRequestHandler } from "@shared/nodejs";
import { createPluginInitFunction } from "@shared/js";

import { SuperTokensPluginProfileSecurityConfig, SuperTokensPluginProfileSecurityNormalisedConfig } from "./types";
import {
  PLUGIN_ID,
  HANDLE_BASE_PATH,
  PLUGIN_SDK_VERSION,
  DEFAULT_ENABLE_SETTING_PASSWORD,
  DEFAULT_ENABLE_THIRD_PARTY_LINKING,
  DEFAULT_ENABLE_MFA_CONFIGURATION,
} from "./constants";
import { enableDebugLogs } from "./logger";
import { Implementation } from "./implementation";

export const init = createPluginInitFunction<
  SuperTokensPlugin,
  SuperTokensPluginProfileSecurityConfig,
  Implementation,
  SuperTokensPluginProfileSecurityNormalisedConfig
>(
  (pluginConfig, implementation) => {
    return {
      id: PLUGIN_ID,
      compatibleSDKVersions: PLUGIN_SDK_VERSION,
      init: (config) => {
        if (config.debug) {
          enableDebugLogs();
        }
      },
      routeHandlers: () => {
        return {
          status: "OK",
          routeHandlers: [
            {
              path: HANDLE_BASE_PATH + "/config",
              method: "get",
              verifySessionOptions: {
                sessionRequired: true,
              },
              handler: withRequestHandler(async (req, res, session, userContext) => {
                const userId = session!.getUserId();
                if (!userId) {
                  return { status: "ERROR", message: "User not found" };
                }

                return implementation.getConfigForClient({
                  session: session!,
                  userContext,
                });
              }),
            },
            {
              path: HANDLE_BASE_PATH + "/password/set",
              method: "post",
              verifySessionOptions: {
                sessionRequired: true,
              },
              handler: withRequestHandler(async (req, res, session, userContext) => {
                if (!isRecipeInitialized("emailpassword")) {
                  return {
                    status: "ERROR",
                    message: "Changing password requires the EmailPassword recipe to be initialized",
                  };
                }

                const { newPassword, email } = await req.getJSONBody();
                if (!email || !newPassword) {
                  return {
                    status: "ERROR",
                    message: "Email and password are required",
                  };
                }

                const userId = session!.getUserId();
                if (!userId) {
                  return { status: "ERROR", message: "User not found" };
                }

                return implementation.setUserPassword({
                  userId,
                  email,
                  password: newPassword,
                  session: session!,
                  userContext,
                });
              }),
            },
            {
              path: HANDLE_BASE_PATH + "/password/change",
              method: "post",
              verifySessionOptions: {
                sessionRequired: true,
              },
              handler: withRequestHandler(async (req, res, session, userContext) => {
                if (!isRecipeInitialized("emailpassword")) {
                  return {
                    status: "ERROR",
                    message: "Changing password requires the EmailPassword recipe to be initialized",
                  };
                }

                const userId = session!.getUserId();
                if (!userId) {
                  return { status: "ERROR", message: "User not found" };
                }

                const { currentPassword, newPassword } = await req.getJSONBody();

                return implementation.changeUserPassword({
                  userId,
                  currentPassword,
                  newPassword,
                  session: session!,
                  userContext,
                });
              }),
            },
            {
              path: HANDLE_BASE_PATH + "/user/unlink",
              method: "post",
              verifySessionOptions: {
                sessionRequired: true,
              },
              handler: withRequestHandler(async (req, res, session, userContext) => {
                if (!isRecipeInitialized("thirdparty")) {
                  return {
                    status: "ERROR",
                    message: "Unlinking account requires the ThirdParty recipe to be initialized",
                  };
                }
                const userId = session!.getUserId();
                if (!userId) {
                  return { status: "ERROR", message: "User not found" };
                }

                const { recipeUserId } = await req.getJSONBody();

                return implementation.unlinkThirdPartyUser({
                  userId,
                  recipeUserId,
                  session: session!,
                  userContext,
                });
              }),
            },
            {
              path: HANDLE_BASE_PATH + "/mfa/set-required",
              method: "post",
              verifySessionOptions: {
                sessionRequired: true,
              },
              handler: withRequestHandler(async (req, res, session, userContext) => {
                const userId = session!.getUserId();
                if (!userId) {
                  return { status: "ERROR", message: "User not found" };
                }

                const { factorId } = await req.getJSONBody();

                return implementation.setOrRemoveSingleRequiredMfaFactorForUser({
                  userId,
                  factorId,
                  session: session!,
                  userContext,
                });
              }),
            },
            {
              path: HANDLE_BASE_PATH + "/mfa",
              method: "get",
              verifySessionOptions: {
                sessionRequired: true,
              },
              handler: withRequestHandler(async (req, res, session, userContext) => {
                const userId = session!.getUserId();
                if (!userId) {
                  return { status: "ERROR", message: "User not found" };
                }

                return implementation.getRequiredSecondaryFactorsForUser({
                  userId,
                  session: session!,
                  userContext,
                });
              }),
            },

            {
              path: HANDLE_BASE_PATH + "/mfa/update-otp-email",
              method: "post",
              verifySessionOptions: {
                sessionRequired: true,
              },
              handler: withRequestHandler(async (req, res, session, userContext) => {
                const userId = session!.getUserId();
                if (!userId) {
                  return { status: "ERROR", message: "User not found" };
                }
                const { email } = await req.getJSONBody();

                return implementation.changeOtpEmailForUser({
                  userId,
                  email,
                  session: session!,
                  userContext,
                });
              }),
            },
            {
              path: HANDLE_BASE_PATH + "/mfa/update-otp-phone-number/code",
              method: "post",
              verifySessionOptions: {
                sessionRequired: true,
              },
              handler: withRequestHandler(async (req, res, session, userContext) => {
                const userId = session!.getUserId();
                if (!userId) {
                  return { status: "ERROR", message: "User not found" };
                }

                const { phoneNumber } = await req.getJSONBody();

                return implementation.sendSmsOtpForUserPhoneNumberChange({
                  userId,
                  phoneNumber,
                  session: session!,
                  userContext,
                });
              }),
            },
            {
              path: HANDLE_BASE_PATH + "/mfa/update-otp-phone-number",
              method: "post",
              verifySessionOptions: {
                sessionRequired: true,
              },
              handler: withRequestHandler(async (req, res, session, userContext) => {
                const userId = session!.getUserId();
                if (!userId) {
                  return { status: "ERROR", message: "User not found" };
                }

                const { phoneNumber, code, deviceId, preAuthSessionId } = await req.getJSONBody();

                return implementation.changeOtpPhoneNumberForUser({
                  userId,
                  phoneNumber,
                  deviceId,
                  preAuthSessionId,
                  code,
                  session: session!,
                  userContext,
                });
              }),
            },
            {
              path: HANDLE_BASE_PATH + "/mfa/update-totp",
              method: "post",
              verifySessionOptions: {
                sessionRequired: true,
              },
              handler: withRequestHandler(async (req, res, session, userContext) => {
                const userId = session!.getUserId();
                if (!userId) {
                  return { status: "ERROR", message: "User not found" };
                }

                const { name, newName } = await req.getJSONBody();

                return implementation.renameOtpTotpDeviceForUser({
                  userId,
                  name,
                  newName,
                  session: session!,
                  userContext,
                });
              }),
            },
            {
              path: HANDLE_BASE_PATH + "/user",
              method: "get",
              verifySessionOptions: {
                sessionRequired: true,
              },
              handler: withRequestHandler(async (req, res, session, userContext) => {
                const userId = session!.getUserId();
                if (!userId) {
                  return { status: "ERROR", message: "User not found" };
                }

                return implementation.getUser({
                  userId,
                  session: session!,
                  userContext,
                });
              }),
            },
          ],
        };
      },
    };
  },
  (config) => Implementation.init(config),
  (pluginConfig) => {
    return {
      enableSettingPassword: pluginConfig.enableSettingPassword ?? DEFAULT_ENABLE_SETTING_PASSWORD,
      enableThirdPartyLinkning: pluginConfig.enableThirdPartyLinkning ?? DEFAULT_ENABLE_THIRD_PARTY_LINKING,
      enableMfaConfiguration: pluginConfig.enableMfaConfiguration ?? DEFAULT_ENABLE_MFA_CONFIGURATION,
    };
  },
);

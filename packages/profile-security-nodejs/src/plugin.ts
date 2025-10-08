import { getUser, isRecipeInitialized, deleteUser, getAvailableFirstFactors } from "supertokens-node";
import { updateEmailOrPassword, verifyCredentials, signUp } from "supertokens-node/recipe/emailpassword";
import MultiFactorAuth, { FactorIds } from "supertokens-node/recipe/multifactorauth";
import AccountLinking from "supertokens-node/recipe/accountlinking";
import TOTP from "supertokens-node/recipe/totp";
import Passwordless from "supertokens-node/recipe/passwordless";
import { SuperTokensPlugin } from "supertokens-node/types";

import { withRequestHandler } from "@shared/nodejs";
import { createPluginInitFunction } from "@shared/js";

import { SuperTokensPluginProfileSecurityConfig } from "./types";
import { PLUGIN_ID, HANDLE_BASE_PATH, PLUGIN_SDK_VERSION } from "./constants";
import { enableDebugLogs, logDebugMessage } from "./logger";

export const init = createPluginInitFunction<
  SuperTokensPlugin,
  SuperTokensPluginProfileSecurityConfig,
  never,
  Required<SuperTokensPluginProfileSecurityConfig>
>(
  (pluginConfig) => {
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
              handler: withRequestHandler(async (req, res, session) => {
                const userId = session!.getUserId();
                if (!userId) {
                  return { status: "ERROR", message: "User not found" };
                }

                return {
                  status: "OK",
                  config: {
                    enableSettingPassword: pluginConfig.enableSettingPassword,
                    enableThirdPartyLinkning: pluginConfig.enableThirdPartyLinkning,
                    enableMfaConfiguration: pluginConfig.enableMfaConfiguration,
                  },
                };
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

                const user = await getUser(userId, userContext);
                if (!user) {
                  return { status: "ERROR", message: "User not found" };
                }

                // todo decide if we should allow setting password for other emails
                if (!user.emails.includes(email)) {
                  return {
                    status: "ERROR",
                    message: "The user does not have this email address",
                  };
                }

                const passwordLoginMethods = user.loginMethods.filter((lm) => lm.recipeId === "emailpassword");
                if (passwordLoginMethods.length) {
                  return {
                    status: "ERROR",
                    message:
                      "User already has a password set. Please use the change password feature to update your password.",
                  };
                }

                // todo firgure out how to handle email verification
                const signUpResult = await signUp(
                  session!.getTenantId(),
                  email,
                  newPassword,
                  session!, // todo: ??? should we pass the session or try linking later?
                  userContext,
                );
                if (signUpResult.status === "EMAIL_ALREADY_EXISTS_ERROR") {
                  return {
                    status: "ERROR",
                    message:
                      "There already exists a user with this email address. Please use the change password feature to update your password.",
                  };
                }
                if (signUpResult.status === "LINKING_TO_SESSION_USER_FAILED") {
                  return {
                    status: "ERROR",
                    message: "Could not link the new password to the user. Please contact support.",
                  };
                }
                if (signUpResult.status !== "OK") {
                  return {
                    status: "ERROR",
                    message: "Password change failed",
                  };
                }

                const linkResp = await AccountLinking.linkAccounts(signUpResult.recipeUserId, session!.getUserId());
                if (linkResp.status !== "OK") {
                  logDebugMessage(`Could not link the new password to the user: ${linkResp.status}`);

                  return {
                    status: "ERROR",
                    message: "Could not link the new password to the user. Please contact support.",
                  };
                }

                return { status: "OK" };
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

                const user = await getUser(userId, userContext);
                if (!user) {
                  return { status: "ERROR", message: "User not found" };
                }
                const passwordLoginMethods = user.loginMethods.filter((lm) => lm.recipeId === "emailpassword");
                if (passwordLoginMethods.length === 0) {
                  return {
                    status: "ERROR",
                    message: "User has no password set. Please set a password first.",
                  };
                }
                if (passwordLoginMethods.length > 1) {
                  return {
                    status: "ERROR",
                    message: "User has multiple password login methods. Please contact support.",
                  };
                }

                const passwordLoginMethod = passwordLoginMethods[0]!;

                const { currentPassword, newPassword } = await req.getJSONBody();

                const verifyResult = await verifyCredentials(
                  session!.getTenantId(),
                  passwordLoginMethod.email!,
                  currentPassword,
                );

                if (verifyResult.status !== "OK") {
                  return { status: "ERROR", message: "Invalid password" };
                }

                const result = await updateEmailOrPassword({
                  recipeUserId: passwordLoginMethod.recipeUserId,
                  password: newPassword,
                });

                if (result.status !== "OK") {
                  logDebugMessage(`Could not update password: ${result.status}`);

                  return {
                    status: "ERROR",
                    message: "Password change failed",
                  };
                }

                return { status: "OK" };
              }),
            },
            {
              path: HANDLE_BASE_PATH + "/user/unlink",
              method: "post",
              verifySessionOptions: {
                sessionRequired: true,
              },
              handler: withRequestHandler(async (req, res, session, userContext) => {
                const userId = session!.getUserId();
                if (!userId) {
                  return { status: "ERROR", message: "User not found" };
                }

                const user = await getUser(userId, userContext);
                if (!user) {
                  return { status: "ERROR", message: "User not found" };
                }

                const { recipeUserId } = await req.getJSONBody();

                const availableFirstFactors = await getAvailableFirstFactors(
                  session!.getTenantId(),
                  session,
                  userContext,
                );

                const availableUserLoginMethods = user.loginMethods.filter(
                  (lm) => lm.recipeUserId.getAsString() !== recipeUserId,
                );
                const availableUserFactorIds: string[] = availableUserLoginMethods
                  .map((lm) => {
                    if (lm.recipeId === "emailpassword") return [FactorIds.EMAILPASSWORD];
                    if (lm.recipeId === "passwordless") {
                      if (lm.email) return [FactorIds.OTP_EMAIL, FactorIds.LINK_EMAIL];
                      if (lm.phoneNumber) return [FactorIds.OTP_EMAIL, FactorIds.LINK_EMAIL];
                    }
                    if (lm.recipeId === "thirdparty") return FactorIds.THIRDPARTY;
                    if (lm.recipeId === "webauthn") return [FactorIds.WEBAUTHN];

                    return undefined;
                  })
                  .filter((factorIds) => factorIds !== undefined)
                  .flat();

                const canUnlink = availableUserFactorIds.some((factorId) => availableFirstFactors.includes(factorId));
                if (!canUnlink) {
                  return {
                    status: "ERROR",
                    message: "User has no available first factor login methods",
                  };
                }

                const result = await deleteUser(recipeUserId, false, {
                  userContext,
                });
                if (result.status !== "OK") {
                  return {
                    status: "ERROR",
                    message: "Could not unlink account",
                  };
                }

                return { status: "OK" };
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

                const user = await getUser(userId, userContext);
                if (!user) {
                  return { status: "ERROR", message: "User not found" };
                }

                const { factorId } = await req.getJSONBody();

                const requiredFactorIds = await MultiFactorAuth.getRequiredSecondaryFactorsForUser(userId);
                for await (const factorId of requiredFactorIds) {
                  await MultiFactorAuth.removeFromRequiredSecondaryFactorsForUser(userId, factorId);
                }

                if (factorId) {
                  await MultiFactorAuth.addToRequiredSecondaryFactorsForUser(userId, factorId);
                }

                return { status: "OK" };
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

                const user = await getUser(userId, userContext);
                if (!user) {
                  return { status: "ERROR", message: "User not found" };
                }

                const requiredSecondaryFactors = await MultiFactorAuth.getRequiredSecondaryFactorsForUser(user.id);

                return {
                  status: "OK",
                  requiredSecondaryFactors,
                };
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

                const user = await getUser(userId, userContext);
                if (!user) {
                  return { status: "ERROR", message: "User not found" };
                }

                const { email } = await req.getJSONBody();

                const emailOtpLoginMethods = user.loginMethods.filter(
                  (lm) => lm.recipeId === "passwordless" && lm.email,
                );
                if (emailOtpLoginMethods.length === 0) {
                  return {
                    status: "ERROR",
                    message: "User has no email OTP login method",
                  };
                }
                if (emailOtpLoginMethods.length > 1) {
                  return {
                    status: "ERROR",
                    message: "User has multiple email OTP login methods",
                  };
                }
                const emailOtpLoginMethod = emailOtpLoginMethods[0]!;

                const result = await Passwordless.updateUser({
                  recipeUserId: emailOtpLoginMethod.recipeUserId,
                  email: email,
                });

                if (result.status !== "OK") {
                  return {
                    status: "ERROR",
                    message: "Failed to update email OTP login method",
                  };
                }

                return {
                  status: "OK",
                };
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

                const user = await getUser(userId, userContext);
                if (!user) {
                  return { status: "ERROR", message: "User not found" };
                }

                const phoneOtpLoginMethods = user.loginMethods.filter(
                  (lm) => lm.recipeId === "passwordless" && lm.phoneNumber,
                );
                if (phoneOtpLoginMethods.length === 0) {
                  return {
                    status: "ERROR",
                    message: "User has no phone OTP login method",
                  };
                }
                if (phoneOtpLoginMethods.length > 1) {
                  return {
                    status: "ERROR",
                    message: "User has multiple phone OTP login methods",
                  };
                }

                const { phoneNumber } = await req.getJSONBody();

                const result = await Passwordless.createCode({
                  phoneNumber,
                  tenantId: session!.getTenantId(),
                  session,
                  userContext,
                });
                if (result.status !== "OK") {
                  return {
                    status: "ERROR",
                    message: "Failed to generate code",
                  };
                }

                await Passwordless.sendSms({
                  isFirstFactor: false,
                  codeLifetime: 1000 * 60 * 5, // todo is this correct?
                  phoneNumber,
                  preAuthSessionId: result.preAuthSessionId,
                  tenantId: session!.getTenantId(),
                  userContext,
                  userInputCode: result.userInputCode,
                  type: "PASSWORDLESS_LOGIN",
                });

                return {
                  status: "OK",
                  deviceId: result.deviceId,
                  preAuthSessionId: result.preAuthSessionId,
                };
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

                const user = await getUser(userId, userContext);
                if (!user) {
                  return { status: "ERROR", message: "User not found" };
                }

                const phoneOtpLoginMethods = user.loginMethods.filter(
                  (lm) => lm.recipeId === "passwordless" && lm.phoneNumber,
                );
                if (phoneOtpLoginMethods.length === 0) {
                  return {
                    status: "ERROR",
                    message: "User has no phone OTP login method",
                  };
                }
                if (phoneOtpLoginMethods.length > 1) {
                  return {
                    status: "ERROR",
                    message: "User has multiple phone OTP login methods",
                  };
                }
                const phoneOtpLoginMethod = phoneOtpLoginMethods[0]!;

                const { phoneNumber, code, deviceId, preAuthSessionId } = await req.getJSONBody();

                const checkResult = await Passwordless.checkCode({
                  deviceId,
                  preAuthSessionId,
                  userInputCode: code,
                  tenantId: session!.getTenantId(),
                  userContext,
                });

                if (checkResult.status !== "OK") {
                  return {
                    status: "ERROR",
                    message: "Failed to validate code",
                  };
                }
                if (!checkResult.consumedDevice.phoneNumber) {
                  return {
                    status: "ERROR",
                    message: "Failed to validate code",
                  };
                }
                if (checkResult.consumedDevice.phoneNumber !== phoneNumber) {
                  return {
                    status: "ERROR",
                    message: "Code is not valid for this phone number",
                  };
                }

                const updateResult = await Passwordless.updateUser({
                  recipeUserId: phoneOtpLoginMethod.recipeUserId,
                  phoneNumber: checkResult.consumedDevice.phoneNumber,
                });
                if (updateResult.status !== "OK") {
                  return {
                    status: "ERROR",
                    message: "Failed to update phone OTP login method",
                  };
                }

                // doesn't matter if it fails or not, since the code we'll revoke itself after a specific time
                await Passwordless.revokeAllCodes({
                  phoneNumber: checkResult.consumedDevice.phoneNumber,
                  tenantId: session!.getTenantId(),
                  userContext,
                });

                return {
                  status: "OK",
                };
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

                const user = await getUser(userId, userContext);
                if (!user) {
                  return { status: "ERROR", message: "User not found" };
                }

                const { name, newName } = await req.getJSONBody();

                const result = await TOTP.updateDevice(userId, name, newName, userContext);

                if (result.status !== "OK") {
                  return {
                    status: "ERROR",
                    message: "Could not update TOTP device",
                  };
                }

                return {
                  status: "OK",
                };
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

                const user = await getUser(userId, userContext);
                if (!user) {
                  return { status: "ERROR", message: "User not found" };
                }

                return {
                  status: "OK",
                  user: user.toJson(),
                };
              }),
            },
          ],
        };
      },
    };
  },
  undefined,
  (pluginConfig) => {
    return {
      enableSettingPassword: pluginConfig.enableSettingPassword ?? true,
      enableThirdPartyLinkning: pluginConfig.enableThirdPartyLinkning ?? true,
      enableMfaConfiguration: pluginConfig.enableMfaConfiguration ?? true,
    };
  },
);

import { getUser, deleteUser, getAvailableFirstFactors, User } from "supertokens-node";
import { SessionContainerInterface } from "supertokens-node/recipe/session/types";
import AccountLinking from "supertokens-node/recipe/accountlinking";
import { FactorIds } from "supertokens-node/recipe/multifactorauth";
import { signUp, updateEmailOrPassword, verifyCredentials } from "supertokens-node/recipe/emailpassword";
import { BaseFormSection } from "@supertokens-plugins/profile-details-shared";
import { SuperTokensPluginProfileSecurityNormalisedConfig } from "./types";
import { logDebugMessage } from "./logger";
import MultiFactorAuth from "supertokens-node/recipe/multifactorauth";
import Passwordless from "supertokens-node/recipe/passwordless";
import { DEFAULT_SMS_CODE_LIFETIME_FOR_OTP_PHONE_CHANGE } from "./constants";
import TOTP from "supertokens-node/recipe/totp";

export class Implementation {
  static instance: Implementation | undefined;

  protected sections: BaseFormSection[] = [];

  static init(pluginConfig: SuperTokensPluginProfileSecurityNormalisedConfig): Implementation {
    if (Implementation.instance) {
      return Implementation.instance;
    }
    Implementation.instance = new Implementation(pluginConfig);

    return Implementation.instance;
  }

  static getInstanceOrThrow(): Implementation {
    if (!Implementation.instance) {
      throw new Error("Implementation instance not found. Make sure you have initialized the plugin.");
    }

    return Implementation.instance;
  }

  static reset(): void {
    Implementation.instance = undefined;
  }

  constructor(protected pluginConfig: SuperTokensPluginProfileSecurityNormalisedConfig) {}

  getConfigForClient = async function (
    this: Implementation,
    // props needed for overriding
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    props: { userContext: any; session: SessionContainerInterface },
  ): Promise<
    { status: "OK"; config: SuperTokensPluginProfileSecurityNormalisedConfig } | { status: "ERROR"; message: string }
  > {
    return {
      status: "OK",
      config: {
        enableSettingPassword: this.pluginConfig.enableSettingPassword,
        enableThirdPartyLinkning: this.pluginConfig.enableThirdPartyLinkning,
        enableMfaConfiguration: this.pluginConfig.enableMfaConfiguration,
      },
    };
  };

  setUserPassword = async function (
    this: Implementation,
    {
      userId,
      email,
      password,
      session,
      userContext,
    }: {
      userId: string;
      email: string;
      password: string;
      session: SessionContainerInterface;
      userContext: any;
    },
  ): Promise<{ status: "OK" } | { status: "ERROR"; message: string }> {
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
        message: "User already has a password set. Please use the change password feature to update your password.",
      };
    }

    // todo firgure out how to handle email verification
    const signUpResult = await signUp(
      session!.getTenantId(),
      email,
      password,
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

    const linkResp = await AccountLinking.linkAccounts(signUpResult.recipeUserId, session!.getUserId(), userContext);
    if (linkResp.status !== "OK") {
      logDebugMessage(`Could not link the new password to the user: ${linkResp.status}`);

      return {
        status: "ERROR",
        message: "Could not link the new password to the user. Please contact support.",
      };
    }

    return { status: "OK" };
  };

  selectLoginMethodForPasswordChange = async function (
    this: Implementation,
    { user }: { user: User; session: SessionContainerInterface; userContext: any },
  ): Promise<{ status: "OK"; loginMethod: User["loginMethods"][number] } | { status: "ERROR"; message: string }> {
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

    return { status: "OK", loginMethod: passwordLoginMethods[0]! };
  };

  changeUserPassword = async function (
    this: Implementation,
    {
      userId,
      currentPassword,
      newPassword,
      session,
      userContext,
    }: {
      userId: string;
      currentPassword: string;
      newPassword: string;
      session: SessionContainerInterface;
      userContext: any;
    },
  ): Promise<{ status: "OK" } | { status: "ERROR"; message: string }> {
    const user = await getUser(userId, userContext);
    if (!user) {
      return { status: "ERROR", message: "User not found" };
    }

    const loginMethodSelectResult = await this.selectLoginMethodForPasswordChange({ user, session, userContext });
    if (loginMethodSelectResult.status !== "OK") {
      return loginMethodSelectResult;
    }

    if (!loginMethodSelectResult.loginMethod.email) {
      return { status: "ERROR", message: "User has no email login method" };
    }

    const verifyResult = await verifyCredentials(
      session!.getTenantId(),
      loginMethodSelectResult.loginMethod.email,
      currentPassword,
      userContext,
    );

    if (verifyResult.status !== "OK") {
      return { status: "ERROR", message: "Invalid password" };
    }

    const result = await updateEmailOrPassword({
      recipeUserId: loginMethodSelectResult.loginMethod.recipeUserId,
      password: newPassword,
      userContext,
    });

    if (result.status !== "OK") {
      logDebugMessage(`Could not update password: ${result.status}`);

      return {
        status: "ERROR",
        message: "Password change failed",
      };
    }

    return { status: "OK" };
  };

  unlinkThirdPartyUser = async function (
    this: Implementation,
    {
      userId,
      recipeUserId,
      session,
      userContext,
    }: {
      userId: string;
      recipeUserId: string;
      session: SessionContainerInterface;
      userContext: any;
    },
  ): Promise<{ status: "OK" } | { status: "ERROR"; message: string }> {
    const user = await getUser(userId, userContext);
    if (!user) {
      return { status: "ERROR", message: "User not found" };
    }

    const availableFirstFactors = await getAvailableFirstFactors(session!.getTenantId(), session, userContext);

    const availableUserLoginMethods = user.loginMethods.filter((lm) => lm.recipeUserId.getAsString() !== recipeUserId);
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
  };

  setOrRemoveSingleRequiredMfaFactorForUser = async function (
    this: Implementation,
    {
      userId,
      factorId,
      userContext,
    }: { userId: string; factorId?: string; session: SessionContainerInterface; userContext: any },
  ): Promise<{ status: "OK" } | { status: "ERROR"; message: string }> {
    const user = await getUser(userId, userContext);
    if (!user) {
      return { status: "ERROR", message: "User not found" };
    }

    const requiredFactorIds = await MultiFactorAuth.getRequiredSecondaryFactorsForUser(userId, userContext);
    for await (const factorId of requiredFactorIds) {
      await MultiFactorAuth.removeFromRequiredSecondaryFactorsForUser(userId, factorId, userContext);
    }

    if (factorId) {
      await MultiFactorAuth.addToRequiredSecondaryFactorsForUser(userId, factorId, userContext);
    }

    return { status: "OK" };
  };

  selectLoginMethodForOtpEmailChange = async function (
    this: Implementation,
    { user }: { user: User; session: SessionContainerInterface; userContext: any },
  ): Promise<{ status: "OK"; loginMethod: User["loginMethods"][number] } | { status: "ERROR"; message: string }> {
    const emailOtpLoginMethods = user.loginMethods.filter((lm) => lm.recipeId === "passwordless" && lm.email);

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

    return { status: "OK", loginMethod: emailOtpLoginMethods[0]! };
  };

  // todo email validation?
  changeOtpEmailForUser = async function (
    this: Implementation,
    {
      userId,
      email,
      userContext,
      session,
    }: { userId: string; email: string; userContext: any; session: SessionContainerInterface },
  ): Promise<{ status: "OK" } | { status: "ERROR"; message: string }> {
    const user = await getUser(userId, userContext);
    if (!user) {
      return { status: "ERROR", message: "User not found" };
    }

    const emailOtpLoginMethods = user.loginMethods.filter((lm) => lm.recipeId === "passwordless" && lm.email);
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
    const loginMethodSelectResult = await this.selectLoginMethodForOtpEmailChange({ user, session, userContext });
    if (loginMethodSelectResult.status !== "OK") {
      return loginMethodSelectResult;
    }

    const result = await Passwordless.updateUser({
      recipeUserId: loginMethodSelectResult.loginMethod.recipeUserId,
      email: email,
      userContext,
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
  };

  getRequiredSecondaryFactorsForUser = async function (
    this: Implementation,
    { userId, userContext }: { userId: string; userContext: any; session: SessionContainerInterface },
  ): Promise<{ status: "OK"; requiredSecondaryFactors: string[] } | { status: "ERROR"; message: string }> {
    const user = await getUser(userId, userContext);
    if (!user) {
      return { status: "ERROR", message: "User not found" };
    }

    const requiredSecondaryFactors = await MultiFactorAuth.getRequiredSecondaryFactorsForUser(user.id, userContext);

    return {
      status: "OK",
      requiredSecondaryFactors,
    };
  };

  selectLoginMethodForOtpPhoneNumberChange = async function (
    this: Implementation,
    { user }: { user: User; session: SessionContainerInterface; userContext: any },
  ): Promise<{ status: "OK"; loginMethod: User["loginMethods"][number] } | { status: "ERROR"; message: string }> {
    const phoneOtpLoginMethods = user.loginMethods.filter((lm) => lm.recipeId === "passwordless" && lm.phoneNumber);

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

    return { status: "OK", loginMethod: phoneOtpLoginMethods[0]! };
  };

  sendSmsOtpForUserPhoneNumberChange = async function (
    this: Implementation,
    {
      userId,
      phoneNumber,
      userContext,
      session,
    }: { userId: string; phoneNumber: string; userContext: any; session: SessionContainerInterface },
  ): Promise<{ status: "OK"; deviceId: string; preAuthSessionId: string } | { status: "ERROR"; message: string }> {
    const user = await getUser(userId, userContext);
    if (!user) {
      return { status: "ERROR", message: "User not found" };
    }

    const loginMethodSelectResult = await this.selectLoginMethodForOtpPhoneNumberChange({ user, session, userContext });
    if (loginMethodSelectResult.status !== "OK") {
      return loginMethodSelectResult;
    }

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
      codeLifetime: DEFAULT_SMS_CODE_LIFETIME_FOR_OTP_PHONE_CHANGE,
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
  };

  changeOtpPhoneNumberForUser = async function (
    this: Implementation,
    {
      userId,
      phoneNumber,
      deviceId,
      preAuthSessionId,
      code,
      userContext,
      session,
    }: {
      userId: string;
      phoneNumber: string;
      deviceId: string;
      preAuthSessionId: string;
      code: string;
      userContext: any;
      session: SessionContainerInterface;
    },
  ): Promise<{ status: "OK" } | { status: "ERROR"; message: string }> {
    const user = await getUser(userId, userContext);
    if (!user) {
      return { status: "ERROR", message: "User not found" };
    }

    const loginMethodSelectResult = await this.selectLoginMethodForOtpPhoneNumberChange({ user, session, userContext });
    if (loginMethodSelectResult.status !== "OK") {
      return loginMethodSelectResult;
    }

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
      recipeUserId: loginMethodSelectResult.loginMethod.recipeUserId,
      phoneNumber: checkResult.consumedDevice.phoneNumber,
      userContext,
    });
    if (updateResult.status !== "OK") {
      return {
        status: "ERROR",
        message: "Failed to update phone OTP login method",
      };
    }

    try {
      await Passwordless.revokeAllCodes({
        phoneNumber: checkResult.consumedDevice.phoneNumber,
        tenantId: session!.getTenantId(),
        userContext,
      });
    } catch (error) {
      logDebugMessage(
        `Failed to revoke all codes: ${error}. It doesn't matter it failed, since the code we'll be revoked anyway after a specific time.`,
      );
    }

    return {
      status: "OK",
    };
  };

  renameOtpTotpDeviceForUser = async function (
    this: Implementation,
    {
      userId,
      name,
      newName,
      userContext,
    }: { userId: string; name: string; newName: string; userContext: any; session: SessionContainerInterface },
  ): Promise<{ status: "OK" } | { status: "ERROR"; message: string }> {
    const user = await getUser(userId, userContext);
    if (!user) {
      return { status: "ERROR", message: "User not found" };
    }

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
  };

  getUser = async function (
    this: Implementation,
    { userId, userContext }: { userId: string; userContext: any; session: SessionContainerInterface },
  ): Promise<{ status: "OK"; user: any } | { status: "ERROR"; message: string }> {
    const user = await getUser(userId, userContext);
    if (!user) {
      return { status: "ERROR", message: "User not found" };
    }

    return {
      status: "OK",
      user: user.toJson(),
    };
  };
}

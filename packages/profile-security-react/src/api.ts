import { getQuerier } from "@shared/react";

export const getApi = (querier: ReturnType<typeof getQuerier>) => {
  const getConfig = async () => {
    return await querier.get<{
      status: "OK" | "ERROR";
      message?: string;
      config: {
        enableSettingPassword: boolean;
        enableThirdPartyLinkning: boolean;
        enableMfaConfiguration: boolean;
      };
    }>("/config", { withSession: true });
  };

  const getUserInfo = async () => {
    return await querier.get<{
      user: any;
      status: "OK" | "ERROR";
      message?: string;
      mfa: { requiredSecondaryFactors: any[] };
    }>("/user", {
      withSession: true,
    });
  };

  const setPassword = async (payload: { newPassword: string; email: string }) => {
    return await querier.post<{ status: "OK" } | { status: "ERROR"; message: string }>("/password/set", payload, {
      withSession: true,
    });
  };

  const changePassword = async (currentPassword: string, newPassword: string) => {
    return await querier.post<{ status: "OK" } | { status: "ERROR"; message: string }>(
      "/password/change",
      {
        currentPassword,
        newPassword,
      },
      {
        withSession: true,
      },
    );
  };

  const unlinkAccount = async (recipeUserId: string) => {
    return await querier.post<{ status: "OK" } | { status: "ERROR"; message: string }>(
      "/user/unlink",
      {
        recipeUserId,
      },
      {
        withSession: true,
      },
    );
  };

  const getMfaInfo = async () => {
    return await querier.get<{
      status: "OK" | "ERROR";
      message?: string;
      requiredSecondaryFactors: any[];
    }>("/mfa", {
      withSession: true,
    });
  };

  const setRequiredSecondaryFactor = async (factorId?: string) => {
    return await querier.post<{ status: "OK" } | { status: "ERROR"; message: string }>(
      "/mfa/set-required",
      {
        factorId,
      },
      {
        withSession: true,
      },
    );
  };

  const updateMfaOtpEmail = async (email: string) => {
    return await querier.post<{ status: "OK" } | { status: "ERROR"; message: string }>(
      "/mfa/update-otp-email",
      { email },
      { withSession: true },
    );
  };

  const updateMfaOtpPhoneNumber = async (payload: {
    phoneNumber: string;
    code: string;
    deviceId: string;
    preAuthSessionId: string;
  }) => {
    return await querier.post<{ status: "OK" } | { status: "ERROR"; message: string }>(
      "/mfa/update-otp-phone-number",
      payload,
      { withSession: true },
    );
  };

  const sendMfaOtpPhoneNumberCode = async (phoneNumber: string) => {
    return await querier.post<
      { status: "OK"; deviceId: string; preAuthSessionId: string } | { status: "ERROR"; message: string }
    >("/mfa/update-otp-phone-number/code", { phoneNumber }, { withSession: true });
  };

  const updateMfaTotpName = async (payload: { name: string; newName: string }) => {
    return await querier.post<{ status: "OK" } | { status: "ERROR"; message: string }>("/mfa/update-totp", payload, {
      withSession: true,
    });
  };

  return {
    getConfig,
    getUserInfo,
    setPassword,
    changePassword,
    unlinkAccount,
    getMfaInfo,
    setRequiredSecondaryFactor,
    updateMfaOtpEmail,
    sendMfaOtpPhoneNumberCode,
    updateMfaOtpPhoneNumber,
    updateMfaTotpName,
  };
};

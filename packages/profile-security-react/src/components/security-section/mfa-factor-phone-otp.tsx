import { Button, usePrettyAction, TextInput } from "@shared/ui";
import classNames from "classnames/bind";
import { useState, useMemo, useCallback } from "react";
import { consumeCode, createCode } from "supertokens-auth-react/recipe/passwordless/index.js";
import { User } from "supertokens-web-js/types";

import { logDebugMessage } from "../../logger";
import { usePluginContext } from "../../plugin";
import { FormActions } from "../form-actions";
import { FormRow } from "../form-item";

import style from "./security-section.module.css";

const cx = classNames.bind(style);

export const MfaFactorPhoneOtpConfig = ({ user, onSuccess }: { user: User; onSuccess: () => Promise<any> }) => {
  const { api, t } = usePluginContext();

  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState<string>("");
  const [codeDetails, setCodeDetails] = useState<{
    deviceId: string;
    preAuthSessionId: string;
  }>();

  const loginMethod = useMemo(() => {
    const loginMethods = user.loginMethods.filter((lm) => lm.recipeId === "passwordless" && lm.phoneNumber);
    if (loginMethods.length === 0) {
      logDebugMessage("User has no phone OTP login method");
      return null;
    }
    if (loginMethods.length > 1) {
      logDebugMessage("User has multiple phone OTP login methods");
      return null;
    }

    return loginMethods[0];
  }, [user]);

  const currentPhoneNumber = useMemo(() => {
    return loginMethod?.phoneNumber;
  }, [loginMethod]);

  const [selectedPhoneNumber, setSelectedPhoneNumber] = useState<string>(currentPhoneNumber || "");

  const resetCode = useCallback(() => {
    setCodeSent(false);
    setCode("");
    setCodeDetails(undefined);
  }, []);

  const sendCode = usePrettyAction(
    async () => {
      if (selectedPhoneNumber === currentPhoneNumber) {
        return;
      }

      resetCode();

      const res = await api.sendMfaOtpPhoneNumberCode(selectedPhoneNumber);
      if (res.status !== "OK") {
        throw new Error(res.message);
      }
      setCodeDetails({
        deviceId: res.deviceId,
        preAuthSessionId: res.preAuthSessionId,
      });

      setCodeSent(true);
    },
    [currentPhoneNumber, api, selectedPhoneNumber],
    {
      successMessage: t("PL_SEC_MFA_CHANGE_PHONE_NUMBER_SUCCESS_SEND_CODE"),
      errorMessage: t("PL_SEC_MFA_CHANGE_PHONE_NUMBER_ERROR_SEND_CODE"),
      onSuccess: onSuccess,
      onError: async () => {
        resetCode();
      },
    },
  );

  const changePhoneNumber = usePrettyAction(
    async () => {
      if (!selectedPhoneNumber) {
        return;
      }
      if (selectedPhoneNumber === currentPhoneNumber) {
        return;
      }
      if (!codeDetails) {
        return;
      }

      const res = await api.updateMfaOtpPhoneNumber({
        phoneNumber: selectedPhoneNumber,
        code,
        deviceId: codeDetails!.deviceId,
        preAuthSessionId: codeDetails!.preAuthSessionId,
      });
      if (res.status !== "OK") {
        throw new Error(res.message);
      }

      resetCode();
    },
    [currentPhoneNumber, api, selectedPhoneNumber, codeDetails, code],
    {
      successMessage: t("PL_SEC_MFA_CHANGE_PHONE_NUMBER_SUCCESS_CHANGE"),
      errorMessage: t("PL_SEC_MFA_CHANGE_PHONE_NUMBER_ERROR_CHANGE"),
      onSuccess,
    },
  );

  if (!loginMethod) {
    return <div>{t("PL_SEC_MFA_ERROR_WRONG_CONFIGURATION")}</div>;
  }

  return (
    <div className={cx("supertokens-plugin-profile-security-second-factor-manage")}>
      {!codeSent && (
        <>
          <FormRow label={t("PL_SEC_MFA_CHANGE_PHONE_NUMBER_LABEL")}>
            <TextInput
              id="change-phone-number"
              value={selectedPhoneNumber}
              type="tel"
              onChange={(value) => {
                if (!value) {
                  return;
                }
                setSelectedPhoneNumber(value as string);
              }}
            />
          </FormRow>

          <br />

          <FormActions>
            <Button
              onClick={sendCode}
              disabled={selectedPhoneNumber === currentPhoneNumber}
              size="small"
              variant="brand"
              appearance="accent">
              {t("PL_SEC_MFA_CHANGE_PHONE_NUMBER_SEND_CODE_BUTTON")}
            </Button>
          </FormActions>
        </>
      )}

      {codeSent && (
        <>
          <FormRow label={t("PL_SEC_MFA_CHANGE_PHONE_NUMBER_CODE_LABEL")}>
            <TextInput
              id="code"
              placeholder={t("PL_SEC_MFA_CHANGE_PHONE_NUMBER_CODE_PLACEHOLDER")}
              value={code}
              onChange={(value) => setCode(value as string)}
            />
          </FormRow>

          <br />

          <FormActions>
            <Button onClick={changePhoneNumber} size="small" variant="brand" appearance="accent">
              {t("PL_SEC_MFA_CHANGE_PHONE_NUMBER_CHANGE_BUTTON")}
            </Button>
          </FormActions>
        </>
      )}
    </div>
  );
};

export const MfaFactorPhoneOtpSetup = ({ user, onSuccess }: { user: User; onSuccess: () => Promise<any> }) => {
  const { api, t } = usePluginContext();

  const alreadySetupLoginMethod = useMemo(() => {
    const loginMethods = user.loginMethods.filter((lm) => lm.recipeId === "passwordless" && lm.phoneNumber);
    return loginMethods[0];
  }, [user]);

  const [phoneNumber, setPhoneNumber] = useState<string>(alreadySetupLoginMethod?.phoneNumber || "");
  const [smsSent, setSmsSent] = useState<boolean>(false);
  const [otp, setOtp] = useState<string>("");

  const sendSms = usePrettyAction(
    async () => {
      setSmsSent(false);
      setOtp("");

      if (!phoneNumber?.trim()) {
        throw new Error(t("PL_SEC_MFA_SETUP_PHONE_ERROR_PHONE_NUMBER_INVALID"));
      }
      const res = await createCode({
        phoneNumber,
        shouldTryLinkingWithSessionUser: true,
      });

      if (res.status !== "OK") {
        console.error(res);
        throw new Error(t("PL_SEC_MFA_SETUP_PHONE_ERROR_SEND"));
      }

      setSmsSent(true);
    },
    [phoneNumber, api],
    {
      successMessage: t("PL_SEC_MFA_SETUP_PHONE_SUCCESS_SEND"),
    },
  );

  const verifyOtp = usePrettyAction(
    async () => {
      if (!otp) {
        return;
      }

      const res = await consumeCode({
        userInputCode: otp,
      });
      if (res.status !== "OK") {
        console.error(res);
        throw new Error(t("PL_SEC_MFA_SETUP_PHONE_ERROR_VERIFY"));
      }

      setOtp("");
    },
    [otp, api, onSuccess],
    {
      successMessage: t("PL_SEC_MFA_SETUP_PHONE_SUCCESS_VERIFY"),
      onSuccess: onSuccess,
    },
  );

  return (
    <div className={cx("supertokens-plugin-profile-security-second-factor-manage")}>
      {!smsSent && (
        <>
          <FormRow label={t("PL_SEC_MFA_SETUP_PHONE_LABEL")}>
            <TextInput
              placeholder={t("PL_SEC_MFA_SETUP_PHONE_PLACEHOLDER")}
              type="tel"
              id="change-phone"
              value={phoneNumber}
              disabled={Boolean(alreadySetupLoginMethod)}
              onChange={(value) => {
                if (!value) {
                  return;
                }
                setPhoneNumber(value);
              }}
            />
          </FormRow>

          <br />

          <FormActions>
            <Button onClick={sendSms} appearance="accent" variant="brand" size="small">
              {t("PL_SEC_MFA_SETUP_PHONE_SEND_BUTTON")}
            </Button>
          </FormActions>
        </>
      )}

      {smsSent && (
        <>
          <FormRow label={t("PL_SEC_MFA_SETUP_PHONE_CODE_LABEL")}>
            <TextInput
              placeholder={t("PL_SEC_MFA_SETUP_PHONE_CODE_PLACEHOLDER")}
              type="text"
              id="code"
              value={otp}
              onChange={(value) => {
                if (!value) {
                  return;
                }
                setOtp(value);
              }}
            />
          </FormRow>

          <br />

          <FormActions>
            <Button onClick={verifyOtp} size="small" variant="brand" appearance="accent">
              {t("PL_SEC_MFA_SETUP_PHONE_VERIFY_BUTTON")}
            </Button>
          </FormActions>
        </>
      )}
    </div>
  );
};

export default {
  Config: MfaFactorPhoneOtpConfig,
  Setup: MfaFactorPhoneOtpSetup,
};

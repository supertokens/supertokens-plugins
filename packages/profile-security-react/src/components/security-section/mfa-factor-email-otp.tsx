import { Button, usePrettyAction, SelectInput, TextInput } from "@shared/ui";
import classNames from "classnames/bind";
import { useState, useMemo } from "react";
import { consumeCode, createCode } from "supertokens-auth-react/recipe/passwordless/index.js";
import { User } from "supertokens-web-js/types";

import { usePluginContext } from "../../plugin";

import style from "./security-section.module.css";

const cx = classNames.bind(style);

export const MfaFactorEmailOtpConfig = ({ user, onSuccess }: { user: User; onSuccess: () => Promise<any> }) => {
  const { api, t } = usePluginContext();

  const loginMethod = useMemo(() => {
    const loginMethods = user.loginMethods.filter((lm) => lm.recipeId === "passwordless" && lm.email);
    if (loginMethods.length === 0) {
      console.warn("User has no email OTP login method");
      return null;
    }
    if (loginMethods.length > 1) {
      console.warn("User has multiple email OTP login methods");
      return null;
    }

    return loginMethods[0];
  }, [user]);

  const currentEmail = useMemo(() => {
    return loginMethod?.email;
  }, [loginMethod]);

  const [selectedEmail, setSelectedEmail] = useState<string>(currentEmail || "");

  const changeEmail = usePrettyAction(
    async () => {
      if (!selectedEmail) {
        return;
      }
      if (selectedEmail === currentEmail) {
        return;
      }
      const res = await api.updateMfaOtpEmail(selectedEmail);
      if (res.status !== "OK") {
        throw new Error(res.message);
      }
    },
    [currentEmail, api, selectedEmail],
    {
      successMessage: t("PL_SEC_MFA_CHANGE_EMAIL_SUCCESS_CHANGE"),
      errorMessage: t("PL_SEC_MFA_CHANGE_EMAIL_ERROR_CHANGE"),
      onSuccess: onSuccess,
    },
  );

  if (!loginMethod) {
    return <div>{t("PL_SEC_MFA_ERROR_WRONG_CONFIGURATION")}</div>;
  }

  return (
    <div className={cx("plugin-profile-security-second-factor-manage")}>
      <SelectInput
        label={t("PL_SEC_MFA_CHANGE_EMAIL_LABEL")}
        id="change-email"
        value={selectedEmail}
        onChange={(value) => {
          if (!value) {
            return;
          }
          setSelectedEmail(value as string);
        }}
        options={user.emails.map((email) => ({ label: email, value: email }))}
      />
      <Button style={{ marginTop: "16px" }} onClick={changeEmail} size="small" variant="brand" appearance="accent">
        {t("PL_SEC_MFA_CHANGE_EMAIL_BUTTON")}
      </Button>
    </div>
  );
};

export const MfaFactorEmailOtpSetup = ({ user, onSuccess }: { user: User; onSuccess: () => Promise<any> }) => {
  const { api, t } = usePluginContext();

  const alreadySetupLoginMethod = useMemo(() => {
    const loginMethods = user.loginMethods.filter((lm) => lm.recipeId === "passwordless" && lm.email);
    return loginMethods[0];
  }, [user]);

  const [email, setEmail] = useState<string>(alreadySetupLoginMethod?.email || "");
  const [emailSent, setEmailSent] = useState<boolean>(false);
  const [otp, setOtp] = useState<string>("");

  const availableEmails = useMemo(() => {
    return user.emails.map((email) => ({ label: email, value: email }));
  }, [user]);

  const sendEmail = usePrettyAction(
    async () => {
      setEmailSent(false);
      setOtp("");

      if (!email?.trim()) {
        throw new Error(t("PL_SEC_MFA_SETUP_EMAIL_ERROR_EMAIL_INVALID"));
      }
      const res = await createCode({
        email,
        shouldTryLinkingWithSessionUser: true,
      });

      if (res.status !== "OK") {
        console.error(res);
        throw new Error(t("PL_SEC_MFA_SETUP_EMAIL_ERROR_SEND"));
      }

      setEmailSent(true);
    },
    [email, api],
    {
      successMessage: t("PL_SEC_MFA_SETUP_EMAIL_SUCCESS_SEND"),
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
        throw new Error(t("PL_SEC_MFA_SETUP_EMAIL_ERROR_VERIFY"));
      }

      setOtp("");
    },
    [otp, api, onSuccess],
    {
      successMessage: t("PL_SEC_MFA_SETUP_EMAIL_SUCCESS_VERIFY"),
      onSuccess: onSuccess,
    },
  );

  return (
    <div className={cx("plugin-profile-security-second-factor-manage")}>
      {!emailSent ? (
        <>
          {availableEmails.length > 0 ? (
            <SelectInput
              label={t("PL_SEC_MFA_SETUP_EMAIL_LABEL")}
              placeholder={t("PL_SEC_MFA_SETUP_EMAIL_PLACEHOLDER")}
              id="setup-email"
              value={email}
              disabled={Boolean(alreadySetupLoginMethod)}
              onChange={(value) => {
                if (!value) {
                  return;
                }
                setEmail(value);
              }}
              options={availableEmails}
            />
          ) : (
            <TextInput
              label={t("PL_SEC_MFA_SETUP_EMAIL_LABEL")}
              placeholder={t("PL_SEC_MFA_SETUP_EMAIL_PLACEHOLDER")}
              type="email"
              id="change-email"
              value={email}
              onChange={(value) => {
                if (!value) {
                  return;
                }
                setEmail(value);
              }}
            />
          )}

          <Button style={{ marginTop: "16px" }} onClick={sendEmail} size="small" variant="brand" appearance="accent">
            {t("PL_SEC_MFA_SETUP_EMAIL_SEND_BUTTON")}
          </Button>
        </>
      ) : (
        <>
          <TextInput
            label={t("PL_SEC_MFA_SETUP_EMAIL_CODE_LABEL")}
            placeholder={t("PL_SEC_MFA_SETUP_EMAIL_CODE_PLACEHOLDER")}
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

          <Button style={{ marginTop: "16px" }} onClick={verifyOtp} size="small" variant="brand" appearance="accent">
            {t("PL_SEC_MFA_SETUP_EMAIL_VERIFY_BUTTON")}
          </Button>
        </>
      )}
    </div>
  );
};

export default {
  Config: MfaFactorEmailOtpConfig,
  Setup: MfaFactorEmailOtpSetup,
};

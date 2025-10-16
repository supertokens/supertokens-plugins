import { Button, usePrettyAction, SelectInput, TextInput } from "@shared/ui";
import classNames from "classnames/bind";
import { useState, useMemo } from "react";
import { consumeCode, createCode } from "supertokens-auth-react/recipe/passwordless/index.js";
import { User } from "supertokens-web-js/types";

import { logDebugMessage } from "../../logger";
import { usePluginContext } from "../../plugin";
import { FormActions } from "../form-actions";
import { FormRow } from "../form-item";

import style from "./security-section.module.css";

const cx = classNames.bind(style);

export const MfaFactorEmailOtpConfig = ({ user, onSuccess }: { user: User; onSuccess: () => Promise<any> }) => {
  const { api, t } = usePluginContext();

  const loginMethod = useMemo(() => {
    const loginMethods = user.loginMethods.filter((lm) => lm.recipeId === "passwordless" && lm.email);
    if (loginMethods.length === 0) {
      logDebugMessage("User has no email OTP login method");
      return null;
    }
    if (loginMethods.length > 1) {
      logDebugMessage("User has multiple email OTP login methods");
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
    return (
      <div className={cx("supertokens-plugin-profile-security-second-factor-manage")}>
        {t("PL_SEC_MFA_ERROR_WRONG_CONFIGURATION")}
      </div>
    );
  }

  return (
    <div className={cx("supertokens-plugin-profile-security-second-factor-manage")}>
      <FormRow label={t("PL_SEC_MFA_CHANGE_EMAIL_LABEL")}>
        <SelectInput
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
      </FormRow>

      <br />

      <FormActions>
        <Button onClick={changeEmail} size="small" variant="brand" appearance="accent">
          {t("PL_SEC_MFA_CHANGE_EMAIL_BUTTON")}
        </Button>
      </FormActions>
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
    <div className={cx("supertokens-plugin-profile-security-second-factor-manage")}>
      {!emailSent && (
        <>
          <FormRow label={t("PL_SEC_MFA_SETUP_EMAIL_LABEL")}>
            {availableEmails.length > 0 ? (
              <SelectInput
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
          </FormRow>

          <br />

          <FormActions>
            <Button onClick={sendEmail} size="small" variant="brand" appearance="accent">
              {t("PL_SEC_MFA_SETUP_EMAIL_SEND_BUTTON")}
            </Button>
          </FormActions>
        </>
      )}

      {emailSent && (
        <>
          <FormRow label={t("PL_SEC_MFA_SETUP_EMAIL_CODE_LABEL")}>
            <TextInput
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
          </FormRow>

          <br />

          <FormActions>
            <Button onClick={verifyOtp} size="small" variant="brand" appearance="accent">
              {t("PL_SEC_MFA_SETUP_EMAIL_VERIFY_BUTTON")}
            </Button>
          </FormActions>
        </>
      )}
    </div>
  );
};

export default {
  Config: MfaFactorEmailOtpConfig,
  Setup: MfaFactorEmailOtpSetup,
};

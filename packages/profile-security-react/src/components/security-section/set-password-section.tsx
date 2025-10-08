import { Button, SelectInput, PasswordInput, useToast, usePrettyAction } from "@shared/ui";
import classNames from "classnames/bind";
import { useCallback, useEffect, useState } from "react";
import { User } from "supertokens-web-js/types";

import { usePluginContext } from "../../plugin";

import style from "./security-section.module.css";

const cx = classNames.bind(style);

export const SetPasswordSection = ({
  user,
  isLoading,
  setIsLoading,
  onSuccess,
}: {
  user: User;
  isLoading: boolean;
  setIsLoading: (isLoading: boolean) => void;
  onSuccess: () => Promise<any>;
}) => {
  const [passwordSetEmail, setPasswordSetEmail] = useState<string>("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [confirmPasswordError, setConfirmPasswordError] = useState("");
  const [passwordInputVisible, setPasswordInputVisible] = useState(false);

  const { api, t } = usePluginContext();
  const { addToast } = useToast();

  const handleShowPasswordInput = useCallback(() => {
    setPasswordInputVisible(true);
  }, []);

  const handleHidePasswordInput = useCallback(() => {
    setPasswordInputVisible(false);
    setNewPassword("");
    setConfirmPassword("");
    setConfirmPasswordError("");
  }, []);

  const setPassword = usePrettyAction(
    async () => {
      const res = await api.setPassword({
        newPassword,
        email: passwordSetEmail,
      });
      if (res.status !== "OK") {
        throw new Error(res.message);
      }

      setNewPassword("");
    },
    [newPassword, addToast, passwordSetEmail],
    {
      errorMessage: t("PL_SEC_SET_PASSWORD_ERROR_MESSAGE"),
      successMessage: t("PL_SEC_SET_PASSWORD_SUCCESS_MESSAGE"),
      onSuccess: onSuccess,
      setLoading: setIsLoading,
    },
  );

  useEffect(() => {
    if (!newPassword || !confirmPassword) {
      setConfirmPasswordError("");
      return;
    }

    if (newPassword !== confirmPassword) {
      setConfirmPasswordError(t("PL_SEC_SET_PASSWORD_CONFIRM_PASSWORD_ERROR"));
    } else {
      setConfirmPasswordError("");
    }
  }, [newPassword, confirmPassword, t]);

  useEffect(() => {
    if (!user) {
      return;
    }

    if (!user.loginMethods.find((lm: any) => lm.recipeId === "emailpassword") && user.emails.length) {
      setPasswordSetEmail(user.emails?.[0] ?? "");
    }
  }, [user]);

  if (!user) {
    return null;
  }

  return (
    <form className={cx("supertokens-plugin-profile-security-edit-form")}>
      <div className={cx("supertokens-plugin-profile-security-item")}>
        <span className={cx("supertokens-plugin-profile-security-label")}>
          {t("PL_SEC_SET_PASSWORD_SELECT_EMAIL_LABEL")}
        </span>

        <span className={cx("supertokens-plugin-profile-security-value")}>
          <SelectInput
            id="change-email"
            value={passwordSetEmail}
            onChange={(value) => {
              if (!value) {
                return;
              }
              setPasswordSetEmail(value as string);
            }}
            options={user?.emails.map((email) => ({ label: email, value: email })) ?? []}
            disabled={(user?.emails.length ?? 0) <= 1}
          />
        </span>
      </div>

      <div className={cx("supertokens-plugin-profile-security-item")}>
        <span className={cx("supertokens-plugin-profile-security-label")}>
          {t("PL_SEC_SET_PASSWORD_PASSWORD_LABEL")}
        </span>

        <span className={cx("supertokens-plugin-profile-security-value")}>
          {passwordInputVisible ? (
            <>
              <PasswordInput
                id="newPassword"
                label={t("PL_SEC_SET_PASSWORD_NEW_PASSWORD_LABEL")}
                placeholder={t("PL_SEC_SET_PASSWORD_PASSWORD_PLACEHOLDER")}
                value={newPassword}
                onChange={setNewPassword}
                required={true}
              />
              <br />
              <PasswordInput
                id="confirmPassword"
                label={t("PL_SEC_SET_PASSWORD_CONFIRM_PASSWORD_LABEL")}
                placeholder={t("PL_SEC_SET_PASSWORD_CONFIRM_PASSWORD_PLACEHOLDER")}
                value={confirmPassword}
                onChange={setConfirmPassword}
                error={confirmPasswordError}
                required={true}
              />
            </>
          ) : (
            <Button
              onClick={handleShowPasswordInput}
              disabled={isLoading}
              size="small"
              variant="brand"
              appearance="filled">
              {t("PL_SEC_SET_PASSWORD_SHOW_BUTTON")}
            </Button>
          )}
        </span>
      </div>

      {passwordInputVisible && (
        <div className={cx("supertokens-plugin-profile-security-form-actions")}>
          <Button
            onClick={handleHidePasswordInput}
            disabled={isLoading}
            size="small"
            variant="neutral"
            appearance="outlined">
            {t("PL_SEC_SET_PASSWORD_CANCEL_BUTTON")}
          </Button>
          <Button onClick={setPassword} disabled={isLoading} size="small" variant="brand" appearance="accent">
            {t("PL_SEC_SET_PASSWORD_BUTTON")}
          </Button>
        </div>
      )}
    </form>
  );
};

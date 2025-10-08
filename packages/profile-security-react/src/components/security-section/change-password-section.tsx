import { Button, PasswordInput, useToast, usePrettyAction } from "@shared/ui";
import classNames from "classnames/bind";
import { useState, useCallback, useEffect } from "react";

import { usePluginContext } from "../../plugin";

import style from "./security-section.module.css";

const cx = classNames.bind(style);

export const ChangePasswordSection = ({
  isLoading,
  setIsLoading,
}: {
  isLoading: boolean;
  setIsLoading: (isLoading: boolean) => void;
}) => {
  const [currentPassword, setCurrentPassword] = useState("");
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
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setConfirmPasswordError("");
  }, []);

  const changePassword = usePrettyAction(
    async () => {
      const res = await api.changePassword(currentPassword, newPassword);
      if (res.status !== "OK") {
        throw new Error(res.message);
      }

      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setConfirmPasswordError("");
      setPasswordInputVisible(false);
    },
    [currentPassword, newPassword, addToast],
    {
      errorMessage: t("PL_SEC_CHANGE_PASSWORD_ERROR_CHANGE"),
      successMessage: t("PL_SEC_CHANGE_PASSWORD_SUCCESS_CHANGE"),
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

  return (
    <form className={cx("supertokens-plugin-profile-security-edit-form")}>
      <div className={cx("supertokens-plugin-profile-security-item")}>
        <span className={cx("supertokens-plugin-profile-security-label")}>{t("PL_SEC_CHANGE_PASSWORD_LABEL")}</span>
        <span className={cx("supertokens-plugin-profile-security-value")}>
          {passwordInputVisible ? (
            <>
              <PasswordInput
                id="currentPassword"
                required
                label={t("PL_SEC_CURRENT_PASSWORD_LABEL")}
                placeholder={t("PL_SEC_CURRENT_PASSWORD_PLACEHOLDER")}
                value={currentPassword}
                onChange={setCurrentPassword}
              />
              <br />
              <PasswordInput
                id="newPassword"
                required
                label={t("PL_SEC_NEW_PASSWORD_LABEL")}
                placeholder={t("PL_SEC_NEW_PASSWORD_PLACEHOLDER")}
                value={newPassword}
                onChange={setNewPassword}
              />
              <br />
              <PasswordInput
                id="confirmPassword"
                required
                label={t("PL_SEC_CHANGE_PASSWORD_CONFIRM_PASSWORD_LABEL")}
                placeholder={t("PL_SEC_CHANGE_PASSWORD_CONFIRM_PASSWORD_PLACEHOLDER")}
                value={confirmPassword}
                onChange={setConfirmPassword}
                error={confirmPasswordError}
              />
            </>
          ) : (
            <Button
              onClick={handleShowPasswordInput}
              disabled={isLoading}
              size="small"
              variant="brand"
              appearance="filled">
              {t("PL_SEC_CHANGE_PASSWORD_SHOW_BUTTON")}
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
            {t("PL_SEC_CHANGE_PASSWORD_CANCEL_BUTTON")}
          </Button>
          <Button onClick={changePassword} disabled={isLoading} size="small" variant="brand" appearance="accent">
            {t("PL_SEC_CHANGE_PASSWORD_BUTTON")}
          </Button>
        </div>
      )}
    </form>
  );
};

import { Button, PasswordInput, useToast, usePrettyAction } from "@shared/ui";
import classNames from "classnames/bind";
import { useState } from "react";

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

  const { api, t } = usePluginContext();
  const { addToast } = useToast();

  const changePassword = usePrettyAction(
    async () => {
      const res = await api.changePassword(currentPassword, newPassword);
      if (res.status !== "OK") {
        throw new Error(res.message);
      }

      setCurrentPassword("");
      setNewPassword("");
    },
    [currentPassword, newPassword, addToast],
    {
      errorMessage: t("PL_SEC_CHANGE_PASSWORD_ERROR_CHANGE"),
      successMessage: t("PL_SEC_CHANGE_PASSWORD_SUCCESS_CHANGE"),
      setLoading: setIsLoading,
    },
  );

  return (
    <form className={cx("plugin-profile-details-edit-form")}>
      <PasswordInput
        id="currentPassword"
        label={t("PL_SEC_CURRENT_PASSWORD_LABEL")}
        placeholder={t("PL_SEC_CURRENT_PASSWORD_PLACEHOLDER")}
        value={currentPassword}
        onChange={setCurrentPassword}
      />
      <br />
      <PasswordInput
        id="newPassword"
        label={t("PL_SEC_NEW_PASSWORD_LABEL")}
        placeholder={t("PL_SEC_NEW_PASSWORD_PLACEHOLDER")}
        value={newPassword}
        onChange={setNewPassword}
      />
      <br />
      <div className={cx("plugin-profile-details-form-actions")}>
        <Button onClick={changePassword} disabled={isLoading} size="small" variant="brand" appearance="accent">
          {t("PL_SEC_CHANGE_PASSWORD_BUTTON")}
        </Button>
      </div>
    </form>
  );
};

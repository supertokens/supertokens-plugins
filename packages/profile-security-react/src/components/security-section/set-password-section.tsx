import { Button, SelectInput, PasswordInput, useToast, usePrettyAction } from "@shared/ui";
import classNames from "classnames/bind";
import { useEffect, useState } from "react";
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

  const { api, t } = usePluginContext();
  const { addToast } = useToast();

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
    <form className={cx("plugin-profile-details-edit-form")}>
      <SelectInput
        label={t("PL_SEC_SET_PASSWORD_SELECT_EMAIL_LABEL")}
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
      <br />
      <PasswordInput
        id="newPassword"
        label={t("PL_SEC_SET_PASSWORD_PASSWORD_LABEL")}
        placeholder={t("PL_SEC_SET_PASSWORD_PASSWORD_PLACEHOLDER")}
        value={newPassword}
        onChange={setNewPassword}
      />
      <br />
      <div className={cx("plugin-profile-details-form-actions")}>
        <Button onClick={setPassword} disabled={isLoading} size="small" variant="brand" appearance="accent">
          {t("PL_SEC_SET_PASSWORD_BUTTON")}
        </Button>
      </div>
    </form>
  );
};

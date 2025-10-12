import { Button, SelectInput, usePrettyAction } from "@shared/ui";
import classNames from "classnames/bind";
import { useEffect, useState } from "react";
import { registerCredentialWithSignUp } from "supertokens-auth-react/recipe/webauthn";
import { User } from "supertokens-web-js/types";

import { usePluginContext } from "../../plugin";
import { FormActions } from "../form-actions";
import { FormRow } from "../form-item";

import style from "./security-section.module.css";

const cx = classNames.bind(style);
export const SetWebAuthnSection = ({
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
  const [webauthnSetEmail, setWebauthnSetEmail] = useState<string>("");

  const { t } = usePluginContext();

  const setWebauthn = usePrettyAction(
    async () => {
      await registerCredentialWithSignUp({
        email: webauthnSetEmail,
        userContext: {},
      });
    },
    [webauthnSetEmail],
    {
      successMessage: t("PL_SEC_SET_WEBAUTHN_SUCCESS_SET_CREDENTIAL"),
      errorMessage: t("PL_SEC_SET_WEBAUTHN_ERROR_SET_CREDENTIAL"),
      onSuccess,
      setLoading: setIsLoading,
    },
  );

  useEffect(() => {
    if (!user) {
      return;
    }

    if (!user.loginMethods.find((lm: any) => lm.recipeId === "webauthn") && user.emails.length) {
      setWebauthnSetEmail(user.emails?.[0] ?? "");
    }
  }, [user]);

  if (!user) {
    return null;
  }

  return (
    <form className={cx("supertokens-plugin-profile-security-form")}>
      <FormRow label={t("PL_SEC_SET_WEBAUTHN_SELECT_EMAIL_LABEL")}>
        <SelectInput
          id="change-email"
          value={webauthnSetEmail}
          onChange={(value) => {
            if (!value) {
              return;
            }
            setWebauthnSetEmail(value as string);
          }}
          options={user?.emails.map((email) => ({ label: email, value: email })) ?? []}
          disabled={(user?.emails.length ?? 0) <= 1}
        />
      </FormRow>

      <FormActions>
        <Button onClick={setWebauthn} disabled={isLoading} size="small" variant="brand" appearance="accent">
          {t("PL_SEC_SET_WEBAUTHN_BUTTON")}
        </Button>
      </FormActions>
    </form>
  );
};

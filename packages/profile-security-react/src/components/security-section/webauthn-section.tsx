import { Button, SelectInput, usePrettyAction } from "@shared/ui";
import classNames from "classnames/bind";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listCredentials,
  removeCredential,
  createAndRegisterCredentialForSessionUser,
} from "supertokens-auth-react/recipe/webauthn";
import { User } from "supertokens-web-js/types";

import { usePluginContext } from "../../plugin";

import style from "./security-section.module.css";

const cx = classNames.bind(style);
export const WebauthnSection = ({
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
  const [credentials, setCredentials] = useState<
    {
      webauthnCredentialId: string;
      relyingPartyId: string;
      recipeUserId: string;
      createdAt: number;
    }[]
  >([]);
  const [webauthnEmail, setWebauthnEmail] = useState<string>("");

  const { t } = usePluginContext();

  useEffect(() => {
    if (!user) {
      return;
    }

    const email = user.loginMethods.find((lm: any) => lm.recipeId === "webauthn")?.email;
    if (email) {
      setWebauthnEmail(email);
    }

    loadWebAuthn();
  }, [user]);

  const webAuthnEmails = useMemo(() => {
    return user?.loginMethods.filter((lm: any) => lm.recipeId === "webauthn").map((lm: any) => lm.email) ?? [];
  }, [user]);

  const loadWebAuthn = usePrettyAction(
    async () => {
      const result = await listCredentials({ userContext: {} });
      if (result.status === "OK") {
        setCredentials(result.credentials);
      } else {
        throw new Error("Failed to load Passkeys");
      }
    },
    [],
    {
      errorMessage: t("PL_SEC_WEBAUTHN_ERROR_LOAD_CREDENTIALS"),
      setLoading: setIsLoading,
    },
  );

  const _onSuccess = useCallback(async () => {
    await loadWebAuthn();
    await onSuccess();
  }, [onSuccess]);

  const _removeCredential = usePrettyAction(
    async (webauthnCredentialId: string) => {
      const result = await removeCredential({
        webauthnCredentialId,
        userContext: {},
      });
      if (result.status === "OK") {
        setCredentials(credentials.filter((c) => c.webauthnCredentialId !== webauthnCredentialId));
      } else {
        throw new Error("Failed to remove Passkey");
      }
    },
    [],
    {
      onSuccess: _onSuccess,
      errorMessage: t("PL_SEC_WEBAUTHN_ERROR_REMOVE_CREDENTIAL"),
      setLoading: setIsLoading,
    },
  );

  const addCredential = usePrettyAction(
    async () => {
      // assume only one webauthn user
      const recipeUserId = user.loginMethods.find(
        (lm: any) => lm.recipeId === "webauthn" && lm.email === webauthnEmail,
      )?.recipeUserId;
      if (!recipeUserId) {
        throw new Error("Could not find user");
      }

      const registerCredentialResult = await createAndRegisterCredentialForSessionUser({
        recipeUserId: recipeUserId!,
        email: webauthnEmail,
        userContext: {},
      });

      if (registerCredentialResult.status !== "OK") {
        throw new Error("Failed to add Passkey");
      }

      await loadWebAuthn();
    },
    [webauthnEmail, user],
    {
      errorMessage: t("PL_SEC_WEBAUTHN_ERROR_ADD_CREDENTIAL"),
      successMessage: t("PL_SEC_WEBAUTHN_SUCCESS_ADD_CREDENTIAL"),
      setLoading: setIsLoading,
      onSuccess: _onSuccess,
    },
  );

  if (!user) {
    return null;
  }

  return (
    <div className={cx(".plugin-profile-security-manage")}>
      {credentials.map((credential) => (
        <div key={credential.webauthnCredentialId} className={cx("plugin-profile-security-manage-item")}>
          <span>
            {webauthnEmail}
            {t("PL_SEC_DOT_SEPARATOR")}
            {new Date(credential.createdAt).toLocaleString()}
          </span>

          <div className={cx("plugin-profile-security-manage-item-actions")}>
            <Button
              variant="neutral"
              size="small"
              appearance="plain"
              className={cx("plugin-profile-security-manage-item-remove")}
              onClick={() => _removeCredential(credential.webauthnCredentialId)}
              disabled={credentials.length <= 1}>
              {t("PL_SEC_WEBAUTHN_REMOVE_BUTTON")}
            </Button>
          </div>
        </div>
      ))}

      <div className={cx("plugin-profile-security-manage-container")}>
        <h4>{t("PL_SEC_WEBAUTHN_ADD_CREDENTIAL_TITLE")}</h4>

        <p className={cx("plugin-profile-security-item-description")}>
          {t("PL_SEC_WEBAUTHN_ADD_CREDENTIAL_DESCRIPTION")}
        </p>
        <br />

        <SelectInput
          label={t("PL_SEC_WEBAUTHN_SELECT_EMAIL_LABEL")}
          id="change-email"
          value={webauthnEmail}
          onChange={(value) => {
            if (!value) {
              return;
            }
            setWebauthnEmail(value as string);
          }}
          options={webAuthnEmails.map((email) => ({ label: email, value: email })) ?? []}
          disabled={webAuthnEmails.length <= 1}
        />
        <br />
        <div className={cx("plugin-profile-details-form-actions")}>
          <Button onClick={addCredential} disabled={isLoading} size="small" variant="brand" appearance="accent">
            {t("PL_SEC_WEBAUTHN_ADD_CREDENTIAL_BUTTON")}
          </Button>
        </div>
      </div>
    </div>
  );
};

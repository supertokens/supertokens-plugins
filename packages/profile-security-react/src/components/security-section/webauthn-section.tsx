import { Button, Card, SelectInput, usePrettyAction } from "@shared/ui";
import classNames from "classnames/bind";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listCredentials,
  removeCredential,
  createAndRegisterCredentialForSessionUser,
} from "supertokens-auth-react/recipe/webauthn";
import { User } from "supertokens-web-js/types";

import { usePluginContext } from "../../plugin";
import { ListCard, ListCardFooter, ListCardItem, ListCardItemActions } from "../list-card";

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

    loadCredentialsAction();
  }, [user]);

  const webAuthnEmails = useMemo(() => {
    return user?.loginMethods.filter((lm: any) => lm.recipeId === "webauthn").map((lm: any) => lm.email) ?? [];
  }, [user]);

  const loadCredentialsAction = usePrettyAction(
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

  const onActionSuccess = useCallback(async () => {
    await loadCredentialsAction();
    await onSuccess();
  }, [onSuccess, loadCredentialsAction]);

  const removeCredentialAction = usePrettyAction(
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
      onSuccess: onActionSuccess,
      errorMessage: t("PL_SEC_WEBAUTHN_ERROR_REMOVE_CREDENTIAL"),
      setLoading: setIsLoading,
    },
  );

  const addCredentialAction = usePrettyAction(
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

      await loadCredentialsAction();
    },
    [webauthnEmail, user],
    {
      errorMessage: t("PL_SEC_WEBAUTHN_ERROR_ADD_CREDENTIAL"),
      successMessage: t("PL_SEC_WEBAUTHN_SUCCESS_ADD_CREDENTIAL"),
      setLoading: setIsLoading,
      onSuccess: onActionSuccess,
    },
  );

  if (!user) {
    return null;
  }

  return (
    <div>
      <ListCard
        FooterComponent={
          <ListCardFooter>
            <div className={cx("supertokens-plugin-profile-security-passkey-email-select-label")}>
              {t("PL_SEC_WEBAUTHN_SELECT_EMAIL_LABEL")}
            </div>

            <SelectInput
              className={cx("supertokens-plugin-profile-security-passkey-email-select")}
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

            <Button
              className={cx("supertokens-plugin-profile-security-add-passkey-button")}
              onClick={addCredentialAction}
              disabled={isLoading}
              size="small"
              variant="brand"
              appearance="accent">
              {t("PL_SEC_WEBAUTHN_ADD_CREDENTIAL_BUTTON")}
            </Button>
          </ListCardFooter>
        }>
        {credentials.map((credential, index) => (
          <ListCardItem
            key={index}
            ActionsComponent={
              <ListCardItemActions>
                <Button
                  variant="danger"
                  size="small"
                  appearance="plain"
                  className={cx("supertokens-plugin-profile-security-manage-passkey-remove")}
                  onClick={() => removeCredentialAction(credential.webauthnCredentialId)}
                  disabled={credentials.length <= 1}>
                  {t("PL_SEC_WEBAUTHN_REMOVE_BUTTON")}
                </Button>
              </ListCardItemActions>
            }>
            <span className={cx("supertokens-plugin-profile-security-passkey-email")}>{webauthnEmail}</span>
            <span className={cx("supertokens-plugin-profile-security-passkey-date")}>
              {new Date(credential.createdAt).toLocaleString()}
            </span>
          </ListCardItem>
        ))}
      </ListCard>
    </div>
  );
};

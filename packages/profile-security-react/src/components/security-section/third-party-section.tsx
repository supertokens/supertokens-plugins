import { Button, usePrettyAction, useToast } from "@shared/ui";
import classNames from "classnames/bind";
import { useMemo } from "react";
import {
  redirectToThirdPartyLogin,
  Apple,
  Facebook,
  Github,
  Gitlab,
  Google,
  LinkedIn,
  Twitter,
  Bitbucket,
  Discord,
  ActiveDirectory,
  GoogleWorkspaces,
  Okta,
  BoxySAML,
  getProviders,
} from "supertokens-auth-react/recipe/thirdparty";
import { User } from "supertokens-web-js/types";

import { usePluginContext } from "../../plugin";

import style from "./security-section.module.css";

const cx = classNames.bind(style);

export const thirdPartyIdToProviderMap = {
  google: Google.init(),
  apple: Apple.init(),
  facebook: Facebook.init(),
  github: Github.init(),
  linkedin: LinkedIn.init(),
  twitter: Twitter.init(),
  gitlab: Gitlab.init(),
  "active-directory": ActiveDirectory.init(),
  "boxy-saml": BoxySAML.init(),
  discord: Discord.init(),
  okta: Okta.init(),
  "google-workspaces": GoogleWorkspaces.init(),
  bitbucket: Bitbucket.init(),
};

export const ThirdPartySection = ({
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
  const { api, t } = usePluginContext();
  const { addToast } = useToast();

  const availableSignUpProviders = useMemo(() => {
    if (!user) {
      return [];
    }

    return getProviders()
      .filter((provider) => {
        const loginMethod = user.loginMethods.find((lm: any) => lm.thirdParty && lm.thirdParty.id === provider.id);
        return !loginMethod;
      })
      .map((provider) => ({ name: provider.name, id: provider.id }));
  }, [user]);

  const connectedAccounts = useMemo(() => {
    if (!user) {
      return [];
    }

    return user.loginMethods
      .filter((method) => method.thirdParty)
      .map((method) => ({
        providerId: method.thirdParty!.id,
        email: method.email!,
        recipeUserId: method.recipeUserId,
      }));
  }, [user]);

  const linkAccount = usePrettyAction(
    async (providerId: string) => {
      const res = await redirectToThirdPartyLogin({
        thirdPartyId: providerId,
        shouldTryLinkingWithSessionUser: true,
      });
      if (res.status !== "OK") {
        throw new Error(
          t("PL_SEC_TP_ERROR_LINK_ACCOUNT", {
            provider: thirdPartyIdToProviderMap[providerId as keyof typeof thirdPartyIdToProviderMap].name,
          }),
        );
      }
    },
    [],
    {
      errorMessage: (e, providerId) =>
        t("PL_SEC_TP_ERROR_LINK_ACCOUNT", {
          provider: thirdPartyIdToProviderMap[providerId as keyof typeof thirdPartyIdToProviderMap].name,
        }),
      onSuccess,
      setLoading: setIsLoading,
    },
  );

  const unlinkAccount = usePrettyAction(
    async (recipeUserId: string) => {
      const res = await api.unlinkAccount(recipeUserId);
      if (res.status !== "OK") {
        throw new Error(res.message);
      }
    },
    [addToast],
    {
      errorMessage: (e, recipeUserId) => {
        const provider = connectedAccounts.find((account) => account.recipeUserId === recipeUserId)?.providerId;
        return t("PL_SEC_TP_ERROR_UNLINK_ACCOUNT", {
          provider: thirdPartyIdToProviderMap[provider as keyof typeof thirdPartyIdToProviderMap].name ?? "",
        });
      },
      successMessage: (recipeUserId) => {
        const provider = connectedAccounts.find((account) => account.recipeUserId === recipeUserId)?.providerId;
        return t("PL_SEC_TP_SUCCESS_UNLINK_ACCOUNT", {
          provider: thirdPartyIdToProviderMap[provider as keyof typeof thirdPartyIdToProviderMap].name ?? "",
        });
      },
      onSuccess,
      setLoading: setIsLoading,
    },
  );

  return (
    <>
      {connectedAccounts.length === 0 && (
        <span className={style["plugin-profile-details-value"]}>{t("PL_SEC_TP_NO_LINKED_ACCOUNTS")}</span>
      )}
      {connectedAccounts.map((account, index) => (
        <div key={index} className={cx("plugin-profile-security-linked-account")}>
          <span className={cx("plugin-profile-security-linked-account-provider")}>
            {thirdPartyIdToProviderMap[account.providerId as keyof typeof thirdPartyIdToProviderMap].getLogo()}
            {thirdPartyIdToProviderMap[account.providerId as keyof typeof thirdPartyIdToProviderMap].name}
          </span>
          <span className={cx("plugin-profile-security-linked-account-email")}>{account.email}</span>
          <Button
            onClick={() => unlinkAccount(account.recipeUserId)}
            size="small"
            variant="brand"
            appearance="plain"
            className={cx("plugin-profile-security-linked-account-unlink-button")}
            loading={isLoading}>
            {t("PL_SEC_TP_UNLINK_ACCOUNT_BUTTON")}
          </Button>
        </div>
      ))}

      {availableSignUpProviders.length > 0 && (
        <div className={cx("plugin-profile-security-link-account-buttons")}>
          {availableSignUpProviders.map((provider) => (
            <Button
              key={provider.id}
              variant="brand"
              onClick={() => linkAccount(provider.id)}
              loading={isLoading}
              size="small"
              appearance="outlined">
              <span className={cx("plugin-profile-security-linked-account-provider-logo")}>
                {thirdPartyIdToProviderMap[provider.id as keyof typeof thirdPartyIdToProviderMap].getLogo()}
              </span>
              {t("PL_SEC_TP_LINK_ACCOUNT_BUTTON")}{" "}
              {thirdPartyIdToProviderMap[provider.id as keyof typeof thirdPartyIdToProviderMap].name}
            </Button>
          ))}
        </div>
      )}
    </>
  );
};

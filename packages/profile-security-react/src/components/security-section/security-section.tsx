import { usePrettyAction } from "@shared/ui";
import classNames from "classnames/bind";
import { useState, useEffect, useMemo } from "react";
import { isRecipeInitialized } from "supertokens-auth-react";
import { User } from "supertokens-web-js/types";

import { usePluginContext } from "../../plugin";

import { ChangePasswordSection } from "./change-password-section";
import { MfaSection } from "./mfa-section";
import style from "./security-section.module.css";
import { SetPasswordSection } from "./set-password-section";
import { SetWebAuthnSection } from "./set-webauthn-section";
import { ThirdPartySection } from "./third-party-section";
import { WebauthnSection } from "./webauthn-section";

const cx = classNames.bind(style);

export const SecurityDetailsSection = () => {
  const [isLoaded, setIsLoaded] = useState(false);
  const [user, setUser] = useState<User>();

  const [config, setConfig] = useState({
    enableSettingPassword: false,
    enableThirdPartyLinkning: false,
    enableMfaConfiguration: false,
  });

  const [isLoading, setIsLoading] = useState(false);

  const { api, t } = usePluginContext();

  const loadConfig = usePrettyAction(async () => {
    const config = await api.getConfig();
    if (config.status !== "OK") {
      throw new Error(config.message);
    }
    setConfig(config.config);
  }, []);

  const hasPasswordRecipe = isRecipeInitialized("emailpassword");
  const hasThirdpartyRecipe = isRecipeInitialized("thirdparty");
  const hasMultiFactorAuthRecipe = isRecipeInitialized("multifactorauth");
  const hasWebauthnRecipe = isRecipeInitialized("webauthn");

  const hasPasswordLoginMethod = useMemo(
    () => Boolean(user?.loginMethods.find((lm: any) => lm.recipeId === "emailpassword")),
    [user],
  );

  const hasWebauthnLoginMethod = useMemo(
    () => Boolean(user?.loginMethods.find((lm: any) => lm.recipeId === "webauthn")),
    [user],
  );

  const loadUserInfo = usePrettyAction(
    async () => {
      const userInfo = await api.getUserInfo();
      if (userInfo.status !== "OK") {
        throw new Error(userInfo.message);
      }

      setUser(userInfo.user);

      return userInfo;
    },
    [],
    {
      setLoading: setIsLoading,
    },
  );

  useEffect(() => {
    if (isLoaded) {
      return;
    }

    loadConfig()
      .then(() => loadUserInfo())
      .then(() => {
        setIsLoaded(true);
      });
  }, [isLoaded, loadConfig, loadUserInfo]);

  return (
    <div className={cx("plugin-profile-security-section")}>
      <div className={cx("plugin-profile-security-header")}>
        <h3>{t("PL_SEC_HEADER_TITLE")}</h3>
        <p>{t("PL_SEC_HEADER_DESCRIPTION")}</p>
      </div>

      <div>
        {hasPasswordRecipe && hasPasswordLoginMethod && (
          <section className={cx("plugin-profile-security-group")}>
            <h3>{t("PL_SEC_CHANGE_PASSWORD_TITLE")}</h3>
            <ChangePasswordSection isLoading={isLoading} setIsLoading={setIsLoading} />
          </section>
        )}

        {config?.enableSettingPassword && hasPasswordRecipe && !hasPasswordLoginMethod && (
          <section className={cx("plugin-profile-security-group")}>
            <h3>{t("PL_SEC_SET_PASSWORD_TITLE")}</h3>
            <SetPasswordSection
              user={user!}
              isLoading={isLoading}
              setIsLoading={setIsLoading}
              onSuccess={loadUserInfo}
            />
          </section>
        )}

        {hasWebauthnRecipe && !hasWebauthnLoginMethod && (
          <section className={cx("plugin-profile-security-group")}>
            <h3>{t("PL_SEC_SET_WEBAUTHN_TITLE")}</h3>
            <SetWebAuthnSection
              user={user!}
              isLoading={isLoading}
              setIsLoading={setIsLoading}
              onSuccess={loadUserInfo}
            />
          </section>
        )}

        {hasWebauthnRecipe && hasWebauthnLoginMethod && (
          <section className={cx("plugin-profile-security-group")}>
            <h3>{t("PL_SEC_WEBAUTHN_TITLE")}</h3>
            <WebauthnSection user={user!} isLoading={isLoading} setIsLoading={setIsLoading} onSuccess={loadUserInfo} />
          </section>
        )}

        {config?.enableThirdPartyLinkning && hasThirdpartyRecipe && (
          <section className={cx("plugin-profile-security-group")}>
            <h3>{t("PL_SEC_TP_TITLE")}</h3>
            <ThirdPartySection
              user={user!}
              isLoading={isLoading}
              setIsLoading={setIsLoading}
              onSuccess={loadUserInfo}
            />
          </section>
        )}

        {config?.enableMfaConfiguration && hasMultiFactorAuthRecipe && (
          <section className={cx("plugin-profile-security-group")}>
            <h3>{t("PL_SEC_MFA_TITLE")}</h3>
            <MfaSection user={user!} isLoading={isLoading} setIsLoading={setIsLoading} onSuccess={loadUserInfo} />
          </section>
        )}
      </div>
    </div>
  );
};

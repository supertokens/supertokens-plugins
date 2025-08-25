import React from "react";
import { useCallback, useState } from "react";
import { SessionAuth } from "supertokens-auth-react/recipe/session";
import { PermissionClaim } from "supertokens-auth-react/recipe/userroles";
import { usePlugin } from "../use-plugin";
import { getErrorMessage, ThemeBase } from "../utils";

// @ts-ignore
import styles from "./style.css?inline";

export function BanUserPage() {
  const { api, pluginConfig, t } = usePlugin();

  const [error, setError] = useState<string | undefined>();
  const [tenantId, setTenantId] = useState("public");
  const [email, setEmail] = useState<string | undefined>();
  const [banStatus, setBanStatus] = useState<boolean | null>(null);

  const scheduleErrorReset = useCallback(() => {
    setTimeout(() => {
      setError(undefined);
    }, 10000);
  }, []);

  const onError = useCallback(
    (error: any) => {
      setError(getErrorMessage(error));
      scheduleErrorReset();
    },
    [scheduleErrorReset]
  );

  const getBanStatus = useCallback(
    (email: string) =>
      api
        .getBanStatus(tenantId, email)
        .then((res) => {
          if (res.status === "OK") {
            setError(undefined);
            setBanStatus(res.banned);
          } else {
            setError(res.message);
            scheduleErrorReset();
          }
        })
        .catch(onError),
    [tenantId]
  );

  const updateBanStatus = useCallback(
    (isBanned: boolean) => {
      if (!email) {
        setError("Email is required");
        scheduleErrorReset();
        return;
      }

      return api
        .updateBanStatus(tenantId, email, isBanned)
        .then(() => {
          setError(undefined);
          setBanStatus(isBanned);
        })
        .catch(onError);
    },
    [tenantId, email]
  );

  const onCheckStatus = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();

      if (!email) {
        setError("Email is required");
        return;
      }

      getBanStatus(email);
    },
    [getBanStatus, email]
  );

  const onBanUser = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      updateBanStatus(true);
    },
    [updateBanStatus]
  );

  const onUnbanUser = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();

      if (!email) {
        setError("Email is required");
        return;
      }

      updateBanStatus(false);
    },
    [updateBanStatus, email]
  );

  return (
    <SessionAuth
      overrideGlobalClaimValidators={(globalValidators) => [
        ...globalValidators,
        {
          ...PermissionClaim.validators.includes(pluginConfig.userBanningPermission),
          onFailureRedirection: () => pluginConfig.onPermissionFailureRedirectPath,
        },
      ]}>
      <ThemeBase userStyles={[styles]}>
        <div className="supertokens-plugin-user-banning">
          <div className="container">
            <div className="row">
              <div className="headerTitle">{t("PL_UB_BAN_PAGE_TITLE")}</div>
              <p>{t("PL_UB_BAN_PAGE_DESCRIPTION")}</p>

              <div className="divider"></div>

              {Boolean(error) && <div className="errorMessage">{error}</div>}

              <form noValidate>
                <div className="formRow">
                  <div className="label">{t("PL_UB_BAN_PAGE_TENANT_ID_LABEL")}</div>
                  <div className="inputContainer">
                    <div className="inputWrapper">
                      <input
                        type="text"
                        value={tenantId}
                        autoComplete="on"
                        placeholder={t("PL_UB_BAN_PAGE_TENANT_ID_PLACEHOLDER")}
                        onChange={(e) => setTenantId(e.target.value)}
                      />
                    </div>
                  </div>
                </div>

                <div className="formRow">
                  <div className="label">{t("PL_UB_BAN_PAGE_EMAIL_LABEL")}</div>
                  <div className="inputContainer">
                    <div className="inputWrapper">
                      <input
                        type="email"
                        value={email}
                        disabled={!tenantId}
                        autoComplete="on"
                        placeholder={t("PL_UB_BAN_PAGE_EMAIL_PLACEHOLDER")}
                        onChange={(e) => setEmail(e.target.value)}
                      />
                    </div>
                  </div>
                </div>

                {typeof banStatus === "boolean" && (
                  <div className="formRow">
                    {banStatus ? (
                      <div className="errorMessage">{t("PL_UB_BAN_PAGE_BANNED_STATUS")}</div>
                    ) : (
                      <div className="successMessage">{t("PL_UB_BAN_PAGE_NOT_BANNED_STATUS")}</div>
                    )}
                  </div>
                )}

                <div className="formRow">
                  <button className="button" onClick={onCheckStatus} disabled={!tenantId || !email}>
                    {t("PL_UB_BAN_PAGE_CHECK_STATUS_BUTTON")}
                  </button>
                </div>

                {typeof banStatus === "boolean" && (
                  <div className="formRow" style={{ flexDirection: "row" }}>
                    <button className="button" disabled={banStatus} onClick={onBanUser} style={{ marginRight: "20px" }}>
                      {t("PL_UB_BAN_PAGE_BAN_BUTTON")}
                    </button>

                    <button className="button" disabled={!banStatus} onClick={onUnbanUser}>
                      {t("PL_UB_BAN_PAGE_UNBAN_BUTTON")}
                    </button>
                  </div>
                )}
              </form>
            </div>
          </div>
        </div>
      </ThemeBase>
    </SessionAuth>
  );
}

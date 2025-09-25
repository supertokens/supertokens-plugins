import { Button, Callout, Card, TextInput, ThemeProvider } from "@shared/ui";
import React from "react";
import { useCallback, useState } from "react";
import { SessionAuth } from "supertokens-auth-react/recipe/session";
import { PermissionClaim } from "supertokens-auth-react/recipe/userroles";

import { usePluginContext } from "../plugin";
import { getErrorMessage } from "../utils";

export function BanUserPage() {
  const { api, pluginConfig, t } = usePluginContext();

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

  const onCheckStatus = useCallback(() => {
    if (!email) {
      setError("Email is required");
      return;
    }

    getBanStatus(email);
  }, [getBanStatus, email]);

  const onBanUser = useCallback(() => {
    if (!email) {
      setError("Email is required");
      return;
    }

    updateBanStatus(true);
  }, [updateBanStatus]);

  const onUnbanUser = useCallback(() => {
    if (!email) {
      setError("Email is required");
      return;
    }

    updateBanStatus(false);
  }, [updateBanStatus, email]);

  return (
    <SessionAuth
      overrideGlobalClaimValidators={(globalValidators) => [
        ...globalValidators,
        {
          ...PermissionClaim.validators.includes(pluginConfig.userBanningPermission),
          onFailureRedirection: () => pluginConfig.onPermissionFailureRedirectPath,
        },
      ]}>
      <ThemeProvider>
        <Card
          title={t("PL_UB_BAN_PAGE_TITLE")}
          description={t("PL_UB_BAN_PAGE_DESCRIPTION")}
          style={{ width: "460px" }}>
          {Boolean(error) && (
            <Callout size="small" variant="danger" appearance="filled">
              {error}
            </Callout>
          )}
          <TextInput
            id=""
            required
            label={t("PL_UB_BAN_PAGE_TENANT_ID_LABEL")}
            value={tenantId}
            onChange={(value) => {
              setTenantId(value);
              setBanStatus(null);
            }}
          />
          <br />
          <TextInput
            id=""
            required
            label={t("PL_UB_BAN_PAGE_EMAIL_LABEL")}
            value={email ?? ""}
            placeholder="test@example.com"
            onChange={(value) => {
              setEmail(value);
              setBanStatus(null);
            }}
          />
          <br />

          {typeof banStatus === "boolean" && (
            <>
              {banStatus ? (
                <Callout size="small" variant="danger" appearance="filled">
                  {t("PL_UB_BAN_PAGE_BANNED_STATUS")}
                </Callout>
              ) : (
                <Callout size="small" variant="success" appearance="filled">
                  {t("PL_UB_BAN_PAGE_NOT_BANNED_STATUS")}
                </Callout>
              )}
              <br />
            </>
          )}

          {typeof banStatus !== "boolean" && (
            <>
              <Button variant="brand" onClick={onCheckStatus} disabled={!tenantId || !email}>
                {t("PL_UB_BAN_PAGE_CHECK_STATUS_BUTTON")}
              </Button>
              <br />
            </>
          )}

          {typeof banStatus === "boolean" && (
            <>
              {banStatus ? (
                <Button variant="brand" onClick={onUnbanUser}>
                  {t("PL_UB_BAN_PAGE_UNBAN_BUTTON")}
                </Button>
              ) : (
                <Button variant="brand" onClick={onBanUser}>
                  {t("PL_UB_BAN_PAGE_BAN_BUTTON")}
                </Button>
              )}
              <br />
            </>
          )}
        </Card>
      </ThemeProvider>
    </SessionAuth>
  );
}

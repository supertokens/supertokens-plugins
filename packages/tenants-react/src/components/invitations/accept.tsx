import { Card, Button } from "@shared/ui";
import classNames from "classnames/bind";
import { useEffect, useState } from "react";
import { redirectToAuth } from "supertokens-auth-react";
import { useSessionContext } from "supertokens-auth-react/recipe/session";

import { usePluginContext } from "../../plugin";

import style from "./invitations.module.scss";

const cx = classNames.bind(style);

export const AcceptInvitation = ({
  onAccept,
}: {
  onAccept: (code: string, tenantId: string) => Promise<{ status: "OK" } | { status: "ERROR"; message: string }>;
}) => {
  const [code, setCode] = useState<string>("");
  const [tenantId, setTenantId] = useState<string>("");
  const [isAccepting, setIsAccepting] = useState(false);
  const [error, setError] = useState<string>("");

  const session = useSessionContext();
  const { t } = usePluginContext();

  useEffect(() => {
    // Parse the code from URL query parameters
    const urlParams = new URLSearchParams((globalThis as any).location.search);
    const inviteCode = urlParams.get("code");
    const tenantId = urlParams.get("tenantId");

    if (!inviteCode || !tenantId) {
      // Redirect to dashboard if no code is present
      (globalThis as any).location.href = "/user/tenants";
      return;
    }

    setCode(inviteCode);
    setTenantId(tenantId);
  }, []);

  if (session.loading) {
    return <div>{t("PL_TB_TENANTS_LOADING_MESSAGE")}</div>;
  }

  const handleAccept = async () => {
    if (!code) {
      return;
    }

    setIsAccepting(true);
    setError("");

    try {
      await onAccept(code, tenantId);
      // Redirect to /user/tenants after successful acceptance
      (globalThis as any).location.href = "/user/tenants";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to accept invitation");
    } finally {
      setIsAccepting(false);
    }
  };

  const handleRedirectToAuth = () => {
    redirectToAuth({
      queryParams: {
        code,
        tenantId,
      },
      redirectBack: false,
    });
  };

  if (!code) {
    return (
      <div className={cx("invitationDetailsSection")}>
        <div className={cx("invitationDetailsHeader")}>
          <h3>{t("PL_TB_INVITATIONS_INVALID_INVITATION_MESSAGE")}</h3>
          <p>{t("PL_TB_INVITATIONS_INVALID_INVITATION_REDIRECTING_TO_DASHBOARD_MESSAGE")}</p>
        </div>
      </div>
    );
  }

  return (
    <Card>
      <div slot="header" className={cx("invitationAcceptHeader")}>
        {t("PL_TB_INVITATIONS_ACCEPT_INVITATION_MESSAGE")}
      </div>
      <Card className={cx("invitationDetailsChild")}>
        <div slot="header" className={cx("invitationDetailsChildHeader")}>
          {t("PL_TB_INVITATIONS_DESCRIPTION_MESSAGE_PREFIX")}
          <span className={cx("tenantName")}>{`"${tenantId}"`}</span>
          {t("PL_TB_INVITATIONS_DESCRIPTION_MESSAGE_POSTFIX")}
        </div>
        <div className={cx("invitationDetailsCodeContainer")}>
          <div>{t("PL_TB_INVITATIONS_INVITATION_CODE_LABEL")}</div>
          <div className={cx("invitationCodeContainer")}>{code}</div>
        </div>
      </Card>
      <div slot="footer" className={cx("invitationDetailsFooter")}>
        {session.doesSessionExist ? (
          <Button onClick={handleAccept} disabled={isAccepting} variant="brand" appearance="accent">
            {isAccepting ? "Accepting..." : "Accept Invitation"}
          </Button>
        ) : (
          <Button onClick={handleRedirectToAuth} variant="brand" appearance="accent">
            {t("PL_TB_INVITATIONS_AUTHENTICATE_AND_ACCEPT_MESSAGE")}
          </Button>
        )}
      </div>
    </Card>
  );
};

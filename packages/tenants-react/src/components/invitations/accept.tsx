import { Card, Button, usePrettyAction } from "@shared/ui";
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

  const session = useSessionContext();
  const { t, pluginConfig } = usePluginContext();

  useEffect(() => {
    // Parse the code from URL query parameters
    const urlParams = new URLSearchParams(window.location.search);
    const inviteCode = urlParams.get("tenantInviteCode");
    const tenantId = urlParams.get("tenantId");

    if (inviteCode === null || inviteCode.trim() === "" || tenantId === null || tenantId.trim() === "") {
      // Redirect to dashboard if no code is present
      pluginConfig.redirectOnJoiningTenantFn();
      return;
    }

    setCode(inviteCode);
    setTenantId(tenantId);
  }, []);

  const onAcceptWrapper = usePrettyAction(
    async () => {
      try {
        const res = await onAccept(code, tenantId);
        if (res.status === "OK") {
          // Redirect user after successful acceptance
          pluginConfig.redirectOnJoiningTenantFn();
          return;
        }

        // Throw the error for it to be picked up.
        throw new Error(res.message);
      } finally {
        setIsAccepting(false);
      }
    },
    [onAccept],
    {
      successMessage: "Invitation accepted successfully!",
      errorMessage: "Failed to accept invitation, please try again",
    },
  );

  const handleAccept = async () => {
    if (!code) {
      return;
    }

    setIsAccepting(true);
    await onAcceptWrapper();
  };

  const handleRedirectToAuth = () => {
    redirectToAuth({
      queryParams: {
        tenantInviteCode: code,
        tenantId,
      },
      redirectBack: false,
    });
  };

  if (session.loading) {
    return <div>{t("PL_TB_TENANTS_LOADING_MESSAGE")}</div>;
  }

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

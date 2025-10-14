import { AwaitingApprovalMessage } from "@supertokens-plugins/tenants-react";

import { usePluginContext } from "../../plugin";

export const SignUpBlocked = () => {
  const { t } = usePluginContext();

  return (
    <AwaitingApprovalMessage
      headerText={t("PL_TE_JOIN_TENANT_AWAITING_APPROVAL_HEADER")}
      messageContent={
        <div>
          <b>{t("PL_TE_SIGN_UP_BLOCKED_MESSAGE_HIGHLIGHT")}</b> <b>{t("PL_TE_SIGN_UP_BLOCKED_MESSAGE_SUFFIX")}</b>
        </div>
      }
      useDangerAccent
      hideLogoutButton
    />
  );
};

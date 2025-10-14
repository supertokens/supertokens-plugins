import { AwaitingApprovalMessage } from "@supertokens-plugins/tenants-react";

import { usePluginContext } from "../../plugin";

export const AwaitingAdminApproval = () => {
  const { t } = usePluginContext();

  return (
    <AwaitingApprovalMessage
      headerText={t("PL_TE_JOIN_TENANT_AWAITING_APPROVAL_HEADER")}
      messageContent={
        <div>
          {t("PL_TE_JOIN_TENANT_AWAITING_APPROVAL_MESSAGE")}{" "}
          <b>{t("PL_TE_JOIN_TENANT_AWAITING_APPROVAL_MESSAGE_HIGHLIGHT")}</b>
        </div>
      }
    />
  );
};

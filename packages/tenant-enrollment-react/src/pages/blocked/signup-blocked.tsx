import { AwaitingApprovalMessage } from "@supertokens-plugins/tenants-react";

import { usePluginContext } from "../../plugin";

export const SignUpBlocked = () => {
  const { t } = usePluginContext();

  return (
    <AwaitingApprovalMessage
      headerText={t("PL_TE_SIGN_UP_BLOCKED_HEADER")}
      messageContent={
        <div>
          <b>{t("PL_TE_SIGN_UP_BLOCKED_MESSAGE_HIGHLIGHT")}</b>
          {" "}
          {t("PL_TE_SIGN_UP_BLOCKED_MESSAGE_SUFFIX")}
        </div>
      }
      useDangerAccent
      hideLogoutButton
    />
  );
};

import { SuperTokensWrapper } from "supertokens-auth-react";
import { SessionAuth } from "supertokens-auth-react/recipe/session";

import { PageWrapper } from "../../components";
import { AwaitingApprovalMessage } from "../../components/tenant-card/awaiting-approval";
import { usePluginContext } from "../../plugin";

export const AccessBlockedContainer = () => {
  const { t } = usePluginContext();

  return (
    <AwaitingApprovalMessage
      headerText={t("PL_TB_ACCESS_BLOCKED_HEADER_MESSAGE")}
      messageContent={<div>{t("PL_TB_ACCESS_BLOCKED_DESCRIPTION_MESSAGE")}</div>}
    />
  );
};

export const AccessBlockedPage = () => {
  return (
    <SuperTokensWrapper>
      <SessionAuth>
        <PageWrapper style={{ width: "1000px", margin: "100px auto" }}>
          <AccessBlockedContainer />
        </PageWrapper>
      </SessionAuth>
    </SuperTokensWrapper>
  );
};

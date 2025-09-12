import { SuperTokensWrapper } from "supertokens-auth-react";
import { SessionAuth } from "supertokens-auth-react/recipe/session";

import { PageWrapper } from "./components";
import TenantCardWrapper from "./tenant-wrapper";

export const SelectTenantPage = () => {
  return (
    <SuperTokensWrapper>
      <SessionAuth>
        <PageWrapper style={{ width: "700px", margin: "100px auto" }}>
          <TenantCardWrapper />
        </PageWrapper>
      </SessionAuth>
    </SuperTokensWrapper>
  );
};

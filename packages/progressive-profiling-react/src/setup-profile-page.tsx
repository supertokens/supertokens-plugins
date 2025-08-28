import { ThemeProvider } from "@shared/ui";
import { SuperTokensWrapper } from "supertokens-auth-react";
import { SessionAuth } from "supertokens-auth-react/recipe/session";

import { PageWrapper } from "./components";
import { UserProfileWrapper } from "./user-profile-wrapper";

export const SetupProfilePage = () => {
  return (
    <SuperTokensWrapper>
      <SessionAuth>
        {/* The theme provider is needed here, because this plugin does not use the base plugin (that has the theme provider) */}
        <ThemeProvider>
          <PageWrapper style={{ width: "700px", margin: "100px auto" }}>
            <UserProfileWrapper />
          </PageWrapper>
        </ThemeProvider>
      </SessionAuth>
    </SuperTokensWrapper>
  );
};

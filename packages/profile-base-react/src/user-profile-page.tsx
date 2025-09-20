import { Card, ThemeProvider } from "@shared/ui";
import { SuperTokensWrapper } from "supertokens-auth-react";
import { SessionAuth } from "supertokens-auth-react/recipe/session";

import { ProfilePageWrapper } from "./components";
import { UserProfileWrapper } from "./user-profile-wrapper";

export const UserProfilePage = () => {
  return (
    <ThemeProvider>
      <SuperTokensWrapper>
        <SessionAuth>
          <ProfilePageWrapper>
            <Card title="User Profile">
              <UserProfileWrapper />
            </Card>
          </ProfilePageWrapper>
        </SessionAuth>
      </SuperTokensWrapper>
    </ThemeProvider>
  );
};

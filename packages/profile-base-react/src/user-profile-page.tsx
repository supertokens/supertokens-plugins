import { Card, ThemeProvider } from "@shared/ui";
import { SuperTokensWrapper } from "supertokens-auth-react";
import { SessionAuth } from "supertokens-auth-react/recipe/session";

import { ProfilePageWrapper } from "./components";
import { usePluginContext } from "./plugin";
import { UserProfileWrapper } from "./user-profile-wrapper";

export const UserProfilePage = () => {
  const { t } = usePluginContext();
  return (
    <ThemeProvider>
      <SuperTokensWrapper>
        <SessionAuth>
          <ProfilePageWrapper>
            <Card title={t("PL_PB_USER_PROFILE")}>
              <UserProfileWrapper />
            </Card>
          </ProfilePageWrapper>
        </SessionAuth>
      </SuperTokensWrapper>
    </ThemeProvider>
  );
};

import { ProfilePageWrapper } from "./components";
import { SuperTokensWrapper } from "supertokens-auth-react";
import { SessionAuth } from "supertokens-auth-react/recipe/session";
import { UserProfileWrapper } from "./user-profile-wrapper";
import { ThemeProvider } from "@shared/ui";

export const UserProfilePage = () => {
  return (
    <ThemeProvider>
      <SuperTokensWrapper>
        <SessionAuth>
          <ProfilePageWrapper style={{ width: "700px", margin: "100px auto" }}>
            <UserProfileWrapper />
          </ProfilePageWrapper>
        </SessionAuth>
      </SuperTokensWrapper>
    </ThemeProvider>
  );
};

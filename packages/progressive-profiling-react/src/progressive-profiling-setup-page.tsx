import { ThemeProvider } from "@shared/ui";
import { SuperTokensWrapper } from "supertokens-auth-react";
import { SessionAuth } from "supertokens-auth-react/recipe/session";

import { PageWrapper } from "./components";
import { ProgressiveProfilingWrapper } from "./progressive-profiling-wrapper";

export const ProgressiveProfilingSetupPage = () => {
  return (
    <SuperTokensWrapper>
      <SessionAuth>
        {/* The theme provider is needed here, because this plugin does not use the base plugin (that has the theme provider) */}
        <ThemeProvider>
          <PageWrapper style={{ width: "700px", margin: "100px auto" }}>
            <ProgressiveProfilingWrapper />
          </PageWrapper>
        </ThemeProvider>
      </SessionAuth>
    </SuperTokensWrapper>
  );
};

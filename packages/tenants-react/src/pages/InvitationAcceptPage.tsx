import { SuperTokensWrapper } from "supertokens-auth-react";
import { SessionAuth } from "supertokens-auth-react/recipe/session";

import { AcceptInvitation } from "../components/invitations/accept";
import { usePluginContext } from "../plugin";

export const InvitationAcceptWrapper = () => {
  const { api } = usePluginContext();

  return (
    <SuperTokensWrapper>
      <SessionAuth requireAuth={false}>
        <AcceptInvitation onAccept={api.acceptInvitation} />
      </SessionAuth>
    </SuperTokensWrapper>
  );
};

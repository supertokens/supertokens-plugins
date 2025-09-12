import { SuperTokensWrapper } from "supertokens-auth-react";

import { AcceptInvitation } from "./components/invitations/accept";
import { usePluginContext } from "./plugin";
// import { SessionAuth } from 'supertokens-auth-react/recipe/session';

export const InvitationAcceptWrapper = () => {
  const { api } = usePluginContext();

  return (
    <SuperTokensWrapper>
      <AcceptInvitation onAccept={api.acceptInvitation} />
    </SuperTokensWrapper>
  );
};

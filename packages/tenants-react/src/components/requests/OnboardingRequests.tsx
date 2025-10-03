import { usePrettyAction } from "@shared/ui";
import { User } from "supertokens-web-js/types";

import { usePluginContext } from "../../plugin";
import { TenantUsersTable } from "../table/TenantTable";
import { UserDetails } from "../users/UserDetails";

import { Action } from "./Action";

type OnboardingRequestsProps = {
  requests: User[];
  onAcceptRequest: (userId: string) => Promise<boolean>;
  onDeclineRequest: (userId: string) => Promise<boolean>;
};

export const OnboardingRequests: React.FC<OnboardingRequestsProps> = ({ requests, onAcceptRequest, onDeclineRequest }) => {
  const { t, api } = usePluginContext();

  const handleAcceptRequest = usePrettyAction(
    async (userId: string) => {
      const acceptResponse = await onAcceptRequest(userId);
      if (!acceptResponse) {
        throw new Error("Failed to accept onboarding request, please try again");
      }
    },
    [onAcceptRequest],
    { errorMessage: "Failed to accept onboarding request, please try again" },
  );

  const handleDeclineRequest = usePrettyAction(
    async (userId: string) => {
      const declineResponse = await onDeclineRequest(userId);
      if (!declineResponse) {
        throw new Error("Failed to decline onboarding request, please try again");
      }
    },
    [onDeclineRequest],
    { errorMessage: "Failed to decline onboarding request, please try again" },
  );

  const getExtraComponent = (user: User) => {
    return <Action onAccept={() => handleAcceptRequest(user.id)} onDecline={() => handleDeclineRequest(user.id)} />;
  };

  return requests.length > 0 ? (
    <TenantUsersTable
      emailComponentTitle={`Tenant Onboarding Requests (${requests.length})`}
      columns={requests.map((user) => ({
        emailComponent: <UserDetails email={user.emails[0]!} avatarVariant="request" />,
        extraComponent: getExtraComponent(user),
      }))}
    />
  ) : null;
};

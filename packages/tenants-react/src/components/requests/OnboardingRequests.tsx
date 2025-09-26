import { usePrettyAction } from "@shared/ui";
import { useEffect, useState } from "react";
import { User } from "supertokens-web-js/types";

import { usePluginContext } from "../../plugin";
import { TenantUsersTable } from "../table/TenantTable";
import { NoUsers } from "../users/NoUsers";
import { UserDetails } from "../users/UserDetails";

import { Action } from "./Action";

export const OnboardingRequests = () => {
  const { t, api } = usePluginContext();
  const [requests, setRequests] = useState<User[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const { getOnboardingRequests, acceptOnboardingAccept, declineOnboardingAccept } = api;

  const getUsers = usePrettyAction(
    async () => {
      setIsLoading(true);
      try {
        const onboardingRequestsResponse = await getOnboardingRequests();
        if (onboardingRequestsResponse.status === "ERROR") {
          throw new Error(onboardingRequestsResponse.message);
        }
        setRequests(onboardingRequestsResponse.users);
      } finally {
        setIsLoading(false);
      }
    },
    [getOnboardingRequests],
    { errorMessage: "Failed to get requests for tenant" },
  );

  const onAcceptRequest = usePrettyAction(
    async (userId: string) => {
      const acceptResponse = await acceptOnboardingAccept(userId);
      if (acceptResponse.status === "ERROR") {
        throw new Error(acceptResponse.message);
      }

      // Remove the request from the list of requests.
      setRequests((existingRequests) => existingRequests.filter((req) => req.id !== userId));
    },
    [acceptOnboardingAccept],
    { errorMessage: "Failed to accept onboarding request, please try again" },
  );

  const onDeclineRequest = usePrettyAction(
    async (userId: string) => {
      const declineResponse = await declineOnboardingAccept(userId);
      if (declineResponse.status === "ERROR") {
        throw new Error(declineResponse.message);
      }

      // Remove the request from the list of requests.
      setRequests((existingRequests) => existingRequests.filter((req) => req.id !== userId));
    },
    [declineOnboardingAccept],
    { errorMessage: "Failed to decline onboarding request, please try again" },
  );

  useEffect(() => {
    getUsers();
  }, []);

  const getExtraComponent = (user: User) => {
    return <Action onAccept={() => onAcceptRequest(user.id)} onDecline={() => onDeclineRequest(user.id)} />;
  };

  if (isLoading) {
    return <div>{t("PL_TB_TENANTS_LOADING_MESSAGE")}</div>;
  }

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

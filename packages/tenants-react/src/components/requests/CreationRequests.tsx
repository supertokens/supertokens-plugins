import { TenantCreationRequestWithUser } from "@shared/tenants";
import { usePrettyAction } from "@shared/ui";
import classNames from "classnames/bind";
import { useEffect, useState } from "react";

import { usePluginContext } from "../../plugin";
import { TenantUsersTable } from "../table/TenantTable";
import { NoUsers } from "../users/NoUsers";
import { UserDetails } from "../users/UserDetails";

import { Action } from "./Action";
import style from "./requests.module.scss";

const cx = classNames.bind(style);

export const CreationRequests = () => {
  const { t, api } = usePluginContext();
  const [requests, setRequests] = useState<TenantCreationRequestWithUser[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const { getCreationRequests, acceptCreationRequest, declineCreationRequest } = api;

  const getRequests = usePrettyAction(
    async () => {
      setIsLoading(true);
      try {
        const onboardingRequestsResponse = await getCreationRequests();
        if (onboardingRequestsResponse.status === "ERROR") {
          throw new Error(onboardingRequestsResponse.message);
        }
        setRequests(onboardingRequestsResponse.requests);
      } finally {
        setIsLoading(false);
      }
    },
    [getCreationRequests],
    { errorMessage: "Failed to get creation requests" },
  );

  const onAcceptRequest = usePrettyAction(
    async (requestId: string) => {
      const acceptResponse = await acceptCreationRequest(requestId);
      if (acceptResponse.status === "ERROR") {
        throw new Error(acceptResponse.message);
      }

      // Remove the request from the list of requests.
      setRequests((existingRequests) => existingRequests.filter((req) => req.requestId !== requestId));
    },
    [acceptCreationRequest],
    { errorMessage: "Failed to accept creation request, please try again" },
  );

  const onDeclineRequest = usePrettyAction(
    async (requestId: string) => {
      const declineResponse = await declineCreationRequest(requestId);
      if (declineResponse.status === "ERROR") {
        throw new Error(declineResponse.message);
      }

      // Remove the request from the list of requests.
      setRequests((existingRequests) => existingRequests.filter((req) => req.requestId !== requestId));
    },
    [declineCreationRequest],
    { errorMessage: "Failed to decline creation request, please try again" },
  );

  useEffect(() => {
    getRequests();
  }, []);

  const getExtraComponent = (request: TenantCreationRequestWithUser) => {
    return (
      <div className={cx("tenantCreateActionWrapper")}>
        <div className={cx("tenantName")}>{request.name}</div>
        <Action
          onAccept={() => onAcceptRequest(request.requestId)}
          onDecline={() => onDeclineRequest(request.requestId)}
        />
      </div>
    );
  };

  if (isLoading) {
    return <div>{t("PL_TB_TENANTS_LOADING_MESSAGE")}</div>;
  }

  return (
    <div>
      {requests.length > 0 ? (
        <TenantUsersTable
          columns={requests.map((request) => ({
            emailComponent: <UserDetails email={request.user.emails[0]!} />,
            extraComponent: getExtraComponent(request),
          }))}
          extraComponentTitle="Tenant ID"
          extraWidth="65%"
          emailWidth="35%"
        />
      ) : (
        <NoUsers text="No creation requests available for tenant" />
      )}
    </div>
  );
};

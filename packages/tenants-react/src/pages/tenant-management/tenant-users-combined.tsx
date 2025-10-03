import { InviteeDetails } from "@shared/tenants";
import { useCallback, useEffect, useMemo, useState } from "react";
import classNames from "classnames/bind";

import { usePrettyAction } from "@shared/ui";
import { InvitedUsers } from "../../components/invitations/InvitedUsers";
import { OnboardingRequests } from "../../components/requests/OnboardingRequests";
import { TenantUsers } from "../../components/users/TenantUsers";
import { logDebugMessage } from "../../logger";
import { usePluginContext } from "../../plugin";

import style from "./styles.module.scss";
import { UserWithRole } from "../../types";
import { User } from "supertokens-web-js/types";
import { NoUsers } from "../../components/users/NoUsers";
import { AddInvitation } from "../../components/invitations/AddInvitation";

const cx = classNames.bind(style);

type TenantUsersCombinedProps = {
  tenantId: string;
};

export const TenantUsersCombined: React.FC<TenantUsersCombinedProps> = ({ tenantId: selectedTenantId }) => {
  const { api, t } = usePluginContext();
  const {
    getUsers,
    getInvitations,
    removeInvitation,
    addInvitation,
    removeUserFromTenant,
    changeRole,
    getOnboardingRequests,
    acceptOnboardingRequest,
    declineOnboardingRequest,
  } = api;

  const [invitations, setInvitations] = useState<InviteeDetails[]>([]);
  const [tenantUsers, setTenantUsers] = useState<UserWithRole[]>([]);
  const [requests, setRequests] = useState<User[]>([]);
  const isNoUsers = useMemo(
    () => tenantUsers.length === 0 && invitations.length === 0 && requests.length === 0,
    [tenantUsers, invitations, requests],
  );

  const loadInvitations = useCallback(async () => {
    const invitationResponse = await getInvitations();
    if (invitationResponse.status !== "OK") {
      throw new Error("Failed to get invitation");
    }
    setInvitations(invitationResponse.invitees);
  }, [getInvitations]);

  const loadTenantUsers = useCallback(async () => {
    const response = await getUsers();
    if (response.status === "ERROR") {
      throw new Error(response.message);
    }
    // Show the users that have a valid role
    setTenantUsers(response.users.filter((user) => user.roles.length !== 0));
  }, [getUsers]);

  const loadRequests = usePrettyAction(
    async () => {
      const onboardingRequestsResponse = await getOnboardingRequests();
      if (onboardingRequestsResponse.status === "ERROR") {
        throw new Error(onboardingRequestsResponse.message);
      }
      setRequests(onboardingRequestsResponse.users);
    },
    [getOnboardingRequests],
    { errorMessage: "Failed to get requests for tenant" },
  );

  useEffect(() => {
    Promise.all([loadInvitations(), loadTenantUsers(), loadRequests()]);
  }, [loadInvitations, loadTenantUsers, loadRequests]);

  const onCreateInvite = useCallback(
    async (email: string, role: string) => {
      const response = await addInvitation(email, role);
      if (response.status === "ERROR") {
        throw new Error(response.message);
      }

      // If `OK` status, add the newly added invitation to the
      // list of invitations.
      setInvitations((currentInvitations) => [
        ...currentInvitations,
        {
          email,
          code: response.code,
          role,
        },
      ]);
    },
    [addInvitation],
  );

  const onRemoveInvite = usePrettyAction(
    async (email: string) => {
      const response = await removeInvitation(email);
      if (response.status === "ERROR") {
        throw new Error(response.message);
      }

      // If it was successful, remove the invitation from the
      // list.
      setInvitations((currentInvitations) => currentInvitations.filter((invitation) => invitation.email !== email));
    },
    [removeInvitation],
    { errorMessage: "Failed to remove invitation, please try again" },
  );

  const onRoleChange = useCallback(
    async (userId: string, role: string) => {
      const response = await changeRole(userId, role);
      if (response.status === "ERROR") {
        logDebugMessage(`Got error while changing role: ${response.message}`);
        return false;
      }
      return true;
    },
    [changeRole],
  );

  const onUserRemove = useCallback(
    async (userId: string): Promise<boolean> => {
      const response = await removeUserFromTenant(userId);
      if (response.status === "ERROR") {
        logDebugMessage(`Got error while removing user: ${response.message}`);
        return false;
      }

      // Remove the user from the list of tenant users
      setTenantUsers((currentUsers) => currentUsers.filter((user) => user.id !== userId));

      return true;
    },
    [removeUserFromTenant],
  );

  const onAcceptRequest = useCallback(
    async (userId: string) => {
      const response = await acceptOnboardingRequest(userId);
      if (response.status === "ERROR") {
        return false;
      }

      // Remove the request from the list of requests.
      setRequests((existingRequests) => existingRequests.filter((req) => req.id !== userId));
      return true;
    },
    [acceptOnboardingRequest],
  );

  const onDeclineRequest = useCallback(
    async (userId: string) => {
      const response = await declineOnboardingRequest(userId);
      if (response.status === "ERROR") {
        return false;
      }

      // Remove the request from the list of requests.
      setRequests((existingRequests) => existingRequests.filter((req) => req.id !== userId));
      return true;
    },
    [declineOnboardingRequest],
  );

  return (
    <div>
      <div className={cx("addInvitationWrapper")}>
        <AddInvitation onCreate={onCreateInvite} />
      </div>
      {isNoUsers ? (
        <NoUsers text={t("PL_TB_NO_USERS_FOUND_TEXT")} />
      ) : (
        <div className={cx("tenantUsersCombinedContainer")}>
          <TenantUsers users={tenantUsers} onRoleChange={onRoleChange} onUserRemove={onUserRemove} />
          <InvitedUsers onRemove={onRemoveInvite} invitations={invitations} tenantId={selectedTenantId} />
          <OnboardingRequests
            requests={requests}
            onAcceptRequest={onAcceptRequest}
            onDeclineRequest={onDeclineRequest}
          />
        </div>
      )}
    </div>
  );
};

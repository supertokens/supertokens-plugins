import { InviteeDetails } from "@shared/tenants";
import { useCallback, useEffect, useState } from "react";
import classNames from "classnames/bind";

import { usePrettyAction } from "../../../../../shared/ui/src/hooks";
import { InvitedUsers } from "../../components/invitations/InvitedUsers";
import { OnboardingRequests } from "../../components/requests/OnboardingRequests";
import { TenantUsers } from "../../components/users/TenantUsers";
import { logDebugMessage } from "../../logger";
import { usePluginContext } from "../../plugin";

import style from "./styles.module.scss";

const cx = classNames.bind(style);

type TenantUsersCombinedProps = {
  tenantId: string;
};

export const TenantUsersCombined: React.FC<TenantUsersCombinedProps> = ({ tenantId: selectedTenantId }) => {
  const { api } = usePluginContext();
  const { getUsers, getInvitations, removeInvitation, addInvitation, removeUserFromTenant, changeRole } = api;

  const [invitations, setInvitations] = useState<InviteeDetails[]>([]);

  const loadInvitations = useCallback(async () => {
    const invitationResponse = await getInvitations();
    if (invitationResponse.status !== "OK") {
      throw new Error("Failed to get invitation");
    }
    setInvitations(invitationResponse.invitees);
  }, [getInvitations]);

  useEffect(() => {
    loadInvitations();
  }, [loadInvitations]);

  const onCreateInvite = useCallback(
    async (email: string) => {
      const response = await addInvitation(email);
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

  // Users tab functions
  const onFetchUsers = useCallback(async () => {
    const response = await getUsers();
    if (response.status === "ERROR") {
      throw new Error(response.message);
    }
    return { users: response.users };
  }, [getUsers]);

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
      return true;
    },
    [removeUserFromTenant],
  );

  // TODO: Handle case for no users
  // when 0 users, 0 invitations and 0 requests
  // <NoUsers text={t("PL_TB_NO_USERS_FOUND_TEXT")} />

  return (
    <div className={cx("tenantUsersCombinedContainer")}>
      <TenantUsers onFetch={onFetchUsers} onRoleChange={onRoleChange} onUserRemove={onUserRemove} />
      <InvitedUsers onRemove={onRemoveInvite} invitations={invitations} tenantId={selectedTenantId} />
      <OnboardingRequests />
    </div>
  );
};

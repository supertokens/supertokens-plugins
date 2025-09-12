import { InviteeDetails } from "@shared/tenants";
import { usePrettyAction } from "@shared/ui";
import { useCallback, useEffect, useState } from "react";

import { usePluginContext } from "../../plugin";
import { TenantTab } from "../tab/TenantTab";

import { AddInvitation } from "./AddInvitation";
import { InvitedUsers } from "./InvitedUsers";

type InvitationsProps = {
  onFetch: (tenantId?: string) => Promise<{ invitations: InviteeDetails[] }>;
  selectedTenantId: string;
};

export const Invitations: React.FC<InvitationsProps> = ({ selectedTenantId, onFetch }) => {
  const { api } = usePluginContext();
  const { addInvitation, removeInvitation } = api;

  const [invitations, setInvitations] = useState<InviteeDetails[]>([]);

  const loadDetails = useCallback(
    async (tenantId?: string) => {
      const details = await onFetch(tenantId || selectedTenantId);
      setInvitations(details.invitations);
    },
    [onFetch, selectedTenantId],
  );

  useEffect(() => {
    if (selectedTenantId) {
      loadDetails(selectedTenantId);
    }
  }, [selectedTenantId, loadDetails]);

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

  return (
    <TenantTab
      description="Invitations sent to join your tenant"
      descriptionComponent={<AddInvitation onCreate={onCreateInvite} selectedTenantId={selectedTenantId} />}>
      <InvitedUsers invitations={invitations} onRemove={onRemoveInvite} tenantId={selectedTenantId} />
    </TenantTab>
  );
};

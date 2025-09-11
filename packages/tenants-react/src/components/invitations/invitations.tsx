import { InviteeDetails } from "@shared/tenants";
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
  const { addInvitation } = api;

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

  return (
    <TenantTab
      description="Invitations sent to join your tenant"
      descriptionComponent={<AddInvitation onCreate={onCreateInvite} selectedTenantId={selectedTenantId} />}>
      <InvitedUsers invitations={invitations} selectedTenantId={selectedTenantId} />
    </TenantTab>
  );
};

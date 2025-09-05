import { InviteeDetails } from "@shared/tenants";
// import { BaseFormSection } from "@supertokens-plugin-profile/common-details-shared";
import { useCallback, useEffect, useState } from "react";

export const InvitationsWrapper = ({
  section,
  onFetch,
  onRemove,
  onCreate,
  selectedTenantId,
}: {
  section: any;
  onFetch: (tenantId?: string) => Promise<{ invitations: InviteeDetails[] }>;
  onRemove: (email: string, tenantId?: string) => Promise<void>;
  onCreate?: (email: string, tenantId: string) => Promise<void>;
  selectedTenantId: string;
}) => {
  const [invitations, setInvitations] = useState<InviteeDetails[]>([]);
  const [showInviteForm, setShowInviteForm] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showCode, setShowCode] = useState<string | null>(null);
  const loadDetails = useCallback(
    async (tenantId?: string) => {
      const details = await onFetch(tenantId || selectedTenantId);
      setInvitations(details.invitations);
    },
    [onFetch, selectedTenantId],
  );

  const handleShowCode = (code: string) => {
    setShowCode(code);
  };

  useEffect(() => {
    if (selectedTenantId) {
      loadDetails(selectedTenantId);
    }
  }, [selectedTenantId, loadDetails]);

  const handleInviteSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!onCreate || !inviteEmail.trim()) {
      return;
    }

    setIsSubmitting(true);
    try {
      await onCreate(inviteEmail.trim(), selectedTenantId);
      setInviteEmail("");
      setShowInviteForm(false);
      // Reload the invitations list
      await loadDetails(selectedTenantId);
    } catch (error) {
      console.error("Failed to create invitation:", error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRemoveInvitation = async (email: string, tenantId: string) => {
    await onRemove(email, tenantId);
    await loadDetails(tenantId);
  };

  const handleCancelInvite = () => {
    setShowInviteForm(false);
    setInviteEmail("");
  };

  return (
    <div className="">
      <div className="">
        <h3>{section.label}</h3>
        <p>{section.description}</p>
        {onCreate && (
          <button className="" type="button" onClick={() => setShowInviteForm(true)} disabled={showInviteForm}>
            Invite Someone
          </button>
        )}
      </div>

      {showInviteForm && onCreate && (
        <div className="">
          <form onSubmit={handleInviteSubmit}>
            <div className="">
              <input
                type="email"
                placeholder="Enter email address"
                value={inviteEmail}
                onChange={(e: any) => setInviteEmail(e.currentTarget.value)}
                className=""
                required
                disabled={isSubmitting}
              />
              <div className="">
                <button type="submit" className="" disabled={isSubmitting || !inviteEmail.trim()}>
                  {isSubmitting ? "Inviting..." : "Send Invitation"}
                </button>
                <button type="button" className="" onClick={handleCancelInvite} disabled={isSubmitting}>
                  Cancel
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      <div className="">
        {invitations.length > 0 ? (
          <div>
            {/* {invitations.map((invitation) => (
              <div key={invitation.email} className="">
                <div className=""</div>
                <div className=""</div>
                <button className="">
                  Code
                </button>
                <button
                  className=""
                  type="button"
                  onClick={() => handleRemoveInvitation(invitation.email, selectedTenantId)}
                >
                  ×
                </button>
              </div>
            ))} */}
          </div>
        ) : (
          <div className="">
            <p>No invitations found</p>
          </div>
        )}
      </div>

      {showCode && (
        <div className="">
          <p>{showCode}</p>
          <button className="">Close</button>
        </div>
      )}
    </div>
  );
};

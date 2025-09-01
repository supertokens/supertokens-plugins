import classNames from 'classnames/bind';
import style from './invitations.module.scss';
import { BaseFormSection } from '@supertokens-plugin-profile/common-details-shared';
import { useCallback, useEffect, useState } from 'react';
import { InviteeDetails } from '@supertokens-plugin-profile/tenants-shared';

const cx = classNames.bind(style);

export const InvitationsWrapper = ({
  section,
  onFetch,
  onRemove,
  onCreate,
  selectedTenantId,
}: {
  section: BaseFormSection;
  onFetch: (tenantId?: string) => Promise<{ invitations: InviteeDetails[] }>;
  onRemove: (email: string, tenantId?: string) => Promise<void>;
  onCreate?: (email: string, tenantId: string) => Promise<void>;
  selectedTenantId: string;
}) => {
  const [invitations, setInvitations] = useState<InviteeDetails[]>([]);
  const [showInviteForm, setShowInviteForm] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
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
    if (!onCreate || !inviteEmail.trim()) return;

    setIsSubmitting(true);
    try {
      await onCreate(inviteEmail.trim(), selectedTenantId);
      setInviteEmail('');
      setShowInviteForm(false);
      // Reload the invitations list
      await loadDetails(selectedTenantId);
    } catch (error) {
      console.error('Failed to create invitation:', error);
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
    setInviteEmail('');
  };

  return (
    <div className={cx('invitationDetailsSection')}>
      <div className={cx('invitationDetailsHeader')}>
        <h3>{section.label}</h3>
        <p>{section.description}</p>
        {onCreate && (
          <button
            className={cx('inviteButton')}
            type="button"
            onClick={() => setShowInviteForm(true)}
            disabled={showInviteForm}
          >
            Invite Someone
          </button>
        )}
      </div>

      {showInviteForm && onCreate && (
        <div className={cx('inviteForm')}>
          <form onSubmit={handleInviteSubmit}>
            <div className={cx('inviteFormContent')}>
              <input
                type="email"
                placeholder="Enter email address"
                value={inviteEmail}
                onChange={(e: any) => setInviteEmail(e.currentTarget.value)}
                className={cx('inviteEmailInput')}
                required
                disabled={isSubmitting}
              />
              <div className={cx('inviteFormActions')}>
                <button
                  type="submit"
                  className={cx('inviteSubmitButton')}
                  disabled={isSubmitting || !inviteEmail.trim()}
                >
                  {isSubmitting ? 'Inviting...' : 'Send Invitation'}
                </button>
                <button
                  type="button"
                  className={cx('inviteCancelButton')}
                  onClick={handleCancelInvite}
                  disabled={isSubmitting}
                >
                  Cancel
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      <div className={cx('invitationDetailsContent')}>
        {invitations.length > 0 ? (
          <div className={cx('invitationDetailsUsers')}>
            {invitations.map((invitation) => (
              <div key={invitation.email} className={cx('userRow')}>
                <div className={cx('userAvatar')}>{invitation.email.charAt(0).toUpperCase() || 'U'}</div>
                <div className={cx('userEmail')}>{invitation.email}</div>
                <button className={cx('showCodeButton')} type="button" onClick={() => handleShowCode(invitation.code)}>
                  Code
                </button>
                <button
                  className={cx('removeButton')}
                  type="button"
                  onClick={() => handleRemoveInvitation(invitation.email, selectedTenantId)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className={cx('invitationDetailsNoUsers')}>
            <p>No invitations found</p>
          </div>
        )}
      </div>

      {showCode && (
        <div className={cx('invitationDetailsCode')}>
          <p>{showCode}</p>
          <button className={cx('closeButton')} type="button" onClick={() => setShowCode(null)}>
            Close
          </button>
        </div>
      )}
    </div>
  );
};

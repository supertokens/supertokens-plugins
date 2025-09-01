import classNames from 'classnames/bind';
import style from './invitations.module.scss';
import { useEffect, useState } from 'react';
import { useSessionContext } from 'supertokens-auth-react/recipe/session';
import { redirectToAuth } from 'supertokens-auth-react';
import { Card, Button } from '@supertokens-plugin-profile/common-frontend';

const cx = classNames.bind(style);

export const AcceptInvitation = ({
  onAccept,
}: {
  onAccept: (code: string, tenantId: string) => Promise<{ status: 'OK' } | { status: 'ERROR'; message: string }>;
}) => {
  const [code, setCode] = useState<string>('');
  const [tenantId, setTenantId] = useState<string>('');
  const [isAccepting, setIsAccepting] = useState(false);
  const [error, setError] = useState<string>('');

  const session = useSessionContext();

  useEffect(() => {
    // Parse the code from URL query parameters
    const urlParams = new URLSearchParams((globalThis as any).location.search);
    const inviteCode = urlParams.get('code');
    const tenantId = urlParams.get('tenantId');

    if (!inviteCode || !tenantId) {
      // Redirect to dashboard if no code is present
      (globalThis as any).location.href = '/user/tenants';
      return;
    }

    setCode(inviteCode);
    setTenantId(tenantId);
  }, []);

  if (session.loading) {
    return <div>Loading...</div>;
  }

  const handleAccept = async () => {
    if (!code) return;

    setIsAccepting(true);
    setError('');

    try {
      await onAccept(code, tenantId);
      // Redirect to /user/tenants after successful acceptance
      (globalThis as any).location.href = '/user/tenants';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to accept invitation');
    } finally {
      setIsAccepting(false);
    }
  };

  const handleRedirectToAuth = () => {
    redirectToAuth({
      queryParams: {
        code,
        tenantId,
      },
      redirectBack: false,
    });
  };

  if (!code) {
    return (
      <div className={cx('invitationDetailsSection')}>
        <div className={cx('invitationDetailsHeader')}>
          <h3>Invalid Invitation</h3>
          <p>No invitation code found. Redirecting to dashboard...</p>
        </div>
      </div>
    );
  }

  return (
    <Card>
      <div slot="header" className={cx('invitationAcceptHeader')}>
        Accept Invitation
      </div>
      <Card className={cx('invitationDetailsChild')}>
        <div slot="header" className={cx('invitationDetailsChildHeader')}>
          You have been invited to join "<span className={cx('tenantName')}>{tenantId}</span>" tenant. Click the button
          below to accept the invitation.
        </div>
        <div className={cx('invitationDetailsCodeContainer')}>
          <div>Invitation code:</div>
          <div className={cx('invitationCodeContainer')}>{code}</div>
        </div>
      </Card>
      <div slot="footer" className={cx('invitationDetailsFooter')}>
        {session.doesSessionExist ? (
          <Button onClick={handleAccept} disabled={isAccepting} variant="brand" appearance="accent">
            {isAccepting ? 'Accepting...' : 'Accept Invitation'}
          </Button>
        ) : (
          <Button onClick={handleRedirectToAuth} variant="brand" appearance="accent">
            Authenticate and accept invitation
          </Button>
        )}
      </div>
    </Card>
  );
};

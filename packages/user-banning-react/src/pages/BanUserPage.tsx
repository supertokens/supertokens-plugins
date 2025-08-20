import React from 'react';
import { useCallback, useState } from 'react';
import { useQuerier } from '../utils/querier';
import { SessionAuth } from 'supertokens-auth-react/recipe/session';
import { PermissionClaim } from 'supertokens-auth-react/recipe/userroles';
// @ts-ignore
import styles from './style.css?inline';
import { getErrorMessage, ThemeBase } from '../utils';

// todo: feedback: it would be useful to be able to use the supertokens components (buttons, inputs, boxes, cards, forms, etc).

export function BanUserPage(props: { apiDomain: string }) {
  const [error, setError] = useState<string | undefined>();
  const [tenantId, setTenantId] = useState('public');
  const [email, setEmail] = useState<string | undefined>();
  const [banStatus, setBanStatus] = useState<boolean | null>(null);

  const querier = useQuerier(props.apiDomain);

  const scheduleErrorReset = useCallback(() => {
    setTimeout(() => {
      setError(undefined);
    }, 10000);
  }, []);

  const onError = useCallback(
    (error: any) => {
      setError(getErrorMessage(error));
      scheduleErrorReset();
    },
    [scheduleErrorReset],
  );

  const getBanStatus = useCallback(
    (email: string) =>
      querier
        .get<{ status: 'OK'; banned: boolean }>('/plugin/supertokens-plugin-user-banning/ban', {
          withSession: true,
          params: { tenantId, email },
        })
        .then((res) => {
          setError(undefined);
          setBanStatus(res.banned);
        })
        .catch(onError),
    [querier, tenantId],
  );

  const updateBanStatus = useCallback(
    (isBanned: boolean) =>
      querier
        .post(
          '/plugin/supertokens-plugin-user-banning/ban',
          {
            email,
            isBanned,
          },
          {
            withSession: true,
            params: { tenantId },
          },
        )
        .then(() => {
          setError(undefined);
          setBanStatus(isBanned);
        })
        .catch(onError),
    [querier, tenantId, email],
  );

  const onCheckStatus = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();

      if (!email) {
        setError('Email is required');
        return;
      }

      getBanStatus(email);
    },
    [getBanStatus, email],
  );

  const onBanUser = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      updateBanStatus(true);
    },
    [updateBanStatus, email],
  );

  const onUnbanUser = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();

      if (!email) {
        setError('Email is required');
        return;
      }

      updateBanStatus(false);
    },
    [updateBanStatus, email],
  );

  return (
    <SessionAuth
      overrideGlobalClaimValidators={(globalValidators) => [
        ...globalValidators,
        {
          ...PermissionClaim.validators.includes('ban-user'),
          onFailureRedirection: () => {
            return '/'; // go back home
          },
        },
      ]}
    >
      <ThemeBase userStyles={[styles]}>
        <div className="supertokens-plugin-user-banning">
          <div className="container">
            <div className="row">
              <div className="headerTitle">Ban User</div>
              <p>
                This page is used to ban and unban users. It is useful for preventing users from accessing your
                application.
              </p>

              <div className="divider"></div>

              {!!error && <div className="generalError">{error}</div>}

              <form noValidate>
                <div className="formRow">
                  <div className="label">Tenant ID</div>
                  <div className="inputContainer">
                    <div className="inputWrapper">
                      <input
                        type="text"
                        value={tenantId}
                        autoComplete="on"
                        placeholder="Tenant ID"
                        onChange={(e) => setTenantId(e.target.value)}
                      />
                    </div>
                  </div>
                </div>

                <div className="formRow">
                  <div className="label">User Email</div>
                  <div className="inputContainer">
                    <div className="inputWrapper">
                      <input
                        type="email"
                        value={email}
                        disabled={!tenantId}
                        autoComplete="on"
                        placeholder="User Email"
                        onChange={(e) => setEmail(e.target.value)}
                      />
                    </div>
                  </div>
                </div>

                <div className="formRow">
                  <button className="button" onClick={onCheckStatus} disabled={!(!!tenantId && !!email)}>
                    Check Status (
                    {typeof banStatus === 'boolean' ? (
                      banStatus ? (
                        <span style={{ color: 'red' }}>Banned</span>
                      ) : (
                        <span style={{ color: 'green' }}>Not Banned</span>
                      )
                    ) : (
                      ' - '
                    )}
                    )
                  </button>
                </div>

                {typeof banStatus === 'boolean' && (
                  <div className="formRow" style={{ flexDirection: 'row' }}>
                    <button className="button" disabled={banStatus} onClick={onBanUser} style={{ marginRight: '20px' }}>
                      Ban
                    </button>

                    <button className="button" disabled={!banStatus} onClick={onUnbanUser}>
                      Unban
                    </button>
                  </div>
                )}
              </form>
            </div>
          </div>
        </div>
      </ThemeBase>
    </SessionAuth>
  );
}

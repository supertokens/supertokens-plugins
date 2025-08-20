import React from 'react';
import { useCallback, useState } from 'react';
import { SessionAuth } from 'supertokens-auth-react/recipe/session';
import { PermissionClaim } from 'supertokens-auth-react/recipe/userroles';
// @ts-ignore
import styles from './style.css?inline';
import { getErrorMessage, ThemeBase } from '../utils';
import { usePlugin } from '../use-plugin';

// todo: feedback: it would be useful to be able to use the supertokens components (buttons, inputs, boxes, cards, forms, etc).

export function BanUserPage() {
  const { api, pluginConfig } = usePlugin();

  const [error, setError] = useState<string | undefined>();
  const [tenantId, setTenantId] = useState('public');
  const [email, setEmail] = useState<string | undefined>();
  const [banStatus, setBanStatus] = useState<boolean | null>(null);

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
    [scheduleErrorReset]
  );

  const getBanStatus = useCallback(
    (email: string) =>
      api
        .getBanStatus(tenantId, email)
        .then((res) => {
          if (res.status === 'OK') {
            setError(undefined);
            setBanStatus(res.banned);
          } else {
            setError(res.message);
            scheduleErrorReset();
          }
        })
        .catch(onError),
    [tenantId]
  );

  const updateBanStatus = useCallback(
    (isBanned: boolean) => {
      if (!email) {
        setError('Email is required');
        scheduleErrorReset();
        return;
      }

      return api
        .updateBanStatus(tenantId, email, isBanned)
        .then(() => {
          setError(undefined);
          setBanStatus(isBanned);
        })
        .catch(onError);
    },
    [tenantId, email]
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
    [getBanStatus, email]
  );

  const onBanUser = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      updateBanStatus(true);
    },
    [updateBanStatus, email]
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
    [updateBanStatus, email]
  );

  return (
    <SessionAuth
      overrideGlobalClaimValidators={(globalValidators) => [
        ...globalValidators,
        {
          ...PermissionClaim.validators.includes(pluginConfig.permissionName),
          onFailureRedirection: () =>
            pluginConfig.onPermissionFailureRedirectPath,
        },
      ]}
    >
      <ThemeBase userStyles={[styles]}>
        <div className="supertokens-plugin-user-banning">
          <div className="container">
            <div className="row">
              <div className="headerTitle">Ban User</div>
              <p>
                This page is used to ban and unban users. It is useful for
                preventing users from accessing your application.
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
                  <button
                    className="button"
                    onClick={onCheckStatus}
                    disabled={!(!!tenantId && !!email)}
                  >
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
                    <button
                      className="button"
                      disabled={banStatus}
                      onClick={onBanUser}
                      style={{ marginRight: '20px' }}
                    >
                      Ban
                    </button>

                    <button
                      className="button"
                      disabled={!banStatus}
                      onClick={onUnbanUser}
                    >
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

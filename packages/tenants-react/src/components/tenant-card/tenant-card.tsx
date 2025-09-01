import classNames from 'classnames/bind';
import { Button, Card, TextInput, usePrettyAction } from '@supertokens-plugin-profile/common-frontend';
import { TenantCreateData, TenantJoinData, TenantList } from '@supertokens-plugin-profile/tenants-shared';
import { useState } from 'react';
import styles from './tenant-card.module.scss';

const cx = classNames.bind(styles);

interface TenantCardProps {
  data: TenantList;
  onJoin: (data: TenantJoinData) => Promise<{ status: 'OK' } | { status: 'ERROR'; message: string }>;
  onCreate: (
    data: TenantCreateData,
  ) => Promise<{ status: 'OK'; pendingApproval: boolean; requestId: string } | { status: 'ERROR'; message: string }>;
  isLoading: boolean;
}

export const TenantCard = ({ data, onJoin, onCreate, isLoading }: TenantCardProps) => {
  if (isLoading) {
    return <Card description="Loading..." />;
  }

  const [newTenantName, setNewTenantName] = useState<string>('');

  const onSuccess = () => {
    // Redirect the user to the app.
    console.log('Redirecting...');
  };

  const handleCreateAndJoin = usePrettyAction(
    async () => {
      if (newTenantName.trim().length === 0) {
        console.warn('No tenant name provided');
        return;
      }

      const createResponse = await onCreate({ name: newTenantName });
      if (createResponse.status !== 'OK') {
        throw new Error(createResponse.message);
      }

      // If creation is pending approval, show a message to the user
      if (createResponse.pendingApproval) {
        throw new Error('Tenant creation request is pending approval');
        return;
      }

      // If creation is successful, join the tenant
      await onJoin({ tenantId: newTenantName });
    },
    [onCreate, newTenantName],
    {
      successMessage: 'Tenant created, redirecting...',
      errorMessage: 'Failed to create tenant',
      onSuccess: async () => {
        onSuccess();
      },
    },
  );

  return (
    <Card>
      <div slot="header" className={cx('createTenantHeader')}>
        Create Tenant
      </div>
      <div slot="footer" className={cx('createTenantFooter')}>
        <Button
          onClick={() => handleCreateAndJoin()}
          disabled={newTenantName.trim() === ''}
          variant="brand"
          appearance="accent"
        >
          Create and Join
        </Button>
      </div>
      <div>
        <Card className={cx('createTenantInputContainer')}>
          <div className={cx('createTenantInputCardText')} slot="header">
            Enter name of your tenant
          </div>
          <div className={cx('createTenantInputWrapper')}>
            <TextInput
              id="tenant-type"
              required
              value={newTenantName}
              onChange={(value) => {
                setNewTenantName(value);
              }}
              type="text"
              appearance="outlined"
              className={cx('createTenantInput')}
            />
          </div>
        </Card>
      </div>
    </Card>
  );
};

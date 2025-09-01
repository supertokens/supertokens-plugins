// DEBUG: Modified at 17:30 on 2025-07-28 - CHECK IF THIS APPEARS IN BROWSER
import { useState, useEffect, useCallback } from 'react';
import classNames from 'classnames/bind';
import style from './tenant-management.module.scss';
import { BaseFormSection } from '@supertokens-plugin-profile/common-details-shared';
import { usePlugin } from '../../use-plugin';
import { TenantDetails } from '@supertokens-plugin-profile/tenants-shared';
import { DetailsWrapper } from '../details/details-wrapper';
import { InvitationsWrapper } from '../invitations/invitations';
import { SelectInput } from '@supertokens-plugin-profile/common-frontend';

const cx = classNames.bind(style);

export const TenantManagement = ({ section }: { section: BaseFormSection }) => {
  const { getUsers, getInvitations, removeInvitation, addInvitation, fetchTenants, switchTenant } = usePlugin();
  const [tenants, setTenants] = useState<TenantDetails[]>([]);
  const [selectedTenantId, setSelectedTenantId] = useState<string>('public');
  const [activeTab, setActiveTab] = useState<'users' | 'invitations'>('users');

  // Load tenants on component mount
  useEffect(() => {
    const loadTenants = async () => {
      const response = await fetchTenants();
      if (response.status === 'OK') {
        setTenants(response.tenants);
        if (response.tenants.length > 0) {
          setSelectedTenantId(response.tenants[0].tenantId);
        }
      }
    };
    loadTenants();
  }, [fetchTenants]);

  // Users tab functions
  const onFetchUsers = useCallback(async () => {
    const response = await getUsers(selectedTenantId);
    if (response.status === 'ERROR') {
      throw new Error(response.message);
    }
    return { users: response.users };
  }, [getUsers, selectedTenantId]);

  // Invitations tab functions
  const onFetchInvitations = useCallback(
    async (tenantId?: string) => {
      const response = await getInvitations(tenantId || selectedTenantId);
      if (response.status === 'ERROR') {
        throw new Error(response.message);
      }
      return { invitations: response.invitees };
    },
    [getInvitations, selectedTenantId],
  );

  const onRemoveInvite = useCallback(
    async (email: string, tenantId?: string) => {
      const response = await removeInvitation(email, tenantId || selectedTenantId);
      if (response.status === 'ERROR') {
        throw new Error(response.message);
      }
    },
    [removeInvitation, selectedTenantId],
  );

  const onCreateInvite = useCallback(
    async (email: string, tenantId: string) => {
      const response = await addInvitation(email, tenantId);
      if (response.status === 'ERROR') {
        throw new Error(response.message);
      }
    },
    [addInvitation],
  );

  const handleTenantSwitch = useCallback(
    async (tenantId: string) => {
      const response = await switchTenant(tenantId);
      if (response.status === 'OK') {
        setSelectedTenantId(tenantId);
      } else {
        console.error('Failed to switch tenant:', response.message);
      }
    },
    [switchTenant],
  );

  return (
    <div className={cx('tenantManagement')}>
      <div className={cx('tenantManagementHeader')}>
        <div>
          <h3>{section.label}</h3>
          <p>{section.description}</p>
        </div>

        {/* Tenant Switcher */}
        {tenants.length > 0 && (
          <div className={cx('tenantSwitcherWrapper')}>
            <SelectInput
              id="tenant-select"
              label="Select Tenant:"
              value={selectedTenantId}
              onChange={(e: any) => handleTenantSwitch(e.target.value)}
              name="Tenant Switcher"
              options={tenants.map(({ tenantId }) => ({
                label: tenantId === 'public' ? 'Public' : tenantId,
                value: tenantId,
              }))}
            />
          </div>
        )}
      </div>

      {/* Tab Navigation */}
      <div className={cx('tabNavigation')}>
        <button className={cx('tabButton', { active: activeTab === 'users' })} onClick={() => setActiveTab('users')}>
          Users
        </button>
        <button
          className={cx('tabButton', { active: activeTab === 'invitations' })}
          onClick={() => setActiveTab('invitations')}
        >
          Invitations
        </button>
      </div>

      {/* Tab Content */}
      <div className={cx('tabContent')}>
        {activeTab === 'users' && selectedTenantId && (
          <DetailsWrapper
            section={{
              id: 'tenant-users',
              label: 'Tenant Users',
              description: 'Users in this tenant',
              fields: [],
            }}
            onFetch={onFetchUsers}
          />
        )}

        {activeTab === 'invitations' && selectedTenantId && (
          <InvitationsWrapper
            section={{
              id: 'tenant-invitations',
              label: 'Tenant Invitations',
              description: 'Invitations for this tenant',
              fields: [],
            }}
            onFetch={onFetchInvitations}
            onRemove={onRemoveInvite}
            onCreate={onCreateInvite}
            selectedTenantId={selectedTenantId}
          />
        )}
      </div>
    </div>
  );
};

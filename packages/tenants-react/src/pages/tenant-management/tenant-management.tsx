import { TenantDetails } from "@shared/tenants";
import { SelectInput, TabGroup, Tab, TabPanel, ToastProvider, ToastContainer } from "@shared/ui";
// import { BaseFormSection } from "@supertokens-plugin-profile/common-details-shared";
import classNames from "classnames/bind";
import { useState, useEffect, useCallback } from "react";

import { Invitations } from "../../components/invitations/invitations";
import { TenantTab } from "../../components/tab/TenantTab";
import { TenantUsers } from "../../components/users/TenantUsers";
import { logDebugMessage } from "../../logger";
import { usePluginContext } from "../../plugin";

import style from "./styles.module.scss";

const cx = classNames.bind(style);

export const TenantManagementWithoutToastWrapper = ({ section }: { section: any }) => {
  const { api, t } = usePluginContext();
  const { getUsers, getInvitations, removeInvitation, fetchTenants, switchTenant, changeRole } = api;
  const [tenants, setTenants] = useState<TenantDetails[]>([]);
  const [selectedTenantId, setSelectedTenantId] = useState<string>("public");

  // Load tenants on component mount
  useEffect(() => {
    const loadTenants = async () => {
      const response = await fetchTenants();
      if (response.status === "OK") {
        setTenants(response.tenants);

        // TODO: Set the selected tenant from the user details
        if (response.tenants.length > 0) {
          setSelectedTenantId(response.tenants[0]!.tenantId);
        }
      }
    };
    loadTenants();
  }, [fetchTenants]);

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

  // Invitations tab functions
  const onFetchInvitations = useCallback(async () => {
    const response = await getInvitations();
    if (response.status === "ERROR") {
      throw new Error(response.message);
    }
    return { invitations: response.invitees };
  }, [getInvitations]);

  const handleTenantSwitch = useCallback(
    async (tenantId: string) => {
      const response = await switchTenant(tenantId);
      if (response.status === "OK") {
        setSelectedTenantId(tenantId);
      } else {
        console.error("Failed to switch tenant:", response.message);
      }
    },
    [switchTenant],
  );

  return (
    <div className={cx("tenantManagement")}>
      <div className={cx("tenantManagementHeader")}>
        <div>
          <h3>{section.label}</h3>
          <p>{section.description}</p>
        </div>

        {/* Tenant Switcher */}
        {tenants.length > 0 && (
          <div className={cx("tenantSwitcherWrapper")}>
            <SelectInput
              id="tenant-select"
              label="Select Tenant:"
              value={selectedTenantId}
              onChange={(e: any) => handleTenantSwitch(e.target.value)}
              name="Tenant Switcher"
              options={tenants.map(({ tenantId }) => ({
                label: tenantId === "public" ? "Public" : tenantId,
                value: tenantId,
              }))}
            />
          </div>
        )}
      </div>

      {/* Tab Navigation */}
      <div>
        <TabGroup>
          <Tab panel="users">{t("PL_TB_USERS_TAB_LABEL")}</Tab>
          <Tab panel="invitations">{t("PL_TB_INVITATIONS_TAB_LABEL")}</Tab>
          <Tab panel="requests">{t("PL_TB_REQUESTS_TAB_LABEL")}</Tab>

          {/* Tab Content */}
          <TabPanel name="users">
            <TenantTab description="List of users that are part of your tenant">
              <TenantUsers onFetch={onFetchUsers} onRoleChange={onRoleChange} />
            </TenantTab>
          </TabPanel>
          <TabPanel name="invitations">
            <Invitations onFetch={onFetchInvitations} selectedTenantId={selectedTenantId} />
          </TabPanel>
        </TabGroup>
      </div>
    </div>
  );
};

export const TenantManagement = (props) => {
  return (
    <ToastProvider>
      <TenantManagementWithoutToastWrapper {...props} />
      <ToastContainer />
    </ToastProvider>
  );
};

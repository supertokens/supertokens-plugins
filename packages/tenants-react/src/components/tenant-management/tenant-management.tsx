import { TenantDetails } from "@shared/tenants";
import { SelectInput, TabGroup, Tab } from "@shared/ui";
// import { BaseFormSection } from "@supertokens-plugin-profile/common-details-shared";
import classNames from "classnames/bind";
import { useState, useEffect, useCallback } from "react";

import { usePluginContext } from "../../plugin";
import { DetailsWrapper } from "../details/details-wrapper";
import { InvitationsWrapper } from "../invitations/invitations";

import style from "./styles.module.scss";

const cx = classNames.bind(style);

export const TenantManagement = ({ section }: { section: any }) => {
  const { api, t } = usePluginContext();
  const { getUsers, getInvitations, removeInvitation, addInvitation, fetchTenants, switchTenant } = api;
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

  // Invitations tab functions
  const onFetchInvitations = useCallback(
    async () => {
      const response = await getInvitations();
      if (response.status === "ERROR") {
        throw new Error(response.message);
      }
      return { invitations: response.invitees };
    },
    [getInvitations],
  );

  const onRemoveInvite = useCallback(
    async (email: string) => {
      const response = await removeInvitation(email);
      if (response.status === "ERROR") {
        throw new Error(response.message);
      }
    },
    [removeInvitation],
  );

  const onCreateInvite = useCallback(
    async (email: string) => {
      const response = await addInvitation(email);
      if (response.status === "ERROR") {
        throw new Error(response.message);
      }
    },
    [addInvitation],
  );

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
          <Tab panel={t("PL_TB_USERS_TAB_LABEL")}>
            <DetailsWrapper
              section={{
                id: "tenant-users",
                label: "Tenant Users",
                description: "Users in this tenant",
                fields: [],
              }}
              onFetch={onFetchUsers}
            />
          </Tab>
          <Tab panel={t("PL_TB_INVITATIONS_TAB_LABEL")}>
            <InvitationsWrapper
              section={{
                id: "tenant-invitations",
                label: "Tenant Invitations",
                description: "Invitations for this tenant",
                fields: [],
              }}
              onFetch={onFetchInvitations}
              onRemove={onRemoveInvite}
              onCreate={onCreateInvite}
              selectedTenantId={selectedTenantId}
            />
          </Tab>
          <Tab panel={t("PL_TB_REQUESTS_TAB_LABEL")}></Tab>
        </TabGroup>
      </div>
    </div>
  );
};

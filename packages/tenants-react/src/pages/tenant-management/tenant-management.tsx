import { TenantDetails } from "@shared/tenants";
import { SelectInput, ToastProvider, ToastContainer } from "@shared/ui";
// import { BaseFormSection } from "@supertokens-plugin-profile/common-details-shared";
import classNames from "classnames/bind";
import { useState, useEffect, useCallback } from "react";

import { TenantTab } from "../../components/tab/TenantTab";
import { usePluginContext } from "../../plugin";

import style from "./styles.module.scss";
import { TenantUsersCombined } from "./tenant-users-combined";

const cx = classNames.bind(style);

export const TenantManagementWithoutToastWrapper = ({ section }: { section: any }) => {
  const { api, t } = usePluginContext();
  const { getUsers, getInvitations, removeInvitation, removeUserFromTenant, fetchTenants, switchTenant, changeRole } =
    api;
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
        <TenantTab description={t("PL_TB_TENANT_USERS_COMBINED_DESCRIPTION")}>
          <TenantUsersCombined tenantId={selectedTenantId} />
        </TenantTab>
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

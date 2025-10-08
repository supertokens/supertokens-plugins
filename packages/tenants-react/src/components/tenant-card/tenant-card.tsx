import { TenantCreateData, TenantJoinData, TenantList } from "@shared/tenants";
import { Button, Card, TextInput, usePrettyAction } from "@shared/ui";
import classNames from "classnames/bind";
import { useState } from "react";

import { usePluginContext } from "../../plugin";

import style from "./tenant-card.module.scss";

const cx = classNames.bind(style);

interface TenantCardProps {
  onJoin: (data: TenantJoinData) => Promise<{ status: "OK" } | { status: "ERROR"; message: string }>;
  onCreate: (
    data: TenantCreateData,
  ) => Promise<{ status: "OK"; pendingApproval: boolean; requestId: string } | { status: "ERROR"; message: string }>;
  isLoading: boolean;
}

export const TenantCard = ({ onJoin, onCreate, isLoading }: TenantCardProps) => {
  const [newTenantName, setNewTenantName] = useState<string>("");
  const [validationError, setValidationError] = useState<string>("");
  const { t, pluginConfig } = usePluginContext();

  const validateTenantName = (name: string): boolean => {
    // Allow only alphanumeric characters and dashes, no spaces or special characters
    const validPattern = /^[a-zA-Z0-9-]+$/;
    return validPattern.test(name);
  };

  const onSuccess = () => {
    // Redirect the user to the app.
    (globalThis as any).location.href = pluginConfig.redirectToUrlOnJoiningTenant;
  };

  const handleCreateAndJoin = usePrettyAction(
    async () => {
      if (newTenantName.trim().length === 0) {
        console.warn("No tenant name provided");
        return;
      }

      const createResponse = await onCreate({ name: newTenantName });
      if (createResponse.status !== "OK") {
        throw new Error(createResponse.message);
      }

      // NOTE: We don't need to handle the pendingApproval
      // flow since that's handled in the parent component
      if (createResponse.pendingApproval) {
        return;
      }

      // If creation is successful, join the tenant
      await onJoin({ tenantId: newTenantName });
    },
    [onCreate, newTenantName],
    {
      successMessage: "Tenant created, redirecting...",
      errorMessage: "Failed to create tenant",
      onSuccess: async () => {
        onSuccess();
      },
    },
  );

  if (isLoading) {
    return <Card description="Loading..." />;
  }

  return (
    <Card>
      <div slot="header" className={cx("createTenantHeader")}>
        {t("PL_TB_CREATE_TENANT_LABEL")}
      </div>
      <div slot="footer" className={cx("createTenantFooter")}>
        <Button
          onClick={() => handleCreateAndJoin()}
          disabled={newTenantName.trim() === "" || validationError !== ""}
          variant="brand"
          appearance="accent">
          {t("PL_TB_CREATE_TENANT_BUTTON_TEXT")}
        </Button>
      </div>
      <div>
        <Card className={cx("createTenantInputContainer")}>
          <div className={cx("createTenantInputCardText")} slot="header">
            {t("PL_TB_CREATE_TENANT_ENTER_NAME_LABEL")}
          </div>
          <div className={cx("createTenantInputWrapper")}>
            <TextInput
              id="tenant-type"
              required
              value={newTenantName}
              onChange={(value) => {
                setNewTenantName(value);
                // Validate in real-time as user types
                if (value.trim().length > 0 && !validateTenantName(value)) {
                  setValidationError("Tenant name can only contain letters, numbers, and dashes");
                } else {
                  setValidationError("");
                }
              }}
              type="text"
              appearance="outlined"
              className={cx("createTenantInput")}
            />
          </div>
          {validationError && <div className={cx("validationError")}>{validationError}</div>}
        </Card>
      </div>
    </Card>
  );
};

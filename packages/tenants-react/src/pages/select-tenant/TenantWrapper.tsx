import { TenantCreateData, TenantJoinData } from "@shared/tenants";
import { ToastProvider, ToastContainer, usePrettyAction } from "@shared/ui";
import { useCallback, useEffect, useState } from "react";

import { TenantCard } from "../../components";
import { AwaitingApprovalMessage } from "../../components/tenant-card/awaiting-approval";
import { logDebugMessage } from "../../logger";
import { usePluginContext } from "../../plugin";

const TenantCardWrapper = () => {
  const { api, pluginConfig, t } = usePluginContext();
  const { joinTenant, createTenant } = api;
  const [isLoading, setIsLoading] = useState(false);
  const [isPendingApproval, setIsPendingApproval] = useState(false);

  const handleOnJoin = useCallback(
    async (data: TenantJoinData) => {
      setIsLoading(true);
      try {
        const result = await joinTenant(data);

        // If there was an error, show that
        if (result.status === "ERROR") {
          console.error(result.message);
          return result;
        }

        // If it was successful, redirect the user.
        if (result.status === "OK" && !isPendingApproval) {
          logDebugMessage("Successfully joined tenant");
          pluginConfig.redirectOnJoiningTenantFn();
        }

        return result;
      } finally {
        setIsLoading(false);
      }
    },
    [isPendingApproval, joinTenant, pluginConfig],
  );

  const handleOnCreate = async (data: TenantCreateData) => {
    setIsLoading(true);
    try {
      const result = await createTenant(data);

      // If there was an error, show that
      if (result.status === "ERROR") {
        throw new Error(result.message);
      }

      // If it's pending approval, we need to change the view
      if (result.pendingApproval) {
        setIsPendingApproval(true);
      }

      return result;
    } finally {
      setIsLoading(false);
    }
  };

  const fetchIfThereIsExistingRequest = usePrettyAction(async () => {
    try {
      setIsLoading(true);
      const existingRequestRes = await api.doesUserHaveExistingCreationRequest();
      if (existingRequestRes.status === "ERROR") {
        throw new Error(existingRequestRes.message);
      }

      if (existingRequestRes.exists === true) {
        setIsPendingApproval(true);
      }
    } finally {
      setIsLoading(false);
    }
  }, [api.doesUserHaveExistingCreationRequest]);

  useEffect(() => {
    fetchIfThereIsExistingRequest();
  }, []);

  return isPendingApproval ? (
    <AwaitingApprovalMessage
      headerText={t("PL_TB_CREATE_TENANT_AWAITING_APPROVAL_HEADER")}
      messageContent={
        <div>
          {t("PL_TB_CREATE_TENANT_AWAITING_APPROVAL_MESSAGE")}{" "}
          <b>{t("PL_TB_CREATE_TENANT_AWAITING_APPROVAL_MESSAGE_HIGHLIGHT")}</b>
        </div>
      }
    />
  ) : (
    <TenantCard onJoin={handleOnJoin} onCreate={handleOnCreate} isLoading={isLoading} />
  );
};

const TenantCardWrapperWithToast = () => {
  return (
    <ToastProvider>
      <TenantCardWrapper />
      <ToastContainer />
    </ToastProvider>
  );
};

export default TenantCardWrapperWithToast;

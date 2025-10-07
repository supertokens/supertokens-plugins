import { TenantCreateData, TenantJoinData } from "@shared/tenants";
import { ToastProvider, ToastContainer } from "@shared/ui";
import { useState } from "react";

import { TenantCard } from "../../components";
import { AwaitingApprovalMessage } from "../../components/tenant-card/awaiting-approval";
import { logDebugMessage } from "../../logger";
import { usePluginContext } from "../../plugin";

const TenantCardWrapper = () => {
  const { api, pluginConfig } = usePluginContext();
  const { joinTenant, createTenant } = api;
  const [isLoading, setIsLoading] = useState(false);
  const [isPendingApproval, setIsPendingApproval] = useState(false);

  const handleOnJoin = async (data: TenantJoinData) => {
    setIsLoading(true);
    try {
      const result = await joinTenant(data);

      // If there was an error, show that
      if (result.status === "ERROR") {
        console.error(result.message);
        return result;
      }

      // If it was successful, redirect the user.
      if (result.status === "OK") {
        logDebugMessage("Successfully joined tenant");
        window.location.assign(pluginConfig.redirectToUrlOnJoiningTenant);
      }

      return result;
    } finally {
      setIsLoading(false);
    }
  };

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

  return isPendingApproval ? (
    <AwaitingApprovalMessage />
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

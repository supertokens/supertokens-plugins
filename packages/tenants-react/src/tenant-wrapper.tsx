import { TenantCreateData, TenantJoinData, TenantList } from "@shared/tenants";
import { ToastProvider, ToastContainer } from "@shared/ui";
import { useEffect, useState } from "react";

import { TenantCard } from "./components";
import { AwaitingApprovalMessage } from "./components/tenant-card/awaiting-approval";
import { logDebugMessage } from "./logger";
import { usePluginContext } from "./plugin";

const TenantCardWrapper = () => {
  const { api } = usePluginContext();
  const { fetchTenants, joinTenant, createTenant } = api;
  const [data, setData] = useState<TenantList>({
    tenants: [],
    joinedTenantIds: [],
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isPendingApproval, setIsPendingApproval] = useState(false);

  useEffect(() => {
    setIsLoading(true);
    fetchTenants().then((result) => {
      if (result.status === "OK") {
        setData(result);
      }
      setIsLoading(false);
    });
  }, []);

  const handleOnJoin = async (data: TenantJoinData) => {
    setIsLoading(true);
    try {
      const result = await joinTenant(data);

      // If there was an error, show that
      if (result.status === "ERROR") {
        console.error(result.message);
        return result;
      }

      // If it was successful, redirect the user to `/user/profile`.
      if (result.status === "OK") {
        logDebugMessage("Successfully joined tenant");
        if (result.wasSessionRefreshed) {
          logDebugMessage("Session was refreshed");
        } else {
          logDebugMessage("Please go to `/user/profile` to continue");
        }
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
    <TenantCard data={data} onJoin={handleOnJoin} onCreate={handleOnCreate} isLoading={isLoading} />
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

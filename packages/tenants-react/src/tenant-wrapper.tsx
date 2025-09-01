import { TenantCreateData, TenantJoinData, TenantList } from "@shared/tenants";
import { ToastProvider, ToastContainer } from "@shared/ui";
import { useEffect, useState } from "react";

import { TenantCard } from "./components";
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
        console.error(result.message);
        return result;
      }

      return result;
    } finally {
      setIsLoading(false);
    }
  };

  return <TenantCard data={data} onJoin={handleOnJoin} onCreate={handleOnCreate} isLoading={isLoading} />;
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

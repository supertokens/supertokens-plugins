import { ToastContainer, ToastProvider } from "@shared/ui";
import { useCallback } from "react";

import { AccountDetailsSection } from "./components";
import { usePluginContext } from "./plugin";

export const AccountSectionWrapper = () => {
  const { api } = usePluginContext();

  const getDetails = useCallback(async () => {
    const response = await api.getDetails();

    if (response.status === "ERROR") {
      throw new Error(response.message);
    }

    return { profile: response.profile, user: response.user };
  }, []);

  return (
    <ToastProvider>
      <AccountDetailsSection onFetch={getDetails} />
      <ToastContainer />
    </ToastProvider>
  );
};

import { ToastContainer, ToastProvider } from "@shared/ui";
import { BaseFormFieldPayload, BaseFormSection } from "@supertokens-plugins/profile-details-shared";
import { useCallback } from "react";

import { DetailsSectionContent } from "./components";
import { usePluginContext } from "./plugin";

export const DetailsSectionWrapper = ({ section }: { section: BaseFormSection }) => {
  const { componentMap, api } = usePluginContext();

  const saveDetails = useCallback(async (data: BaseFormFieldPayload[]) => {
    const response = await api.updateProfile({ data });

    if (response.status === "ERROR") {
      throw new Error(response.message);
    }

    return true;
  }, []);

  const getDetails = useCallback(async () => {
    const response = await api.getDetails();

    if (response.status === "ERROR") {
      throw new Error(response.message);
    }

    return { profile: response.profile, user: response.user };
  }, []);

  return (
    <ToastProvider>
      <DetailsSectionContent
        section={section}
        onSubmit={saveDetails}
        onFetch={getDetails}
        componentMap={componentMap}
      />
      <ToastContainer />
    </ToastProvider>
  );
};

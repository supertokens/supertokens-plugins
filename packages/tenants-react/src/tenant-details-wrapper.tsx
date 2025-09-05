// import { BaseFormSection } from "@supertokens-plugin-profile/common-details-shared";
import { useCallback } from "react";

import { DetailsWrapper } from "./components/details/details-wrapper";
import { usePluginContext } from "./plugin";

export const TenantDetailsWrapper = ({ section }: { section: any }) => {
  const { api } = usePluginContext();

  const onFetch = useCallback(async () => {
    // Use the `tid` from the users access token payload.

    const response = await api.getUsers();
    if (response.status === "ERROR") {
      throw new Error(response.message);
    }
    return { users: response.users };
  }, [api.getUsers, section.id]);

  return <DetailsWrapper section={section} onFetch={onFetch} />;
};

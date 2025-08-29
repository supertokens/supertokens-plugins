import { getQuerier } from "@shared/react";

import { TenantList } from "./types";

export const getApi = (querier: ReturnType<typeof getQuerier>) => {
  const fetchTenants = async () => {
    const response = await querier.get<({ status: "OK" } & TenantList) | { status: "ERROR"; message: string }>(
      "/list",
      {
        withSession: false,
      },
    );

    return response;
  };

  return {
    fetchTenants,
  };
};

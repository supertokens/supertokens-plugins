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

  const tenantIdFromEmail = async (email: string) => {
    const response = await querier.post<{ status: "OK"; tenant: string; inferredTenantId: string; email: string } | { status: "ERROR"; message: string }>(
      "/from-email",
      {
        email
      },
      {
        withSession: false,
      },
    );
  };

  return {
    fetchTenants,
    tenantIdFromEmail,
  };
};

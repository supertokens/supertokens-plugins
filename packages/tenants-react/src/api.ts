import { getQuerier } from "@shared/react";
import { InviteeDetails, TenantCreateData, TenantJoinData, TenantList } from "@shared/tenants";
import Session from "supertokens-auth-react/recipe/session";
import { User } from "supertokens-web-js/types";

export const getApi = (querier: ReturnType<typeof getQuerier>) => {
  const fetchTenants = async () => {
    const response = await querier.get<({ status: "OK" } & TenantList) | { status: "ERROR"; message: string }>(
      "/list",
      {
        withSession: true,
      },
    );

    return response;
  };

  const joinTenant = async (data: TenantJoinData) => {
    const response = await querier.post<{ status: "OK" } | { status: "ERROR"; message: string }>(
      "/join",
      {
        ...data,
      },
      { withSession: true },
    );

    // Refresh the session if the status was OK
    let wasSessionRefreshed = false;
    if (response.status === "OK") {
      wasSessionRefreshed = await Session.attemptRefreshingSession();
    }

    return {
      ...response,
      wasSessionRefreshed,
    };
  };

  const createTenant = async (data: TenantCreateData) => {
    const response = await querier.post<
      { status: "OK"; pendingApproval: boolean; requestId: string } | { status: "ERROR"; message: string }
    >(
      "/create",
      {
        ...data,
      },
      { withSession: true },
    );

    return response;
  };

  const getUsers = async () => {
    const response = await querier.post<{ status: "OK"; users: User[] } | { status: "ERROR"; message: string }>(
      "/users",
      {},
      { withSession: true },
    );

    return response;
  };

  const getInvitations = async () => {
    const response = await querier.post<
      { status: "OK"; invitees: InviteeDetails[] } | { status: "ERROR"; message: string }
    >("/invite/list", {}, { withSession: true });

    return response;
  };

  const removeInvitation = async (email: string) => {
    const response = await querier.post<{ status: "OK" } | { status: "ERROR"; message: string }>(
      "/invite/remove",
      { email },
      { withSession: true },
    );

    return response;
  };

  const addInvitation = async (email: string) => {
    const response = await querier.post<{ status: "OK"; code: string } | { status: "ERROR"; message: string }>(
      "/invite/add",
      { email },
      { withSession: true },
    );

    return response;
  };

  const acceptInvitation = async (code: string, tenantId: string) => {
    const response = await querier.post<{ status: "OK" } | { status: "ERROR"; message: string }>(
      "/invite/accept",
      { code, tenantId },
      { withSession: true },
    );

    return response;
  };

  const switchTenant = async (tenantId: string) => {
    const response = await querier.post<{ status: "OK" } | { status: "ERROR"; message: string }>(
      "/switch-tenant",
      { tenantId },
      { withSession: true },
    );

    return response;
  };

  const changeRole = async (userId: string, role: string) => {
    const response = await querier.post<{ status: "OK" } | { status: "ERROR"; message: string }>(
      "/role/change",
      { userId, role },
      { withSession: true },
    );

    return response;
  };

  const removeUserFromTenant = async (userId: string) => {
    const response = await querier.post<{ status: "OK" } | { status: "ERROR"; message: string }>(
      "/remove",
      { userId },
      { withSession: true },
    );

    return response;
  };

  const getOnboardingRequests = async () => {
    const response = await querier.post<{ status: "OK"; users: User[] } | { status: "ERROR"; message: string }>(
      "/request/list",
      {},
      { withSession: true },
    );
    return response;
  };

  const acceptOnboardingAccept = async (userId: string) => {
    return querier.post<{ status: "OK" } | { status: "ERROR"; message: string }>(
      "/request/accept",
      { userId },
      { withSession: true },
    );
  };

  const declineOnboardingAccept = async (userId: string) => {
    return querier.post<{ status: "OK" } | { status: "ERROR"; message: string }>(
      "/request/reject",
      { userId },
      { withSession: true },
    );
  };

  return {
    fetchTenants,
    joinTenant,
    createTenant,
    getInvitations,
    getUsers,
    removeInvitation,
    addInvitation,
    acceptInvitation,
    switchTenant,
    changeRole,
    removeUserFromTenant,
    getOnboardingRequests,
    acceptOnboardingAccept,
    declineOnboardingAccept,
  };
};

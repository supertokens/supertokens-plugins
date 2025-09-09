import { TenantConfig } from "supertokens-node/lib/build/recipe/multitenancy/types";

export type TenantJoinData = {
  tenantId: string;
};

export type TenantCreateData = {
  name: string;
};

export type TenantDetails = {
  tenantId: string;
  displayName: string;
};

export type TenantList = {
  tenants: TenantDetails[];
  joinedTenantIds: string[];
};

export type InviteeDetails = {
  email: string;
  role: string;
  code: string;
};

export type TenantCreationRequest = {
  name: string;
  firstFactors?: string[] | null;
  requestId: string;
};

export type TenantMetadata = {
  invitees: InviteeDetails[];
};

export type TenantCreationRequestMetadata = {
  requests: (TenantCreationRequest & { userId: string })[];
};

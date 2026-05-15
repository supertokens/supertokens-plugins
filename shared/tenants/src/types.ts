import { SessionClaimValidator } from "supertokens-node/recipe/session";

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

export type TenantCreationRequestWithUser = TenantCreationRequest & {
  id: string;
  emails: string[];
};

export type TenantMetadata = {
  invitees: InviteeDetails[];
};

export type TenantCreationRequestMetadata = {
  requests: (TenantCreationRequest & { userId: string })[];
};

export type FilterGlobalClaimValidators = (
  globalValidators: SessionClaimValidator[],
) => SessionClaimValidator[] | Promise<SessionClaimValidator[]>;

export enum NotAllowedToSignUpReason {
  INVITE_ONLY,
  EMAIL_DOMAIN_NOT_ALLOWED,
  IDP_NOT_ALLOWED,
  PHONE_NOT_ALLOWED,
}

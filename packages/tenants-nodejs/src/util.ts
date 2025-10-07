import { BaseRequest } from "supertokens-node/lib/build/framework/request";
import Session from "supertokens-node/recipe/session";
import { PermissionClaim } from "supertokens-node/recipe/userroles";

export const validateWithoutClaims = (keys: string[]) => {
  return (existingValidators: Session.SessionClaimValidator[]) => {
    const keysToRemoveSet = new Set(keys);
    return existingValidators.filter(validator => !keysToRemoveSet.has(validator.id));
  };
};

export const hasPermissions = (permissions: string[]) => (globalValidators: Session.SessionClaimValidator[]) => {
  return [
    ...globalValidators,
    PermissionClaim.validators.includesAny(permissions),
  ];
};

export const extractInvitationCodeAndTenantId = async (req: BaseRequest) => {
  const body = await req.getJSONBody();
  const code = body.code;
  const tenantId = body.tenantId;
  const shouldAcceptInvite = !!code && !!tenantId;

  return {
    code,
    tenantId,
    shouldAcceptInvite,
  };
};

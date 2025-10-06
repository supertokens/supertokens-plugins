import { BaseRequest } from "supertokens-node/lib/build/framework/request";
import Session from "supertokens-node/recipe/session";

export const validateWithoutClaims = (existingValidators: Session.SessionClaimValidator[], keys: string[]) => {
  const keysToRemoveSet = new Set(keys);
  return existingValidators.filter(validator => !keysToRemoveSet.has(validator.id));
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

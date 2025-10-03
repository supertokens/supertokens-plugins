import { BaseRequest } from "supertokens-node/lib/build/framework/request";
import Session from "supertokens-node/recipe/session";

export const validateWithoutClaim = (existingValidators: Session.SessionClaimValidator[], key: string) => {
  return existingValidators.filter((validator) => validator.id !== key);
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

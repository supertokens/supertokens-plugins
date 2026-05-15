import { NotAllowedToSignUpReason } from './types';

export const NOT_ALLOWED_TO_SIGNUP_REASON_MESSAGE: Record<NotAllowedToSignUpReason, string> = {
  [NotAllowedToSignUpReason.INVITE_ONLY]: 'Tenant is invite only, cannot signup',
  [NotAllowedToSignUpReason.EMAIL_DOMAIN_NOT_ALLOWED]: 'Email domain not allowed to signup to tenant',
  [NotAllowedToSignUpReason.IDP_NOT_ALLOWED]: 'Identity Provider not allowed to signup to tenant',
  [NotAllowedToSignUpReason.PHONE_NOT_ALLOWED]: 'Phone number not allowed to signup to tenant'
};

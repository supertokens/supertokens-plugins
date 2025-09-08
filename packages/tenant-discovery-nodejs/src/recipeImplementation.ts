import { UserContext } from "supertokens-node/types";
import { POPULAR_EMAIL_DOMAINS } from "./constants";
import { OverrideableTenantFunctionImplementation } from "./types";
import MultiTenancy from "supertokens-node/recipe/multitenancy";

export const getOverrideableTenantFunctionImplementation = (): OverrideableTenantFunctionImplementation => {
  const implementation = {
    getTenantIdFromEmail: async function (email: string) {
      const emailSplitted = email.split("@");
      if (emailSplitted.length !== 2) {
        return "public";
      }
      const emailDomain = emailSplitted[1]?.toLowerCase();

      if (!emailDomain) {
        return "public";
      }

      // If it is one of the restricted domains, we will return
      // public.
      if (this.isRestrictedEmailDomain(emailDomain)) {
        return "public";
      }

      // Split the domain using dot (.) and return the second last
      // value from the back.
      const emailDomainSplitted = emailDomain.split(".");
      if (emailDomainSplitted.length < 2) {
        return emailDomain;
      }

      // Return the second last value.
      // Eg: if the domain is `supertokens.com`, the array will be
      // ['supertokens', 'com']
      return emailDomainSplitted[emailDomainSplitted.length - 2] ?? "public";
    },
    getTenants: async function (userContext?: UserContext) {
      const tenantDetails = (await MultiTenancy.listAllTenants(userContext)).tenants;
      return tenantDetails.map((tenant) => ({ tenantId: tenant.tenantId, displayName: tenant.tenantId }));
    },
    isValidTenant: async function (tenantId: string, userContext?: UserContext) {
      /**
       * Check whether the passed tenantId is valid or not.
       *
       * We will check by checking in the list of tenants to
       * see if it is present.
       */
      return (await this.getTenants(userContext)).map((tenant) => tenant.tenantId).includes(tenantId);
    },
    isRestrictedEmailDomain: function (emailDomain: string) {
      /**
       * Check if the passed email domain is part of the restricted email
       * domain list.
       */
      return POPULAR_EMAIL_DOMAINS.includes(emailDomain);
    },
  };

  return implementation;
};

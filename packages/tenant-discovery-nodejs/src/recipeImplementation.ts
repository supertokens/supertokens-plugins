import { OverrideableTenantFunctionImplementation, SuperTokensPluginTenantDiscoveryPluginConfig } from './types';
import MultiTenancy from 'supertokens-node/recipe/multitenancy';

export const getOverrideableTenantFunctionImplementation = (
  config: SuperTokensPluginTenantDiscoveryPluginConfig,
): OverrideableTenantFunctionImplementation => ({
  getTenantIdFromEmail: async (email) => {
    const emailDomainSplitted = email.split('@');
    if (emailDomainSplitted.length !== 2) {
      return 'public';
    }
    const emailDomain = emailDomainSplitted[1]?.toLowerCase();

    if (!emailDomain) {
      return 'public';
    }

    const tenantId = config.emailDomainToTenantIdMap[emailDomain];
    return tenantId || 'public';
  },
  getTenants: async () => {
    return (await MultiTenancy.listAllTenants()).tenants;
  },
});

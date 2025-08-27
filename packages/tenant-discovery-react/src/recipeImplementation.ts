import { ST_EMAIL_VALUE } from './constants';
import { OverrideableTenantFunctionImplementation, PluginConfig } from './types';
import Session from 'supertokens-auth-react/recipe/session';

export const getOverrideableTenantFunctionImplementation = (
  config: PluginConfig,
): OverrideableTenantFunctionImplementation => {
  const implementation = {
    setTenantId: (tenantId: string, email?: string, shouldRefresh?: boolean, shouldOverride?: boolean) => {
      const url = new URL(window.location.href);

      // If the URL already has the tenantId param, don't override it
      // unless that is set to true.
      //
      // We are using the willOverride flag to determine if the tenantId
      // changed in which case we will override and ignore the shouldOverride flag.
      const existingTenantId = url.searchParams.get('tenantId');
      const willOverride = existingTenantId === tenantId;
      if (willOverride && !shouldOverride) {
        return;
      }

      url.searchParams.set('tenantId', tenantId);

      if (email) {
        localStorage.setItem(ST_EMAIL_VALUE, email);
      }

      // If shouldRefresh is not provided, we will default to true
      if (shouldRefresh === undefined) {
        shouldRefresh = true;
      }

      // If shouldRefresh is true, we will refresh the page
      if (shouldRefresh) {
        window.location.href = url.toString();
      }
    },
    determineTenantFromURL: async () => {
      /**
       * Try to determine the tenantId from the URL.
       *
       * This method will try to check if the url matches any of the tenantIds
       * passed in the config and accordingly return that value.
       */
      if (!(await implementation.shouldDetermineTenantFromURL())) {
        return undefined;
      }

      const url = new URL(window.location.href);
      if (!config.urlToTenantIdMap) {
        return undefined;
      }

      // If the url already has a tenantId, return that to avoid
      // an infinite loop.
      const existingTenantId = url.searchParams.get('tenantId');
      if (existingTenantId) {
        return existingTenantId;
      }

      for (const [urlPattern, tenantId] of Object.entries(config.urlToTenantIdMap)) {
        if (url.hostname === urlPattern) {
          return tenantId;
        }
      }

      // Fallback to determining from the url directly if it is a subdomain
      // and `extractTenantIdFromDomain` is enabled.
      return implementation.determineTenantFromSubdomain();
    },
    determineTenantFromSubdomain: async () => {
      /**
       * Try to determine the tenant ID from the subdomain.
       *
       * Returns undefined if no subdomain exists, otherwise returns the subdomain part.
       * Example: test.something.com returns "test"
       */
      if (config.extractTenantIdFromDomain === undefined || config.extractTenantIdFromDomain === false) {
        return undefined;
      }

      const url = new URL(window.location.href);
      const hostname = url.hostname;

      // Split the hostname by dots
      const parts = hostname.split('.');

      // If we have more than 2 parts, we have a subdomain
      // (e.g., "test.something.com" -> ["test", "something", "com"])
      if (parts.length > 2) {
        return parts[0];
      }

      // No subdomain found
      return undefined;
    },
    shouldDetermineTenantFromURL: async () => {
      /**
       * Check if the tenant should be determined from the URL or not.
       */
      // If the user is logged in, we don't want the determine trigger
      // to run.
      return !(await Session.doesSessionExist());
    },
  };
  return implementation;
};

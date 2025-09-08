import Session from "supertokens-auth-react/recipe/session";

import { ST_EMAIL_VALUE_STORAGE_KEY } from "./constants";
import { logDebugMessage } from "./logger";
import {
  OverrideableTenantFunctionImplementation,
  ParseTenantIdReturnType,
  SuperTokensPluginTenantDiscoveryPluginConfig,
} from "./types";

export const getOverrideableTenantFunctionImplementation = (
  config: SuperTokensPluginTenantDiscoveryPluginConfig,
): OverrideableTenantFunctionImplementation => {
  const implementation = {
    setTenantId: function (tenantId: string, email?: string, shouldRefresh?: boolean, shouldOverwrite?: boolean) {
      const url = new URL(window.location.href);

      // If the URL already has the tenantId param, don't override it
      // unless that is set to true.
      //
      // We are using the willOverride flag to determine if the tenantId
      // changed in which case we will override and ignore the shouldOverwrite flag.
      const existingTenantId = url.searchParams.get("tenantId");
      const willOverride = existingTenantId === tenantId;
      if (willOverride && !shouldOverwrite) {
        return;
      }

      url.searchParams.set("tenantId", tenantId);

      if (email) {
        this.setEmailId(email);
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
    determineTenantFromURL: async function () {
      /**
       * Try to determine the tenantId from the URL.
       *
       * This method will try to check if the url matches any of the tenantIds
       * passed in the config and accordingly return that value.
       */
      logDebugMessage("determineTenantFromURL: trying to determine tenant from URL");

      const url = new URL(window.location.href);

      // If the url already has a tenantId, return that to avoid
      // an infinite loop.
      const existingTenantId = url.searchParams.get("tenantId");
      if (existingTenantId) {
        return existingTenantId;
      }

      // Fallback to determining from the url directly if it is a subdomain
      // and `extractTenantIdFromDomain` is enabled.
      return this.determineTenantFromSubdomain();
    },
    determineTenantFromSubdomain: function () {
      /**
       * Try to determine the tenant ID from the subdomain.
       *
       * Returns undefined if no subdomain exists, otherwise returns the subdomain part.
       * Example: test.something.com returns "test"
       */
      if (config.extractTenantIdFromDomain !== true) {
        return undefined;
      }

      const url = new URL(window.location.href);
      const hostname = url.hostname;

      // Split the hostname by dots
      const parts = hostname.split(".");

      // If we have more than 2 parts, we have a subdomain
      // (e.g., "test.something.com" -> ["test", "something", "com"])
      if (parts.length > 2) {
        return parts[0];
      }

      // No subdomain found
      return undefined;
    },
    parseTenantId: function (): ParseTenantIdReturnType {
      // Get the urlParams and check if it has a tenantId
      const urlParams = new URLSearchParams(window.location.search);
      let tenantId = urlParams.get("tenantId") ?? undefined;
      logDebugMessage(`tenantId inferred from query param: ${tenantId}`);

      // If `tenantId` is not found in the query param, try to parse it from
      // URL as a fallback.
      if (tenantId === undefined) {
        logDebugMessage("Falling back to inferring tenantId using subdomain");
        tenantId = this.determineTenantFromSubdomain();
      }

      logDebugMessage(`final tenant ID: ${tenantId}`);

      return tenantId === undefined
        ? { tenantId: null, shouldShowSelector: true }
        : { tenantId, shouldShowSelector: false };
    },
    setEmailId: function (emailId: string) {
      /**
       * Set the emailId in the sessionStorage for later use.
       */
      return sessionStorage.setItem(ST_EMAIL_VALUE_STORAGE_KEY, emailId);
    },
    getEmailId: function () {
      /**
       * Get the emailId from session storage if available.
       */
      return sessionStorage.getItem(ST_EMAIL_VALUE_STORAGE_KEY) ?? undefined;
    },
    removeEmailId: function() {
      /**
       * Remove the emailID from session storage.
       */
      sessionStorage.removeItem(ST_EMAIL_VALUE_STORAGE_KEY);
    }
  };
  return implementation;
};

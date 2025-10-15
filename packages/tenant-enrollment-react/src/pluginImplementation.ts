import { NOT_ALLOWED_TO_SIGNUP_REASONS } from "../../../shared/tenants/src/errors";

import { logDebugMessage } from "./logger";
import { OverrideableTenantFunctionImplementation, SuperTokensPluginTenantEnrollmentPluginConfig } from "./types";

export const getOverrideableTenantFunctionImplementation = (
  config: SuperTokensPluginTenantEnrollmentPluginConfig,
): OverrideableTenantFunctionImplementation => {
  const implementation: OverrideableTenantFunctionImplementation = {
    withSignUpBlockedRedirect: async (callback) => {
      try {
        return await callback();
      } catch (error: any) {
        // Check if the error is a STGeneralError
        logDebugMessage(`Caught error: ${error}`);
        if (error.isSuperTokensGeneralError === true) {
          logDebugMessage(`Got general error with reason: ${error.message}`);

          // Check if the message is one of the not allowed defined errors.
          if (Object.values(NOT_ALLOWED_TO_SIGNUP_REASONS).includes(error.message)) {
            logDebugMessage("Found not-allowed to signup flow, redirecting");

            // Update the message before re-throwing the error
            error.message = "Not allowed to signup to tenant";

            // Redirect the user to not allowed to signup view
            window.location.assign("/signup-blocked");
          }
        }

        throw error;
      }
    },
  };

  return implementation;
};

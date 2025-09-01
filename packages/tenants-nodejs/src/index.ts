import { init } from "./plugin";
import { PluginSMTPService } from "./emailServices";

export { init };
export { PLUGIN_ID } from "./constants";

export type {
  SuperTokensPluginTenantPluginConfig,
  AssociateAllLoginMethodsOfUserWithTenant,
  PluginEmailDeliveryInput,
  SendPluginEmail,
  GetUserIdsInTenantWithRole,
  GetAppUrl,
} from "./types";

// Export email services for user configuration
export { PluginSMTPService } from "./emailServices";

export default {
  init,
  SMTPService: PluginSMTPService,
};

export { assignAdminToUserInTenant, assignRoleToUserInTenant } from "./roles";

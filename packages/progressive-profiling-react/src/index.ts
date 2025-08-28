import { PLUGIN_ID, PLUGIN_VERSION } from "./constants";
import { init, usePluginContext } from "./plugin";
import { UserProfileWrapper } from "./user-profile-wrapper";

export { init, usePluginContext, PLUGIN_ID, PLUGIN_VERSION, UserProfileWrapper };
export default {
  init,
  usePluginContext,
  PLUGIN_ID,
  PLUGIN_VERSION,
  UserProfileWrapper,
};

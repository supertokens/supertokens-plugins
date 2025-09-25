import { PLUGIN_ID, PLUGIN_VERSION } from "./constants";
import { init, usePluginContext } from "./plugin";
import { ProgressiveProfilingWrapper } from "./progressive-profiling-wrapper";

export { init, usePluginContext, PLUGIN_ID, PLUGIN_VERSION, ProgressiveProfilingWrapper as UserProfileWrapper };

export default {
  init,
  usePluginContext,
  PLUGIN_ID,
  PLUGIN_VERSION,
  UserProfileWrapper: ProgressiveProfilingWrapper,
};

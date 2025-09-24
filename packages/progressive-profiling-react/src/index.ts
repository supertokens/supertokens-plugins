import { PLUGIN_ID, PLUGIN_VERSION } from "./constants";
import { init, usePluginContext } from "./plugin";
import { ProgressiveProfilingWrapper } from "./progressive-profiling-wrapper";

export default {
  init,
  usePluginContext,
  PLUGIN_ID,
  PLUGIN_VERSION,
  UserProfileWrapper: ProgressiveProfilingWrapper,
};

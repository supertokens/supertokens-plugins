import { init } from "./plugin";
import { PLUGIN_ID, PLUGIN_VERSION } from "./constants";
import { Implementation } from "./implementation";
import { SessionContainerInterface } from "supertokens-node/recipe/session/types";
import { ProfileFormData } from "@supertokens-plugins/progressive-profiling-shared";

export type { RegisterSections as RegisterSection } from "./types";

const getProfile = (session: SessionContainerInterface, userContext?: Record<string, any>) => {
  return Implementation.getInstanceOrThrow().getSectionValues(session, userContext);
};

const setProfile = (
  session: SessionContainerInterface,
  profile: ProfileFormData,
  userContext?: Record<string, any>,
) => {
  return Implementation.getInstanceOrThrow().setSectionValues(session, profile, userContext);
};

export { init, PLUGIN_ID, PLUGIN_VERSION, getProfile, setProfile };
export default { init, PLUGIN_ID, PLUGIN_VERSION, getProfile, setProfile };

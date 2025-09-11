import { init } from "./plugin";
import { PLUGIN_ID, PLUGIN_VERSION } from "./constants";
import { Implementation } from "./implementation";
import { SessionContainerInterface } from "supertokens-node/recipe/session/types";
import { ProfileFormData } from "@supertokens-plugins/progressive-profiling-shared";
import { RegisterSections } from "./types";

export type { RegisterSections as RegisterSection } from "./types";

const getSectionValues = (session: SessionContainerInterface, userContext?: Record<string, any>) => {
  return Implementation.getInstanceOrThrow().getSectionValues(session, userContext);
};

const setSectionValues = (
  session: SessionContainerInterface,
  profile: ProfileFormData,
  userContext?: Record<string, any>,
) => {
  return Implementation.getInstanceOrThrow().setSectionValues(session, profile, userContext);
};

const registerSections = (payload: Parameters<RegisterSections>[0]) => {
  return Implementation.getInstanceOrThrow().registerSections(payload);
};

const getSections = () => {
  return Implementation.getInstanceOrThrow().getSections();
};

export { init, PLUGIN_ID, PLUGIN_VERSION, getSectionValues, setSectionValues, registerSections, getSections };
export default {
  init,
  PLUGIN_ID,
  PLUGIN_VERSION,
  getSectionValues,
  setSectionValues,
  registerSections,
  getSections,
};

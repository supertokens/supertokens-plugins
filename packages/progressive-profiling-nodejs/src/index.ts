import { init } from "./plugin";
import { PLUGIN_ID, PLUGIN_VERSION } from "./constants";
import { Implementation } from "./implementation";
import { SessionContainerInterface } from "supertokens-node/recipe/session/types";
import { ProfileFormData } from "@supertokens-plugins/progressive-profiling-shared";
import { RegisterSections } from "./types";
import { FilterGlobalClaimValidators } from "@shared/tenants";

export type { RegisterSections as RegisterSection } from "./types";

const getSectionValues = (input: { session: SessionContainerInterface; userContext?: Record<string, any> }) => {
  return Implementation.getInstanceOrThrow().getSectionValues(input);
};

const setSectionValues = (input: {
  session: SessionContainerInterface;
  data: ProfileFormData;
  userContext?: Record<string, any>;
}) => {
  return Implementation.getInstanceOrThrow().setSectionValues(input);
};

const registerSections = (payload: Parameters<RegisterSections>[0]) => {
  return Implementation.getInstanceOrThrow().registerSections(payload);
};

const getAllSections = (input: { session: SessionContainerInterface; userContext?: Record<string, any> }) => {
  return Implementation.getInstanceOrThrow().getAllSections(input);
};

const registerGlobalClaimValidatorOverride = (fn: FilterGlobalClaimValidators) => {
  return Implementation.getInstanceOrThrow().registerGlobalClaimValidatorOverride(fn);
};

export { init, PLUGIN_ID, PLUGIN_VERSION, getSectionValues, setSectionValues, registerSections, getAllSections };
export default {
  init,
  PLUGIN_ID,
  PLUGIN_VERSION,
  getSectionValues,
  setSectionValues,
  registerSections,
  getAllSections,
  registerGlobalClaimValidatorOverride,
};

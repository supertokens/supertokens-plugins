import { init } from "./plugin";
import { PLUGIN_ID, PLUGIN_VERSION } from "./constants";
import { SessionContainerInterface } from "supertokens-node/recipe/session/types";
import { Implementation } from "./implementation";
import { BaseFormFieldPayload, BaseFormSection } from "@supertokens-plugins/profile-details-shared";
export { init, PLUGIN_ID, PLUGIN_VERSION };

export type { BaseFormSection };

export const getProfile = (userId: string, session: SessionContainerInterface, userContext?: Record<string, any>) => {
  return Implementation.getInstanceOrThrow().getProfile(userId, session, userContext);
};

export const updateProfile = (
  userId: string,
  profile: BaseFormFieldPayload[],
  session: SessionContainerInterface,
  userContext?: Record<string, any>,
) => {
  return Implementation.getInstanceOrThrow().updateProfile(userId, profile, session, userContext);
};

export const getSections = (session: SessionContainerInterface, userContext?: Record<string, any>) => {
  return Implementation.getInstanceOrThrow().getSections(session, userContext);
};

export default { init, PLUGIN_ID, PLUGIN_VERSION, getProfile, updateProfile, getSections };

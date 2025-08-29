import { SessionContainerInterface } from "supertokens-node/recipe/session/types";
import { ProfileFormData, FormSection as SharedFormSection } from "@supertokens-plugins/progressive-profiling-shared";

export type SuperTokensPluginProfileProgressiveProfilingConfig = undefined;
export type SuperTokensPluginProfileProgressiveProfilingNormalisedConfig =
  Required<SuperTokensPluginProfileProgressiveProfilingConfig>;

export type UserMetadataConfig = {
  sectionCompleted: Record<string, boolean>;
};

export type FormSection = Omit<SharedFormSection, "completed">;

export type RegisterSections = (payload: {
  registratorId: string;
  sections: FormSection[];
  set: (data: ProfileFormData, session: SessionContainerInterface | undefined) => Promise<void>;
  get: (session: SessionContainerInterface | undefined) => Promise<ProfileFormData>;
}) => void;

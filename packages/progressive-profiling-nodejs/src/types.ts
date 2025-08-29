import { SessionContainerInterface } from "supertokens-node/recipe/session/types";
import { ProfileFormData } from "@supertokens-plugins/progressive-profiling-shared";

export type FormFieldValue = string | number | boolean | null | undefined | string[];

export type FormField = {
  id: string;
  label: string;
  type:
    | "string"
    | "text"
    | "number"
    | "boolean"
    | "email"
    | "phone"
    | "date"
    | "select"
    | "multiselect"
    | "password"
    | "url"
    | "image-url"
    | "toggle";
  required: boolean;
  defaultValue?: FormFieldValue;
  placeholder?: string;
  description?: string;
  validation?: (value: FormFieldValue) => Promise<string | undefined>;
  options?: { value: FormFieldValue; label: string }[];
};

export type FormSection = {
  id: string;
  label: string;
  description?: string;
  fields: FormField[];
};
export type SuperTokensPluginProfileProgressiveProfilingConfig = undefined;
export type SuperTokensPluginProfileProgressiveProfilingNormalisedConfig = undefined;

export type UserMetadataConfig = {
  sectionCompleted: Record<string, boolean>;
};

export type RegisterSection = (section: {
  registratorId: string;
  sections: FormSection[];
  set: (data: ProfileFormData, session: SessionContainerInterface | undefined) => Promise<void>;
  get: (session: SessionContainerInterface | undefined) => Promise<ProfileFormData>;
}) => void;

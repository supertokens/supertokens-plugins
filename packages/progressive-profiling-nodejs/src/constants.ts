import { FormSection } from "./types";

export const PLUGIN_ID = "supertokens-plugin-progressive-profiling";
export const PLUGIN_VERSION = "0.0.1";
export const PLUGIN_SDK_VERSION = ["23.0.1", ">=23.0.1"];

export const METADATA_KEY = `${PLUGIN_ID}`;
export const METADATA_PROFILE_KEY = "st-default-profile"; // don't use plugin id, because we need to be able to have the same key in the profile plugin as well

export const HANDLE_BASE_PATH = `/plugin/${PLUGIN_ID}`;

export const DEFAULT_SECTIONS: FormSection[] = [];

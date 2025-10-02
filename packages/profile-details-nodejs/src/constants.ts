export const PLUGIN_ID = "supertokens-plugin-profile-details";
export const PLUGIN_VERSION = "0.0.1";
export const PLUGIN_SDK_VERSION = ["23.0.1", ">=23.0.1"];

export const HANDLE_BASE_PATH = `/plugin/${PLUGIN_ID}`;

export const METADATA_KEY = `${PLUGIN_ID}`;
export const METADATA_PROFILE_KEY = "st-profile"; // don't use plugin id, because we need to be able to have the same key in the profile plugin as well

export const SUPERTOKENS_PLUGIN_PROGRESSIVE_PROFILING_ID = "supertokens-plugin-progressive-profiling";

export const DEFAULT_REGISTER_SECTIONS_FOR_PROGRESSIVE_PROFILING = true;

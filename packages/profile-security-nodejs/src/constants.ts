export const PLUGIN_ID = "supertokens-plugin-profile-security";
export const PLUGIN_VERSION = "0.0.1";
export const PLUGIN_SDK_VERSION = ["23.0.1", ">=23.0.1"];

export const HANDLE_BASE_PATH = `/plugin/${PLUGIN_ID}`;

export const METADATA_KEY = `${PLUGIN_ID}`;

export const DEFAULT_ENABLE_SETTING_PASSWORD = true;
export const DEFAULT_ENABLE_THIRD_PARTY_LINKING = true;
export const DEFAULT_ENABLE_MFA_CONFIGURATION = true;

// todo is this correct?
export const DEFAULT_SMS_CODE_LIFETIME_FOR_OTP_PHONE_CHANGE = 1000 * 60 * 5; // 5 minutes

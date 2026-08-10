import { RowndSchema } from "./types";

export const PLUGIN_ID = "supertokens-plugin-rownd";
export const PLUGIN_VERSION = "0.3.0";

export const PLUGIN_SDK_VERSION = ["23.0.0", "23.0.1", ">=23.0.1"];
export const HANDLE_BASE_PATH = "/plugin/rownd";
export const PUBLIC_TENANT_ID = "public";

// When a user explicitly chooses to log in as a guest
export const GUEST_AUTH_METHOD_ID = "guest";
// When a user is automatically logged in when they open the app
export const INSTANT_AUTH_METHOD_ID = "instant";

export const ROWND_JWT_CLAIMS = {
  AppUserId: "https://auth.rownd.io/app_user_id",
  IsVerifiedUser: "https://auth.rownd.io/is_verified_user",
  IsAnonymous: "https://auth.rownd.io/is_anonymous",
  IssuedOffline: "https://auth.rownd.io/issued_offline",
  JwtType: "https://auth.rownd.io/jwt_type",
  PlatformJwt: "https://auth.rownd.io/platform_jwt",
  AuthLevel: "https://auth.rownd.io/auth_level",
} as const;

export const DEFAULT_ROWND_SCHEMA: RowndSchema = {
  zip_code: {
    display_name: "Zip code",
    type: "string",
    user_visible: true,
  },
  last_name: {
    display_name: "Last name",
    type: "string",
    user_visible: true,
  },
  nick_name: {
    display_name: "Nick name",
    type: "string",
    user_visible: true,
  },
  first_name: {
    display_name: "First name",
    type: "string",
    user_visible: true,
  },
};

export const HUB_LOGIN_PAGE_PATH = "/account/login";
export const HUB_VERIFY_EMAIL_PAGE_PATH = "/account/verify-email";
export const PASSWORDLESS_BYPASS_DEVICE_CONFIRMATION_PARAM =
  "bypassDeviceConfirmation";
export const PENDING_EMAIL_VERIFICATION_QUERY_PARAM =
  "rowndPendingVerificationId";
export const NATIVE_EMAIL_VERIFICATION_UPGRADE_REQUIRED_MESSAGE =
  "native email verification requires a Rownd SDK upgrade";

PLUGIN_ID = "supertokens-plugin-rownd"
PLUGIN_VERSION = "0.1.1"
PLUGIN_SDK_VERSION = ">=0.31.3"
HANDLE_BASE_PATH = "/plugin/rownd"
PUBLIC_TENANT_ID = "public"

GUEST_AUTH_METHOD_ID = "guest"
INSTANT_AUTH_METHOD_ID = "instant"

ROWND_JWT_CLAIMS = {
    "app_user_id": "https://auth.rownd.io/app_user_id",
    "is_verified_user": "https://auth.rownd.io/is_verified_user",
    "is_anonymous": "https://auth.rownd.io/is_anonymous",
    "auth_level": "https://auth.rownd.io/auth_level",
}

DEFAULT_ROWND_SCHEMA = {
    "zip_code": {"display_name": "Zip code", "type": "string", "user_visible": True},
    "last_name": {"display_name": "Last name", "type": "string", "user_visible": True},
    "nick_name": {"display_name": "Nick name", "type": "string", "user_visible": True},
    "first_name": {"display_name": "First name", "type": "string", "user_visible": True},
}

IDENTITY_USER_DATA_FIELDS = {"user_id", "email", "phone_number", "google_id", "apple_id"}
INTERNAL_METADATA_FIELDS = {"original_rownd_user", "rownd_pending_verification"}
BUILTIN_SIGN_IN_METHOD_KEYS = {"email", "phone", "google", "apple", "anonymous"}
PASSWORDLESS_BYPASS_DEVICE_CONFIRMATION_PARAM = "bypassDeviceConfirmation"

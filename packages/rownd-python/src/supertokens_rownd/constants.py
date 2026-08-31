from types import MappingProxyType
from typing import Mapping


PLUGIN_ID = "supertokens-plugin-rownd"
PLUGIN_VERSION = "0.1.13"
PLUGIN_SDK_VERSION = ">=0.31.3"
HANDLE_BASE_PATH = "/plugin/rownd"
PUBLIC_TENANT_ID = "public"

GUEST_AUTH_METHOD_ID = "guest"
INSTANT_AUTH_METHOD_ID = "instant"

ROWND_JWT_CLAIMS: Mapping[str, str] = MappingProxyType(
    {
        "app_user_id": "https://auth.rownd.io/app_user_id",
        "is_verified_user": "https://auth.rownd.io/is_verified_user",
        "is_anonymous": "https://auth.rownd.io/is_anonymous",
        "issued_offline": "https://auth.rownd.io/issued_offline",
        "jwt_type": "https://auth.rownd.io/jwt_type",
        "platform_jwt": "https://auth.rownd.io/platform_jwt",
        "auth_level": "https://auth.rownd.io/auth_level",
    }
)

JWT_REGISTERED_CLAIMS = frozenset({"iss", "sub", "aud", "exp", "nbf", "iat", "jti"})

RESERVED_SESSION_CLAIMS = frozenset(
    {
        *JWT_REGISTERED_CLAIMS,
        "app_user_id",
        "auth_level",
        "is_verified_user",
        "is_anonymous",
        "anonymous_id",
        "sessionHandle",
        "refreshTokenHash1",
        "parentRefreshTokenHash1",
        "antiCsrfToken",
        "expiryTime",
        "timeCreated",
        "recipeUserId",
        "tenantId",
        "tId",
        "rsub",
        "st-mfa",
        "st-role",
        "st-perm",
        "st-ev",
        *ROWND_JWT_CLAIMS.values(),
    }
)

RESERVED_OAUTH_CLAIMS = frozenset(
    {
        *RESERVED_SESSION_CLAIMS,
        "email",
        "email_verified",
        "emails",
        "phone_number",
        "phone_number_verified",
        "phoneNumber",
        "phoneNumber_verified",
        "phoneNumbers",
        "name",
        "given_name",
        "family_name",
        "updated_at",
        "auth_time",
        "nonce",
        "azp",
        "acr",
        "amr",
        "sid",
        "at_hash",
        "c_hash",
        "client_id",
        "scope",
        "scp",
        "stt",
    }
)

DEFAULT_ROWND_SCHEMA = {
    "zip_code": {"display_name": "Zip code", "type": "string", "user_visible": True},
    "last_name": {"display_name": "Last name", "type": "string", "user_visible": True},
    "nick_name": {"display_name": "Nick name", "type": "string", "user_visible": True},
    "first_name": {"display_name": "First name", "type": "string", "user_visible": True},
}

IDENTITY_USER_DATA_FIELDS = {"user_id", "email", "phone_number", "google_id", "apple_id"}
INTERNAL_METADATA_FIELDS = {
    "original_rownd_user",
    "rownd_email_recipe_user_id",
    "rownd_email_recipe_user_ids",
    "rownd_migration_complete",
    "rownd_pending_verification",
}
BUILTIN_SIGN_IN_METHOD_KEYS = {"email", "phone", "google", "apple", "anonymous"}
PASSWORDLESS_BYPASS_DEVICE_CONFIRMATION_PARAM = "bypassDeviceConfirmation"
ROWND_OAUTH_LOGIN_CHALLENGE_PARAM = "rownd_oauth_login_challenge"
PENDING_EMAIL_VERIFICATION_QUERY_PARAM = "rowndPendingVerificationId"
NATIVE_EMAIL_VERIFICATION_UPGRADE_REQUIRED_MESSAGE = (
    "native email verification requires a Rownd SDK upgrade"
)

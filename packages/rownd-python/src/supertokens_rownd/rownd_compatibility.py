from __future__ import annotations

import time
from hashlib import sha256
from types import SimpleNamespace
from typing import AbstractSet, Any, Dict, List, Optional, Tuple, cast

from supertokens_python.recipe.accountlinking.types import AccountInfoWithRecipeId
from supertokens_python.types import LoginMethod, User

from .config import as_json_dict
from .constants import (
    DEFAULT_ROWND_SCHEMA,
    GUEST_AUTH_METHOD_ID,
    IDENTITY_USER_DATA_FIELDS,
    INSTANT_AUTH_METHOD_ID,
    INTERNAL_METADATA_FIELDS,
    RESERVED_SESSION_CLAIMS,
    ROWND_JWT_CLAIMS,
)
from .errors import RowndPluginError
from .types import JsonDict, RowndPluginConfig


SUPERTOKENS_FAKE_EMAIL_DOMAIN = "stfakeemail.supertokens.com"


def public_metadata(metadata: JsonDict) -> JsonDict:
    return {key: value for key, value in metadata.items() if not is_internal_metadata_field(key)}


def is_identity_field(field_name: str) -> bool:
    return field_name in IDENTITY_USER_DATA_FIELDS


def is_internal_metadata_field(field_name: str) -> bool:
    return field_name in INTERNAL_METADATA_FIELDS


def can_update_user_data_field(config: RowndPluginConfig, field_name: str) -> bool:
    schema_field = config.schema.get(field_name)
    if schema_field is None:
        return False
    owned_by = (
        "app" if field_name in {"google_id", "apple_id"} else schema_field.get("owned_by", "user")
    )
    return owned_by != "app" and schema_field.get("read_only") is not True


def validate_writable_fields(config: RowndPluginConfig, fields: List[str]) -> Optional[JsonDict]:
    for field_name in fields:
        if not can_update_user_data_field(config, field_name):
            return {
                "status": "ERROR",
                "code": 403,
                "message": "field is not writable: %s" % field_name,
            }
    return None


def missing_field_response() -> JsonDict:
    return {"status": "ERROR", "code": 400, "message": "field is required"}


def get_third_party_info(method: LoginMethod) -> Tuple[Optional[str], Optional[str]]:
    third_party = getattr(method, "third_party", None)
    return getattr(third_party, "id", None), getattr(third_party, "user_id", None)


def is_guest_login_method(method: LoginMethod) -> bool:
    third_party_id, _ = get_third_party_info(method)
    return method.recipe_id == "thirdparty" and third_party_id in {
        GUEST_AUTH_METHOD_ID,
        INSTANT_AUTH_METHOD_ID,
    }


def is_real_third_party_method(method: LoginMethod) -> bool:
    third_party_id, _ = get_third_party_info(method)
    return method.recipe_id == "thirdparty" and third_party_id not in {
        GUEST_AUTH_METHOD_ID,
        INSTANT_AUTH_METHOD_ID,
    }


def has_only_guest_login_methods(user: Optional[User]) -> bool:
    if not user or not user.login_methods:
        return False
    return all(is_guest_login_method(method) for method in user.login_methods)


def has_verified_real_login_method(user: Optional[User]) -> bool:
    if not user:
        return False
    for method in user.login_methods:
        if is_guest_login_method(method):
            continue
        if method.recipe_id == "passwordless" and (method.email or method.phone_number):
            return True
        if method.recipe_id == "thirdparty" and method.verified:
            _, third_party_user_id = get_third_party_info(method)
            return bool(third_party_user_id)
        if method.recipe_id == "emailpassword" and method.email and method.verified:
            return True
    return False


def get_guest_auth_level(user: Optional[User]) -> Optional[str]:
    if user:
        for method in user.login_methods:
            third_party_id, _ = get_third_party_info(method)
            if method.recipe_id == "thirdparty" and third_party_id == GUEST_AUTH_METHOD_ID:
                return GUEST_AUTH_METHOD_ID
        for method in user.login_methods:
            third_party_id, _ = get_third_party_info(method)
            if method.recipe_id == "thirdparty" and third_party_id == INSTANT_AUTH_METHOD_ID:
                return INSTANT_AUTH_METHOD_ID
    return None


def get_effective_auth_level(
    user: Optional[User],
    original_auth_level: Optional[str] = None,
    verified_data: Optional[JsonDict] = None,
) -> str:
    if has_verified_real_login_method(user):
        return "verified"
    if original_auth_level == INSTANT_AUTH_METHOD_ID:
        return INSTANT_AUTH_METHOD_ID
    return (
        get_guest_auth_level(user)
        or original_auth_level
        or ("verified" if verified_data else "unverified")
    )


def get_anonymous_id(
    user_id: str,
    user: Optional[User],
    metadata: JsonDict,
    current_payload: Optional[JsonDict] = None,
) -> Optional[str]:
    original = as_json_dict(metadata.get("original_rownd_user"))
    original_data = as_json_dict(original.get("data"))
    if isinstance(original_data.get("anonymous_id"), str):
        return cast(str, original_data["anonymous_id"])
    guest_method = user and any(
        method.recipe_id == "thirdparty"
        and get_third_party_info(method)[0] == GUEST_AUTH_METHOD_ID
        for method in user.login_methods
    )
    if not guest_method:
        return None
    if current_payload and isinstance(current_payload.get("anonymous_id"), str):
        return cast(str, current_payload["anonymous_id"])
    return "anon_%s" % (getattr(user, "id", None) or user_id)


def map_login_method(method: Optional[LoginMethod]) -> str:
    if method is None:
        return "email"
    if method.recipe_id == "thirdparty":
        third_party_id, _ = get_third_party_info(method)
        if third_party_id in {"google", "apple"}:
            return third_party_id
    if method.recipe_id == "passwordless":
        return "email" if method.email else "phone"
    return "email"


def iso_from_ms(value: int) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(value / 1000))


def get_canonical_email_recipe_user_id(metadata: JsonDict, tenant_id: str) -> Optional[str]:
    if "rownd_email_recipe_user_ids" in metadata:
        canonical_by_tenant = metadata.get("rownd_email_recipe_user_ids")
        if not isinstance(canonical_by_tenant, dict):
            return None
        canonical = canonical_by_tenant.get(tenant_id)
        return canonical if isinstance(canonical, str) else None
    canonical = metadata.get("rownd_email_recipe_user_id")
    return canonical if isinstance(canonical, str) else None


def project_rownd_compat_user(
    user_id: str,
    st_user: User,
    metadata: JsonDict,
    config: Optional[RowndPluginConfig],
    tenant_id: str,
    latest_session_info: Optional[Any],
) -> JsonDict:
    original = as_json_dict(metadata.get("original_rownd_user"))
    original_data = as_json_dict(original.get("data"))
    verified_data = {
        key: value
        for key, value in as_json_dict(original.get("verified_data")).items()
        if key != "email"
    }
    data: JsonDict = {"user_id": user_id}
    data_field_keys = set()

    for key, value in original_data.items():
        if not is_identity_field(key):
            data[key] = value
            data_field_keys.add(key)

    schema = config.schema if config is not None else DEFAULT_ROWND_SCHEMA
    for key in schema.keys():
        data_field_keys.add(key)
        if not is_identity_field(key) and not is_internal_metadata_field(key) and key in metadata:
            data[key] = metadata[key]

    tenant_login_methods = sorted(
        [
            method
            for method in st_user.login_methods
            if tenant_id in (getattr(method, "tenant_ids", None) or [])
        ],
        key=lambda method: (method.time_joined, method.recipe_user_id.get_as_string()),
    )
    canonical_recipe_user_id = get_canonical_email_recipe_user_id(metadata, tenant_id)
    canonical_email_method = next(
        (
            method
            for method in tenant_login_methods
            if method.recipe_user_id.get_as_string() == canonical_recipe_user_id
            and method.email
            and not is_supertokens_fake_email(method.email)
        ),
        None,
    )
    if canonical_email_method is not None:
        data["email"] = canonical_email_method.email
        if canonical_email_method.verified:
            verified_data["email"] = canonical_email_method.email
    for method in tenant_login_methods:
        if method.recipe_id == "passwordless":
            if method.email and not is_supertokens_fake_email(method.email):
                if "email" not in verified_data and getattr(method, "verified", False):
                    verified_data["email"] = method.email
                data.setdefault("email", method.email)
            if method.phone_number:
                verified_data["phone_number"] = method.phone_number
                data.setdefault("phone_number", method.phone_number)
        elif method.recipe_id == "thirdparty":
            third_party_id, third_party_user_id = get_third_party_info(method)
            if (
                method.verified
                and method.email
                and not is_supertokens_fake_email(method.email)
                and "email" not in verified_data
            ):
                verified_data["email"] = method.email
            if method.email and not is_supertokens_fake_email(method.email):
                data.setdefault("email", method.email)
            if third_party_id == "google" and third_party_user_id:
                data["google_id"] = third_party_user_id
                verified_data["google_id"] = third_party_user_id
            if third_party_id == "apple" and third_party_user_id:
                data["apple_id"] = third_party_user_id
                verified_data["apple_id"] = third_party_user_id

    if verified_data.get("email") is True and isinstance(data.get("email"), str):
        verified_data["email"] = data["email"]
    if verified_data.get("phone_number") is True and isinstance(data.get("phone_number"), str):
        verified_data["phone_number"] = data["phone_number"]

    tenant_user = cast(User, SimpleNamespace(login_methods=tenant_login_methods))
    anonymous_id = get_anonymous_id(st_user.id, tenant_user, metadata)
    if anonymous_id:
        data.setdefault("anonymous_id", anonymous_id)

    for key, schema_field in schema.items():
        if data.get(key) is None and schema_field.get("type") == "string":
            data[key] = ""

    sorted_by_joined = sorted(tenant_login_methods, key=lambda method: method.time_joined)
    first_method = sorted_by_joined[0] if sorted_by_joined else None
    latest_recipe_user_id = None
    if latest_session_info is not None:
        recipe_user_id = getattr(latest_session_info, "recipe_user_id", None)
        if recipe_user_id is not None:
            latest_recipe_user_id = recipe_user_id.get_as_string()
    last_method = (
        next(
            (
                method
                for method in tenant_login_methods
                if method.recipe_user_id.get_as_string() == latest_recipe_user_id
            ),
            None,
        )
        if latest_recipe_user_id
        else None
    )
    if last_method is None:
        last_method = (
            max(tenant_login_methods, key=lambda method: method.time_joined)
            if tenant_login_methods
            else None
        )
    last_sign_in_at = getattr(latest_session_info, "time_created", st_user.time_joined)
    metadata_meta = {
        key: value
        for key, value in metadata.items()
        if not is_internal_metadata_field(key) and key not in data_field_keys
    }

    original_auth_level = original.get("auth_level")
    return {
        "rownd_user": original_data.get("user_id", user_id),
        "data": data,
        "meta": {
            **metadata_meta,
            "created": iso_from_ms(st_user.time_joined),
            "first_sign_in": iso_from_ms(st_user.time_joined),
            "last_sign_in": iso_from_ms(last_sign_in_at),
            "last_active": iso_from_ms(last_sign_in_at),
            "first_sign_in_method": map_login_method(first_method),
            "last_sign_in_method": map_login_method(last_method),
        },
        "verified_data": verified_data,
        "state": original.get("state", "enabled"),
        "auth_level": get_effective_auth_level(
            tenant_user,
            original_auth_level if isinstance(original_auth_level, str) else None,
            verified_data,
        ),
        "redacted": [],
        "groups": original.get("groups", []),
        "attributes": original.get("attributes", {}),
    }


def build_rownd_session_claim_payload(
    config: RowndPluginConfig,
    user_id: str,
    user: Optional[User],
    metadata: JsonDict,
    current_payload: JsonDict,
    app_variant_id: Optional[str],
    reserved_claims: AbstractSet[str] = RESERVED_SESSION_CLAIMS,
) -> JsonDict:
    original = as_json_dict(metadata.get("original_rownd_user"))
    verified_data = as_json_dict(original.get("verified_data"))
    original_auth_level_value = original.get("auth_level")
    original_auth_level = (
        original_auth_level_value if isinstance(original_auth_level_value, str) else None
    )
    auth_level = get_effective_auth_level(user, original_auth_level, verified_data)
    app_user_id = as_json_dict(original.get("data")).get("user_id")
    app_user_id = (
        app_user_id or current_payload.get("app_user_id") or (user.id if user else user_id)
    )
    is_anonymous = auth_level in {GUEST_AUTH_METHOD_ID, INSTANT_AUTH_METHOD_ID}
    anonymous_id = get_anonymous_id(user_id, user, metadata, current_payload) if user else None
    claims = {
        **build_rownd_audience(current_payload, config, app_variant_id),
        **build_configured_session_claims(config, metadata, reserved_claims),
        "app_user_id": app_user_id,
        "auth_level": auth_level,
        "is_verified_user": auth_level != "unverified",
        ROWND_JWT_CLAIMS["app_user_id"]: app_user_id,
        ROWND_JWT_CLAIMS["auth_level"]: auth_level,
        ROWND_JWT_CLAIMS["is_verified_user"]: auth_level != "unverified",
    }
    if is_anonymous:
        claims[ROWND_JWT_CLAIMS["is_anonymous"]] = True
    if anonymous_id:
        claims["anonymous_id"] = anonymous_id
    return claims


def resolve_session_claim_name(key: str, field_config: JsonDict) -> str:
    configured_name = field_config.get("session_claim_name")
    if configured_name is None or configured_name == "":
        return key
    if not isinstance(configured_name, str):
        raise ValueError("schema.%s.session_claim_name must be a string" % key)
    return configured_name


def build_configured_session_claims(
    config: RowndPluginConfig,
    metadata: JsonDict,
    reserved_claims: AbstractSet[str] = RESERVED_SESSION_CLAIMS,
) -> JsonDict:
    original = as_json_dict(metadata.get("original_rownd_user"))
    original_data = as_json_dict(original.get("data"))
    claims = {}
    for key, field_config in config.schema.items():
        if field_config.get("include_in_session_claims") is not True:
            continue
        claim_name = resolve_session_claim_name(key, field_config)
        if claim_name in reserved_claims:
            continue
        value = original_data.get(key, metadata.get(key))
        if value is not None:
            claims[claim_name] = value
    return claims


def build_rownd_audience(
    current_payload: JsonDict, config: RowndPluginConfig, app_variant_id: Optional[str]
) -> JsonDict:
    _ = current_payload, config, app_variant_id
    # PyJWT rejects tokens containing `aud` unless an audience is passed during decode.
    # SuperTokens Python validates access tokens internally without an audience, so adding
    # Rownd's standard JWT audience claim makes later session verification fail with 401.
    return {}


def normalize_rownd_oauth_scopes(scopes: List[str]) -> List[str]:
    normalized = []
    for scope in scopes:
        if scope and scope not in normalized:
            normalized.append(scope)
    return normalized


def first_string(value: object) -> Optional[str]:
    if isinstance(value, list):
        return next((item for item in value if isinstance(item, str) and item), None)
    return value if isinstance(value, str) and value else None


def is_supertokens_fake_email(value: object) -> bool:
    return isinstance(value, str) and value.lower().endswith("@%s" % SUPERTOKENS_FAKE_EMAIL_DOMAIN)


def build_supertokens_fake_email(provider_user_id: str, provider_id: str) -> str:
    digest = sha256(("%s:%s" % (provider_id, provider_user_id)).encode("utf-8")).hexdigest()[:32]
    return "st-%s-%s@%s" % (provider_id, digest, SUPERTOKENS_FAKE_EMAIL_DOMAIN)


def first_real_email(*values: object) -> Optional[str]:
    return next(
        (
            value
            for value in values
            if isinstance(value, str) and value and not is_supertokens_fake_email(value)
        ),
        None,
    )


def get_rownd_oauth_audience(
    requested_audience: Optional[str] = None,
    requested_resource: Optional[str] = None,
) -> Optional[str]:
    requested = requested_resource or requested_audience
    return requested if requested and requested.startswith("app:") else None


def apply_rownd_oauth_resource_params(params: Dict[str, object]) -> Optional[str]:
    rownd_audience = get_rownd_oauth_audience(
        requested_audience=first_string(params.get("audience")),
        requested_resource=first_string(params.get("resource")),
    )
    if not rownd_audience:
        return None
    params["audience"] = first_string(params.get("audience")) or rownd_audience
    params.pop("resource", None)
    return rownd_audience


def build_standard_oauth_claims(user: User, scopes: List[str], metadata: JsonDict) -> JsonDict:
    claims: JsonDict = {}
    original = as_json_dict(metadata.get("original_rownd_user"))
    rownd_data = as_json_dict(original.get("data"))
    verified_data = as_json_dict(original.get("verified_data"))

    if "email" in scopes:
        email = first_real_email(first_string(rownd_data.get("email")), *(user.emails or []))
        if email:
            claims["email"] = email
            claims["email_verified"] = is_oauth_claim_verified(
                verified_data.get("email"),
                email,
                any(method.email == email and method.verified for method in user.login_methods),
            )

    if "phone" in scopes:
        phone_number = first_string(rownd_data.get("phone_number")) or (
            user.phone_numbers[0] if user.phone_numbers else None
        )
        if phone_number:
            claims["phone_number"] = phone_number
            claims["phone_number_verified"] = is_oauth_claim_verified(
                verified_data.get("phone_number"),
                phone_number,
                any(
                    method.phone_number == phone_number and method.verified
                    for method in user.login_methods
                ),
            )

    if "profile" in scopes:
        given_name = first_string(rownd_data.get("first_name"))
        family_name = first_string(rownd_data.get("last_name"))
        name = " ".join(item for item in [given_name, family_name] if item)
        if name:
            claims["name"] = name
        if given_name:
            claims["given_name"] = given_name
        if family_name:
            claims["family_name"] = family_name
        if isinstance(rownd_data.get("updated_at"), str):
            claims["updated_at"] = rownd_data["updated_at"]
    return claims


def pick_oauth_user_info_rownd_claims(payload: JsonDict) -> JsonDict:
    return {
        key: payload[key]
        for key in [
            "app_user_id",
            "auth_level",
            "is_verified_user",
            "is_anonymous",
            "anonymous_id",
            ROWND_JWT_CLAIMS["app_user_id"],
            ROWND_JWT_CLAIMS["auth_level"],
            ROWND_JWT_CLAIMS["is_verified_user"],
            ROWND_JWT_CLAIMS["is_anonymous"],
        ]
        if key in payload
    }


def is_oauth_claim_verified(value: object, expected_value: str, fallback: bool) -> bool:
    return value is True or value == expected_value or fallback


def is_rownd_email_verified(value: object, email: str) -> bool:
    return value is True or (isinstance(value, str) and value.lower() == email.lower())


def map_rownd_user_to_supertokens(
    rownd_user: JsonDict, tenant_id: Optional[str] = None
) -> JsonDict:
    login_methods = []
    data = as_json_dict(rownd_user.get("data"))
    verified_data = as_json_dict(rownd_user.get("verified_data"))
    if not data.get("user_id"):
        raise RowndPluginError("Rownd user has no user_id")

    google_id = data.get("google_id")
    if isinstance(google_id, str) and google_id:
        login_methods.append(
            {
                "recipeId": "thirdparty",
                "thirdPartyId": "google",
                "thirdPartyUserId": google_id,
                "email": build_supertokens_fake_email(google_id, "google"),
                "isVerified": False,
                **({"tenantIds": [tenant_id]} if tenant_id else {}),
            }
        )
    apple_id = data.get("apple_id")
    if isinstance(apple_id, str) and apple_id:
        login_methods.append(
            {
                "recipeId": "thirdparty",
                "thirdPartyId": "apple",
                "thirdPartyUserId": apple_id,
                "email": build_supertokens_fake_email(apple_id, "apple"),
                "isVerified": False,
                **({"tenantIds": [tenant_id]} if tenant_id else {}),
            }
        )
    if data.get("phone_number"):
        login_methods.append(
            {
                "recipeId": "passwordless",
                "phoneNumber": data["phone_number"],
                "isVerified": bool(verified_data.get("phone_number")),
                **({"tenantIds": [tenant_id]} if tenant_id else {}),
            }
        )
    email = data.get("email")
    if isinstance(email, str) and email:
        login_methods.append(
            {
                "recipeId": "passwordless",
                "email": email,
                "isVerified": is_rownd_email_verified(verified_data.get("email"), email),
                **({"tenantIds": [tenant_id]} if tenant_id else {}),
            }
        )
    if not login_methods:
        auth_level = rownd_user.get("auth_level")
        third_party_id = (
            GUEST_AUTH_METHOD_ID if auth_level == GUEST_AUTH_METHOD_ID else INSTANT_AUTH_METHOD_ID
        )
        login_methods.append(
            {
                "recipeId": "thirdparty",
                "thirdPartyId": third_party_id,
                "thirdPartyUserId": data["user_id"],
                "email": "%s@anonymous.local" % data["user_id"],
                "isVerified": False,
                **({"tenantIds": [tenant_id]} if tenant_id else {}),
            }
        )
    if len(login_methods) > 1:
        login_methods[0]["isPrimary"] = True
    return {
        "externalUserId": data["user_id"],
        "loginMethods": login_methods,
        "userMetadata": build_rownd_user_metadata(rownd_user),
    }


def build_rownd_user_metadata(rownd_user: JsonDict) -> JsonDict:
    metadata = dict(as_json_dict(rownd_user.get("meta")))
    metadata["original_rownd_user"] = rownd_user
    metadata["rownd_migration_complete"] = True
    data = as_json_dict(rownd_user.get("data"))
    for key, value in data.items():
        if not is_identity_field(key) and value is not None:
            metadata[key] = value
    return metadata


def is_guest_account_info(account_info: AccountInfoWithRecipeId) -> bool:
    third_party = getattr(account_info, "third_party", None)
    return getattr(account_info, "recipe_id", None) == "thirdparty" and getattr(
        third_party, "id", None
    ) in {GUEST_AUTH_METHOD_ID, INSTANT_AUTH_METHOD_ID}


def does_account_info_match_auth_method(
    user: User, account_info: AccountInfoWithRecipeId, tenant_id: str
) -> bool:
    normalized_email = account_info.email.lower() if account_info.email else None
    if normalized_email:
        return any(
            not is_guest_login_method(method)
            and tenant_id in method.tenant_ids
            and method.verified
            and method.email
            and method.email.lower() == normalized_email
            for method in user.login_methods
        )
    if getattr(account_info, "phone_number", None):
        return any(
            not is_guest_login_method(method)
            and tenant_id in method.tenant_ids
            and method.verified
            and method.phone_number == account_info.phone_number
            for method in user.login_methods
        )
    return False


def has_verified_matching_email_login_method(
    user: User, account_info: AccountInfoWithRecipeId, tenant_id: str
) -> bool:
    if not account_info.email:
        return False
    incoming_third_party = getattr(account_info, "third_party", None)
    if account_info.recipe_id == "thirdparty" and incoming_third_party is not None:
        for method in user.login_methods:
            existing_third_party = method.third_party
            if (
                method.recipe_id == "thirdparty"
                and tenant_id in method.tenant_ids
                and existing_third_party is not None
                and existing_third_party.id == incoming_third_party.id
                and existing_third_party.user_id != incoming_third_party.user_id
            ):
                return False
    normalized_email = account_info.email.lower()
    for method in user.login_methods:
        if (
            is_guest_login_method(method)
            or tenant_id not in method.tenant_ids
            or not method.verified
            or not method.email
            or method.email.lower() != normalized_email
        ):
            continue
        if method.recipe_id != account_info.recipe_id:
            return True
        if method.recipe_id == "thirdparty":
            existing_third_party = method.third_party
            if (
                existing_third_party is not None
                and incoming_third_party is not None
                and existing_third_party.id != incoming_third_party.id
            ):
                return True
    return False

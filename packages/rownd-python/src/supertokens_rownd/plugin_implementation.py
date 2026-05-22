from __future__ import annotations

import time
import uuid
from typing import Any, Dict, List, Optional, Tuple, cast
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

import httpx
from supertokens_python import SupertokensConfig
from supertokens_python.asyncio import delete_user, get_user
from supertokens_python.framework.request import BaseRequest
from supertokens_python.framework.response import BaseResponse
from supertokens_python.recipe.accountlinking import asyncio as accountlinking_asyncio
from supertokens_python.recipe.accountlinking.types import AccountInfoWithRecipeId
from supertokens_python.recipe.emailverification import asyncio as emailverification_asyncio
from supertokens_python.recipe.passwordless import asyncio as passwordless_asyncio
from supertokens_python.recipe.session import SessionContainer
from supertokens_python.recipe.session import asyncio as session_asyncio
from supertokens_python.recipe.thirdparty import asyncio as thirdparty_asyncio
from supertokens_python.recipe.usermetadata import asyncio as usermetadata_asyncio
from supertokens_python.types import RecipeUserId

from .constants import (
    ANONYMOUS_AUTH_METHOD_ID,
    BUILTIN_SIGN_IN_METHOD_KEYS,
    DEFAULT_ROWND_SCHEMA,
    GUEST_AUTH_METHOD_ID,
    IDENTITY_USER_DATA_FIELDS,
    INTERNAL_METADATA_FIELDS,
    PUBLIC_TENANT_ID,
    ROWND_JWT_CLAIMS,
)
from .rownd_client import RowndClient
from .telemetry import record_error, record_success
from .types import JsonDict, RowndPluginConfig, RowndPluginError, RowndTelemetryClient


def log_debug(config: RowndPluginConfig, message: str) -> None:
    if config.enable_debug_logs:
        print("RowndMigrationPlugin: %s" % message)


def json_response(response: BaseResponse, body: JsonDict, status_code: int = 200) -> BaseResponse:
    response.set_status_code(status_code)
    response.set_json_content(body)
    return response


def parse_authorization_header(request: BaseRequest) -> str:
    auth_header = request.get_header("authorization")
    if not auth_header:
        raise RowndPluginError("Missing authorization header")
    token = auth_header[7:] if auth_header.lower().startswith("bearer ") else auth_header
    token = token.strip()
    if not token:
        raise RowndPluginError("Invalid token")
    return token


def get_requested_app_variant_id_from_request(request: BaseRequest) -> Optional[str]:
    return request.get_query_param("app_variant_id") or None


def get_requested_display_context_from_request(request: BaseRequest) -> Optional[str]:
    value = request.get_query_param("rownd_display_context")
    return value if value in {"browser", "mobile_app", "customer_web_view"} else None


def get_requested_redirect_to_path_from_request(request: BaseRequest) -> Optional[str]:
    return request.get_query_param("rownd_redirect_to_path") or None


def assert_app_variant_is_configured(config: RowndPluginConfig, app_variant_id: Optional[str]) -> None:
    if app_variant_id and config.sub_brands and app_variant_id not in config.sub_brands:
        raise RowndPluginError("Unknown Rownd app variant: %s" % app_variant_id)


def rewrite_link_path(
    input_url: Optional[str], target_path: str, search_params: Dict[str, str]
) -> Optional[str]:
    if not input_url:
        return input_url
    parsed = urlparse(input_url)
    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    query.update(search_params)
    if parsed.scheme and parsed.netloc:
        return urlunparse(parsed._replace(path="/" + target_path.lstrip("/"), query=urlencode(query)))
    path = parsed.path.replace("auth/verify", target_path)
    return urlunparse(parsed._replace(path=path, query=urlencode(query)))


def add_hub_bootstrap_params(
    link: Optional[str],
    target_path: str,
    config: RowndPluginConfig,
    user_context: Optional[Dict[str, Any]],
) -> Optional[str]:
    params = {
        "appKey": config.rownd_app_key,
        "apiBasePath": config.api_base_path,
    }
    if config.api_domain:
        params["apiDomain"] = config.api_domain

    user_context = user_context or {}
    if isinstance(user_context.get("rowndAppVariantId"), str):
        params["appVariantId"] = user_context["rowndAppVariantId"]
    if isinstance(user_context.get("rowndDisplayContext"), str):
        params["displayContext"] = user_context["rowndDisplayContext"]
    if isinstance(user_context.get("rowndRedirectToPath"), str):
        params["redirectToPath"] = user_context["rowndRedirectToPath"]
    return rewrite_link_path(link, target_path, params)


async def handle_app_config(
    config: RowndPluginConfig,
    request: BaseRequest,
    response: BaseResponse,
) -> BaseResponse:
    app_variant_id = get_requested_app_variant_id_from_request(request)
    app_config = build_app_config(config, app_variant_id)
    if app_config is None:
        return json_response(
            response,
            {"status": "ERROR", "message": "Unknown Rownd app variant: %s" % app_variant_id},
        )
    return json_response(response, {"status": "OK", **app_config})


async def handle_guest_login(
    config: RowndPluginConfig,
    telemetry_client: RowndTelemetryClient,
    request: BaseRequest,
    response: BaseResponse,
    user_context: Dict[str, Any],
) -> BaseResponse:
    started_at = time.time()
    try:
        body = await _json_body(request)
        app_variant_id = get_requested_app_variant_id_from_request(request)
        assert_app_variant_is_configured(config, app_variant_id)
        auth_level = body.get("auth_level") if isinstance(body, dict) else None
        third_party_id = (
            ANONYMOUS_AUTH_METHOD_ID if auth_level == ANONYMOUS_AUTH_METHOD_ID else GUEST_AUTH_METHOD_ID
        )
        third_party_user_id = (
            "anon_%s" % uuid.uuid4()
            if third_party_id == ANONYMOUS_AUTH_METHOD_ID
            else "guest_%s" % uuid.uuid4()
        )

        result = await thirdparty_asyncio.manually_create_or_update_user(
            tenant_id=PUBLIC_TENANT_ID,
            third_party_id=third_party_id,
            third_party_user_id=third_party_user_id,
            email="%s@anonymous.local" % third_party_user_id,
            is_verified=False,
            user_context=user_context,
        )
        if getattr(result, "status", "OK") != "OK":
            raise RowndPluginError("Guest user creation failed")
        result = cast(Any, result)

        payload = {
            **build_rownd_audience({}, config, app_variant_id),
            "auth_level": GUEST_AUTH_METHOD_ID,
            "is_anonymous": True,
            "app_user_id": result.user.id,
        }
        await session_asyncio.create_new_session(
            request,
            PUBLIC_TENANT_ID,
            result.recipe_user_id,
            payload,
            {},
            {**user_context, **({"rowndAppVariantId": app_variant_id} if app_variant_id else {})},
        )
        await record_success(telemetry_client, started_at, PUBLIC_TENANT_ID, None, result.user.id)
        return json_response(
            response,
            {"status": "OK", "createdNewRecipeUser": result.created_new_recipe_user},
        )
    except Exception as err:
        log_debug(config, "Guest login failed: %s" % err)
        await record_error(telemetry_client, started_at, err, PUBLIC_TENANT_ID)
        return json_response(response, {"status": "ERROR", "message": "Guest login failed"})


async def handle_migrate(
    config: RowndPluginConfig,
    client: RowndClient,
    telemetry_client: RowndTelemetryClient,
    supertokens_config: SupertokensConfig,
    request: BaseRequest,
    response: BaseResponse,
    user_context: Dict[str, Any],
) -> BaseResponse:
    started_at = time.time()
    rownd_user_id = None
    supertokens_user_id = None
    try:
        token = parse_authorization_header(request)
        app_variant_id = get_requested_app_variant_id_from_request(request)
        assert_app_variant_is_configured(config, app_variant_id)
        rownd_user_id = await client.validate_token(token)
        user = await get_user(rownd_user_id, user_context)
        recipe_user_id = None

        if user is None:
            rownd_user = await client.fetch_user_info(rownd_user_id)
            try:
                imported_user = await import_user(
                    map_rownd_user_to_supertokens(rownd_user), supertokens_config
                )
                supertokens_user_id = imported_user["id"]
                login_methods = imported_user.get("loginMethods") or []
                if login_methods:
                    recipe_user_id = RecipeUserId(login_methods[0]["recipeUserId"])
            except Exception:
                user = await get_user(rownd_user_id, user_context)
                if user is None:
                    raise
                supertokens_user_id = user.id
                recipe_user_id = user.login_methods[0].recipe_user_id if user.login_methods else None
        else:
            supertokens_user_id = user.id
            recipe_user_id = user.login_methods[0].recipe_user_id if user.login_methods else None

        if supertokens_user_id:
            await record_rownd_app_variant_for_user(config, supertokens_user_id, app_variant_id)
        if recipe_user_id is None:
            raise RowndPluginError("User not found or has no login methods")

        await sync_imported_email_verification_state(recipe_user_id, supertokens_user_id, user_context)

        await session_asyncio.create_new_session(
            request,
            PUBLIC_TENANT_ID,
            recipe_user_id,
            await build_rownd_session_claims(
                config,
                supertokens_user_id or recipe_user_id.get_as_string(),
                {},
                app_variant_id,
            ),
            {},
            {**user_context, **({"rowndAppVariantId": app_variant_id} if app_variant_id else {})},
        )
        await record_success(
            telemetry_client, started_at, PUBLIC_TENANT_ID, rownd_user_id, supertokens_user_id
        )
        return json_response(response, {"status": "OK"})
    except Exception as err:
        log_debug(config, "Migration failed for Rownd user %s: %s" % (rownd_user_id, err))
        await record_error(
            telemetry_client, started_at, err, PUBLIC_TENANT_ID, rownd_user_id, supertokens_user_id
        )
        return json_response(
            response,
            {"status": "ERROR", "message": str(err) if isinstance(err, RowndPluginError) else "Migration failed"},
        )


async def handle_signout(session: Optional[SessionContainer], response: BaseResponse) -> BaseResponse:
    session = require_session(session)
    await session_asyncio.revoke_all_sessions_for_user(
        session.get_user_id(), revoke_sessions_for_linked_accounts=True, tenant_id=session.get_tenant_id()
    )
    return json_response(response, {"status": "OK"})


async def handle_get_user(session: Optional[SessionContainer], response: BaseResponse) -> BaseResponse:
    session = require_session(session)
    return json_response(response, {"status": "OK", **(await get_rownd_compat_user(session.get_user_id()))})


async def handle_update_user(
    config: RowndPluginConfig,
    request: BaseRequest,
    response: BaseResponse,
    session: Optional[SessionContainer],
    user_context: Dict[str, Any],
) -> BaseResponse:
    session = require_session(session)
    app_variant_id = get_requested_app_variant_id_from_request(request)
    assert_app_variant_is_configured(config, app_variant_id)
    body = await _json_body(request)
    data = as_json_dict(body.get("data"))
    context = as_json_dict(body.get("context"))
    data_without_email = {key: value for key, value in data.items() if key != "email"}
    permission_error = validate_writable_fields(config, list(data_without_email.keys()))
    if permission_error:
        return json_response(response, permission_error, int(permission_error.get("code", 400)))
    if data_without_email:
        await update_user_data(session.get_user_id(), data_without_email)
    if isinstance(data.get("email"), str):
        return json_response(
            response,
            {
                "status": "OK",
                **(
                    await start_pending_email_verification(
                        config,
                        session,
                        data["email"],
                        {**user_context, **context, **({"rowndAppVariantId": app_variant_id} if app_variant_id else {})},
                    )
                ),
            },
        )
    return json_response(response, {"status": "OK", **(await get_rownd_compat_user(session.get_user_id()))})


async def handle_delete_user(session: Optional[SessionContainer], response: BaseResponse) -> BaseResponse:
    session = require_session(session)
    await delete_user(session.get_user_id(), remove_all_linked_accounts=True)
    return json_response(response, {"status": "OK"})


async def handle_get_user_meta(session: Optional[SessionContainer], response: BaseResponse) -> BaseResponse:
    session = require_session(session)
    metadata = await get_user_metadata(session.get_user_id())
    return json_response(response, {"status": "OK", "id": session.get_user_id(), "meta": public_metadata(metadata)})


async def handle_update_user_meta(
    request: BaseRequest, response: BaseResponse, session: Optional[SessionContainer]
) -> BaseResponse:
    session = require_session(session)
    body = await _json_body(request)
    meta = as_json_dict(body.get("meta"))
    internal_field = next((key for key in meta if is_internal_metadata_field(key)), None)
    if internal_field:
        return json_response(response, {"status": "ERROR", "code": 403, "message": "field is not writable: %s" % internal_field}, 403)
    updated = await update_user_metadata(session.get_user_id(), meta)
    return json_response(response, {"status": "OK", **updated})


async def handle_get_user_field(
    request: BaseRequest, response: BaseResponse, session: Optional[SessionContainer]
) -> BaseResponse:
    session = require_session(session)
    field_name = request.get_query_param("field")
    if not field_name:
        return json_response(response, missing_field_response(), 400)
    user = await get_rownd_compat_user(session.get_user_id())
    return json_response(response, {"status": "OK", "value": user["data"].get(field_name)})


async def handle_update_user_field(
    config: RowndPluginConfig,
    request: BaseRequest,
    response: BaseResponse,
    session: Optional[SessionContainer],
    user_context: Dict[str, Any],
) -> BaseResponse:
    session = require_session(session)
    field_name = request.get_query_param("field")
    if not field_name:
        return json_response(response, missing_field_response(), 400)
    app_variant_id = get_requested_app_variant_id_from_request(request)
    assert_app_variant_is_configured(config, app_variant_id)
    body = await _json_body(request)
    if field_name == "email" and isinstance(body.get("value"), str):
        return json_response(
            response,
            {
                "status": "OK",
                **(
                    await start_pending_email_verification(
                        config,
                        session,
                        body["value"],
                        {**user_context, **({"rowndAppVariantId": app_variant_id} if app_variant_id else {})},
                    )
                ),
            },
        )
    permission_error = validate_writable_fields(config, [field_name])
    if permission_error:
        return json_response(response, permission_error, int(permission_error.get("code", 400)))
    return json_response(
        response,
        {"status": "OK", **(await update_user_data(session.get_user_id(), {field_name: body.get("value")}))},
    )


def require_session(session: Optional[SessionContainer]) -> SessionContainer:
    if session is None:
        raise RowndPluginError("Session not found")
    return session


async def _json_body(request: BaseRequest) -> JsonDict:
    return as_json_dict(await request.json())


def as_json_dict(value: Any) -> JsonDict:
    return cast(JsonDict, value) if isinstance(value, dict) else {}


def as_json_list(value: Any) -> List[JsonDict]:
    return [cast(JsonDict, item) for item in value if isinstance(item, dict)] if isinstance(value, list) else []


async def get_user_metadata(user_id: str) -> JsonDict:
    result = await usermetadata_asyncio.get_user_metadata(user_id)
    return result.metadata or {}


async def update_user_metadata(user_id: str, input_meta: JsonDict) -> JsonDict:
    metadata = await get_user_metadata(user_id)
    updated = {**metadata, **input_meta}
    await usermetadata_asyncio.update_user_metadata(user_id, updated)
    return {"id": user_id, "meta": public_metadata(updated)}


async def update_user_data(user_id: str, input_data: JsonDict) -> JsonDict:
    metadata = await get_user_metadata(user_id)
    await usermetadata_asyncio.update_user_metadata(user_id, {**metadata, **input_data})
    return await get_rownd_compat_user(user_id)


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
    owned_by = "app" if field_name in {"google_id", "apple_id"} else schema_field.get("owned_by", "user")
    return owned_by != "app" and schema_field.get("read_only") is not True


def validate_writable_fields(config: RowndPluginConfig, fields: List[str]) -> Optional[JsonDict]:
    for field_name in fields:
        if not can_update_user_data_field(config, field_name):
            return {"status": "ERROR", "code": 403, "message": "field is not writable: %s" % field_name}
    return None


def missing_field_response() -> JsonDict:
    return {"status": "ERROR", "code": 400, "message": "field is required"}


async def get_rownd_compat_user(user_id: str) -> JsonDict:
    metadata = await get_user_metadata(user_id)
    st_user = await get_user(user_id)
    if st_user is None:
        raise RowndPluginError("User not found in Rownd")

    original = as_json_dict(metadata.get("original_rownd_user"))
    original_data = as_json_dict(original.get("data"))
    verified_data = as_json_dict(original.get("verified_data"))
    data: JsonDict = {"user_id": user_id}
    data_field_keys = set()

    for key, value in original_data.items():
        if not is_identity_field(key):
            data[key] = value
            data_field_keys.add(key)

    for key in DEFAULT_ROWND_SCHEMA.keys():
        data_field_keys.add(key)
        if not is_identity_field(key) and not is_internal_metadata_field(key) and key in metadata:
            data[key] = metadata[key]

    last_used_at = st_user.time_joined
    for method in st_user.login_methods:
        last_used_at = max(last_used_at, getattr(method, "time_joined", last_used_at))
        if method.recipe_id == "passwordless":
            if method.email:
                verified_data["email"] = method.email
                data.setdefault("email", method.email)
            if method.phone_number:
                verified_data["phone_number"] = method.phone_number
                data.setdefault("phone_number", method.phone_number)
        elif method.recipe_id == "thirdparty":
            third_party_id, third_party_user_id = get_third_party_info(method)
            if method.verified and method.email:
                verified_data["email"] = method.email
            if method.email:
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

    anonymous_id = get_anonymous_id(st_user.id, st_user, metadata)
    if anonymous_id:
        data.setdefault("anonymous_id", anonymous_id)

    for key, schema_field in DEFAULT_ROWND_SCHEMA.items():
        if data.get(key) is None and schema_field.get("type") == "string":
            data[key] = ""

    sorted_by_joined = sorted(st_user.login_methods, key=lambda method: method.time_joined)
    first_method = sorted_by_joined[0] if sorted_by_joined else None
    last_method = sorted_by_joined[-1] if sorted_by_joined else None
    metadata_meta = {
        key: value
        for key, value in metadata.items()
        if not is_internal_metadata_field(key) and key not in data_field_keys
    }

    return {
        "rownd_user": original_data.get("user_id", user_id),
        "data": data,
        "meta": {
            **metadata_meta,
            "created": iso_from_ms(st_user.time_joined),
            "first_sign_in": iso_from_ms(st_user.time_joined),
            "last_sign_in": iso_from_ms(last_used_at),
            "last_active": iso_from_ms(last_used_at),
            "first_sign_in_method": map_login_method(first_method),
            "last_sign_in_method": map_login_method(last_method),
        },
        "verified_data": verified_data,
        "state": original.get("state", "enabled"),
        "auth_level": get_effective_auth_level(st_user, original.get("auth_level"), verified_data),
        "redacted": [],
        "groups": original.get("groups", []),
        "attributes": original.get("attributes", {}),
    }


def iso_from_ms(value: int) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(value / 1000))


def get_third_party_info(method: Any) -> Tuple[Optional[str], Optional[str]]:
    third_party = getattr(method, "third_party", None)
    return getattr(third_party, "id", None), getattr(third_party, "user_id", None)


def is_guest_login_method(method: Any) -> bool:
    third_party_id, _ = get_third_party_info(method)
    return method.recipe_id == "thirdparty" and third_party_id in {GUEST_AUTH_METHOD_ID, ANONYMOUS_AUTH_METHOD_ID}


def has_only_guest_login_methods(user: Any) -> bool:
    return bool(user and user.login_methods) and all(is_guest_login_method(method) for method in user.login_methods)


def has_verified_real_login_method(user: Any) -> bool:
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


def get_guest_auth_level(user: Any) -> Optional[str]:
    if user and any(is_guest_login_method(method) for method in user.login_methods):
        return GUEST_AUTH_METHOD_ID
    return None


def get_effective_auth_level(
    user: Any, original_auth_level: Optional[str] = None, verified_data: Optional[JsonDict] = None
) -> str:
    if has_verified_real_login_method(user):
        return "verified"
    return get_guest_auth_level(user) or original_auth_level or ("verified" if verified_data else "unverified")


def get_anonymous_id(user_id: str, user: Any, metadata: JsonDict) -> Optional[str]:
    original = as_json_dict(metadata.get("original_rownd_user"))
    original_data = as_json_dict(original.get("data"))
    if isinstance(original_data.get("anonymous_id"), str):
        return original_data["anonymous_id"]
    if user:
        for method in user.login_methods:
            third_party_id, third_party_user_id = get_third_party_info(method)
            if method.recipe_id == "thirdparty" and third_party_id == ANONYMOUS_AUTH_METHOD_ID and third_party_user_id:
                return third_party_user_id
    return "anon_%s" % user_id if user and any(is_guest_login_method(method) for method in user.login_methods) else None


def map_login_method(method: Any) -> str:
    if method is None:
        return "email"
    if method.recipe_id == "thirdparty":
        third_party_id, _ = get_third_party_info(method)
        if third_party_id in {"google", "apple"}:
            return third_party_id
    if method.recipe_id == "passwordless":
        return "email" if method.email else "phone"
    return "email"


async def build_rownd_session_claims(
    config: RowndPluginConfig,
    user_id: str,
    current_payload: JsonDict,
    app_variant_id: Optional[str],
) -> JsonDict:
    user = await get_user(user_id)
    metadata = await get_user_metadata(user.id if user else user_id) if user else {}
    original = as_json_dict(metadata.get("original_rownd_user"))
    verified_data = as_json_dict(original.get("verified_data"))
    auth_level = get_effective_auth_level(user, original.get("auth_level"), verified_data)
    app_user_id = as_json_dict(original.get("data")).get("user_id")
    app_user_id = app_user_id or current_payload.get("app_user_id") or (user.id if user else user_id)
    is_anonymous = auth_level == GUEST_AUTH_METHOD_ID
    anonymous_id = get_anonymous_id(user_id, user, metadata) if user else None
    claims = {
        **build_rownd_audience(current_payload, config, app_variant_id),
        **build_configured_session_claims(config, metadata),
        "app_user_id": app_user_id,
        "auth_level": auth_level,
        "is_verified_user": auth_level != "unverified",
        "is_anonymous": is_anonymous,
        ROWND_JWT_CLAIMS["app_user_id"]: app_user_id,
        ROWND_JWT_CLAIMS["auth_level"]: auth_level,
        ROWND_JWT_CLAIMS["is_verified_user"]: auth_level != "unverified",
        ROWND_JWT_CLAIMS["is_anonymous"]: is_anonymous,
    }
    if anonymous_id:
        claims["anonymous_id"] = anonymous_id
    return claims


def build_configured_session_claims(config: RowndPluginConfig, metadata: JsonDict) -> JsonDict:
    original = as_json_dict(metadata.get("original_rownd_user"))
    original_data = as_json_dict(original.get("data"))
    claims = {}
    for key, field_config in config.schema.items():
        if field_config.get("include_in_session_claims") is not True:
            continue
        value = original_data.get(key, metadata.get(key))
        if value is not None:
            claims[field_config.get("session_claim_name") or key] = value
    return claims


def build_rownd_audience(current_payload: JsonDict, config: RowndPluginConfig, app_variant_id: Optional[str]) -> JsonDict:
    aud = current_payload.get("aud") or []
    if isinstance(aud, str):
        aud = [aud]
    if not isinstance(aud, list):
        aud = []
    app_id = config.app_config.get("id")
    if app_id:
        aud.append("app:%s" % app_id)
    if app_variant_id:
        aud.append("app_variant:%s" % app_variant_id)
    return {"aud": list(dict.fromkeys(aud))} if aud else {}


async def record_rownd_app_variant_for_user(
    config: RowndPluginConfig, user_id: str, app_variant_id: Optional[str]
) -> None:
    if not app_variant_id:
        return
    assert_app_variant_is_configured(config, app_variant_id)
    metadata = await get_user_metadata(user_id)
    original = as_json_dict(metadata.get("original_rownd_user"))
    attributes = as_json_dict(original.get("attributes"))
    app_variants = attributes.get("rownd:app_variants") or []
    if isinstance(app_variants, str):
        app_variants = [app_variants]
    if not isinstance(app_variants, list):
        app_variants = []
    if app_variant_id in app_variants:
        return
    await usermetadata_asyncio.update_user_metadata(
        user_id,
        {
            **metadata,
            "original_rownd_user": {
                **original,
                "data": as_json_dict(original.get("data")) or {"user_id": user_id},
                "verified_data": as_json_dict(original.get("verified_data")),
                "attributes": {**attributes, "rownd:app_variants": [*app_variants, app_variant_id]},
            },
        },
    )


def map_rownd_user_to_supertokens(rownd_user: JsonDict) -> JsonDict:
    login_methods = []
    data = as_json_dict(rownd_user.get("data"))
    verified_data = as_json_dict(rownd_user.get("verified_data"))
    if not data.get("user_id"):
        raise RowndPluginError("Rownd user has no user_id")

    if data.get("google_id"):
        if not data.get("email"):
            raise RowndPluginError("Rownd Google user is missing email")
        login_methods.append({"recipeId": "thirdparty", "thirdPartyId": "google", "thirdPartyUserId": data["google_id"], "email": data["email"], "isVerified": bool(verified_data.get("google_id"))})
    if data.get("apple_id"):
        if not data.get("email"):
            raise RowndPluginError("Rownd Apple user is missing email")
        login_methods.append({"recipeId": "thirdparty", "thirdPartyId": "apple", "thirdPartyUserId": data["apple_id"], "email": data["email"], "isVerified": bool(verified_data.get("apple_id"))})
    if data.get("phone_number"):
        login_methods.append({"recipeId": "passwordless", "phoneNumber": data["phone_number"], "isVerified": bool(verified_data.get("phone_number"))})
    if data.get("email") and not data.get("google_id") and not data.get("apple_id"):
        login_methods.append({"recipeId": "passwordless", "email": data["email"], "isVerified": bool(verified_data.get("email"))})
    if not login_methods:
        auth_level = rownd_user.get("auth_level")
        third_party_id = GUEST_AUTH_METHOD_ID if auth_level == GUEST_AUTH_METHOD_ID else ANONYMOUS_AUTH_METHOD_ID
        login_methods.append({"recipeId": "thirdparty", "thirdPartyId": third_party_id, "thirdPartyUserId": data["user_id"], "email": "%s@anonymous.local" % data["user_id"], "isVerified": False})

    return {
        "externalUserId": data["user_id"],
        "loginMethods": login_methods,
        "userMetadata": build_rownd_user_metadata(rownd_user),
    }


def build_rownd_user_metadata(rownd_user: JsonDict) -> JsonDict:
    metadata = dict(as_json_dict(rownd_user.get("meta")))
    metadata["original_rownd_user"] = rownd_user
    data = as_json_dict(rownd_user.get("data"))
    for key, value in data.items():
        if not is_identity_field(key) and value is not None:
            metadata[key] = value
    return metadata


async def import_user(user_import: JsonDict, supertokens_config: SupertokensConfig) -> JsonDict:
    headers = {"Content-Type": "application/json"}
    if supertokens_config.api_key:
        headers["api-key"] = supertokens_config.api_key
    async with httpx.AsyncClient(timeout=15.0) as client:
        res = await client.post(
            supertokens_config.connection_uri.rstrip("/") + "/bulk-import/import",
            headers=headers,
            json=user_import,
        )
    if res.status_code < 200 or res.status_code >= 300:
        raise RuntimeError("Bulk import failed with status %s: %s" % (res.status_code, res.text))
    data = res.json()
    if data.get("status") != "OK" or not data.get("user"):
        raise RuntimeError("Bulk import failed: %s" % (data.get("message") or "Missing user in response"))
    return data["user"]


async def sync_imported_email_verification_state(
    recipe_user_id: RecipeUserId,
    user_id: Optional[str],
    user_context: Dict[str, Any],
) -> None:
    metadata = await get_user_metadata(user_id or recipe_user_id.get_as_string())
    original = as_json_dict(metadata.get("original_rownd_user"))
    data = as_json_dict(original.get("data"))
    verified_data = as_json_dict(original.get("verified_data"))
    email = data.get("email")
    if not isinstance(email, str) or not verified_data.get("email"):
        return
    try:
        token_result = await emailverification_asyncio.create_email_verification_token(
            PUBLIC_TENANT_ID, recipe_user_id, email, user_context
        )
        token = getattr(token_result, "token", None)
        if isinstance(token, str):
            await emailverification_asyncio.verify_email_using_token(
                PUBLIC_TENANT_ID, token, False, user_context
            )
    except Exception:
        return


async def start_pending_email_verification(
    config: RowndPluginConfig,
    session: SessionContainer,
    email: str,
    user_context: Dict[str, Any],
) -> JsonDict:
    user_id = session.get_user_id()
    metadata = await get_user_metadata(user_id)
    current_email = (await get_rownd_compat_user(user_id))["data"].get("email")
    if current_email == email:
        return await get_rownd_compat_user(user_id)

    pending = [item for item in metadata.get("rownd_pending_verification", []) if isinstance(item, dict)]
    for verification in [item for item in pending if item.get("field") == "email"]:
        await emailverification_asyncio.revoke_email_verification_tokens(
            session.get_tenant_id(), session.get_recipe_user_id(), verification.get("value"), user_context
        )

    pending_verification = {
        "id": str(uuid.uuid4()),
        "field": "email",
        "value": email,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    await usermetadata_asyncio.update_user_metadata(
        user_id,
        {
            **metadata,
            "rownd_pending_verification": [
                *[item for item in pending if item.get("field") != "email"],
                pending_verification,
            ],
        },
    )

    result = await emailverification_asyncio.send_email_verification_email(
        session.get_tenant_id(),
        user_id,
        session.get_recipe_user_id(),
        email,
        {**user_context, "rowndPendingVerificationId": pending_verification["id"]},
    )
    if getattr(result, "status", None) == "EMAIL_ALREADY_VERIFIED_ERROR":
        await complete_pending_email_verification(session.get_recipe_user_id(), email, user_context)
    return await get_rownd_compat_user(user_id)


async def complete_pending_email_verification(
    recipe_user_id: RecipeUserId,
    email: str,
    user_context: Dict[str, Any],
) -> None:
    user = await get_user(recipe_user_id.get_as_string(), user_context)
    user_id = user.id if user else recipe_user_id.get_as_string()
    metadata = await get_user_metadata(user_id)
    pending = [item for item in metadata.get("rownd_pending_verification", []) if isinstance(item, dict)]
    pending_verification = next((item for item in pending if item.get("field") == "email" and item.get("value") == email), None)
    if not pending_verification:
        return

    metadata_user_id = user_id
    passwordless_email_method = get_passwordless_email_login_method(user)
    if passwordless_email_method:
        result = await passwordless_asyncio.update_user(passwordless_email_method.recipe_user_id, email=email, user_context=user_context)
        if getattr(result, "status", "OK") != "OK":
            raise RowndPluginError("Failed to update verified email method: %s" % getattr(result, "status", "ERROR"))
    elif has_only_guest_login_methods(user):
        allowed = await accountlinking_asyncio.is_sign_up_allowed(
            PUBLIC_TENANT_ID,
            AccountInfoWithRecipeId(recipe_id="passwordless", email=email),
            True,
            None,
            user_context,
        )
        if not allowed:
            raise RowndPluginError("Passwordless sign up is not allowed for this email")
        passwordless_result = await passwordless_asyncio.signinup(
            PUBLIC_TENANT_ID, email, None, None, user_context
        )
        primary_result = await accountlinking_asyncio.create_primary_user(
            passwordless_result.recipe_user_id, user_context
        )
        if getattr(primary_result, "status", "OK") != "OK":
            primary_user = await accountlinking_asyncio.create_primary_user_id_or_link_accounts(
                PUBLIC_TENANT_ID, passwordless_result.recipe_user_id, None, user_context
            )
        else:
            primary_result = cast(Any, primary_result)
            primary_user = primary_result.user
        link_result = await accountlinking_asyncio.link_accounts(
            recipe_user_id, primary_user.id, user_context
        )
        if getattr(link_result, "status", "OK") != "OK":
            raise RowndPluginError("Failed to link guest account: %s" % getattr(link_result, "status", "ERROR"))
        link_result = cast(Any, link_result)
        metadata_user_id = link_result.user.id

    original = as_json_dict(metadata.get("original_rownd_user")) or {
        "data": {"user_id": metadata_user_id},
        "verified_data": {},
    }
    updated = {
        **metadata,
        "rownd_pending_verification": [item for item in pending if item is not pending_verification],
    }
    updated["original_rownd_user"] = {
        **original,
        "data": {**as_json_dict(original.get("data")), "user_id": metadata_user_id, "email": email},
        "verified_data": {**as_json_dict(original.get("verified_data")), "email": email},
    }
    await usermetadata_asyncio.update_user_metadata(metadata_user_id, updated)


def get_passwordless_email_login_method(user: Any) -> Optional[Any]:
    if not user:
        return None
    return next((method for method in user.login_methods if method.recipe_id == "passwordless" and method.email), None)


def is_guest_account_info(account_info: Any) -> bool:
    third_party = getattr(account_info, "third_party", None)
    return getattr(account_info, "recipe_id", None) == "thirdparty" and getattr(third_party, "id", None) in {GUEST_AUTH_METHOD_ID, ANONYMOUS_AUTH_METHOD_ID}


def does_account_info_match_auth_method(user: Any, account_info: Any) -> bool:
    normalized_email = account_info.email.lower() if getattr(account_info, "email", None) else None
    if normalized_email:
        return any(not is_guest_login_method(method) and method.email and method.email.lower() == normalized_email for method in user.login_methods)
    if getattr(account_info, "phone_number", None):
        return any(not is_guest_login_method(method) and method.phone_number == account_info.phone_number for method in user.login_methods)
    return False


def deep_merge(base: JsonDict, overlay: JsonDict) -> JsonDict:
    result = dict(base)
    for key, value in overlay.items():
        if value is None:
            continue
        existing = result.get(key)
        if isinstance(existing, dict) and isinstance(value, dict):
            result[key] = deep_merge(existing, value)
        else:
            result[key] = value
    return result


def build_app_config(config: RowndPluginConfig, app_variant_id: Optional[str]) -> Optional[JsonDict]:
    base_app = config.app_config or {}
    sub_brand = config.sub_brands.get(app_variant_id) if app_variant_id else None
    if app_variant_id and sub_brand is None:
        return None
    app = deep_merge(base_app, sub_brand or {})
    schema = dict(config.schema or DEFAULT_ROWND_SCHEMA)
    sign_in_methods = build_sign_in_methods_config(app.get("signInMethods") or [])

    if sign_in_methods["email"]["enabled"] and "email" not in schema:
        schema["email"] = {"display_name": "Email", "type": "string", "user_visible": True}
    if sign_in_methods["phone"]["enabled"] and "phone_number" not in schema:
        schema["phone_number"] = {"display_name": "Phone number", "type": "string", "user_visible": True}
    if sign_in_methods["google"]["enabled"] and "google_id" not in schema:
        schema["google_id"] = {"display_name": "Google ID", "type": "string", "user_visible": False}
    if sign_in_methods["apple"]["enabled"] and "apple_id" not in schema:
        schema["apple_id"] = {"display_name": "Apple ID", "type": "string", "user_visible": False}

    branding = app.get("branding") or {}
    auth = app.get("auth") or {}
    hub_auth = {
        "email": build_auth_email_config(auth.get("email") or {}),
        **({"mobile": build_auth_mobile_config(auth.get("mobile") or {})} if auth.get("mobile") else {}),
        "sign_in_methods": sign_in_methods,
        "additional_fields": auth.get("additionalFields", []),
        **({"remember_sign_in_method": auth["rememberSignInMethod"]} if "rememberSignInMethod" in auth else {}),
        **({"use_explicit_sign_up_flow": auth["useExplicitSignUpFlow"]} if "useExplicitSignUpFlow" in auth else {}),
        **({"allow_unverified_users": auth["allowUnverifiedUsers"]} if "allowUnverifiedUsers" in auth else {}),
        **({"primary_sign_up_method": auth["primarySignUpMethod"]} if auth.get("primarySignUpMethod") else {}),
        **({"preferred_method": auth["preferredMethod"]} if auth.get("preferredMethod") else {}),
        **({"order": auth["order"]} if auth.get("order") else {}),
        **({"instant_user": {"enabled": True}} if is_instant_anonymous_method(app.get("signInMethods") or []) else {}),
        "show_app_icon": branding.get("showAppIcon", False),
    }
    return {
        "config_type": "variant" if app_variant_id else "app",
        **({"variant": app.get("variant")} if isinstance(app.get("variant"), dict) else {}),
        "app": {
            "id": app.get("id", ""),
            "name": app.get("name", config.app_name),
            "icon": app.get("icon", ""),
            **({"user_verification_fields": app["userVerificationFields"]} if app.get("userVerificationFields") else {}),
            "schema": {key: normalize_schema_field(key, field) for key, field in schema.items()},
            "config": {
                **({"capabilities": app["capabilities"]} if app.get("capabilities") else {}),
                **({"web": app["web"]} if app.get("web") else {}),
                **({"bottom_sheet": app["bottomSheet"]} if app.get("bottomSheet") else {}),
                **({"profile_storage_version": app["profileStorageVersion"]} if app.get("profileStorageVersion") else {}),
                "customizations": {
                    "primary_color": branding.get("primaryColor", "#5b5bd6"),
                    **({"logo": branding["logo"]} if branding.get("logo") else {}),
                    **({"logo_dark_mode": branding["logoDarkMode"]} if branding.get("logoDarkMode") else {}),
                    **({"animations": branding["animations"]} if branding.get("animations") else {}),
                },
                "hub": {
                    **({"allowed_web_origins": app["allowedWebOrigins"]} if app.get("allowedWebOrigins") else {}),
                    "customizations": {
                        "rounded_corners": branding.get("roundedCorners", True),
                        **({"container_border_radius": branding["containerBorderRadius"]} if "containerBorderRadius" in branding else {}),
                        **({"placement": branding["placement"]} if "placement" in branding else {}),
                        **({"primary_color": branding["hubPrimaryColor"]} if "hubPrimaryColor" in branding else {}),
                        **({"primary_color_dark_mode": branding["primaryColorDarkMode"]} if "primaryColorDarkMode" in branding else {}),
                        **({"background_color": branding["backgroundColor"]} if "backgroundColor" in branding else {}),
                        **({"font_family": branding["fontFamily"]} if "fontFamily" in branding else {}),
                        **({"hide_verification_icons": branding["hideVerificationIcons"]} if "hideVerificationIcons" in branding else {}),
                        "visual_swoops": branding.get("visualSwoops", True),
                        "blur_background": branding.get("blurBackground", True),
                        **({"blur_background_opacity": branding["blurBackgroundOpacity"]} if "blurBackgroundOpacity" in branding else {}),
                        **({"offset_x": branding["offsetX"]} if "offsetX" in branding else {}),
                        **({"offset_y": branding["offsetY"]} if "offsetY" in branding else {}),
                        **({"property_overrides": branding["propertyOverrides"]} if branding.get("propertyOverrides") else {}),
                        "dark_mode": branding.get("darkMode", "auto"),
                    },
                    **({"custom_scripts": branding["customScripts"]} if branding.get("customScripts") else {}),
                    **({"custom_styles": branding["customStyles"]} if branding.get("customStyles") else {}),
                    "auth": hub_auth,
                    "legal": build_legal_config(app.get("legal") or {}),
                    "profile": build_profile_config(app.get("profile") or {}),
                    "custom_content": build_custom_content_config(app.get("customContent") or {}),
                },
            },
        },
    }


def normalize_schema_field(key: str, field: JsonDict) -> JsonDict:
    owned_by = "app" if key in {"google_id", "apple_id"} else field.get("owned_by", "user")
    return {
        "display_name": field.get("display_name", key),
        "type": field.get("type", "string"),
        "owned_by": owned_by,
        "user_visible": field.get("user_visible", True),
        "read_only": field.get("read_only", owned_by == "app"),
        "show_empty": field.get("show_empty", False),
    }


def build_sign_in_methods_config(methods_array: List[JsonDict]) -> JsonDict:
    methods = {item.get("method"): item for item in methods_array if isinstance(item, dict)}
    custom_providers = {
        key: {
            "enabled": True,
            "display_name": value.get("displayName", key),
            "icon_light_url": value.get("iconLightUrl"),
            "icon_dark_url": value.get("iconDarkUrl"),
        }
        for key, value in methods.items()
        if key and key not in BUILTIN_SIGN_IN_METHOD_KEYS
    }
    google = methods.get("google") or {}
    apple = methods.get("apple") or {}
    anonymous = methods.get("anonymous") or {}
    return {
        "email": {"enabled": "email" in methods},
        "phone": {"enabled": "phone" in methods},
        "google": {
            "enabled": "google" in methods,
            "client_id": google.get("clientId", ""),
            "ios_client_id": google.get("iosClientId", ""),
            "scopes": google.get("scopes", []),
            **({"one_tap": snake_case_auth_order(google["oneTap"])} if google.get("oneTap") else {}),
        },
        "apple": {"enabled": "apple" in methods, "client_id": apple.get("clientId", "")},
        "anonymous": {
            "enabled": "anonymous" in methods and anonymous.get("type") != "instant",
            **({"type": anonymous["type"]} if anonymous.get("type") else {}),
            "display_name": anonymous.get("displayName", "Continue as a guest"),
        },
        **custom_providers,
    }


def build_auth_email_config(auth_email: JsonDict) -> JsonDict:
    return {
        "from_address": auth_email.get("fromAddress", "no-reply@rownd.io"),
        "image": auth_email.get("image", ""),
        **({"subject": auth_email["subject"]} if auth_email.get("subject") else {}),
        **({"call_to_action_text": auth_email["callToActionText"]} if auth_email.get("callToActionText") else {}),
        **({"verify_template": auth_email["verifyTemplate"]} if auth_email.get("verifyTemplate") else {}),
        **({"custom_content": auth_email["customContent"]} if auth_email.get("customContent") else {}),
        **({"custom_closing_content": auth_email["customClosingContent"]} if auth_email.get("customClosingContent") else {}),
    }


def build_auth_mobile_config(auth_mobile: JsonDict) -> JsonDict:
    return {
        **({"title": auth_mobile["title"]} if auth_mobile.get("title") else {}),
        **({"image": auth_mobile["image"]} if auth_mobile.get("image") else {}),
        **({"call_to_action_text": auth_mobile["callToActionText"]} if auth_mobile.get("callToActionText") else {}),
        **({"hyperlink_text": auth_mobile["hyperlinkText"]} if auth_mobile.get("hyperlinkText") else {}),
        **({"hyperlink_redirect_url": auth_mobile["hyperlinkRedirectUrl"]} if auth_mobile.get("hyperlinkRedirectUrl") else {}),
        **({"custom_content": auth_mobile["customContent"]} if auth_mobile.get("customContent") else {}),
    }


def build_legal_config(legal: JsonDict) -> JsonDict:
    return {
        **({"company_name": legal["companyName"]} if legal.get("companyName") else {}),
        **({"privacy_policy_url": legal["privacyPolicyUrl"]} if legal.get("privacyPolicyUrl") else {}),
        **({"terms_conditions_url": legal["termsConditionsUrl"]} if legal.get("termsConditionsUrl") else {}),
        **({"support_email": legal["supportEmail"]} if legal.get("supportEmail") else {}),
    }


def build_profile_config(profile: JsonDict) -> JsonDict:
    return {
        **({"account_information": profile["accountInformation"]} if profile.get("accountInformation") else {}),
        **({"personal_information": profile["personalInformation"]} if profile.get("personalInformation") else {}),
        **({"preferences": profile["preferences"]} if profile.get("preferences") else {}),
        **({"sign_out_button": profile["signOutButton"]} if profile.get("signOutButton") else {}),
        **({"delete_account_button": profile["deleteAccountButton"]} if profile.get("deleteAccountButton") else {}),
        **({"add_sign_in_methods_button": profile["addSignInMethodsButton"]} if profile.get("addSignInMethodsButton") else {}),
    }


def build_custom_content_config(custom_content: JsonDict) -> JsonDict:
    return {
        **({"sign_in_modal": build_sign_in_modal_config(custom_content["signInModal"])} if custom_content.get("signInModal") else {}),
        **({"profile_modal": custom_content["profileModal"]} if custom_content.get("profileModal") else {}),
        **({"verification_modal": build_verification_modal_config(custom_content["verificationModal"])} if custom_content.get("verificationModal") else {}),
        **({"sign_in_failure_modal": {"failure_message": custom_content["signInFailureModal"].get("failureMessage")}} if custom_content.get("signInFailureModal") else {}),
        **({"no_account_message": custom_content["noAccountMessage"]} if custom_content.get("noAccountMessage") else {}),
        **({"mobile": custom_content["mobile"]} if custom_content.get("mobile") else {}),
    }


def build_sign_in_modal_config(sign_in_modal: JsonDict) -> JsonDict:
    return {
        **({"title": sign_in_modal["title"]} if sign_in_modal.get("title") else {}),
        **({"subtitle": sign_in_modal["subtitle"]} if sign_in_modal.get("subtitle") else {}),
        **({"sign_in_title": sign_in_modal["signInTitle"]} if sign_in_modal.get("signInTitle") else {}),
        **({"sign_up_title": sign_in_modal["signUpTitle"]} if sign_in_modal.get("signUpTitle") else {}),
        **({"sign_in_subtitle": sign_in_modal["signInSubtitle"]} if sign_in_modal.get("signInSubtitle") else {}),
        **({"sign_up_subtitle": sign_in_modal["signUpSubtitle"]} if sign_in_modal.get("signUpSubtitle") else {}),
        **({"sign_in_button": sign_in_modal["signInButton"]} if sign_in_modal.get("signInButton") else {}),
        **({"sign_up_button": sign_in_modal["signUpButton"]} if sign_in_modal.get("signUpButton") else {}),
    }


def build_verification_modal_config(verification_modal: JsonDict) -> JsonDict:
    return {
        **({"title": verification_modal["title"]} if verification_modal.get("title") else {}),
        **({"subtitle": verification_modal["subtitle"]} if verification_modal.get("subtitle") else {}),
    }


def is_instant_anonymous_method(methods_array: List[JsonDict]) -> bool:
    return any(
        isinstance(item, dict) and item.get("method") == "anonymous" and item.get("type") == "instant"
        for item in methods_array
    )


def snake_case_auth_order(value: JsonDict) -> JsonDict:
    if not isinstance(value, dict):
        return value
    result = {}
    for key, item in value.items():
        snake_key = "auto_prompt" if key == "autoPrompt" else key
        result[snake_key] = snake_case_auth_order(item) if isinstance(item, dict) else item
    return result

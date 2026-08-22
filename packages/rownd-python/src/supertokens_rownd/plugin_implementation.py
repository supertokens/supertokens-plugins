from __future__ import annotations

import asyncio
import time
import uuid
import re
from contextlib import suppress
from datetime import datetime, timezone
from hashlib import sha256
from types import SimpleNamespace
from typing import Any, Awaitable, Callable, Dict, List, NoReturn, Optional, Tuple, Union, cast
from urllib.parse import parse_qsl, quote, urlencode, urljoin, urlparse, urlunparse

import httpx
from supertokens_python import SupertokensConfig, is_recipe_initialized
from supertokens_python.asyncio import (
    create_user_id_mapping,
    delete_user,
    get_user,
    get_user_id_mapping,
    list_users_by_account_info,
)
from supertokens_python.framework.request import BaseRequest
from supertokens_python.framework.response import BaseResponse
from supertokens_python.recipe.accountlinking import asyncio as accountlinking_asyncio
from supertokens_python.recipe.accountlinking.interfaces import (
    CreatePrimaryUserOkResult,
    CreatePrimaryUserRecipeUserIdAlreadyLinkedError,
    LinkAccountsOkResult,
    LinkAccountsRecipeUserIdAlreadyLinkedError,
)
from supertokens_python.recipe.accountlinking.types import AccountInfoWithRecipeId
from supertokens_python.recipe.emailverification import asyncio as emailverification_asyncio
from supertokens_python.recipe.multitenancy import asyncio as multitenancy_asyncio
from supertokens_python.recipe.passwordless import asyncio as passwordless_asyncio
from supertokens_python.recipe.session import SessionContainer
from supertokens_python.recipe.session import asyncio as session_asyncio
from supertokens_python.recipe.thirdparty import asyncio as thirdparty_asyncio
from supertokens_python.recipe.thirdparty.interfaces import ManuallyCreateOrUpdateUserOkResult
from supertokens_python.recipe.thirdparty.types import ThirdPartyInfo
from supertokens_python.recipe.usermetadata import asyncio as usermetadata_asyncio
from supertokens_python.types import LoginMethod, RecipeUserId, User
from supertokens_python.types.base import AccountInfoInput, UserContext
from supertokens_python.interfaces import CreateUserIdMappingOkResult, GetUserIdMappingOkResult

from .constants import (
    BUILTIN_SIGN_IN_METHOD_KEYS,
    DEFAULT_ROWND_SCHEMA,
    GUEST_AUTH_METHOD_ID,
    IDENTITY_USER_DATA_FIELDS,
    INSTANT_AUTH_METHOD_ID,
    INTERNAL_METADATA_FIELDS,
    NATIVE_EMAIL_VERIFICATION_UPGRADE_REQUIRED_MESSAGE,
    PENDING_EMAIL_VERIFICATION_QUERY_PARAM,
    PUBLIC_TENANT_ID,
    PASSWORDLESS_BYPASS_DEVICE_CONFIRMATION_PARAM,
    ROWND_OAUTH_LOGIN_CHALLENGE_PARAM,
    ROWND_JWT_CLAIMS,
)
from .telemetry import record_error, record_success
from .types import (
    JsonDict,
    RowndClientProtocol,
    RowndEmailChangeError,
    RowndPluginConfig,
    RowndPluginError,
    RowndTelemetryClient,
)


_active_config: Optional[RowndPluginConfig] = None
SUPERTOKENS_FAKE_EMAIL_DOMAIN = "stfakeemail.supertokens.com"
_PENDING_EMAIL_VERIFICATION_USER_CONTEXT_KEY = "_rowndPendingEmailVerificationId"
_LINKED_OPERATIONAL_METADATA_FIELDS = {
    "rownd_email_recipe_user_id",
    "rownd_email_recipe_user_ids",
    "rownd_migration_complete",
    "rownd_pending_verification",
}


class _DerivedUserContext(dict[str, Any]):
    def __init__(self, parent: UserContext, values: Dict[str, Any]):
        if not isinstance(parent, dict) or "_default" in values:
            raise TypeError("Unable to safely derive SuperTokens user context")
        default_context = parent.get("_default")
        if default_context is None and "_default" not in parent:
            default_context = {}
            parent["_default"] = default_context
        if not isinstance(default_context, dict):
            raise TypeError("SuperTokens user context _default must be a dict")
        self._default_context = default_context
        super().__init__((key, value) for key, value in parent.items() if key != "_default")
        super().update(values)
        super().__setitem__("_default", default_context)

    def __setitem__(self, key: str, value: Any) -> None:
        if key == "_default":
            if not isinstance(value, dict):
                raise TypeError("SuperTokens user context _default replacement must be a dict")
            if value is not self._default_context:
                replacement = dict(value)
                self._default_context.clear()
                self._default_context.update(replacement)
            return
        super().__setitem__(key, value)

    def __delitem__(self, key: str) -> None:
        if key == "_default":
            raise TypeError("SuperTokens user context _default cannot be removed")
        super().__delitem__(key)

    def setdefault(self, key: str, default: Any = None) -> Any:
        if key == "_default":
            return self._default_context
        return super().setdefault(key, default)

    def update(self, *args: Any, **kwargs: Any) -> None:
        for key, value in dict(*args, **kwargs).items():
            self[key] = value

    def pop(self, key: str, *default: Any) -> Any:
        if len(default) > 1:
            raise TypeError("pop expected at most 2 arguments")
        if key == "_default":
            raise TypeError("SuperTokens user context _default cannot be removed")
        return super().pop(key, *default)

    def popitem(self) -> Tuple[str, Any]:
        for key in reversed(self):
            if key != "_default":
                return key, super().pop(key)
        raise TypeError("SuperTokens user context _default cannot be removed")

    def clear(self) -> None:
        super().clear()
        super().__setitem__("_default", self._default_context)

    def __ior__(self, values: Any):
        self.update(values)
        return self


def create_derived_user_context(user_context: UserContext, values: Dict[str, Any]) -> UserContext:
    return _DerivedUserContext(user_context, values)


def set_active_rownd_config(config: RowndPluginConfig) -> None:
    global _active_config
    _active_config = config


def get_active_rownd_config() -> RowndPluginConfig:
    if _active_config is None:
        raise RowndPluginError("Rownd plugin config is not initialized")
    return _active_config


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


def resolve_tenant_id(request: BaseRequest) -> str:
    return request.get_query_param("tenantId") or PUBLIC_TENANT_ID


def get_requested_display_context_from_request(request: BaseRequest) -> Optional[str]:
    value = request.get_query_param("rownd_display_context")
    return value if value in {"browser", "mobile_app", "customer_web_view"} else None


def get_requested_client_domain_from_request(request: BaseRequest) -> Optional[str]:
    value = request.get_query_param("rownd_client_domain")
    return value if isinstance(value, str) and value else None


def get_requested_redirect_to_path_from_request(request: BaseRequest) -> Optional[str]:
    return request.get_query_param("rownd_redirect_to_path") or None


def get_requested_oauth_login_challenge_from_request(request: BaseRequest) -> Optional[str]:
    value = request.get_query_param(ROWND_OAUTH_LOGIN_CHALLENGE_PARAM)
    return value if isinstance(value, str) and value else None


def assert_app_variant_is_configured(
    config: RowndPluginConfig, app_variant_id: Optional[str]
) -> None:
    if app_variant_id and config.sub_brands and app_variant_id not in config.sub_brands:
        raise RowndPluginError("Unknown Rownd app variant: %s" % app_variant_id)


def is_email_sign_in_enabled(
    config: RowndPluginConfig, app_variant_id: Optional[str] = None
) -> bool:
    variant = config.sub_brands.get(app_variant_id, {}) if app_variant_id else {}
    methods = (
        variant.get("signInMethods")
        if isinstance(variant.get("signInMethods"), list)
        else config.app_config.get("signInMethods")
    )
    return isinstance(methods, list) and any(
        isinstance(method, dict) and method.get("method") == "email" for method in methods
    )


def rewrite_link_path(
    input_url: Optional[str], target_path: str, search_params: Dict[str, str]
) -> Optional[str]:
    if not input_url:
        return input_url
    parsed = urlparse(input_url)
    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    query.update(search_params)
    if parsed.scheme and parsed.netloc:
        return urlunparse(
            parsed._replace(path="/" + target_path.lstrip("/"), query=urlencode(query))
        )
    path = parsed.path.replace("auth/verify", target_path)
    return urlunparse(parsed._replace(path=path, query=urlencode(query)))


def rewrite_link_to_base_url(
    input_url: Optional[str], target_path: str, base_url: str, search_params: Dict[str, str]
) -> Optional[str]:
    if not input_url:
        return input_url

    normalized_base_url = base_url if base_url.endswith("://") else base_url.rstrip("/") + "/"
    target = urlparse(normalized_base_url + target_path.lstrip("/"))
    source = urlparse(input_url)
    query = dict(parse_qsl(source.query, keep_blank_values=True))
    query.update(search_params)
    return urlunparse(
        target._replace(
            query=urlencode(query),
            fragment=source.fragment,
        )
    )


def normalize_client_domain(value: str) -> str:
    if value.endswith("://"):
        return value

    parsed = urlparse(value)
    if parsed.scheme in {"http", "https"}:
        if not parsed.netloc:
            raise RowndPluginError("Invalid clientDomain")
        return "%s://%s" % (parsed.scheme, parsed.netloc)
    if parsed.scheme:
        return "%s://%s" % (parsed.scheme, parsed.netloc)
    raise RowndPluginError("Invalid clientDomain")


def resolve_client_domain(
    config: RowndPluginConfig,
    website_domain: Optional[str],
    client_domain: Optional[str],
) -> str:
    if not client_domain:
        if not website_domain:
            raise RowndPluginError("website_domain is required when clientDomain is omitted")
        return website_domain

    resolved = config.client_domains.get(client_domain)
    if not resolved:
        raise RowndPluginError("Unknown clientDomain key: %s" % client_domain)
    return resolved


def resolve_allowed_client_domain(
    config: RowndPluginConfig,
    website_domain: Optional[str],
    client_domain: Optional[str],
) -> str:
    resolved = resolve_client_domain(config, website_domain, client_domain)
    normalized = normalize_client_domain(resolved)
    allowed = [normalize_client_domain(value) for value in config.client_domains.values()]
    if website_domain:
        allowed.insert(0, normalize_client_domain(website_domain))
    if normalized not in allowed:
        raise RowndPluginError("clientDomain is not allowed: %s" % resolved)
    return normalized


def normalize_redirect_to_path_for_client_domain(
    redirect_to_path: Optional[str],
    client_domain: str,
) -> Optional[str]:
    if not redirect_to_path:
        return None
    if redirect_to_path == "NATIVE_APP":
        return redirect_to_path
    if redirect_to_path.startswith("//"):
        raise RowndPluginError("redirectToPath cannot be schemaless")

    normalized_client_domain = normalize_client_domain(client_domain)
    base_url = (
        "http://localhost" if normalized_client_domain.endswith("://") else normalized_client_domain
    )
    redirect_url = urlparse(urljoin(base_url.rstrip("/") + "/", redirect_to_path))
    has_explicit_scheme = re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", redirect_to_path) is not None

    if has_explicit_scheme:
        if redirect_url.scheme not in {"http", "https"}:
            raise RowndPluginError("redirectToPath must be http(s) or relative")
        redirect_origin = "%s://%s" % (redirect_url.scheme, redirect_url.netloc)
        if redirect_origin != normalized_client_domain:
            raise RowndPluginError("redirectToPath must match clientDomain")

    return urlunparse(("", "", redirect_url.path, "", redirect_url.query, redirect_url.fragment))


def assert_allowed_bypass_redirect_path(
    config: RowndPluginConfig,
    redirect_to_path: Optional[str],
) -> None:
    if not redirect_to_path:
        raise RowndPluginError("redirectToPath is required for confirmation bypass magic links")
    bypass_config = config.cross_device_confirmation_bypass or {}
    allowed_redirect_paths = bypass_config.get("allowed_redirect_paths", [])
    if not allowed_redirect_paths:
        raise RowndPluginError(
            "cross_device_confirmation_bypass.allowed_redirect_paths must be configured"
        )
    if redirect_to_path not in allowed_redirect_paths:
        raise RowndPluginError(
            "redirectToPath is not allowed for confirmation bypass: %s" % redirect_to_path
        )


def get_magic_link_bootstrap_params(
    config: RowndPluginConfig,
    app_variant_id: Optional[str] = None,
    display_context: Optional[str] = None,
    redirect_to_path: Optional[str] = None,
    client_domain_key: Optional[str] = None,
    oauth_login_challenge: Optional[str] = None,
) -> Dict[str, str]:
    params = {
        "appKey": config.rownd_app_key or "migration-disabled",
        "apiBasePath": config.api_base_path,
    }
    if config.api_domain:
        params["apiDomain"] = config.api_domain
    if app_variant_id:
        params["appVariantId"] = app_variant_id
    if display_context:
        params["displayContext"] = display_context
    if redirect_to_path:
        params["redirectToPath"] = redirect_to_path
    if client_domain_key:
        params["clientDomain"] = client_domain_key
    if oauth_login_challenge:
        params["oauthLoginChallenge"] = oauth_login_challenge
    return params


def optional_string(value: object) -> Optional[str]:
    return value if isinstance(value, str) else None


def rewrite_magic_link(
    magic_link: str,
    client_domain: str,
    bootstrap_params: Dict[str, str],
) -> str:
    rewritten = rewrite_link_to_base_url(
        magic_link,
        "account/login",
        client_domain,
        bootstrap_params,
    )
    if rewritten is None:
        raise RowndPluginError("Failed to rewrite magic link")
    return rewritten


async def create_magic_link_with_confirmation_bypass(
    email: Optional[str] = None,
    phone_number: Optional[str] = None,
    tenant_id: str = PUBLIC_TENANT_ID,
    session: Optional[SessionContainer] = None,
    user_context: Optional[UserContext] = None,
    redirect_to_path: Optional[str] = None,
    client_domain: Optional[str] = None,
    display_context: Optional[str] = None,
    app_variant_id: Optional[str] = None,
) -> str:
    has_email = isinstance(email, str) and len(email) > 0
    has_phone_number = isinstance(phone_number, str) and len(phone_number) > 0
    if has_email == has_phone_number:
        raise RowndPluginError("Exactly one of email or phone_number is required")

    config = get_active_rownd_config()
    assert_app_variant_is_configured(config, app_variant_id)
    resolved_client_domain = resolve_allowed_client_domain(
        config,
        config.website_domain or None,
        client_domain,
    )
    normalized_redirect_to_path = normalize_redirect_to_path_for_client_domain(
        redirect_to_path,
        resolved_client_domain,
    )
    assert_allowed_bypass_redirect_path(config, normalized_redirect_to_path)

    context = create_derived_user_context(
        user_context if user_context is not None else {},
        {
            "rowndDisplayContext": display_context,
            "rowndRedirectToPath": normalized_redirect_to_path,
            "rowndClientDomain": client_domain,
            "rowndAppVariantId": app_variant_id,
        },
    )
    code_info = await passwordless_asyncio.create_code(
        tenant_id,
        email=email if has_email else None,
        phone_number=phone_number if has_phone_number else None,
        session=session,
        user_context=context,
    )

    website_domain = (config.website_domain or resolved_client_domain).rstrip("/")
    magic_link = "%s%s/verify?preAuthSessionId=%s&tenantId=%s#%s" % (
        website_domain,
        config.api_base_path,
        quote(code_info.pre_auth_session_id, safe=""),
        quote(tenant_id, safe=""),
        quote(code_info.link_code, safe=""),
    )
    rewritten_url = urlparse(
        rewrite_magic_link(
            magic_link,
            resolved_client_domain,
            get_magic_link_bootstrap_params(
                config,
                app_variant_id=app_variant_id,
                display_context=display_context,
                redirect_to_path=normalized_redirect_to_path,
                client_domain_key=client_domain,
                oauth_login_challenge=(
                    context["rowndOAuthLoginChallenge"]
                    if isinstance(context.get("rowndOAuthLoginChallenge"), str)
                    else None
                ),
            ),
        )
    )
    query = dict(parse_qsl(rewritten_url.query, keep_blank_values=True))
    query[PASSWORDLESS_BYPASS_DEVICE_CONFIRMATION_PARAM] = "true"
    return urlunparse(rewritten_url._replace(query=urlencode(query)))


async def handle_validate_passwordless_confirmation_bypass(
    config: RowndPluginConfig,
    request: BaseRequest,
    response: BaseResponse,
) -> BaseResponse:
    try:
        body = await _json_body(request)
        client_domain = optional_string(body.get("clientDomain"))
        redirect_to_path = optional_string(body.get("redirectToPath"))
        app_variant_id = optional_string(body.get("appVariantId"))

        assert_app_variant_is_configured(config, app_variant_id)
        resolved_client_domain = resolve_allowed_client_domain(
            config,
            config.website_domain or None,
            client_domain,
        )
        normalized_redirect_to_path = normalize_redirect_to_path_for_client_domain(
            redirect_to_path,
            resolved_client_domain,
        )
        assert_allowed_bypass_redirect_path(config, normalized_redirect_to_path)
        return json_response(response, {"status": "OK", "bypass": True})
    except Exception as err:
        log_debug(config, "Passwordless confirmation bypass validation failed: %s" % err)
        return json_response(response, {"status": "ERROR", "bypass": False})


def add_hub_bootstrap_params(
    link: Optional[str],
    target_path: str,
    config: RowndPluginConfig,
    user_context: Optional[UserContext],
    user_input_code: Optional[str] = None,
    additional_params: Optional[Dict[str, str]] = None,
) -> Optional[str]:
    if not link:
        return link
    params = {
        "appKey": config.rownd_app_key or "migration-disabled",
        "apiBasePath": config.api_base_path,
    }
    if config.api_domain:
        params["apiDomain"] = config.api_domain

    context = user_context if user_context is not None else {}
    if isinstance(context.get("rowndAppVariantId"), str):
        params["appVariantId"] = context["rowndAppVariantId"]
    if isinstance(context.get("rowndDisplayContext"), str):
        params["displayContext"] = context["rowndDisplayContext"]
    if isinstance(context.get("rowndRedirectToPath"), str):
        params["redirectToPath"] = context["rowndRedirectToPath"]
    if isinstance(context.get("rowndOAuthLoginChallenge"), str):
        params["oauthLoginChallenge"] = context["rowndOAuthLoginChallenge"]
    if user_input_code:
        params["passwordlessFlowType"] = "USER_INPUT_CODE_AND_MAGIC_LINK"
    params.update(additional_params or {})
    client_domain = context.get("rowndClientDomain")
    client_domain_key = (
        client_domain
        if isinstance(client_domain, str)
        else "mobile"
        if context.get("rowndDisplayContext") == "mobile_app"
        else "browser"
    )
    client_base_url = config.client_domains.get(client_domain_key)
    if client_base_url:
        return rewrite_link_to_base_url(link, target_path, client_base_url, params)
    return rewrite_link_path(link, target_path, params)


def get_pending_email_verification_id_from_user_context(
    user_context: UserContext,
) -> Optional[str]:
    value = user_context.get(_PENDING_EMAIL_VERIFICATION_USER_CONTEXT_KEY)
    return value if isinstance(value, str) else None


def add_pending_email_verification_marker(
    email_verify_link: Optional[str], pending_verification_id: str
) -> Optional[str]:
    if not email_verify_link:
        return email_verify_link
    parsed = urlparse(email_verify_link)
    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    if not query.get("token"):
        raise RuntimeError("Pending email verification link has no Core token")
    query[PENDING_EMAIL_VERIFICATION_QUERY_PARAM] = pending_verification_id
    return urlunparse(parsed._replace(query=urlencode(query)))


def build_email_change_user_context(
    user_context: UserContext, payload_context: JsonDict
) -> UserContext:
    context: Dict[str, Any] = {
        "rowndDisplayContext": None,
        "rowndClientDomain": None,
        "rowndNativeEmailVerification": None,
    }
    display_context = payload_context.get("rowndDisplayContext")
    if display_context in {"browser", "mobile_app", "customer_web_view"}:
        context["rowndDisplayContext"] = cast(Any, display_context)
    client_domain = payload_context.get("rowndClientDomain")
    if isinstance(client_domain, str):
        context["rowndClientDomain"] = client_domain
    native_verification = payload_context.get("rowndNativeEmailVerification")
    if isinstance(native_verification, bool):
        context["rowndNativeEmailVerification"] = native_verification
    return create_derived_user_context(user_context, context)


def native_email_verification_upgrade_required(user_context: UserContext) -> bool:
    return (
        user_context.get("rowndDisplayContext") == "mobile_app"
        and user_context.get("rowndNativeEmailVerification") is not True
    )


def native_email_verification_upgrade_required_response() -> JsonDict:
    return {
        "status": "ERROR",
        "code": 426,
        "message": NATIVE_EMAIL_VERIFICATION_UPGRADE_REQUIRED_MESSAGE,
    }


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
    user_context: UserContext,
) -> BaseResponse:
    started_at = time.time()
    tenant_id = resolve_tenant_id(request)
    try:
        body = await _json_body(request)
        app_variant_id = get_requested_app_variant_id_from_request(request)
        assert_app_variant_is_configured(config, app_variant_id)
        auth_level = body.get("auth_level") if isinstance(body, dict) else None
        third_party_id = (
            INSTANT_AUTH_METHOD_ID if auth_level == INSTANT_AUTH_METHOD_ID else GUEST_AUTH_METHOD_ID
        )
        third_party_user_id = (
            "anon_%s" % uuid.uuid4()
            if third_party_id == INSTANT_AUTH_METHOD_ID
            else "guest_%s" % uuid.uuid4()
        )
        effective_auth_level = (
            INSTANT_AUTH_METHOD_ID
            if third_party_id == INSTANT_AUTH_METHOD_ID
            else GUEST_AUTH_METHOD_ID
        )

        result = await thirdparty_asyncio.manually_create_or_update_user(
            tenant_id=tenant_id,
            third_party_id=third_party_id,
            third_party_user_id=third_party_user_id,
            email="%s@anonymous.local" % third_party_user_id,
            is_verified=False,
            user_context=user_context,
        )
        if not isinstance(result, ManuallyCreateOrUpdateUserOkResult):
            raise RowndPluginError("Guest user creation failed")
        payload = {
            **build_rownd_audience({}, config, app_variant_id),
            "auth_level": effective_auth_level,
            "is_anonymous": True,
            "app_user_id": result.user.id,
        }
        operation_context = create_derived_user_context(
            user_context, {"rowndAppVariantId": app_variant_id}
        )
        await record_rownd_app_variant_for_user(
            config, result.user.id, app_variant_id, operation_context
        )
        await session_asyncio.create_new_session(
            request,
            tenant_id,
            result.recipe_user_id,
            payload,
            {},
            operation_context,
        )
        await record_success(telemetry_client, started_at, tenant_id, None, result.user.id)
        return json_response(
            response,
            {"status": "OK", "createdNewRecipeUser": result.created_new_recipe_user},
        )
    except Exception as err:
        log_debug(config, "Guest login failed: %s" % err)
        await record_error(telemetry_client, started_at, err, tenant_id)
        return json_response(response, {"status": "ERROR", "message": "Guest login failed"})


async def handle_migrate(
    config: RowndPluginConfig,
    client: RowndClientProtocol,
    telemetry_client: RowndTelemetryClient,
    supertokens_config: SupertokensConfig,
    request: BaseRequest,
    response: BaseResponse,
    user_context: UserContext,
) -> BaseResponse:
    started_at = time.time()
    tenant_id = resolve_tenant_id(request)
    rownd_user_id = None
    supertokens_user_id = None
    try:
        token = parse_authorization_header(request)
        app_variant_id = get_requested_app_variant_id_from_request(request)
        assert_app_variant_is_configured(config, app_variant_id)
        rownd_user_id = await client.validate_token(token)
        rownd_user = await client.fetch_optional_user_info(rownd_user_id)
        if rownd_user is None:
            log_debug(
                config,
                "Skipping migration because user does not exist in Rownd. tenantId: %s, rowndUserId: %s"
                % (tenant_id, rownd_user_id),
            )
            return json_response(response, {"status": "OK"})

        user = await get_user(rownd_user_id, user_context)
        existing_metadata = await get_user_metadata(user.id, user_context) if user else None
        recipe_user_id = None

        if user is None or (existing_metadata or {}).get("rownd_migration_complete") is not True:
            user_import = map_rownd_user_to_supertokens(
                rownd_user,
                tenant_id if tenant_id != PUBLIC_TENANT_ID else None,
            )
            reconciled = await reconcile_rownd_user_with_existing_login_methods(
                user_import,
                tenant_id,
                user_context,
            )
            if not reconciled:
                if user is not None:
                    raise RuntimeError("Incomplete migrated user could not be reconciled")
                await import_user(user_import, supertokens_config, user_context)
            user = await get_user(rownd_user_id, user_context)
            if user is None:
                raise RowndPluginError("Imported user could not be resolved")
            supertokens_user_id = user.id
            recipe_user_id = user.login_methods[0].recipe_user_id if user.login_methods else None
        else:
            supertokens_user_id = user.id
            recipe_user_id = user.login_methods[0].recipe_user_id if user.login_methods else None

        if isinstance(supertokens_user_id, str):
            await record_rownd_app_variant_for_user(
                config, supertokens_user_id, app_variant_id, user_context
            )
        tenant_login_method = (
            next(
                (
                    method
                    for method in user.login_methods
                    if tenant_id in (getattr(method, "tenant_ids", None) or [])
                ),
                None,
            )
            if user
            else None
        )
        if tenant_login_method is not None:
            recipe_user_id = tenant_login_method.recipe_user_id
        if recipe_user_id is None:
            raise RowndPluginError("User not found or has no login methods")

        if user is not None:
            await associate_user_login_methods_to_tenant(user, tenant_id, user_context)

        await sync_imported_email_verification_state(
            recipe_user_id,
            supertokens_user_id if isinstance(supertokens_user_id, str) else None,
            tenant_id,
            user_context,
        )

        await session_asyncio.create_new_session(
            request,
            tenant_id,
            recipe_user_id,
            await build_rownd_session_claims(
                config,
                supertokens_user_id
                if isinstance(supertokens_user_id, str)
                else recipe_user_id.get_as_string(),
                {},
                app_variant_id,
                user_context,
            ),
            {},
            create_derived_user_context(user_context, {"rowndAppVariantId": app_variant_id}),
        )
        await record_success(
            telemetry_client,
            started_at,
            tenant_id,
            rownd_user_id,
            supertokens_user_id if isinstance(supertokens_user_id, str) else None,
        )
        return json_response(response, {"status": "OK"})
    except Exception as err:
        log_debug(config, "Migration failed for Rownd user %s: %s" % (rownd_user_id, err))
        await record_error(
            telemetry_client,
            started_at,
            err,
            tenant_id,
            rownd_user_id,
            supertokens_user_id if isinstance(supertokens_user_id, str) else None,
        )
        return json_response(
            response,
            {
                "status": "ERROR",
                "message": str(err) if isinstance(err, RowndPluginError) else "Migration failed",
            },
        )


def clear_supertokens_core_call_cache(user_context: UserContext) -> None:
    default_context = user_context.get("_default") if isinstance(user_context, dict) else None
    if not isinstance(default_context, dict):
        return
    if isinstance(default_context.get("coreCallCache"), dict):
        default_context["coreCallCache"] = {}
    if isinstance(default_context.get("core_call_cache"), dict):
        default_context["core_call_cache"] = {}


async def associate_user_login_methods_to_tenant(
    user: User, tenant_id: str, user_context: UserContext
) -> None:
    for login_method in user.login_methods:
        if tenant_id in login_method.tenant_ids:
            continue
        association = await multitenancy_asyncio.associate_user_to_tenant(
            tenant_id,
            login_method.recipe_user_id,
            user_context,
        )
        if getattr(association, "status", None) != "OK":
            raise RuntimeError(
                "Failed to associate migrated user with tenant: %s"
                % getattr(association, "status", "ERROR")
            )


async def handle_signout(
    session: Optional[SessionContainer], response: BaseResponse, user_context: UserContext
) -> BaseResponse:
    session = require_session(session)
    await session_asyncio.revoke_all_sessions_for_user(
        session.get_user_id(user_context),
        revoke_sessions_for_linked_accounts=True,
        tenant_id=session.get_tenant_id(user_context),
        user_context=user_context,
    )
    return json_response(response, {"status": "OK"})


async def handle_get_user(
    config: RowndPluginConfig,
    session: Optional[SessionContainer],
    response: BaseResponse,
    user_context: UserContext,
) -> BaseResponse:
    session = require_session(session)
    return json_response(
        response,
        {
            "status": "OK",
            **(
                await get_rownd_compat_user(
                    session.get_user_id(user_context),
                    config,
                    session.get_tenant_id(user_context),
                    user_context=user_context,
                )
            ),
        },
    )


async def handle_update_user(
    config: RowndPluginConfig,
    request: BaseRequest,
    response: BaseResponse,
    session: Optional[SessionContainer],
    user_context: UserContext,
) -> BaseResponse:
    session = require_session(session)
    app_variant_id = get_requested_app_variant_id_from_request(request)
    assert_app_variant_is_configured(config, app_variant_id)
    body = await _json_body(request)
    data = as_json_dict(body.get("data"))
    context = as_json_dict(body.get("context"))
    has_email_field = "email" in data
    email = data.get("email")
    if has_email_field and (not isinstance(email, str) or not email.strip()):
        return json_response(
            response,
            {"status": "ERROR", "code": 400, "message": "email must be a non-empty string"},
            400,
        )
    data_without_email = {key: value for key, value in data.items() if key != "email"}
    permission_error = validate_writable_fields(config, list(data_without_email.keys()))
    if permission_error:
        code = permission_error.get("code")
        return json_response(response, permission_error, code if isinstance(code, int) else 400)
    if isinstance(email, str):
        current_email = as_json_dict(
            (
                await get_rownd_compat_user(
                    session.get_user_id(user_context),
                    config,
                    session.get_tenant_id(user_context),
                    user_context=user_context,
                )
            ).get("data")
        ).get("email")
        changes_email = not isinstance(current_email, str) or normalize_email(
            current_email
        ) != normalize_email(email)
        request_context = build_email_change_user_context(user_context, context)
        if app_variant_id:
            request_context["rowndAppVariantId"] = app_variant_id
        if changes_email:
            if native_email_verification_upgrade_required(request_context):
                upgrade = native_email_verification_upgrade_required_response()
                return json_response(response, upgrade, 426)
            session_error = await validate_email_change_session(
                config, session, app_variant_id, request_context
            )
            if session_error:
                return json_response(response, session_error, cast(int, session_error["code"]))
        try:
            pending_result = await start_pending_email_verification(
                config, session, email, request_context
            )
            update_result = (
                await update_user_data(
                    config,
                    session.get_user_id(user_context),
                    data_without_email,
                    session.get_tenant_id(user_context),
                    user_context,
                )
                if data_without_email
                else pending_result
            )
            return json_response(
                response,
                {
                    "status": "OK",
                    **update_result,
                    "email_verification_pending": changes_email,
                },
            )
        except RowndEmailChangeError as error:
            return json_response(
                response,
                {"status": "ERROR", "code": error.http_status, "message": str(error)},
                error.http_status,
            )
    if data_without_email:
        await update_user_data(
            config,
            session.get_user_id(user_context),
            data_without_email,
            session.get_tenant_id(user_context),
            user_context,
        )
    return json_response(
        response,
        {
            "status": "OK",
            **(
                await get_rownd_compat_user(
                    session.get_user_id(user_context),
                    config,
                    session.get_tenant_id(user_context),
                    user_context=user_context,
                )
            ),
        },
    )


async def handle_delete_user(
    session: Optional[SessionContainer], response: BaseResponse, user_context: UserContext
) -> BaseResponse:
    session = require_session(session)
    await delete_user(
        session.get_user_id(user_context),
        remove_all_linked_accounts=True,
        user_context=user_context,
    )
    return json_response(response, {"status": "OK"})


async def handle_get_user_meta(
    session: Optional[SessionContainer], response: BaseResponse, user_context: UserContext
) -> BaseResponse:
    session = require_session(session)
    user_id = session.get_user_id(user_context)
    metadata = await get_user_metadata(user_id, user_context)
    return json_response(
        response, {"status": "OK", "id": user_id, "meta": public_metadata(metadata)}
    )


async def handle_update_user_meta(
    request: BaseRequest,
    response: BaseResponse,
    session: Optional[SessionContainer],
    user_context: UserContext,
) -> BaseResponse:
    session = require_session(session)
    body = await _json_body(request)
    meta = as_json_dict(body.get("meta"))
    internal_field = next((key for key in meta if is_internal_metadata_field(key)), None)
    if internal_field:
        return json_response(
            response,
            {
                "status": "ERROR",
                "code": 403,
                "message": "field is not writable: %s" % internal_field,
            },
            403,
        )
    updated = await update_user_metadata(session.get_user_id(user_context), meta, user_context)
    return json_response(response, {"status": "OK", **updated})


async def handle_get_user_field(
    config: RowndPluginConfig,
    request: BaseRequest,
    response: BaseResponse,
    session: Optional[SessionContainer],
    user_context: UserContext,
) -> BaseResponse:
    session = require_session(session)
    field_name = request.get_query_param("field")
    if not field_name:
        return json_response(response, missing_field_response(), 400)
    user = await get_rownd_compat_user(
        session.get_user_id(user_context),
        config,
        session.get_tenant_id(user_context),
        user_context=user_context,
    )
    return json_response(
        response, {"status": "OK", "value": as_json_dict(user.get("data")).get(field_name)}
    )


async def handle_update_user_field(
    config: RowndPluginConfig,
    request: BaseRequest,
    response: BaseResponse,
    session: Optional[SessionContainer],
    user_context: UserContext,
) -> BaseResponse:
    session = require_session(session)
    field_name = request.get_query_param("field")
    if not field_name:
        return json_response(response, missing_field_response(), 400)
    app_variant_id = get_requested_app_variant_id_from_request(request)
    assert_app_variant_is_configured(config, app_variant_id)
    body = await _json_body(request)
    value = body.get("value")
    if field_name == "email":
        if not isinstance(value, str) or not value.strip():
            return json_response(
                response,
                {"status": "ERROR", "code": 400, "message": "email must be a non-empty string"},
                400,
            )
        current_email = as_json_dict(
            (
                await get_rownd_compat_user(
                    session.get_user_id(user_context),
                    config,
                    session.get_tenant_id(user_context),
                    user_context=user_context,
                )
            ).get("data")
        ).get("email")
        changes_email = not isinstance(current_email, str) or normalize_email(
            current_email
        ) != normalize_email(value)
        context = build_email_change_user_context(user_context, as_json_dict(body.get("context")))
        if app_variant_id:
            context["rowndAppVariantId"] = app_variant_id
        if changes_email:
            if native_email_verification_upgrade_required(context):
                upgrade = native_email_verification_upgrade_required_response()
                return json_response(response, upgrade, 426)
            session_error = await validate_email_change_session(
                config, session, app_variant_id, context
            )
            if session_error:
                return json_response(response, session_error, cast(int, session_error["code"]))
        try:
            return json_response(
                response,
                {
                    "status": "OK",
                    **(await start_pending_email_verification(config, session, value, context)),
                    "email_verification_pending": changes_email,
                },
            )
        except RowndEmailChangeError as error:
            return json_response(
                response,
                {"status": "ERROR", "code": error.http_status, "message": str(error)},
                error.http_status,
            )
    permission_error = validate_writable_fields(config, [field_name])
    if permission_error:
        code = permission_error.get("code")
        return json_response(response, permission_error, code if isinstance(code, int) else 400)
    return json_response(
        response,
        {
            "status": "OK",
            **(
                await update_user_data(
                    config,
                    session.get_user_id(user_context),
                    {field_name: body.get("value")},
                    session.get_tenant_id(user_context),
                    user_context,
                )
            ),
        },
    )


def require_session(session: Optional[SessionContainer]) -> SessionContainer:
    if session is None:
        raise RowndPluginError("Session not found")
    return session


async def validate_email_change_session(
    config: RowndPluginConfig,
    session: SessionContainer,
    app_variant_id: Optional[str],
    user_context: UserContext,
) -> Optional[JsonDict]:
    if not is_email_sign_in_enabled(config, app_variant_id):
        return {"status": "ERROR", "code": 403, "message": "email sign-in is not enabled"}
    if not is_recipe_initialized("passwordless") or not is_recipe_initialized("emailverification"):
        return {"status": "ERROR", "code": 503, "message": "email sign-in is not available"}
    session_age_ms = time.time() * 1000 - await session.get_time_created(user_context)
    max_session_age = config.email_change.get("max_session_age_seconds", 600)
    if session_age_ms > cast(float, max_session_age) * 1000:
        return recent_authentication_required_response()
    return None


def recent_authentication_required_response() -> JsonDict:
    return {
        "status": "ERROR",
        "code": 403,
        "message": "recent authentication is required to change email",
    }


async def _json_body(request: BaseRequest) -> JsonDict:
    return as_json_dict(await request.json())


def as_json_dict(value: object) -> JsonDict:
    return cast(JsonDict, value) if isinstance(value, dict) else {}


def as_json_list(value: object) -> List[JsonDict]:
    return (
        [cast(JsonDict, item) for item in value if isinstance(item, dict)]
        if isinstance(value, list)
        else []
    )


async def get_raw_user_metadata(
    user_id: str, user_context: Optional[UserContext] = None
) -> JsonDict:
    result = await usermetadata_asyncio.get_user_metadata(user_id, user_context)
    return result.metadata or {}


def get_original_rownd_user_id(metadata: JsonDict) -> Optional[str]:
    user_id = as_json_dict(as_json_dict(metadata.get("original_rownd_user")).get("data")).get(
        "user_id"
    )
    return user_id if isinstance(user_id, str) else None


def merge_missing_values(primary: JsonDict, secondary: JsonDict) -> JsonDict:
    merged = {**primary}
    for key, secondary_value in secondary.items():
        if key not in merged:
            merged[key] = secondary_value
        elif isinstance(merged[key], dict) and isinstance(secondary_value, dict):
            merged[key] = merge_missing_values(
                cast(JsonDict, merged[key]), cast(JsonDict, secondary_value)
            )
    return merged


def combine_linked_metadata(
    primary_user_id: str,
    primary_metadata: JsonDict,
    linked_metadata: List[Tuple[str, JsonDict]],
    mapped_rownd_user_id: Optional[str] = None,
) -> JsonDict:
    ordered = sorted(
        linked_metadata,
        key=lambda item: (
            not (
                mapped_rownd_user_id is not None
                and get_original_rownd_user_id(item[1]) == mapped_rownd_user_id
            ),
            item[0],
        ),
    )
    primary_rownd_user_id = get_original_rownd_user_id(primary_metadata)
    canonical_linked_metadata = (
        next(
            (
                item
                for item in ordered
                if get_original_rownd_user_id(item[1]) == mapped_rownd_user_id
            ),
            None,
        )
        if mapped_rownd_user_id is not None
        else None
    )
    canonical_replaces_primary = (
        canonical_linked_metadata is not None and primary_rownd_user_id != mapped_rownd_user_id
    )
    metadata_update: JsonDict = (
        {"original_rownd_user": canonical_linked_metadata[1]["original_rownd_user"]}
        if canonical_replaces_primary and canonical_linked_metadata is not None
        else {}
    )
    for _, metadata in ordered:
        for key, value in metadata.items():
            if key in _LINKED_OPERATIONAL_METADATA_FIELDS:
                continue
            if (
                key == "original_rownd_user"
                and mapped_rownd_user_id is not None
                and (
                    primary_rownd_user_id == mapped_rownd_user_id
                    or canonical_linked_metadata is not None
                )
                and get_original_rownd_user_id(metadata) != mapped_rownd_user_id
            ):
                continue
            current = metadata_update[key] if key in metadata_update else primary_metadata.get(key)
            if key not in metadata_update and key not in primary_metadata:
                metadata_update[key] = value
            elif isinstance(current, dict) and isinstance(value, dict):
                merged = merge_missing_values(cast(JsonDict, current), cast(JsonDict, value))
                if merged != current:
                    metadata_update[key] = merged

    primary_is_source = primary_rownd_user_id is not None and (
        mapped_rownd_user_id is None
        or primary_rownd_user_id == mapped_rownd_user_id
        or canonical_linked_metadata is None
    )
    source_user_id = (
        primary_user_id
        if primary_is_source
        else (
            canonical_linked_metadata[0]
            if canonical_linked_metadata is not None
            else next(
                (
                    linked_user_id
                    for linked_user_id, metadata in ordered
                    if get_original_rownd_user_id(metadata) is not None
                ),
                None,
            )
        )
    )
    return {
        "primary_user_id": primary_user_id,
        "linked_user_ids": [linked_user_id for linked_user_id, _ in ordered],
        "primary_metadata": primary_metadata,
        "combined_metadata": {**primary_metadata, **metadata_update},
        "metadata_update": metadata_update,
        "rownd_metadata_source_user_id": source_user_id,
    }


async def get_primary_user_mapping(
    user_id: str, user_context: Optional[UserContext] = None
) -> Optional[GetUserIdMappingOkResult]:
    context = user_context if user_context is not None else {}
    internal = await get_user_id_mapping(user_id, "SUPERTOKENS", context)
    if isinstance(internal, GetUserIdMappingOkResult):
        return internal
    external = await get_user_id_mapping(user_id, "EXTERNAL", context)
    return external if isinstance(external, GetUserIdMappingOkResult) else None


async def inspect_linked_user_metadata(
    user_id: str,
    user_context: Optional[UserContext] = None,
    user_override: Optional[User] = None,
) -> Dict[str, Any]:
    user = user_override if user_override is not None else await get_user(user_id, user_context)
    if user is None:
        metadata = await get_raw_user_metadata(user_id, user_context)
        return {**combine_linked_metadata(user_id, metadata, []), "user": None}

    mapping = await get_primary_user_mapping(user.id, user_context)
    primary_user_id = mapping.supertokens_user_id if mapping else user.id
    linked_user_ids = sorted(
        {
            method.recipe_user_id.get_as_string()
            for method in user.login_methods
            if method.recipe_user_id.get_as_string() != primary_user_id
        }
    )
    metadata_results = await asyncio.gather(
        get_raw_user_metadata(primary_user_id, user_context),
        *(
            get_raw_user_metadata(linked_user_id, user_context)
            for linked_user_id in linked_user_ids
        ),
    )
    return {
        **combine_linked_metadata(
            primary_user_id,
            metadata_results[0],
            list(zip(linked_user_ids, metadata_results[1:])),
            mapping.external_user_id if mapping else None,
        ),
        "user": user,
    }


async def get_user_metadata(user_id: str, user_context: Optional[UserContext] = None) -> JsonDict:
    inspection = await inspect_linked_user_metadata(user_id, user_context)
    return cast(JsonDict, inspection["combined_metadata"])


async def update_primary_user_metadata(
    user_id: str,
    metadata_update: JsonDict,
    user_context: Optional[UserContext] = None,
) -> Tuple[str, JsonDict]:
    user = await get_user(user_id, user_context)
    mapping = await get_primary_user_mapping(user.id, user_context) if user else None
    primary_user_id = mapping.supertokens_user_id if mapping else user.id if user else user_id
    result = await usermetadata_asyncio.update_user_metadata(
        primary_user_id, metadata_update, user_context
    )
    return primary_user_id, result.metadata or {}


async def replace_primary_user_metadata(
    user_id: str,
    metadata: JsonDict,
    user_context: Optional[UserContext] = None,
) -> None:
    mapping = await get_primary_user_mapping(user_id, user_context)
    primary_user_id = mapping.supertokens_user_id if mapping else user_id
    await usermetadata_asyncio.clear_user_metadata(primary_user_id, user_context)
    if metadata:
        await usermetadata_asyncio.update_user_metadata(primary_user_id, metadata, user_context)


async def update_user_metadata(
    user_id: str, input_meta: JsonDict, user_context: Optional[UserContext] = None
) -> JsonDict:
    primary_user_id, updated = await update_primary_user_metadata(user_id, input_meta, user_context)
    return {"id": primary_user_id, "meta": public_metadata(updated)}


async def update_user_data(
    config: RowndPluginConfig,
    user_id: str,
    input_data: JsonDict,
    tenant_id: str = PUBLIC_TENANT_ID,
    user_context: Optional[UserContext] = None,
) -> JsonDict:
    primary_user_id, _ = await update_primary_user_metadata(user_id, input_data, user_context)
    return await get_rownd_compat_user(
        primary_user_id, config, tenant_id, user_context=user_context
    )


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


async def get_rownd_compat_user(
    user_id: str,
    config: Optional[RowndPluginConfig] = None,
    tenant_id: str = PUBLIC_TENANT_ID,
    metadata_override: Optional[JsonDict] = None,
    user_override: Optional[User] = None,
    user_context: Optional[UserContext] = None,
) -> JsonDict:
    inspection = (
        None
        if metadata_override is not None and user_override is not None
        else await inspect_linked_user_metadata(user_id, user_context, user_override)
    )
    metadata = (
        metadata_override
        if metadata_override is not None
        else cast(JsonDict, cast(JsonDict, inspection)["combined_metadata"])
    )
    st_user = (
        user_override
        if user_override is not None
        else cast(Optional[User], cast(JsonDict, inspection)["user"])
    )
    if st_user is None:
        raise RowndPluginError("User not found in Rownd")

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
    latest_session_info = await get_latest_session_info(st_user.id, tenant_id, user_context)
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


def iso_from_ms(value: int) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(value / 1000))


async def get_latest_session_info(
    user_id: str,
    tenant_id: str = PUBLIC_TENANT_ID,
    user_context: Optional[UserContext] = None,
):
    try:
        handles = await session_asyncio.get_all_session_handles_for_user(
            user_id,
            fetch_sessions_for_linked_accounts=True,
            tenant_id=tenant_id,
            user_context=user_context,
        )
    except Exception:
        return None
    latest = None
    for handle in handles:
        session_info = await session_asyncio.get_session_information(handle, user_context)
        if session_info is not None and (
            latest is None or session_info.time_created > latest.time_created
        ):
            latest = session_info
    return latest


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
        method.recipe_id == "thirdparty" and get_third_party_info(method)[0] == GUEST_AUTH_METHOD_ID
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


async def build_rownd_session_claims(
    config: RowndPluginConfig,
    user_id: str,
    current_payload: JsonDict,
    app_variant_id: Optional[str],
    user_context: Optional[UserContext] = None,
) -> JsonDict:
    inspection = await inspect_linked_user_metadata(user_id, user_context)
    user = cast(Optional[User], inspection["user"])
    metadata = cast(JsonDict, inspection["combined_metadata"]) if user else {}
    return build_rownd_session_claim_payload(
        config, user_id, user, metadata, current_payload, app_variant_id
    )


def build_rownd_session_claim_payload(
    config: RowndPluginConfig,
    user_id: str,
    user: Optional[User],
    metadata: JsonDict,
    current_payload: JsonDict,
    app_variant_id: Optional[str],
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
    is_anonymous = auth_level in {
        GUEST_AUTH_METHOD_ID,
        INSTANT_AUTH_METHOD_ID,
    }
    anonymous_id = get_anonymous_id(user_id, user, metadata, current_payload) if user else None
    claims = {
        **build_rownd_audience(current_payload, config, app_variant_id),
        **build_configured_session_claims(config, metadata),
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


async def build_rownd_session_and_anonymous_claims(
    config: RowndPluginConfig,
    user_id: str,
    current_payload: JsonDict,
    app_variant_id: Optional[str],
    user_context: UserContext,
) -> Tuple[JsonDict, JsonDict]:
    inspection = await inspect_linked_user_metadata(user_id, user_context)
    user = cast(Optional[User], inspection["user"])
    metadata = cast(JsonDict, inspection["combined_metadata"]) if user else {}
    rownd_claims = build_rownd_session_claim_payload(
        config, user_id, user, metadata, current_payload, app_variant_id
    )
    is_anonymous = get_effective_auth_level(user) in {
        GUEST_AUTH_METHOD_ID,
        INSTANT_AUTH_METHOD_ID,
    }
    from supertokens_python.utils import get_timestamp_ms

    return rownd_claims, {"is_anonymous": {"v": is_anonymous, "t": get_timestamp_ms()}}


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


async def build_rownd_oauth_payload(
    config: RowndPluginConfig,
    user: Optional[User],
    scopes: List[str],
    current_payload: Optional[JsonDict],
    user_context: UserContext,
) -> JsonDict:
    payload = current_payload or {}
    metadata = (
        cast(
            JsonDict,
            (await inspect_linked_user_metadata(user.id, user_context, user))["combined_metadata"],
        )
        if user
        else {}
    )
    rownd_audience = get_rownd_oauth_audience(
        requested_audience=first_string(user_context.get("rowndOAuthAudience"))
    )
    return {
        **payload,
        **(build_standard_oauth_claims(user, scopes, metadata) if user else {}),
        **(
            build_rownd_session_claim_payload(config, user.id, user, metadata, payload, None)
            if user
            else {}
        ),
        **({"aud": rownd_audience} if rownd_audience else {}),
    }


async def build_rownd_oauth_user_info(
    user: User,
    access_token_payload: JsonDict,
    scopes: List[str],
    current_payload: Optional[JsonDict],
    user_context: Optional[UserContext] = None,
) -> JsonDict:
    metadata = cast(
        JsonDict,
        (await inspect_linked_user_metadata(user.id, user_context, user))["combined_metadata"],
    )
    return {
        **(current_payload or {}),
        **build_standard_oauth_claims(user, scopes, metadata),
        **pick_oauth_user_info_rownd_claims(access_token_payload),
    }


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


def build_configured_session_claims(config: RowndPluginConfig, metadata: JsonDict) -> JsonDict:
    original = as_json_dict(metadata.get("original_rownd_user"))
    original_data = as_json_dict(original.get("data"))
    claims = {}
    for key, field_config in config.schema.items():
        if field_config.get("include_in_session_claims") is not True:
            continue
        claim_name = field_config.get("session_claim_name") or key
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


async def record_rownd_app_variant_for_user(
    config: RowndPluginConfig,
    user_id: str,
    app_variant_id: Optional[str],
    user_context: Optional[UserContext] = None,
) -> None:
    if not app_variant_id:
        return
    assert_app_variant_is_configured(config, app_variant_id)
    operation_context = user_context if user_context is not None else {}
    inspection = await inspect_linked_user_metadata(user_id, operation_context)
    metadata_user_id = cast(
        str,
        inspection.get("rownd_metadata_source_user_id") or inspection["primary_user_id"],
    )
    clear_supertokens_core_call_cache(operation_context)
    metadata = await get_raw_user_metadata(metadata_user_id, operation_context)
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
        metadata_user_id,
        {
            "original_rownd_user": {
                **original,
                "data": as_json_dict(original.get("data")) or {"user_id": metadata_user_id},
                "verified_data": as_json_dict(original.get("verified_data")),
                "attributes": {**attributes, "rownd:app_variants": [*app_variants, app_variant_id]},
            },
        },
        operation_context,
    )


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


async def import_user(
    user_import: JsonDict,
    supertokens_config: SupertokensConfig,
    user_context: UserContext,
) -> JsonDict:
    headers = {"Content-Type": "application/json"}
    if supertokens_config.api_key:
        headers["api-key"] = supertokens_config.api_key
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            res = await client.post(
                supertokens_config.connection_uri.rstrip("/") + "/bulk-import/import",
                headers=headers,
                json=user_import,
            )
    finally:
        clear_supertokens_core_call_cache(user_context)
    if res.status_code < 200 or res.status_code >= 300:
        raise RuntimeError("Bulk import failed with status %s: %s" % (res.status_code, res.text))
    data = res.json()
    if data.get("status") != "OK" or not data.get("user"):
        raise RuntimeError(
            "Bulk import failed: %s" % (data.get("message") or "Missing user in response")
        )
    return data["user"]


def login_method_matches_import(login_method: LoginMethod, method_import: JsonDict) -> bool:
    recipe_id = method_import.get("recipeId")
    if login_method.recipe_id != recipe_id:
        return False
    if recipe_id == "thirdparty":
        third_party_user_id = optional_string(method_import.get("thirdPartyUserId"))
        third_party_id = optional_string(method_import.get("thirdPartyId"))
        if not third_party_user_id or not third_party_id:
            return False
        return login_method.has_same_third_party_info_as(
            ThirdPartyInfo(
                third_party_user_id,
                third_party_id,
            )
        )
    if recipe_id == "passwordless":
        email = optional_string(method_import.get("email"))
        return (
            login_method.has_same_email_as(email)
            if email
            else login_method.has_same_phone_number_as(
                optional_string(method_import.get("phoneNumber"))
            )
        )
    return login_method.has_same_email_as(optional_string(method_import.get("email")))


def import_method_account_info(method_import: JsonDict) -> AccountInfoInput:
    if method_import.get("recipeId") == "thirdparty":
        third_party_user_id = optional_string(method_import.get("thirdPartyUserId"))
        third_party_id = optional_string(method_import.get("thirdPartyId"))
        if not third_party_user_id or not third_party_id:
            raise RuntimeError("Migrated third-party login method is incomplete")
        return AccountInfoInput(
            third_party=ThirdPartyInfo(
                third_party_user_id,
                third_party_id,
            )
        )
    email = optional_string(method_import.get("email"))
    if email:
        return AccountInfoInput(email=email)
    return AccountInfoInput(phone_number=optional_string(method_import.get("phoneNumber")))


async def inspect_import_method(
    method_import: JsonDict,
    tenant_id: str,
    user_context: UserContext,
) -> Tuple[JsonDict, List[Tuple[User, LoginMethod]], Optional[Tuple[User, LoginMethod]]]:
    users = await list_users_by_account_info(
        tenant_id,
        import_method_account_info(method_import),
        False,
        user_context,
    )
    owners = [
        (user, login_method)
        for user in users
        for login_method in user.login_methods
        if tenant_id in login_method.tenant_ids
        and login_method_matches_import(login_method, method_import)
    ]
    match = next(
        (
            owner
            for owner in owners
            if method_import.get("recipeId") == "thirdparty"
            or method_import.get("recipeId") == "passwordless"
            or (method_import.get("isVerified") is True and owner[1].verified)
        ),
        None,
    )
    return method_import, owners, match


async def create_missing_login_method(
    method_import: JsonDict,
    tenant_id: str,
    primary_user_id: str,
    user_context: UserContext,
) -> Tuple[RecipeUserId, bool]:
    reconciliation_context = create_derived_user_context(
        user_context, {"rowndDisableAutomaticAccountLinking": True}
    )
    if method_import.get("recipeId") == "thirdparty":
        third_party_id = optional_string(method_import.get("thirdPartyId"))
        third_party_user_id = optional_string(method_import.get("thirdPartyUserId"))
        email = optional_string(method_import.get("email"))
        if not third_party_id or not third_party_user_id or not email:
            raise RuntimeError("Migrated third-party login method is incomplete")
        result = await thirdparty_asyncio.manually_create_or_update_user(
            tenant_id=tenant_id,
            third_party_id=third_party_id,
            third_party_user_id=third_party_user_id,
            email=email,
            is_verified=bool(method_import.get("isVerified")),
            user_context=reconciliation_context,
        )
        if not isinstance(result, ManuallyCreateOrUpdateUserOkResult):
            raise RuntimeError(
                "Failed to create migrated third-party login method: %s"
                % getattr(result, "status", "ERROR")
            )
        if not result.created_new_recipe_user and not await sdk_user_id_matches_internal_target(
            result.user.id, primary_user_id, reconciliation_context
        ):
            raise RuntimeError(
                "Migrated third-party login method belongs to another SuperTokens user"
            )
        return result.recipe_user_id, result.created_new_recipe_user

    if method_import.get("recipeId") == "passwordless":
        email = optional_string(method_import.get("email"))
        phone_number = optional_string(method_import.get("phoneNumber"))
        result = await passwordless_asyncio.signinup(
            tenant_id,
            email,
            phone_number,
            None,
            reconciliation_context,
        )
        if not result.created_new_recipe_user and not await sdk_user_id_matches_internal_target(
            result.user.id, primary_user_id, reconciliation_context
        ):
            raise RuntimeError(
                "Migrated passwordless login method belongs to another SuperTokens user"
            )
        return result.recipe_user_id, result.created_new_recipe_user

    raise RuntimeError(
        "Cannot reconcile unsupported login method: %s" % method_import.get("recipeId")
    )


async def resolve_supertokens_user_id(user_id: str, user_context: UserContext) -> str:
    mapping = await get_user_id_mapping(user_id, "EXTERNAL", user_context)
    return mapping.supertokens_user_id if isinstance(mapping, GetUserIdMappingOkResult) else user_id


async def freshly_resolve_sdk_user_id_to_internal(
    sdk_user_id: str, user_context: UserContext
) -> str:
    clear_supertokens_core_call_cache(user_context)
    return await resolve_supertokens_user_id(sdk_user_id, user_context)


async def sdk_user_id_matches_internal_target(
    sdk_user_id: str, expected_internal_user_id: str, user_context: UserContext
) -> bool:
    if sdk_user_id == expected_internal_user_id:
        return True
    resolved_sdk_user_id = await freshly_resolve_sdk_user_id_to_internal(sdk_user_id, user_context)
    return resolved_sdk_user_id == expected_internal_user_id


async def assert_user_is_not_mapped_to_another_rownd_user(
    supertokens_user_id: str,
    rownd_user_id: str,
    user_context: UserContext,
) -> None:
    mapping = await get_user_id_mapping(supertokens_user_id, "SUPERTOKENS", user_context)
    if isinstance(mapping, GetUserIdMappingOkResult) and mapping.external_user_id != rownd_user_id:
        raise RuntimeError("A migrated login method is already mapped to another Rownd user")


async def assert_rownd_user_id_can_be_mapped(
    supertokens_user_id: str,
    rownd_user_id: str,
    user_context: UserContext,
) -> bool:
    external_mapping = await get_user_id_mapping(rownd_user_id, "EXTERNAL", user_context)
    if isinstance(external_mapping, GetUserIdMappingOkResult):
        if not await sdk_user_id_matches_internal_target(
            external_mapping.supertokens_user_id, supertokens_user_id, user_context
        ):
            raise RuntimeError("The Rownd user ID is already mapped to another SuperTokens user")
        return True

    internal_mapping = await get_user_id_mapping(supertokens_user_id, "SUPERTOKENS", user_context)
    if isinstance(internal_mapping, GetUserIdMappingOkResult):
        if internal_mapping.external_user_id != rownd_user_id:
            raise RuntimeError("The SuperTokens user is already mapped to another external user ID")
        return True
    return False


async def ensure_primary_user(
    user: User,
    login_method: LoginMethod,
    supertokens_user_id: str,
    user_context: UserContext,
) -> str:
    if user.is_primary_user:
        return supertokens_user_id
    result = await accountlinking_asyncio.create_primary_user(
        login_method.recipe_user_id,
        user_context,
    )
    if isinstance(result, CreatePrimaryUserOkResult):
        return supertokens_user_id
    if isinstance(result, CreatePrimaryUserRecipeUserIdAlreadyLinkedError):
        if await sdk_user_id_matches_internal_target(
            result.primary_user_id, supertokens_user_id, user_context
        ):
            return supertokens_user_id
        raise RuntimeError("A migrated login method belongs to a different primary user")
    raise RuntimeError("A migrated login method belongs to a different primary user")


async def create_rownd_user_id_mapping(
    supertokens_user_id: str,
    rownd_user_id: str,
    user_context: UserContext,
) -> bool:
    try:
        mapping_result = await create_user_id_mapping(
            supertokens_user_id,
            rownd_user_id,
            force=False,
            user_context=user_context,
        )
    except KeyError as error:
        if error.args != ("does_external_user_id_exist",):
            raise
        clear_supertokens_core_call_cache(user_context)
        existing = await get_user_id_mapping(rownd_user_id, "EXTERNAL", user_context)
        if isinstance(
            existing, GetUserIdMappingOkResult
        ) and await sdk_user_id_matches_internal_target(
            existing.supertokens_user_id, supertokens_user_id, user_context
        ):
            return False
        raise
    if isinstance(mapping_result, CreateUserIdMappingOkResult):
        return True
    clear_supertokens_core_call_cache(user_context)
    existing = await get_user_id_mapping(rownd_user_id, "EXTERNAL", user_context)
    if isinstance(existing, GetUserIdMappingOkResult) and await sdk_user_id_matches_internal_target(
        existing.supertokens_user_id, supertokens_user_id, user_context
    ):
        return False
    raise RuntimeError(
        "Failed to map migrated Rownd user ID: %s" % getattr(mapping_result, "status", "ERROR")
    )


async def reconcile_rownd_user_with_existing_login_methods(
    user_import: JsonDict,
    tenant_id: str,
    user_context: UserContext,
) -> bool:
    external_user_id = user_import.get("externalUserId")
    if not isinstance(external_user_id, str):
        raise RuntimeError("Migrated Rownd user has no external user ID")

    clear_supertokens_core_call_cache(user_context)
    method_imports = as_json_list(user_import.get("loginMethods"))
    inspections = await asyncio.gather(
        *(inspect_import_method(method, tenant_id, user_context) for method in method_imports)
    )
    matches = [match for _, _, match in inspections if match is not None]
    if not matches:
        return False

    third_party_matches = [
        match
        for method, _, match in inspections
        if method.get("recipeId") == "thirdparty" and match is not None
    ]
    target_user, target_login_method = third_party_matches[0] if third_party_matches else matches[0]
    resolved_user_ids: Dict[str, "asyncio.Task[str]"] = {}

    def resolve_user_id(user_id: str) -> "asyncio.Task[str]":
        task = resolved_user_ids.get(user_id)
        if task is None:
            task = asyncio.create_task(resolve_supertokens_user_id(user_id, user_context))
            resolved_user_ids[user_id] = task
        return task

    target_supertokens_user_id = await resolve_user_id(target_user.id)
    owner_inputs = [
        (method, owner, login_method)
        for method, owners, _match in inspections
        for owner, login_method in owners
    ]
    owner_ids = await asyncio.gather(*(resolve_user_id(owner.id) for _, owner, _ in owner_inputs))
    inspected_owners = [
        (*owner_input, owner_id) for owner_input, owner_id in zip(owner_inputs, owner_ids)
    ]
    foreign_owners = [
        owner_info for owner_info in inspected_owners if owner_info[3] != target_supertokens_user_id
    ]
    can_link_verified_email_owners = (
        bool(third_party_matches)
        and all(
            owner_id == target_supertokens_user_id
            for method, _, _, owner_id in inspected_owners
            if method.get("recipeId") == "thirdparty"
        )
        and all(
            method.get("recipeId") == "passwordless"
            and isinstance(method.get("email"), str)
            and method.get("isVerified") is True
            and login_method.recipe_id == "passwordless"
            and login_method.has_same_email_as(cast(str, method["email"]))
            and not owner.is_primary_user
            for method, owner, login_method, _ in foreign_owners
        )
    )
    if foreign_owners and not can_link_verified_email_owners:
        raise RuntimeError("A migrated login method belongs to a different SuperTokens user")
    for _, _, _, owner_id in foreign_owners:
        await assert_user_is_not_mapped_to_another_rownd_user(
            owner_id,
            external_user_id,
            user_context,
        )
    unsupported = next(
        (
            method
            for method, _, match in inspections
            if match is None and method.get("recipeId") == "emailpassword"
        ),
        None,
    )
    if unsupported is not None:
        raise RuntimeError("Cannot reconcile unsupported login method: emailpassword")

    clear_supertokens_core_call_cache(user_context)
    existing_mapping_matches = await assert_rownd_user_id_can_be_mapped(
        target_supertokens_user_id, external_user_id, user_context
    )
    mapping_exists = target_supertokens_user_id == external_user_id or existing_mapping_matches
    primary_user_id = await ensure_primary_user(
        target_user,
        target_login_method,
        target_supertokens_user_id,
        user_context,
    )
    foreign_recipe_user_ids = {
        login_method.recipe_user_id.get_as_string(): login_method.recipe_user_id
        for _, _, login_method, _ in foreign_owners
    }
    for recipe_user_id in foreign_recipe_user_ids.values():
        link_result = await accountlinking_asyncio.link_accounts(
            recipe_user_id,
            primary_user_id,
            user_context,
        )
        if not isinstance(link_result, LinkAccountsOkResult):
            raise RuntimeError(
                "Failed to link migrated login method: %s" % getattr(link_result, "status", "ERROR")
            )
    for method_import, _, match in inspections:
        if match is not None:
            continue
        verified_matching_email = None
        email = optional_string(method_import.get("email"))
        if method_import.get("recipeId") == "passwordless" and email:
            verified_matching_email = next(
                (
                    method
                    for method in target_user.login_methods
                    if tenant_id in method.tenant_ids
                    and method.verified
                    and method.has_same_email_as(email)
                ),
                None,
            )
        effective_import = (
            {**method_import, "isVerified": True}
            if verified_matching_email is not None
            else method_import
        )
        recipe_user_id, _ = await create_missing_login_method(
            effective_import, tenant_id, primary_user_id, user_context
        )
        created_user = await get_user(recipe_user_id.get_as_string(), user_context)
        if created_user is None:
            raise RuntimeError("Created migrated login method was not found")
        if not await sdk_user_id_matches_internal_target(
            created_user.id, primary_user_id, user_context
        ):
            link_result = await accountlinking_asyncio.link_accounts(
                recipe_user_id, primary_user_id, user_context
            )
            already_linked = isinstance(
                link_result, LinkAccountsRecipeUserIdAlreadyLinkedError
            ) and await sdk_user_id_matches_internal_target(
                link_result.primary_user_id, primary_user_id, user_context
            )
            if not isinstance(link_result, LinkAccountsOkResult) and not already_linked:
                raise RuntimeError(
                    "Failed to link migrated login method: %s"
                    % getattr(link_result, "status", "ERROR")
                )
        if (
            effective_import.get("recipeId") == "passwordless"
            and email
            and not effective_import.get("isVerified")
        ):
            await emailverification_asyncio.unverify_email(
                recipe_user_id,
                email,
                user_context,
            )

    if not mapping_exists:
        clear_supertokens_core_call_cache(user_context)
        mapping_exists = await assert_rownd_user_id_can_be_mapped(
            primary_user_id, external_user_id, user_context
        )
        if not mapping_exists:
            await create_rownd_user_id_mapping(primary_user_id, external_user_id, user_context)
    await usermetadata_asyncio.update_user_metadata(
        primary_user_id,
        as_json_dict(user_import.get("userMetadata")),
        user_context,
    )
    return True


async def sync_imported_email_verification_state(
    recipe_user_id: RecipeUserId,
    user_id: Optional[str],
    tenant_id: str,
    user_context: UserContext,
) -> None:
    metadata = await get_user_metadata(user_id or recipe_user_id.get_as_string(), user_context)
    original = as_json_dict(metadata.get("original_rownd_user"))
    data = as_json_dict(original.get("data"))
    verified_data = as_json_dict(original.get("verified_data"))
    email = data.get("email")
    if not isinstance(email, str) or not is_rownd_email_verified(verified_data.get("email"), email):
        return
    try:
        token_result = await emailverification_asyncio.create_email_verification_token(
            tenant_id, recipe_user_id, email, user_context
        )
        token = getattr(token_result, "token", None)
        if isinstance(token, str):
            await emailverification_asyncio.verify_email_using_token(
                tenant_id, token, False, user_context
            )
    except Exception:
        return


async def start_pending_email_verification(
    config: RowndPluginConfig,
    session: SessionContainer,
    email: str,
    user_context: UserContext,
) -> JsonDict:
    user_id = session.get_user_id(user_context)
    tenant_id = session.get_tenant_id(user_context)
    user = await get_user(user_id, user_context)
    if user is None:
        raise RowndPluginError("User not found in Rownd")
    metadata_inspection = await inspect_linked_user_metadata(user.id, user_context)
    metadata = cast(JsonDict, metadata_inspection["primary_metadata"])
    combined_metadata = cast(JsonDict, metadata_inspection["combined_metadata"])
    normalized_email = normalize_email(email)
    if not normalized_email:
        raise RowndEmailChangeError("INVALID_EMAIL", 400, "email must be a non-empty string")
    passwordless_method = find_canonical_passwordless_method(user, combined_metadata, tenant_id)
    tenant_login_methods = [
        method for method in user.login_methods if tenant_id in method.tenant_ids
    ]
    has_passwordless_method = any(
        method.recipe_id == "passwordless" for method in tenant_login_methods
    )
    initiating_login_method = next(
        (
            method
            for method in user.login_methods
            if method.recipe_user_id.get_as_string()
            == session.get_recipe_user_id(user_context).get_as_string()
            and tenant_id in method.tenant_ids
        ),
        None,
    )
    can_add_passwordless = (
        not has_passwordless_method
        and initiating_login_method is not None
        and is_real_third_party_method(initiating_login_method)
        and all(is_real_third_party_method(method) for method in tenant_login_methods)
    )
    if passwordless_method is None and not can_add_passwordless:
        raise RowndEmailChangeError(
            "CONFLICT", 409, "the account has no passwordless sign-in method"
        )
    current_email = as_json_dict(
        (
            await get_rownd_compat_user(
                user_id,
                config,
                tenant_id,
                metadata_override=combined_metadata,
                user_override=user,
                user_context=user_context,
            )
        ).get("data")
    ).get("email")
    pending = get_pending_verifications(metadata)
    pending_email_verifications = [item for item in pending if item.get("field") == "email"]
    if any(item.get("status") == "COMMITTING" for item in pending_email_verifications):
        raise RowndEmailChangeError("CONFLICT", 409, "an email change is already being committed")

    if isinstance(current_email, str) and normalize_email(current_email) == normalized_email:
        for verification in pending_email_verifications:
            await revoke_pending_email_verification_tokens(
                user,
                verification,
                session.get_recipe_user_id(user_context),
                user_context,
            )
        current_passwordless_method = next(
            (
                method
                for method in user.login_methods
                if method.recipe_id == "passwordless"
                and tenant_id in method.tenant_ids
                and method.verified
                and method.email
                and normalize_email(method.email) == normalized_email
            ),
            None,
        )
        updated_metadata = {
            **metadata,
            **(
                {
                    "rownd_email_recipe_user_id": (
                        current_passwordless_method.recipe_user_id.get_as_string()
                    ),
                    "rownd_email_recipe_user_ids": {
                        **as_json_dict(combined_metadata.get("rownd_email_recipe_user_ids")),
                        tenant_id: current_passwordless_method.recipe_user_id.get_as_string(),
                    },
                }
                if current_passwordless_method is not None
                else {}
            ),
            "rownd_pending_verification": [
                item for item in pending if item.get("field") != "email"
            ],
        }
        if pending_email_verifications or current_passwordless_method is not None:
            await update_primary_user_metadata(user_id, updated_metadata, user_context)
        return await get_rownd_compat_user(
            user_id,
            config,
            tenant_id,
            metadata_override={**combined_metadata, **updated_metadata},
            user_override=user,
            user_context=user_context,
        )

    await assert_email_available_for_user(normalized_email, user.id, user_context)
    purpose = "UPDATE_PASSWORDLESS" if passwordless_method else "ADD_PASSWORDLESS"
    verification_recipe_user_id = (
        passwordless_method.recipe_user_id
        if passwordless_method
        else session.get_recipe_user_id(user_context)
    )
    for verification in pending_email_verifications:
        await revoke_pending_email_verification_tokens(
            user,
            verification,
            session.get_recipe_user_id(user_context),
            user_context,
        )

    now = datetime.now(timezone.utc)
    pending_verification_id = str(uuid.uuid4())
    pending_verification: JsonDict = {
        "id": pending_verification_id,
        "field": "email",
        "value": email,
        "created_at": now.isoformat().replace("+00:00", "Z"),
        "tenantId": tenant_id,
        "purpose": purpose,
        "initiatingSessionHandle": session.get_handle(user_context),
        "verificationRecipeUserId": verification_recipe_user_id.get_as_string(),
        "status": "PENDING",
    }
    await update_primary_user_metadata(
        user_id,
        {
            **metadata,
            "rownd_pending_verification": [
                *[item for item in pending if item.get("field") != "email"],
                pending_verification,
            ],
        },
        user_context,
    )

    try:
        await emailverification_asyncio.revoke_email_verification_tokens(
            tenant_id, verification_recipe_user_id, normalized_email, user_context
        )
        await emailverification_asyncio.unverify_email(
            verification_recipe_user_id, normalized_email, user_context
        )
        result = await emailverification_asyncio.send_email_verification_email(
            tenant_id,
            user_id,
            verification_recipe_user_id,
            normalized_email,
            create_derived_user_context(
                user_context,
                {_PENDING_EMAIL_VERIFICATION_USER_CONTEXT_KEY: pending_verification_id},
            ),
        )
        if getattr(result, "status", None) != "OK":
            raise RuntimeError("A fresh email verification could not be created")
    except Exception:
        with suppress(Exception):
            await emailverification_asyncio.revoke_email_verification_tokens(
                tenant_id, verification_recipe_user_id, normalized_email, user_context
            )
        await remove_pending_email_verification(user_id, pending_verification_id, user_context)
        raise
    return await get_rownd_compat_user(
        user_id,
        config,
        tenant_id,
        metadata_override=combined_metadata,
        user_override=user,
        user_context=user_context,
    )


async def resolve_pending_email_verification_token(
    token: str,
    query_pending_verification_id: Optional[str],
    tenant_id: str,
    session: Optional[SessionContainer],
    user_context: UserContext,
) -> Dict[str, str]:
    if query_pending_verification_id is None:
        return {"status": "NOT_PENDING"}
    if session is None:
        return {"status": "INVALID_PENDING"}

    session_handle = session.get_handle(user_context)
    session_user_id = session.get_user_id(user_context)
    session_tenant_id = session.get_tenant_id(user_context)
    if session_tenant_id != tenant_id:
        return {"status": "INVALID_PENDING"}
    session_information = await session_asyncio.get_session_information(
        session_handle, user_context
    )
    if (
        session_information is None
        or session_information.session_handle != session_handle
        or session_information.user_id != session_user_id
        or session_information.tenant_id != session_tenant_id
    ):
        return {"status": "INVALID_PENDING"}

    metadata = await get_raw_user_metadata(session_user_id, user_context)
    pending_verification = next(
        (
            verification
            for verification in get_pending_verifications(metadata)
            if verification.get("id") == query_pending_verification_id
            and verification.get("field") == "email"
            and verification.get("status") == "PENDING"
            and verification.get("initiatingSessionHandle") == session_handle
            and (verification.get("tenantId") or PUBLIC_TENANT_ID) == tenant_id
            and verification.get("purpose") in {"UPDATE_PASSWORDLESS", "ADD_PASSWORDLESS"}
        ),
        None,
    )
    if pending_verification is None:
        return {"status": "INVALID_PENDING"}
    return {
        "status": "OK",
        "core_token": token,
        "pending_verification_id": query_pending_verification_id,
        "user_id": session_user_id,
    }


async def complete_pending_email_verification(
    recipe_user_id: RecipeUserId,
    email: str,
    user_context: UserContext,
    tenant_id: str = PUBLIC_TENANT_ID,
    session_handle: Optional[str] = None,
    pending_verification_id: Optional[str] = None,
    pending_user_id: Optional[str] = None,
) -> Optional[Dict[str, object]]:
    user = await get_user(recipe_user_id.get_as_string(), user_context)
    user_id = user.id if user else recipe_user_id.get_as_string()
    if pending_user_id and user_id != pending_user_id:
        if pending_verification_id:
            await remove_pending_email_verification(
                pending_user_id, pending_verification_id, user_context
            )
        raise RowndEmailChangeError(
            "CONFLICT",
            409,
            "email change session is no longer active; start the email change again",
        )
    primary_mapping = await get_primary_user_mapping(user_id, user_context)
    primary_metadata_user_id = primary_mapping.supertokens_user_id if primary_mapping else user_id
    metadata = await get_raw_user_metadata(primary_metadata_user_id, user_context)
    pending = get_pending_verifications(metadata)
    normalized_email = normalize_email(email)
    pending_verification = next(
        (
            item
            for item in pending
            if (not pending_verification_id or item.get("id") == pending_verification_id)
            and item.get("field") == "email"
            and normalize_email(cast(str, item["value"])) == normalized_email
            and (item.get("tenantId") or PUBLIC_TENANT_ID) == tenant_id
            and (
                not item.get("verificationRecipeUserId")
                or item.get("verificationRecipeUserId") == recipe_user_id.get_as_string()
            )
        ),
        None,
    )
    if not pending_verification:
        if pending_verification_id:
            try:
                await emailverification_asyncio.unverify_email(
                    recipe_user_id, normalized_email, user_context
                )
            finally:
                await remove_pending_email_verification(
                    user_id, pending_verification_id, user_context
                )
            raise RowndEmailChangeError(
                "CONFLICT",
                409,
                "email change session is no longer active; start the email change again",
            )
        return None

    purpose = pending_verification.get("purpose")
    if purpose != "UPDATE_PASSWORDLESS" and purpose != "ADD_PASSWORDLESS":
        await reject_inactive_pending_email_verification(
            user_id, pending_verification, recipe_user_id, normalized_email, user_context
        )

    initiating_session_handle = optional_string(pending_verification.get("initiatingSessionHandle"))
    pending_status = pending_verification.get("status")
    if (
        (pending_status if pending_status is not None else "PENDING") != "PENDING"
        or not initiating_session_handle
        or initiating_session_handle != session_handle
    ):
        await reject_inactive_pending_email_verification(
            user_id, pending_verification, recipe_user_id, normalized_email, user_context
        )

    completion_phase = "PENDING"
    rollback_credential_change: Optional[Callable[[], Awaitable[None]]] = None
    try:
        await assert_email_available_for_user(normalized_email, user_id, user_context)
        initiating_session = await session_asyncio.get_session_information(
            cast(str, initiating_session_handle), user_context
        )
        if (
            initiating_session is None
            or initiating_session.user_id != user_id
            or initiating_session.tenant_id != tenant_id
        ):
            await reject_inactive_pending_email_verification(
                user_id, pending_verification, recipe_user_id, normalized_email, user_context
            )
        current_user = await get_user(user_id, user_context)
        initiating_login_method = (
            next(
                (
                    method
                    for method in current_user.login_methods
                    if method.recipe_user_id.get_as_string()
                    == initiating_session.recipe_user_id.get_as_string()
                    and tenant_id in method.tenant_ids
                ),
                None,
            )
            if current_user
            else None
        )
        if current_user is None or initiating_login_method is None:
            await reject_inactive_pending_email_verification(
                user_id, pending_verification, recipe_user_id, normalized_email, user_context
            )
        passwordless_method = find_pending_passwordless_method(
            current_user, pending_verification, tenant_id
        )
        can_add_passwordless = (
            purpose == "ADD_PASSWORDLESS"
            and all(
                is_real_third_party_method(method)
                for method in current_user.login_methods
                if tenant_id in method.tenant_ids
            )
            and is_real_third_party_method(initiating_login_method)
            and pending_verification.get("verificationRecipeUserId")
            == initiating_login_method.recipe_user_id.get_as_string()
        )
        if (purpose == "UPDATE_PASSWORDLESS" and passwordless_method is None) or (
            purpose == "ADD_PASSWORDLESS" and not can_add_passwordless
        ):
            await reject_inactive_pending_email_verification(
                user_id, pending_verification, recipe_user_id, normalized_email, user_context
            )

        completion_phase = "COMMITTING"
        await mark_pending_email_verification_status(
            user_id, cast(str, pending_verification["id"]), "COMMITTING", user_context
        )
        if not await session_asyncio.revoke_session(
            cast(str, initiating_session_handle), user_context
        ):
            await reject_inactive_pending_email_verification(
                user_id, pending_verification, recipe_user_id, normalized_email, user_context
            )
        initiating_recipe_user_id = initiating_login_method.recipe_user_id
        await session_asyncio.revoke_all_sessions_for_user(user_id, True, None, user_context)
        committing_metadata = await get_raw_user_metadata(user_id, user_context)
        committing_verification = next(
            (
                item
                for item in get_pending_verifications(committing_metadata)
                if item.get("field") == "email"
            ),
            None,
        )
        if (
            committing_verification is None
            or committing_verification.get("id") != pending_verification.get("id")
            or committing_verification.get("status") != "COMMITTING"
        ):
            await reject_inactive_pending_email_verification(
                user_id, pending_verification, recipe_user_id, normalized_email, user_context
            )

        passwordless_user = await passwordless_asyncio.signinup(
            tenant_id,
            normalized_email,
            None,
            None,
            create_derived_user_context(
                user_context, {"rowndDisableAutomaticAccountLinking": True}
            ),
        )
        reuses_linked_method = (
            not passwordless_user.created_new_recipe_user
            and passwordless_user.user.id == user_id
            and any(
                method.recipe_user_id.get_as_string()
                == passwordless_user.recipe_user_id.get_as_string()
                and tenant_id in method.tenant_ids
                for method in passwordless_user.user.login_methods
            )
        )
        if not passwordless_user.created_new_recipe_user and not reuses_linked_method:
            raise email_ownership_conflict()
        if passwordless_user.created_new_recipe_user:

            async def rollback_add() -> None:
                await delete_user(
                    passwordless_user.recipe_user_id.get_as_string(),
                    remove_all_linked_accounts=False,
                    user_context=user_context,
                )

            rollback_credential_change = rollback_add
            await assert_email_available_for_user(
                normalized_email,
                [user_id, passwordless_user.user.id],
                user_context,
            )
            primary_user_id = await ensure_stable_primary_user(
                current_user, initiating_recipe_user_id, user_context
            )
            if primary_user_id != user_id:
                raise RowndEmailChangeError(
                    "CONFLICT", 409, "the account changed before email verification completed"
                )
            link_result = await accountlinking_asyncio.link_accounts(
                passwordless_user.recipe_user_id, primary_user_id, user_context
            )
            if not isinstance(link_result, LinkAccountsOkResult):
                raise email_ownership_conflict()
        canonical_email_recipe_user_id = passwordless_user.recipe_user_id.get_as_string()

        await session_asyncio.revoke_all_sessions_for_user(user_id, True, None, user_context)
        final_metadata_inspection = await inspect_linked_user_metadata(user_id, user_context)
        target_metadata = cast(JsonDict, final_metadata_inspection["primary_metadata"])
        combined_metadata = cast(JsonDict, final_metadata_inspection["combined_metadata"])
        updated_metadata = build_verified_email_metadata(
            target_metadata,
            user_id,
            normalized_email,
            canonical_email_recipe_user_id,
            tenant_id,
            combined_metadata,
        )
        await update_primary_user_metadata(user_id, updated_metadata, user_context)
        completion_phase = "COMPLETED"

        async def rollback_on_session_replacement_failure() -> None:
            rollback_errors: List[Exception] = []
            operations: List[Callable[[], Awaitable[object]]] = []
            if rollback_credential_change:
                operations.append(rollback_credential_change)

            async def unverify() -> None:
                await emailverification_asyncio.unverify_email(
                    recipe_user_id, normalized_email, user_context
                )

            async def restore_metadata() -> None:
                await replace_primary_user_metadata(
                    user_id,
                    {
                        **target_metadata,
                        "rownd_pending_verification": [
                            item
                            for item in get_pending_verifications(target_metadata)
                            if item.get("id") != pending_verification.get("id")
                        ],
                    },
                    user_context,
                )

            async def revoke_sessions() -> None:
                await session_asyncio.revoke_all_sessions_for_user(
                    user_id, True, None, user_context
                )

            operations.extend([unverify, restore_metadata, revoke_sessions])
            for operation in operations:
                try:
                    await operation()
                except Exception as rollback_error:
                    rollback_errors.append(rollback_error)
            if rollback_errors:
                log_debug(
                    get_active_rownd_config(),
                    "Email change replacement-session rollback failed for user %s; "
                    "reconciliation required. Errors: %s"
                    % (user_id, "; ".join(str(error) for error in rollback_errors)),
                )
                raise RowndEmailChangeError(
                    "CONFLICT",
                    409,
                    "email change rollback failed; account reconciliation is required",
                )

        return {
            "user_id": user_id,
            "recipe_user_id": initiating_recipe_user_id,
            "initiating_session_handle": initiating_session_handle,
            "replace_session": True,
            "rollback_on_session_replacement_failure": (rollback_on_session_replacement_failure),
        }
    except Exception as error:
        if completion_phase != "COMPLETED":
            rollback_error: Optional[Exception] = None
            if rollback_credential_change:
                try:
                    await rollback_credential_change()
                except Exception as caught_rollback_error:
                    rollback_error = caught_rollback_error
            if completion_phase == "COMMITTING":
                await asyncio.gather(
                    session_asyncio.revoke_all_sessions_for_user(user_id, True, None, user_context),
                    return_exceptions=True,
                )
            if rollback_error is not None:
                log_debug(
                    get_active_rownd_config(),
                    "Email change rollback failed for user %s; reconciliation required. Error: %s"
                    % (user_id, rollback_error),
                )
                raise RowndEmailChangeError(
                    "CONFLICT",
                    409,
                    "email change rollback failed; account reconciliation is required",
                ) from rollback_error
            cleanup_failed = False
            try:
                await cleanup_pending_email_verification(
                    user_id,
                    pending_verification,
                    recipe_user_id,
                    normalized_email,
                    user_context,
                )
            except Exception:
                cleanup_failed = True
            if completion_phase == "COMMITTING" and cleanup_failed:
                with suppress(Exception):
                    await mark_pending_email_verification_status(
                        user_id,
                        cast(str, pending_verification["id"]),
                        "PENDING",
                        user_context,
                    )
        raise error


def get_pending_verifications(metadata: JsonDict) -> List[JsonDict]:
    return [
        item
        for item in as_json_list(metadata.get("rownd_pending_verification"))
        if all(isinstance(item.get(key), str) for key in ("id", "field", "value", "created_at"))
    ]


def normalize_email(email: str) -> str:
    return email.strip().lower()


def get_passwordless_email_login_methods(login_methods: List[LoginMethod]) -> List[LoginMethod]:
    return [
        method
        for method in login_methods
        if method.recipe_id == "passwordless" and bool(method.email)
    ]


def get_account_tenant_ids(user: User, current_tenant_id: str) -> List[str]:
    return list(
        dict.fromkeys(
            [current_tenant_id]
            + [tenant for method in user.login_methods for tenant in method.tenant_ids]
        )
    )


async def rollback_tenant_associations(
    tenant_ids: List[str], recipe_user_id: RecipeUserId, user_context: UserContext
) -> None:
    await asyncio.gather(
        *(
            multitenancy_asyncio.disassociate_user_from_tenant(
                tenant_id, recipe_user_id, user_context
            )
            for tenant_id in tenant_ids
        )
    )


async def associate_recipe_user_to_tenants(
    tenant_ids: List[str], recipe_user_id: RecipeUserId, user_context: UserContext
) -> List[str]:
    newly_associated: List[str] = []
    unknown_outcome: Optional[str] = None
    try:
        for tenant_id in tenant_ids:
            unknown_outcome = tenant_id
            result = await multitenancy_asyncio.associate_user_to_tenant(
                tenant_id, recipe_user_id, user_context
            )
            unknown_outcome = None
            if getattr(result, "status", None) != "OK":
                raise email_ownership_conflict()
            if not getattr(result, "was_already_associated", False):
                newly_associated.append(tenant_id)
        return newly_associated
    except Exception:
        await rollback_tenant_associations(
            list(dict.fromkeys(newly_associated + ([unknown_outcome] if unknown_outcome else []))),
            recipe_user_id,
            user_context,
        )
        raise


def get_verification_recipe_user_ids(
    user: User, verification: JsonDict, fallback: RecipeUserId
) -> List[RecipeUserId]:
    verification_recipe_user_id = verification.get("verificationRecipeUserId")
    method = next(
        (
            method
            for method in user.login_methods
            if method.recipe_user_id.get_as_string() == verification_recipe_user_id
        ),
        None,
    )
    if method:
        return [method.recipe_user_id]
    return list(
        {
            recipe_user_id.get_as_string(): recipe_user_id
            for recipe_user_id in [
                *(login_method.recipe_user_id for login_method in user.login_methods),
                fallback,
            ]
        }.values()
    )


async def revoke_pending_email_verification_tokens(
    user: User,
    verification: JsonDict,
    fallback: RecipeUserId,
    user_context: UserContext,
) -> None:
    await asyncio.gather(
        *(
            emailverification_asyncio.revoke_email_verification_tokens(
                cast(str, verification.get("tenantId") or PUBLIC_TENANT_ID),
                recipe_user_id,
                cast(str, verification["value"]),
                user_context,
            )
            for recipe_user_id in get_verification_recipe_user_ids(user, verification, fallback)
        )
    )


async def assert_email_available_for_user(
    email: str, allowed_user_ids: Union[str, List[str]], user_context: UserContext
) -> None:
    allowed_ids = {allowed_user_ids} if isinstance(allowed_user_ids, str) else set(allowed_user_ids)
    tenants = await multitenancy_asyncio.list_all_tenants(user_context)
    tenant_ids = list(
        dict.fromkeys([PUBLIC_TENANT_ID] + [tenant.tenant_id for tenant in tenants.tenants])
    )
    owners_by_tenant = await asyncio.gather(
        *(
            list_users_by_account_info(
                tenant_id, AccountInfoInput(email=email), False, user_context
            )
            for tenant_id in tenant_ids
        )
    )
    if any(owner.id not in allowed_ids for owners in owners_by_tenant for owner in owners):
        raise email_ownership_conflict()


def email_ownership_conflict() -> RowndEmailChangeError:
    return RowndEmailChangeError("CONFLICT", 409, "email cannot be used for this account")


def find_pending_passwordless_method(
    user: Optional[User], pending_verification: JsonDict, tenant_id: str
) -> Optional[LoginMethod]:
    if user is None:
        return None
    if pending_verification.get("purpose") != "UPDATE_PASSWORDLESS" or not pending_verification.get(
        "verificationRecipeUserId"
    ):
        return None
    pending_recipe_user_id = pending_verification.get("verificationRecipeUserId")
    method = next(
        (
            method
            for method in user.login_methods
            if method.recipe_id == "passwordless"
            and method.recipe_user_id.get_as_string() == pending_recipe_user_id
        ),
        None,
    )
    return (
        method
        if method is not None
        and tenant_id in method.tenant_ids
        and method.recipe_user_id.get_as_string() == pending_recipe_user_id
        else None
    )


def get_canonical_email_recipe_user_id(metadata: JsonDict, tenant_id: str) -> Optional[str]:
    if "rownd_email_recipe_user_ids" in metadata:
        canonical_by_tenant = metadata.get("rownd_email_recipe_user_ids")
        if not isinstance(canonical_by_tenant, dict):
            return None
        canonical = canonical_by_tenant.get(tenant_id)
        return canonical if isinstance(canonical, str) else None
    canonical = metadata.get("rownd_email_recipe_user_id")
    return canonical if isinstance(canonical, str) else None


def find_canonical_passwordless_method(
    user: User, metadata: JsonDict, tenant_id: str
) -> Optional[LoginMethod]:
    passwordless_methods = [
        method
        for method in user.login_methods
        if method.recipe_id == "passwordless" and tenant_id in method.tenant_ids
    ]
    canonical_recipe_user_id = get_canonical_email_recipe_user_id(metadata, tenant_id)
    if canonical_recipe_user_id:
        canonical_method = next(
            (
                method
                for method in passwordless_methods
                if method.recipe_user_id.get_as_string() == canonical_recipe_user_id
            ),
            None,
        )
        if canonical_method is None:
            raise RowndEmailChangeError(
                "CONFLICT", 409, "the canonical email sign-in method is invalid"
            )
        return canonical_method
    if len(passwordless_methods) > 1:
        raise RowndEmailChangeError(
            "AMBIGUOUS",
            409,
            "the account has multiple email sign-in methods without a canonical method",
        )
    return passwordless_methods[0] if passwordless_methods else None


async def ensure_stable_primary_user(
    user: Optional[User], anchor: RecipeUserId, user_context: UserContext
) -> str:
    if user is None:
        raise RowndPluginError("User not found in Rownd")
    if user.is_primary_user:
        return user.id
    result = await accountlinking_asyncio.create_primary_user(anchor, user_context)
    if isinstance(result, CreatePrimaryUserOkResult):
        return result.user.id
    if isinstance(result, CreatePrimaryUserRecipeUserIdAlreadyLinkedError):
        return result.primary_user_id
    raise email_ownership_conflict()


async def remove_pending_email_verification(
    user_id: str, pending_id: str, user_context: UserContext
) -> None:
    metadata = await get_raw_user_metadata(user_id, user_context)
    await update_primary_user_metadata(
        user_id,
        {
            "rownd_pending_verification": [
                item for item in get_pending_verifications(metadata) if item.get("id") != pending_id
            ]
        },
        user_context,
    )


async def mark_pending_email_verification_status(
    user_id: str, pending_id: str, status: str, user_context: UserContext
) -> None:
    metadata = await get_raw_user_metadata(user_id, user_context)
    await update_primary_user_metadata(
        user_id,
        {
            "rownd_pending_verification": [
                {**item, "status": status} if item.get("id") == pending_id else item
                for item in get_pending_verifications(metadata)
            ]
        },
        user_context,
    )


async def cleanup_pending_email_verification(
    user_id: str,
    pending_verification: JsonDict,
    recipe_user_id: RecipeUserId,
    email: str,
    user_context: UserContext,
) -> None:
    await emailverification_asyncio.unverify_email(recipe_user_id, email, user_context)
    await remove_pending_email_verification(
        user_id, cast(str, pending_verification["id"]), user_context
    )


async def reject_inactive_pending_email_verification(
    user_id: str,
    pending_verification: JsonDict,
    recipe_user_id: RecipeUserId,
    email: str,
    user_context: UserContext,
) -> NoReturn:
    await cleanup_pending_email_verification(
        user_id, pending_verification, recipe_user_id, email, user_context
    )
    raise RowndEmailChangeError(
        "CONFLICT",
        409,
        "email change session is no longer active; start the email change again",
    )


def build_verified_email_metadata(
    metadata: JsonDict,
    user_id: str,
    email: str,
    canonical_email_recipe_user_id: str,
    tenant_id: str,
    fallback_metadata: Optional[JsonDict] = None,
) -> JsonDict:
    fallback_metadata = fallback_metadata or {}
    compatibility_user = (
        as_json_dict(metadata.get("original_rownd_user"))
        or as_json_dict(fallback_metadata.get("original_rownd_user"))
        or {
            "state": "enabled",
            "auth_level": "verified",
            "data": {"user_id": user_id},
            "verified_data": {},
            "groups": [],
            "meta": {},
        }
    )
    compatibility_data = as_json_dict(compatibility_user.get("data"))
    return {
        **metadata,
        "original_rownd_user": {
            **compatibility_user,
            "data": {
                **compatibility_data,
                "user_id": compatibility_data.get("user_id") or user_id,
                "email": email,
            },
            "verified_data": {
                **as_json_dict(compatibility_user.get("verified_data")),
                "email": email,
            },
        },
        "rownd_email_recipe_user_id": canonical_email_recipe_user_id,
        "rownd_email_recipe_user_ids": {
            **as_json_dict(fallback_metadata.get("rownd_email_recipe_user_ids")),
            **as_json_dict(metadata.get("rownd_email_recipe_user_ids")),
            tenant_id: canonical_email_recipe_user_id,
        },
        "rownd_pending_verification": [
            item for item in get_pending_verifications(metadata) if item.get("field") != "email"
        ],
    }


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


def build_app_config(
    config: RowndPluginConfig, app_variant_id: Optional[str]
) -> Optional[JsonDict]:
    base_app = config.app_config or {}
    sub_brand = config.sub_brands.get(app_variant_id) if app_variant_id else None
    if app_variant_id and sub_brand is None:
        return None
    app = deep_merge(base_app, sub_brand or {})
    schema = dict(config.schema or DEFAULT_ROWND_SCHEMA)
    sign_in_method_items = as_json_list(app.get("signInMethods"))
    sign_in_methods = build_sign_in_methods_config(sign_in_method_items)

    email_sign_in = as_json_dict(sign_in_methods.get("email"))
    phone_sign_in = as_json_dict(sign_in_methods.get("phone"))
    google_sign_in = as_json_dict(sign_in_methods.get("google"))
    apple_sign_in = as_json_dict(sign_in_methods.get("apple"))

    if email_sign_in.get("enabled") and "email" not in schema:
        schema["email"] = {"display_name": "Email", "type": "string", "user_visible": True}
    if phone_sign_in.get("enabled") and "phone_number" not in schema:
        schema["phone_number"] = {
            "display_name": "Phone number",
            "type": "string",
            "user_visible": True,
        }
    if google_sign_in.get("enabled") and "google_id" not in schema:
        schema["google_id"] = {"display_name": "Google ID", "type": "string", "user_visible": False}
    if apple_sign_in.get("enabled") and "apple_id" not in schema:
        schema["apple_id"] = {"display_name": "Apple ID", "type": "string", "user_visible": False}

    branding = as_json_dict(app.get("branding"))
    auth = as_json_dict(app.get("auth"))
    hub_auth = {
        "email": build_auth_email_config(auth.get("email")),
        **({"mobile": build_auth_mobile_config(auth.get("mobile"))} if auth.get("mobile") else {}),
        "sign_in_methods": sign_in_methods,
        "additional_fields": auth.get("additionalFields", []),
        **(
            {"remember_sign_in_method": auth["rememberSignInMethod"]}
            if "rememberSignInMethod" in auth
            else {}
        ),
        **(
            {"use_explicit_sign_up_flow": auth["useExplicitSignUpFlow"]}
            if "useExplicitSignUpFlow" in auth
            else {}
        ),
        **(
            {"allow_unverified_users": auth["allowUnverifiedUsers"]}
            if "allowUnverifiedUsers" in auth
            else {}
        ),
        **(
            {
                "enforce_same_device_passwordless_sign_in": auth[
                    "enforceSameDevicePasswordlessSignIn"
                ]
            }
            if "enforceSameDevicePasswordlessSignIn" in auth
            else {}
        ),
        **(
            {"primary_sign_up_method": auth["primarySignUpMethod"]}
            if auth.get("primarySignUpMethod")
            else {}
        ),
        **({"preferred_method": auth["preferredMethod"]} if auth.get("preferredMethod") else {}),
        **({"order": auth["order"]} if auth.get("order") else {}),
        **(
            {"instant_user": {"enabled": True}}
            if is_instant_anonymous_method(sign_in_method_items)
            else {}
        ),
        "show_app_icon": branding.get("showAppIcon", False),
    }
    return {
        "config_type": "variant" if app_variant_id else "app",
        **({"variant": app.get("variant")} if isinstance(app.get("variant"), dict) else {}),
        "app": {
            "id": app.get("id", ""),
            "name": app.get("name", config.app_name),
            "icon": app.get("icon", ""),
            **(
                {"user_verification_fields": app["userVerificationFields"]}
                if app.get("userVerificationFields")
                else {}
            ),
            "schema": {key: normalize_schema_field(key, field) for key, field in schema.items()},
            "config": {
                **({"capabilities": app["capabilities"]} if app.get("capabilities") else {}),
                **({"web": app["web"]} if app.get("web") else {}),
                **({"bottom_sheet": app["bottomSheet"]} if app.get("bottomSheet") else {}),
                **(
                    {"profile_storage_version": app["profileStorageVersion"]}
                    if app.get("profileStorageVersion")
                    else {}
                ),
                "customizations": {
                    "primary_color": branding.get("primaryColor", "#5b5bd6"),
                    **({"logo": branding["logo"]} if branding.get("logo") else {}),
                    **(
                        {"logo_dark_mode": branding["logoDarkMode"]}
                        if branding.get("logoDarkMode")
                        else {}
                    ),
                    **(
                        {"animations": branding["animations"]} if branding.get("animations") else {}
                    ),
                },
                "hub": {
                    **(
                        {"allowed_web_origins": app["allowedWebOrigins"]}
                        if app.get("allowedWebOrigins")
                        else {}
                    ),
                    "customizations": {
                        "rounded_corners": branding.get("roundedCorners", True),
                        **(
                            {"container_border_radius": branding["containerBorderRadius"]}
                            if "containerBorderRadius" in branding
                            else {}
                        ),
                        **({"placement": branding["placement"]} if "placement" in branding else {}),
                        **(
                            {"primary_color": branding["hubPrimaryColor"]}
                            if "hubPrimaryColor" in branding
                            else {}
                        ),
                        **(
                            {"primary_color_dark_mode": branding["primaryColorDarkMode"]}
                            if "primaryColorDarkMode" in branding
                            else {}
                        ),
                        **(
                            {"background_color": branding["backgroundColor"]}
                            if "backgroundColor" in branding
                            else {}
                        ),
                        **(
                            {"font_family": branding["fontFamily"]}
                            if "fontFamily" in branding
                            else {}
                        ),
                        **(
                            {"hide_verification_icons": branding["hideVerificationIcons"]}
                            if "hideVerificationIcons" in branding
                            else {}
                        ),
                        "visual_swoops": branding.get("visualSwoops", True),
                        "blur_background": branding.get("blurBackground", True),
                        **(
                            {"blur_background_opacity": branding["blurBackgroundOpacity"]}
                            if "blurBackgroundOpacity" in branding
                            else {}
                        ),
                        **({"offset_x": branding["offsetX"]} if "offsetX" in branding else {}),
                        **({"offset_y": branding["offsetY"]} if "offsetY" in branding else {}),
                        **(
                            {"property_overrides": branding["propertyOverrides"]}
                            if branding.get("propertyOverrides")
                            else {}
                        ),
                        "dark_mode": branding.get("darkMode", "auto"),
                    },
                    **(
                        {"custom_scripts": branding["customScripts"]}
                        if branding.get("customScripts")
                        else {}
                    ),
                    **(
                        {"custom_styles": branding["customStyles"]}
                        if branding.get("customStyles")
                        else {}
                    ),
                    "auth": hub_auth,
                    "legal": build_legal_config(app.get("legal")),
                    "profile": build_profile_config(app.get("profile")),
                    "custom_content": build_custom_content_config(app.get("customContent")),
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
    methods = {}
    for item in methods_array:
        method = item.get("method")
        if isinstance(method, str):
            methods[method] = item
    custom_providers = {}
    for key, value in methods.items():
        if key and key not in BUILTIN_SIGN_IN_METHOD_KEYS:
            display_name = value.get("displayName")
            custom_provider: JsonDict = {
                "enabled": True,
                "display_name": display_name if isinstance(display_name, str) else key,
            }
            if isinstance(value.get("iconLightUrl"), str):
                custom_provider["icon_light_url"] = value["iconLightUrl"]
            if isinstance(value.get("iconDarkUrl"), str):
                custom_provider["icon_dark_url"] = value["iconDarkUrl"]
            custom_providers[key] = custom_provider
    google = methods.get("google") or {}
    apple = methods.get("apple") or {}
    anonymous = methods.get("anonymous") or {}
    sign_in_faster_with_google = google.get("signInFasterWithGoogle")
    anonymous_type = "instant" if anonymous.get("type") == "instant" else "guest"
    anonymous_config: JsonDict = {"enabled": "anonymous" in methods and anonymous_type != "instant"}
    apple_config: JsonDict = {"enabled": "apple" in methods, "client_id": apple.get("clientId", "")}
    if isinstance(apple.get("webClientType"), str):
        apple_config["web_client_type"] = apple["webClientType"]
    if isinstance(apple.get("iosClientType"), str):
        apple_config["ios_client_type"] = apple["iosClientType"]
    if isinstance(apple.get("androidClientType"), str):
        apple_config["android_client_type"] = apple["androidClientType"]
    if "anonymous" in methods and anonymous_type != "instant":
        anonymous_config["type"] = anonymous_type
        if isinstance(anonymous.get("displayName"), str):
            anonymous_config["display_name"] = anonymous["displayName"]
        if isinstance(anonymous.get("iconLightUrl"), str):
            anonymous_config["icon_light_url"] = anonymous["iconLightUrl"]
        if isinstance(anonymous.get("iconDarkUrl"), str):
            anonymous_config["icon_dark_url"] = anonymous["iconDarkUrl"]
    scopes = google.get("scopes")
    return {
        "email": {"enabled": "email" in methods},
        "phone": {"enabled": "phone" in methods},
        "google": {
            "enabled": "google" in methods,
            "client_id": google.get("clientId", ""),
            "ios_client_id": google.get("iosClientId", ""),
            "scopes": scopes
            if isinstance(scopes, list) and all(isinstance(item, str) for item in scopes)
            else [],
            **(
                {"sign_in_faster_with_google": sign_in_faster_with_google}
                if sign_in_faster_with_google in {"enabled", "disabled"}
                else {}
            ),
            "one_tap": build_google_one_tap_config(google.get("oneTap")),
        },
        "apple": apple_config,
        "anonymous": anonymous_config,
        **custom_providers,
    }


def build_auth_email_config(auth_email: object) -> JsonDict:
    auth_email = as_json_dict(auth_email)
    return {
        "from_address": auth_email.get("fromAddress", "no-reply@rownd.io"),
        "image": auth_email.get("image", ""),
        **({"subject": auth_email["subject"]} if auth_email.get("subject") else {}),
        **(
            {"call_to_action_text": auth_email["callToActionText"]}
            if auth_email.get("callToActionText")
            else {}
        ),
        **(
            {"verify_template": auth_email["verifyTemplate"]}
            if auth_email.get("verifyTemplate")
            else {}
        ),
        **(
            {"custom_content": auth_email["customContent"]}
            if auth_email.get("customContent")
            else {}
        ),
        **(
            {"custom_closing_content": auth_email["customClosingContent"]}
            if auth_email.get("customClosingContent")
            else {}
        ),
    }


def build_auth_mobile_config(auth_mobile: object) -> JsonDict:
    auth_mobile = as_json_dict(auth_mobile)
    return {
        **({"title": auth_mobile["title"]} if auth_mobile.get("title") else {}),
        **({"image": auth_mobile["image"]} if auth_mobile.get("image") else {}),
        **(
            {"call_to_action_text": auth_mobile["callToActionText"]}
            if auth_mobile.get("callToActionText")
            else {}
        ),
        **(
            {"hyperlink_text": auth_mobile["hyperlinkText"]}
            if auth_mobile.get("hyperlinkText")
            else {}
        ),
        **(
            {"hyperlink_redirect_url": auth_mobile["hyperlinkRedirectUrl"]}
            if auth_mobile.get("hyperlinkRedirectUrl")
            else {}
        ),
        **(
            {"custom_content": auth_mobile["customContent"]}
            if auth_mobile.get("customContent")
            else {}
        ),
    }


def build_legal_config(legal: object) -> JsonDict:
    legal = as_json_dict(legal)
    return {
        **({"company_name": legal["companyName"]} if legal.get("companyName") else {}),
        **(
            {"privacy_policy_url": legal["privacyPolicyUrl"]}
            if legal.get("privacyPolicyUrl")
            else {}
        ),
        **(
            {"terms_conditions_url": legal["termsConditionsUrl"]}
            if legal.get("termsConditionsUrl")
            else {}
        ),
        **({"support_email": legal["supportEmail"]} if legal.get("supportEmail") else {}),
    }


def build_profile_config(profile: object) -> JsonDict:
    profile = as_json_dict(profile)
    return {
        **(
            {"account_information": profile["accountInformation"]}
            if profile.get("accountInformation")
            else {}
        ),
        **(
            {"personal_information": profile["personalInformation"]}
            if profile.get("personalInformation")
            else {}
        ),
        **({"preferences": profile["preferences"]} if profile.get("preferences") else {}),
        **({"sign_out_button": profile["signOutButton"]} if profile.get("signOutButton") else {}),
        **(
            {"delete_account_button": profile["deleteAccountButton"]}
            if profile.get("deleteAccountButton")
            else {}
        ),
        **(
            {"add_sign_in_methods_button": profile["addSignInMethodsButton"]}
            if profile.get("addSignInMethodsButton")
            else {}
        ),
    }


def build_custom_content_config(custom_content: object) -> JsonDict:
    custom_content = as_json_dict(custom_content)
    return {
        **(
            {"sign_in_modal": build_sign_in_modal_config(custom_content.get("signInModal"))}
            if custom_content.get("signInModal")
            else {}
        ),
        **(
            {"profile_modal": custom_content["profileModal"]}
            if custom_content.get("profileModal")
            else {}
        ),
        **(
            {
                "verification_modal": build_verification_modal_config(
                    custom_content.get("verificationModal")
                )
            }
            if custom_content.get("verificationModal")
            else {}
        ),
        **(
            {
                "sign_in_failure_modal": {
                    "failure_message": as_json_dict(custom_content.get("signInFailureModal")).get(
                        "failureMessage"
                    )
                }
            }
            if custom_content.get("signInFailureModal")
            else {}
        ),
        **(
            {"no_account_message": custom_content["noAccountMessage"]}
            if custom_content.get("noAccountMessage")
            else {}
        ),
        **({"mobile": custom_content["mobile"]} if custom_content.get("mobile") else {}),
    }


def build_sign_in_modal_config(sign_in_modal: object) -> JsonDict:
    sign_in_modal = as_json_dict(sign_in_modal)
    return {
        **({"title": sign_in_modal["title"]} if sign_in_modal.get("title") else {}),
        **({"subtitle": sign_in_modal["subtitle"]} if sign_in_modal.get("subtitle") else {}),
        **(
            {"sign_in_title": sign_in_modal["signInTitle"]}
            if sign_in_modal.get("signInTitle")
            else {}
        ),
        **(
            {"sign_up_title": sign_in_modal["signUpTitle"]}
            if sign_in_modal.get("signUpTitle")
            else {}
        ),
        **(
            {"sign_in_subtitle": sign_in_modal["signInSubtitle"]}
            if sign_in_modal.get("signInSubtitle")
            else {}
        ),
        **(
            {"sign_up_subtitle": sign_in_modal["signUpSubtitle"]}
            if sign_in_modal.get("signUpSubtitle")
            else {}
        ),
        **(
            {"sign_in_button": sign_in_modal["signInButton"]}
            if sign_in_modal.get("signInButton")
            else {}
        ),
        **(
            {"sign_up_button": sign_in_modal["signUpButton"]}
            if sign_in_modal.get("signUpButton")
            else {}
        ),
    }


def build_verification_modal_config(verification_modal: object) -> JsonDict:
    verification_modal = as_json_dict(verification_modal)
    return {
        **({"title": verification_modal["title"]} if verification_modal.get("title") else {}),
        **(
            {"subtitle": verification_modal["subtitle"]}
            if verification_modal.get("subtitle")
            else {}
        ),
    }


def is_instant_anonymous_method(methods_array: List[JsonDict]) -> bool:
    return any(
        isinstance(item, dict)
        and item.get("method") == "anonymous"
        and item.get("type") == "instant"
        for item in methods_array
    )


def build_google_one_tap_config(value: object) -> JsonDict:
    one_tap = as_json_dict(value)
    return {
        "browser": build_one_tap_platform_config(one_tap.get("browser")),
        "mobile_app": build_one_tap_platform_config(one_tap.get("mobileApp")),
    }


def build_one_tap_platform_config(value: object) -> JsonDict:
    platform = as_json_dict(value)
    auto_prompt = platform.get("autoPrompt")
    delay = platform.get("delay")
    return {
        "auto_prompt": auto_prompt if isinstance(auto_prompt, bool) else False,
        "delay": delay if isinstance(delay, (int, float)) else 7000,
    }


def snake_case_auth_order(value: object) -> JsonDict:
    if not isinstance(value, dict):
        return {}
    result = {}
    for key, item in value.items():
        snake_key = "auto_prompt" if key == "autoPrompt" else key
        result[snake_key] = snake_case_auth_order(item) if isinstance(item, dict) else item
    return result

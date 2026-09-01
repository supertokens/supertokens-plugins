from __future__ import annotations

import re
from typing import Any, Dict, Optional, Tuple, cast
from urllib.parse import parse_qsl, urlencode, urljoin, urlparse, urlunparse

from supertokens_python.framework.request import BaseRequest
from supertokens_python.framework.response import BaseResponse
from supertokens_python.types.base import UserContext

from .config import as_json_dict
from .constants import (
    NATIVE_EMAIL_VERIFICATION_UPGRADE_REQUIRED_MESSAGE,
    PENDING_EMAIL_VERIFICATION_QUERY_PARAM,
    PUBLIC_TENANT_ID,
    ROWND_OAUTH_LOGIN_CHALLENGE_PARAM,
)
from .errors import RowndPluginError
from .types import JsonDict, RowndPluginConfig


_PENDING_EMAIL_VERIFICATION_USER_CONTEXT_KEY = "_rowndPendingEmailVerificationId"


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


def json_response(response: BaseResponse, body: JsonDict, status_code: int = 200) -> BaseResponse:
    response.set_status_code(status_code)
    response.set_json_content(body)
    return response


async def get_json_body(request: BaseRequest) -> JsonDict:
    return as_json_dict(await request.json())


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


def create_pending_email_verification_user_context(
    user_context: UserContext, pending_verification_id: str
) -> UserContext:
    return create_derived_user_context(
        user_context,
        {_PENDING_EMAIL_VERIFICATION_USER_CONTEXT_KEY: pending_verification_id},
    )


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


def clear_supertokens_core_call_cache(user_context: UserContext) -> None:
    default_context = user_context.get("_default") if isinstance(user_context, dict) else None
    if not isinstance(default_context, dict):
        return
    if isinstance(default_context.get("coreCallCache"), dict):
        default_context["coreCallCache"] = {}
    if isinstance(default_context.get("core_call_cache"), dict):
        default_context["core_call_cache"] = {}

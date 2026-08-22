from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any, Dict, Optional, cast

import pytest
from supertokens_python.recipe.accountlinking.types import (
    AccountInfoWithRecipeId,
    ShouldNotAutomaticallyLink,
)
from supertokens_python.recipe.thirdparty.types import ThirdPartyInfo
from supertokens_python.types import LoginMethod, User

from supertokens_rownd import plugin
import supertokens_rownd.plugin_implementation as impl
from supertokens_rownd.constants import ROWND_JWT_CLAIMS
from supertokens_rownd.types import RowndPluginConfig


pytestmark = pytest.mark.asyncio


class FakeRequest:
    def __init__(self, query: Optional[Dict[str, str]] = None):
        self.query = query or {}

    def get_query_param(self, key: str) -> Optional[str]:
        return self.query.get(key)


class FakeSession:
    def __init__(self, user_id: str = "session-user"):
        self.user_id = user_id

    def get_user_id(self, user_context: Optional[Dict[str, Any]] = None) -> str:
        return self.user_id


class RefreshSession:
    def __init__(self, payload: Dict[str, Any]):
        self.payload = payload
        self.merged: Optional[Dict[str, Any]] = None

    def get_access_token_payload(self, user_context: Dict[str, Any]) -> Dict[str, Any]:
        return self.payload

    def get_recipe_user_id(self, user_context: Dict[str, Any]) -> Any:
        return SimpleNamespace(get_as_string=lambda: "recipe-user")

    def get_tenant_id(self, user_context: Dict[str, Any]) -> str:
        return "public"

    async def merge_into_access_token_payload(
        self, claims: Dict[str, Any], user_context: Dict[str, Any]
    ) -> None:
        self.merged = claims


def make_config() -> RowndPluginConfig:
    return RowndPluginConfig(rownd_app_key="app-key", rownd_app_secret="secret")


class CapturingDelivery:
    def __init__(self) -> None:
        self.template_vars: Any = None
        self.user_context: Dict[str, Any] = {}

    async def send_email(self, template_vars: Any, user_context: Dict[str, Any]) -> None:
        self.template_vars = template_vars
        self.user_context = user_context

    async def send_sms(self, template_vars: Any, user_context: Dict[str, Any]) -> None:
        self.template_vars = template_vars
        self.user_context = user_context


async def test_passwordless_email_delivery_rewrites_magic_link():
    original = CapturingDelivery()
    override = plugin.RowndEmailDeliveryOverride(
        cast(Any, original), make_config(), "url_with_link_code", "account/login"
    )
    template_vars = SimpleNamespace(
        url_with_link_code="https://api.example.com/auth/verify?preAuthSessionId=preauth"
    )

    await override.send_email(template_vars, {"rowndAppVariantId": "variant_123"})

    assert original.template_vars.url_with_link_code == (
        "https://api.example.com/account/login?preAuthSessionId=preauth"
        "&appKey=app-key&apiBasePath=%2Fauth&appVariantId=variant_123"
    )


async def test_passwordless_sms_delivery_rewrites_magic_link():
    original = CapturingDelivery()
    override = plugin.RowndSMSDeliveryOverride(cast(Any, original), make_config())
    template_vars = SimpleNamespace(url_with_link_code="/auth/verify?linkCode=code")

    await override.send_sms(cast(Any, template_vars), {"rowndDisplayContext": "mobile_app"})

    assert original.template_vars.url_with_link_code == (
        "/account/login?linkCode=code&appKey=app-key&apiBasePath=%2Fauth&displayContext=mobile_app"
    )


async def test_delivery_rewrites_magic_link_to_configured_client_domain():
    original = CapturingDelivery()
    config = RowndPluginConfig(
        rownd_app_key="app-key",
        rownd_app_secret="secret",
        client_domains={"mobile": "myapp://", "browser": "https://app.example.com"},
    )
    override = plugin.RowndEmailDeliveryOverride(
        cast(Any, original), config, "url_with_link_code", "account/login"
    )
    template_vars = SimpleNamespace(
        url_with_link_code="https://api.example.com/auth/verify?preAuthSessionId=preauth#hash"
    )

    await override.send_email(template_vars, {"rowndDisplayContext": "mobile_app"})

    assert original.template_vars.url_with_link_code == (
        "myapp://account/login?preAuthSessionId=preauth&appKey=app-key&apiBasePath=%2Fauth"
        "&displayContext=mobile_app#hash"
    )


async def test_delivery_uses_mobile_https_client_domain():
    original = CapturingDelivery()
    config = RowndPluginConfig(
        rownd_app_key="app-key",
        rownd_app_secret="secret",
        client_domains={
            "mobile": "https://mobile.example.com",
            "browser": "https://app.example.com",
        },
    )
    override = plugin.RowndEmailDeliveryOverride(
        cast(Any, original), config, "url_with_link_code", "account/login"
    )
    template_vars = SimpleNamespace(
        url_with_link_code="https://api.example.com/auth/verify?linkCode=code"
    )

    await override.send_email(template_vars, {"rowndDisplayContext": "mobile_app"})

    assert original.template_vars.url_with_link_code == (
        "https://mobile.example.com/account/login?linkCode=code&appKey=app-key"
        "&apiBasePath=%2Fauth&displayContext=mobile_app"
    )


async def test_delivery_uses_explicit_client_domain_key():
    original = CapturingDelivery()
    config = RowndPluginConfig(
        rownd_app_key="app-key",
        rownd_app_secret="secret",
        client_domains={"admin": "https://admin.example.com"},
    )
    override = plugin.RowndEmailDeliveryOverride(
        cast(Any, original), config, "url_with_link_code", "account/login"
    )
    template_vars = SimpleNamespace(url_with_link_code="/auth/verify?linkCode=code")

    await override.send_email(template_vars, {"rowndClientDomain": "admin"})

    assert original.template_vars.url_with_link_code == (
        "https://admin.example.com/account/login?linkCode=code&appKey=app-key&apiBasePath=%2Fauth"
    )


async def test_delivery_keeps_hub_link_when_requested_client_domain_missing():
    original = CapturingDelivery()
    config = RowndPluginConfig(
        rownd_app_key="app-key",
        rownd_app_secret="secret",
        client_domains={"browser": "https://app.example.com"},
    )
    override = plugin.RowndEmailDeliveryOverride(
        cast(Any, original), config, "url_with_link_code", "account/login"
    )
    template_vars = SimpleNamespace(url_with_link_code="/auth/verify?linkCode=code")

    await override.send_email(template_vars, {"rowndClientDomain": "missing"})

    assert original.template_vars.url_with_link_code == (
        "/account/login?linkCode=code&appKey=app-key&apiBasePath=%2Fauth"
    )


async def test_emailverification_delivery_rewrites_verify_link():
    original = CapturingDelivery()
    override = plugin.RowndEmailDeliveryOverride(
        cast(Any, original), make_config(), "email_verify_link", "account/verify-email"
    )
    template_vars = SimpleNamespace(email_verify_link="/auth/verify?token=token")

    await override.send_email(template_vars, {"rowndRedirectToPath": "/settings"})

    assert original.template_vars.email_verify_link == (
        "/account/verify-email?token=token&appKey=app-key&apiBasePath=%2Fauth"
        "&redirectToPath=%2Fsettings"
    )


async def test_emailverification_delivery_uses_mobile_client_domain():
    original = CapturingDelivery()
    config = RowndPluginConfig(
        rownd_app_key="app-key",
        rownd_app_secret="secret",
        client_domains={"mobile": "myapp://"},
    )
    override = plugin.RowndEmailDeliveryOverride(
        cast(Any, original), config, "email_verify_link", "account/verify-email"
    )
    template_vars = SimpleNamespace(
        email_verify_link="https://api.example.com/auth/verify?token=token"
    )

    await override.send_email(template_vars, {"rowndDisplayContext": "mobile_app"})

    assert original.template_vars.email_verify_link == (
        "myapp://account/verify-email?token=token&appKey=app-key&apiBasePath=%2Fauth"
        "&displayContext=mobile_app"
    )


async def test_emailverification_delivery_uses_explicit_client_domain_key():
    original = CapturingDelivery()
    config = RowndPluginConfig(
        rownd_app_key="app-key",
        rownd_app_secret="secret",
        client_domains={"browser_local": "http://localhost:3000"},
    )
    override = plugin.RowndEmailDeliveryOverride(
        cast(Any, original), config, "email_verify_link", "account/verify-email"
    )
    template_vars = SimpleNamespace(email_verify_link="/auth/verify?token=token")

    await override.send_email(template_vars, {"rowndClientDomain": "browser_local"})

    assert original.template_vars.email_verify_link == (
        "http://localhost:3000/account/verify-email?token=token&appKey=app-key&apiBasePath=%2Fauth"
    )


async def test_passwordless_create_code_adds_rownd_context():
    captured_context: Dict[str, Any] = {}

    async def create_code_post(
        email: Optional[str],
        phone_number: Optional[str],
        session_: Any,
        should_try_linking_with_session_user: Optional[bool],
        tenant_id: str,
        api_options: Any,
        user_context: Dict[str, Any],
    ):
        captured_context.update(user_context)
        return SimpleNamespace(status="OK")

    original = SimpleNamespace(create_code_post=create_code_post, consume_code_post=None)
    overridden = plugin._passwordless_api_override(make_config())(cast(Any, original))

    await overridden.create_code_post(
        "user@example.com",
        None,
        None,
        None,
        "public",
        cast(
            Any,
            SimpleNamespace(
                request=FakeRequest(
                    {
                        "app_variant_id": "variant_123",
                        "rownd_display_context": "mobile_app",
                        "rownd_redirect_to_path": "/dashboard",
                        "rownd_client_domain": "admin",
                        "rownd_oauth_login_challenge": "challenge_123",
                    }
                )
            ),
        ),
        {"existing": "value"},
    )

    assert captured_context == {
        "_default": {},
        "existing": "value",
        "rowndAppVariantId": "variant_123",
        "rowndDisplayContext": "mobile_app",
        "rowndRedirectToPath": "/dashboard",
        "rowndClientDomain": "admin",
        "rowndOAuthLoginChallenge": "challenge_123",
    }


async def test_passwordless_resend_code_adds_rownd_context():
    captured_context: Dict[str, Any] = {}

    async def resend_code_post(
        device_id: str,
        pre_auth_session_id: str,
        session_: Any,
        should_try_linking_with_session_user: Optional[bool],
        tenant_id: str,
        api_options: Any,
        user_context: Dict[str, Any],
    ):
        captured_context.update(user_context)
        return SimpleNamespace(status="OK")

    original = SimpleNamespace(
        create_code_post=None, consume_code_post=None, resend_code_post=resend_code_post
    )
    overridden = plugin._passwordless_api_override(make_config())(cast(Any, original))

    await overridden.resend_code_post(
        "device",
        "pre-auth",
        None,
        None,
        "public",
        cast(
            Any,
            SimpleNamespace(
                request=FakeRequest(
                    {
                        "app_variant_id": "variant_123",
                        "rownd_oauth_login_challenge": "challenge_123",
                    }
                )
            ),
        ),
        {"existing": "value"},
    )

    assert captured_context == {
        "_default": {},
        "existing": "value",
        "rowndAppVariantId": "variant_123",
        "rowndDisplayContext": None,
        "rowndRedirectToPath": None,
        "rowndClientDomain": None,
        "rowndOAuthLoginChallenge": "challenge_123",
    }


async def test_passwordless_email_delivery_rewrites_oauth_login_challenge():
    original = CapturingDelivery()
    override = plugin.RowndEmailDeliveryOverride(
        cast(Any, original), make_config(), "url_with_link_code", "account/login"
    )
    template_vars = SimpleNamespace(url_with_link_code="/auth/verify?linkCode=code")

    await override.send_email(template_vars, {"rowndOAuthLoginChallenge": "challenge_123"})

    assert "oauthLoginChallenge=challenge_123" in original.template_vars.url_with_link_code


async def test_passwordless_delivery_marks_combined_code_and_link_flow():
    original = CapturingDelivery()
    override = plugin.RowndEmailDeliveryOverride(
        cast(Any, original), make_config(), "url_with_link_code", "account/login"
    )
    template_vars = SimpleNamespace(
        url_with_link_code="/auth/verify?linkCode=code", user_input_code="123456"
    )

    await override.send_email(template_vars, {})

    assert (
        "passwordlessFlowType=USER_INPUT_CODE_AND_MAGIC_LINK"
        in original.template_vars.url_with_link_code
    )


async def test_init_rejects_invalid_client_domain():
    with pytest.raises(ValueError, match="Invalid client_domains.browser"):
        plugin.init(
            RowndPluginConfig(
                rownd_app_key="app-key",
                rownd_app_secret="secret",
                client_domains={"browser": "not-a-url"},
            )
        )


async def test_passwordless_create_code_rejects_unknown_app_variant():
    called = False

    async def create_code_post(
        email: Optional[str],
        phone_number: Optional[str],
        session_: Any,
        should_try_linking_with_session_user: Optional[bool],
        tenant_id: str,
        api_options: Any,
        user_context: Dict[str, Any],
    ):
        nonlocal called
        called = True
        return SimpleNamespace(status="OK")

    config = make_config()
    config.sub_brands = {"known": {"id": "app"}}
    original = SimpleNamespace(create_code_post=create_code_post, consume_code_post=None)
    overridden = plugin._passwordless_api_override(config)(cast(Any, original))

    with pytest.raises(Exception, match="Unknown Rownd app variant: missing"):
        await overridden.create_code_post(
            "user@example.com",
            None,
            None,
            None,
            "public",
            cast(Any, SimpleNamespace(request=FakeRequest({"app_variant_id": "missing"}))),
            {},
        )

    assert called is False


async def test_plugin_routes_use_explicit_api_base_path():
    rownd_plugin = plugin.init(
        RowndPluginConfig(
            rownd_app_key="app-key",
            rownd_app_secret="secret",
            api_base_path="/api/auth",
        )
    )

    route_handlers = cast(Any, rownd_plugin.route_handlers)
    result = route_handlers(cast(Any, None), [], "0.31.3")
    paths = {handler.path for handler in result.route_handlers}

    assert "/api/auth/plugin/rownd/app-config" in paths
    assert "/api/auth/plugin/migrate-session" in paths


async def test_account_management_routes_check_session_database():
    rownd_plugin = plugin.init(make_config())
    route_handlers = cast(Any, rownd_plugin.route_handlers)
    result = route_handlers(cast(Any, None), [], "0.31.3")
    account_routes = [
        handler
        for handler in result.route_handlers
        if handler.path.startswith("/auth/plugin/rownd/user")
        or handler.path == "/auth/plugin/rownd/signout"
    ]

    assert account_routes
    assert all(handler.verify_session_options.check_database for handler in account_routes)


async def test_init_rejects_non_positive_email_change_session_age():
    with pytest.raises(
        ValueError, match="email_change.max_session_age_seconds must be a positive number"
    ):
        plugin.init(
            RowndPluginConfig(
                rownd_app_key="app-key",
                rownd_app_secret="secret",
                email_change={"max_session_age_seconds": 0},
            )
        )


async def test_disabled_migration_omits_migration_routes():
    with pytest.warns(UserWarning, match="migration is disabled"):
        rownd_plugin = plugin.init(
            RowndPluginConfig(disable_rownd_user_migration=True, api_base_path="/api/auth")
        )

    route_handlers = cast(Any, rownd_plugin.route_handlers)
    result = route_handlers(cast(Any, None), [], "0.31.3")
    paths = {handler.path for handler in result.route_handlers}

    assert "/api/auth/plugin/rownd/migrate" not in paths
    assert "/api/auth/plugin/migrate-session" not in paths
    assert "/api/auth/plugin/rownd/guest" in paths


async def test_oauth_scopes_are_deduplicated():
    async def get_requested_scopes(
        recipe_user_id: Any,
        session_handle: Any,
        scope_param: list[str],
        client_id: str,
        user_context: Dict[str, Any],
    ):
        return ["openid", "profile", "email", "phone", "phone", ""]

    original = SimpleNamespace(
        get_requested_scopes=get_requested_scopes,
        build_access_token_payload=None,
        build_id_token_payload=None,
        build_user_info=None,
    )
    overridden = plugin._oauth2provider_function_override(make_config())(cast(Any, original))

    assert await overridden.get_requested_scopes(None, None, [], "client-id", {}) == [
        "openid",
        "profile",
        "email",
        "phone",
    ]


async def test_oauth_auth_get_translates_resource_to_audience():
    captured: Dict[str, Any] = {}

    async def auth_get(
        params: Dict[str, Any],
        cookie: Any,
        session: Any,
        should_try_refresh: bool,
        options: Any,
        user_context: Dict[str, Any],
    ):
        captured["params"] = params
        captured["user_context"] = user_context
        return SimpleNamespace(status="OK")

    original = SimpleNamespace(auth_get=auth_get, token_post=None)
    overridden = plugin._oauth2provider_api_override()(cast(Any, original))
    params = {"resource": "app:app_123", "client_id": "client_123"}
    user_context: Dict[str, Any] = {}

    await overridden.auth_get(params, None, None, False, cast(Any, None), user_context)

    assert captured["params"] == {"client_id": "client_123", "audience": "app:app_123"}
    assert captured["user_context"] == {
        "_default": {},
        "rowndOAuthAudience": "app:app_123",
    }
    assert user_context == {"_default": {}}


async def test_oauth_token_post_translates_resource_to_audience():
    captured: Dict[str, Any] = {}

    async def token_post(
        authorization_header: Any,
        body: Dict[str, Any],
        options: Any,
        user_context: Dict[str, Any],
    ):
        captured["body"] = body
        captured["user_context"] = user_context
        return SimpleNamespace(status="OK")

    original = SimpleNamespace(auth_get=None, token_post=token_post)
    overridden = plugin._oauth2provider_api_override()(cast(Any, original))
    body = {"resource": "app:app_123", "grant_type": "client_credentials"}
    user_context: Dict[str, Any] = {}

    await overridden.token_post(None, body, cast(Any, None), user_context)

    assert captured["body"] == {"grant_type": "client_credentials", "audience": "app:app_123"}
    assert captured["user_context"] == {
        "_default": {},
        "rowndOAuthAudience": "app:app_123",
    }
    assert user_context == {"_default": {}}


async def test_rownd_oauth_payload_adds_standard_and_rownd_claims(monkeypatch: pytest.MonkeyPatch):
    login_method = LoginMethod(
        "passwordless",
        "recipe-user",
        ["public"],
        "oauth@example.com",
        None,
        None,
        None,
        1000,
        True,
    )
    user = User(
        "st-user",
        False,
        ["public"],
        ["fallback@example.com"],
        [],
        [],
        cast(Any, []),
        [login_method],
        1000,
    )

    async def get_user(user_id: str, user_context: Any = None):
        return user

    async def get_user_metadata(user_id: str):
        return {
            "original_rownd_user": {
                "data": {
                    "user_id": "rownd-user",
                    "email": "oauth@example.com",
                    "first_name": "Ada",
                    "last_name": "Lovelace",
                },
                "verified_data": {"email": True},
            }
        }

    async def inspect(user_id: str, user_context: Any = None, user_override: Any = None):
        return {
            "user": user_override or user,
            "combined_metadata": await get_user_metadata(user_id),
        }

    monkeypatch.setattr(impl, "inspect_linked_user_metadata", inspect)

    payload = await impl.build_rownd_oauth_payload(
        make_config(),
        user,
        ["email", "profile"],
        {"existing": "claim"},
        {"rowndOAuthAudience": "app:app_123"},
    )

    assert payload["existing"] == "claim"
    assert payload["email"] == "oauth@example.com"
    assert payload["email_verified"] is True
    assert payload["name"] == "Ada Lovelace"
    assert payload["app_user_id"] == "rownd-user"
    assert payload["auth_level"] == "verified"
    assert payload[ROWND_JWT_CLAIMS["app_user_id"]] == "rownd-user"
    assert payload["aud"] == "app:app_123"


async def test_rownd_oauth_user_info_picks_rownd_claims(monkeypatch: pytest.MonkeyPatch):
    user = User("st-user", False, ["public"], ["user@example.com"], [], [], cast(Any, []), [], 1000)

    async def get_user_metadata(user_id: str):
        return {}

    async def inspect(user_id: str, user_context: Any = None, user_override: Any = None):
        return {"user": user_override or user, "combined_metadata": {}}

    monkeypatch.setattr(impl, "inspect_linked_user_metadata", inspect)

    user_info = await impl.build_rownd_oauth_user_info(
        user,
        {
            "app_user_id": "rownd-user",
            "auth_level": "verified",
            ROWND_JWT_CLAIMS["is_verified_user"]: True,
            "ignored": "claim",
        },
        ["email"],
        {"sub": "st-user"},
    )

    assert user_info == {
        "sub": "st-user",
        "email": "user@example.com",
        "email_verified": False,
        "app_user_id": "rownd-user",
        "auth_level": "verified",
        ROWND_JWT_CLAIMS["is_verified_user"]: True,
    }


async def test_passwordless_consume_records_app_variant_before_refresh(
    monkeypatch: pytest.MonkeyPatch,
):
    events: list[tuple[str, str, Optional[str]]] = []
    returned_session = SimpleNamespace()

    async def record_variant(
        config: RowndPluginConfig,
        user_id: str,
        app_variant_id: Optional[str],
        user_context: Dict[str, Any],
    ):
        events.append(("record", user_id, app_variant_id))

    async def refresh_claims(
        config: RowndPluginConfig,
        session: Any,
        user_id: str,
        app_variant_id: Optional[str],
        user_context: Dict[str, Any],
    ):
        assert session is returned_session
        events.append(("refresh", user_id, app_variant_id))

    async def consume_code_post(
        pre_auth_session_id: str,
        user_input_code: Optional[str],
        device_id: Optional[str],
        link_code: Optional[str],
        session_: Any,
        should_try_linking_with_session_user: Optional[bool],
        tenant_id: str,
        api_options: Any,
        user_context: Dict[str, Any],
    ):
        assert user_context["rowndAppVariantId"] == "variant_123"
        return SimpleNamespace(
            status="OK", user=SimpleNamespace(id="passwordless-user"), session=returned_session
        )

    monkeypatch.setattr(plugin, "record_rownd_app_variant_for_user", record_variant)
    monkeypatch.setattr(plugin, "refresh_rownd_session_claims", refresh_claims)
    original = SimpleNamespace(create_code_post=None, consume_code_post=consume_code_post)
    overridden = plugin._passwordless_api_override(make_config())(cast(Any, original))

    await overridden.consume_code_post(
        "preauth",
        None,
        None,
        "link-code",
        None,
        None,
        "public",
        cast(Any, SimpleNamespace(request=FakeRequest({"app_variant_id": "variant_123"}))),
        {},
    )

    assert events == [
        ("record", "passwordless-user", "variant_123"),
        ("refresh", "passwordless-user", "variant_123"),
    ]


async def test_passwordless_consume_rejects_unknown_app_variant():
    async def consume_code_post(
        pre_auth_session_id: str,
        user_input_code: Optional[str],
        device_id: Optional[str],
        link_code: Optional[str],
        session_: Any,
        should_try_linking_with_session_user: Optional[bool],
        tenant_id: str,
        api_options: Any,
        user_context: Dict[str, Any],
    ):
        return SimpleNamespace(status="OK", user=SimpleNamespace(id="passwordless-user"))

    config = make_config()
    config.sub_brands = {"known": {"id": "app"}}
    original = SimpleNamespace(create_code_post=None, consume_code_post=consume_code_post)
    overridden = plugin._passwordless_api_override(config)(cast(Any, original))

    with pytest.raises(Exception, match="Unknown Rownd app variant: missing"):
        await overridden.consume_code_post(
            "preauth",
            None,
            None,
            "link-code",
            None,
            None,
            "public",
            cast(Any, SimpleNamespace(request=FakeRequest({"app_variant_id": "missing"}))),
            {},
        )


async def test_thirdparty_sign_in_records_app_variant_before_refresh(
    monkeypatch: pytest.MonkeyPatch,
):
    events: list[tuple[str, str, Optional[str]]] = []
    returned_session = SimpleNamespace()

    async def record_variant(
        config: RowndPluginConfig,
        user_id: str,
        app_variant_id: Optional[str],
        user_context: Dict[str, Any],
    ):
        events.append(("record", user_id, app_variant_id))

    async def refresh_claims(
        config: RowndPluginConfig,
        session: Any,
        user_id: str,
        app_variant_id: Optional[str],
        user_context: Dict[str, Any],
    ):
        assert session is returned_session
        events.append(("refresh", user_id, app_variant_id))

    async def sign_in_up_post(
        provider: Any,
        redirect_uri_info: Any,
        oauth_tokens: Any,
        session_: Any,
        should_try_linking_with_session_user: Optional[bool],
        tenant_id: str,
        api_options: Any,
        user_context: Dict[str, Any],
    ):
        assert user_context["rowndAppVariantId"] == "variant_123"
        return SimpleNamespace(
            status="OK", user=SimpleNamespace(id="thirdparty-user"), session=returned_session
        )

    monkeypatch.setattr(plugin, "record_rownd_app_variant_for_user", record_variant)
    monkeypatch.setattr(plugin, "refresh_rownd_session_claims", refresh_claims)
    original = SimpleNamespace(sign_in_up_post=sign_in_up_post)
    overridden = plugin._thirdparty_api_override(make_config())(cast(Any, original))

    await overridden.sign_in_up_post(
        cast(Any, None),
        None,
        None,
        None,
        None,
        "public",
        cast(Any, SimpleNamespace(request=FakeRequest({"app_variant_id": "variant_123"}))),
        {},
    )

    assert events == [
        ("record", "thirdparty-user", "variant_123"),
        ("refresh", "thirdparty-user", "variant_123"),
    ]


@pytest.mark.parametrize("preserve_anonymous_id", [False, True])
async def test_refresh_rownd_session_claims_merges_and_clears_stale_claims(
    monkeypatch: pytest.MonkeyPatch, preserve_anonymous_id: bool
):
    payload = {
        "is_anonymous": True,
        ROWND_JWT_CLAIMS["is_anonymous"]: True,
        "anonymous_id": "anon-before-link",
    }
    session = RefreshSession(payload)

    async def build_claims(*_args: Any, **_kwargs: Any):
        return (
            {
                "auth_level": "verified",
                **({"anonymous_id": "anon-before-link"} if preserve_anonymous_id else {}),
            },
            {"is_anonymous": {"v": False, "t": 1}},
        )

    monkeypatch.setattr(plugin, "build_rownd_session_and_anonymous_claims", build_claims)

    await plugin.refresh_rownd_session_claims(
        make_config(), cast(Any, session), "linked-user", None, {}
    )

    assert session.merged is not None
    assert session.merged["is_anonymous"] == {"v": False, "t": 1}
    assert session.merged[ROWND_JWT_CLAIMS["is_anonymous"]] is None
    assert session.merged["anonymous_id"] == ("anon-before-link" if preserve_anonymous_id else None)
    assert "aud" not in session.merged


async def test_refresh_rownd_session_claims_clears_stale_configured_claim(
    monkeypatch: pytest.MonkeyPatch,
):
    config = RowndPluginConfig(
        rownd_app_key="app-key",
        rownd_app_secret="secret",
        schema={
            "role": {
                "include_in_session_claims": True,
                "session_claim_name": "authorization_role",
            },
            "nickname": {"include_in_session_claims": False},
        },
    )
    session = RefreshSession({"authorization_role": "admin", "nickname": "still-present"})

    async def build_claims(*_args: Any, **_kwargs: Any):
        return {"auth_level": "verified"}, {"is_anonymous": {"v": False, "t": 1}}

    monkeypatch.setattr(plugin, "build_rownd_session_and_anonymous_claims", build_claims)

    await plugin.refresh_rownd_session_claims(config, cast(Any, session), "user", None, {})

    assert session.merged is not None
    assert session.merged["authorization_role"] is None
    assert "nickname" not in session.merged


@pytest.mark.parametrize("revoke_outcome", ["success", "false", "exception"])
async def test_post_auth_refresh_revokes_session_without_masking_original_error(
    monkeypatch: pytest.MonkeyPatch, revoke_outcome: str
):
    refresh_error = RuntimeError("refresh failed")
    revoked: list[tuple[str, Dict[str, Any]]] = []
    revoked_for_user: list[tuple[str, bool, Optional[str], Dict[str, Any]]] = []
    context = {"rowndAppVariantId": "variant_123"}

    def get_handle(user_context: Dict[str, Any]) -> str:
        assert user_context is context
        return "returned-session-handle"

    session = SimpleNamespace(get_handle=get_handle)

    async def refresh(*_args: Any, **_kwargs: Any) -> None:
        raise refresh_error

    async def revoke(handle: str, user_context: Dict[str, Any]) -> bool:
        revoked.append((handle, user_context))
        if revoke_outcome == "exception":
            raise RuntimeError("revoke failed")
        return revoke_outcome == "success"

    async def revoke_all(
        user_id: str,
        revoke_sessions_for_linked_accounts: bool,
        tenant_id: Optional[str],
        user_context: Dict[str, Any],
    ) -> None:
        revoked_for_user.append(
            (user_id, revoke_sessions_for_linked_accounts, tenant_id, user_context)
        )
        raise RuntimeError("fallback revoke failed")

    monkeypatch.setattr(plugin, "refresh_rownd_session_claims", refresh)
    monkeypatch.setattr(plugin.session_asyncio, "revoke_session", revoke)
    monkeypatch.setattr(plugin.session_asyncio, "revoke_all_sessions_for_user", revoke_all)
    with pytest.raises(RuntimeError) as exc_info:
        await plugin._refresh_rownd_session_claims_or_revoke(
            make_config(), cast(Any, session), "user", "variant_123", context
        )

    assert exc_info.value is refresh_error
    assert revoked == [("returned-session-handle", context)]
    assert revoked_for_user == (
        [] if revoke_outcome == "success" else [("user", True, None, context)]
    )


async def test_create_new_session_builds_rownd_and_boolean_claims_in_initial_payload(
    monkeypatch: pytest.MonkeyPatch,
):
    recipe_user_id = SimpleNamespace(get_as_string=lambda: "recipe-user")
    captured_payload: Optional[Dict[str, Any]] = None

    async def build_claims(*_args: Any, **_kwargs: Any):
        return (
            {"auth_level": "instant", ROWND_JWT_CLAIMS["is_anonymous"]: True},
            {"is_anonymous": {"v": True, "t": 1}},
        )

    async def create_new_session(
        user_id: str,
        passed_recipe_user_id: Any,
        access_token_payload: Dict[str, Any],
        session_data_in_database: Any,
        disable_anti_csrf: Any,
        tenant_id: str,
        user_context: Dict[str, Any],
    ) -> str:
        nonlocal captured_payload
        assert user_id == "user"
        assert passed_recipe_user_id is recipe_user_id
        captured_payload = access_token_payload
        return "session"

    monkeypatch.setattr(plugin, "build_rownd_session_and_anonymous_claims", build_claims)
    original = SimpleNamespace(create_new_session=create_new_session)
    overridden = plugin._session_function_override(make_config())(cast(Any, original))

    result = await overridden.create_new_session(
        "user",
        cast(Any, recipe_user_id),
        {"existing": "claim"},
        {},
        None,
        "public",
        {"rowndAppVariantId": "variant_123"},
    )

    assert result == "session"
    assert captured_payload == {
        "existing": "claim",
        "auth_level": "instant",
        ROWND_JWT_CLAIMS["is_anonymous"]: True,
        "is_anonymous": {"v": True, "t": 1},
    }


async def test_thirdparty_sign_in_rejects_unknown_app_variant():
    async def sign_in_up_post(
        provider: Any,
        redirect_uri_info: Any,
        oauth_tokens: Any,
        session_: Any,
        should_try_linking_with_session_user: Optional[bool],
        tenant_id: str,
        api_options: Any,
        user_context: Dict[str, Any],
    ):
        return SimpleNamespace(status="OK", user=SimpleNamespace(id="thirdparty-user"))

    config = make_config()
    config.sub_brands = {"known": {"id": "app"}}
    original = SimpleNamespace(sign_in_up_post=sign_in_up_post)
    overridden = plugin._thirdparty_api_override(config)(cast(Any, original))

    with pytest.raises(Exception, match="Unknown Rownd app variant: missing"):
        await overridden.sign_in_up_post(
            cast(Any, None),
            None,
            None,
            None,
            None,
            "public",
            cast(Any, SimpleNamespace(request=FakeRequest({"app_variant_id": "missing"}))),
            {},
        )


async def test_emailverification_unmarked_verify_does_not_complete_pending_email(
    monkeypatch: pytest.MonkeyPatch,
):
    completed: list[tuple[str, str, Dict[str, Any], str]] = []

    async def complete_pending_email_verification(
        recipe_user_id: Any,
        email: str,
        user_context: Dict[str, Any],
        tenant_id: str,
        session_handle: Optional[str],
    ):
        assert session_handle is None
        completed.append((recipe_user_id.get_as_string(), email, user_context, tenant_id))

    async def email_verify_post(
        token: str,
        session_: Any,
        tenant_id: str,
        api_options: Any,
        user_context: Dict[str, Any],
    ):
        return SimpleNamespace(
            status="OK",
            user=SimpleNamespace(
                recipe_user_id=SimpleNamespace(get_as_string=lambda: "recipe-user"),
                email="verified@example.com",
            ),
        )

    monkeypatch.setattr(
        plugin, "complete_pending_email_verification", complete_pending_email_verification
    )
    original = SimpleNamespace(email_verify_post=email_verify_post)
    overridden = plugin._emailverification_api_override()(cast(Any, original))

    await overridden.email_verify_post(
        "token",
        None,
        "public",
        cast(Any, SimpleNamespace(request=FakeRequest())),
        {"source": "test"},
    )

    assert completed == []


async def test_emailverification_pending_marker_requires_session():
    called = False

    async def email_verify_post(*_args: Any, **_kwargs: Any):
        nonlocal called
        called = True
        return SimpleNamespace(status="OK")

    original = SimpleNamespace(email_verify_post=email_verify_post)
    overridden = plugin._emailverification_api_override()(cast(Any, original))

    result = await overridden.email_verify_post(
        "raw-token",
        None,
        "public",
        cast(
            Any,
            SimpleNamespace(request=FakeRequest({"rowndPendingVerificationId": "pending-id"})),
        ),
        {},
    )

    assert cast(Any, result).status == "GENERAL_ERROR"
    assert cast(Any, result).message == (
        "email change verification requires the initiating session"
    )
    assert called is False


async def test_emailverification_delivery_adds_pending_marker():
    original = CapturingDelivery()
    override = plugin.RowndEmailDeliveryOverride(
        cast(Any, original), make_config(), "email_verify_link", "account/verify-email"
    )
    template_vars = SimpleNamespace(email_verify_link="/auth/verify?token=raw-token")

    await override.send_email(
        template_vars,
        {
            "_rowndPendingEmailVerificationId": "pending-id",
            "rowndDisplayContext": "mobile_app",
        },
    )

    assert "token=raw-token" in original.template_vars.email_verify_link
    assert "rowndPendingVerificationId=pending-id" in original.template_vars.email_verify_link
    assert "displayContext=mobile_app" in original.template_vars.email_verify_link


async def test_email_change_context_is_sanitized():
    context = impl.build_email_change_user_context(
        {"trusted": "value"},
        {
            "rowndDisplayContext": "mobile_app",
            "rowndClientDomain": "mobile",
            "rowndNativeEmailVerification": True,
            "rowndRedirectToPath": "/untrusted",
            "trusted": "overwritten",
        },
    )

    assert context == {
        "_default": {},
        "trusted": "value",
        "rowndDisplayContext": "mobile_app",
        "rowndClientDomain": "mobile",
        "rowndNativeEmailVerification": True,
    }


@pytest.mark.parametrize(
    "invalid_binding",
    ["session_user", "session_tenant", "pending_session", "purpose", "status"],
)
async def test_pending_verification_binding_is_checked_before_token_use(
    monkeypatch: pytest.MonkeyPatch, invalid_binding: str
):
    session = SimpleNamespace(
        get_handle=lambda _context: "session-handle",
        get_user_id=lambda _context: "user-id",
        get_tenant_id=lambda _context: "public",
    )
    session_information = SimpleNamespace(
        session_handle="session-handle",
        user_id="user-id",
        tenant_id="public",
    )
    pending = {
        "id": "pending-id",
        "field": "email",
        "value": "target@example.com",
        "created_at": "2026-08-11T00:00:00Z",
        "tenantId": "public",
        "purpose": "UPDATE_PASSWORDLESS",
        "initiatingSessionHandle": "session-handle",
        "status": "PENDING",
    }
    if invalid_binding == "session_user":
        session_information.user_id = "other-user"
    elif invalid_binding == "session_tenant":
        session_information.tenant_id = "other-tenant"
    elif invalid_binding == "pending_session":
        pending["initiatingSessionHandle"] = "other-session"
    elif invalid_binding == "purpose":
        pending["purpose"] = "UNSAFE"
    else:
        pending["status"] = "COMMITTING"

    async def get_session_information(*_args: Any, **_kwargs: Any):
        return session_information

    async def get_user_metadata(*_args: Any, **_kwargs: Any):
        return {"rownd_pending_verification": [pending]}

    monkeypatch.setattr(impl.session_asyncio, "get_session_information", get_session_information)
    monkeypatch.setattr(impl, "get_raw_user_metadata", get_user_metadata)

    result = await impl.resolve_pending_email_verification_token(
        "raw-token", "pending-id", "public", cast(Any, session), {}
    )

    assert result == {"status": "INVALID_PENDING"}


async def test_replacement_session_failure_runs_email_change_rollback(
    monkeypatch: pytest.MonkeyPatch,
):
    rolled_back = False

    async def resolve_pending(*_args: Any, **_kwargs: Any):
        return {
            "status": "OK",
            "core_token": "raw-token",
            "pending_verification_id": "pending-id",
            "user_id": "user-id",
        }

    async def complete_pending(*_args: Any, **_kwargs: Any):
        async def rollback() -> None:
            nonlocal rolled_back
            rolled_back = True

        return {
            "recipe_user_id": SimpleNamespace(get_as_string=lambda: "recipe-user"),
            "initiating_session_handle": "session-handle",
            "rollback_on_session_replacement_failure": rollback,
        }

    async def email_verify_post(*_args: Any, **_kwargs: Any):
        return SimpleNamespace(
            status="OK",
            user=SimpleNamespace(
                recipe_user_id=SimpleNamespace(get_as_string=lambda: "recipe-user"),
                email="target@example.com",
            ),
        )

    async def create_new_session(*_args: Any, **_kwargs: Any):
        raise RuntimeError("replacement session failed")

    session = SimpleNamespace(
        get_handle=lambda _context: "session-handle",
        get_tenant_id=lambda _context: "public",
    )
    monkeypatch.setattr(plugin, "resolve_pending_email_verification_token", resolve_pending)
    monkeypatch.setattr(plugin, "complete_pending_email_verification", complete_pending)
    monkeypatch.setattr(plugin.session_asyncio, "create_new_session", create_new_session)
    overridden = plugin._emailverification_api_override()(
        cast(Any, SimpleNamespace(email_verify_post=email_verify_post))
    )

    with pytest.raises(RuntimeError, match="replacement session failed"):
        await overridden.email_verify_post(
            "raw-token",
            cast(Any, session),
            "public",
            cast(
                Any,
                SimpleNamespace(request=FakeRequest({"rowndPendingVerificationId": "pending-id"})),
            ),
            {},
        )

    assert rolled_back is True


async def test_accountlinking_links_guest_session_without_verification(
    monkeypatch: pytest.MonkeyPatch,
):
    async def get_user(user_id: str, user_context: Dict[str, Any]):
        return SimpleNamespace(
            login_methods=[
                SimpleNamespace(
                    recipe_id="thirdparty",
                    third_party=SimpleNamespace(id="guest", user_id="guest_123"),
                )
            ]
        )

    monkeypatch.setattr("supertokens_python.asyncio.get_user", get_user)
    original_config = SimpleNamespace(should_do_automatic_account_linking=None)
    overridden = cast(Any, plugin._accountlinking_config_override()(cast(Any, original_config)))

    result = await overridden.should_do_automatic_account_linking(
        AccountInfoWithRecipeId(recipe_id="passwordless", email="user@example.com"),
        None,
        FakeSession(),
        "public",
        {},
    )

    assert result.should_require_verification is False


async def test_accountlinking_does_not_link_without_session(monkeypatch: pytest.MonkeyPatch):
    async def list_users_by_account_info(*_args: Any, **_kwargs: Any):
        return []

    monkeypatch.setattr(
        "supertokens_python.asyncio.list_users_by_account_info", list_users_by_account_info
    )
    original_config = SimpleNamespace(should_do_automatic_account_linking=None)
    overridden = cast(Any, plugin._accountlinking_config_override()(cast(Any, original_config)))

    result = await overridden.should_do_automatic_account_linking(
        AccountInfoWithRecipeId(recipe_id="passwordless", email="user@example.com"),
        None,
        None,
        "public",
        {},
    )

    assert isinstance(result, ShouldNotAutomaticallyLink)


async def test_accountlinking_reconciliation_context_disables_linking():
    original_config = SimpleNamespace(should_do_automatic_account_linking=None)
    overridden = cast(Any, plugin._accountlinking_config_override()(cast(Any, original_config)))

    result = await overridden.should_do_automatic_account_linking(
        AccountInfoWithRecipeId(recipe_id="passwordless", email="user@example.com"),
        SimpleNamespace(login_methods=[]),
        None,
        "public",
        {"rowndDisableAutomaticAccountLinking": True},
    )

    assert isinstance(result, ShouldNotAutomaticallyLink)


async def test_accountlinking_links_verified_matching_email_without_session():
    original_config = SimpleNamespace(should_do_automatic_account_linking=None)
    overridden = cast(Any, plugin._accountlinking_config_override()(cast(Any, original_config)))
    email = "user@example.com"
    existing_user = SimpleNamespace(
        login_methods=[
            SimpleNamespace(
                recipe_id="passwordless",
                email=email,
                verified=True,
                tenant_ids=["public"],
                third_party=None,
            )
        ]
    )

    result = await overridden.should_do_automatic_account_linking(
        AccountInfoWithRecipeId(
            recipe_id="thirdparty",
            email=email,
            third_party=ThirdPartyInfo("google-user", "google"),
        ),
        existing_user,
        None,
        "public",
        {},
    )

    assert result.should_require_verification is True


@pytest.mark.parametrize(
    "login_methods",
    [
        [
            SimpleNamespace(
                recipe_id="passwordless",
                email="user@example.com",
                verified=False,
                tenant_ids=["public"],
                third_party=None,
            )
        ],
        [
            SimpleNamespace(
                recipe_id="passwordless",
                email="user@example.com",
                verified=True,
                tenant_ids=["tenant-b"],
                third_party=None,
            )
        ],
        [
            SimpleNamespace(
                recipe_id="passwordless",
                email="user@example.com",
                verified=True,
                tenant_ids=["public"],
                third_party=None,
            ),
            SimpleNamespace(
                recipe_id="thirdparty",
                email="user@example.com",
                verified=True,
                tenant_ids=["public"],
                third_party=SimpleNamespace(id="google", user_id="other-google-user"),
            ),
        ],
    ],
)
async def test_accountlinking_rejects_unsafe_matching_email_methods(login_methods: list[Any]):
    original_config = SimpleNamespace(should_do_automatic_account_linking=None)
    overridden = cast(Any, plugin._accountlinking_config_override()(cast(Any, original_config)))

    result = await overridden.should_do_automatic_account_linking(
        AccountInfoWithRecipeId(
            recipe_id="thirdparty",
            email="user@example.com",
            third_party=ThirdPartyInfo("google-user", "google"),
        ),
        SimpleNamespace(login_methods=login_methods),
        None,
        "public",
        {},
    )

    assert isinstance(result, ShouldNotAutomaticallyLink)


async def test_accountlinking_links_matching_real_session_with_verification(
    monkeypatch: pytest.MonkeyPatch,
):
    async def get_user(user_id: str, user_context: Dict[str, Any]):
        return SimpleNamespace(
            login_methods=[
                SimpleNamespace(
                    recipe_id="passwordless",
                    email="user@example.com",
                    phone_number=None,
                    third_party=None,
                    verified=True,
                    tenant_ids=["public"],
                )
            ]
        )

    monkeypatch.setattr("supertokens_python.asyncio.get_user", get_user)
    original_config = SimpleNamespace(should_do_automatic_account_linking=None)
    overridden = cast(Any, plugin._accountlinking_config_override()(cast(Any, original_config)))

    result = await overridden.should_do_automatic_account_linking(
        AccountInfoWithRecipeId(recipe_id="passwordless", email="USER@example.com"),
        None,
        FakeSession(),
        "public",
        {},
    )

    assert result.should_require_verification is True


async def test_derived_context_forwards_default_replacements_to_parent():
    original_default = {"core_call_cache": {"stale": True}}
    parent = {"_default": original_default, "custom": "value"}
    first = impl.create_derived_user_context(parent, {"temporary": "first"})
    second = impl.create_derived_user_context(parent, {"temporary": "second"})

    replacement = {"core_call_cache": {"fresh": True}}
    first["_default"] = replacement

    assert parent["_default"] is original_default
    assert parent["_default"] == replacement
    assert second.get("_default") is original_default
    assert second["_default"] is original_default
    assert "_default" in second
    assert dict(first)["_default"] is original_default
    assert dict(first.items())["_default"] is original_default
    assert original_default in first.values()
    assert first.copy()["_default"] is original_default

    final = {"core_call_cache": {}}
    second.update({"_default": final})
    assert parent["_default"] is original_default
    assert original_default == final

    second |= {"_default": {"core_call_cache": {"updated": True}}, "added": True}
    assert first["_default"] == {"core_call_cache": {"updated": True}}
    assert second["added"] is True

    empty_parent: Dict[str, Any] = {}
    derived = impl.create_derived_user_context(empty_parent, {"temporary": True})
    created = derived.setdefault("_default", {"ignored": True})
    assert empty_parent["_default"] is created
    assert created == {}
    assert derived.setdefault("local", "value") == "value"
    assert derived.pop("local") == "value"
    with pytest.raises(TypeError, match="cannot be removed"):
        derived.pop("_default")
    with pytest.raises(TypeError, match="cannot be removed"):
        del derived["_default"]
    assert derived.popitem() == ("temporary", True)
    with pytest.raises(TypeError, match="cannot be removed"):
        derived.popitem()
    derived.update({"temporary": True})
    derived.clear()
    assert dict(derived) == {"_default": created}

    with pytest.raises(TypeError, match="replacement must be a dict"):
        derived["_default"] = cast(Any, None)


async def test_derived_context_reproduces_querier_default_replacement():
    from supertokens_python.querier import Querier

    parent: Dict[str, Any] = {"_default": {"keep_cache_alive": True}}
    first = impl.create_derived_user_context(parent, {})
    second = impl.create_derived_user_context(parent, {})
    stable_default = parent["_default"]
    querier = object.__new__(Querier)

    querier.invalidate_core_call_cache(first)

    assert parent["_default"] is stable_default
    assert first["_default"] is stable_default
    assert second["_default"] is stable_default
    assert stable_default == {"keep_cache_alive": True, "core_call_cache": {}}
    assert dict(first)["_default"] is stable_default


async def test_passwordless_request_contexts_are_isolated_during_overlap():
    entered = 0
    both_entered = asyncio.Event()
    captured: list[Dict[str, Any]] = []

    async def create_code_post(*args: Any):
        nonlocal entered
        context = cast(Dict[str, Any], args[-1])
        captured.append(context)
        entered += 1
        if entered == 2:
            both_entered.set()
        await both_entered.wait()
        return SimpleNamespace(status="OK")

    original = SimpleNamespace(create_code_post=create_code_post, consume_code_post=None)
    overridden = plugin._passwordless_api_override(make_config())(cast(Any, original))
    parent: Dict[str, Any] = {
        "custom": "value",
        "rowndDisplayContext": "stale",
        "rowndClientDomain": "stale",
    }

    await asyncio.gather(
        overridden.create_code_post(
            "first@example.com",
            None,
            None,
            None,
            "public",
            cast(
                Any,
                SimpleNamespace(
                    request=FakeRequest(
                        {
                            "rownd_display_context": "mobile_app",
                            "rownd_client_domain": "mobile",
                        }
                    )
                ),
            ),
            parent,
        ),
        overridden.create_code_post(
            "second@example.com",
            None,
            None,
            None,
            "public",
            cast(Any, SimpleNamespace(request=FakeRequest())),
            parent,
        ),
    )

    assert captured[0] is not captured[1]
    assert captured[0]["rowndDisplayContext"] == "mobile_app"
    assert captured[0]["rowndClientDomain"] == "mobile"
    assert captured[1]["rowndDisplayContext"] is None
    assert captured[1]["rowndClientDomain"] is None
    assert parent == {
        "_default": {},
        "custom": "value",
        "rowndDisplayContext": "stale",
        "rowndClientDomain": "stale",
    }


async def test_security_flag_is_operation_local_across_awaits():
    parent: Dict[str, Any] = {"rowndDisableAutomaticAccountLinking": False}
    entered = asyncio.Event()
    release = asyncio.Event()

    async def operation():
        context = impl.create_derived_user_context(
            parent, {"rowndDisableAutomaticAccountLinking": True}
        )
        entered.set()
        await release.wait()
        return context["rowndDisableAutomaticAccountLinking"]

    task = asyncio.create_task(operation())
    await entered.wait()
    assert parent["rowndDisableAutomaticAccountLinking"] is False
    release.set()
    assert await task is True


async def test_normal_user_route_forwards_exact_context(monkeypatch: pytest.MonkeyPatch):
    parent: Dict[str, Any] = {"custom": object()}

    class ContextSession:
        def get_user_id(self, user_context: Dict[str, Any]) -> str:
            assert user_context is parent
            return "user"

        def get_tenant_id(self, user_context: Dict[str, Any]) -> str:
            assert user_context is parent
            return "public"

    async def get_compat_user(*args: Any, **kwargs: Any):
        assert kwargs["user_context"] is parent
        return {"data": {}}

    monkeypatch.setattr(impl, "get_rownd_compat_user", get_compat_user)
    response = SimpleNamespace(
        set_status_code=lambda _code: None, set_json_content=lambda _body: None
    )

    await impl.handle_get_user(
        make_config(), cast(Any, ContextSession()), cast(Any, response), parent
    )


async def test_session_claims_share_one_inspection_snapshot(monkeypatch: pytest.MonkeyPatch):
    context: Dict[str, Any] = {"custom": "value"}
    calls = 0
    user = SimpleNamespace(id="user", login_methods=[])

    async def inspect(user_id: str, user_context: Any = None, user_override: Any = None):
        nonlocal calls
        calls += 1
        assert user_context is context
        return {"user": user, "combined_metadata": {}}

    monkeypatch.setattr(impl, "inspect_linked_user_metadata", inspect)

    claims, anonymous = await impl.build_rownd_session_and_anonymous_claims(
        make_config(), "user", {}, None, context
    )

    assert calls == 1
    assert claims["app_user_id"] == "user"
    assert cast(Dict[str, Any], anonymous["is_anonymous"])["v"] is False


async def test_oauth_claims_share_one_metadata_inspection(monkeypatch: pytest.MonkeyPatch):
    context: Dict[str, Any] = {"rowndOAuthAudience": "app:app_123"}
    calls = 0
    user = User("user", False, ["public"], ["user@example.com"], [], [], cast(Any, []), [], 1)

    async def inspect(user_id: str, user_context: Any = None, user_override: Any = None):
        nonlocal calls
        calls += 1
        assert user_context is context
        assert user_override is user
        return {"user": user, "combined_metadata": {}}

    monkeypatch.setattr(impl, "inspect_linked_user_metadata", inspect)

    await impl.build_rownd_oauth_payload(make_config(), user, ["email"], {}, context)

    assert calls == 1


async def test_app_variant_uses_fresh_raw_metadata_before_write(
    monkeypatch: pytest.MonkeyPatch,
):
    context: Dict[str, Any] = {"_default": {"core_call_cache": {"metadata": "stale"}}}
    fresh_original = {
        "data": {"user_id": "rownd-user"},
        "verified_data": {},
        "attributes": {"preserved": True},
    }
    written: Dict[str, Any] = {}

    async def inspect(*args: Any, **kwargs: Any):
        return {
            "primary_user_id": "primary",
            "rownd_metadata_source_user_id": "source",
        }

    async def get_raw(user_id: str, user_context: Dict[str, Any]):
        assert user_id == "source"
        assert user_context is context
        assert user_context["_default"]["core_call_cache"] == {}
        return {"original_rownd_user": fresh_original}

    async def update(user_id: str, metadata: Dict[str, Any], user_context: Dict[str, Any]):
        written.update(metadata)
        return SimpleNamespace(metadata=metadata)

    monkeypatch.setattr(impl, "inspect_linked_user_metadata", inspect)
    monkeypatch.setattr(impl, "get_raw_user_metadata", get_raw)
    monkeypatch.setattr(impl.usermetadata_asyncio, "update_user_metadata", update)

    await impl.record_rownd_app_variant_for_user(make_config(), "user", "variant_123", context)

    original = cast(Dict[str, Any], written["original_rownd_user"])
    assert original["attributes"] == {
        "preserved": True,
        "rownd:app_variants": ["variant_123"],
    }

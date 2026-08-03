from __future__ import annotations

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

    def get_user_id(self) -> str:
        return self.user_id


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
        "existing": "value",
        "rowndAppVariantId": "variant_123",
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
    assert captured["user_context"] == {"rowndOAuthAudience": "app:app_123"}


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
    assert captured["user_context"] == {"rowndOAuthAudience": "app:app_123"}


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

    monkeypatch.setattr(impl, "get_user", get_user)
    monkeypatch.setattr(impl, "get_user_metadata", get_user_metadata)

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

    monkeypatch.setattr(impl, "get_user_metadata", get_user_metadata)

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


async def test_passwordless_consume_records_app_variant(monkeypatch: pytest.MonkeyPatch):
    recorded: list[tuple[str, Optional[str]]] = []

    async def record_variant(
        config: RowndPluginConfig, user_id: str, app_variant_id: Optional[str]
    ):
        recorded.append((user_id, app_variant_id))

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
        return SimpleNamespace(status="OK", user=SimpleNamespace(id="passwordless-user"))

    monkeypatch.setattr(plugin, "record_rownd_app_variant_for_user", record_variant)
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

    assert recorded == [("passwordless-user", "variant_123")]


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


async def test_thirdparty_sign_in_records_app_variant(monkeypatch: pytest.MonkeyPatch):
    recorded: list[tuple[str, Optional[str]]] = []

    async def record_variant(
        config: RowndPluginConfig, user_id: str, app_variant_id: Optional[str]
    ):
        recorded.append((user_id, app_variant_id))

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
        return SimpleNamespace(status="OK", user=SimpleNamespace(id="thirdparty-user"))

    monkeypatch.setattr(plugin, "record_rownd_app_variant_for_user", record_variant)
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

    assert recorded == [("thirdparty-user", "variant_123")]


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


async def test_emailverification_verify_completes_pending_email(monkeypatch: pytest.MonkeyPatch):
    completed: list[tuple[str, str, Dict[str, Any], str]] = []

    async def complete_pending_email_verification(
        recipe_user_id: Any,
        email: str,
        user_context: Dict[str, Any],
        tenant_id: str,
    ):
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

    await overridden.email_verify_post("token", None, "public", cast(Any, None), {"source": "test"})

    assert completed == [("recipe-user", "verified@example.com", {"source": "test"}, "public")]


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

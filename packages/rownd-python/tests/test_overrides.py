from __future__ import annotations

from types import SimpleNamespace
from typing import Any, Dict, Optional, cast

import pytest
from supertokens_python.recipe.accountlinking.types import AccountInfoWithRecipeId

from supertokens_rownd import plugin
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
        cast(Any, SimpleNamespace(
            request=FakeRequest(
                {
                    "app_variant_id": "variant_123",
                    "rownd_display_context": "mobile_app",
                    "rownd_redirect_to_path": "/dashboard",
                }
            )
        )),
        {"existing": "value"},
    )

    assert captured_context == {
        "existing": "value",
        "rowndAppVariantId": "variant_123",
        "rowndDisplayContext": "mobile_app",
        "rowndRedirectToPath": "/dashboard",
    }


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


async def test_passwordless_consume_records_app_variant(monkeypatch: pytest.MonkeyPatch):
    recorded: list[tuple[str, Optional[str]]] = []

    async def record_variant(config: RowndPluginConfig, user_id: str, app_variant_id: Optional[str]):
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

    async def record_variant(config: RowndPluginConfig, user_id: str, app_variant_id: Optional[str]):
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
    completed: list[tuple[str, str, Dict[str, Any]]] = []

    async def complete_pending_email_verification(recipe_user_id: Any, email: str, user_context: Dict[str, Any]):
        completed.append((recipe_user_id.get_as_string(), email, user_context))

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

    assert completed == [("recipe-user", "verified@example.com", {"source": "test"})]


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

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
import supertokens_rownd.config as rownd_config
import supertokens_rownd.plugin_implementation as impl
import supertokens_rownd.rownd_compatibility as compatibility
import supertokens_rownd.supertokens_repository as supertokens_repository
import supertokens_rownd.utils as utils
from supertokens_rownd.constants import (
    RESERVED_OAUTH_CLAIMS,
    RESERVED_SESSION_CLAIMS,
    ROWND_JWT_CLAIMS,
)
from supertokens_rownd.types import RowndPluginConfig
from supertokens_rownd.types import (
    EmailCredentialAuthorization,
    EmailCredentialReason,
    EmailCredentialState,
)


pytestmark = pytest.mark.asyncio


class FakeRequest:
    def __init__(self, query: Optional[Dict[str, str]] = None):
        self.query = query or {}

    def get_query_param(self, key: str) -> Optional[str]:
        return self.query.get(key)


class FakeRouteRequest(FakeRequest):
    def __init__(self, body: Dict[str, Any], query: Optional[Dict[str, str]] = None):
        super().__init__(query)
        self.body = body

    async def json(self) -> Dict[str, Any]:
        return self.body


class FakeResponse:
    def __init__(self) -> None:
        self.status_code: Optional[int] = None
        self.body: Optional[Dict[str, Any]] = None

    def set_status_code(self, status_code: int) -> None:
        self.status_code = status_code

    def set_json_content(self, body: Dict[str, Any]) -> None:
        self.body = body


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


def make_guard_config() -> RowndPluginConfig:
    return RowndPluginConfig(
        rownd_app_key="app-key",
        rownd_app_secret="secret",
        email_change={"retirement_mode": "guard"},
    )


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


async def test_passwordless_create_code_adds_rownd_context(monkeypatch: pytest.MonkeyPatch):
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

    async def authorize(*_args: Any, **_kwargs: Any):
        return EmailCredentialAuthorization(EmailCredentialState.ALLOW, EmailCredentialReason.NO_OWNER)

    monkeypatch.setattr(supertokens_repository, "authorize_passwordless_email", authorize)
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


async def test_passwordless_resend_code_adds_rownd_context(monkeypatch: pytest.MonkeyPatch):
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
    monkeypatch.setattr(
        supertokens_repository,
        "resolve_passwordless_device_email",
        lambda *_args, **_kwargs: asyncio.sleep(0, result=""),
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


async def test_confirmation_bypass_helper_resolves_policy_from_owning_modules(
    monkeypatch: pytest.MonkeyPatch,
):
    config = make_config()
    calls: list[str] = []

    async def create_code(*_args: Any, **_kwargs: Any):
        return SimpleNamespace(pre_auth_session_id="pre-auth", link_code="link-code")

    monkeypatch.setattr(rownd_config, "get_active_rownd_config", lambda: config)
    monkeypatch.setattr(
        rownd_config,
        "assert_app_variant_is_configured",
        lambda *_args: calls.append("app-variant"),
    )
    monkeypatch.setattr(
        utils,
        "resolve_allowed_client_domain",
        lambda *_args: calls.append("client-domain") or "https://app.example.com",
    )
    monkeypatch.setattr(
        utils,
        "normalize_redirect_to_path_for_client_domain",
        lambda *_args: calls.append("redirect") or "/profile",
    )
    monkeypatch.setattr(
        utils,
        "assert_allowed_bypass_redirect_path",
        lambda *_args: calls.append("bypass"),
    )
    monkeypatch.setattr(
        utils,
        "create_derived_user_context",
        lambda *_args: calls.append("context") or {},
    )
    monkeypatch.setattr(
        utils,
        "get_magic_link_bootstrap_params",
        lambda *_args, **_kwargs: calls.append("bootstrap") or {},
    )
    monkeypatch.setattr(
        utils,
        "rewrite_magic_link",
        lambda *_args: calls.append("rewrite") or "https://app.example.com/account/login",
    )
    monkeypatch.setattr(plugin.passwordless_asyncio, "create_code", create_code)
    monkeypatch.setattr(
        supertokens_repository,
        "authorize_passwordless_email",
        lambda *_args, **_kwargs: asyncio.sleep(
            0,
            result=EmailCredentialAuthorization(
                EmailCredentialState.ALLOW, EmailCredentialReason.NO_OWNER
            ),
        ),
    )

    link = await plugin.create_magic_link_with_confirmation_bypass(
        email="user@example.com", redirect_to_path="/profile"
    )

    assert calls == [
        "app-variant",
        "client-domain",
        "redirect",
        "bypass",
        "context",
        "bootstrap",
        "rewrite",
    ]
    assert link == "https://app.example.com/account/login?bypassDeviceConfirmation=true"


@pytest.mark.parametrize(
    ("state", "reason"),
    [
        (EmailCredentialState.RETIRED, EmailCredentialReason.NONCANONICAL),
        (EmailCredentialState.MALFORMED, EmailCredentialReason.SECURITY_METADATA),
    ],
)
async def test_passwordless_create_rejects_unauthorized_email_before_original(
    monkeypatch: pytest.MonkeyPatch,
    state: EmailCredentialState,
    reason: EmailCredentialReason,
):
    called = False

    async def original_create(*_args: Any, **_kwargs: Any):
        nonlocal called
        called = True

    async def unauthorized(*_args: Any, **_kwargs: Any):
        return EmailCredentialAuthorization(state, reason, "owner", "old")

    monkeypatch.setattr(supertokens_repository, "authorize_passwordless_email", unauthorized)
    original = SimpleNamespace(create_code_post=original_create, consume_code_post=None)
    overridden = plugin._passwordless_api_override(make_guard_config())(cast(Any, original))

    result = await overridden.create_code_post(
        "old@example.com",
        None,
        None,
        None,
        "public",
        cast(Any, SimpleNamespace(request=FakeRequest())),
        {},
    )

    assert result.status == "GENERAL_ERROR"
    assert called is False


async def test_passwordless_create_observe_mode_does_not_enforce(
    monkeypatch: pytest.MonkeyPatch,
):
    async def retired(*_args: Any, **_kwargs: Any):
        return EmailCredentialAuthorization(
            EmailCredentialState.RETIRED, EmailCredentialReason.NONCANONICAL
        )

    async def original_create(*_args: Any, **_kwargs: Any):
        return SimpleNamespace(status="OK")

    monkeypatch.setattr(supertokens_repository, "authorize_passwordless_email", retired)
    overridden = plugin._passwordless_api_override(make_config())(
        cast(Any, SimpleNamespace(create_code_post=original_create, consume_code_post=None))
    )

    result = await overridden.create_code_post(
        "old@example.com",
        None,
        None,
        None,
        "public",
        cast(Any, SimpleNamespace(request=FakeRequest())),
        {},
    )

    assert result.status == "OK"


async def test_passwordless_create_guard_rejects_foreign_owner_from_session(
    monkeypatch: pytest.MonkeyPatch,
):
    expected_owners: list[Optional[str]] = []
    original_called = False

    async def foreign_owner(*_args: Any, **kwargs: Any):
        expected_owners.append(kwargs.get("expected_owner_user_id"))
        return EmailCredentialAuthorization(
            EmailCredentialState.MALFORMED,
            EmailCredentialReason.OWNER_CHANGED,
            "owner-b",
        )

    async def original_create(*_args: Any, **_kwargs: Any):
        nonlocal original_called
        original_called = True

    monkeypatch.setattr(supertokens_repository, "authorize_passwordless_email", foreign_owner)
    overridden = plugin._passwordless_api_override(make_guard_config())(
        cast(Any, SimpleNamespace(create_code_post=original_create, consume_code_post=None))
    )

    result = await overridden.create_code_post(
        "owned-by-b@example.com",
        None,
        cast(Any, FakeSession("owner-a")),
        True,
        "public",
        cast(Any, SimpleNamespace(request=FakeRequest())),
        {},
    )

    assert result.status == "GENERAL_ERROR"
    assert expected_owners == ["owner-a"]
    assert original_called is False


async def test_passwordless_create_phone_is_unchanged(monkeypatch: pytest.MonkeyPatch):
    authorization_calls = 0

    async def authorize(*_args: Any, **_kwargs: Any):
        nonlocal authorization_calls
        authorization_calls += 1

    async def original_create(*_args: Any, **_kwargs: Any):
        return SimpleNamespace(status="OK")

    monkeypatch.setattr(supertokens_repository, "authorize_passwordless_email", authorize)
    original = SimpleNamespace(create_code_post=original_create, consume_code_post=None)
    overridden = plugin._passwordless_api_override(make_config())(cast(Any, original))

    result = await overridden.create_code_post(
        None,
        "+15555550123",
        None,
        None,
        "public",
        cast(Any, SimpleNamespace(request=FakeRequest())),
        {},
    )

    assert result.status == "OK"
    assert authorization_calls == 0


async def test_confirmation_bypass_helper_rejects_retired_email(
    monkeypatch: pytest.MonkeyPatch,
):
    config = make_guard_config()
    config.website_domain = "https://app.example.com"
    config.cross_device_confirmation_bypass = {"allowed_redirect_paths": ["/"]}
    created = False

    async def retired(*_args: Any, **_kwargs: Any):
        return EmailCredentialAuthorization(
            EmailCredentialState.RETIRED, EmailCredentialReason.NONCANONICAL
        )

    async def create_code(*_args: Any, **_kwargs: Any):
        nonlocal created
        created = True

    monkeypatch.setattr(rownd_config, "get_active_rownd_config", lambda: config)
    monkeypatch.setattr(supertokens_repository, "authorize_passwordless_email", retired)
    monkeypatch.setattr(plugin.passwordless_asyncio, "create_code", create_code)

    with pytest.raises(Exception, match="could not be completed"):
        await plugin.create_magic_link_with_confirmation_bypass(
            email="old@example.com", redirect_to_path="/"
        )
    assert created is False


async def test_confirmation_bypass_helper_phone_is_unchanged(
    monkeypatch: pytest.MonkeyPatch,
):
    config = make_config()
    config.website_domain = "https://app.example.com"
    config.cross_device_confirmation_bypass = {"allowed_redirect_paths": ["/profile"]}
    authorization_calls = 0

    async def authorize(*_args: Any, **_kwargs: Any):
        nonlocal authorization_calls
        authorization_calls += 1

    async def create_code(*_args: Any, **_kwargs: Any):
        return SimpleNamespace(pre_auth_session_id="pre-auth", link_code="link-code")

    monkeypatch.setattr(rownd_config, "get_active_rownd_config", lambda: config)
    monkeypatch.setattr(supertokens_repository, "authorize_passwordless_email", authorize)
    monkeypatch.setattr(plugin.passwordless_asyncio, "create_code", create_code)

    link = await plugin.create_magic_link_with_confirmation_bypass(
        phone_number="+15555550123", redirect_to_path="/profile"
    )

    assert "preAuthSessionId=pre-auth" in link
    assert authorization_calls == 0


async def test_confirmation_bypass_helper_guard_rejects_foreign_owner_from_session(
    monkeypatch: pytest.MonkeyPatch,
):
    config = make_guard_config()
    config.website_domain = "https://app.example.com"
    config.cross_device_confirmation_bypass = {"allowed_redirect_paths": ["/profile"]}
    expected_owners: list[Optional[str]] = []
    code_created = False

    async def foreign_owner(*_args: Any, **kwargs: Any):
        expected_owners.append(kwargs.get("expected_owner_user_id"))
        return EmailCredentialAuthorization(
            EmailCredentialState.MALFORMED,
            EmailCredentialReason.OWNER_CHANGED,
            "owner-b",
        )

    async def create_code(*_args: Any, **_kwargs: Any):
        nonlocal code_created
        code_created = True

    monkeypatch.setattr(rownd_config, "get_active_rownd_config", lambda: config)
    monkeypatch.setattr(supertokens_repository, "authorize_passwordless_email", foreign_owner)
    monkeypatch.setattr(plugin.passwordless_asyncio, "create_code", create_code)

    with pytest.raises(Exception, match="could not be completed"):
        await plugin.create_magic_link_with_confirmation_bypass(
            email="owned-by-b@example.com",
            session=cast(Any, FakeSession("owner-a")),
            redirect_to_path="/profile",
        )

    assert expected_owners == ["owner-a"]
    assert code_created is False


async def test_confirmation_bypass_helper_observe_mode_does_not_enforce(
    monkeypatch: pytest.MonkeyPatch,
):
    config = make_config()
    config.website_domain = "https://app.example.com"
    config.cross_device_confirmation_bypass = {"allowed_redirect_paths": ["/profile"]}

    async def fail(*_args: Any, **_kwargs: Any):
        raise RuntimeError("classification unavailable")

    async def create_code(*_args: Any, **_kwargs: Any):
        return SimpleNamespace(pre_auth_session_id="pre-auth", link_code="link-code")

    monkeypatch.setattr(rownd_config, "get_active_rownd_config", lambda: config)
    monkeypatch.setattr(supertokens_repository, "authorize_passwordless_email", fail)
    monkeypatch.setattr(plugin.passwordless_asyncio, "create_code", create_code)

    link = await plugin.create_magic_link_with_confirmation_bypass(
        email="old@example.com", redirect_to_path="/profile"
    )

    assert "preAuthSessionId=pre-auth" in link


async def test_passwordless_resend_rejects_device_mismatch(monkeypatch: pytest.MonkeyPatch):
    called = False

    async def original_resend(*_args: Any, **_kwargs: Any):
        nonlocal called
        called = True

    monkeypatch.setattr(
        supertokens_repository,
        "resolve_passwordless_device_email",
        lambda *_args, **_kwargs: asyncio.sleep(0, result=None),
    )
    original = SimpleNamespace(
        create_code_post=None, consume_code_post=None, resend_code_post=original_resend
    )
    overridden = plugin._passwordless_api_override(make_guard_config())(cast(Any, original))

    result = await overridden.resend_code_post(
        "device-a",
        "pre-auth-b",
        None,
        None,
        "public",
        cast(Any, SimpleNamespace(request=FakeRequest())),
        {},
    )

    assert isinstance(result, plugin.ResendCodePostRestartFlowError)
    assert called is False


async def test_passwordless_resend_revokes_retired_email_codes(
    monkeypatch: pytest.MonkeyPatch,
):
    revoked: list[str] = []

    async def retired(*_args: Any, **_kwargs: Any):
        return EmailCredentialAuthorization(
            EmailCredentialState.RETIRED, EmailCredentialReason.NONCANONICAL
        )

    async def revoke(_tenant: str, email: str, user_context: Any):
        revoked.append(email)

    monkeypatch.setattr(
        supertokens_repository,
        "resolve_passwordless_device_email",
        lambda *_args, **_kwargs: asyncio.sleep(0, result="old@example.com"),
    )
    monkeypatch.setattr(supertokens_repository, "authorize_passwordless_email", retired)
    monkeypatch.setattr(plugin.passwordless_asyncio, "revoke_all_codes", revoke)
    original = SimpleNamespace(
        create_code_post=None, consume_code_post=None, resend_code_post=lambda *_args: None
    )
    overridden = plugin._passwordless_api_override(make_guard_config())(cast(Any, original))

    result = await overridden.resend_code_post(
        "device",
        "pre-auth",
        None,
        None,
        "public",
        cast(Any, SimpleNamespace(request=FakeRequest())),
        {},
    )

    assert isinstance(result, plugin.ResendCodePostRestartFlowError)
    assert revoked == ["old@example.com"]


async def test_passwordless_resend_guard_rejects_foreign_owner_from_session(
    monkeypatch: pytest.MonkeyPatch,
):
    expected_owners: list[Optional[str]] = []
    original_called = False

    async def foreign_owner(*_args: Any, **kwargs: Any):
        expected_owners.append(kwargs.get("expected_owner_user_id"))
        return EmailCredentialAuthorization(
            EmailCredentialState.MALFORMED,
            EmailCredentialReason.OWNER_CHANGED,
            "owner-b",
        )

    async def original_resend(*_args: Any, **_kwargs: Any):
        nonlocal original_called
        original_called = True

    monkeypatch.setattr(
        supertokens_repository,
        "resolve_passwordless_device_email",
        lambda *_args, **_kwargs: asyncio.sleep(0, result="owned-by-b@example.com"),
    )
    monkeypatch.setattr(supertokens_repository, "authorize_passwordless_email", foreign_owner)
    overridden = plugin._passwordless_api_override(make_guard_config())(
        cast(
            Any,
            SimpleNamespace(
                create_code_post=None,
                consume_code_post=None,
                resend_code_post=original_resend,
            ),
        )
    )

    result = await overridden.resend_code_post(
        "device",
        "pre-auth",
        cast(Any, FakeSession("owner-a")),
        True,
        "public",
        cast(Any, SimpleNamespace(request=FakeRequest())),
        {},
    )

    assert isinstance(result, plugin.ResendCodePostRestartFlowError)
    assert expected_owners == ["owner-a"]
    assert original_called is False


@pytest.mark.parametrize("stored_email", ["canonical@example.com", ""])
async def test_passwordless_resend_allows_canonical_email_and_phone(
    monkeypatch: pytest.MonkeyPatch, stored_email: str
):
    called = False

    async def allow(*_args: Any, **_kwargs: Any):
        return EmailCredentialAuthorization(
            EmailCredentialState.ALLOW, EmailCredentialReason.CANONICAL
        )

    async def original_resend(*_args: Any, **_kwargs: Any):
        nonlocal called
        called = True
        return SimpleNamespace(status="OK")

    monkeypatch.setattr(
        supertokens_repository,
        "resolve_passwordless_device_email",
        lambda *_args, **_kwargs: asyncio.sleep(0, result=stored_email),
    )
    monkeypatch.setattr(supertokens_repository, "authorize_passwordless_email", allow)
    overridden = plugin._passwordless_api_override(make_guard_config())(
        cast(
            Any,
            SimpleNamespace(
                create_code_post=None,
                consume_code_post=None,
                resend_code_post=original_resend,
            ),
        )
    )

    result = await overridden.resend_code_post(
        "device",
        "pre-auth",
        None,
        None,
        "public",
        cast(Any, SimpleNamespace(request=FakeRequest())),
        {},
    )

    assert result.status == "OK"
    assert called is True


async def test_passwordless_resend_observe_mode_ignores_resolver_exception(
    monkeypatch: pytest.MonkeyPatch,
):
    async def fail(*_args: Any, **_kwargs: Any):
        raise RuntimeError("resolver unavailable")

    async def original_resend(*_args: Any, **_kwargs: Any):
        return SimpleNamespace(status="OK")

    monkeypatch.setattr(supertokens_repository, "resolve_passwordless_device_email", fail)
    overridden = plugin._passwordless_api_override(make_config())(
        cast(
            Any,
            SimpleNamespace(
                create_code_post=None,
                consume_code_post=None,
                resend_code_post=original_resend,
            ),
        )
    )

    result = await overridden.resend_code_post(
        "device",
        "pre-auth",
        None,
        None,
        "public",
        cast(Any, SimpleNamespace(request=FakeRequest())),
        {},
    )

    assert result.status == "OK"


async def test_passwordless_recipe_consume_validates_authoritative_recipe_user_id(
    monkeypatch: pytest.MonkeyPatch,
):
    class FakeOk:
        def __init__(self, recipe_user_id: str):
            self.recipe_user_id = SimpleNamespace(get_as_string=lambda: recipe_user_id)
            self.user = SimpleNamespace(id="owner")

    calls: list[tuple[Optional[str], Optional[str]]] = []

    async def authorize(*_args: Any, **kwargs: Any):
        consumed_id = kwargs.get("consumed_recipe_user_id")
        if consumed_id is None and len(_args) > 3:
            consumed_id = _args[3]
        expected_owner = _args[4] if len(_args) > 4 else kwargs.get("expected_owner_user_id")
        calls.append((consumed_id, expected_owner))
        return EmailCredentialAuthorization(
            EmailCredentialState.ALLOW,
            EmailCredentialReason.CANONICAL,
            "owner",
            consumed_id or "canonical",
        )

    async def original_consume(*_args: Any, **_kwargs: Any):
        return FakeOk("canonical")

    monkeypatch.setattr(plugin, "ConsumeCodeOkResult", FakeOk)
    monkeypatch.setattr(
        supertokens_repository,
        "resolve_passwordless_device_email",
        lambda *_args, **_kwargs: asyncio.sleep(0, result="user@example.com"),
    )
    monkeypatch.setattr(supertokens_repository, "authorize_passwordless_email", authorize)
    original = SimpleNamespace(consume_code=original_consume)
    overridden = plugin._passwordless_function_override(make_guard_config())(cast(Any, original))

    result = await overridden.consume_code(
        "pre",
        None,
        None,
        "link",
        None,
        None,
        "public",
        {},
    )

    assert isinstance(result, FakeOk)
    assert calls == [(None, None), ("canonical", "owner")]


async def test_passwordless_recipe_consume_mismatched_authoritative_id_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
):
    class FakeOk:
        recipe_user_id = SimpleNamespace(get_as_string=lambda: "duplicate")
        user = SimpleNamespace(id="owner")

    original_called = False
    authorization_count = 0

    async def authorize(*_args: Any, **_kwargs: Any):
        nonlocal authorization_count
        authorization_count += 1
        if authorization_count == 1:
            return EmailCredentialAuthorization(
                EmailCredentialState.ALLOW, EmailCredentialReason.CANONICAL, "owner", "canonical"
            )
        return EmailCredentialAuthorization(
            EmailCredentialState.MALFORMED, EmailCredentialReason.METHOD_MISMATCH, "owner"
        )

    async def original_consume(*_args: Any, **_kwargs: Any):
        nonlocal original_called
        original_called = True
        return FakeOk()

    monkeypatch.setattr(plugin, "ConsumeCodeOkResult", FakeOk)
    monkeypatch.setattr(
        supertokens_repository,
        "resolve_passwordless_device_email",
        lambda *_args, **_kwargs: asyncio.sleep(0, result="user@example.com"),
    )
    monkeypatch.setattr(supertokens_repository, "authorize_passwordless_email", authorize)
    overridden = plugin._passwordless_function_override(make_guard_config())(
        cast(Any, SimpleNamespace(consume_code=original_consume))
    )

    result = await overridden.consume_code(
        "pre",
        None,
        None,
        "link",
        None,
        None,
        "public",
        {},
    )

    assert original_called is True
    assert isinstance(result, plugin.ConsumeCodeRestartFlowError)


async def test_passwordless_recipe_consume_rejects_malformed_state_before_core(
    monkeypatch: pytest.MonkeyPatch,
):
    original_called = False

    async def malformed(*_args: Any, **_kwargs: Any):
        return EmailCredentialAuthorization(
            EmailCredentialState.MALFORMED, EmailCredentialReason.SECURITY_METADATA
        )

    async def original_consume(*_args: Any, **_kwargs: Any):
        nonlocal original_called
        original_called = True

    monkeypatch.setattr(
        supertokens_repository,
        "resolve_passwordless_device_email",
        lambda *_args, **_kwargs: asyncio.sleep(0, result="user@example.com"),
    )
    monkeypatch.setattr(supertokens_repository, "authorize_passwordless_email", malformed)
    overridden = plugin._passwordless_function_override(make_guard_config())(
        cast(Any, SimpleNamespace(consume_code=original_consume))
    )

    result = await overridden.consume_code(
        "pre",
        None,
        None,
        "link",
        None,
        None,
        "public",
        {},
    )

    assert isinstance(result, plugin.ConsumeCodeRestartFlowError)
    assert original_called is False


async def test_passwordless_recipe_consume_phone_sets_postcheck_without_email_auth(
    monkeypatch: pytest.MonkeyPatch,
):
    class FakeOk:
        user = SimpleNamespace(id="phone-owner")
        recipe_user_id = SimpleNamespace(get_as_string=lambda: "phone-method")

    authorization_calls = 0

    async def authorize(*_args: Any, **_kwargs: Any):
        nonlocal authorization_calls
        authorization_calls += 1

    async def original_consume(*_args: Any, **_kwargs: Any):
        return FakeOk()

    monkeypatch.setattr(plugin, "ConsumeCodeOkResult", FakeOk)
    monkeypatch.setattr(
        supertokens_repository,
        "resolve_passwordless_device_email",
        lambda *_args, **_kwargs: asyncio.sleep(0, result=""),
    )
    monkeypatch.setattr(supertokens_repository, "authorize_passwordless_email", authorize)
    context: Dict[str, Any] = {}
    overridden = plugin._passwordless_function_override(make_guard_config())(
        cast(Any, SimpleNamespace(consume_code=original_consume))
    )

    result = await overridden.consume_code(
        "pre", None, None, "link", None, None, "public", context
    )

    assert isinstance(result, FakeOk)
    assert isinstance(context["rowndPasswordlessConsumePostcheck"], tuple)
    assert authorization_calls == 0


async def test_passwordless_recipe_consume_guard_catches_authorization_exception(
    monkeypatch: pytest.MonkeyPatch,
):
    async def fail(*_args: Any, **_kwargs: Any):
        raise RuntimeError("lookup failed")

    monkeypatch.setattr(
        supertokens_repository,
        "resolve_passwordless_device_email",
        lambda *_args, **_kwargs: asyncio.sleep(0, result="user@example.com"),
    )
    monkeypatch.setattr(supertokens_repository, "authorize_passwordless_email", fail)
    overridden = plugin._passwordless_function_override(make_guard_config())(
        cast(Any, SimpleNamespace(consume_code=fail))
    )

    result = await overridden.consume_code("pre", None, None, "link", None, None, "public", {})

    assert isinstance(result, plugin.ConsumeCodeRestartFlowError)


async def test_passwordless_recipe_consume_catches_post_core_authorization_exception(
    monkeypatch: pytest.MonkeyPatch,
):
    class FakeOk:
        user = SimpleNamespace(id="owner")
        recipe_user_id = SimpleNamespace(get_as_string=lambda: "canonical")

    authorization_count = 0

    async def authorize(*_args: Any, **_kwargs: Any):
        nonlocal authorization_count
        authorization_count += 1
        if authorization_count == 1:
            return EmailCredentialAuthorization(
                EmailCredentialState.ALLOW,
                EmailCredentialReason.CANONICAL,
                "owner",
                "canonical",
            )
        raise RuntimeError("postcheck failed")

    async def original_consume(*_args: Any, **_kwargs: Any):
        return FakeOk()

    monkeypatch.setattr(plugin, "ConsumeCodeOkResult", FakeOk)
    monkeypatch.setattr(
        supertokens_repository,
        "resolve_passwordless_device_email",
        lambda *_args, **_kwargs: asyncio.sleep(0, result="user@example.com"),
    )
    monkeypatch.setattr(supertokens_repository, "authorize_passwordless_email", authorize)
    overridden = plugin._passwordless_function_override(make_guard_config())(
        cast(Any, SimpleNamespace(consume_code=original_consume))
    )

    result = await overridden.consume_code("pre", None, None, "link", None, None, "public", {})

    assert isinstance(result, plugin.ConsumeCodeRestartFlowError)
    assert authorization_count == 2


@pytest.mark.parametrize("failure", ["resolver", "authorization"])
async def test_passwordless_recipe_consume_observe_mode_ignores_classification_failures(
    monkeypatch: pytest.MonkeyPatch, failure: str
):
    async def fail(*_args: Any, **_kwargs: Any):
        raise RuntimeError("classification unavailable")

    async def resolve(*_args: Any, **_kwargs: Any):
        return "user@example.com"

    async def original_consume(*_args: Any, **_kwargs: Any):
        return SimpleNamespace(status="ORIGINAL")

    monkeypatch.setattr(
        supertokens_repository,
        "resolve_passwordless_device_email",
        fail if failure == "resolver" else resolve,
    )
    monkeypatch.setattr(
        supertokens_repository,
        "authorize_passwordless_email",
        fail,
    )
    overridden = plugin._passwordless_function_override(make_config())(
        cast(Any, SimpleNamespace(consume_code=original_consume))
    )

    result = await overridden.consume_code("pre", None, None, "link", None, None, "public", {})

    assert cast(Any, result).status == "ORIGINAL"


async def test_passwordless_consume_api_missing_postcheck_revokes_and_denies(
    monkeypatch: pytest.MonkeyPatch,
):
    revoked_all: list[tuple[str, Optional[str]]] = []
    diagnostics: list[str] = []

    class FakeReturnedSession:
        def __init__(self):
            self.req_res_info = SimpleNamespace(
                transfer_method="header", request=SimpleNamespace()
            )
            self.response_mutators: list[Any] = []
            self.config = SimpleNamespace()

        async def revoke_session(self, _context: Any):
            raise RuntimeError("targeted revoke failed")

        def get_recipe_user_id(self, _context: Any):
            return SimpleNamespace(get_as_string=lambda: "recipe-user")

    returned_session = FakeReturnedSession()

    async def consume_api(*_args: Any, **_kwargs: Any):
        return SimpleNamespace(
            status="OK", user=SimpleNamespace(id="owner"), session=returned_session
        )

    async def revoke_all(user_id: str, _linked: bool, tenant_id: Optional[str], _context: Any):
        revoked_all.append((user_id, tenant_id))
        raise RuntimeError("fallback revoke failed")

    monkeypatch.setattr(plugin, "SessionContainer", FakeReturnedSession)
    monkeypatch.setattr(
        plugin,
        "clear_session_response_mutator",
        lambda *_args: SimpleNamespace(type="clear-session"),
    )
    monkeypatch.setattr(plugin.session_asyncio, "revoke_all_sessions_for_user", revoke_all)

    diagnostic_configs: list[RowndPluginConfig] = []

    def capture_warning(warning_config: RowndPluginConfig, message: str):
        diagnostic_configs.append(warning_config)
        diagnostics.append(message)

    monkeypatch.setattr(plugin, "log_warning", capture_warning)
    config = make_guard_config()
    config.enable_debug_logs = False
    overridden = plugin._passwordless_api_override(config)(
        cast(Any, SimpleNamespace(create_code_post=None, consume_code_post=consume_api))
    )

    result = await overridden.consume_code_post(
        "pre",
        None,
        None,
        "link",
        None,
        None,
        "public",
        cast(Any, SimpleNamespace(request=FakeRequest())),
        {},
    )

    assert isinstance(result, plugin.ConsumeCodePostRestartFlowError)
    assert revoked_all == [("owner", "public")]
    assert [mutator.type for mutator in returned_session.response_mutators] == ["clear-session"]
    assert any("code=account_revoke_failed" in diagnostic for diagnostic in diagnostics)
    assert diagnostic_configs == [config]
    assert config.enable_debug_logs is False
    assert all("targeted revoke failed" not in diagnostic for diagnostic in diagnostics)
    assert all("fallback revoke failed" not in diagnostic for diagnostic in diagnostics)


async def test_passwordless_consume_api_without_queued_credentials_denies_when_clear_mutator_fails(
    monkeypatch: pytest.MonkeyPatch,
):
    revoked_all: list[tuple[str, Optional[str]]] = []

    class FakeReturnedSession:
        def __init__(self):
            self.req_res_info = SimpleNamespace(
                transfer_method="header", request=SimpleNamespace()
            )
            self.response_mutators: list[Any] = []
            self.config = SimpleNamespace()

        async def revoke_session(self, _context: Any):
            return None

        def get_recipe_user_id(self, _context: Any):
            return SimpleNamespace(get_as_string=lambda: "recipe-user")

    returned_session = FakeReturnedSession()

    async def consume_api(*_args: Any, **_kwargs: Any):
        return SimpleNamespace(
            status="OK", user=SimpleNamespace(id="owner"), session=returned_session
        )

    async def revoke_all(user_id: str, _linked: bool, tenant_id: Optional[str], _context: Any):
        revoked_all.append((user_id, tenant_id))

    def fail_clear_mutator(*_args: Any):
        raise RuntimeError("cannot construct clear mutator")

    monkeypatch.setattr(plugin, "SessionContainer", FakeReturnedSession)
    monkeypatch.setattr(plugin, "clear_session_response_mutator", fail_clear_mutator)
    monkeypatch.setattr(plugin.session_asyncio, "revoke_all_sessions_for_user", revoke_all)
    overridden = plugin._passwordless_api_override(make_guard_config())(
        cast(Any, SimpleNamespace(create_code_post=None, consume_code_post=consume_api))
    )

    result = await overridden.consume_code_post(
        "pre",
        None,
        None,
        "link",
        None,
        None,
        "public",
        cast(Any, SimpleNamespace(request=FakeRequest())),
        {},
    )

    assert isinstance(result, plugin.ConsumeCodePostRestartFlowError)
    assert revoked_all == [("owner", "public")]
    assert returned_session.response_mutators == []


async def test_passwordless_consume_api_with_queued_credentials_raises_when_clear_mutator_fails(
    monkeypatch: pytest.MonkeyPatch,
):
    revoked_all: list[tuple[str, Optional[str]]] = []
    queued_access_token = SimpleNamespace(type="access-token")

    class FakeReturnedSession:
        def __init__(self):
            self.req_res_info = SimpleNamespace(
                transfer_method="header", request=SimpleNamespace()
            )
            self.response_mutators: list[Any] = [queued_access_token]
            self.config = SimpleNamespace()

        async def revoke_session(self, _context: Any):
            return None

        def get_recipe_user_id(self, _context: Any):
            return SimpleNamespace(get_as_string=lambda: "recipe-user")

    returned_session = FakeReturnedSession()

    async def consume_api(*_args: Any, **_kwargs: Any):
        return SimpleNamespace(
            status="OK", user=SimpleNamespace(id="owner"), session=returned_session
        )

    async def revoke_all(user_id: str, _linked: bool, tenant_id: Optional[str], _context: Any):
        revoked_all.append((user_id, tenant_id))

    def fail_clear_mutator(*_args: Any):
        raise RuntimeError("sensitive clear-mutator failure")

    monkeypatch.setattr(plugin, "SessionContainer", FakeReturnedSession)
    monkeypatch.setattr(plugin, "clear_session_response_mutator", fail_clear_mutator)
    monkeypatch.setattr(plugin.session_asyncio, "revoke_all_sessions_for_user", revoke_all)
    overridden = plugin._passwordless_api_override(make_guard_config())(
        cast(Any, SimpleNamespace(create_code_post=None, consume_code_post=consume_api))
    )

    with pytest.raises(RuntimeError) as exc_info:
        await overridden.consume_code_post(
            "pre",
            None,
            None,
            "link",
            None,
            None,
            "public",
            cast(Any, SimpleNamespace(request=FakeRequest())),
            {},
        )

    assert "sensitive clear-mutator failure" not in str(exc_info.value)
    assert revoked_all == [("owner", "public")]
    assert returned_session.response_mutators == [queued_access_token]


async def test_passwordless_consume_api_rejects_marker_recipe_mismatch(
    monkeypatch: pytest.MonkeyPatch,
):
    class FakeReturnedSession:
        req_res_info = None
        response_mutators: list[Any] = []
        config = SimpleNamespace()
        revoked = False

        async def revoke_session(self, _context: Any):
            self.revoked = True

        def get_recipe_user_id(self, _context: Any):
            return SimpleNamespace(get_as_string=lambda: "returned-recipe")

    returned_session = FakeReturnedSession()

    async def consume_api(*args: Any, **_kwargs: Any):
        context = cast(Dict[str, Any], args[-1])
        context["rowndPasswordlessConsumePostcheck"] = plugin._PasswordlessConsumePostcheck(
            "owner", "different-recipe"
        )
        return SimpleNamespace(
            status="OK", user=SimpleNamespace(id="owner"), session=returned_session
        )

    monkeypatch.setattr(plugin, "SessionContainer", FakeReturnedSession)
    monkeypatch.setattr(
        supertokens_repository,
        "sdk_user_id_matches_internal_target",
        lambda *_args, **_kwargs: asyncio.sleep(0, result=True),
    )
    overridden = plugin._passwordless_api_override(make_guard_config())(
        cast(Any, SimpleNamespace(create_code_post=None, consume_code_post=consume_api))
    )

    result = await overridden.consume_code_post(
        "pre",
        None,
        None,
        "link",
        None,
        None,
        "public",
        cast(Any, SimpleNamespace(request=FakeRequest())),
        {},
    )

    assert isinstance(result, plugin.ConsumeCodePostRestartFlowError)
    assert returned_session.revoked is True


@pytest.mark.parametrize(
    ("user", "session"),
    [(SimpleNamespace(id=None), SimpleNamespace()), (SimpleNamespace(id="owner"), None)],
)
async def test_passwordless_consume_api_rejects_malformed_ok_result(
    user: Any, session: Any
):
    async def consume_api(*_args: Any, **_kwargs: Any):
        return SimpleNamespace(status="OK", user=user, session=session)

    overridden = plugin._passwordless_api_override(make_guard_config())(
        cast(Any, SimpleNamespace(create_code_post=None, consume_code_post=consume_api))
    )

    result = await overridden.consume_code_post(
        "pre",
        None,
        None,
        "link",
        None,
        None,
        "public",
        cast(Any, SimpleNamespace(request=FakeRequest())),
        {},
    )

    assert isinstance(result, plugin.ConsumeCodePostRestartFlowError)


async def test_device_email_resolver_requires_matching_device_records(
    monkeypatch: pytest.MonkeyPatch,
):
    pre_auth = SimpleNamespace(
        pre_auth_session_id="pre-a", email="user@example.com", phone_number=None
    )

    async def by_pre_auth(*_args: Any, **_kwargs: Any):
        return pre_auth

    monkeypatch.setattr(
        supertokens_repository.passwordless_asyncio,
        "list_codes_by_pre_auth_session_id",
        by_pre_auth,
    )
    for device in [
        None,
        SimpleNamespace(pre_auth_session_id="pre-b", email="user@example.com", phone_number=None),
        SimpleNamespace(pre_auth_session_id="pre-a", email="other@example.com", phone_number=None),
    ]:
        async def by_device(*_args: Any, _device: Any = device, **_kwargs: Any):
            return _device

        monkeypatch.setattr(
            supertokens_repository.passwordless_asyncio,
            "list_codes_by_device_id",
            by_device,
        )
        assert (
            await supertokens_repository.resolve_passwordless_device_email(
                "public", "pre-a", {}, "device"
            )
            is None
        )


@pytest.mark.parametrize(
    ("email", "phone", "expected"),
    [
        (None, None, None),
        ("user@example.com", "+15555550123", None),
        ("user@example.com", None, "user@example.com"),
        (None, "+15555550123", ""),
    ],
)
async def test_device_email_resolver_validates_contact_channel(
    monkeypatch: pytest.MonkeyPatch,
    email: Optional[str],
    phone: Optional[str],
    expected: Optional[str],
):
    device = SimpleNamespace(
        pre_auth_session_id="pre-auth", email=email, phone_number=phone
    )

    async def lookup(*_args: Any, **_kwargs: Any):
        return device

    monkeypatch.setattr(
        supertokens_repository.passwordless_asyncio,
        "list_codes_by_pre_auth_session_id",
        lookup,
    )
    monkeypatch.setattr(
        supertokens_repository.passwordless_asyncio,
        "list_codes_by_device_id",
        lookup,
    )

    assert (
        await supertokens_repository.resolve_passwordless_device_email(
            "public", "pre-auth", {}, "device"
        )
        == expected
    )


async def test_device_email_resolver_rejects_phone_mismatch(
    monkeypatch: pytest.MonkeyPatch,
):
    async def by_pre_auth(*_args: Any, **_kwargs: Any):
        return SimpleNamespace(
            pre_auth_session_id="pre-auth", email=None, phone_number="+15555550123"
        )

    async def by_device(*_args: Any, **_kwargs: Any):
        return SimpleNamespace(
            pre_auth_session_id="pre-auth", email=None, phone_number="+15555550124"
        )

    monkeypatch.setattr(
        supertokens_repository.passwordless_asyncio,
        "list_codes_by_pre_auth_session_id",
        by_pre_auth,
    )
    monkeypatch.setattr(
        supertokens_repository.passwordless_asyncio,
        "list_codes_by_device_id",
        by_device,
    )

    assert (
        await supertokens_repository.resolve_passwordless_device_email(
            "public", "pre-auth", {}, "device"
        )
        is None
    )


async def test_confirmation_bypass_route_uses_post_import_validation_patch(
    monkeypatch: pytest.MonkeyPatch,
):
    config = make_config()
    config.website_domain = "https://app.example.com"
    config.cross_device_confirmation_bypass = {"allowed_redirect_paths": ["/profile"]}
    calls: list[Optional[str]] = []

    def reject_confirmation_bypass(
        _config: RowndPluginConfig, redirect_to_path: Optional[str]
    ) -> None:
        calls.append(redirect_to_path)
        raise RuntimeError("patched confirmation policy")

    monkeypatch.setattr(utils, "assert_allowed_bypass_redirect_path", reject_confirmation_bypass)
    request = FakeRouteRequest({"redirectToPath": "/profile"})
    response = FakeResponse()

    await impl.handle_validate_passwordless_confirmation_bypass(
        config, cast(Any, request), cast(Any, response)
    )

    assert calls == ["/profile"]
    assert response.body == {"status": "ERROR", "bypass": False}


async def test_update_user_field_route_uses_post_import_writable_policy_patch(
    monkeypatch: pytest.MonkeyPatch,
):
    calls: list[list[str]] = []
    patched_error = {
        "status": "ERROR",
        "code": 418,
        "message": "patched writable policy",
    }

    def reject_field(_config: RowndPluginConfig, fields: list[str]):
        calls.append(fields)
        return patched_error

    monkeypatch.setattr(compatibility, "validate_writable_fields", reject_field)
    request = FakeRouteRequest({"value": "Ada"}, {"field": "first_name"})
    response = FakeResponse()

    await impl.handle_update_user_field(
        make_config(), cast(Any, request), cast(Any, response), cast(Any, object()), {}
    )

    assert calls == [["first_name"]]
    assert response.status_code == 418
    assert response.body == patched_error


async def test_init_rejects_invalid_client_domain():
    with pytest.raises(ValueError, match="Invalid client_domains.browser"):
        plugin.init(
            RowndPluginConfig(
                rownd_app_key="app-key",
                rownd_app_secret="secret",
                client_domains={"browser": "not-a-url"},
            )
        )


@pytest.mark.parametrize(
    "claim_name",
    ["sub", "st-role", ROWND_JWT_CLAIMS["auth_level"]],
)
async def test_init_allows_reserved_session_claim_name(claim_name: str):
    plugin.init(
        RowndPluginConfig(
            rownd_app_key="app-key",
            rownd_app_secret="secret",
            schema={
                "profile_field": {
                    "include_in_session_claims": True,
                    "session_claim_name": claim_name,
                }
            },
        )
    )


async def test_init_accepts_non_reserved_session_claim_name():
    plugin.init(
        RowndPluginConfig(
            rownd_app_key="app-key",
            rownd_app_secret="secret",
            schema={
                "profile_field": {
                    "include_in_session_claims": True,
                    "session_claim_name": "profile_field_claim",
                }
            },
        )
    )


async def test_reserved_session_claim_contract():
    assert RESERVED_SESSION_CLAIMS == {
        "iss",
        "sub",
        "aud",
        "exp",
        "nbf",
        "iat",
        "jti",
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
        "https://auth.rownd.io/app_user_id",
        "https://auth.rownd.io/is_verified_user",
        "https://auth.rownd.io/is_anonymous",
        "https://auth.rownd.io/issued_offline",
        "https://auth.rownd.io/jwt_type",
        "https://auth.rownd.io/platform_jwt",
        "https://auth.rownd.io/auth_level",
    }


async def test_reserved_oauth_claim_contract():
    assert RESERVED_OAUTH_CLAIMS == RESERVED_SESSION_CLAIMS | {
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


async def test_reserved_claim_constants_are_immutable():
    assert isinstance(RESERVED_SESSION_CLAIMS, frozenset)
    assert isinstance(RESERVED_OAUTH_CLAIMS, frozenset)
    with pytest.raises(TypeError):
        cast(Any, ROWND_JWT_CLAIMS)["app_user_id"] = "changed"
    with pytest.raises(AttributeError):
        cast(Any, RESERVED_SESSION_CLAIMS).add("changed")


@pytest.mark.parametrize("claim_name", sorted(RESERVED_SESSION_CLAIMS))
async def test_configured_claim_builder_filters_every_reserved_name(claim_name: str):
    config = make_config()
    config.schema = {
        "profile_field": {
            "include_in_session_claims": True,
            "session_claim_name": claim_name,
        }
    }

    assert compatibility.build_configured_session_claims(config, {"profile_field": "attacker"}) == {}


@pytest.mark.parametrize("claim_name", sorted(RESERVED_OAUTH_CLAIMS - RESERVED_SESSION_CLAIMS))
async def test_configured_claim_builder_filters_every_oauth_only_reserved_name(
    claim_name: str,
):
    config = make_config()
    config.schema = {
        "profile_field": {
            "include_in_session_claims": True,
            "session_claim_name": claim_name,
        }
    }

    assert (
        compatibility.build_configured_session_claims(
            config, {"profile_field": "attacker"}, RESERVED_OAUTH_CLAIMS
        )
        == {}
    )


@pytest.mark.parametrize("claim_name", ["email", "name", "phone_number", "updated_at"])
async def test_normal_session_preserves_custom_oidc_named_claims(claim_name: str):
    config = make_config()
    config.schema = {
        "profile_field": {
            "include_in_session_claims": True,
            "session_claim_name": claim_name,
        }
    }

    assert compatibility.build_configured_session_claims(config, {"profile_field": "preserved"}) == {
        claim_name: "preserved"
    }


@pytest.mark.parametrize(
    "field_config",
    [
        {"include_in_session_claims": True},
        {"include_in_session_claims": True, "session_claim_name": ""},
        {"include_in_session_claims": True, "session_claim_name": None},
    ],
)
async def test_configured_claim_builder_filters_reserved_field_name_fallback(
    field_config: Dict[str, Any],
):
    config = make_config()
    config.schema = cast(Any, {"sub": field_config})

    assert compatibility.build_configured_session_claims(config, {"sub": "attacker"}) == {}


@pytest.mark.parametrize(
    "field_config",
    [
        {"include_in_session_claims": True},
        {"include_in_session_claims": True, "session_claim_name": ""},
        {"include_in_session_claims": True, "session_claim_name": None},
    ],
)
async def test_configured_claim_builder_uses_field_name_fallback(
    field_config: Dict[str, Any],
):
    config = make_config()
    config.schema = cast(Any, {"profile_field": field_config})

    assert compatibility.build_configured_session_claims(config, {"profile_field": "preserved"}) == {
        "profile_field": "preserved"
    }


async def test_configured_claim_builder_preserves_valid_custom_claim():
    config = make_config()
    config.schema = {
        "profile_field": {
            "include_in_session_claims": True,
            "session_claim_name": "profile_field_claim",
        }
    }

    assert compatibility.build_configured_session_claims(config, {"profile_field": "preserved"}) == {
        "profile_field_claim": "preserved"
    }


async def test_reserved_session_claim_is_allowed_and_ignored_when_excluded():
    config = RowndPluginConfig(
        rownd_app_key="app-key",
        rownd_app_secret="secret",
        schema={
            "profile_field": {
                "include_in_session_claims": False,
                "session_claim_name": "st-role",
            }
        },
    )

    plugin.init(config)
    assert compatibility.build_configured_session_claims(config, {"profile_field": "attacker"}) == {}


@pytest.mark.parametrize("claim_name", [[], {}, 1, 0, True, False])
async def test_init_rejects_malformed_session_claim_name(claim_name: Any):
    with pytest.raises(
        ValueError, match=r"schema\.profile_field\.session_claim_name must be a string"
    ):
        plugin.init(
            RowndPluginConfig(
                rownd_app_key="app-key",
                rownd_app_secret="secret",
                schema=cast(
                    Any,
                    {
                        "profile_field": {
                            "include_in_session_claims": True,
                            "session_claim_name": claim_name,
                        }
                    },
                ),
            )
        )


async def test_post_init_schema_mutation_fails_with_field_path():
    config = RowndPluginConfig(
        rownd_app_key="app-key",
        rownd_app_secret="secret",
        schema={"profile_field": {"include_in_session_claims": True}},
    )
    plugin.init(config)
    config.schema["profile_field"]["session_claim_name"] = cast(Any, [])

    with pytest.raises(
        ValueError, match=r"schema\.profile_field\.session_claim_name must be a string"
    ):
        compatibility.build_configured_session_claims(config, {"profile_field": "value"})


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


async def test_init_validates_email_retirement_mode():
    with pytest.raises(
        ValueError, match="email_change.retirement_mode must be 'observe' or 'guard'"
    ):
        plugin.init(
            RowndPluginConfig(
                rownd_app_key="app-key",
                rownd_app_secret="secret",
                email_change=cast(Any, {"retirement_mode": "invalid"}),
            )
        )

    config = make_config()
    plugin.init(config)
    assert config.email_change.get("retirement_mode") == "observe"


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

    monkeypatch.setattr(supertokens_repository, "inspect_linked_user_metadata", inspect)

    payload = await supertokens_repository.build_rownd_oauth_payload(
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


async def test_oauth_payload_preserves_authoritative_reserved_claims(
    monkeypatch: pytest.MonkeyPatch,
):
    login_method = LoginMethod(
        "passwordless",
        "recipe-user",
        ["public"],
        "oauth-reserved@example.com",
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
        ["oauth-reserved@example.com"],
        [],
        [],
        cast(Any, []),
        [login_method],
        1000,
    )
    oauth_only_claims = sorted(RESERVED_OAUTH_CLAIMS - RESERVED_SESSION_CLAIMS)
    authoritative_claims: Dict[str, Any] = {
        claim_name: "authoritative-%s" % claim_name for claim_name in oauth_only_claims
    }
    authoritative_claims.update(
        {
            "st-role": ["admin"],
            "st-perm": ["read"],
            "st-mfa": {"v": True},
            "st-ev": {"v": True},
        }
    )
    configured_claim_names = [
        *oauth_only_claims,
        "st-role",
        "st-perm",
        "st-mfa",
        "st-ev",
    ]
    config = make_config()
    config.schema = {
        "spoofed_%s" % index: {
            "include_in_session_claims": True,
            "session_claim_name": claim_name,
        }
        for index, claim_name in enumerate(configured_claim_names)
    }
    metadata: Dict[str, Any] = {
        "original_rownd_user": {
            "data": {
                "user_id": "rownd-user",
                "email": "oauth-reserved@example.com",
                "first_name": "Ada",
                "last_name": "Lovelace",
                "updated_at": "2026-01-01T00:00:00Z",
            },
            "verified_data": {"email": True},
        },
        **{
            "spoofed_%s" % index: "attacker"
            for index in range(len(configured_claim_names))
        },
    }

    async def inspect(*_args: Any, **_kwargs: Any):
        return {"user": user, "combined_metadata": metadata}

    monkeypatch.setattr(supertokens_repository, "inspect_linked_user_metadata", inspect)

    payload = await supertokens_repository.build_rownd_oauth_payload(
        config,
        user,
        ["email", "profile"],
        authoritative_claims,
        {},
    )

    standard_claims = {
        "email": "oauth-reserved@example.com",
        "email_verified": True,
        "name": "Ada Lovelace",
        "given_name": "Ada",
        "family_name": "Lovelace",
        "updated_at": "2026-01-01T00:00:00Z",
    }
    for claim_name in oauth_only_claims:
        assert payload[claim_name] == standard_claims.get(
            claim_name, authoritative_claims[claim_name]
        )
    for claim_name in ["st-role", "st-perm", "st-mfa", "st-ev"]:
        assert payload[claim_name] == authoritative_claims[claim_name]


async def test_rownd_oauth_user_info_picks_rownd_claims(monkeypatch: pytest.MonkeyPatch):
    user = User("st-user", False, ["public"], ["user@example.com"], [], [], cast(Any, []), [], 1000)

    async def get_user_metadata(user_id: str):
        return {}

    async def inspect(user_id: str, user_context: Any = None, user_override: Any = None):
        return {"user": user_override or user, "combined_metadata": {}}

    monkeypatch.setattr(supertokens_repository, "inspect_linked_user_metadata", inspect)

    user_info = await supertokens_repository.build_rownd_oauth_user_info(
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


async def test_repository_resolves_compatibility_policy_from_owning_module(
    monkeypatch: pytest.MonkeyPatch,
):
    user = User("st-user", False, ["public"], [], [], [], cast(Any, []), [], 1000)

    async def inspect(*_args: Any, **_kwargs: Any):
        return {"user": user, "combined_metadata": {}}

    monkeypatch.setattr(supertokens_repository, "inspect_linked_user_metadata", inspect)
    monkeypatch.setattr(
        compatibility,
        "build_standard_oauth_claims",
        lambda *_args, **_kwargs: {"policy_owner_patch": True},
    )

    user_info = await supertokens_repository.build_rownd_oauth_user_info(user, {}, [], {})

    assert user_info["policy_owner_patch"] is True


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


async def test_refresh_does_not_clear_reserved_claims_from_runtime_config(
    monkeypatch: pytest.MonkeyPatch,
):
    config = make_config()
    config.schema = {
        "spoofed_%s" % index: {
            "include_in_session_claims": True,
            "session_claim_name": claim_name,
        }
        for index, claim_name in enumerate(
            ["sub", "st-role", "st-perm", "st-mfa", "st-ev"]
        )
    }
    protected_payload = {
        "sub": "real-user",
        "st-role": ["admin"],
        "st-perm": ["read"],
        "st-mfa": {"v": True},
        "st-ev": {"v": True},
    }
    session = RefreshSession(protected_payload)

    async def build_claims(*_args: Any, **_kwargs: Any):
        return {"auth_level": "verified"}, {"is_anonymous": {"v": False, "t": 1}}

    monkeypatch.setattr(plugin, "build_rownd_session_and_anonymous_claims", build_claims)

    await plugin.refresh_rownd_session_claims(config, cast(Any, session), "user", None, {})

    assert session.merged is not None
    assert protected_payload.keys().isdisjoint(session.merged)


async def test_refresh_preserves_configured_oidc_named_session_claims(
    monkeypatch: pytest.MonkeyPatch,
):
    config = make_config()
    config.schema = {
        "profile_email": {
            "include_in_session_claims": True,
            "session_claim_name": "email",
        },
        "profile_name": {
            "include_in_session_claims": True,
            "session_claim_name": "name",
        },
    }
    session = RefreshSession({"email": "old@example.com", "name": "Old Name"})

    async def build_claims(*_args: Any, **_kwargs: Any):
        return {
            "email": "new@example.com",
            "name": "New Name",
        }, {"is_anonymous": {"v": False, "t": 1}}

    monkeypatch.setattr(plugin, "build_rownd_session_and_anonymous_claims", build_claims)

    await plugin.refresh_rownd_session_claims(config, cast(Any, session), "user", None, {})

    assert session.merged is not None
    assert session.merged["email"] == "new@example.com"
    assert session.merged["name"] == "New Name"


async def test_refresh_fails_safely_after_malformed_schema_mutation(
    monkeypatch: pytest.MonkeyPatch,
):
    config = make_config()
    config.schema = {"profile_field": {"include_in_session_claims": True}}
    plugin.init(config)
    config.schema["profile_field"]["session_claim_name"] = cast(Any, [])
    session = RefreshSession({})

    async def build_claims(*_args: Any, **_kwargs: Any):
        return {}, {"is_anonymous": {"v": False, "t": 1}}

    monkeypatch.setattr(plugin, "build_rownd_session_and_anonymous_claims", build_claims)

    with pytest.raises(
        ValueError, match=r"schema\.profile_field\.session_claim_name must be a string"
    ):
        await plugin.refresh_rownd_session_claims(config, cast(Any, session), "user", None, {})
    assert session.merged is None


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
    context = utils.build_email_change_user_context(
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

    monkeypatch.setattr(
        supertokens_repository.session_asyncio, "get_session_information", get_session_information
    )
    monkeypatch.setattr(supertokens_repository, "get_raw_user_metadata", get_user_metadata)

    result = await supertokens_repository.resolve_pending_email_verification_token(
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
            "user_id": "user-id",
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
    monkeypatch.setattr(
        supertokens_repository,
        "authorize_passwordless_email",
        lambda *_args, **_kwargs: asyncio.sleep(
            0,
            result=EmailCredentialAuthorization(
                EmailCredentialState.ALLOW,
                EmailCredentialReason.CANONICAL,
                "user-id",
                "recipe-user",
            ),
        ),
    )
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
    first = utils.create_derived_user_context(parent, {"temporary": "first"})
    second = utils.create_derived_user_context(parent, {"temporary": "second"})

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
    derived = utils.create_derived_user_context(empty_parent, {"temporary": True})
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
    first = utils.create_derived_user_context(parent, {})
    second = utils.create_derived_user_context(parent, {})
    stable_default = parent["_default"]
    querier = object.__new__(Querier)

    querier.invalidate_core_call_cache(first)

    assert parent["_default"] is stable_default
    assert first["_default"] is stable_default
    assert second["_default"] is stable_default
    assert stable_default == {"keep_cache_alive": True, "core_call_cache": {}}
    assert dict(first)["_default"] is stable_default


async def test_passwordless_request_contexts_are_isolated_during_overlap(
    monkeypatch: pytest.MonkeyPatch,
):
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

    async def authorize(*_args: Any, **_kwargs: Any):
        return EmailCredentialAuthorization(
            EmailCredentialState.ALLOW, EmailCredentialReason.NO_OWNER
        )

    monkeypatch.setattr(supertokens_repository, "authorize_passwordless_email", authorize)
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
        context = utils.create_derived_user_context(
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

    monkeypatch.setattr(supertokens_repository, "get_rownd_compat_user", get_compat_user)
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

    monkeypatch.setattr(supertokens_repository, "inspect_linked_user_metadata", inspect)

    claims, anonymous = await supertokens_repository.build_rownd_session_and_anonymous_claims(
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

    monkeypatch.setattr(supertokens_repository, "inspect_linked_user_metadata", inspect)

    await supertokens_repository.build_rownd_oauth_payload(
        make_config(), user, ["email"], {}, context
    )

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

    monkeypatch.setattr(supertokens_repository, "inspect_linked_user_metadata", inspect)
    monkeypatch.setattr(supertokens_repository, "get_raw_user_metadata", get_raw)
    monkeypatch.setattr(
        supertokens_repository.usermetadata_asyncio, "update_user_metadata", update
    )

    await supertokens_repository.record_rownd_app_variant_for_user(
        make_config(), "user", "variant_123", context
    )

    original = cast(Dict[str, Any], written["original_rownd_user"])
    assert original["attributes"] == {
        "preserved": True,
        "rownd:app_variants": ["variant_123"],
    }


async def _invoke_observe_passwordless_operation(
    operation: str, original: Any, config: RowndPluginConfig
):
    if operation == "consume":
        overridden = plugin._passwordless_function_override(config)(
            cast(Any, SimpleNamespace(consume_code=original))
        )
        return await overridden.consume_code(
            "pre", None, None, "link", None, None, "public", {}
        )

    overridden = plugin._passwordless_api_override(config)(
        cast(
            Any,
            SimpleNamespace(
                create_code_post=original,
                consume_code_post=None,
                resend_code_post=original,
            ),
        )
    )
    if operation == "create":
        return await overridden.create_code_post(
            "user@example.com",
            None,
            None,
            None,
            "public",
            cast(Any, SimpleNamespace(request=FakeRequest())),
            {},
        )
    return await overridden.resend_code_post(
        "device",
        "pre",
        None,
        None,
        "public",
        cast(Any, SimpleNamespace(request=FakeRequest())),
        {},
    )


@pytest.mark.parametrize("operation", ["create", "resend", "consume"])
@pytest.mark.parametrize(
    ("authorization", "diagnostic_code", "reason_code"),
    [
        (
            EmailCredentialAuthorization(
                EmailCredentialState.RETIRED, EmailCredentialReason.NONCANONICAL
            ),
            "classification_rejected",
            "noncanonical",
        ),
        (
            EmailCredentialAuthorization(
                EmailCredentialState.MALFORMED, EmailCredentialReason.SECURITY_METADATA
            ),
            "classification_rejected",
            "security_metadata",
        ),
        (
            EmailCredentialAuthorization(
                EmailCredentialState.AMBIGUOUS, EmailCredentialReason.MULTIPLE_OWNERS
            ),
            "classification_rejected",
            "multiple_owners",
        ),
        (None, "classification_exception", None),
        (
            EmailCredentialAuthorization(
                EmailCredentialState.ALLOW, EmailCredentialReason.CANONICAL
            ),
            None,
            None,
        ),
    ],
)
async def test_passwordless_observe_mode_diagnostics_preserve_original_behavior(
    monkeypatch: pytest.MonkeyPatch,
    operation: str,
    authorization: Optional[EmailCredentialAuthorization],
    diagnostic_code: Optional[str],
    reason_code: Optional[str],
):
    calls: list[str] = []
    diagnostics: list[str] = []
    diagnostic_configs: list[RowndPluginConfig] = []
    config = make_config()
    config.enable_debug_logs = False

    async def authorize(*_args: Any, **_kwargs: Any):
        if authorization is None:
            raise RuntimeError("sensitive classifier failure")
        return authorization

    async def original(*_args: Any, **_kwargs: Any):
        calls.append(operation)
        return SimpleNamespace(status="ORIGINAL")

    monkeypatch.setattr(supertokens_repository, "authorize_passwordless_email", authorize)
    monkeypatch.setattr(
        supertokens_repository,
        "resolve_passwordless_device_email",
        lambda *_args, **_kwargs: asyncio.sleep(0, result="user@example.com"),
    )
    def capture_warning(warning_config: RowndPluginConfig, message: str):
        diagnostic_configs.append(warning_config)
        diagnostics.append(message)

    monkeypatch.setattr(plugin, "log_warning", capture_warning)

    result = await _invoke_observe_passwordless_operation(operation, original, config)

    assert cast(Any, result).status == "ORIGINAL"
    assert calls == [operation]
    if diagnostic_code is None:
        assert diagnostics == []
        assert diagnostic_configs == []
    else:
        assert any(
            f"operation={operation}" in diagnostic
            and f"code={diagnostic_code}" in diagnostic
            and (reason_code is None or f"reason={reason_code}" in diagnostic)
            for diagnostic in diagnostics
        )
        assert diagnostic_configs == [config]
        assert all("sensitive classifier failure" not in diagnostic for diagnostic in diagnostics)
    assert config.enable_debug_logs is False

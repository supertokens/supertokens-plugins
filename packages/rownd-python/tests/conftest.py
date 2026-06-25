from __future__ import annotations

import time
from os import environ
from typing import Any, Dict, Optional

environ["SUPERTOKENS_ENV"] = "testing"

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from testcontainers.core.container import DockerContainer
from testcontainers.core.network import Network
from testcontainers.core.waiting_utils import WaitStrategy, WaitStrategyTarget

from supertokens_python import (
    InputAppInfo,
    Supertokens,
    SupertokensConfig,
    SupertokensExperimentalConfig,
    init as supertokens_init,
)
from supertokens_python.framework.fastapi import get_middleware
from supertokens_python.process_state import ProcessState
from supertokens_python.recipe import accountlinking, emailverification, passwordless, session, thirdparty, usermetadata
from supertokens_python.recipe.accountlinking.recipe import AccountLinkingRecipe
from supertokens_python.recipe.dashboard import DashboardRecipe
from supertokens_python.recipe.emailpassword import EmailPasswordRecipe
from supertokens_python.recipe.emailverification import EmailVerificationRecipe
from supertokens_python.recipe.jwt import JWTRecipe
from supertokens_python.recipe.multifactorauth.recipe import MultiFactorAuthRecipe
from supertokens_python.recipe.multitenancy.recipe import MultitenancyRecipe
from supertokens_python.recipe.oauth2provider import OAuth2ProviderRecipe
from supertokens_python.recipe.openid import OpenIdRecipe
from supertokens_python.recipe.passwordless.recipe import PasswordlessRecipe
from supertokens_python.recipe.saml.recipe import SAMLRecipe
from supertokens_python.recipe.session import SessionRecipe
from supertokens_python.recipe.thirdparty import ProviderClientConfig, ProviderConfig, ProviderInput, ThirdPartyRecipe
from supertokens_python.recipe.totp import TOTPRecipe
from supertokens_python.recipe.usermetadata import UserMetadataRecipe
from supertokens_python.recipe.userroles import UserRolesRecipe
from supertokens_python.recipe.webauthn.recipe import WebauthnRecipe

from supertokens_rownd import init as rownd_init
from supertokens_rownd.types import RowndPluginConfig, RowndPluginError


class MockRowndClient:
    def __init__(self) -> None:
        self.user_id = "rownd-user"
        self.user_info: Optional[Dict[str, Any]] = {
            "data": {"user_id": self.user_id, "email": "rownd-user@example.com"},
            "verified_data": {"email": True},
            "meta": {"created": "2026-01-01T00:00:00.000Z"},
        }
        self.validate_error: Optional[Exception] = None
        self.fetch_error: Optional[Exception] = None

    async def validate_token(self, token: str) -> str:
        if self.validate_error is not None:
            raise self.validate_error
        return self.user_id

    async def fetch_user_info(self, user_id: str) -> Dict[str, Any]:
        user_info = await self.fetch_optional_user_info(user_id)
        if user_info is None:
            raise RowndPluginError("User not found in Rownd")
        return user_info

    async def fetch_optional_user_info(self, user_id: str) -> Optional[Dict[str, Any]]:
        if self.fetch_error is not None:
            raise self.fetch_error
        return self.user_info


class TestClientWithNoCookieJar(TestClient):
    def request(self, *args: Any, **kwargs: Any):  # type: ignore[no-untyped-def]
        self.cookies.clear()
        return super().request(*args, **kwargs)  # type: ignore[no-any-return]


class LogMessageWaitStrategy(WaitStrategy):
    def __init__(self, message: str) -> None:
        super().__init__()
        self.message = message

    def wait_until_ready(self, container: WaitStrategyTarget) -> None:
        def has_message() -> bool:
            stdout, stderr = container.get_logs()
            logs = stdout.decode(errors="ignore") + stderr.decode(errors="ignore")
            return self.message in logs

        if not self._poll(has_message):
            raise TimeoutError("Timed out waiting for log message: %s" % self.message)


@pytest.fixture(scope="session")
def core_url():
    network = Network()
    network.create()
    postgres = None
    core = None
    try:
        postgres = (
            DockerContainer("postgres:14")
            .with_network(network)
            .with_network_aliases("postgres")
            .with_env("POSTGRES_USER", "supertokens")
            .with_env("POSTGRES_PASSWORD", "somepassword")
            .with_env("POSTGRES_DB", "supertokens")
            .with_exposed_ports(5432)
            .waiting_for(LogMessageWaitStrategy("database system is ready to accept connections").with_startup_timeout(60))
        )
        postgres.start()

        core = (
            DockerContainer("supertokens/supertokens-postgresql")
            .with_network(network)
            .with_env(
                "POSTGRESQL_CONNECTION_URI",
                "postgresql://supertokens:somepassword@postgres:5432/supertokens",
            )
            .with_exposed_ports(3567)
        )
        core.start()
        url = "http://%s:%s" % (core.get_container_host_ip(), core.get_exposed_port(3567))
        deadline = time.time() + 60
        while time.time() < deadline:
            try:
                if httpx.get(url + "/hello", timeout=2.0).status_code == 200:
                    yield url
                    return
            except Exception:
                time.sleep(0.5)
        raise RuntimeError("SuperTokens Core container did not become ready")
    finally:
        if core is not None:
            core.stop()
        if postgres is not None:
            postgres.stop()
        network.remove()


@pytest.fixture(scope="session")
def memory_core_url():
    core = None
    try:
        core = DockerContainer("supertokens/supertokens-postgresql").with_exposed_ports(3567)
        core.start()
        url = "http://%s:%s" % (core.get_container_host_ip(), core.get_exposed_port(3567))
        deadline = time.time() + 60
        while time.time() < deadline:
            try:
                if httpx.get(url + "/hello", timeout=2.0).status_code == 200:
                    yield url
                    return
            except Exception:
                time.sleep(0.5)
        raise RuntimeError("SuperTokens in-memory Core container did not become ready")
    finally:
        if core is not None:
            core.stop()


@pytest.fixture(autouse=True)
def reset_supertokens():
    reset_st()
    yield
    reset_st()


@pytest.fixture
def rownd_client() -> MockRowndClient:
    return MockRowndClient()


def make_client(
    core_url: str,
    rownd_client: MockRowndClient,
    plugin_config: Optional[Dict[str, Any]] = None,
    enable_email_verification: bool = False,
    email_verification_mode: str = "OPTIONAL",
) -> TestClientWithNoCookieJar:
    app = FastAPI()
    app.add_middleware(get_middleware())

    api_domain = "http://testserver"
    rownd_config = RowndPluginConfig(
        rownd_app_key="test-key",
        rownd_app_secret="test-secret",
        api_base_path="/auth",
        api_domain=api_domain,
        app_name="Test App",
        rownd_client=rownd_client,
        **(plugin_config or {}),
    )

    recipes = [
        accountlinking.init(),
        session.init(anti_csrf="NONE"),
        usermetadata.init(),
        passwordless.init(
            contact_config=passwordless.ContactEmailOrPhoneConfig(),
            flow_type="MAGIC_LINK",
        ),
        thirdparty.init(
            sign_in_and_up_feature=thirdparty.SignInAndUpFeature(
                providers=[
                    ProviderInput(
                        config=ProviderConfig(
                            third_party_id="google",
                            clients=[ProviderClientConfig(client_id="test", client_secret="test")],
                        )
                    ),
                    ProviderInput(
                        config=ProviderConfig(
                            third_party_id="apple",
                            clients=[ProviderClientConfig(client_id="test", client_secret="test")],
                        )
                    ),
                ]
            )
        ),
    ]
    if enable_email_verification:
        recipes.insert(4, emailverification.init(mode=email_verification_mode))

    supertokens_init(
        app_info=InputAppInfo(
            app_name="Test App",
            api_domain=api_domain,
            website_domain="http://website.example.com",
            api_base_path="/auth",
        ),
        framework="fastapi",
        supertokens_config=SupertokensConfig(core_url),
        recipe_list=recipes,
        experimental=SupertokensExperimentalConfig(plugins=[rownd_init(rownd_config)]),
    )

    return TestClientWithNoCookieJar(app, raise_server_exceptions=False)


def auth_headers(access_token: str) -> Dict[str, str]:
    return {
        "Authorization": "Bearer %s" % access_token,
        "rid": "session",
        "fdi-version": "1.18",
        "st-auth-mode": "header",
    }


def session_headers() -> Dict[str, str]:
    return {"rid": "session", "fdi-version": "1.18", "st-auth-mode": "header"}


def reset_st() -> None:
    ProcessState.get_instance().reset()
    Supertokens.reset()
    SessionRecipe.reset()
    EmailPasswordRecipe.reset()
    EmailVerificationRecipe.reset()
    ThirdPartyRecipe.reset()
    PasswordlessRecipe.reset()
    JWTRecipe.reset()
    UserMetadataRecipe.reset()
    UserRolesRecipe.reset()
    DashboardRecipe.reset()
    MultitenancyRecipe.reset()
    AccountLinkingRecipe.reset()
    MultiFactorAuthRecipe.reset()
    TOTPRecipe.reset()
    OpenIdRecipe.reset()
    OAuth2ProviderRecipe.reset()
    SAMLRecipe.reset()
    WebauthnRecipe.reset()

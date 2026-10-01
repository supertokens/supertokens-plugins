from __future__ import annotations

import asyncio
import base64
import json
import time
from collections import Counter
from typing import Callable, Optional, cast
from unittest.mock import AsyncMock, Mock

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from supertokens_rownd.errors import RowndPluginError
import supertokens_rownd.plugin as plugin
from supertokens_rownd.rownd_repository import (
    RowndAPIError,
    RowndAPIErrorReason,
    RowndClient,
    RowndTokenValidationError,
    RowndTokenValidationReason,
)
import supertokens_rownd.telemetry.create_telemetry_client as telemetry
from supertokens_rownd.types import JsonDict, RowndPluginConfig, RowndPluginKwargs


APP_ID = "app-id"
CONFIGURED_APP_ID = "327677849595019856"
USER_ID = "rownd-user-id"


def _jwk(key_id: str, private_key: Ed25519PrivateKey) -> JsonDict:
    public_bytes = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    x = base64.urlsafe_b64encode(public_bytes).rstrip(b"=").decode("ascii")
    return {"kty": "OKP", "crv": "Ed25519", "x": x, "kid": key_id, "alg": "EdDSA"}


def _token(
    key_id: str,
    private_key: Ed25519PrivateKey,
    *,
    algorithm: str = "EdDSA",
    claims: Optional[JsonDict] = None,
    omit_claims: tuple[str, ...] = (),
) -> str:
    now = int(time.time())
    payload: JsonDict = {
        "aud": "app:%s" % APP_ID,
        "exp": now + 300,
        "iat": now,
        "https://auth.rownd.io/app_user_id": USER_ID,
    }
    if claims is not None:
        payload.update(claims)
    for claim in omit_claims:
        payload.pop(claim, None)
    token = jwt.encode(
        payload,
        private_key,
        algorithm=algorithm,
        headers={"kid": key_id},
    )
    assert isinstance(token, str)
    return token


class RowndTransport(httpx.AsyncBaseTransport):
    def __init__(self, jwks: JsonDict):
        self.jwks = jwks
        self.calls: Counter[str] = Counter()
        self.refresh_failure: Optional[str] = None
        self.jwks_started: Optional[asyncio.Event] = None
        self.release_jwks: Optional[asyncio.Event] = None
        self.gate_all_jwks = False
        self.discovery: JsonDict = {"jwks_uri": "https://keys.example/jwks"}
        self.app_config_started: Optional[asyncio.Event] = None
        self.release_app_config: Optional[asyncio.Event] = None
        self.app_config_status = 200

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.calls[request.url.path] += 1
        if request.url.path == "/hub/auth/.well-known/oauth-authorization-server":
            return httpx.Response(200, json=self.discovery)
        if request.url.path == "/jwks":
            gated = self.gate_all_jwks or self.calls["/jwks"] > 1
            if self.jwks_started is not None and gated:
                self.jwks_started.set()
            if self.release_jwks is not None and gated:
                await self.release_jwks.wait()
            if self.refresh_failure == "always_timeout" or (
                self.refresh_failure == "timeout" and self.calls["/jwks"] > 1
            ):
                raise httpx.ReadTimeout("JWKS timed out", request=request)
            if self.refresh_failure == "malformed" and self.calls["/jwks"] > 1:
                return httpx.Response(200, json={"keys": "invalid"})
            return httpx.Response(200, json=self.jwks)
        if request.url.path == "/hub/app-config":
            if self.app_config_started is not None:
                self.app_config_started.set()
            if self.release_app_config is not None:
                await self.release_app_config.wait()
            if self.app_config_status != 200:
                return httpx.Response(self.app_config_status)
            return httpx.Response(200, json={"app": {"id": APP_ID}})
        return httpx.Response(404)


def _client(transport: httpx.AsyncBaseTransport) -> RowndClient:
    return RowndClient(
        RowndPluginConfig(
            rownd_app_key="app-key",
            rownd_app_secret="app-secret",
            rownd_api_base_url="https://api.example",
        ),
        transport=transport,
    )


def _client_with_clock(
    transport: httpx.AsyncBaseTransport, monotonic: Callable[[], float]
) -> RowndClient:
    return RowndClient(
        RowndPluginConfig(
            rownd_app_key="app-key",
            rownd_app_secret="app-secret",
            rownd_api_base_url="https://api.example",
        ),
        transport=transport,
        monotonic=monotonic,
    )


@pytest.mark.parametrize("as_kwargs", [False, True])
@pytest.mark.parametrize(
    "app_id",
    [None, CONFIGURED_APP_ID, "app_123", "app-id", "opaque.~:id@!$&'()*+,;="],
)
def test_factory_accepts_url_segment_app_id(app_id: Optional[str], as_kwargs: bool) -> None:
    kwargs: RowndPluginKwargs = {
        "rownd_app_key": "app-key",
        "rownd_app_secret": "app-secret",
        "rownd_app_id": app_id,
    }
    if as_kwargs:
        assert plugin.init(**kwargs) is not None
    else:
        config = RowndPluginConfig(**kwargs)
        assert plugin.init(config) is not None
        assert config.rownd_app_id == app_id


@pytest.mark.parametrize("as_kwargs", [False, True])
@pytest.mark.parametrize(
    "app_id",
    [
        "", " ", " app-id", "app-id ", "app id", "app\t-id", "app-id\n",
        "app\r-id", "app\x00-id", "app\x7f-id", ".", "..", "app/id", "app\\id",
        "app?id", "app#id", "%2e%2e", "app%2fid", "app%252fid", "app%5cid",
        "https://other.example/app", "app\u00a0id", "app\ud800", 123, False, [], {},
    ],
)
def test_factory_rejects_unsafe_app_id_before_side_effects(
    monkeypatch: pytest.MonkeyPatch, app_id: object, as_kwargs: bool,
) -> None:
    activate = Mock()
    create_telemetry = Mock()
    create_client = Mock()
    monkeypatch.setattr(plugin, "set_active_rownd_config", activate)
    monkeypatch.setattr(plugin, "create_telemetry_client", create_telemetry)
    monkeypatch.setattr(plugin, "RowndClient", create_client)
    kwargs: RowndPluginKwargs = {
        "rownd_app_key": "app-key",
        "rownd_app_secret": "app-secret",
        "rownd_app_id": cast(str, app_id),
    }
    with pytest.raises(ValueError, match="rownd_app_id"):
        if as_kwargs:
            plugin.init(**kwargs)
        else:
            plugin.init(RowndPluginConfig(**kwargs))
    activate.assert_not_called()
    create_telemetry.assert_not_called()
    create_client.assert_not_called()


@pytest.fixture
def differing_sub_identity() -> tuple[Ed25519PrivateKey, JsonDict, JsonDict]:
    key = Ed25519PrivateKey.generate()
    claims: JsonDict = {
        "sub": "global-rownd-user-id",
        "https://auth.rownd.io/app_user_id": USER_ID,
    }
    profile: JsonDict = {
        "rownd_user": "global-rownd-user-id",
        "data": {"user_id": USER_ID, "email": "user@example.com"},
        "verified_data": {"email": "user@example.com"},
    }
    return key, claims, profile


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "configured_app_id", [None, CONFIGURED_APP_ID, "opaque.~:id@!$&'()*+,;="],
)
@pytest.mark.parametrize("omit_claims", [(), ("exp",)])
async def test_app_id_source_preserves_signed_app_user_profile_identity(
    differing_sub_identity: tuple[Ed25519PrivateKey, JsonDict, JsonDict],
    configured_app_id: Optional[str],
    omit_claims: tuple[str, ...],
) -> None:
    key, claims, profile = differing_sub_identity
    app_id = configured_app_id if configured_app_id is not None else APP_ID
    claims["aud"] = "app:%s" % app_id
    transport = RowndTransport({"keys": [_jwk("A", key)]})
    transport.app_config_status = 503 if configured_app_id is not None else 200
    profile_path = "/applications/%s/users/%s/data" % (app_id, USER_ID)

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == profile_path:
            transport.calls[request.url.path] += 1
            assert not request.url.query
            assert not request.url.fragment
            assert request.headers["x-rownd-app-key"] == "app-key"
            assert request.headers["x-rownd-app-secret"] == "app-secret"
            return httpx.Response(200, json=profile)
        return await transport.handle_async_request(request)

    client = RowndClient(
        RowndPluginConfig(
            rownd_app_key="app-key",
            rownd_app_secret="app-secret",
            rownd_app_id=configured_app_id,
            app_config={"app": {"id": "untrusted-id"}, "id": "untrusted-id"},
        ),
        transport=httpx.MockTransport(handler),
    )
    token = _token("A", key, claims=claims, omit_claims=omit_claims)
    assert await client.fetch_optional_user_info(USER_ID) == profile
    for _ in range(2):
        user_id = await client.validate_token(token)
        assert user_id == USER_ID
        assert user_id != claims["sub"]
        assert await client.fetch_user_info(user_id) == profile
    expected_calls = Counter({
        "/hub/auth/.well-known/oauth-authorization-server": 1,
        "/jwks": 1,
        profile_path: 3,
    })
    if configured_app_id is None:
        expected_calls["/hub/app-config"] = 1
    assert transport.calls == expected_calls


@pytest.mark.asyncio
@pytest.mark.parametrize("configured_app_id", [None, CONFIGURED_APP_ID])
async def test_subject_cannot_replace_missing_namespaced_identity(
    differing_sub_identity: tuple[Ed25519PrivateKey, JsonDict, JsonDict],
    configured_app_id: Optional[str],
) -> None:
    key, claims, _ = differing_sub_identity
    claims["aud"] = "app:%s" % (configured_app_id or APP_ID)
    transport = RowndTransport({"keys": [_jwk("A", key)]})
    client = _client(transport)
    client.config.rownd_app_id = configured_app_id

    with pytest.raises(RowndTokenValidationError) as exc_info:
        await client.validate_token(
            _token("A", key, claims=claims, omit_claims=("https://auth.rownd.io/app_user_id",))
        )

    assert exc_info.value.reason is RowndTokenValidationReason.TOKEN_CLAIMS_INVALID
    assert transport.calls["/hub/app-config"] == (1 if configured_app_id is None else 0)


@pytest.mark.asyncio
@pytest.mark.parametrize("status_code", [401, 404, 503])
async def test_configured_app_id_profile_failure_does_not_fall_back_to_discovery(
    status_code: int,
) -> None:
    calls: list[str] = []
    profile_path = "/applications/%s/users/%s/data" % (CONFIGURED_APP_ID, USER_ID)

    async def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        if request.url.path == "/hub/app-config":
            return httpx.Response(200, json={"app": {"id": APP_ID}})
        return httpx.Response(status_code)

    client = _client(httpx.MockTransport(handler))
    client.config.rownd_app_id = CONFIGURED_APP_ID
    for _ in range(2):
        if status_code == 404:
            assert await client.fetch_optional_user_info(USER_ID) is None
        else:
            with pytest.raises(RowndAPIError) as exc_info:
                await client.fetch_optional_user_info(USER_ID)
            assert exc_info.value.reason is (
                RowndAPIErrorReason.CREDENTIALS_REJECTED
                if status_code == 401
                else RowndAPIErrorReason.UNAVAILABLE
            )
    assert calls == [profile_path, profile_path]


@pytest.mark.asyncio
@pytest.mark.parametrize("configured_app_id", [None, CONFIGURED_APP_ID])
async def test_untrusted_app_config_and_token_cannot_choose_expected_audience(
    configured_app_id: Optional[str],
) -> None:
    key = Ed25519PrivateKey.generate()
    transport = RowndTransport({"keys": [_jwk("A", key)]})
    client = RowndClient(
        RowndPluginConfig(
            rownd_app_key="app-key",
            rownd_app_secret="app-secret",
            rownd_app_id=configured_app_id,
            app_config={"app": {"id": "untrusted-id"}, "id": "untrusted-id"},
        ),
        transport=transport,
    )
    other_app_id = APP_ID if configured_app_id is not None else CONFIGURED_APP_ID
    for audience in ["app:untrusted-id", "app:%s" % other_app_id]:
        with pytest.raises(RowndTokenValidationError) as exc_info:
            await client.validate_token(_token("A", key, claims={"aud": audience}))
        assert exc_info.value.reason is RowndTokenValidationReason.TOKEN_CLAIMS_INVALID
    expected_calls = Counter({
        "/hub/auth/.well-known/oauth-authorization-server": 1,
        "/jwks": 1,
    })
    if configured_app_id is None:
        expected_calls["/hub/app-config"] = 1
    assert transport.calls == expected_calls


@pytest.mark.asyncio
@pytest.mark.parametrize("omit_claims", [(), ("exp",)])
async def test_valid_eddsa_token_returns_rownd_user_id(omit_claims: tuple[str, ...]) -> None:
    key = Ed25519PrivateKey.generate()
    transport = RowndTransport({"keys": [_jwk("A", key)]})

    assert await _client(transport).validate_token(
        _token("A", key, omit_claims=omit_claims)
    ) == USER_ID


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "token",
    [
        "not-a-token",
        jwt.encode({}, Ed25519PrivateKey.generate(), algorithm="EdDSA"),
        jwt.encode({}, "a" * 32, algorithm="HS256", headers={"kid": "A"}),
    ],
)
async def test_malformed_or_unsupported_header_makes_no_http_calls(token: str) -> None:
    transport = RowndTransport({"keys": []})

    with pytest.raises(RowndPluginError, match="Invalid token"):
        await _client(transport).validate_token(token)

    assert transport.calls == Counter()


@pytest.mark.asyncio
@pytest.mark.parametrize("key_id", ["\ud800", "\udfff"], ids=["high-surrogate", "low-surrogate"])
@pytest.mark.parametrize("sample", [0.0, 1.0], ids=["sampled", "not-sampled"])
async def test_surrogate_kid_is_malformed_before_jwks_work(
    monkeypatch: pytest.MonkeyPatch, key_id: str, sample: float,
) -> None:
    token = _token(key_id, Ed25519PrivateKey.generate())
    assert token.isascii()
    assert jwt.get_unverified_header(token)["kid"] == key_id
    transport = RowndTransport({"keys": [_jwk("A", Ed25519PrivateKey.generate())]})
    client = _client(transport)
    telemetry_client = Mock()
    random_value = Mock(return_value=sample)
    monkeypatch.setattr(client, "_telemetry_client", telemetry_client)
    monkeypatch.setattr(client, "_random_value", random_value)
    load = AsyncMock(wraps=client._load_jwks)
    diagnostic = Mock(wraps=client._record_jwks_diagnostic)
    remember = Mock(wraps=client._remember_unknown_kid)
    monkeypatch.setattr(client, "_load_jwks", load)
    monkeypatch.setattr(client, "_record_jwks_diagnostic", diagnostic)
    monkeypatch.setattr(client, "_remember_unknown_kid", remember)

    with pytest.raises(RowndTokenValidationError) as exc_info:
        await client.validate_token(token)

    assert exc_info.value.reason is RowndTokenValidationReason.TOKEN_MALFORMED
    load.assert_not_called()
    diagnostic.assert_not_called()
    remember.assert_not_called()
    random_value.assert_not_called()
    assert telemetry_client.mock_calls == []
    assert transport.calls == Counter()
    assert client._jwks_cache is None
    assert client._jwks_refresh is None
    assert not client._negative_kids
    assert client._refresh_blocked_until == 0.0
    assert client._app_id_cache is None


@pytest.mark.asyncio
@pytest.mark.parametrize("key_id", ["cl\u00e9-\u5bc6\u94a5", "key-\U0001f511"])
async def test_valid_unicode_kid_verifies_and_reuses_cache(key_id: str) -> None:
    key = Ed25519PrivateKey.generate()
    transport = RowndTransport({"keys": [_jwk(key_id, key)]})
    client = _client(transport)
    token = _token(key_id, key)
    assert token.isascii()
    assert jwt.get_unverified_header(token)["kid"] == key_id

    assert await client.validate_token(token) == USER_ID
    assert await client.validate_token(token) == USER_ID
    assert transport.calls == Counter({
        "/hub/auth/.well-known/oauth-authorization-server": 1,
        "/jwks": 1,
        "/hub/app-config": 1,
    })


@pytest.mark.asyncio
async def test_malformed_payload_has_typed_reason() -> None:
    key = Ed25519PrivateKey.generate()
    transport = RowndTransport({"keys": [_jwk("A", key)]})
    valid = _token("A", key)
    header, _, signature = valid.split(".")

    with pytest.raises(RowndTokenValidationError) as exc_info:
        await _client(transport).validate_token("%s.invalid*.%s" % (header, signature))

    assert exc_info.value.reason is RowndTokenValidationReason.TOKEN_MALFORMED


@pytest.mark.asyncio
async def test_second_validation_reuses_discovery_and_jwks_cache() -> None:
    key = Ed25519PrivateKey.generate()
    transport = RowndTransport({"keys": [_jwk("A", key)]})
    client = _client(transport)
    token = _token("A", key)

    assert await client.validate_token(token) == USER_ID
    assert await client.validate_token(token) == USER_ID

    assert transport.calls["/hub/auth/.well-known/oauth-authorization-server"] == 1
    assert transport.calls["/jwks"] == 1
    assert transport.calls["/hub/app-config"] == 1


@pytest.mark.asyncio
async def test_rotated_key_forces_one_refresh_and_succeeds() -> None:
    key_a = Ed25519PrivateKey.generate()
    key_b = Ed25519PrivateKey.generate()
    transport = RowndTransport({"keys": [_jwk("A", key_a)]})
    client = _client(transport)
    assert await client.validate_token(_token("A", key_a)) == USER_ID

    rotated_jwks: JsonDict = {"keys": [_jwk("B", key_b)]}
    transport.jwks = rotated_jwks

    assert await client.validate_token(_token("B", key_b)) == USER_ID
    assert transport.calls["/hub/auth/.well-known/oauth-authorization-server"] == 2
    assert transport.calls["/jwks"] == 2


@pytest.mark.asyncio
async def test_unknown_kid_refreshes_once_and_has_typed_reason() -> None:
    key_a = Ed25519PrivateKey.generate()
    key_c = Ed25519PrivateKey.generate()
    transport = RowndTransport({"keys": [_jwk("A", key_a)]})
    client = _client(transport)
    assert await client.validate_token(_token("A", key_a)) == USER_ID

    with pytest.raises(RowndTokenValidationError, match="Invalid token") as exc_info:
        await client.validate_token(_token("C", key_c))

    assert exc_info.value.reason == RowndTokenValidationReason.TOKEN_KID_UNKNOWN
    assert transport.calls["/hub/auth/.well-known/oauth-authorization-server"] == 2
    assert transport.calls["/jwks"] == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("omit_claims", [(), ("exp",)])
async def test_known_kid_with_invalid_signature_does_not_refresh(
    omit_claims: tuple[str, ...],
) -> None:
    key_a = Ed25519PrivateKey.generate()
    wrong_key = Ed25519PrivateKey.generate()
    transport = RowndTransport({"keys": [_jwk("A", key_a)]})
    client = _client(transport)
    assert await client.validate_token(_token("A", key_a)) == USER_ID

    with pytest.raises(RowndTokenValidationError) as exc_info:
        await client.validate_token(_token("A", wrong_key, omit_claims=omit_claims))

    assert exc_info.value.reason == RowndTokenValidationReason.TOKEN_SIGNATURE_INVALID
    assert transport.calls["/hub/auth/.well-known/oauth-authorization-server"] == 1
    assert transport.calls["/jwks"] == 1


@pytest.mark.asyncio
async def test_known_kid_forgery_does_not_amplify_authenticated_requests() -> None:
    key = Ed25519PrivateKey.generate()
    attacker_key = Ed25519PrivateKey.generate()
    transport = RowndTransport({"keys": [_jwk("A", key)]})
    client = _client(transport)
    assert await client.validate_token(_token("A", key)) == USER_ID

    for _ in range(8):
        with pytest.raises(RowndTokenValidationError) as exc_info:
            await client.validate_token(_token("A", attacker_key))
        assert exc_info.value.reason is RowndTokenValidationReason.TOKEN_SIGNATURE_INVALID

    assert transport.calls["/hub/app-config"] == 1
    assert transport.calls["/jwks"] == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("temporal_state", ["expired", "not_active"])
async def test_temporally_invalid_token_does_not_fetch_app_config(
    temporal_state: str,
) -> None:
    key = Ed25519PrivateKey.generate()
    transport = RowndTransport({"keys": [_jwk("A", key)]})
    claims: JsonDict = (
        {"exp": int(time.time()) - 120}
        if temporal_state == "expired"
        else {"nbf": int(time.time()) + 120}
    )

    with pytest.raises(RowndTokenValidationError):
        await _client(transport).validate_token(_token("A", key, claims=claims))

    assert transport.calls["/hub/app-config"] == 0


@pytest.mark.asyncio
async def test_cross_audience_tokens_reuse_bounded_app_id_cache() -> None:
    key = Ed25519PrivateKey.generate()
    transport = RowndTransport({"keys": [_jwk("A", key)]})
    client = _client(transport)

    for _ in range(8):
        with pytest.raises(RowndTokenValidationError) as exc_info:
            await client.validate_token(_token("A", key, claims={"aud": "app:other"}))
        assert exc_info.value.reason is RowndTokenValidationReason.TOKEN_CLAIMS_INVALID

    assert transport.calls["/hub/app-config"] == 1


@pytest.mark.asyncio
async def test_app_id_cache_is_bounded_and_single_flight() -> None:
    key = Ed25519PrivateKey.generate()
    transport = RowndTransport({"keys": [_jwk("A", key)]})
    now = 10.0
    client = _client_with_clock(transport, lambda: now)
    transport.app_config_started = asyncio.Event()
    transport.release_app_config = asyncio.Event()

    loads = [asyncio.create_task(client._fetch_app_id()) for _ in range(8)]
    await transport.app_config_started.wait()
    transport.release_app_config.set()
    assert await asyncio.gather(*loads) == [APP_ID] * 8
    assert transport.calls["/hub/app-config"] == 1
    assert client._app_id_cache is not None
    assert client._app_id_cache.generation == 1

    assert await client._fetch_app_id() == APP_ID
    assert transport.calls["/hub/app-config"] == 1
    now += RowndClient._APP_ID_CACHE_TTL_SECONDS
    assert await client._fetch_app_id() == APP_ID
    assert transport.calls["/hub/app-config"] == 2
    assert client._app_id_cache is not None
    assert client._app_id_cache.generation == 2


@pytest.mark.asyncio
async def test_app_id_failure_is_replayed_during_backoff() -> None:
    transport = RowndTransport({"keys": []})
    transport.app_config_status = 503
    now = 10.0
    client = _client_with_clock(transport, lambda: now)

    for _ in range(2):
        with pytest.raises(RowndAPIError) as exc_info:
            await client._fetch_app_id()
        assert exc_info.value.reason is RowndAPIErrorReason.UNAVAILABLE
    assert transport.calls["/hub/app-config"] == 1

    now += RowndClient._APP_ID_FAILURE_BACKOFF_SECONDS
    with pytest.raises(RowndAPIError) as exc_info:
        await client._fetch_app_id()
    assert exc_info.value.reason is RowndAPIErrorReason.UNAVAILABLE
    assert transport.calls["/hub/app-config"] == 2


@pytest.mark.asyncio
async def test_concurrent_app_id_outage_is_single_flight_and_backed_off() -> None:
    transport = RowndTransport({"keys": []})
    transport.app_config_status = 503
    transport.app_config_started = asyncio.Event()
    transport.release_app_config = asyncio.Event()
    client = _client(transport)

    loads = [asyncio.create_task(client._fetch_app_id()) for _ in range(8)]
    await transport.app_config_started.wait()
    transport.release_app_config.set()
    results = await asyncio.gather(*loads, return_exceptions=True)
    assert all(
        isinstance(result, RowndAPIError)
        and result.reason is RowndAPIErrorReason.UNAVAILABLE
        for result in results
    )
    assert transport.calls["/hub/app-config"] == 1

    with pytest.raises(RowndAPIError):
        await client._fetch_app_id()
    assert transport.calls["/hub/app-config"] == 1


@pytest.mark.asyncio
async def test_expired_app_id_failure_does_not_serve_stale_and_recovers() -> None:
    transport = RowndTransport({"keys": []})
    now = 10.0
    client = _client_with_clock(transport, lambda: now)
    assert await client._fetch_app_id() == APP_ID
    assert client._app_id_cache is not None
    assert client._app_id_cache.generation == 1

    now += RowndClient._APP_ID_CACHE_TTL_SECONDS
    transport.app_config_status = 503
    with pytest.raises(RowndAPIError) as exc_info:
        await client._fetch_app_id()
    assert exc_info.value.reason is RowndAPIErrorReason.UNAVAILABLE
    with pytest.raises(RowndAPIError):
        await client._fetch_app_id()
    assert transport.calls["/hub/app-config"] == 2

    now += RowndClient._APP_ID_FAILURE_BACKOFF_SECONDS
    transport.app_config_status = 200
    assert await client._fetch_app_id() == APP_ID
    assert transport.calls["/hub/app-config"] == 3
    assert client._app_id_cache is not None
    assert client._app_id_cache.generation == 2


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("claims_factory", "reason"),
    [
        (lambda: {"exp": int(time.time()) - 120}, RowndTokenValidationReason.TOKEN_EXPIRED),
        (lambda: {"exp": "invalid"}, RowndTokenValidationReason.TOKEN_MALFORMED),
        (lambda: {"nbf": int(time.time()) + 120}, RowndTokenValidationReason.TOKEN_NOT_ACTIVE),
        (lambda: {"aud": "app:other"}, RowndTokenValidationReason.TOKEN_CLAIMS_INVALID),
        (
            lambda: {"https://auth.rownd.io/app_user_id": None},
            RowndTokenValidationReason.TOKEN_CLAIMS_INVALID,
        ),
    ],
)
async def test_token_claim_failures_have_typed_reasons(
    claims_factory: Callable[[], JsonDict], reason: RowndTokenValidationReason
) -> None:
    key = Ed25519PrivateKey.generate()
    transport = RowndTransport({"keys": [_jwk("A", key)]})

    with pytest.raises(RowndTokenValidationError) as exc_info:
        await _client(transport).validate_token(_token("A", key, claims=claims_factory()))

    assert exc_info.value.reason == reason


@pytest.mark.asyncio
@pytest.mark.parametrize("omit_claims", [(), ("exp",)])
@pytest.mark.parametrize("missing_claim", ["aud", "iat", "https://auth.rownd.io/app_user_id"])
async def test_required_token_claims_are_typed(
    missing_claim: str, omit_claims: tuple[str, ...],
) -> None:
    key = Ed25519PrivateKey.generate()
    transport = RowndTransport({"keys": [_jwk("A", key)]})

    with pytest.raises(RowndTokenValidationError) as exc_info:
        await _client(transport).validate_token(
            _token("A", key, omit_claims=(*omit_claims, missing_claim))
        )

    assert exc_info.value.reason is RowndTokenValidationReason.TOKEN_CLAIMS_INVALID


@pytest.mark.asyncio
@pytest.mark.parametrize("configured_app_id", [None, CONFIGURED_APP_ID])
@pytest.mark.parametrize("omit_claims", [(), ("exp",)])
async def test_discovery_issuer_is_required_and_validated_only_when_available(
    omit_claims: tuple[str, ...], configured_app_id: Optional[str],
) -> None:
    key = Ed25519PrivateKey.generate()
    transport = RowndTransport({"keys": [_jwk("A", key)]})
    client = _client(transport)
    client.config.rownd_app_id = configured_app_id
    claims: JsonDict = {"aud": "app:%s" % (configured_app_id or APP_ID)}
    assert (
        await client.validate_token(_token("A", key, claims=claims, omit_claims=omit_claims))
        == USER_ID
    )

    transport.discovery["issuer"] = "https://issuer.example"
    client = _client(transport)
    client.config.rownd_app_id = configured_app_id
    with pytest.raises(RowndTokenValidationError) as exc_info:
        await client.validate_token(_token("A", key, claims=claims, omit_claims=omit_claims))
    assert exc_info.value.reason is RowndTokenValidationReason.TOKEN_CLAIMS_INVALID

    claims["iss"] = "https://wrong.example"
    with pytest.raises(RowndTokenValidationError) as exc_info:
        await client.validate_token(_token("A", key, claims=claims, omit_claims=omit_claims))
    assert exc_info.value.reason is RowndTokenValidationReason.TOKEN_CLAIMS_INVALID

    claims["iss"] = "https://issuer.example"
    assert (
        await client.validate_token(_token("A", key, claims=claims, omit_claims=omit_claims))
        == USER_ID
    )
    assert transport.calls["/hub/app-config"] == (2 if configured_app_id is None else 0)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("claims_factory", "reason"),
    [
        (lambda: {"aud": "app:other"}, RowndTokenValidationReason.TOKEN_CLAIMS_INVALID),
        (lambda: {"iss": "https://wrong.example"}, RowndTokenValidationReason.TOKEN_CLAIMS_INVALID),
        (lambda: {"iat": "invalid"}, RowndTokenValidationReason.TOKEN_CLAIMS_INVALID),
        (lambda: {"iat": int(time.time()) + 120}, RowndTokenValidationReason.TOKEN_NOT_ACTIVE),
        (lambda: {"nbf": int(time.time()) + 120}, RowndTokenValidationReason.TOKEN_NOT_ACTIVE),
        (lambda: {"nbf": "invalid"}, RowndTokenValidationReason.TOKEN_MALFORMED),
        (
            lambda: {"https://auth.rownd.io/app_user_id": ""},
            RowndTokenValidationReason.TOKEN_CLAIMS_INVALID,
        ),
        (
            lambda: {"https://auth.rownd.io/app_user_id": 123},
            RowndTokenValidationReason.TOKEN_CLAIMS_INVALID,
        ),
    ],
)
async def test_non_expiring_token_still_validates_claims(
    claims_factory: Callable[[], JsonDict], reason: RowndTokenValidationReason,
) -> None:
    key = Ed25519PrivateKey.generate()
    transport = RowndTransport({"keys": [_jwk("A", key)]})
    transport.discovery["issuer"] = "https://issuer.example"
    claims = {"iss": "https://issuer.example", **claims_factory()}

    with pytest.raises(RowndTokenValidationError) as exc_info:
        await _client(transport).validate_token(
            _token("A", key, claims=claims, omit_claims=("exp",))
        )

    assert exc_info.value.reason is reason


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "source_error",
    [
        jwt.InvalidIssuerError("invalid issuer"),
        jwt.MissingRequiredClaimError("sub"),
    ],
)
async def test_pyjwt_issuer_and_required_claim_failures_are_claims_invalid(
    monkeypatch: pytest.MonkeyPatch, source_error: jwt.PyJWTError
) -> None:
    key = Ed25519PrivateKey.generate()
    transport = RowndTransport({"keys": [_jwk("A", key)]})

    def decode(*args: object, **kwargs: object) -> dict[str, object]:
        raise source_error

    monkeypatch.setattr(jwt, "decode", decode)
    with pytest.raises(RowndTokenValidationError) as exc_info:
        await _client(transport).validate_token(_token("A", key))

    assert exc_info.value.reason == RowndTokenValidationReason.TOKEN_CLAIMS_INVALID


@pytest.mark.asyncio
async def test_concurrent_rotated_key_validations_share_one_refresh() -> None:
    key_a = Ed25519PrivateKey.generate()
    key_b = Ed25519PrivateKey.generate()
    transport = RowndTransport({"keys": [_jwk("A", key_a)]})
    client = _client(transport)
    assert await client.validate_token(_token("A", key_a)) == USER_ID

    rotated_jwks: JsonDict = {"keys": [_jwk("B", key_b)]}
    transport.jwks = rotated_jwks
    transport.jwks_started = asyncio.Event()
    transport.release_jwks = asyncio.Event()
    validations = [asyncio.create_task(client.validate_token(_token("B", key_b))) for _ in range(8)]
    await transport.jwks_started.wait()
    transport.release_jwks.set()
    results = await asyncio.gather(*validations)

    assert results == [USER_ID] * 8
    assert transport.calls["/hub/auth/.well-known/oauth-authorization-server"] == 2
    assert transport.calls["/jwks"] == 2


@pytest.mark.asyncio
async def test_concurrent_failed_refresh_is_attempted_once() -> None:
    key_a = Ed25519PrivateKey.generate()
    key_b = Ed25519PrivateKey.generate()
    transport = RowndTransport({"keys": [_jwk("A", key_a)]})
    client = _client(transport)
    assert await client.validate_token(_token("A", key_a)) == USER_ID

    transport.refresh_failure = "timeout"
    transport.jwks_started = asyncio.Event()
    transport.release_jwks = asyncio.Event()
    validations = [asyncio.create_task(client.validate_token(_token("B", key_b))) for _ in range(8)]
    await transport.jwks_started.wait()
    transport.release_jwks.set()
    results = await asyncio.gather(*validations, return_exceptions=True)

    assert all(
        isinstance(result, RowndTokenValidationError)
        and result.reason == RowndTokenValidationReason.JWKS_FETCH_FAILED
        for result in results
    )
    assert transport.calls["/hub/auth/.well-known/oauth-authorization-server"] == 2
    assert transport.calls["/jwks"] == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["malformed", "timeout"])
async def test_failed_refresh_does_not_replace_last_known_good_cache(failure: str) -> None:
    key_a = Ed25519PrivateKey.generate()
    key_b = Ed25519PrivateKey.generate()
    transport = RowndTransport({"keys": [_jwk("A", key_a)]})
    client = _client(transport)
    token_a = _token("A", key_a)
    assert await client.validate_token(token_a) == USER_ID
    transport.refresh_failure = failure

    with pytest.raises(RowndTokenValidationError) as exc_info:
        await client.validate_token(_token("B", key_b))

    expected_reason = (
        RowndTokenValidationReason.JWKS_FETCH_FAILED
        if failure == "timeout"
        else RowndTokenValidationReason.JWKS_INVALID_RESPONSE
    )
    assert exc_info.value.reason == expected_reason
    assert await client.validate_token(token_a) == USER_ID
    assert transport.calls["/hub/auth/.well-known/oauth-authorization-server"] == 2
    assert transport.calls["/jwks"] == 2


@pytest.mark.asyncio
async def test_rotation_can_retry_after_a_failed_refresh() -> None:
    key_a = Ed25519PrivateKey.generate()
    key_b = Ed25519PrivateKey.generate()
    transport = RowndTransport({"keys": [_jwk("A", key_a)]})
    now = 10.0
    client = _client_with_clock(transport, lambda: now)
    assert await client.validate_token(_token("A", key_a)) == USER_ID

    transport.refresh_failure = "timeout"
    with pytest.raises(RowndTokenValidationError) as exc_info:
        await client.validate_token(_token("B", key_b))
    assert exc_info.value.reason == RowndTokenValidationReason.JWKS_FETCH_FAILED

    transport.refresh_failure = None
    now += RowndClient._REFRESH_COOLDOWN_SECONDS
    rotated_jwks: JsonDict = {"keys": [_jwk("B", key_b)]}
    transport.jwks = rotated_jwks
    assert await client.validate_token(_token("B", key_b)) == USER_ID
    assert transport.calls["/jwks"] == 3


@pytest.mark.asyncio
async def test_forced_refresh_cooldown_prevents_repeated_fetches() -> None:
    key_a = Ed25519PrivateKey.generate()
    unknown_key = Ed25519PrivateKey.generate()
    transport = RowndTransport({"keys": [_jwk("A", key_a)]})
    now = 10.0
    client = _client_with_clock(transport, lambda: now)
    assert await client.validate_token(_token("A", key_a)) == USER_ID

    for _ in range(2):
        with pytest.raises(RowndTokenValidationError) as exc_info:
            await client.validate_token(_token("missing-1", unknown_key))
        assert exc_info.value.reason is RowndTokenValidationReason.TOKEN_KID_UNKNOWN
    results = await asyncio.gather(
        *(client.validate_token(_token("flood-%s" % i, unknown_key)) for i in range(300)),
        return_exceptions=True,
    )
    assert all(
        isinstance(result, RowndTokenValidationError)
        and result.reason is RowndTokenValidationReason.JWKS_REFRESH_SUPPRESSED
        for result in results
    )
    assert list(client._negative_kids) == ["missing-1"]
    assert await client.validate_token(_token("A", key_a)) == USER_ID
    assert transport.calls["/jwks"] == 2
    assert transport.calls["/hub/auth/.well-known/oauth-authorization-server"] == 2

    now += RowndClient._REFRESH_COOLDOWN_SECONDS
    with pytest.raises(RowndTokenValidationError) as exc_info:
        await client.validate_token(_token("missing-2", unknown_key))
    assert exc_info.value.reason is RowndTokenValidationReason.TOKEN_KID_UNKNOWN
    assert transport.calls["/jwks"] == 3


@pytest.mark.asyncio
async def test_rotation_during_cooldown_is_retryable_then_succeeds() -> None:
    key_a = Ed25519PrivateKey.generate()
    key_b = Ed25519PrivateKey.generate()
    transport = RowndTransport({"keys": [_jwk("A", key_a)]})
    now = 10.0
    client = _client_with_clock(transport, lambda: now)
    assert await client.validate_token(_token("A", key_a)) == USER_ID
    with pytest.raises(RowndTokenValidationError) as exc_info:
        await client.validate_token(_token("missing", key_b))
    assert exc_info.value.reason is RowndTokenValidationReason.TOKEN_KID_UNKNOWN

    rotated_jwks: JsonDict = {"keys": [_jwk("A", key_a), _jwk("B", key_b)]}
    transport.jwks = rotated_jwks
    for _ in range(2):
        with pytest.raises(RowndTokenValidationError) as exc_info:
            await client.validate_token(_token("B", key_b))
        assert exc_info.value.reason is RowndTokenValidationReason.JWKS_REFRESH_SUPPRESSED
    assert "B" not in client._negative_kids
    assert transport.calls["/jwks"] == 2
    assert await client.validate_token(_token("A", key_a)) == USER_ID

    now += RowndClient._REFRESH_COOLDOWN_SECONDS
    assert await client.validate_token(_token("B", key_b)) == USER_ID
    assert transport.calls["/jwks"] == 3
    assert transport.calls["/hub/auth/.well-known/oauth-authorization-server"] == 3


@pytest.mark.asyncio
@pytest.mark.parametrize("expire_cache", [False, True])
async def test_coalesced_misses_are_confirmed_even_during_cooldown(expire_cache: bool) -> None:
    key = Ed25519PrivateKey.generate()
    transport = RowndTransport({"keys": [_jwk("A", key)]})
    now = 10.0
    client = _client_with_clock(transport, lambda: now)
    client._JWKS_CACHE_TTL_SECONDS = 1.0
    assert await client.validate_token(_token("A", key)) == USER_ID
    transport.jwks_started = asyncio.Event()
    transport.release_jwks = asyncio.Event()
    first = asyncio.create_task(client.validate_token(_token("missing-1", key)))
    await transport.jwks_started.wait()
    if expire_cache:
        now += client._JWKS_CACHE_TTL_SECONDS
    second = asyncio.create_task(client.validate_token(_token("missing-2", key)))
    # Let the second validation join the gated refresh before releasing it.
    await asyncio.sleep(0)
    transport.release_jwks.set()
    results = await asyncio.gather(first, second, return_exceptions=True)

    assert all(
        isinstance(result, RowndTokenValidationError)
        and result.reason is RowndTokenValidationReason.TOKEN_KID_UNKNOWN
        for result in results
    )
    assert set(client._negative_kids) == {"missing-1", "missing-2"}
    assert transport.calls["/jwks"] == 2


@pytest.mark.asyncio
async def test_negative_cache_is_bounded_and_expires() -> None:
    key_a = Ed25519PrivateKey.generate()
    unknown_key = Ed25519PrivateKey.generate()
    transport = RowndTransport({"keys": [_jwk("A", key_a)]})
    now = 10.0
    client = _client_with_clock(transport, lambda: now)
    client._MAX_NEGATIVE_CACHE_ENTRIES = 2
    client._NEGATIVE_CACHE_TTL_SECONDS = 30
    assert await client.validate_token(_token("A", key_a)) == USER_ID

    for index, key_id in enumerate(("missing-1", "missing-2", "missing-3")):
        with pytest.raises(RowndTokenValidationError):
            await client.validate_token(_token(key_id, unknown_key))
        if index < 2:
            now += RowndClient._REFRESH_COOLDOWN_SECONDS
    assert list(client._negative_kids) == ["missing-2", "missing-3"]
    assert transport.calls["/jwks"] == 4

    with pytest.raises(RowndTokenValidationError):
        await client.validate_token(_token("missing-3", unknown_key))
    assert transport.calls["/jwks"] == 4

    now += client._NEGATIVE_CACHE_TTL_SECONDS
    rotated_jwks: JsonDict = {"keys": [_jwk("missing-3", unknown_key)]}
    transport.jwks = rotated_jwks
    assert await client.validate_token(_token("missing-3", unknown_key)) == USER_ID
    assert transport.calls["/jwks"] == 5


@pytest.mark.asyncio
async def test_negative_entry_does_not_hide_key_after_refresh_cooldown() -> None:
    key_a = Ed25519PrivateKey.generate()
    key_b = Ed25519PrivateKey.generate()
    transport = RowndTransport({"keys": [_jwk("A", key_a)]})
    now = 10.0
    client = _client_with_clock(transport, lambda: now)
    client._NEGATIVE_CACHE_TTL_SECONDS = 30
    assert await client.validate_token(_token("A", key_a)) == USER_ID

    with pytest.raises(RowndTokenValidationError):
        await client.validate_token(_token("B", key_b))
    rotated_jwks: JsonDict = {"keys": [_jwk("B", key_b)]}
    transport.jwks = rotated_jwks
    now += RowndClient._REFRESH_COOLDOWN_SECONDS

    assert await client.validate_token(_token("B", key_b)) == USER_ID
    assert transport.calls["/jwks"] == 3


@pytest.mark.asyncio
async def test_cold_cache_outage_is_single_flight_and_backed_off() -> None:
    key = Ed25519PrivateKey.generate()
    transport = RowndTransport({"keys": [_jwk("A", key)]})
    transport.refresh_failure = "always_timeout"
    transport.gate_all_jwks = True
    transport.jwks_started = asyncio.Event()
    transport.release_jwks = asyncio.Event()
    now = 10.0
    client = _client_with_clock(transport, lambda: now)

    validations = [asyncio.create_task(client.validate_token(_token("A", key))) for _ in range(8)]
    await transport.jwks_started.wait()
    transport.release_jwks.set()
    results = await asyncio.gather(*validations, return_exceptions=True)
    assert all(
        isinstance(result, RowndTokenValidationError)
        and result.reason is RowndTokenValidationReason.JWKS_FETCH_FAILED
        for result in results
    )
    assert transport.calls["/jwks"] == 1

    with pytest.raises(RowndTokenValidationError):
        await client.validate_token(_token("A", key))
    assert transport.calls["/jwks"] == 1

    now += RowndClient._REFRESH_COOLDOWN_SECONDS
    with pytest.raises(RowndTokenValidationError):
        await client.validate_token(_token("A", key))
    assert transport.calls["/jwks"] == 2


@pytest.mark.asyncio
async def test_failed_refresh_publishes_backoff_before_completion_handoff(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    key = Ed25519PrivateKey.generate()
    transport = RowndTransport({"keys": [_jwk("A", key)]})
    transport.refresh_failure = "always_timeout"
    now = 10.0
    client = _client_with_clock(transport, lambda: now)
    handoff: list[asyncio.Task[str]] = []

    def handoff_on_completion(refresh: asyncio.Task[object]) -> None:
        if client._jwks_refresh is refresh:
            client._jwks_refresh = None
        handoff.append(asyncio.create_task(client.validate_token(_token("A", key))))

    monkeypatch.setattr(client, "_clear_jwks_refresh", handoff_on_completion)
    with pytest.raises(RowndTokenValidationError):
        await client.validate_token(_token("A", key))
    assert len(handoff) == 1
    with pytest.raises(RowndTokenValidationError) as exc_info:
        await handoff[0]

    assert exc_info.value.reason is RowndTokenValidationReason.JWKS_FETCH_FAILED
    assert transport.calls["/jwks"] == 1


@pytest.mark.asyncio
async def test_expired_cache_outage_is_backed_off_and_retains_cache() -> None:
    key = Ed25519PrivateKey.generate()
    transport = RowndTransport({"keys": [_jwk("A", key)]})
    now = 10.0
    client = _client_with_clock(transport, lambda: now)
    assert await client.validate_token(_token("A", key)) == USER_ID
    generation = client._jwks_cache.generation if client._jwks_cache else 0

    now += RowndClient._JWKS_CACHE_TTL_SECONDS
    transport.refresh_failure = "timeout"
    transport.jwks_started = asyncio.Event()
    transport.release_jwks = asyncio.Event()
    validations = [asyncio.create_task(client.validate_token(_token("A", key))) for _ in range(8)]
    await transport.jwks_started.wait()
    transport.release_jwks.set()
    results = await asyncio.gather(*validations, return_exceptions=True)
    assert all(
        isinstance(result, RowndTokenValidationError)
        and result.reason is RowndTokenValidationReason.JWKS_FETCH_FAILED
        for result in results
    )

    with pytest.raises(RowndTokenValidationError) as exc_info:
        await client.validate_token(_token("A", key))
    assert exc_info.value.reason is RowndTokenValidationReason.JWKS_FETCH_FAILED

    assert transport.calls["/jwks"] == 2
    assert client._jwks_cache is not None
    assert client._jwks_cache.generation == generation


@pytest.mark.asyncio
async def test_complete_jwks_refresh_has_absolute_deadline() -> None:
    key = Ed25519PrivateKey.generate()
    transport = RowndTransport({"keys": [_jwk("A", key)]})
    transport.gate_all_jwks = True
    transport.jwks_started = asyncio.Event()
    transport.release_jwks = asyncio.Event()
    client = _client(transport)
    client._JWKS_REFRESH_DEADLINE_SECONDS = 0.01
    validation = asyncio.create_task(client.validate_token(_token("A", key)))
    await transport.jwks_started.wait()

    with pytest.raises(RowndTokenValidationError) as exc_info:
        await validation

    assert exc_info.value.reason is RowndTokenValidationReason.JWKS_FETCH_FAILED
    assert transport.calls["/hub/auth/.well-known/oauth-authorization-server"] == 1
    assert transport.calls["/jwks"] == 1


@pytest.mark.asyncio
async def test_jwks_diagnostic_is_sampled_structured_and_redacted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class CapturingTelemetry:
        def __init__(self) -> None:
            self.events: list[JsonDict] = []

        async def record_event(self, event: JsonDict) -> None:
            self.events.append(event)

    class CapturingRegistry:
        def submit(self, client: CapturingTelemetry, event: JsonDict) -> bool:
            client.events.append(event)
            return True

    key_a = Ed25519PrivateKey.generate()
    unknown_key = Ed25519PrivateKey.generate()
    transport = RowndTransport({"keys": [_jwk("A", key_a)]})
    telemetry_client = CapturingTelemetry()
    monkeypatch.setattr(telemetry, "_jwks_diagnostics", CapturingRegistry())
    client = RowndClient(
        RowndPluginConfig(
            rownd_app_key="app-key",
            rownd_app_secret="app-secret",
            rownd_api_base_url="https://api.example",
        ),
        transport=transport,
        telemetry_client=telemetry_client,
        random_value=lambda: 0.0,
        monotonic=lambda: 10.0,
    )
    token = _token("attacker-controlled-kid", unknown_key)
    await client.validate_token(_token("A", key_a))

    with pytest.raises(RowndTokenValidationError):
        await client.validate_token(token)

    assert telemetry_client.events == [
        {
            "operation": "jwks_refresh",
            "outcome": "refreshed_missing",
            "kidHash": telemetry_client.events[0]["kidHash"],
            "keyCount": 1,
            "generation": 2,
        }
    ]
    with pytest.raises(RowndTokenValidationError) as exc_info:
        await client.validate_token(_token("new-unchecked-kid", unknown_key))
    assert exc_info.value.reason is RowndTokenValidationReason.JWKS_REFRESH_SUPPRESSED
    assert telemetry_client.events[1] == {
        "operation": "jwks_refresh",
        "outcome": "cooldown",
        "kidHash": telemetry_client.events[1]["kidHash"],
        "keyCount": 1,
        "generation": 2,
    }
    assert len(str(telemetry_client.events[0]["kidHash"])) == 16
    serialized = json.dumps(telemetry_client.events)
    assert token not in serialized
    assert "attacker-controlled-kid" not in serialized
    assert "new-unchecked-kid" not in serialized


@pytest.mark.asyncio
async def test_completed_refresh_task_does_not_suppress_rotation_refresh() -> None:
    key_a = Ed25519PrivateKey.generate()
    key_b = Ed25519PrivateKey.generate()
    transport = RowndTransport({"keys": [_jwk("A", key_a)]})
    client = _client(transport)
    assert await client.validate_token(_token("A", key_a)) == USER_ID

    completed_refresh = asyncio.create_task(client._refresh_jwks())
    await completed_refresh
    client._jwks_refresh = completed_refresh
    rotated_jwks: JsonDict = {"keys": [_jwk("B", key_b)]}
    transport.jwks = rotated_jwks

    assert await client.validate_token(_token("B", key_b)) == USER_ID
    assert transport.calls["/jwks"] == 3


@pytest.mark.asyncio
async def test_expired_cache_is_refreshed() -> None:
    key = Ed25519PrivateKey.generate()
    transport = RowndTransport({"keys": [_jwk("A", key)]})
    now = 10.0
    client = _client_with_clock(transport, lambda: now)
    token = _token("A", key)

    assert await client.validate_token(token) == USER_ID
    now += RowndClient._JWKS_CACHE_TTL_SECONDS - 1
    assert await client.validate_token(token) == USER_ID
    assert transport.calls["/jwks"] == 1

    now += 1
    assert await client.validate_token(token) == USER_ID
    assert transport.calls["/jwks"] == 2


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status_code", "expected_reason"),
    [
        (401, RowndAPIErrorReason.CREDENTIALS_REJECTED),
        (403, RowndAPIErrorReason.CREDENTIALS_REJECTED),
        (408, RowndAPIErrorReason.UNAVAILABLE),
    ],
)
async def test_app_config_error_status_is_typed(
    status_code: int, expected_reason: RowndAPIErrorReason
) -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status_code)

    with pytest.raises(RowndAPIError) as exc_info:
        await _client(httpx.MockTransport(handler)).fetch_optional_user_info(USER_ID)

    assert exc_info.value.reason is expected_reason
    assert str(exc_info.value) == "Rownd API request failed"


@pytest.mark.asyncio
@pytest.mark.parametrize("status_code", [301, 302, 307, 308])
async def test_app_config_redirect_is_rejected_before_parsing(status_code: int) -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status_code, json={"app": {"id": APP_ID}})

    with pytest.raises(RowndAPIError) as exc_info:
        await _client(httpx.MockTransport(handler)).fetch_optional_user_info(USER_ID)

    assert exc_info.value.reason is RowndAPIErrorReason.APP_CONFIG_INVALID


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "app_config",
    [{}, {"app": {}}, {"app": {"id": ""}}, {"app": {"id": 1}}],
)
async def test_malformed_app_config_is_typed(app_config: JsonDict) -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=app_config)

    with pytest.raises(RowndAPIError) as exc_info:
        await _client(httpx.MockTransport(handler)).fetch_optional_user_info(USER_ID)

    assert exc_info.value.reason is RowndAPIErrorReason.APP_CONFIG_INVALID


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status_code", "expected_reason"),
    [
        (404, RowndAPIErrorReason.USER_NOT_FOUND),
        (401, RowndAPIErrorReason.CREDENTIALS_REJECTED),
        (403, RowndAPIErrorReason.CREDENTIALS_REJECTED),
        (408, RowndAPIErrorReason.UNAVAILABLE),
        (429, RowndAPIErrorReason.UNAVAILABLE),
        (500, RowndAPIErrorReason.UNAVAILABLE),
        (503, RowndAPIErrorReason.UNAVAILABLE),
    ],
)
async def test_profile_status_is_typed(
    status_code: int, expected_reason: RowndAPIErrorReason
) -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/hub/app-config":
            return httpx.Response(200, json={"app": {"id": APP_ID}})
        return httpx.Response(status_code)

    client = _client(httpx.MockTransport(handler))
    if expected_reason is RowndAPIErrorReason.USER_NOT_FOUND:
        assert await client.fetch_optional_user_info(USER_ID) is None
    else:
        with pytest.raises(RowndAPIError) as exc_info:
            await client.fetch_optional_user_info(USER_ID)
        assert exc_info.value.reason is expected_reason


@pytest.mark.asyncio
@pytest.mark.parametrize("status_code", [301, 302, 307, 308])
async def test_profile_redirect_is_rejected_before_parsing(status_code: int) -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/hub/app-config":
            return httpx.Response(200, json={"app": {"id": APP_ID}})
        return httpx.Response(
            status_code,
            json={"data": {"user_id": USER_ID}, "verified_data": {}},
        )

    with pytest.raises(RowndAPIError) as exc_info:
        await _client(httpx.MockTransport(handler)).fetch_optional_user_info(USER_ID)

    assert exc_info.value.reason is RowndAPIErrorReason.PROFILE_INVALID


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "profile",
    [{}, {"data": {}}, {"data": {"user_id": 1}, "verified_data": {}}, {"data": {"user_id": USER_ID}}],
)
async def test_malformed_profile_is_typed(profile: JsonDict) -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/hub/app-config":
            return httpx.Response(200, json={"app": {"id": APP_ID}})
        return httpx.Response(200, json=profile)

    with pytest.raises(RowndAPIError) as exc_info:
        await _client(httpx.MockTransport(handler)).fetch_optional_user_info(USER_ID)

    assert exc_info.value.reason is RowndAPIErrorReason.PROFILE_INVALID


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["network", "timeout"])
async def test_profile_transport_failure_is_typed(failure: str) -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/hub/app-config":
            return httpx.Response(200, json={"app": {"id": APP_ID}})
        if failure == "timeout":
            raise httpx.ReadTimeout("private timeout", request=request)
        raise httpx.ConnectError("private network error", request=request)

    with pytest.raises(RowndAPIError) as exc_info:
        await _client(httpx.MockTransport(handler)).fetch_optional_user_info(USER_ID)

    assert exc_info.value.reason is RowndAPIErrorReason.UNAVAILABLE


@pytest.mark.asyncio
@pytest.mark.parametrize("endpoint", ["app_config", "profile"])
async def test_authenticated_response_size_is_bounded(endpoint: str) -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/hub/app-config":
            if endpoint == "app_config":
                return httpx.Response(200, content=b'{"app":{"id":"app-id"}}' + b" " * 64)
            return httpx.Response(200, json={"app": {"id": APP_ID}})
        return httpx.Response(
            200,
            content=b'{"data":{"user_id":"rownd-user-id"},"verified_data":{}}' + b" " * 64,
        )

    client = _client(httpx.MockTransport(handler))
    client._MAX_API_RESPONSE_BYTES = 32
    with pytest.raises(RowndAPIError) as exc_info:
        await client.fetch_optional_user_info(USER_ID)

    expected = (
        RowndAPIErrorReason.APP_CONFIG_INVALID
        if endpoint == "app_config"
        else RowndAPIErrorReason.PROFILE_INVALID
    )
    assert exc_info.value.reason is expected


@pytest.mark.asyncio
async def test_authenticated_request_has_total_deadline() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(0.1)
        return httpx.Response(200, json={"app": {"id": APP_ID}})

    client = _client(httpx.MockTransport(handler))
    client._API_REQUEST_DEADLINE_SECONDS = 0.01
    with pytest.raises(RowndAPIError) as exc_info:
        await client.fetch_optional_user_info(USER_ID)

    assert exc_info.value.reason is RowndAPIErrorReason.UNAVAILABLE

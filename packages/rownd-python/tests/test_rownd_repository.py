from __future__ import annotations

import asyncio
import base64
from collections import Counter
from typing import Callable, Optional

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from supertokens_rownd.errors import RowndPluginError
from supertokens_rownd.rownd_repository import (
    RowndClient,
    RowndTokenValidationError,
    RowndTokenValidationReason,
)
from supertokens_rownd.types import JsonDict, RowndPluginConfig


APP_ID = "app-id"
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
) -> str:
    token = jwt.encode(
        {
            "aud": "app:%s" % APP_ID,
            "https://auth.rownd.io/app_user_id": USER_ID,
        },
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
        self.jwks_delay = 0.0

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.calls[request.url.path] += 1
        if request.url.path == "/hub/auth/.well-known/oauth-authorization-server":
            return httpx.Response(200, json={"jwks_uri": "https://keys.example/jwks"})
        if request.url.path == "/jwks":
            if self.jwks_delay:
                await asyncio.sleep(self.jwks_delay)
            if self.refresh_failure == "timeout" and self.calls["/jwks"] > 1:
                raise httpx.ReadTimeout("JWKS timed out", request=request)
            if self.refresh_failure == "malformed" and self.calls["/jwks"] > 1:
                return httpx.Response(200, json={"keys": "invalid"})
            return httpx.Response(200, json=self.jwks)
        if request.url.path == "/hub/app-config":
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


@pytest.mark.asyncio
async def test_valid_eddsa_token_returns_rownd_user_id() -> None:
    key = Ed25519PrivateKey.generate()
    transport = RowndTransport({"keys": [_jwk("A", key)]})

    assert await _client(transport).validate_token(_token("A", key)) == USER_ID


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
async def test_second_validation_reuses_discovery_and_jwks_cache() -> None:
    key = Ed25519PrivateKey.generate()
    transport = RowndTransport({"keys": [_jwk("A", key)]})
    client = _client(transport)
    token = _token("A", key)

    assert await client.validate_token(token) == USER_ID
    assert await client.validate_token(token) == USER_ID

    assert transport.calls["/hub/auth/.well-known/oauth-authorization-server"] == 1
    assert transport.calls["/jwks"] == 1


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
async def test_known_kid_with_invalid_signature_does_not_refresh() -> None:
    key_a = Ed25519PrivateKey.generate()
    wrong_key = Ed25519PrivateKey.generate()
    transport = RowndTransport({"keys": [_jwk("A", key_a)]})
    client = _client(transport)
    assert await client.validate_token(_token("A", key_a)) == USER_ID

    with pytest.raises(RowndTokenValidationError) as exc_info:
        await client.validate_token(_token("A", wrong_key))

    assert exc_info.value.reason == RowndTokenValidationReason.TOKEN_SIGNATURE_INVALID
    assert transport.calls["/hub/auth/.well-known/oauth-authorization-server"] == 1
    assert transport.calls["/jwks"] == 1


@pytest.mark.asyncio
async def test_concurrent_rotated_key_validations_share_one_refresh() -> None:
    key_a = Ed25519PrivateKey.generate()
    key_b = Ed25519PrivateKey.generate()
    transport = RowndTransport({"keys": [_jwk("A", key_a)]})
    client = _client(transport)
    assert await client.validate_token(_token("A", key_a)) == USER_ID

    rotated_jwks: JsonDict = {"keys": [_jwk("B", key_b)]}
    transport.jwks = rotated_jwks
    transport.jwks_delay = 0.01
    results = await asyncio.gather(*[client.validate_token(_token("B", key_b)) for _ in range(8)])

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
    transport.jwks_delay = 0.01
    results = await asyncio.gather(
        *[client.validate_token(_token("B", key_b)) for _ in range(8)],
        return_exceptions=True,
    )

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
    client = _client(transport)
    assert await client.validate_token(_token("A", key_a)) == USER_ID

    transport.refresh_failure = "timeout"
    with pytest.raises(RowndTokenValidationError) as exc_info:
        await client.validate_token(_token("B", key_b))
    assert exc_info.value.reason == RowndTokenValidationReason.JWKS_FETCH_FAILED

    transport.refresh_failure = None
    rotated_jwks: JsonDict = {"keys": [_jwk("B", key_b)]}
    transport.jwks = rotated_jwks
    assert await client.validate_token(_token("B", key_b)) == USER_ID
    assert transport.calls["/jwks"] == 3


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

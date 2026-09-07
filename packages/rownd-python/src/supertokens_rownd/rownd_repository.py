from __future__ import annotations

import asyncio
import hashlib
import json as json_module
import random
import time
from collections import OrderedDict
from dataclasses import dataclass
from enum import Enum
from typing import Any, Callable, Dict, Optional, Tuple
from urllib.parse import urlsplit

import httpx
import jwt

from .errors import RowndPluginError
from .telemetry.create_telemetry_client import record_jwks_diagnostic
from .types import JsonDict, RowndPluginConfig, RowndTelemetryClient


class RowndTokenValidationReason(str, Enum):
    TOKEN_MALFORMED = "TOKEN_MALFORMED"
    TOKEN_EXPIRED = "TOKEN_EXPIRED"
    TOKEN_NOT_ACTIVE = "TOKEN_NOT_ACTIVE"
    TOKEN_CLAIMS_INVALID = "TOKEN_CLAIMS_INVALID"
    TOKEN_KID_UNKNOWN = "TOKEN_KID_UNKNOWN"
    TOKEN_SIGNATURE_INVALID = "TOKEN_SIGNATURE_INVALID"
    JWKS_FETCH_FAILED = "JWKS_FETCH_FAILED"
    JWKS_INVALID_RESPONSE = "JWKS_INVALID_RESPONSE"
    JWKS_REFRESH_SUPPRESSED = "JWKS_REFRESH_SUPPRESSED"


class RowndTokenValidationError(RowndPluginError):
    def __init__(self, reason: RowndTokenValidationReason):
        super().__init__("Invalid token")
        self.reason = reason


class RowndAPIErrorReason(str, Enum):
    USER_NOT_FOUND = "USER_NOT_FOUND"
    AUTHORIZATION_REJECTED = "AUTHORIZATION_REJECTED"
    CREDENTIALS_REJECTED = "CREDENTIALS_REJECTED"
    APP_CONFIG_INVALID = "APP_CONFIG_INVALID"
    PROFILE_INVALID = "PROFILE_INVALID"
    UNAVAILABLE = "UNAVAILABLE"
    INVALID_RESPONSE = "INVALID_RESPONSE"


class RowndAPIError(RowndPluginError):
    def __init__(self, reason: RowndAPIErrorReason):
        super().__init__("Rownd API request failed")
        self.reason = reason


@dataclass(frozen=True)
class _JwksCache:
    jwks_uri: str
    keys: Dict[str, Any]
    issuer: Optional[str]
    expires_at: float
    generation: int


@dataclass(frozen=True)
class _AppIdCache:
    app_id: str
    expires_at: float
    generation: int


class RowndClient:
    _JWKS_CACHE_TTL_SECONDS: float = 300.0
    _REFRESH_COOLDOWN_SECONDS: float = 5.0
    _NEGATIVE_CACHE_TTL_SECONDS: float = 5.0
    _MAX_NEGATIVE_CACHE_ENTRIES: int = 256
    _JWKS_REFRESH_DEADLINE_SECONDS: float = 10.0
    _JWKS_DIAGNOSTIC_SAMPLE_RATE: float = 0.1
    _APP_ID_CACHE_TTL_SECONDS: float = 300.0
    _APP_ID_FAILURE_BACKOFF_SECONDS: float = 5.0
    _API_REQUEST_DEADLINE_SECONDS: float = 10.0
    _MAX_API_RESPONSE_BYTES: int = 1024 * 1024

    def __init__(
        self,
        config: RowndPluginConfig,
        transport: Optional[httpx.AsyncBaseTransport] = None,
        monotonic: Callable[[], float] = time.monotonic,
        telemetry_client: Optional[RowndTelemetryClient] = None,
        random_value: Callable[[], float] = random.random,
    ):
        self.config = config
        self._transport = transport
        self._monotonic = monotonic
        self._jwks_cache: Optional[_JwksCache] = None
        self._jwks_refresh: Optional[asyncio.Task[_JwksCache]] = None
        self._refresh_blocked_until = 0.0
        self._refresh_error: Optional[RowndTokenValidationReason] = None
        self._negative_kids: OrderedDict[str, Tuple[float, int]] = OrderedDict()
        self._app_id_cache: Optional[_AppIdCache] = None
        self._app_id_refresh: Optional[asyncio.Task[_AppIdCache]] = None
        self._app_id_blocked_until = 0.0
        self._app_id_error: Optional[RowndAPIErrorReason] = None
        self._telemetry_client = telemetry_client
        self._random_value = random_value

    async def validate_token(self, token: str) -> str:
        try:
            key_id = self._parse_token_header(token)
            cache, load_outcome = await self._load_jwks(
                force=False,
                observed_generation=self._jwks_cache.generation if self._jwks_cache else 0,
                requested_key_id=key_id,
            )
            key = cache.keys.get(key_id)
            if key is None:
                negative = self._negative_kids.get(key_id)
                now = self._monotonic()
                if (
                    negative is not None
                    and negative[0] > now
                    and negative[1] == cache.generation
                    and now < self._refresh_blocked_until
                ):
                    self._negative_kids.move_to_end(key_id)
                    self._record_jwks_diagnostic(key_id, cache, "negative_cache")
                    raise RowndTokenValidationError(
                        RowndTokenValidationReason.TOKEN_KID_UNKNOWN
                    )
                self._negative_kids.pop(key_id, None)
                checked_generation = cache.generation if load_outcome == "refreshed" else None
                cache, refresh_outcome = await self._load_jwks(
                    force=True,
                    observed_generation=cache.generation,
                    requested_key_id=key_id,
                )
                key = cache.keys.get(key_id)
                if key is None:
                    # A cooldown alone cannot confirm that a newly published key is absent.
                    suppressed = (
                        refresh_outcome == "cooldown"
                        and checked_generation != cache.generation
                    )
                    if not suppressed:
                        self._remember_unknown_kid(key_id, cache.generation)
                    self._record_jwks_diagnostic(
                        key_id,
                        cache,
                        "cooldown" if refresh_outcome == "cooldown" else "refreshed_missing",
                    )
                    raise RowndTokenValidationError(
                        RowndTokenValidationReason.JWKS_REFRESH_SUPPRESSED
                        if suppressed
                        else RowndTokenValidationReason.TOKEN_KID_UNKNOWN
                    )
                self._negative_kids.pop(key_id, None)
                self._record_jwks_diagnostic(key_id, cache, "refreshed_found")

            jwt.decode(
                token,
                key,
                algorithms=["EdDSA"],
                options={
                    "verify_aud": False,
                    "verify_iss": False,
                    # Legacy Rownd access_token_ttl="never" tokens omit exp.
                    "require": ["iat"],
                },
            )
            app_id = await self._fetch_app_id()

            decode_options = {"require": ["aud", "iat"]}
            decode_kwargs: Dict[str, Any] = {
                "algorithms": ["EdDSA"],
                "audience": "app:%s" % app_id,
                "options": decode_options,
            }
            if cache.issuer is not None:
                decode_options["require"].append("iss")
                decode_kwargs["issuer"] = cache.issuer
            data = jwt.decode(token, key, **decode_kwargs)
        except RowndTokenValidationError:
            raise
        except jwt.InvalidSignatureError as err:
            raise RowndTokenValidationError(
                RowndTokenValidationReason.TOKEN_SIGNATURE_INVALID
            ) from err
        except jwt.DecodeError as err:
            raise RowndTokenValidationError(RowndTokenValidationReason.TOKEN_MALFORMED) from err
        except jwt.ExpiredSignatureError as err:
            raise RowndTokenValidationError(RowndTokenValidationReason.TOKEN_EXPIRED) from err
        except jwt.ImmatureSignatureError as err:
            raise RowndTokenValidationError(RowndTokenValidationReason.TOKEN_NOT_ACTIVE) from err
        except jwt.PyJWTError as err:
            raise RowndTokenValidationError(
                RowndTokenValidationReason.TOKEN_CLAIMS_INVALID
            ) from err

        user_id = data.get("https://auth.rownd.io/app_user_id")
        if not isinstance(user_id, str) or not user_id:
            raise RowndTokenValidationError(RowndTokenValidationReason.TOKEN_CLAIMS_INVALID)
        return user_id

    def _parse_token_header(self, token: str) -> str:
        if not isinstance(token, str) or not token.isascii():
            raise RowndTokenValidationError(RowndTokenValidationReason.TOKEN_MALFORMED)
        first_dot = token.find(".")
        second_dot = token.find(".", first_dot + 1)
        if (
            first_dot <= 0
            or second_dot <= first_dot + 1
            or second_dot == len(token) - 1
            or token.find(".", second_dot + 1) != -1
        ):
            raise RowndTokenValidationError(RowndTokenValidationReason.TOKEN_MALFORMED)
        try:
            header = jwt.get_unverified_header(token)
        except jwt.PyJWTError as err:
            raise RowndTokenValidationError(RowndTokenValidationReason.TOKEN_MALFORMED) from err
        key_id = header.get("kid")
        if (
            header.get("alg") != "EdDSA"
            or not isinstance(key_id, str)
            or not key_id
            or key_id != key_id.strip()
        ):
            raise RowndTokenValidationError(RowndTokenValidationReason.TOKEN_MALFORMED)
        return key_id

    async def _load_jwks(
        self,
        force: bool,
        observed_generation: int,
        requested_key_id: str = "",
    ) -> Tuple[_JwksCache, str]:
        cache = self._jwks_cache
        if cache is not None and not force and self._monotonic() < cache.expires_at:
            return cache, "cache"
        if force and cache is not None and cache.generation != observed_generation:
            return cache, "generation"

        refresh = self._jwks_refresh
        if refresh is None or refresh.done():
            if self._monotonic() < self._refresh_blocked_until:
                if self._refresh_error is not None:
                    raise RowndTokenValidationError(self._refresh_error)
                assert cache is not None
                return cache, "cooldown"
            if force:
                self._refresh_blocked_until = (
                    self._monotonic() + self._REFRESH_COOLDOWN_SECONDS
                )
            self._refresh_error = None
            refresh = asyncio.create_task(self._run_jwks_refresh())
            self._jwks_refresh = refresh
            refresh.add_done_callback(self._clear_jwks_refresh)
        try:
            return await asyncio.shield(refresh), "refreshed"
        except RowndTokenValidationError as err:
            if force:
                self._record_jwks_diagnostic(
                    requested_key_id,
                    self._jwks_cache,
                    "refresh_failed",
                    reason=err.reason.value,
                )
            raise

    async def _run_jwks_refresh(self) -> _JwksCache:
        try:
            cache = await self._refresh_jwks()
        except RowndTokenValidationError as err:
            self._refresh_error = err.reason
            self._refresh_blocked_until = self._monotonic() + self._REFRESH_COOLDOWN_SECONDS
            raise
        self._refresh_error = None
        return cache

    def _clear_jwks_refresh(self, refresh: asyncio.Task[_JwksCache]) -> None:
        if self._jwks_refresh is refresh:
            self._jwks_refresh = None

    async def _refresh_jwks(self) -> _JwksCache:
        try:
            return await asyncio.wait_for(
                self._perform_jwks_refresh(), timeout=self._JWKS_REFRESH_DEADLINE_SECONDS
            )
        except asyncio.TimeoutError as err:
            raise RowndTokenValidationError(
                RowndTokenValidationReason.JWKS_FETCH_FAILED
            ) from err

    async def _perform_jwks_refresh(self) -> _JwksCache:
        try:
            oauth_config = await self._request_public(
                "/hub/auth/.well-known/oauth-authorization-server"
            )
            jwks_uri = oauth_config.get("jwks_uri")
            if not isinstance(jwks_uri, str) or not self._is_valid_jwks_uri(jwks_uri):
                raise RowndTokenValidationError(
                    RowndTokenValidationReason.JWKS_INVALID_RESPONSE
                )
            issuer_value = oauth_config.get("issuer")
            if issuer_value is not None and (
                not isinstance(issuer_value, str)
                or not issuer_value.strip()
            ):
                raise RowndTokenValidationError(
                    RowndTokenValidationReason.JWKS_INVALID_RESPONSE
                )
            issuer = issuer_value if isinstance(issuer_value, str) else None
            jwks = await self._request_public_url(jwks_uri)
            keys = self._parse_jwks(jwks)
        except RowndTokenValidationError:
            raise
        except httpx.HTTPError as err:
            raise RowndTokenValidationError(
                RowndTokenValidationReason.JWKS_FETCH_FAILED
            ) from err
        except (jwt.PyJWTError, ValueError, RowndPluginError) as err:
            raise RowndTokenValidationError(
                RowndTokenValidationReason.JWKS_INVALID_RESPONSE
            ) from err

        loaded = _JwksCache(
            jwks_uri=jwks_uri,
            keys=keys,
            issuer=issuer,
            expires_at=self._monotonic() + self._JWKS_CACHE_TTL_SECONDS,
            generation=(self._jwks_cache.generation + 1 if self._jwks_cache else 1),
        )
        self._jwks_cache = loaded
        return loaded

    def _is_valid_jwks_uri(self, jwks_uri: str) -> bool:
        parsed = urlsplit(jwks_uri)
        base_scheme = urlsplit(self.config.rownd_api_base_url).scheme
        return (
            parsed.scheme in {"http", "https"}
            and bool(parsed.hostname)
            and parsed.username is None
            and parsed.password is None
            and not parsed.fragment
            and (parsed.scheme == "https" or base_scheme == "http")
        )

    def _parse_jwks(self, jwks: JsonDict) -> Dict[str, Any]:
        candidates = jwks.get("keys")
        if not isinstance(candidates, list) or not candidates:
            raise RowndTokenValidationError(RowndTokenValidationReason.JWKS_INVALID_RESPONSE)

        keys: Dict[str, Any] = {}
        for candidate in candidates:
            if not isinstance(candidate, dict):
                raise RowndTokenValidationError(RowndTokenValidationReason.JWKS_INVALID_RESPONSE)
            key_id = candidate.get("kid")
            if (
                not isinstance(key_id, str)
                or not key_id
                or key_id != key_id.strip()
                or key_id in keys
                or candidate.get("kty") != "OKP"
                or candidate.get("crv") != "Ed25519"
                or candidate.get("alg") not in {None, "EdDSA"}
                or candidate.get("use") not in {None, "sig"}
            ):
                raise RowndTokenValidationError(RowndTokenValidationReason.JWKS_INVALID_RESPONSE)
            py_jwk = jwt.PyJWK.from_dict(candidate)
            keys[key_id] = py_jwk.key
        return keys

    def _remember_unknown_kid(self, key_id: str, generation: int) -> None:
        now = self._monotonic()
        expired = [kid for kid, entry in self._negative_kids.items() if entry[0] <= now]
        for kid in expired:
            del self._negative_kids[kid]
        self._negative_kids[key_id] = (now + self._NEGATIVE_CACHE_TTL_SECONDS, generation)
        self._negative_kids.move_to_end(key_id)
        while len(self._negative_kids) > self._MAX_NEGATIVE_CACHE_ENTRIES:
            self._negative_kids.popitem(last=False)

    def _record_jwks_diagnostic(
        self,
        key_id: str,
        cache: Optional[_JwksCache],
        outcome: str,
        reason: Optional[str] = None,
    ) -> None:
        if (
            self._telemetry_client is None
            or self._random_value() >= self._JWKS_DIAGNOSTIC_SAMPLE_RATE
        ):
            return
        event: JsonDict = {
            "operation": "jwks_refresh",
            "outcome": outcome,
            "kidHash": hashlib.sha256(key_id.encode("utf-8")).hexdigest()[:16],
            "keyCount": len(cache.keys) if cache is not None else 0,
            "generation": cache.generation if cache is not None else 0,
        }
        if reason is not None:
            event["reason"] = reason
        record_jwks_diagnostic(self._telemetry_client, event)

    async def fetch_user_info(self, user_id: str) -> JsonDict:
        data = await self.fetch_optional_user_info(user_id)
        if data is None:
            raise RowndPluginError("User not found in Rownd")
        return data

    async def fetch_optional_user_info(self, user_id: str) -> Optional[JsonDict]:
        app_id = await self._fetch_app_id()

        try:
            data = await self._request(
                "GET",
                "/applications/%s/users/%s/data" % (app_id, user_id),
            )
        except RowndAPIError as err:
            if err.reason is RowndAPIErrorReason.USER_NOT_FOUND:
                return None
            if err.reason is RowndAPIErrorReason.AUTHORIZATION_REJECTED:
                raise RowndAPIError(RowndAPIErrorReason.CREDENTIALS_REJECTED) from err
            if err.reason is RowndAPIErrorReason.INVALID_RESPONSE:
                raise RowndAPIError(RowndAPIErrorReason.PROFILE_INVALID) from err
            raise
        profile_data = data.get("data")
        profile_user_id = profile_data.get("user_id") if isinstance(profile_data, dict) else None
        if (
            not isinstance(profile_data, dict)
            or not isinstance(profile_user_id, str)
            or not profile_user_id.strip()
            or not isinstance(data.get("verified_data"), dict)
        ):
            raise RowndAPIError(RowndAPIErrorReason.PROFILE_INVALID)
        return data

    async def _fetch_app_id(self) -> str:
        cache = self._app_id_cache
        if cache is not None and self._monotonic() < cache.expires_at:
            return cache.app_id
        refresh = self._app_id_refresh
        if refresh is None or refresh.done():
            if (
                self._app_id_error is not None
                and self._monotonic() < self._app_id_blocked_until
            ):
                raise RowndAPIError(self._app_id_error)
            refresh = asyncio.create_task(self._run_app_id_refresh())
            self._app_id_refresh = refresh
            refresh.add_done_callback(self._clear_app_id_refresh)
        loaded = await asyncio.shield(refresh)
        return loaded.app_id

    def _clear_app_id_refresh(self, refresh: asyncio.Task[_AppIdCache]) -> None:
        if self._app_id_refresh is refresh:
            self._app_id_refresh = None

    async def _run_app_id_refresh(self) -> _AppIdCache:
        try:
            cache = await self._refresh_app_id()
        except RowndAPIError as err:
            self._app_id_error = err.reason
            self._app_id_blocked_until = (
                self._monotonic() + self._APP_ID_FAILURE_BACKOFF_SECONDS
            )
            raise
        self._app_id_error = None
        return cache

    async def _refresh_app_id(self) -> _AppIdCache:
        try:
            app_config = await self._request("GET", "/hub/app-config")
        except RowndAPIError as err:
            if err.reason is RowndAPIErrorReason.AUTHORIZATION_REJECTED:
                raise RowndAPIError(RowndAPIErrorReason.CREDENTIALS_REJECTED) from err
            if err.reason in {
                RowndAPIErrorReason.USER_NOT_FOUND,
                RowndAPIErrorReason.INVALID_RESPONSE,
            }:
                raise RowndAPIError(RowndAPIErrorReason.APP_CONFIG_INVALID) from err
            raise
        app = app_config.get("app")
        app_id = app.get("id") if isinstance(app, dict) else None
        if not isinstance(app_id, str) or not app_id.strip():
            raise RowndAPIError(RowndAPIErrorReason.APP_CONFIG_INVALID)
        loaded = _AppIdCache(
            app_id=app_id,
            expires_at=self._monotonic() + self._APP_ID_CACHE_TTL_SECONDS,
            generation=(self._app_id_cache.generation + 1 if self._app_id_cache else 1),
        )
        self._app_id_cache = loaded
        return loaded

    async def _request(self, method: str, path: str, json: Optional[JsonDict] = None) -> JsonDict:
        app_key = self.config.rownd_app_key
        app_secret = self.config.rownd_app_secret
        if app_key is None or app_secret is None:
            raise RowndAPIError(RowndAPIErrorReason.CREDENTIALS_REJECTED)
        headers = {
            "x-rownd-app-key": app_key,
            "x-rownd-app-secret": app_secret,
        }
        async def perform_request() -> JsonDict:
            async with httpx.AsyncClient(timeout=10.0, transport=self._transport) as client:
                async with client.stream(
                    method,
                    self.config.rownd_api_base_url.rstrip("/") + path,
                    headers=headers,
                    json=json,
                ) as res:
                    if not 200 <= res.status_code < 300:
                        if res.status_code in {401, 403}:
                            raise RowndAPIError(RowndAPIErrorReason.AUTHORIZATION_REJECTED)
                        if res.status_code == 404:
                            raise RowndAPIError(RowndAPIErrorReason.USER_NOT_FOUND)
                        if res.status_code in {408, 429} or res.status_code >= 500:
                            raise RowndAPIError(RowndAPIErrorReason.UNAVAILABLE)
                        raise RowndAPIError(RowndAPIErrorReason.INVALID_RESPONSE)
                    body = bytearray()
                    chunk_size = min(64 * 1024, self._MAX_API_RESPONSE_BYTES + 1)
                    async for chunk in res.aiter_bytes(chunk_size=chunk_size):
                        if len(body) + len(chunk) > self._MAX_API_RESPONSE_BYTES:
                            raise RowndAPIError(RowndAPIErrorReason.INVALID_RESPONSE)
                        body.extend(chunk)
            try:
                data = json_module.loads(body)
            except ValueError as err:
                raise RowndAPIError(RowndAPIErrorReason.INVALID_RESPONSE) from err
            if not isinstance(data, dict):
                raise RowndAPIError(RowndAPIErrorReason.INVALID_RESPONSE)
            return data

        try:
            return await asyncio.wait_for(
                perform_request(), timeout=self._API_REQUEST_DEADLINE_SECONDS
            )
        except RowndAPIError:
            raise
        except (asyncio.TimeoutError, httpx.HTTPError) as err:
            raise RowndAPIError(RowndAPIErrorReason.UNAVAILABLE) from err

    async def _request_public(self, path: str) -> JsonDict:
        return await self._request_public_url(self.config.rownd_api_base_url.rstrip("/") + path)

    async def _request_public_url(self, url: str) -> JsonDict:
        async with httpx.AsyncClient(timeout=10.0, transport=self._transport) as client:
            res = await client.get(url)
            res.raise_for_status()
            data = res.json()
        if not isinstance(data, dict):
            raise RowndPluginError("Invalid Rownd response")
        return data

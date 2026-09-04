from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from enum import Enum
from typing import Any, Callable, Dict, Optional
from urllib.parse import urlsplit

import httpx
import jwt

from .errors import RowndPluginError
from .types import JsonDict, RowndPluginConfig


class RowndTokenValidationReason(str, Enum):
    TOKEN_MALFORMED = "TOKEN_MALFORMED"
    TOKEN_EXPIRED = "TOKEN_EXPIRED"
    TOKEN_NOT_ACTIVE = "TOKEN_NOT_ACTIVE"
    TOKEN_CLAIMS_INVALID = "TOKEN_CLAIMS_INVALID"
    TOKEN_KID_UNKNOWN = "TOKEN_KID_UNKNOWN"
    TOKEN_SIGNATURE_INVALID = "TOKEN_SIGNATURE_INVALID"
    JWKS_FETCH_FAILED = "JWKS_FETCH_FAILED"
    JWKS_INVALID_RESPONSE = "JWKS_INVALID_RESPONSE"


class RowndTokenValidationError(RowndPluginError):
    def __init__(self, reason: RowndTokenValidationReason):
        super().__init__("Invalid token")
        self.reason = reason


@dataclass(frozen=True)
class _JwksCache:
    jwks_uri: str
    keys: Dict[str, Any]
    expires_at: float
    generation: int


class RowndClient:
    _JWKS_CACHE_TTL_SECONDS = 300.0

    def __init__(
        self,
        config: RowndPluginConfig,
        transport: Optional[httpx.AsyncBaseTransport] = None,
        monotonic: Callable[[], float] = time.monotonic,
    ):
        self.config = config
        self._transport = transport
        self._monotonic = monotonic
        self._jwks_cache: Optional[_JwksCache] = None
        self._jwks_refresh: Optional[asyncio.Task[_JwksCache]] = None

    async def validate_token(self, token: str) -> str:
        try:
            key_id = self._parse_token_header(token)
            cache = await self._load_jwks(
                force=False,
                observed_generation=self._jwks_cache.generation if self._jwks_cache else 0,
            )
            key = cache.keys.get(key_id)
            if key is None:
                cache = await self._load_jwks(
                    force=True,
                    observed_generation=cache.generation,
                )
                key = cache.keys.get(key_id)
                if key is None:
                    raise RowndTokenValidationError(
                        RowndTokenValidationReason.TOKEN_KID_UNKNOWN
                    )

            app_config = await self._request("GET", "/hub/app-config")
            app = app_config.get("app")
            app_id = app.get("id") if isinstance(app, dict) else None
            if not isinstance(app_id, str) or not app_id:
                raise RowndTokenValidationError(
                    RowndTokenValidationReason.TOKEN_CLAIMS_INVALID
                )

            data = jwt.decode(
                token,
                key,
                algorithms=["EdDSA"],
                audience="app:%s" % app_id,
            )
        except RowndTokenValidationError:
            raise
        except jwt.InvalidSignatureError as err:
            raise RowndTokenValidationError(
                RowndTokenValidationReason.TOKEN_SIGNATURE_INVALID
            ) from err
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
        if len(token.split(".")) != 3 or any(not part for part in token.split(".")):
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
    ) -> _JwksCache:
        cache = self._jwks_cache
        if cache is not None and not force and self._monotonic() < cache.expires_at:
            return cache
        if force and cache is not None and cache.generation != observed_generation:
            return cache

        refresh = self._jwks_refresh
        if refresh is None or refresh.done():
            refresh = asyncio.create_task(self._refresh_jwks())
            self._jwks_refresh = refresh
            refresh.add_done_callback(self._clear_jwks_refresh)
        return await asyncio.shield(refresh)

    def _clear_jwks_refresh(self, refresh: asyncio.Task[_JwksCache]) -> None:
        if self._jwks_refresh is refresh:
            self._jwks_refresh = None

    async def _refresh_jwks(self) -> _JwksCache:
        try:
            oauth_config = await self._request_public(
                "/hub/auth/.well-known/oauth-authorization-server"
            )
            jwks_uri = oauth_config.get("jwks_uri")
            if not isinstance(jwks_uri, str) or not self._is_valid_jwks_uri(jwks_uri):
                raise RowndTokenValidationError(
                    RowndTokenValidationReason.JWKS_INVALID_RESPONSE
                )
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

    async def fetch_user_info(self, user_id: str) -> JsonDict:
        data = await self.fetch_optional_user_info(user_id)
        if data is None:
            raise RowndPluginError("User not found in Rownd")
        return data

    async def fetch_optional_user_info(self, user_id: str) -> Optional[JsonDict]:
        app_config = await self._request("GET", "/hub/app-config")
        app = app_config.get("app")
        app_id = app.get("id") if isinstance(app, dict) else None
        if not isinstance(app_id, str) or not app_id:
            raise RowndPluginError("Invalid Rownd app config")

        try:
            data = await self._request(
                "GET",
                "/applications/%s/users/%s/data" % (app_id, user_id),
            )
        except httpx.HTTPStatusError as err:
            if err.response.status_code == 404:
                return None
            raise
        if not isinstance(data, dict) or not data:
            return None
        return data

    async def _request(self, method: str, path: str, json: Optional[JsonDict] = None) -> JsonDict:
        app_key = self.config.rownd_app_key
        app_secret = self.config.rownd_app_secret
        if app_key is None or app_secret is None:
            raise RowndPluginError("Rownd credentials are required for Rownd API requests")
        headers = {
            "x-rownd-app-key": app_key,
            "x-rownd-app-secret": app_secret,
        }
        async with httpx.AsyncClient(timeout=10.0, transport=self._transport) as client:
            res = await client.request(
                method,
                self.config.rownd_api_base_url.rstrip("/") + path,
                headers=headers,
                json=json,
            )
            res.raise_for_status()
            data = res.json()
            if not isinstance(data, dict):
                raise RowndPluginError("Invalid Rownd response")
            return data

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

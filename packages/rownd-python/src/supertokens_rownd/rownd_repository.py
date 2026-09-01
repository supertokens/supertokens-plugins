from __future__ import annotations

import httpx
import jwt
from typing import Optional

from .errors import RowndPluginError
from .types import JsonDict, RowndPluginConfig


class RowndClient:
    def __init__(self, config: RowndPluginConfig):
        self.config = config

    async def validate_token(self, token: str) -> str:
        oauth_config = await self._request_public(
            "/hub/auth/.well-known/oauth-authorization-server"
        )
        jwks_uri = oauth_config.get("jwks_uri")
        if not isinstance(jwks_uri, str) or not jwks_uri:
            raise RowndPluginError("Invalid token")

        try:
            jwks = await self._request_public_url(jwks_uri)
            header = jwt.get_unverified_header(token)
            key_id = header.get("kid")
            keys = jwks.get("keys")
            if not isinstance(key_id, str) or not isinstance(keys, list):
                raise RowndPluginError("Invalid token")

            key = next(
                (
                    candidate
                    for candidate in keys
                    if isinstance(candidate, dict) and candidate.get("kid") == key_id
                ),
                None,
            )
            if key is None:
                raise RowndPluginError("Invalid token")

            app_config = await self._request("GET", "/hub/app-config")
            app = app_config.get("app")
            app_id = app.get("id") if isinstance(app, dict) else None
            if not isinstance(app_id, str) or not app_id:
                raise RowndPluginError("Invalid token")

            data = jwt.decode(
                token,
                jwt.PyJWK.from_dict(key).key,
                algorithms=["EdDSA"],
                audience="app:%s" % app_id,
            )
        except jwt.PyJWTError as err:
            raise RowndPluginError("Invalid token") from err

        user_id = data.get("https://auth.rownd.io/app_user_id")
        if not isinstance(user_id, str) or not user_id:
            raise RowndPluginError("Invalid token")
        return user_id

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
        async with httpx.AsyncClient(timeout=10.0) as client:
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
        async with httpx.AsyncClient(timeout=10.0) as client:
            res = await client.get(url)
            res.raise_for_status()
            data = res.json()
            if not isinstance(data, dict):
                raise RowndPluginError("Invalid Rownd response")
            return data

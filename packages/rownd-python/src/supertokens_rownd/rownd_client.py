from __future__ import annotations

from typing import Any, Dict

import httpx

from .types import RowndPluginConfig, RowndPluginError


class RowndClient:
    def __init__(self, config: RowndPluginConfig):
        self.config = config

    async def validate_token(self, token: str) -> str:
        data = await self._request("POST", "/hub/auth/token/validate", json={"token": token})
        user_id = data.get("user_id") or data.get("userId")
        if not isinstance(user_id, str) or not user_id:
            raise RowndPluginError("Invalid token")
        return user_id

    async def fetch_user_info(self, user_id: str) -> Dict[str, Any]:
        data = await self._request(
            "GET",
            "/me/applications/%s/users/%s" % (self.config.rownd_app_key, user_id),
        )
        if not isinstance(data, dict) or not data:
            raise RowndPluginError("User not found in Rownd")
        return data

    async def _request(self, method: str, path: str, **kwargs: Any) -> Dict[str, Any]:
        headers = kwargs.pop("headers", {})
        headers.update(
            {
                "x-rownd-app-key": self.config.rownd_app_key,
                "x-rownd-app-secret": self.config.rownd_app_secret,
            }
        )
        async with httpx.AsyncClient(timeout=10.0) as client:
            res = await client.request(
                method,
                self.config.rownd_api_base_url.rstrip("/") + path,
                headers=headers,
                **kwargs,
            )
            res.raise_for_status()
            return res.json()

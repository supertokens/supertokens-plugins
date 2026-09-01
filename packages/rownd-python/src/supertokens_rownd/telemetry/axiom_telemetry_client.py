from __future__ import annotations

from typing import Optional

import httpx

from ..types import JsonDict


class AxiomTelemetryClient:
    def __init__(self, token: str, dataset: str, url: Optional[str] = None):
        self.token = token
        self.dataset = dataset
        self.url = (url or "https://api.axiom.co/v1/datasets").rstrip("/")

    async def record_event(self, event: JsonDict) -> None:
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(
                "%s/%s/ingest" % (self.url, self.dataset),
                headers={"Authorization": "Bearer %s" % self.token},
                json=[event],
            )

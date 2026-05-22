from __future__ import annotations

import time
from typing import Any, Dict, Optional

import httpx

from .types import RowndPluginConfig, RowndTelemetryClient, RowndTelemetryConfig


class NoopTelemetryClient:
    async def record_event(self, event: Dict[str, Any]) -> None:
        return None


class AxiomTelemetryClient:
    def __init__(self, token: str, dataset: str, url: Optional[str] = None):
        self.token = token
        self.dataset = dataset
        self.url = (url or "https://api.axiom.co/v1/datasets").rstrip("/")

    async def record_event(self, event: Dict[str, Any]) -> None:
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(
                "%s/%s/ingest" % (self.url, self.dataset),
                headers={"Authorization": "Bearer %s" % self.token},
                json=[event],
            )


def create_telemetry_client(config: RowndPluginConfig) -> RowndTelemetryClient:
    telemetry = config.telemetry
    if telemetry is None:
        return NoopTelemetryClient()
    if isinstance(telemetry, dict):
        telemetry = RowndTelemetryConfig(**telemetry)
    if telemetry.provider == "custom" and telemetry.factory is not None:
        return telemetry.factory()
    if telemetry.provider == "axiom" and telemetry.token and telemetry.dataset:
        return AxiomTelemetryClient(telemetry.token, telemetry.dataset, telemetry.url)
    return NoopTelemetryClient()


async def record_success(
    client: RowndTelemetryClient,
    started_at: float,
    tenant_id: Optional[str] = None,
    rownd_user_id: Optional[str] = None,
    supertokens_user_id: Optional[str] = None,
) -> None:
    await _safe_record(
        client,
        {
            "outcome": "success",
            "durationMs": int((time.time() - started_at) * 1000),
            "tenantId": tenant_id,
            "rowndUserId": rownd_user_id,
            "superTokensUserId": supertokens_user_id,
        },
    )


async def record_error(
    client: RowndTelemetryClient,
    started_at: float,
    error: Exception,
    tenant_id: Optional[str] = None,
    rownd_user_id: Optional[str] = None,
    supertokens_user_id: Optional[str] = None,
) -> None:
    await _safe_record(
        client,
        {
            "outcome": "error",
            "durationMs": int((time.time() - started_at) * 1000),
            "tenantId": tenant_id,
            "rowndUserId": rownd_user_id,
            "superTokensUserId": supertokens_user_id,
            "error": {"message": str(error), "name": error.__class__.__name__},
        },
    )


async def _safe_record(client: RowndTelemetryClient, event: Dict[str, Any]) -> None:
    try:
        await client.record_event({k: v for k, v in event.items() if v is not None})
    except Exception:
        return None

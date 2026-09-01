from __future__ import annotations

import time
from typing import Optional

from ..types import JsonDict, RowndPluginConfig, RowndTelemetryClient, RowndTelemetryConfig
from .axiom_telemetry_client import AxiomTelemetryClient


class NoopTelemetryClient:
    async def record_event(self, event: JsonDict) -> None:
        return None


def create_telemetry_client(config: RowndPluginConfig) -> RowndTelemetryClient:
    telemetry = config.telemetry
    if telemetry is None:
        return NoopTelemetryClient()
    if isinstance(telemetry, dict):
        provider = telemetry.get("provider")
        token = telemetry.get("token")
        dataset = telemetry.get("dataset")
        url = telemetry.get("url")
        factory = telemetry.get("factory")
        telemetry = RowndTelemetryConfig(
            provider=provider if isinstance(provider, str) else "none",
            token=token if isinstance(token, str) else None,
            dataset=dataset if isinstance(dataset, str) else None,
            url=url if isinstance(url, str) else None,
            factory=factory if callable(factory) else None,
        )
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


async def _safe_record(client: RowndTelemetryClient, event: JsonDict) -> None:
    try:
        await client.record_event({k: v for k, v in event.items() if v is not None})
    except Exception:
        return None

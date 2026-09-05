from __future__ import annotations

import asyncio
import inspect
import threading
import time
from typing import Callable, Optional

from ..errors import MigrationErrorReason
from ..types import JsonDict, MigrationStage, RowndPluginConfig, RowndTelemetryClient, RowndTelemetryConfig
from .axiom_telemetry_client import AxiomTelemetryClient


class NoopTelemetryClient:
    async def record_event(self, event: JsonDict) -> None:
        return None


class _MigrationTelemetryTaskRegistry:
    def __init__(self, capacity: int = 128, delivery_timeout: Optional[float] = None) -> None:
        self._capacity = capacity
        self._delivery_timeout = delivery_timeout
        self._lock = threading.Lock()
        self._tasks: set[asyncio.Task[None]] = set()

    def submit(self, client: RowndTelemetryClient, event: JsonDict) -> bool:
        with self._lock:
            if len(self._tasks) >= self._capacity:
                return False
            try:
                delivery = (
                    client.record_event(event)
                    if self._delivery_timeout is None
                    else self._record_with_deadline(client, event)
                )
            except Exception:
                return False
            try:
                task = asyncio.create_task(delivery)
            except Exception:
                delivery.close()
                return False
            try:
                self._tasks.add(task)
                task.add_done_callback(self._task_done)
            except Exception:
                self._tasks.discard(task)
                task.add_done_callback(self._consume_task_exception)
                task.cancel()
                return False
        return True

    async def _record_with_deadline(
        self, client: RowndTelemetryClient, event: JsonDict
    ) -> None:
        assert self._delivery_timeout is not None
        delivery = asyncio.create_task(client.record_event(event))
        done, _ = await asyncio.wait({delivery}, timeout=self._delivery_timeout)
        if delivery not in done:
            delivery.cancel()
        try:
            await delivery
        except (asyncio.CancelledError, Exception):
            pass

    def _task_done(self, task: asyncio.Task[None]) -> None:
        self._consume_task_exception(task)
        with self._lock:
            self._tasks.discard(task)

    @staticmethod
    def _consume_task_exception(task: asyncio.Task[None]) -> None:
        try:
            task.exception()
        except (asyncio.CancelledError, Exception):
            pass


_migration_tasks = _MigrationTelemetryTaskRegistry()


class _JwksDiagnosticLimiter:
    def __init__(
        self,
        registry: _MigrationTelemetryTaskRegistry,
        interval_seconds: float = 1.0,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self._registry = registry
        self._interval_seconds = interval_seconds
        self._monotonic = monotonic
        self._lock = threading.Lock()
        self._next_allowed_at = 0.0

    def submit(self, client: RowndTelemetryClient, event: JsonDict) -> bool:
        with self._lock:
            now = self._monotonic()
            if now < self._next_allowed_at:
                return False
            self._next_allowed_at = now + self._interval_seconds
        return self._registry.submit(client, event)


_jwks_tasks = _MigrationTelemetryTaskRegistry(capacity=4, delivery_timeout=0.25)
_jwks_diagnostics = _JwksDiagnosticLimiter(_jwks_tasks)


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
        client = telemetry.factory()
        if not inspect.iscoroutinefunction(getattr(client, "record_event", None)):
            raise ValueError("Custom telemetry record_event must be async")
        return client
    if telemetry.provider == "axiom" and telemetry.token and telemetry.dataset:
        return AxiomTelemetryClient(telemetry.token, telemetry.dataset, telemetry.url)
    return NoopTelemetryClient()


def record_jwks_diagnostic(client: RowndTelemetryClient, event: JsonDict) -> None:
    try:
        _jwks_diagnostics.submit(client, event)
    except Exception:
        pass


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


async def record_migration_terminal(
    client: RowndTelemetryClient,
    started_at: float,
    operation_id: str,
    outcome: str,
    stage: MigrationStage,
    http_status: int,
    retryable: bool,
    migration_state: JsonDict,
    reason: Optional[MigrationErrorReason] = None,
) -> None:
    event: JsonDict = {
        "operationId": operation_id,
        "operation": "migration",
        "outcome": outcome,
        "stage": stage,
        "httpStatus": http_status,
        "retryable": retryable,
        "attemptCount": migration_state.get("attempt_count", 0),
        "path": migration_state.get("path", "not_started"),
        "forcedMappingUsed": False,
        "durationMs": int((time.time() - started_at) * 1000),
    }
    if reason is not None:
        event["reason"] = reason.value
    target_source = migration_state.get("target_source")
    target_context_reasons = {
        MigrationErrorReason.IDENTITY_AMBIGUOUS,
        MigrationErrorReason.IDENTITY_OWNED_BY_ANOTHER_USER,
        MigrationErrorReason.MAPPING_CONFLICT,
        MigrationErrorReason.PRIMARY_ACCOUNT_MERGE_REQUIRED,
    }
    if (
        (outcome == "success" or reason in target_context_reasons)
        and isinstance(target_source, str)
        and target_source
        in {
            "mapping",
            "raw_id",
            "third_party",
            "verified_passwordless",
            "new_import",
        }
    ):
        event["targetSource"] = target_source
    identity_type = migration_state.get("blocked_identity_type")
    if reason in {
        MigrationErrorReason.IDENTITY_AMBIGUOUS,
        MigrationErrorReason.IDENTITY_OWNED_BY_ANOTHER_USER,
        MigrationErrorReason.PRIMARY_ACCOUNT_MERGE_REQUIRED,
    } and isinstance(identity_type, str) and identity_type in {
        "thirdparty",
        "passwordless_email",
        "passwordless_phone",
    }:
        event["blockedIdentityType"] = identity_type
    try:
        _migration_tasks.submit(client, event)
    except Exception:
        pass


async def _safe_record(client: RowndTelemetryClient, event: JsonDict) -> None:
    try:
        await asyncio.wait_for(
            client.record_event({k: v for k, v in event.items() if v is not None}), timeout=0.25
        )
    except Exception:
        return None

from __future__ import annotations

import asyncio
import json
import time
import uuid
from types import SimpleNamespace
from typing import Any, Optional, cast

import pytest
from supertokens_python import SupertokensConfig

import supertokens_rownd.plugin_implementation as implementation
import supertokens_rownd.plugin as plugin
from supertokens_rownd.errors import MigrationError, MigrationErrorReason
from supertokens_rownd.plugin_implementation import handle_migrate, migration_error_response
from supertokens_rownd.rownd_repository import (
    RowndAPIError,
    RowndAPIErrorReason,
    RowndTokenValidationError,
    RowndTokenValidationReason,
)
from supertokens_rownd.types import JsonDict, RowndPluginConfig, RowndTelemetryConfig
from supertokens_rownd.utils import parse_migration_authorization_header


ERROR_CONTRACT = {
    MigrationErrorReason.ROWND_USER_NOT_FOUND: (401, False, "User not found in Rownd"),
    MigrationErrorReason.PLUGIN_CONFIGURATION_INVALID: (
        500,
        False,
        "The Rownd plugin configuration is invalid",
    ),
    MigrationErrorReason.ROWND_USER_DISABLED: (401, False, "The Rownd user is disabled"),
    MigrationErrorReason.TOKEN_MISSING: (401, False, "Authorization token is required"),
    MigrationErrorReason.TOKEN_MALFORMED: (401, False, "Authorization token is malformed"),
    MigrationErrorReason.TOKEN_EXPIRED: (401, False, "Authorization token has expired"),
    MigrationErrorReason.TOKEN_NOT_ACTIVE: (401, False, "Authorization token is not active"),
    MigrationErrorReason.TOKEN_CLAIMS_INVALID: (
        401,
        False,
        "Authorization token claims are invalid",
    ),
    MigrationErrorReason.TOKEN_KID_UNKNOWN: (401, False, "Authorization token key is unknown"),
    MigrationErrorReason.TOKEN_SIGNATURE_INVALID: (
        401,
        False,
        "Authorization token signature is invalid",
    ),
    MigrationErrorReason.ROWND_USER_ID_MISMATCH: (
        403,
        False,
        "The token does not belong to the Rownd user",
    ),
    MigrationErrorReason.SOURCE_IDENTITY_INVALID: (
        422,
        False,
        "The Rownd identity data is invalid",
    ),
    MigrationErrorReason.IDENTITY_AMBIGUOUS: (
        409,
        False,
        "The Rownd identity resolves to multiple users",
    ),
    MigrationErrorReason.IDENTITY_OWNED_BY_ANOTHER_USER: (
        409,
        False,
        "The Rownd identity belongs to another user",
    ),
    MigrationErrorReason.MAPPING_CONFLICT: (
        409,
        False,
        "The Rownd identity is linked to another user",
    ),
    MigrationErrorReason.RAW_USER_ID_COLLISION: (
        409,
        False,
        "The Rownd user ID conflicts with an existing user",
    ),
    MigrationErrorReason.PRIMARY_ACCOUNT_MERGE_REQUIRED: (
        409,
        False,
        "Migration requires merging primary accounts",
    ),
    MigrationErrorReason.MIGRATION_STATE_INVALID: (
        409,
        False,
        "The persisted migration state is invalid",
    ),
    MigrationErrorReason.ROWND_UNAVAILABLE: (503, True, "Rownd is temporarily unavailable"),
    MigrationErrorReason.CORE_UNAVAILABLE: (
        503,
        True,
        "SuperTokens Core is temporarily unavailable",
    ),
    MigrationErrorReason.CORE_CAPABILITY_REQUIRED: (
        503,
        False,
        "SuperTokens Core does not support the required migration operation",
    ),
    MigrationErrorReason.MIGRATION_INCOMPLETE: (503, True, "Migration could not be completed"),
    MigrationErrorReason.SESSION_CREATION_FAILED: (
        503,
        True,
        "Migration completed but session creation failed",
    ),
    MigrationErrorReason.INTERNAL_ERROR: (
        500,
        True,
        "Migration failed due to an internal error",
    ),
}


class FakeRequest:
    def __init__(self, authorization: Optional[str] = "Bearer token") -> None:
        self.authorization = authorization

    def get_header(self, name: str) -> Optional[str]:
        return self.authorization if name == "authorization" else None

    def get_query_param(self, name: str) -> Optional[str]:
        return None

    def get_path(self) -> str:
        return "/auth/plugin/rownd/migrate"


class FakeResponse:
    def __init__(self, fail_json_count: int = 0, cancel_json_count: int = 0) -> None:
        self.status_code: Optional[int] = None
        self.body: Optional[JsonDict] = None
        self.fail_json_count = fail_json_count
        self.cancel_json_count = cancel_json_count

    def set_status_code(self, status_code: int) -> None:
        self.status_code = status_code

    def set_json_content(self, body: JsonDict) -> None:
        if self.cancel_json_count:
            self.cancel_json_count -= 1
            raise asyncio.CancelledError
        if self.fail_json_count:
            self.fail_json_count -= 1
            raise RuntimeError("response adapter private failure")
        self.body = body


class CapturingTelemetry:
    def __init__(self) -> None:
        self.events: list[JsonDict] = []

    async def record_event(self, event: JsonDict) -> None:
        self.events.append(event)


class CapturingRegistry:
    def submit(self, client: CapturingTelemetry, event: JsonDict) -> bool:
        client.events.append(event)
        return True


class FakeRowndClient:
    def __init__(
        self,
        *,
        validation_error: Optional[Exception] = None,
        fetch_error: Optional[Exception] = None,
        user_info: Optional[JsonDict] = None,
    ) -> None:
        self.validation_error = validation_error
        self.fetch_error = fetch_error
        self.validation_calls = 0
        self.user_info: Optional[JsonDict] = (
            user_info
            if user_info is not None
            else {"data": {"user_id": "rownd-user"}, "verified_data": {}}
        )

    async def validate_token(self, token: str) -> str:
        self.validation_calls += 1
        if self.validation_error is not None:
            raise self.validation_error
        return "rownd-user"

    async def fetch_optional_user_info(self, user_id: str) -> Optional[JsonDict]:
        if self.fetch_error is not None:
            raise self.fetch_error
        return self.user_info

    async def fetch_user_info(self, user_id: str) -> JsonDict:
        if self.user_info is None:
            raise RuntimeError("missing test user")
        return self.user_info


async def invoke_migration(
    monkeypatch: pytest.MonkeyPatch,
    *,
    authorization: Optional[str] = "Bearer token",
    client: Optional[FakeRowndClient] = None,
    repository_error: Optional[Exception] = None,
    telemetry_client: Optional[CapturingTelemetry] = None,
    migration_state: Optional[JsonDict] = None,
    response: Optional[FakeResponse] = None,
    capture_telemetry: bool = True,
) -> tuple[FakeResponse, CapturingTelemetry]:
    async def migrate(*args: Any, **kwargs: Any) -> str:
        if migration_state is not None:
            cast(JsonDict, args[9]).update(migration_state)
        if repository_error is not None:
            raise repository_error
        return "supertokens-user"

    monkeypatch.setattr(implementation.repository, "migrate_rownd_user_and_create_session", migrate)
    if capture_telemetry:
        monkeypatch.setattr(implementation.telemetry, "_migration_tasks", CapturingRegistry())
    response = response or FakeResponse()
    telemetry = telemetry_client or CapturingTelemetry()
    await handle_migrate(
        RowndPluginConfig(rownd_app_key="key", rownd_app_secret="secret"),
        client or FakeRowndClient(),
        telemetry,
        SupertokensConfig("http://localhost:3567"),
        cast(Any, FakeRequest(authorization)),
        cast(Any, response),
        {},
    )
    return response, telemetry


@pytest.mark.parametrize("reason", list(MigrationErrorReason))
def test_every_reason_has_exact_public_contract(reason: MigrationErrorReason) -> None:
    status, retryable, message = ERROR_CONTRACT[reason]
    error = MigrationError(reason, "state_inspect", RuntimeError("private upstream detail"))

    assert error.http_status == status
    assert error.retryable is retryable
    assert error.public_message == message
    assert migration_error_response(error, "operation-id") == {
        "status": "ERROR",
        "code": status,
        "reason": reason.value,
        "message": message,
        "retryable": retryable,
        "stage": "state_inspect",
        "operationId": "operation-id",
    }
    assert "private upstream detail" not in json.dumps(migration_error_response(error, "id"))


@pytest.mark.parametrize(
    ("authorization", "reason"),
    [
        (None, MigrationErrorReason.TOKEN_MISSING),
        ("", MigrationErrorReason.TOKEN_MISSING),
        ("Bearer", MigrationErrorReason.TOKEN_MALFORMED),
        ("Bearer ", MigrationErrorReason.TOKEN_MALFORMED),
        ("Basic token", MigrationErrorReason.TOKEN_MALFORMED),
        ("token", MigrationErrorReason.TOKEN_MALFORMED),
        ("Bearer token with-spaces", MigrationErrorReason.TOKEN_MALFORMED),
        (" Bearer token", MigrationErrorReason.TOKEN_MALFORMED),
        ("Bearer  token", MigrationErrorReason.TOKEN_MALFORMED),
    ],
)
def test_migration_authorization_is_strict(
    authorization: Optional[str], reason: MigrationErrorReason
) -> None:
    with pytest.raises(MigrationError) as exc_info:
        parse_migration_authorization_header(FakeRequest(authorization))  # type: ignore[arg-type]

    assert exc_info.value.reason == reason
    assert exc_info.value.stage == "request_parse"


def test_migration_authorization_accepts_case_insensitive_bearer() -> None:
    assert parse_migration_authorization_header(FakeRequest("bEaReR token")) == "token"  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("internal_reason", "public_reason"),
    [
        (RowndTokenValidationReason.TOKEN_MALFORMED, MigrationErrorReason.TOKEN_MALFORMED),
        (RowndTokenValidationReason.TOKEN_EXPIRED, MigrationErrorReason.TOKEN_EXPIRED),
        (RowndTokenValidationReason.TOKEN_NOT_ACTIVE, MigrationErrorReason.TOKEN_NOT_ACTIVE),
        (
            RowndTokenValidationReason.TOKEN_CLAIMS_INVALID,
            MigrationErrorReason.TOKEN_CLAIMS_INVALID,
        ),
        (RowndTokenValidationReason.TOKEN_KID_UNKNOWN, MigrationErrorReason.TOKEN_KID_UNKNOWN),
        (
            RowndTokenValidationReason.TOKEN_SIGNATURE_INVALID,
            MigrationErrorReason.TOKEN_SIGNATURE_INVALID,
        ),
        (RowndTokenValidationReason.JWKS_FETCH_FAILED, MigrationErrorReason.ROWND_UNAVAILABLE),
        (RowndTokenValidationReason.JWKS_INVALID_RESPONSE, MigrationErrorReason.ROWND_UNAVAILABLE),
    ],
)
@pytest.mark.asyncio
async def test_handler_maps_nominal_token_and_jwks_reasons(
    monkeypatch: pytest.MonkeyPatch,
    internal_reason: RowndTokenValidationReason,
    public_reason: MigrationErrorReason,
) -> None:
    response, _ = await invoke_migration(
        monkeypatch,
        client=FakeRowndClient(validation_error=RowndTokenValidationError(internal_reason)),
    )

    assert response.body is not None
    assert response.status_code == ERROR_CONTRACT[public_reason][0]
    assert response.body["reason"] == public_reason.value
    assert response.body["stage"] == "token_validate"


@pytest.mark.asyncio
async def test_unknown_exception_is_sanitized_in_response_and_telemetry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response, telemetry = await invoke_migration(
        monkeypatch, repository_error=RuntimeError("private database response")
    )

    assert response.status_code == 500
    assert response.body is not None
    assert response.body["reason"] == "INTERNAL_ERROR"
    assert response.body["message"] == "Migration failed due to an internal error"
    assert response.body["stage"] == "state_inspect"
    uuid.UUID(str(response.body["operationId"]))
    assert "private database response" not in json.dumps(response.body)
    assert "private database response" not in json.dumps(telemetry.events)


@pytest.mark.asyncio
async def test_missing_profile_is_not_a_successful_no_op(monkeypatch: pytest.MonkeyPatch) -> None:
    client = FakeRowndClient()
    client.user_info = None
    response, _ = await invoke_migration(monkeypatch, client=client)

    assert response.status_code == 401
    assert response.body is not None
    assert response.body["reason"] == "ROWND_USER_NOT_FOUND"
    assert response.body["stage"] == "rownd_profile_fetch"


@pytest.mark.asyncio
async def test_early_failure_emits_exactly_one_terminal_event(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response, telemetry_client = await invoke_migration(monkeypatch, authorization=None)

    assert response.status_code == 401
    assert len(telemetry_client.events) == 1
    assert telemetry_client.events[0]["reason"] == "TOKEN_MISSING"
    assert telemetry_client.events[0]["attemptCount"] == 0
    assert telemetry_client.events[0]["path"] == "not_started"


@pytest.mark.asyncio
async def test_profile_fetch_failure_is_rownd_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    class FailingProfileClient(FakeRowndClient):
        async def fetch_optional_user_info(self, user_id: str) -> Optional[JsonDict]:
            raise RuntimeError("private upstream response")

    response, _ = await invoke_migration(monkeypatch, client=FailingProfileClient())

    assert response.status_code == 503
    assert response.body is not None
    assert response.body["reason"] == "ROWND_UNAVAILABLE"
    assert response.body["stage"] == "rownd_profile_fetch"
    assert "private upstream response" not in json.dumps(response.body)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("error", "reason", "status", "stage"),
    [
        (
            RowndAPIError(RowndAPIErrorReason.CREDENTIALS_REJECTED),
            "PLUGIN_CONFIGURATION_INVALID",
            500,
            "token_validate",
        ),
        (
            RowndAPIError(RowndAPIErrorReason.APP_CONFIG_INVALID),
            "PLUGIN_CONFIGURATION_INVALID",
            500,
            "token_validate",
        ),
        (
            RowndAPIError(RowndAPIErrorReason.UNAVAILABLE),
            "ROWND_UNAVAILABLE",
            503,
            "token_validate",
        ),
    ],
)
async def test_token_app_config_adapter_errors_are_classified(
    monkeypatch: pytest.MonkeyPatch,
    error: RowndAPIError,
    reason: str,
    status: int,
    stage: str,
) -> None:
    response, _ = await invoke_migration(
        monkeypatch, client=FakeRowndClient(validation_error=error)
    )

    assert response.status_code == status
    assert response.body is not None
    assert response.body["reason"] == reason
    assert response.body["stage"] == stage


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("adapter_reason", "reason", "status", "stage"),
    [
        (RowndAPIErrorReason.USER_NOT_FOUND, "ROWND_USER_NOT_FOUND", 401, "rownd_profile_fetch"),
        (
            RowndAPIErrorReason.CREDENTIALS_REJECTED,
            "PLUGIN_CONFIGURATION_INVALID",
            500,
            "rownd_profile_fetch",
        ),
        (RowndAPIErrorReason.PROFILE_INVALID, "SOURCE_IDENTITY_INVALID", 422, "source_normalize"),
        (RowndAPIErrorReason.UNAVAILABLE, "ROWND_UNAVAILABLE", 503, "rownd_profile_fetch"),
    ],
)
async def test_profile_adapter_errors_are_classified(
    monkeypatch: pytest.MonkeyPatch,
    adapter_reason: RowndAPIErrorReason,
    reason: str,
    status: int,
    stage: str,
) -> None:
    response, _ = await invoke_migration(
        monkeypatch,
        client=FakeRowndClient(fetch_error=RowndAPIError(adapter_reason)),
    )

    assert response.status_code == status
    assert response.body is not None
    assert response.body["reason"] == reason
    assert response.body["stage"] == stage


@pytest.mark.asyncio
async def test_profile_user_id_must_match_token_subject(monkeypatch: pytest.MonkeyPatch) -> None:
    response, _ = await invoke_migration(
        monkeypatch,
        client=FakeRowndClient(
            user_info={"data": {"user_id": "different-user"}, "verified_data": {}}
        ),
    )

    assert response.status_code == 403
    assert response.body is not None
    assert response.body["reason"] == "ROWND_USER_ID_MISMATCH"
    assert response.body["stage"] == "source_normalize"


@pytest.mark.asyncio
async def test_malformed_custom_client_profile_is_source_identity_invalid(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response, _ = await invoke_migration(
        monkeypatch, client=FakeRowndClient(user_info={"data": {}})
    )

    assert response.status_code == 422
    assert response.body is not None
    assert response.body["reason"] == "SOURCE_IDENTITY_INVALID"
    assert response.body["stage"] == "source_normalize"


@pytest.mark.asyncio
async def test_success_body_remains_compatible(monkeypatch: pytest.MonkeyPatch) -> None:
    response, telemetry = await invoke_migration(
        monkeypatch,
        migration_state={
            "attempt_count": 2,
            "path": "postcondition_recovery",
            "target_source": "mapping",
        },
    )

    assert response.status_code == 200
    assert response.body == {"status": "OK"}
    assert telemetry.events == [
        {
            "operationId": telemetry.events[0]["operationId"],
            "operation": "migration",
            "outcome": "success",
            "stage": "session_create",
            "httpStatus": 200,
            "retryable": False,
            "attemptCount": 2,
            "path": "postcondition_recovery",
            "forcedMappingUsed": False,
            "durationMs": telemetry.events[0]["durationMs"],
            "targetSource": "mapping",
        }
    ]
    uuid.UUID(cast(str, telemetry.events[0]["operationId"]))


@pytest.mark.asyncio
async def test_success_response_adapter_failure_emits_only_terminal_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response, telemetry_client = await invoke_migration(
        monkeypatch, response=FakeResponse(fail_json_count=1)
    )

    assert response.status_code == 500
    assert response.body is not None
    assert response.body["reason"] == "INTERNAL_ERROR"
    assert len(telemetry_client.events) == 1
    assert telemetry_client.events[0]["outcome"] == "error"
    assert telemetry_client.events[0]["reason"] == "INTERNAL_ERROR"


@pytest.mark.asyncio
async def test_cancellation_during_migration_emits_one_cancelled_event(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class BlockingClient(FakeRowndClient):
        def __init__(self) -> None:
            super().__init__()
            self.started = asyncio.Event()

        async def validate_token(self, token: str) -> str:
            self.started.set()
            await asyncio.sleep(10)
            return "rownd-user"

    client = BlockingClient()
    telemetry_client = CapturingTelemetry()
    task = asyncio.create_task(
        invoke_migration(monkeypatch, client=client, telemetry_client=telemetry_client)
    )
    await client.started.wait()
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task

    assert len(telemetry_client.events) == 1
    assert telemetry_client.events[0]["outcome"] == "cancelled"
    assert telemetry_client.events[0]["stage"] == "token_validate"
    assert telemetry_client.events[0]["httpStatus"] == 499
    assert "reason" not in telemetry_client.events[0]


@pytest.mark.asyncio
async def test_cancellation_during_response_construction_emits_one_cancelled_event(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    telemetry_client = CapturingTelemetry()
    response = FakeResponse(cancel_json_count=1)

    with pytest.raises(asyncio.CancelledError):
        await invoke_migration(
            monkeypatch,
            telemetry_client=telemetry_client,
            response=response,
        )

    assert response.status_code == 200
    assert response.body is None
    assert len(telemetry_client.events) == 1
    assert telemetry_client.events[0]["outcome"] == "cancelled"
    assert telemetry_client.events[0]["stage"] == "session_create"
    assert telemetry_client.events[0]["httpStatus"] == 499


@pytest.mark.asyncio
async def test_typed_repository_failure_keeps_its_stage(monkeypatch: pytest.MonkeyPatch) -> None:
    response, _ = await invoke_migration(
        monkeypatch,
        repository_error=MigrationError(MigrationErrorReason.MAPPING_CONFLICT, "mapping"),
    )

    assert response.status_code == 409
    assert response.body is not None
    assert response.body["reason"] == "MAPPING_CONFLICT"
    assert response.body["stage"] == "mapping"


@pytest.mark.asyncio
async def test_failure_emits_one_private_terminal_event(monkeypatch: pytest.MonkeyPatch) -> None:
    hostile = "rownd-user st-user bearer-token https://private.example body stack traceback"
    response, telemetry = await invoke_migration(
        monkeypatch,
        repository_error=MigrationError(
            MigrationErrorReason.MAPPING_CONFLICT, "mapping", RuntimeError(hostile)
        ),
        migration_state={"attempt_count": 2, "path": "mapped_repair", "target_source": "mapping"},
    )

    assert response.status_code == 409
    assert len(telemetry.events) == 1
    event = telemetry.events[0]
    assert event["operation"] == "migration"
    assert event["outcome"] == "error"
    assert event["reason"] == "MAPPING_CONFLICT"
    assert event["stage"] == "mapping"
    assert event["httpStatus"] == 409
    assert event["retryable"] is False
    assert event["attemptCount"] == 2
    assert event["path"] == "mapped_repair"
    assert event["targetSource"] == "mapping"
    assert event["forcedMappingUsed"] is False
    assert hostile not in json.dumps(event)
    assert "rowndUserId" not in event
    assert "superTokensUserId" not in event
    assert "error" not in event


@pytest.mark.asyncio
async def test_migration_telemetry_preserves_application_loop_affinity_and_returns_fast(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    application_loop = asyncio.get_running_loop()
    delivered = asyncio.Event()

    class LoopAffineTelemetry:
        async def record_event(self, event: JsonDict) -> None:
            assert asyncio.get_running_loop() is application_loop
            delivered.set()

    registry = implementation.telemetry._MigrationTelemetryTaskRegistry(capacity=2)
    monkeypatch.setattr(implementation.telemetry, "_migration_tasks", registry)
    started_at = time.monotonic()
    response, _ = await invoke_migration(
        monkeypatch,
        telemetry_client=cast(Any, LoopAffineTelemetry()),
        capture_telemetry=False,
    )
    elapsed = time.monotonic() - started_at

    assert response.status_code == 200
    assert elapsed < 0.1
    await asyncio.wait_for(delivered.wait(), 1)


@pytest.mark.asyncio
async def test_hung_task_occupies_one_bounded_slot_without_blocking_another() -> None:
    started = asyncio.Event()
    release = asyncio.Event()
    delivered = asyncio.Event()

    class CancellationResistantTelemetry:
        async def record_event(self, event: JsonDict) -> None:
            started.set()
            try:
                await release.wait()
            except asyncio.CancelledError:
                await release.wait()

    class FastTelemetry:
        async def record_event(self, event: JsonDict) -> None:
            delivered.set()

    registry = implementation.telemetry._MigrationTelemetryTaskRegistry(capacity=2)
    assert registry.submit(cast(Any, CancellationResistantTelemetry()), {"sequence": 1}) is True
    await asyncio.wait_for(started.wait(), 1)
    hung_task = next(iter(registry._tasks))
    hung_task.cancel()
    await asyncio.sleep(0)

    assert registry.submit(cast(Any, FastTelemetry()), {"sequence": 2}) is True
    assert registry.submit(cast(Any, FastTelemetry()), {"sequence": 3}) is False
    await asyncio.wait_for(delivered.wait(), 1)
    release.set()
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    assert not registry._tasks


@pytest.mark.asyncio
async def test_jwks_diagnostics_are_globally_limited_and_do_not_consume_terminal_capacity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = 10.0
    diagnostic_started = asyncio.Event()
    diagnostic_cancelled = asyncio.Event()
    terminal_delivered = asyncio.Event()

    class Telemetry:
        async def record_event(self, event: JsonDict) -> None:
            if event.get("operation") == "jwks_refresh":
                diagnostic_started.set()
                try:
                    await asyncio.Event().wait()
                finally:
                    diagnostic_cancelled.set()
            terminal_delivered.set()

    client = cast(Any, Telemetry())
    diagnostic_tasks = implementation.telemetry._MigrationTelemetryTaskRegistry(
        capacity=1, delivery_timeout=0.01
    )
    limiter = implementation.telemetry._JwksDiagnosticLimiter(
        diagnostic_tasks, interval_seconds=1.0, monotonic=lambda: now
    )
    terminal_tasks = implementation.telemetry._MigrationTelemetryTaskRegistry(capacity=1)
    monkeypatch.setattr(implementation.telemetry, "_jwks_diagnostics", limiter)
    monkeypatch.setattr(implementation.telemetry, "_migration_tasks", terminal_tasks)

    for sequence in range(100):
        implementation.telemetry.record_jwks_diagnostic(
            client, {"operation": "jwks_refresh", "sequence": sequence}
        )
    await asyncio.wait_for(diagnostic_started.wait(), 1)
    assert len(diagnostic_tasks._tasks) == 1

    assert terminal_tasks.submit(client, {"operation": "migration"}) is True
    await asyncio.wait_for(terminal_delivered.wait(), 1)
    await asyncio.wait_for(diagnostic_cancelled.wait(), 1)
    await asyncio.sleep(0)
    assert not diagnostic_tasks._tasks

    now += 1.0
    diagnostic_started.clear()
    diagnostic_cancelled.clear()
    implementation.telemetry.record_jwks_diagnostic(
        client, {"operation": "jwks_refresh", "sequence": 101}
    )
    await asyncio.wait_for(diagnostic_started.wait(), 1)
    await asyncio.wait_for(diagnostic_cancelled.wait(), 1)


@pytest.mark.asyncio
async def test_cancellation_resistant_jwks_delivery_keeps_capacity_until_child_exits() -> None:
    started = asyncio.Event()
    cancellation_suppressed = asyncio.Event()
    release = asyncio.Event()
    finished = asyncio.Event()
    loop_errors: list[dict[str, Any]] = []
    loop = asyncio.get_running_loop()
    previous_handler = loop.get_exception_handler()

    class CancellationResistantTelemetry:
        async def record_event(self, event: JsonDict) -> None:
            started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cancellation_suppressed.set()
                await release.wait()
                raise RuntimeError("contained diagnostic failure")
            finally:
                finished.set()

    registry = implementation.telemetry._MigrationTelemetryTaskRegistry(
        capacity=1, delivery_timeout=0.01
    )
    loop.set_exception_handler(lambda _loop, context: loop_errors.append(context))
    try:
        assert registry.submit(cast(Any, CancellationResistantTelemetry()), {}) is True
        await asyncio.wait_for(started.wait(), 1)
        await asyncio.wait_for(cancellation_suppressed.wait(), 1)
        assert len(registry._tasks) == 1
        assert registry.submit(cast(Any, CancellationResistantTelemetry()), {}) is False

        release.set()
        await asyncio.wait_for(finished.wait(), 1)
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert not registry._tasks
        assert loop_errors == []
    finally:
        loop.set_exception_handler(previous_handler)


@pytest.mark.asyncio
async def test_migration_telemetry_task_exception_is_consumed() -> None:
    called = asyncio.Event()
    loop_errors: list[dict[str, Any]] = []
    loop = asyncio.get_running_loop()
    previous_handler = loop.get_exception_handler()

    class FailingTelemetry:
        async def record_event(self, event: JsonDict) -> None:
            called.set()
            raise RuntimeError("private telemetry failure")

    loop.set_exception_handler(lambda _loop, context: loop_errors.append(context))
    try:
        registry = implementation.telemetry._MigrationTelemetryTaskRegistry(capacity=1)
        assert registry.submit(cast(Any, FailingTelemetry()), {}) is True
        await asyncio.wait_for(called.wait(), 1)
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert not registry._tasks
        assert loop_errors == []
    finally:
        loop.set_exception_handler(previous_handler)


def test_migration_telemetry_create_task_failure_is_contained(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Telemetry:
        async def record_event(self, event: JsonDict) -> None:
            return None

    def fail_create_task(coroutine: Any) -> None:
        raise RuntimeError("task submission failed")

    monkeypatch.setattr(asyncio, "create_task", fail_create_task)
    registry = implementation.telemetry._MigrationTelemetryTaskRegistry(capacity=1)

    assert registry.submit(cast(Any, Telemetry()), {}) is False
    assert not registry._tasks


@pytest.mark.asyncio
async def test_migration_telemetry_submission_failure_does_not_change_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FailingRegistry:
        def submit(self, client: CapturingTelemetry, event: JsonDict) -> bool:
            raise RuntimeError("registry failed")

    monkeypatch.setattr(implementation.telemetry, "_migration_tasks", FailingRegistry())
    response, _ = await invoke_migration(monkeypatch, capture_telemetry=False)

    assert response.status_code == 200
    assert response.body == {"status": "OK"}


def test_custom_sync_telemetry_is_rejected() -> None:
    class SyncTelemetry:
        def record_event(self, event: JsonDict) -> None:
            time.sleep(1)

    config = RowndPluginConfig(
        telemetry=RowndTelemetryConfig(
            provider="custom", factory=cast(Any, lambda: SyncTelemetry())
        )
    )

    with pytest.raises(ValueError, match="record_event must be async"):
        implementation.telemetry.create_telemetry_client(config)


@pytest.mark.asyncio
async def test_migration_aliases_invoke_same_error_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    telemetry_client = CapturingTelemetry()
    rownd_plugin = plugin.init(
        RowndPluginConfig(
            rownd_app_key="app-key",
            rownd_app_secret="app-secret",
            telemetry=RowndTelemetryConfig(
                provider="custom", factory=lambda: telemetry_client
            ),
        )
    )
    result = cast(Any, rownd_plugin.route_handlers)(cast(Any, None), [], "0.31.3")
    handlers = {
        route.path: route.handler
        for route in result.route_handlers
        if route.path in {"/auth/plugin/rownd/migrate", "/auth/plugin/migrate-session"}
    }

    assert set(handlers) == {"/auth/plugin/rownd/migrate", "/auth/plugin/migrate-session"}
    assert handlers["/auth/plugin/rownd/migrate"] is handlers["/auth/plugin/migrate-session"]
    monkeypatch.setattr(implementation.telemetry, "_migration_tasks", CapturingRegistry())
    monkeypatch.setattr(
        "supertokens_python.Supertokens.get_instance",
        lambda: SimpleNamespace(supertokens_config=SupertokensConfig("http://localhost:3567")),
    )

    bodies = []
    for handler in handlers.values():
        response = FakeResponse()
        await handler(cast(Any, FakeRequest(None)), cast(Any, response), None, {})
        assert response.status_code == 401
        assert response.body is not None
        bodies.append({**response.body, "operationId": "normalized"})

    assert bodies[0] == bodies[1]
    assert bodies[0]["reason"] == "TOKEN_MISSING"
    assert len(telemetry_client.events) == 2

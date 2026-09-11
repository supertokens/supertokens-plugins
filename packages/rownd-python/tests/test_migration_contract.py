from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from types import SimpleNamespace
from typing import Any, Optional, cast

import pytest
from supertokens_python import SupertokensConfig

import supertokens_rownd.plugin_implementation as implementation
import supertokens_rownd.plugin as plugin
from supertokens_rownd.errors import MigrationError, MigrationErrorReason
from supertokens_rownd.migration import (
    CanonicalEmailPointerState,
    CanonicalEmailPointerStatus,
    MappingLookup,
    MappingState,
    MigrationMetadataState,
    MigrationDisposition,
    MigrationDispositionStatus,
    MigrationSnapshot,
    MigrationMutation,
    MigrationTargetSource,
    MigrationUserState,
    PinnedMigrationTarget,
    RawIdInspection,
    RawIdStatus,
    ValidatedMigrationMetadata,
    immutable_mapping,
)
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
        422,
        False,
        "The Rownd identity resolves to multiple users",
    ),
    MigrationErrorReason.IDENTITY_OWNED_BY_ANOTHER_USER: (
        422,
        False,
        "The Rownd identity belongs to another user",
    ),
    MigrationErrorReason.MAPPING_CONFLICT: (
        422,
        False,
        "The Rownd identity is linked to another user",
    ),
    MigrationErrorReason.RAW_USER_ID_COLLISION: (
        422,
        False,
        "The Rownd user ID conflicts with an existing user",
    ),
    MigrationErrorReason.PRIMARY_ACCOUNT_MERGE_REQUIRED: (
        422,
        False,
        "Migration requires merging primary accounts",
    ),
    MigrationErrorReason.MIGRATION_STATE_INVALID: (
        422,
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
    use_real_repository: bool = False,
    enable_debug_logs: bool = False,
) -> tuple[FakeResponse, CapturingTelemetry]:
    async def migrate(*args: Any, **kwargs: Any) -> str:
        if migration_state is not None:
            cast(JsonDict, args[9]).update(migration_state)
        if repository_error is not None:
            raise repository_error
        return "supertokens-user"

    if not use_real_repository:
        monkeypatch.setattr(
            implementation.repository, "migrate_rownd_user_and_create_session", migrate
        )
    response = response or FakeResponse()
    telemetry = telemetry_client or CapturingTelemetry()
    await handle_migrate(
        RowndPluginConfig(
            rownd_app_key="key", rownd_app_secret="secret", enable_debug_logs=enable_debug_logs
        ),
        client or FakeRowndClient(),
        telemetry,
        SupertokensConfig("http://localhost:3567"),
        cast(Any, FakeRequest(authorization)),
        cast(Any, response),
        {},
    )
    return response, telemetry


@pytest.mark.asyncio
@pytest.mark.parametrize("enable_debug_logs", [False, True])
@pytest.mark.parametrize("delivery", ["capturing", "noop", "failing"])
@pytest.mark.parametrize("outcome", ["success", "early", "typed", "unknown", "response_failure"])
async def test_local_terminal_summary_is_once_and_independent_of_telemetry(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    enable_debug_logs: bool,
    delivery: str,
    outcome: str,
) -> None:
    local_record_counts: list[int] = []

    class Telemetry(CapturingTelemetry):
        async def record_event(self, event: JsonDict) -> None:
            local_record_counts.append(len(caplog.records))
            if delivery == "failing":
                raise RuntimeError("private telemetry token")
            if delivery == "noop":
                await implementation.telemetry.NoopTelemetryClient().record_event(event)
            else:
                await super().record_event(event)

    error = (
        MigrationError(MigrationErrorReason.MAPPING_CONFLICT, "mapping")
        if outcome == "typed"
        else RuntimeError("private database response") if outcome == "unknown" else None
    )
    with caplog.at_level(logging.INFO, logger="supertokens_rownd"):
        response, telemetry = await invoke_migration(
            monkeypatch,
            authorization=None if outcome == "early" else "Bearer token",
            repository_error=error,
            response=FakeResponse(fail_json_count=int(outcome == "response_failure")),
            telemetry_client=Telemetry(),
            enable_debug_logs=enable_debug_logs,
        )

    assert response.body is not None
    assert local_record_counts == [1]
    assert len(caplog.records) == 1
    record = caplog.records[0]
    success = outcome == "success"
    assert response.status_code == {
        "success": 200, "early": 401, "typed": 422, "unknown": 500, "response_failure": 500
    }[outcome]
    assert record.levelno == (logging.INFO if success else logging.WARNING)
    operation_id = record.getMessage().split("operationId=", 1)[1].split()[0]
    uuid.UUID(operation_id)
    stage = "session_create" if success else response.body["stage"]
    reason = "none" if success else response.body["reason"]
    retryable = False if success else response.body["retryable"]
    assert record.getMessage() == (
        "RowndMigrationPlugin: Migration terminal: "
        f"operationId={operation_id} outcome={'success' if success else 'error'} "
        f"stage={stage} reason={reason} retryable={retryable}"
    )
    assert record.exc_info is None
    assert record.stack_info is None
    if not success:
        assert response.body["operationId"] == operation_id
    if delivery == "capturing":
        assert len(telemetry.events) == 1
        assert telemetry.events[0]["operationId"] == operation_id
    else:
        assert telemetry.events == []


@pytest.mark.asyncio
@pytest.mark.parametrize("outcome", ["success", "typed", "stage_subclass", "unknown", "query"])
async def test_local_terminal_summary_omits_hostile_input(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, outcome: str
) -> None:
    hostile = "private-token user@example.com rownd-user st-user\r\nFORGED\x00\x1b[31m" + "x" * 10000

    class HostileError(Exception):
        def __str__(self) -> str:
            raise AssertionError("Exception text must not be read")

    class HostileStage(str):
        def __str__(self) -> str:
            return hostile

    HostileError.__name__ = hostile.replace("\x00", "")
    if outcome == "query":
        monkeypatch.setattr(FakeRequest, "get_query_param", lambda *_args: hostile)
    with caplog.at_level(logging.INFO, logger="supertokens_rownd"):
        await invoke_migration(
            monkeypatch,
            authorization="Bearer private-token",
            repository_error=(
                MigrationError(
                    MigrationErrorReason.MAPPING_CONFLICT,
                    cast(Any, HostileStage("mapping") if outcome == "stage_subclass" else hostile),
                    HostileError(hostile),
                )
                if outcome in {"typed", "stage_subclass"}
                else HostileError(hostile) if outcome == "unknown" else None
            ),
            migration_state={
                "attempt_count": hostile,
                "path": hostile,
                "target_source": hostile,
                "blocked_identity_type": hostile,
                "unresolved_mutation": hostile,
                "rowndUserId": hostile,
            },
            enable_debug_logs=True,
        )

    assert len(caplog.records) == 1
    record = caplog.records[0]
    assert len(record.getMessage()) < 250
    for secret in ("private-token", "user@example.com", "rownd-user", "st-user", "FORGED", "\x00", "\x1b"):
        assert secret not in str(record.__dict__)
    assert record.exc_info is None
    assert record.stack_info is None
    if outcome in {"typed", "stage_subclass", "unknown"}:
        assert "stage=state_inspect" in record.getMessage()
    if outcome == "unknown":
        assert "reason=INTERNAL_ERROR" in record.getMessage()


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
        (RowndTokenValidationReason.JWKS_REFRESH_SUPPRESSED, MigrationErrorReason.ROWND_UNAVAILABLE),
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
    assert response.body["retryable"] is ERROR_CONTRACT[public_reason][1]
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
@pytest.mark.parametrize(
    ("boundary", "profiles_before_disappearance", "repairable"),
    [
        ("attempt_refresh", 1, False),
        ("complete_refresh", 2, False),
        ("final_refresh", 3, True),
        ("session_refresh", 3, False),
        ("immediate_session_refresh", 4, False),
    ],
)
async def test_profile_disappearance_at_migration_boundary_is_user_not_found(
    monkeypatch: pytest.MonkeyPatch,
    boundary: str,
    profiles_before_disappearance: int,
    repairable: bool,
) -> None:
    profile = cast(JsonDict, {"data": {"user_id": "rownd-user"}, "verified_data": {}})

    class DisappearingClient(FakeRowndClient):
        def __init__(self) -> None:
            super().__init__(user_info=profile)
            self.profile_reads = 0

        async def fetch_optional_user_info(self, user_id: str) -> Optional[JsonDict]:
            self.profile_reads += 1
            return profile if self.profile_reads <= profiles_before_disappearance else None

    target = PinnedMigrationTarget("target", MigrationTargetSource.MAPPING)
    disposition = MigrationDisposition(
        MigrationDispositionStatus.REPAIRABLE if repairable else MigrationDispositionStatus.COMPLETE,
        target,
        mutations=(MigrationMutation("WRITE_METADATA", target_user_id="target"),)
        if repairable
        else (),
    )

    async def read_snapshot(*_args: Any):
        return cast(Any, object())

    async def no_op(*_args: Any, **_kwargs: Any) -> None:
        return None

    async def session_method(*_args: Any, **_kwargs: Any):
        return SimpleNamespace(get_as_string=lambda: "recipe-user")

    monkeypatch.setattr(implementation.repository, "read_fresh_migration_snapshot", read_snapshot)
    monkeypatch.setattr(
        implementation.repository, "classify_migration_snapshot", lambda *_args: disposition
    )
    monkeypatch.setattr(implementation.repository, "apply_migration_repairs", no_op)
    monkeypatch.setattr(implementation.repository, "read_fresh_migration_session_method", session_method)
    monkeypatch.setattr(implementation.repository, "record_rownd_app_variant_for_user", no_op)
    monkeypatch.setattr(implementation.repository, "build_rownd_session_claims", lambda *_args: no_op())

    response, telemetry = await invoke_migration(
        monkeypatch,
        client=DisappearingClient(),
        use_real_repository=True,
    )

    assert response.status_code == 401, boundary
    assert response.body is not None
    assert response.body["reason"] == "ROWND_USER_NOT_FOUND"
    assert response.body["stage"] == "rownd_profile_fetch"
    assert telemetry.events[0]["reason"] == "ROWND_USER_NOT_FOUND"


@pytest.mark.asyncio
@pytest.mark.parametrize("boundary", ["complete", "final"])
async def test_source_epoch_change_uses_only_new_source_attribution(
    monkeypatch: pytest.MonkeyPatch, boundary: str
) -> None:
    source_a = cast(
        JsonDict,
        {
            "data": {"user_id": "rownd-user", "email": "a@example.com"},
            "verified_data": {"email": True},
        },
    )
    source_b = cast(
        JsonDict,
        {
            "data": {"user_id": "rownd-user", "google_id": "source-b"},
            "verified_data": {"google_id": True},
        },
    )
    change_after = 2 if boundary == "complete" else 3

    class ChangingClient(FakeRowndClient):
        def __init__(self) -> None:
            super().__init__(user_info=source_a)
            self.profile_reads = 0

        async def fetch_optional_user_info(self, user_id: str) -> Optional[JsonDict]:
            self.profile_reads += 1
            return source_a if self.profile_reads <= change_after else source_b

    target_a = PinnedMigrationTarget("source-a-owner", MigrationTargetSource.THIRD_PARTY)
    target_b = PinnedMigrationTarget("source-b-owner", MigrationTargetSource.MAPPING)
    selected_session_targets: list[str] = []

    async def read_snapshot(source, *_args: Any):
        return source

    def classify(source, pinned):
        is_source_b = any(identity.recipe_id == "thirdparty" for identity in source.expected_identities)
        if is_source_b:
            assert pinned is None
            return MigrationDisposition(MigrationDispositionStatus.COMPLETE, target_b)
        if boundary == "complete":
            return MigrationDisposition(MigrationDispositionStatus.COMPLETE, target_a)
        return MigrationDisposition(
            MigrationDispositionStatus.REPAIRABLE,
            target_a,
            mutations=(MigrationMutation("CREATE_MAPPING", target_user_id=target_a.user_id),),
        )

    repair_calls = 0

    async def no_progress(*args: Any, **_kwargs: Any) -> None:
        nonlocal repair_calls
        repair_calls += 1
        state = cast(JsonDict, args[7])
        state.update(
            {
                "target_source": "third_party",
                "blocked_identity_type": "passwordless_email",
                "path": "identity_reconcile",
                "unresolved_mutation": "CREATE_MAPPING",
            }
        )
        if repair_calls == 1:
            raise MigrationError(MigrationErrorReason.CORE_CAPABILITY_REQUIRED, "mapping")

    async def session_method(_source: Any, target: PinnedMigrationTarget, *_args: Any):
        selected_session_targets.append(target.user_id)
        return SimpleNamespace(get_as_string=lambda: "source-b-recipe")

    async def no_op(*_args: Any, **_kwargs: Any) -> None:
        return None

    async def create_session(*_args: Any, **_kwargs: Any):
        return SimpleNamespace(
            get_user_id=lambda _context: "rownd-user",
            get_recipe_user_id=lambda _context: SimpleNamespace(
                get_as_string=lambda: "source-b-recipe"
            ),
            get_tenant_id=lambda _context: "public",
        )

    monkeypatch.setattr(implementation.repository, "read_fresh_migration_snapshot", read_snapshot)
    monkeypatch.setattr(implementation.repository, "classify_migration_snapshot", classify)
    monkeypatch.setattr(implementation.repository, "apply_migration_repairs", no_progress)
    monkeypatch.setattr(
        implementation.repository, "read_fresh_migration_session_method", session_method
    )
    monkeypatch.setattr(implementation.repository, "record_rownd_app_variant_for_user", no_op)
    monkeypatch.setattr(implementation.repository, "build_rownd_session_claims", lambda *_args: no_op())
    monkeypatch.setattr(implementation.repository.session_asyncio, "create_new_session", create_session)

    response, telemetry = await invoke_migration(
        monkeypatch,
        client=ChangingClient(),
        use_real_repository=True,
    )

    assert response.status_code == 200
    assert response.body == {"status": "OK"}
    assert selected_session_targets == ["source-b-owner"]
    event = telemetry.events[0]
    assert event["targetSource"] == "mapping"
    assert event["path"] == (
        "already_complete" if boundary == "complete" else "postcondition_recovery"
    )
    assert "blockedIdentityType" not in event
    assert "unresolvedMutation" not in event
    assert "source-a" not in json.dumps(event)


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
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO, logger="supertokens_rownd")
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
    assert len(caplog.records) == 1
    assert "outcome=cancelled stage=token_validate reason=none retryable=True" in caplog.text
    assert "499" not in caplog.records[0].getMessage().split(" outcome=", 1)[1]


@pytest.mark.asyncio
@pytest.mark.parametrize("delivery", ["capturing", "noop", "failing"])
@pytest.mark.parametrize("authorization", [None, "Bearer token"])
async def test_cancellation_during_response_construction_emits_one_cancelled_event(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    authorization: Optional[str],
    delivery: str,
) -> None:
    caplog.set_level(logging.INFO, logger="supertokens_rownd")
    calls: list[JsonDict] = []

    class Telemetry(CapturingTelemetry):
        async def record_event(self, event: JsonDict) -> None:
            calls.append(event)
            assert len(caplog.records) == 1
            if delivery == "failing":
                raise RuntimeError("private telemetry token")
            if delivery == "noop":
                await implementation.telemetry.NoopTelemetryClient().record_event(event)
            else:
                await super().record_event(event)

    telemetry_client = Telemetry()
    response = FakeResponse(cancel_json_count=1)

    with pytest.raises(asyncio.CancelledError):
        await invoke_migration(
            monkeypatch,
            telemetry_client=telemetry_client,
            response=response,
            authorization=authorization,
        )

    stage = "request_parse" if authorization is None else "session_create"
    assert response.status_code == (401 if authorization is None else 200)
    assert response.body is None
    assert len(calls) == 1
    assert calls[0]["outcome"] == "cancelled"
    assert calls[0]["stage"] == stage
    assert calls[0]["httpStatus"] == 499
    assert "reason" not in calls[0]
    assert telemetry_client.events == (calls if delivery == "capturing" else [])
    assert len(caplog.records) == 1
    assert caplog.records[0].levelno == logging.INFO
    assert f"operationId={calls[0]['operationId']}" in caplog.text
    assert f"outcome=cancelled stage={stage} reason=none retryable=True" in caplog.text
    assert "499" not in caplog.records[0].getMessage().split(" outcome=", 1)[1]
    assert "private telemetry token" not in caplog.text


@pytest.mark.asyncio
async def test_typed_repository_failure_keeps_its_stage(monkeypatch: pytest.MonkeyPatch) -> None:
    response, _ = await invoke_migration(
        monkeypatch,
        repository_error=MigrationError(MigrationErrorReason.MAPPING_CONFLICT, "mapping"),
    )

    assert response.status_code == 422
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

    assert response.status_code == 422
    assert len(telemetry.events) == 1
    event = telemetry.events[0]
    assert event["operation"] == "migration"
    assert event["outcome"] == "error"
    assert event["reason"] == "MAPPING_CONFLICT"
    assert event["stage"] == "mapping"
    assert event["httpStatus"] == 422
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
@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("CREATE_IDENTITY", "CREATE_IDENTITY"),
        ("https://private.example/user/secret", None),
        ("", None),
        (None, None),
    ],
)
async def test_terminal_unresolved_mutation_is_allowlisted(
    monkeypatch: pytest.MonkeyPatch, value: Optional[str], expected: Optional[str]
) -> None:
    migration_state: JsonDict = {}
    if value is not None:
        migration_state["unresolved_mutation"] = value
    response, telemetry = await invoke_migration(
        monkeypatch,
        repository_error=MigrationError(MigrationErrorReason.MIGRATION_INCOMPLETE, "state_inspect"),
        migration_state=migration_state,
    )

    assert response.status_code == 503
    event = telemetry.events[0]
    assert event.get("unresolvedMutation") == expected
    assert "private.example" not in json.dumps(event)


@pytest.mark.asyncio
async def test_success_never_emits_stale_unresolved_mutation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response, telemetry = await invoke_migration(
        monkeypatch,
        migration_state={"unresolved_mutation": "CREATE_MAPPING"},
    )

    assert response.status_code == 200
    assert "unresolvedMutation" not in telemetry.events[0]


@pytest.mark.asyncio
async def test_identity_conflict_context_is_internal_and_redacted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response, telemetry = await invoke_migration(
        monkeypatch,
        repository_error=MigrationError(
            MigrationErrorReason.IDENTITY_OWNED_BY_ANOTHER_USER, "account_link"
        ),
        migration_state={
            "blocked_identity_type": "passwordless_email",
            "target_source": "mapping",
        },
    )

    assert response.body is not None
    assert "blockedIdentityType" not in response.body
    assert "targetSource" not in response.body
    event = telemetry.events[0]
    assert event["blockedIdentityType"] == "passwordless_email"
    assert event["targetSource"] == "mapping"
    assert set(event) == {
        "operationId",
        "operation",
        "outcome",
        "stage",
        "httpStatus",
        "retryable",
        "attemptCount",
        "path",
        "forcedMappingUsed",
        "durationMs",
        "reason",
        "blockedIdentityType",
        "targetSource",
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "reason",
    [
        MigrationErrorReason.IDENTITY_AMBIGUOUS,
        MigrationErrorReason.IDENTITY_OWNED_BY_ANOTHER_USER,
        MigrationErrorReason.MAPPING_CONFLICT,
        MigrationErrorReason.PRIMARY_ACCOUNT_MERGE_REQUIRED,
    ],
)
async def test_blocked_topology_reason_is_stable_at_route_boundary(
    monkeypatch: pytest.MonkeyPatch, reason: MigrationErrorReason
) -> None:
    response, _ = await invoke_migration(
        monkeypatch,
        repository_error=MigrationError(reason, "state_inspect"),
    )

    assert response.status_code == 422
    assert response.body is not None
    assert response.body["reason"] == reason.value
    assert response.body["retryable"] is False


@pytest.mark.asyncio
async def test_mapping_conflict_does_not_reuse_prior_identity_context(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    snapshots: list[MigrationSnapshot] = []

    async def read_snapshot(source, *_args: Any) -> MigrationSnapshot:
        mapping = MappingLookup("rownd-user", "mapped-target")
        consistent = not snapshots
        result = MigrationSnapshot(
            source=source,
            owners=(),
            reservation_owners=(),
            mapping=MappingState(
                external_lookup=mapping,
                source_internal_lookup=None,
                internal_lookups=immutable_mapping(
                    {
                        "mapped-target": (
                            mapping
                            if consistent
                            else MappingLookup("rownd-user", "wrong-target")
                        )
                    }
                ),
                raw_id_inspection=RawIdInspection(RawIdStatus.UNINSPECTABLE),
            ),
            users=immutable_mapping({"mapped-target": MigrationUserState(True, True)}),
            metadata=immutable_mapping(
                {
                    "mapped-target": MigrationMetadataState(
                        True,
                        ValidatedMigrationMetadata(
                            legacy_complete=False,
                            original_rownd_user_id="rownd-user",
                        ),
                    )
                }
            ),
            metadata_source_user_ids=immutable_mapping({"mapped-target": "mapped-target"}),
            canonical_email_pointers=immutable_mapping(
                {
                    "mapped-target": CanonicalEmailPointerState(
                        CanonicalEmailPointerStatus.ABSENT
                    )
                }
            ),
        )
        snapshots.append(result)
        return result

    async def no_op_repair(*_args: Any, **_kwargs: Any) -> None:
        return None

    monkeypatch.setattr(implementation.repository, "read_fresh_migration_snapshot", read_snapshot)
    monkeypatch.setattr(implementation.repository, "apply_migration_repairs", no_op_repair)

    response, telemetry = await invoke_migration(
        monkeypatch, use_real_repository=True
    )

    assert response.status_code == 422
    assert response.body is not None
    assert response.body["reason"] == "MAPPING_CONFLICT"
    assert "targetSource" not in response.body
    event = telemetry.events[0]
    assert event["reason"] == "MAPPING_CONFLICT"
    assert event["targetSource"] == "mapping"
    assert "blockedIdentityType" not in event
    assert "rownd-user" not in json.dumps(event)
    assert "mapped-target" not in json.dumps(event)


@pytest.mark.asyncio
async def test_migration_telemetry_preserves_application_loop_affinity_and_returns_fast(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    application_loop = asyncio.get_running_loop()
    delivered = asyncio.Event()

    class LoopAffineTelemetry:
        async def record_event(self, event: JsonDict) -> None:
            assert asyncio.get_running_loop() is application_loop
            await asyncio.sleep(0.01)
            delivered.set()

    registry = implementation.telemetry._MigrationTelemetryTaskRegistry(capacity=2)
    monkeypatch.setattr(implementation.telemetry, "_migration_tasks", registry)
    started_at = time.monotonic()
    response, _ = await invoke_migration(
        monkeypatch,
        telemetry_client=cast(Any, LoopAffineTelemetry()),
    )
    elapsed = time.monotonic() - started_at

    assert response.status_code == 200
    assert elapsed < 0.1
    assert delivered.is_set()


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


@pytest.mark.parametrize("authorization", [None, "Bearer token"])
def test_terminal_delivery_finishes_before_request_scoped_loop_teardown(
    monkeypatch: pytest.MonkeyPatch, authorization: Optional[str]
) -> None:
    client = CapturingTelemetry()
    sequence: list[str] = []
    registry = implementation.telemetry._MigrationTelemetryTaskRegistry(capacity=1)
    monkeypatch.setattr(implementation.telemetry, "_migration_tasks", registry)

    class SuspendingTelemetry(CapturingTelemetry):
        async def record_event(self, event: JsonDict) -> None:
            await asyncio.sleep(0.01)
            await client.record_event(event)
            sequence.append("delivered")

    async def request() -> None:
        previous_count = len(client.events)
        response, _ = await invoke_migration(
            monkeypatch, authorization=authorization, telemetry_client=SuspendingTelemetry()
        )
        assert response.status_code == (401 if authorization is None else 200)
        assert len(client.events) == previous_count + 1
        sequence.append("request_return")

    for request_count in range(1, 3):
        asyncio.run(request())
        assert not registry._tasks
        assert len(client.events) == request_count
        assert sequence == ["delivered", "request_return"] * request_count


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["slow", "failing", "cancelled", "resistant"])
@pytest.mark.parametrize("authorization", [None, "Bearer token"])
async def test_terminal_client_failure_is_bounded_and_preserves_response(
    monkeypatch: pytest.MonkeyPatch, mode: str, authorization: Optional[str]
) -> None:
    release = asyncio.Event()
    finished = asyncio.Event()
    calls: list[JsonDict] = []
    loop_errors: list[dict[str, Any]] = []
    loop = asyncio.get_running_loop()
    previous_handler = loop.get_exception_handler()
    registry = implementation.telemetry._MigrationTelemetryTaskRegistry(capacity=1)
    monkeypatch.setattr(implementation.telemetry, "_migration_tasks", registry)

    class Telemetry(CapturingTelemetry):
        async def record_event(self, event: JsonDict) -> None:
            calls.append(event)
            try:
                await asyncio.sleep(0)
                if mode == "failing":
                    raise RuntimeError("private delivery failure")
                if mode == "cancelled":
                    raise asyncio.CancelledError()
                try:
                    await release.wait()
                except asyncio.CancelledError:
                    if mode != "resistant":
                        raise
                    await release.wait()
                    raise RuntimeError("late delivery failure")
            finally:
                finished.set()

    loop.set_exception_handler(lambda _loop, context: loop_errors.append(context))
    try:
        started_at = time.monotonic()
        response, _ = await invoke_migration(
            monkeypatch, authorization=authorization, telemetry_client=Telemetry()
        )
        assert time.monotonic() - started_at < 0.75
        assert response.status_code == (401 if authorization is None else 200)
        assert len(calls) == 1
        if mode == "resistant":
            # A timed-out client must retain its slot, not admit more hung work.
            await invoke_migration(monkeypatch, telemetry_client=Telemetry())
            assert len(calls) == 1
        release.set()
        await asyncio.wait_for(finished.wait(), 1)
        await asyncio.sleep(0)
        _, recovered = await invoke_migration(monkeypatch)
        assert len(recovered.events) == 1
        assert loop_errors == []
    finally:
        release.set()
        loop.set_exception_handler(previous_handler)


@pytest.mark.asyncio
async def test_external_cancellation_during_terminal_delivery_propagates_promptly(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    started = asyncio.Event()
    cancellation_received = asyncio.Event()
    release = asyncio.Event()
    finished = asyncio.Event()

    class Telemetry(CapturingTelemetry):
        async def record_event(self, event: JsonDict) -> None:
            started.set()
            try:
                await release.wait()
            except asyncio.CancelledError:
                cancellation_received.set()
                await release.wait()
            finally:
                finished.set()

    request = asyncio.create_task(invoke_migration(monkeypatch, telemetry_client=Telemetry()))
    try:
        await asyncio.wait_for(started.wait(), 1)
        request.cancel()
        done, _ = await asyncio.wait({request}, timeout=0.1)
        assert request in done
        with pytest.raises(asyncio.CancelledError):
            await request
        await asyncio.wait_for(cancellation_received.wait(), 1)
        assert not finished.is_set()
    finally:
        release.set()
        await asyncio.wait_for(finished.wait(), 1)


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

    response, _ = await invoke_migration(monkeypatch, telemetry_client=client)
    assert response.status_code == 200
    assert terminal_delivered.is_set()
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
        async def record(self, client: CapturingTelemetry, event: JsonDict) -> None:
            raise RuntimeError("registry failed")

    monkeypatch.setattr(implementation.telemetry, "_migration_tasks", FailingRegistry())
    response, _ = await invoke_migration(monkeypatch)

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

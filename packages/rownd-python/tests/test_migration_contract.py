from __future__ import annotations

import json
import uuid
from typing import Any, Optional, cast

import pytest
from supertokens_python import SupertokensConfig

import supertokens_rownd.plugin_implementation as implementation
from supertokens_rownd.errors import MigrationError, MigrationErrorReason
from supertokens_rownd.plugin_implementation import handle_migrate, migration_error_response
from supertokens_rownd.rownd_repository import (
    RowndTokenValidationError,
    RowndTokenValidationReason,
)
from supertokens_rownd.types import JsonDict, RowndPluginConfig
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


class FakeResponse:
    def __init__(self) -> None:
        self.status_code: Optional[int] = None
        self.body: Optional[JsonDict] = None

    def set_status_code(self, status_code: int) -> None:
        self.status_code = status_code

    def set_json_content(self, body: JsonDict) -> None:
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
        user_info: Optional[JsonDict] = None,
    ) -> None:
        self.validation_error = validation_error
        self.user_info: Optional[JsonDict] = (
            user_info
            if user_info is not None
            else {"data": {"user_id": "rownd-user"}, "verified_data": {}}
        )

    async def validate_token(self, token: str) -> str:
        if self.validation_error is not None:
            raise self.validation_error
        return "rownd-user"

    async def fetch_optional_user_info(self, user_id: str) -> Optional[JsonDict]:
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
) -> tuple[FakeResponse, CapturingTelemetry]:
    async def migrate(*args: Any, **kwargs: Any) -> str:
        if repository_error is not None:
            raise repository_error
        return "supertokens-user"

    monkeypatch.setattr(implementation.repository, "migrate_rownd_user_and_create_session", migrate)
    response = FakeResponse()
    telemetry = CapturingTelemetry()
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
async def test_success_body_remains_compatible(monkeypatch: pytest.MonkeyPatch) -> None:
    response, _ = await invoke_migration(monkeypatch)

    assert response.status_code == 200
    assert response.body == {"status": "OK"}


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

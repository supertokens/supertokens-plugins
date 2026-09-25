from dataclasses import dataclass
from enum import Enum
from typing import Dict, Literal, Optional

from .types import MigrationStage


class MigrationErrorReason(str, Enum):
    ROWND_USER_NOT_FOUND = "ROWND_USER_NOT_FOUND"
    PLUGIN_CONFIGURATION_INVALID = "PLUGIN_CONFIGURATION_INVALID"
    ROWND_USER_DISABLED = "ROWND_USER_DISABLED"
    TOKEN_MISSING = "TOKEN_MISSING"
    TOKEN_MALFORMED = "TOKEN_MALFORMED"
    TOKEN_EXPIRED = "TOKEN_EXPIRED"
    TOKEN_NOT_ACTIVE = "TOKEN_NOT_ACTIVE"
    TOKEN_CLAIMS_INVALID = "TOKEN_CLAIMS_INVALID"
    TOKEN_KID_UNKNOWN = "TOKEN_KID_UNKNOWN"
    TOKEN_SIGNATURE_INVALID = "TOKEN_SIGNATURE_INVALID"
    ROWND_USER_ID_MISMATCH = "ROWND_USER_ID_MISMATCH"
    SOURCE_IDENTITY_INVALID = "SOURCE_IDENTITY_INVALID"
    IDENTITY_AMBIGUOUS = "IDENTITY_AMBIGUOUS"
    IDENTITY_OWNED_BY_ANOTHER_USER = "IDENTITY_OWNED_BY_ANOTHER_USER"
    MAPPING_CONFLICT = "MAPPING_CONFLICT"
    RAW_USER_ID_COLLISION = "RAW_USER_ID_COLLISION"
    PRIMARY_ACCOUNT_MERGE_REQUIRED = "PRIMARY_ACCOUNT_MERGE_REQUIRED"
    MIGRATION_STATE_INVALID = "MIGRATION_STATE_INVALID"
    ROWND_UNAVAILABLE = "ROWND_UNAVAILABLE"
    CORE_UNAVAILABLE = "CORE_UNAVAILABLE"
    CORE_CAPABILITY_REQUIRED = "CORE_CAPABILITY_REQUIRED"
    MIGRATION_INCOMPLETE = "MIGRATION_INCOMPLETE"
    SESSION_CREATION_FAILED = "SESSION_CREATION_FAILED"
    INTERNAL_ERROR = "INTERNAL_ERROR"


@dataclass(frozen=True)
class MigrationErrorDetails:
    http_status: int
    retryable: bool
    message: str


MIGRATION_ERROR_DETAILS: Dict[MigrationErrorReason, MigrationErrorDetails] = {
    MigrationErrorReason.ROWND_USER_NOT_FOUND: MigrationErrorDetails(
        401, False, "User not found in Rownd"
    ),
    MigrationErrorReason.PLUGIN_CONFIGURATION_INVALID: MigrationErrorDetails(
        500, False, "The Rownd plugin configuration is invalid"
    ),
    MigrationErrorReason.ROWND_USER_DISABLED: MigrationErrorDetails(
        401, False, "The Rownd user is disabled"
    ),
    MigrationErrorReason.TOKEN_MISSING: MigrationErrorDetails(
        401, False, "Authorization token is required"
    ),
    MigrationErrorReason.TOKEN_MALFORMED: MigrationErrorDetails(
        401, False, "Authorization token is malformed"
    ),
    MigrationErrorReason.TOKEN_EXPIRED: MigrationErrorDetails(
        401, False, "Authorization token has expired"
    ),
    MigrationErrorReason.TOKEN_NOT_ACTIVE: MigrationErrorDetails(
        401, False, "Authorization token is not active"
    ),
    MigrationErrorReason.TOKEN_CLAIMS_INVALID: MigrationErrorDetails(
        401, False, "Authorization token claims are invalid"
    ),
    MigrationErrorReason.TOKEN_KID_UNKNOWN: MigrationErrorDetails(
        401, False, "Authorization token key is unknown"
    ),
    MigrationErrorReason.TOKEN_SIGNATURE_INVALID: MigrationErrorDetails(
        401, False, "Authorization token signature is invalid"
    ),
    MigrationErrorReason.ROWND_USER_ID_MISMATCH: MigrationErrorDetails(
        403, False, "The token does not belong to the Rownd user"
    ),
    MigrationErrorReason.SOURCE_IDENTITY_INVALID: MigrationErrorDetails(
        422, False, "The Rownd identity data is invalid"
    ),
    # Native clients interpret migration HTTP 409 as an existing session, not a failure.
    MigrationErrorReason.IDENTITY_AMBIGUOUS: MigrationErrorDetails(
        422, False, "The Rownd identity resolves to multiple users"
    ),
    MigrationErrorReason.IDENTITY_OWNED_BY_ANOTHER_USER: MigrationErrorDetails(
        422, False, "The Rownd identity belongs to another user"
    ),
    MigrationErrorReason.MAPPING_CONFLICT: MigrationErrorDetails(
        422, False, "The Rownd identity is linked to another user"
    ),
    MigrationErrorReason.RAW_USER_ID_COLLISION: MigrationErrorDetails(
        422, False, "The Rownd user ID conflicts with an existing user"
    ),
    MigrationErrorReason.PRIMARY_ACCOUNT_MERGE_REQUIRED: MigrationErrorDetails(
        422, False, "Migration requires merging primary accounts"
    ),
    MigrationErrorReason.MIGRATION_STATE_INVALID: MigrationErrorDetails(
        422, False, "The persisted migration state is invalid"
    ),
    MigrationErrorReason.ROWND_UNAVAILABLE: MigrationErrorDetails(
        503, True, "Rownd is temporarily unavailable"
    ),
    MigrationErrorReason.CORE_UNAVAILABLE: MigrationErrorDetails(
        503, True, "SuperTokens Core is temporarily unavailable"
    ),
    MigrationErrorReason.CORE_CAPABILITY_REQUIRED: MigrationErrorDetails(
        503, False, "SuperTokens Core does not support the required migration operation"
    ),
    MigrationErrorReason.MIGRATION_INCOMPLETE: MigrationErrorDetails(
        503, True, "Migration could not be completed"
    ),
    MigrationErrorReason.SESSION_CREATION_FAILED: MigrationErrorDetails(
        503, True, "Migration completed but session creation failed"
    ),
    MigrationErrorReason.INTERNAL_ERROR: MigrationErrorDetails(
        500, True, "Migration failed due to an internal error"
    ),
}


class MigrationError(Exception):
    reason: MigrationErrorReason
    http_status: int
    retryable: bool
    public_message: str
    stage: MigrationStage

    def __init__(
        self,
        reason: MigrationErrorReason,
        stage: MigrationStage,
        internal_cause: Optional[BaseException] = None,
    ):
        details = MIGRATION_ERROR_DETAILS[reason]
        super().__init__(details.message)
        self.reason = reason
        self.http_status = details.http_status
        self.retryable = details.retryable
        self.public_message = details.message
        self.stage = stage
        self._internal_cause = internal_cause

    @property
    def internal_cause(self) -> Optional[BaseException]:
        return self._internal_cause


class RowndPluginError(Exception):
    pass


class RowndEmailChangeError(Exception):
    def __init__(
        self,
        code: Literal["CONFLICT", "AMBIGUOUS", "INVALID_EMAIL", "EMAIL_CHANGE_DISABLED"],
        http_status: int,
        message: str,
    ):
        super().__init__(message)
        self.code = code
        self.http_status = http_status

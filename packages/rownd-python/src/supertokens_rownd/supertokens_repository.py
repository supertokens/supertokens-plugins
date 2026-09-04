from __future__ import annotations

import asyncio
import json
import uuid
from contextlib import suppress
from datetime import datetime, timezone
from typing import (
    Any,
    Awaitable,
    Callable,
    Dict,
    List,
    Literal,
    NamedTuple,
    NoReturn,
    Optional,
    Tuple,
    Union,
    cast,
)

import httpx
from supertokens_python import SupertokensConfig
from supertokens_python.asyncio import (
    create_user_id_mapping,
    delete_user,
    get_user,
    get_user_id_mapping,
    list_users_by_account_info,
)
from supertokens_python.framework.request import BaseRequest
from supertokens_python.framework.response import BaseResponse
from supertokens_python.recipe.accountlinking import asyncio as accountlinking_asyncio
from supertokens_python.recipe.accountlinking.interfaces import (
    CreatePrimaryUserOkResult,
    CreatePrimaryUserRecipeUserIdAlreadyLinkedError,
    LinkAccountsOkResult,
    LinkAccountsRecipeUserIdAlreadyLinkedError,
)
from supertokens_python.recipe.emailverification import (
    asyncio as emailverification_asyncio,
)
from supertokens_python.recipe.multitenancy import asyncio as multitenancy_asyncio
from supertokens_python.recipe.passwordless import asyncio as passwordless_asyncio
from supertokens_python.recipe.session import SessionContainer
from supertokens_python.recipe.session import asyncio as session_asyncio
from supertokens_python.recipe.thirdparty import asyncio as thirdparty_asyncio
from supertokens_python.recipe.thirdparty.interfaces import (
    ManuallyCreateOrUpdateUserOkResult,
)
from supertokens_python.recipe.thirdparty.types import ThirdPartyInfo
from supertokens_python.recipe.usermetadata import asyncio as usermetadata_asyncio
from supertokens_python.types import LoginMethod, RecipeUserId, User
from supertokens_python.types.base import AccountInfoInput, UserContext
from supertokens_python.interfaces import (
    CreateUserIdMappingOkResult,
    GetUserIdMappingOkResult,
    UserIdMappingAlreadyExistsError,
)

from .constants import (
    GUEST_AUTH_METHOD_ID,
    INSTANT_AUTH_METHOD_ID,
    PUBLIC_TENANT_ID,
    RESERVED_OAUTH_CLAIMS,
)
from .config import (
    as_json_dict,
    as_json_list,
    assert_app_variant_is_configured,
    get_active_rownd_config,
)
from .errors import (
    MigrationError,
    MigrationErrorReason,
    RowndEmailChangeError,
    RowndPluginError,
)
from .logger import log_debug
from . import rownd_compatibility
from .migration import (
    CanonicalEmailPointerState,
    CanonicalEmailPointerStatus,
    ExpectedIdentity,
    IdentityOwner,
    IdentityReservationOwner,
    MappingLookup,
    MappingState,
    MigrationDisposition,
    MigrationDispositionStatus,
    MigrationMutation,
    MigrationMetadataState,
    MigrationSnapshot,
    MigrationUserState,
    PinnedMigrationTarget,
    RawIdInspection,
    RawIdStatus,
    RowndIdentitySnapshot,
    ValidatedMigrationMetadata,
    classify_migration_snapshot,
    immutable_mapping,
    validate_migration_metadata,
)
from .types import (
    EmailCredentialAuthorization,
    EmailCredentialReason,
    EmailCredentialState,
    JsonDict,
    ParsedCommittingEmailVerification,
    ParsedPendingEmailVerification,
    RowndPluginConfig,
)
from .utils import (
    clear_supertokens_core_call_cache,
    create_derived_user_context,
    create_pending_email_verification_user_context,
    optional_string,
)


_LINKED_OPERATIONAL_METADATA_FIELDS = {
    "rownd_email_recipe_user_id",
    "rownd_email_recipe_user_ids",
    "rownd_migration_complete",
    "rownd_pending_verification",
}


class _BulkImportError(RuntimeError):
    status: int
    response_text: str

    def __init__(self, status: int, response_text: str):
        self.status = status
        self.response_text = response_text
        super().__init__("Bulk import failed with status %s: %s" % (status, response_text))


class FreshMigrationSource(NamedTuple):
    rownd_user: JsonDict
    snapshot: RowndIdentitySnapshot


class _MigrationSourceChanged(RuntimeError):
    source: FreshMigrationSource

    def __init__(self, source: FreshMigrationSource):
        self.source = source
        super().__init__("Rownd migration source changed before account linking")


class _MappingRetryState:
    narrow_retry_attempted: bool

    def __init__(self) -> None:
        self.narrow_retry_attempted = False


class _NonAuthRecipeUserIdReferenceError:
    status: Literal["NON_AUTH_RECIPE_USER_ID_REFERENCE_ERROR"] = (
        "NON_AUTH_RECIPE_USER_ID_REFERENCE_ERROR"
    )


_NarrowMappingCapability = Callable[[str, str, UserContext], Awaitable[object]]


_SESSION_RESPONSE_HEADERS = (
    "set-cookie",
    "front-token",
    "anti-csrf",
    "st-access-token",
    "st-refresh-token",
)
_SESSION_RESPONSE_COOKIES = (
    ("sAccessToken", "/"),
    ("sRefreshToken", "/auth/session/refresh"),
)


def scrub_migration_session_response(
    response: BaseResponse, request: Optional[BaseRequest] = None
) -> None:
    if request is not None:
        with suppress(Exception):
            request.set_session_as_none()
    for header in _SESSION_RESPONSE_HEADERS:
        with suppress(Exception):
            response.remove_header(header)
    for name, path in _SESSION_RESPONSE_COOKIES:
        with suppress(Exception):
            response.set_cookie(name, "", 0, path=path, httponly=True, samesite="lax")


def _mapping_lookup(result: object) -> Optional[MappingLookup]:
    if not isinstance(result, GetUserIdMappingOkResult):
        return None
    return MappingLookup(result.external_user_id, result.supertokens_user_id)


def _migration_method_matches_identity(method: LoginMethod, identity: ExpectedIdentity) -> bool:
    if method.recipe_id != identity.recipe_id:
        return False
    if identity.recipe_id == "thirdparty":
        provider_id, provider_user_id = rownd_compatibility.get_third_party_info(method)
        return provider_id == identity.provider_id and provider_user_id == identity.provider_user_id
    if identity.identifier_type == "email":
        return method.has_same_email_as(identity.identifier)
    return method.has_same_phone_number_as(identity.identifier)


def _migration_method_reserves_identity(method: LoginMethod, identity: ExpectedIdentity) -> bool:
    if identity.recipe_id != "passwordless" or method.recipe_id not in {
        "thirdparty",
        "emailpassword",
    }:
        return False
    if identity.identifier_type == "email":
        return method.has_same_email_as(identity.identifier)
    return method.has_same_phone_number_as(identity.identifier)


async def _get_migration_identity_users(
    identity: ExpectedIdentity, tenant_id: str, user_context: UserContext
) -> List[User]:
    if identity.recipe_id == "thirdparty":
        account_info = AccountInfoInput(
            third_party=ThirdPartyInfo(
                cast(str, identity.provider_user_id), cast(str, identity.provider_id)
            )
        )
    elif identity.identifier_type == "email":
        account_info = AccountInfoInput(email=identity.identifier)
    else:
        account_info = AccountInfoInput(phone_number=identity.identifier)
    return await list_users_by_account_info(tenant_id, account_info, False, user_context)


async def read_fresh_migration_snapshot(
    source: RowndIdentitySnapshot,
    user_context: UserContext,
    pinned_target: Optional[PinnedMigrationTarget] = None,
) -> MigrationSnapshot:
    inspection_context = create_derived_user_context(user_context, {})
    clear_supertokens_core_call_cache(inspection_context)
    external_result, source_internal_result = await asyncio.gather(
        get_user_id_mapping(source.rownd_user_id, "EXTERNAL", inspection_context),
        get_user_id_mapping(source.rownd_user_id, "SUPERTOKENS", inspection_context),
    )
    external_lookup = _mapping_lookup(external_result)
    source_internal_lookup = _mapping_lookup(source_internal_result)
    raw_user = (
        None
        if external_lookup is not None or source_internal_lookup is not None
        else await get_user(source.rownd_user_id, inspection_context)
    )
    identity_users = await asyncio.gather(
        *(
            _get_migration_identity_users(identity, source.tenant_id, inspection_context)
            for identity in source.expected_identities
        )
    )
    owner_entries = [
        (identity, user, method)
        for identity, users in zip(source.expected_identities, identity_users)
        for user in users
        for method in user.login_methods
        if _migration_method_matches_identity(method, identity)
    ]
    reservation_entries = [
        (identity, user, method)
        for identity, users in zip(source.expected_identities, identity_users)
        for user in users
        for method in user.login_methods
        if source.tenant_id in method.tenant_ids
        and _migration_method_reserves_identity(method, identity)
    ]

    async def resolved_owner(
        entry: Tuple[ExpectedIdentity, User, LoginMethod],
    ) -> IdentityOwner:
        identity, user, method = entry
        internal_user_id = await resolve_supertokens_user_id(user.id, inspection_context)
        resolved_user = (
            user
            if internal_user_id == user.id
            else await get_user(internal_user_id, inspection_context)
        )
        recipe_user_id = method.recipe_user_id.get_as_string()
        resolved_method = next(
            (
                candidate
                for candidate in (resolved_user.login_methods if resolved_user else [])
                if candidate.recipe_user_id.get_as_string() == recipe_user_id
                and _migration_method_matches_identity(candidate, identity)
            ),
            None,
        )
        if resolved_user is None or resolved_method is None:
            raise MigrationError(MigrationErrorReason.MIGRATION_STATE_INVALID, "state_inspect")
        identifier = (
            "%s:%s" % (identity.provider_id, identity.provider_user_id)
            if identity.recipe_id == "thirdparty"
            else cast(str, identity.identifier)
        )
        return IdentityOwner(
            identity.key,
            recipe_user_id,
            internal_user_id,
            identity.recipe_id,
            identifier,
            resolved_method.verified,
            tuple(sorted(resolved_method.tenant_ids)),
            resolved_user.is_primary_user,
        )

    async def resolved_reservation(
        entry: Tuple[ExpectedIdentity, User, LoginMethod],
    ) -> IdentityReservationOwner:
        identity, user, method = entry
        internal_user_id = await resolve_supertokens_user_id(user.id, inspection_context)
        resolved_user = (
            user
            if internal_user_id == user.id
            else await get_user(internal_user_id, inspection_context)
        )
        recipe_user_id = method.recipe_user_id.get_as_string()
        resolved_method = next(
            (
                candidate
                for candidate in (resolved_user.login_methods if resolved_user else [])
                if candidate.recipe_user_id.get_as_string() == recipe_user_id
                and _migration_method_reserves_identity(candidate, identity)
            ),
            None,
        )
        if resolved_user is None or resolved_method is None:
            raise MigrationError(MigrationErrorReason.MIGRATION_STATE_INVALID, "state_inspect")
        return IdentityReservationOwner(
            identity.key,
            recipe_user_id,
            internal_user_id,
            resolved_method.recipe_id,
            resolved_user.is_primary_user,
        )

    scoped_owners = await asyncio.gather(*(resolved_owner(entry) for entry in owner_entries))
    scoped_reservations = await asyncio.gather(
        *(resolved_reservation(entry) for entry in reservation_entries)
    )
    candidate_ids = {
        *([external_lookup.supertokens_user_id] if external_lookup else []),
        *([raw_user.id] if raw_user else []),
        *([pinned_target.user_id] if pinned_target else []),
        *(owner.primary_user_id for owner in scoped_owners),
        *(owner.primary_user_id for owner in scoped_reservations),
    }

    async def inspect_candidate(user_id: str):
        user = (
            raw_user
            if raw_user and raw_user.id == user_id
            else await get_user(user_id, inspection_context)
        )
        mapping_result = (
            source_internal_result
            if user_id == source.rownd_user_id
            else await get_user_id_mapping(user_id, "SUPERTOKENS", inspection_context)
        )
        metadata_inspection = (
            await inspect_linked_user_metadata(user_id, inspection_context, user) if user else None
        )
        metadata_source_user_id = cast(
            str,
            metadata_inspection.get("rownd_metadata_source_user_id")
            if metadata_inspection
            else user_id,
        ) or user_id
        target_metadata = validate_migration_metadata(
            await get_raw_user_metadata(user_id, inspection_context) if user else {},
            source.tenant_id,
        )
        source_metadata = (
            target_metadata
            if metadata_source_user_id == user_id
            else validate_migration_metadata(
                await get_raw_user_metadata(metadata_source_user_id, inspection_context),
                source.tenant_id,
            )
        )
        metadata_state = MigrationMetadataState(
            target_metadata.valid and source_metadata.valid,
            (
                ValidatedMigrationMetadata(
                    legacy_complete=target_metadata.value.legacy_complete,
                    canonical_email_recipe_user_id=(
                        target_metadata.value.canonical_email_recipe_user_id
                    ),
                    original_rownd_user_id=source_metadata.value.original_rownd_user_id,
                )
                if target_metadata.value is not None and source_metadata.value is not None
                else None
            ),
        )
        return (
            user_id,
            user,
            _mapping_lookup(mapping_result),
            metadata_state,
            metadata_source_user_id,
        )

    candidates = await asyncio.gather(
        *(inspect_candidate(user_id) for user_id in sorted(candidate_ids))
    )
    candidate_owner_entries = [
        (identity, user, method)
        for _, user, _, _, _ in candidates
        if user is not None
        for identity in source.expected_identities
        for method in user.login_methods
        if _migration_method_matches_identity(method, identity)
    ]
    candidate_reservation_entries = [
        (identity, user, method)
        for _, user, _, _, _ in candidates
        if user is not None
        for identity in source.expected_identities
        for method in user.login_methods
        if _migration_method_reserves_identity(method, identity)
    ]
    candidate_owners = await asyncio.gather(
        *(resolved_owner(entry) for entry in candidate_owner_entries)
    )
    candidate_reservations = await asyncio.gather(
        *(resolved_reservation(entry) for entry in candidate_reservation_entries)
    )
    owners_by_method: Dict[Tuple[str, str], IdentityOwner] = {}
    for owner in (*scoped_owners, *candidate_owners):
        key = (owner.identity_key, owner.recipe_user_id)
        if key in owners_by_method and owners_by_method[key] != owner:
            raise MigrationError(MigrationErrorReason.MIGRATION_STATE_INVALID, "state_inspect")
        owners_by_method[key] = owner
    reservations_by_method: Dict[Tuple[str, str], IdentityReservationOwner] = {}
    for owner in (*scoped_reservations, *candidate_reservations):
        key = (owner.identity_key, owner.recipe_user_id)
        if key in reservations_by_method and reservations_by_method[key] != owner:
            raise MigrationError(MigrationErrorReason.MIGRATION_STATE_INVALID, "state_inspect")
        reservations_by_method[key] = owner
    owners = tuple(owners_by_method.values())
    reservations = tuple(reservations_by_method.values())
    internal_lookups = {user_id: mapping for user_id, _, mapping, _, _ in candidates}
    users = {
        user_id: MigrationUserState(user is not None, user.is_primary_user if user else False)
        for user_id, user, _, _, _ in candidates
    }
    metadata: Dict[str, MigrationMetadataState] = {
        user_id: state for user_id, _, _, state, _ in candidates
    }
    metadata_source_user_ids = {
        user_id: metadata_source_user_id
        for user_id, _, _, _, metadata_source_user_id in candidates
    }
    raw_metadata = metadata.get(raw_user.id) if raw_user else None
    raw_same_graph = bool(
        raw_user
        and (
            any(owner.primary_user_id == raw_user.id for owner in owners)
            or (
                raw_metadata
                and raw_metadata.valid
                and raw_metadata.value
                and raw_metadata.value.legacy_complete is True
                and raw_metadata.value.original_rownd_user_id == source.rownd_user_id
            )
        )
    )

    async def inspect_pointer(
        candidate: Tuple[
            str,
            Optional[User],
            Optional[MappingLookup],
            MigrationMetadataState,
            str,
        ],
    ) -> Tuple[str, CanonicalEmailPointerState]:
        user_id, user, _, metadata_state, _ = candidate
        recipe_user_id = (
            metadata_state.value.canonical_email_recipe_user_id
            if metadata_state.valid and metadata_state.value
            else None
        )
        if not recipe_user_id:
            return user_id, CanonicalEmailPointerState(CanonicalEmailPointerStatus.ABSENT)
        method = next(
            (
                item
                for item in (user.login_methods if user else [])
                if item.recipe_user_id.get_as_string() == recipe_user_id
            ),
            None,
        )
        belongs_to_candidate = method is not None
        method_owner = user
        if method is None:
            method_owner = await get_user(recipe_user_id, inspection_context)
            method = next(
                (
                    item
                    for item in (method_owner.login_methods if method_owner else [])
                    if item.recipe_user_id.get_as_string() == recipe_user_id
                ),
                None,
            )
        reason = None
        if method_owner is None or method is None:
            reason = "MISSING_METHOD"
        elif not belongs_to_candidate:
            reason = "FOREIGN_OWNER"
        elif method.recipe_id != "passwordless" or not method.email:
            reason = "NOT_PASSWORDLESS"
        elif not method.verified:
            reason = "NOT_VERIFIED"
        elif source.tenant_id not in method.tenant_ids:
            reason = "WRONG_TENANT"
        return (
            user_id,
            CanonicalEmailPointerState(
                CanonicalEmailPointerStatus.INVALID
                if reason
                else CanonicalEmailPointerStatus.VALID,
                recipe_user_id,
                reason,
            ),
        )

    pointer_entries = await asyncio.gather(
        *(inspect_pointer(candidate) for candidate in candidates)
    )
    if source_internal_lookup and (
        external_lookup is None or external_lookup.supertokens_user_id != source.rownd_user_id
    ):
        raw_inspection = RawIdInspection(RawIdStatus.PRESENT, source.rownd_user_id, False)
    elif external_lookup:
        raw_inspection = RawIdInspection(RawIdStatus.UNINSPECTABLE)
    elif raw_user:
        raw_inspection = RawIdInspection(RawIdStatus.PRESENT, raw_user.id, raw_same_graph)
    else:
        raw_inspection = RawIdInspection(RawIdStatus.ABSENT)
    return MigrationSnapshot(
        source,
        tuple(sorted(owners, key=lambda owner: (owner.identity_key, owner.recipe_user_id))),
        tuple(
            sorted(
                reservations,
                key=lambda owner: (owner.identity_key, owner.recipe_user_id),
            )
        ),
        MappingState(
            external_lookup,
            source_internal_lookup,
            immutable_mapping(internal_lookups),
            raw_inspection,
        ),
        immutable_mapping(users),
        immutable_mapping(metadata),
        immutable_mapping(metadata_source_user_ids),
        immutable_mapping(dict(pointer_entries)),
    )


def is_bulk_import_duplicate_identity_error(error: object) -> bool:
    if not isinstance(error, _BulkImportError) or error.status != 400:
        return False
    try:
        body = json.loads(error.response_text)
    except (TypeError, ValueError):
        return False
    if not isinstance(body, dict):
        return False
    errors = body.get("errors")
    return (
        isinstance(errors, list)
        and bool(errors)
        and all(isinstance(entry, str) and entry.startswith("E006:") for entry in errors)
    )


async def _import_user_with_e006_recovery(
    user_import: JsonDict,
    tenant_id: str,
    supertokens_config: SupertokensConfig,
    user_context: UserContext,
) -> None:
    try:
        await import_user(user_import, supertokens_config, user_context)
    except Exception as import_error:
        if not is_bulk_import_duplicate_identity_error(import_error):
            raise
        try:
            # Match Node by rerunning full reconciliation, including authoritative-passwordless checks.
            recovered = await reconcile_rownd_user_with_existing_login_methods(
                user_import,
                tenant_id,
                user_context,
            )
        except Exception as reconciliation_error:
            raise reconciliation_error from import_error
        if not recovered:
            raise


async def create_guest_session(
    config: RowndPluginConfig,
    request: BaseRequest,
    tenant_id: str,
    third_party_id: str,
    third_party_user_id: str,
    effective_auth_level: str,
    app_variant_id: Optional[str],
    user_context: UserContext,
) -> ManuallyCreateOrUpdateUserOkResult:
    result = await thirdparty_asyncio.manually_create_or_update_user(
        tenant_id=tenant_id,
        third_party_id=third_party_id,
        third_party_user_id=third_party_user_id,
        email="%s@anonymous.local" % third_party_user_id,
        is_verified=False,
        user_context=user_context,
    )
    if not isinstance(result, ManuallyCreateOrUpdateUserOkResult):
        raise RowndPluginError("Guest user creation failed")
    payload = {
        **rownd_compatibility.build_rownd_audience({}, config, app_variant_id),
        "auth_level": effective_auth_level,
        "is_anonymous": True,
        "app_user_id": result.user.id,
    }
    operation_context = create_derived_user_context(
        user_context, {"rowndAppVariantId": app_variant_id}
    )
    await record_rownd_app_variant_for_user(config, result.user.id, app_variant_id, operation_context)
    await session_asyncio.create_new_session(
        request,
        tenant_id,
        result.recipe_user_id,
        payload,
        {},
        operation_context,
    )
    return result


async def migrate_rownd_user_and_create_session(
    config: RowndPluginConfig,
    rownd_user_id: str,
    source: FreshMigrationSource,
    supertokens_config: SupertokensConfig,
    request: BaseRequest,
    response: BaseResponse,
    tenant_id: str,
    app_variant_id: Optional[str],
    user_context: UserContext,
    migration_state: JsonDict,
    read_fresh_source: Callable[[], Awaitable[Optional[FreshMigrationSource]]],
) -> str:
    if source.snapshot.rownd_user_id != rownd_user_id:
        raise MigrationError(MigrationErrorReason.ROWND_USER_ID_MISMATCH, "source_normalize")
    pinned_target: Optional[PinnedMigrationTarget] = None
    completed_target: Optional[PinnedMigrationTarget] = None
    last_error: Optional[BaseException] = None
    capability_error: Optional[MigrationError] = None
    mapping_retry_state = _MappingRetryState()

    for _ in range(2):
        try:
            durable = await read_fresh_migration_snapshot(
                source.snapshot, user_context, pinned_target
            )
        except Exception as error:
            last_error = error
            clear_supertokens_core_call_cache(user_context)
            continue
        disposition = classify_migration_snapshot(durable, pinned_target)
        if disposition.status is MigrationDispositionStatus.COMPLETE:
            fresh_source = await read_fresh_source()
            if fresh_source is None:
                raise MigrationError(MigrationErrorReason.MIGRATION_INCOMPLETE, "state_inspect")
            if fresh_source.snapshot != source.snapshot:
                source = fresh_source
                continue
            completed_target = disposition.target
            break
        if disposition.status is MigrationDispositionStatus.BLOCKED:
            raise MigrationError(
                disposition.reason or MigrationErrorReason.MIGRATION_STATE_INVALID,
                "state_inspect",
            )
        repair_target = pinned_target
        if repair_target is None and disposition.target is not None:
            pinned_target = disposition.target
            repair_target = disposition.target
        try:
            changed_source = await apply_migration_repairs(
                disposition,
                source,
                repair_target,
                supertokens_config,
                user_context,
                read_fresh_source,
                mapping_retry_state,
            )
            if changed_source is not None:
                source = changed_source
        except Exception as error:
            last_error = error
            if (
                isinstance(error, MigrationError)
                and error.reason is MigrationErrorReason.CORE_CAPABILITY_REQUIRED
            ):
                capability_error = error
            clear_supertokens_core_call_cache(user_context)

    if completed_target is None:
        final_source = await read_fresh_source()
        if final_source is None:
            raise MigrationError(MigrationErrorReason.MIGRATION_INCOMPLETE, "state_inspect")
        source = final_source
        try:
            final_snapshot = await read_fresh_migration_snapshot(
                source.snapshot, user_context, pinned_target
            )
            final_disposition = classify_migration_snapshot(final_snapshot, pinned_target)
        except Exception as error:
            reason = (
                MigrationErrorReason.CORE_UNAVAILABLE
                if _is_recognizable_core_outage(error) or _is_recognizable_core_outage(last_error)
                else MigrationErrorReason.MIGRATION_INCOMPLETE
            )
            raise MigrationError(reason, "state_inspect", error) from error
        if final_disposition.status is MigrationDispositionStatus.COMPLETE:
            completed_target = final_disposition.target
        elif final_disposition.status is MigrationDispositionStatus.BLOCKED:
            raise MigrationError(
                final_disposition.reason or MigrationErrorReason.MIGRATION_STATE_INVALID,
                "state_inspect",
                last_error,
            )
        else:
            capability_required = (
                capability_error is not None
                and final_disposition.status is MigrationDispositionStatus.REPAIRABLE
                and any(
                    mutation.type == "CREATE_MAPPING"
                    for mutation in final_disposition.mutations
                )
            )
            if capability_required:
                raise cast(MigrationError, capability_error)
            reason = (
                MigrationErrorReason.CORE_UNAVAILABLE
                if _is_recognizable_core_outage(last_error)
                else MigrationErrorReason.MIGRATION_INCOMPLETE
            )
            raise MigrationError(reason, "state_inspect", last_error)
    if completed_target is None:
        raise MigrationError(MigrationErrorReason.MIGRATION_INCOMPLETE, "state_inspect")

    supertokens_user_id = completed_target.user_id
    migration_state["supertokens_user_id"] = supertokens_user_id
    await record_rownd_app_variant_for_user(
        config, supertokens_user_id, app_variant_id, user_context
    )

    session_source = await read_fresh_source()
    if session_source is None or session_source.snapshot != source.snapshot:
        raise MigrationError(MigrationErrorReason.MIGRATION_INCOMPLETE, "state_inspect")
    final_snapshot = await read_fresh_migration_snapshot(
        session_source.snapshot, user_context, completed_target
    )
    final_disposition = classify_migration_snapshot(final_snapshot, completed_target)
    if final_disposition.status is MigrationDispositionStatus.BLOCKED:
        raise MigrationError(
            final_disposition.reason or MigrationErrorReason.MIGRATION_STATE_INVALID,
            "state_inspect",
        )
    if final_disposition.status is not MigrationDispositionStatus.COMPLETE:
        raise MigrationError(MigrationErrorReason.MIGRATION_INCOMPLETE, "state_inspect")
    recipe_user_id = await read_fresh_migration_session_method(
        session_source.snapshot, completed_target, user_context
    )
    immediately_fresh_source = await read_fresh_source()
    if (
        immediately_fresh_source is None
        or immediately_fresh_source.snapshot != session_source.snapshot
    ):
        raise MigrationError(MigrationErrorReason.MIGRATION_INCOMPLETE, "state_inspect")
    try:
        session = await session_asyncio.create_new_session(
            request,
            tenant_id,
            recipe_user_id,
            await build_rownd_session_claims(
                config, supertokens_user_id, {}, app_variant_id, user_context
            ),
            {},
            create_derived_user_context(user_context, {"rowndAppVariantId": app_variant_id}),
        )
    except MigrationError:
        scrub_migration_session_response(response, request)
        raise
    except Exception as err:
        scrub_migration_session_response(response, request)
        raise MigrationError(
            MigrationErrorReason.SESSION_CREATION_FAILED, "session_create", err
        ) from err
    binding_error: Optional[BaseException] = None
    try:
        binding_matches = (
            session.get_user_id(user_context) == immediately_fresh_source.snapshot.rownd_user_id
            and session.get_recipe_user_id(user_context).get_as_string()
            == recipe_user_id.get_as_string()
            and session.get_tenant_id(user_context) == tenant_id
        )
    except Exception as error:
        binding_error = error
        binding_matches = False
    if not binding_matches:
        with suppress(Exception):
            await session.revoke_session(user_context)
        scrub_migration_session_response(response, request)
        raise MigrationError(
            MigrationErrorReason.SESSION_CREATION_FAILED, "session_create", binding_error
        )
    return supertokens_user_id


def _is_recognizable_core_outage(error: Optional[BaseException]) -> bool:
    if error is None:
        return False
    if isinstance(error, httpx.HTTPStatusError):
        return error.response.status_code >= 500
    if isinstance(error, (httpx.RequestError, ConnectionError, TimeoutError)):
        return True
    for field in ("status", "status_code", "statusCode"):
        value = getattr(error, field, None)
        if isinstance(value, int) and not isinstance(value, bool) and value >= 500:
            return True
    cause = error.__cause__ or error.__context__
    return _is_recognizable_core_outage(cause)


async def associate_user_login_methods_to_tenant(
    user: User, tenant_id: str, user_context: UserContext
) -> None:
    for login_method in user.login_methods:
        if tenant_id in login_method.tenant_ids:
            continue
        association = await multitenancy_asyncio.associate_user_to_tenant(
            tenant_id, login_method.recipe_user_id, user_context
        )
        if getattr(association, "status", None) != "OK":
            raise RuntimeError(
                "Failed to associate migrated user with tenant: %s"
                % getattr(association, "status", "ERROR")
            )


async def revoke_all_user_sessions(session: SessionContainer, user_context: UserContext) -> None:
    await session_asyncio.revoke_all_sessions_for_user(
        session.get_user_id(user_context),
        revoke_sessions_for_linked_accounts=True,
        tenant_id=session.get_tenant_id(user_context),
        user_context=user_context,
    )


async def delete_user_and_linked_accounts(user_id: str, user_context: UserContext) -> None:
    await delete_user(user_id, remove_all_linked_accounts=True, user_context=user_context)


async def get_raw_user_metadata(
    user_id: str, user_context: Optional[UserContext] = None
) -> JsonDict:
    result = await usermetadata_asyncio.get_user_metadata(user_id, user_context)
    return result.metadata or {}


def get_original_rownd_user_id(metadata: JsonDict) -> Optional[str]:
    user_id = as_json_dict(as_json_dict(metadata.get("original_rownd_user")).get("data")).get(
        "user_id"
    )
    return user_id if isinstance(user_id, str) else None


def merge_missing_values(primary: JsonDict, secondary: JsonDict) -> JsonDict:
    merged = {**primary}
    for key, secondary_value in secondary.items():
        if key not in merged:
            merged[key] = secondary_value
        elif isinstance(merged[key], dict) and isinstance(secondary_value, dict):
            merged[key] = merge_missing_values(
                cast(JsonDict, merged[key]), cast(JsonDict, secondary_value)
            )
    return merged


def combine_linked_metadata(
    primary_user_id: str,
    primary_metadata: JsonDict,
    linked_metadata: List[Tuple[str, JsonDict]],
    mapped_rownd_user_id: Optional[str] = None,
) -> JsonDict:
    ordered = sorted(
        linked_metadata,
        key=lambda item: (
            not (
                mapped_rownd_user_id is not None
                and get_original_rownd_user_id(item[1]) == mapped_rownd_user_id
            ),
            item[0],
        ),
    )
    primary_rownd_user_id = get_original_rownd_user_id(primary_metadata)
    canonical_linked_metadata = (
        next(
            (
                item
                for item in ordered
                if get_original_rownd_user_id(item[1]) == mapped_rownd_user_id
            ),
            None,
        )
        if mapped_rownd_user_id is not None
        else None
    )
    canonical_replaces_primary = (
        canonical_linked_metadata is not None and primary_rownd_user_id != mapped_rownd_user_id
    )
    metadata_update: JsonDict = (
        {"original_rownd_user": canonical_linked_metadata[1]["original_rownd_user"]}
        if canonical_replaces_primary and canonical_linked_metadata is not None
        else {}
    )
    for _, metadata in ordered:
        for key, value in metadata.items():
            if key in _LINKED_OPERATIONAL_METADATA_FIELDS:
                continue
            if (
                key == "original_rownd_user"
                and mapped_rownd_user_id is not None
                and (
                    primary_rownd_user_id == mapped_rownd_user_id
                    or canonical_linked_metadata is not None
                )
                and get_original_rownd_user_id(metadata) != mapped_rownd_user_id
            ):
                continue
            current = metadata_update[key] if key in metadata_update else primary_metadata.get(key)
            if key not in metadata_update and key not in primary_metadata:
                metadata_update[key] = value
            elif isinstance(current, dict) and isinstance(value, dict):
                merged = merge_missing_values(cast(JsonDict, current), cast(JsonDict, value))
                if merged != current:
                    metadata_update[key] = merged

    primary_is_source = primary_rownd_user_id is not None and (
        mapped_rownd_user_id is None
        or primary_rownd_user_id == mapped_rownd_user_id
        or canonical_linked_metadata is None
    )
    source_user_id = (
        primary_user_id
        if primary_is_source
        else (
            canonical_linked_metadata[0]
            if canonical_linked_metadata is not None
            else next(
                (
                    linked_user_id
                    for linked_user_id, metadata in ordered
                    if get_original_rownd_user_id(metadata) is not None
                ),
                None,
            )
        )
    )
    return {
        "primary_user_id": primary_user_id,
        "linked_user_ids": [linked_user_id for linked_user_id, _ in ordered],
        "primary_metadata": primary_metadata,
        "combined_metadata": {**primary_metadata, **metadata_update},
        "metadata_update": metadata_update,
        "rownd_metadata_source_user_id": source_user_id,
    }


async def get_primary_user_mapping(
    user_id: str, user_context: Optional[UserContext] = None
) -> Optional[GetUserIdMappingOkResult]:
    context = user_context if user_context is not None else {}
    internal = await get_user_id_mapping(user_id, "SUPERTOKENS", context)
    if isinstance(internal, GetUserIdMappingOkResult):
        return internal
    external = await get_user_id_mapping(user_id, "EXTERNAL", context)
    return external if isinstance(external, GetUserIdMappingOkResult) else None


async def inspect_linked_user_metadata(
    user_id: str,
    user_context: Optional[UserContext] = None,
    user_override: Optional[User] = None,
) -> Dict[str, Any]:
    user = user_override if user_override is not None else await get_user(user_id, user_context)
    if user is None:
        metadata = await get_raw_user_metadata(user_id, user_context)
        return {**combine_linked_metadata(user_id, metadata, []), "user": None}

    mapping = await get_primary_user_mapping(user.id, user_context)
    primary_user_id = mapping.supertokens_user_id if mapping else user.id
    linked_user_ids = sorted(
        {
            method.recipe_user_id.get_as_string()
            for method in user.login_methods
            if method.recipe_user_id.get_as_string() != primary_user_id
        }
    )
    metadata_results = await asyncio.gather(
        get_raw_user_metadata(primary_user_id, user_context),
        *(
            get_raw_user_metadata(linked_user_id, user_context)
            for linked_user_id in linked_user_ids
        ),
    )
    return {
        **combine_linked_metadata(
            primary_user_id,
            metadata_results[0],
            list(zip(linked_user_ids, metadata_results[1:])),
            mapping.external_user_id if mapping else None,
        ),
        "user": user,
    }


async def get_user_metadata(user_id: str, user_context: Optional[UserContext] = None) -> JsonDict:
    inspection = await inspect_linked_user_metadata(user_id, user_context)
    return cast(JsonDict, inspection["combined_metadata"])


async def update_primary_user_metadata(
    user_id: str,
    metadata_update: JsonDict,
    user_context: Optional[UserContext] = None,
) -> Tuple[str, JsonDict]:
    user = await get_user(user_id, user_context)
    mapping = await get_primary_user_mapping(user.id, user_context) if user else None
    primary_user_id = mapping.supertokens_user_id if mapping else user.id if user else user_id
    result = await usermetadata_asyncio.update_user_metadata(
        primary_user_id, metadata_update, user_context
    )
    return primary_user_id, result.metadata or {}


async def replace_primary_user_metadata(
    user_id: str,
    metadata: JsonDict,
    user_context: Optional[UserContext] = None,
) -> None:
    mapping = await get_primary_user_mapping(user_id, user_context)
    primary_user_id = mapping.supertokens_user_id if mapping else user_id
    await usermetadata_asyncio.clear_user_metadata(primary_user_id, user_context)
    if metadata:
        await usermetadata_asyncio.update_user_metadata(primary_user_id, metadata, user_context)


async def update_user_metadata(
    user_id: str, input_meta: JsonDict, user_context: Optional[UserContext] = None
) -> JsonDict:
    primary_user_id, updated = await update_primary_user_metadata(user_id, input_meta, user_context)
    return {"id": primary_user_id, "meta": rownd_compatibility.public_metadata(updated)}


async def update_user_data(
    config: RowndPluginConfig,
    user_id: str,
    input_data: JsonDict,
    tenant_id: str = PUBLIC_TENANT_ID,
    user_context: Optional[UserContext] = None,
) -> JsonDict:
    primary_user_id, _ = await update_primary_user_metadata(user_id, input_data, user_context)
    return await get_rownd_compat_user(
        primary_user_id, config, tenant_id, user_context=user_context
    )


async def get_rownd_compat_user(
    user_id: str,
    config: Optional[RowndPluginConfig] = None,
    tenant_id: str = PUBLIC_TENANT_ID,
    metadata_override: Optional[JsonDict] = None,
    user_override: Optional[User] = None,
    user_context: Optional[UserContext] = None,
) -> JsonDict:
    inspection = (
        None
        if metadata_override is not None and user_override is not None
        else await inspect_linked_user_metadata(user_id, user_context, user_override)
    )
    metadata = (
        metadata_override
        if metadata_override is not None
        else cast(JsonDict, cast(JsonDict, inspection)["combined_metadata"])
    )
    st_user = (
        user_override
        if user_override is not None
        else cast(Optional[User], cast(JsonDict, inspection)["user"])
    )
    if st_user is None:
        raise RowndPluginError("User not found in Rownd")

    latest_session_info = await get_latest_session_info(st_user.id, tenant_id, user_context)
    return rownd_compatibility.project_rownd_compat_user(
        user_id, st_user, metadata, config, tenant_id, latest_session_info
    )


async def get_latest_session_info(
    user_id: str,
    tenant_id: str = PUBLIC_TENANT_ID,
    user_context: Optional[UserContext] = None,
):
    try:
        handles = await session_asyncio.get_all_session_handles_for_user(
            user_id,
            fetch_sessions_for_linked_accounts=True,
            tenant_id=tenant_id,
            user_context=user_context,
        )
    except Exception:
        return None
    latest = None
    for handle in handles:
        session_info = await session_asyncio.get_session_information(handle, user_context)
        if session_info is not None and (
            latest is None or session_info.time_created > latest.time_created
        ):
            latest = session_info
    return latest


async def build_rownd_session_claims(
    config: RowndPluginConfig,
    user_id: str,
    current_payload: JsonDict,
    app_variant_id: Optional[str],
    user_context: Optional[UserContext] = None,
) -> JsonDict:
    inspection = await inspect_linked_user_metadata(user_id, user_context)
    user = cast(Optional[User], inspection["user"])
    metadata = cast(JsonDict, inspection["combined_metadata"]) if user else {}
    return rownd_compatibility.build_rownd_session_claim_payload(
        config, user_id, user, metadata, current_payload, app_variant_id
    )


async def build_rownd_session_and_anonymous_claims(
    config: RowndPluginConfig,
    user_id: str,
    current_payload: JsonDict,
    app_variant_id: Optional[str],
    user_context: UserContext,
) -> Tuple[JsonDict, JsonDict]:
    inspection = await inspect_linked_user_metadata(user_id, user_context)
    user = cast(Optional[User], inspection["user"])
    metadata = cast(JsonDict, inspection["combined_metadata"]) if user else {}
    rownd_claims = rownd_compatibility.build_rownd_session_claim_payload(
        config, user_id, user, metadata, current_payload, app_variant_id
    )
    is_anonymous = rownd_compatibility.get_effective_auth_level(user) in {
        GUEST_AUTH_METHOD_ID,
        INSTANT_AUTH_METHOD_ID,
    }
    from supertokens_python.utils import get_timestamp_ms

    return rownd_claims, {"is_anonymous": {"v": is_anonymous, "t": get_timestamp_ms()}}


async def build_rownd_oauth_payload(
    config: RowndPluginConfig,
    user: Optional[User],
    scopes: List[str],
    current_payload: Optional[JsonDict],
    user_context: UserContext,
) -> JsonDict:
    payload = current_payload or {}
    metadata = (
        cast(
            JsonDict,
            (await inspect_linked_user_metadata(user.id, user_context, user))["combined_metadata"],
        )
        if user
        else {}
    )
    rownd_audience = rownd_compatibility.get_rownd_oauth_audience(
        requested_audience=rownd_compatibility.first_string(
            user_context.get("rowndOAuthAudience")
        )
    )
    return {
        **payload,
        **(
            rownd_compatibility.build_standard_oauth_claims(user, scopes, metadata)
            if user
            else {}
        ),
        **(
            rownd_compatibility.build_rownd_session_claim_payload(
                config, user.id, user, metadata, payload, None, RESERVED_OAUTH_CLAIMS
            )
            if user
            else {}
        ),
        **({"aud": rownd_audience} if rownd_audience else {}),
    }


async def build_rownd_oauth_user_info(
    user: User,
    access_token_payload: JsonDict,
    scopes: List[str],
    current_payload: Optional[JsonDict],
    user_context: Optional[UserContext] = None,
) -> JsonDict:
    metadata = cast(
        JsonDict,
        (await inspect_linked_user_metadata(user.id, user_context, user))["combined_metadata"],
    )
    return {
        **(current_payload or {}),
        **rownd_compatibility.build_standard_oauth_claims(user, scopes, metadata),
        **rownd_compatibility.pick_oauth_user_info_rownd_claims(access_token_payload),
    }


async def record_rownd_app_variant_for_user(
    config: RowndPluginConfig,
    user_id: str,
    app_variant_id: Optional[str],
    user_context: Optional[UserContext] = None,
) -> None:
    if not app_variant_id:
        return
    assert_app_variant_is_configured(config, app_variant_id)
    operation_context = user_context if user_context is not None else {}
    inspection = await inspect_linked_user_metadata(user_id, operation_context)
    metadata_user_id = cast(
        str,
        inspection.get("rownd_metadata_source_user_id") or inspection["primary_user_id"],
    )
    clear_supertokens_core_call_cache(operation_context)
    metadata = await get_raw_user_metadata(metadata_user_id, operation_context)
    original = as_json_dict(metadata.get("original_rownd_user"))
    attributes = as_json_dict(original.get("attributes"))
    app_variants = attributes.get("rownd:app_variants") or []
    if isinstance(app_variants, str):
        app_variants = [app_variants]
    if not isinstance(app_variants, list):
        app_variants = []
    if app_variant_id in app_variants:
        return
    await usermetadata_asyncio.update_user_metadata(
        metadata_user_id,
        {
            "original_rownd_user": {
                **original,
                "data": as_json_dict(original.get("data")) or {"user_id": metadata_user_id},
                "verified_data": as_json_dict(original.get("verified_data")),
                "attributes": {**attributes, "rownd:app_variants": [*app_variants, app_variant_id]},
            },
        },
        operation_context,
    )


async def import_user(
    user_import: JsonDict,
    supertokens_config: SupertokensConfig,
    user_context: UserContext,
) -> JsonDict:
    headers = {"Content-Type": "application/json"}
    if supertokens_config.api_key:
        headers["api-key"] = supertokens_config.api_key
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            res = await client.post(
                supertokens_config.connection_uri.rstrip("/") + "/bulk-import/import",
                headers=headers,
                json=user_import,
            )
    finally:
        clear_supertokens_core_call_cache(user_context)
    if res.status_code < 200 or res.status_code >= 300:
        raise _BulkImportError(res.status_code, res.text)
    data = res.json()
    if data.get("status") != "OK" or not data.get("user"):
        raise RuntimeError(
            "Bulk import failed: %s" % (data.get("message") or "Missing user in response")
        )
    return data["user"]


def login_method_matches_import(login_method: LoginMethod, method_import: JsonDict) -> bool:
    recipe_id = method_import.get("recipeId")
    if login_method.recipe_id != recipe_id:
        return False
    if recipe_id == "thirdparty":
        third_party_user_id = optional_string(method_import.get("thirdPartyUserId"))
        third_party_id = optional_string(method_import.get("thirdPartyId"))
        if not third_party_user_id or not third_party_id:
            return False
        return login_method.has_same_third_party_info_as(
            ThirdPartyInfo(
                third_party_user_id,
                third_party_id,
            )
        )
    if recipe_id == "passwordless":
        email = optional_string(method_import.get("email"))
        return (
            login_method.has_same_email_as(email)
            if email
            else login_method.has_same_phone_number_as(
                optional_string(method_import.get("phoneNumber"))
            )
        )
    return login_method.has_same_email_as(optional_string(method_import.get("email")))


def import_method_account_infos(method_import: JsonDict) -> List[AccountInfoInput]:
    if method_import.get("recipeId") == "thirdparty":
        third_party_user_id = optional_string(method_import.get("thirdPartyUserId"))
        third_party_id = optional_string(method_import.get("thirdPartyId"))
        email = optional_string(method_import.get("email"))
        if not third_party_user_id or not third_party_id or not email:
            raise RuntimeError("Migrated third-party login method is incomplete")
        return [
            AccountInfoInput(
                third_party=ThirdPartyInfo(
                    third_party_user_id,
                    third_party_id,
                )
            ),
            AccountInfoInput(email=email),
        ]
    email = optional_string(method_import.get("email"))
    if email:
        return [AccountInfoInput(email=email)]
    phone_number = optional_string(method_import.get("phoneNumber"))
    if phone_number:
        return [AccountInfoInput(phone_number=phone_number)]
    raise RuntimeError("Migrated login method has no account information")


def login_method_owns_import_account_info(
    user: User, login_method: LoginMethod, method_import: JsonDict
) -> bool:
    if login_method_matches_import(login_method, method_import):
        return True
    if not user.is_primary_user:
        return False

    email = optional_string(method_import.get("email"))
    if method_import.get("recipeId") == "thirdparty":
        return login_method.has_same_email_as(email)
    if method_import.get("recipeId") == "passwordless" and not email:
        return login_method.has_same_phone_number_as(
            optional_string(method_import.get("phoneNumber"))
        )
    return login_method.has_same_email_as(email)


class ImportMethodInspection(NamedTuple):
    method_import: JsonDict
    owners: List[Tuple[User, LoginMethod]]
    match: Optional[Tuple[User, LoginMethod]]
    reconciliation_match: Optional[Tuple[User, LoginMethod]]


async def inspect_import_method(
    method_import: JsonDict,
    tenant_id: str,
    user_context: UserContext,
) -> ImportMethodInspection:
    user_lists = await asyncio.gather(
        *(
            list_users_by_account_info(
                tenant_id,
                account_info,
                False,
                user_context,
            )
            for account_info in import_method_account_infos(method_import)
        )
    )
    users = {user.id: user for user_list in user_lists for user in user_list}.values()
    owners = [
        (user, login_method)
        for user in users
        for login_method in user.login_methods
        if tenant_id in login_method.tenant_ids
        and login_method_owns_import_account_info(user, login_method, method_import)
    ]
    match = next(
        (
            owner
            for owner in owners
            if login_method_matches_import(owner[1], method_import)
            and (
                method_import.get("recipeId") == "thirdparty"
                or method_import.get("recipeId") == "passwordless"
                or (method_import.get("isVerified") is True and owner[1].verified)
            )
        ),
        None,
    )
    reconciliation_match = match
    if (
        reconciliation_match is None
        and method_import.get("recipeId") == "passwordless"
        and isinstance(method_import.get("email"), str)
        and method_import.get("isVerified") is True
    ):
        reconciliation_match = next(
            (owner for owner in owners if owner[0].is_primary_user and owner[1].verified),
            None,
        )
    return ImportMethodInspection(method_import, owners, match, reconciliation_match)


async def create_missing_login_method(
    method_import: JsonDict,
    tenant_id: str,
    primary_user_id: str,
    user_context: UserContext,
) -> Tuple[RecipeUserId, bool]:
    reconciliation_context = create_derived_user_context(
        user_context, {"rowndDisableAutomaticAccountLinking": True}
    )
    if method_import.get("recipeId") == "thirdparty":
        third_party_id = optional_string(method_import.get("thirdPartyId"))
        third_party_user_id = optional_string(method_import.get("thirdPartyUserId"))
        email = optional_string(method_import.get("email"))
        if not third_party_id or not third_party_user_id or not email:
            raise RuntimeError("Migrated third-party login method is incomplete")
        result = await thirdparty_asyncio.manually_create_or_update_user(
            tenant_id=tenant_id,
            third_party_id=third_party_id,
            third_party_user_id=third_party_user_id,
            email=email,
            is_verified=bool(method_import.get("isVerified")),
            user_context=reconciliation_context,
        )
        if not isinstance(result, ManuallyCreateOrUpdateUserOkResult):
            raise RuntimeError(
                "Failed to create migrated third-party login method: %s"
                % getattr(result, "status", "ERROR")
            )
        if not result.created_new_recipe_user and not await sdk_user_id_matches_internal_target(
            result.user.id, primary_user_id, reconciliation_context
        ):
            raise RuntimeError(
                "Migrated third-party login method belongs to another SuperTokens user"
            )
        return result.recipe_user_id, result.created_new_recipe_user

    if method_import.get("recipeId") == "passwordless":
        email = optional_string(method_import.get("email"))
        phone_number = optional_string(method_import.get("phoneNumber"))
        result = await passwordless_asyncio.signinup(
            tenant_id,
            email,
            phone_number,
            None,
            reconciliation_context,
        )
        if not result.created_new_recipe_user and not await sdk_user_id_matches_internal_target(
            result.user.id, primary_user_id, reconciliation_context
        ):
            raise RuntimeError(
                "Migrated passwordless login method belongs to another SuperTokens user"
            )
        return result.recipe_user_id, result.created_new_recipe_user

    raise RuntimeError(
        "Cannot reconcile unsupported login method: %s" % method_import.get("recipeId")
    )


async def resolve_supertokens_user_id(user_id: str, user_context: UserContext) -> str:
    mapping = await get_user_id_mapping(user_id, "EXTERNAL", user_context)
    return mapping.supertokens_user_id if isinstance(mapping, GetUserIdMappingOkResult) else user_id


async def freshly_resolve_sdk_user_id_to_internal(
    sdk_user_id: str, user_context: UserContext
) -> str:
    clear_supertokens_core_call_cache(user_context)
    return await resolve_supertokens_user_id(sdk_user_id, user_context)


async def sdk_user_id_matches_internal_target(
    sdk_user_id: str, expected_internal_user_id: str, user_context: UserContext
) -> bool:
    if sdk_user_id == expected_internal_user_id:
        return True
    resolved_sdk_user_id = await freshly_resolve_sdk_user_id_to_internal(sdk_user_id, user_context)
    return resolved_sdk_user_id == expected_internal_user_id


async def assert_user_is_not_mapped_to_another_rownd_user(
    supertokens_user_id: str,
    rownd_user_id: str,
    user_context: UserContext,
) -> None:
    mapping = await get_user_id_mapping(supertokens_user_id, "SUPERTOKENS", user_context)
    if isinstance(mapping, GetUserIdMappingOkResult) and mapping.external_user_id != rownd_user_id:
        raise RuntimeError("A migrated login method is already mapped to another Rownd user")


async def assert_rownd_user_id_can_be_mapped(
    supertokens_user_id: str,
    rownd_user_id: str,
    user_context: UserContext,
) -> bool:
    external_mapping = await get_user_id_mapping(rownd_user_id, "EXTERNAL", user_context)
    if isinstance(external_mapping, GetUserIdMappingOkResult):
        if not await sdk_user_id_matches_internal_target(
            external_mapping.supertokens_user_id, supertokens_user_id, user_context
        ):
            raise RuntimeError("The Rownd user ID is already mapped to another SuperTokens user")
        return True

    internal_mapping = await get_user_id_mapping(supertokens_user_id, "SUPERTOKENS", user_context)
    if isinstance(internal_mapping, GetUserIdMappingOkResult):
        if internal_mapping.external_user_id != rownd_user_id:
            raise RuntimeError("The SuperTokens user is already mapped to another external user ID")
        return True
    return False


async def ensure_primary_user(
    user: User,
    login_method: LoginMethod,
    supertokens_user_id: str,
    user_context: UserContext,
) -> str:
    if user.is_primary_user:
        return supertokens_user_id
    result = await accountlinking_asyncio.create_primary_user(
        login_method.recipe_user_id,
        user_context,
    )
    if isinstance(result, CreatePrimaryUserOkResult):
        return supertokens_user_id
    if isinstance(result, CreatePrimaryUserRecipeUserIdAlreadyLinkedError):
        if await sdk_user_id_matches_internal_target(
            result.primary_user_id, supertokens_user_id, user_context
        ):
            return supertokens_user_id
        raise RuntimeError("A migrated login method belongs to a different primary user")
    raise RuntimeError("A migrated login method belongs to a different primary user")


async def create_unforced_rownd_user_id_mapping(
    supertokens_user_id: str,
    rownd_user_id: str,
    user_context: UserContext,
) -> bool:
    try:
        mapping_result = await create_user_id_mapping(
            supertokens_user_id,
            rownd_user_id,
            force=False,
            user_context=user_context,
        )
    except KeyError as error:
        if error.args != ("does_external_user_id_exist",):
            raise
        clear_supertokens_core_call_cache(user_context)
        existing = await get_user_id_mapping(rownd_user_id, "EXTERNAL", user_context)
        if isinstance(
            existing, GetUserIdMappingOkResult
        ) and await sdk_user_id_matches_internal_target(
            existing.supertokens_user_id, supertokens_user_id, user_context
        ):
            return False
        raise
    if isinstance(mapping_result, CreateUserIdMappingOkResult):
        return True
    clear_supertokens_core_call_cache(user_context)
    existing = await get_user_id_mapping(rownd_user_id, "EXTERNAL", user_context)
    if isinstance(existing, GetUserIdMappingOkResult) and await sdk_user_id_matches_internal_target(
        existing.supertokens_user_id, supertokens_user_id, user_context
    ):
        return False
    raise RuntimeError(
        "Failed to map migrated Rownd user ID: %s" % getattr(mapping_result, "status", "ERROR")
    )


async def _read_mapping_postcondition(
    supertokens_user_id: str,
    rownd_user_id: str,
    user_context: UserContext,
) -> Literal["ABSENT", "EXACT", "CONFLICT"]:
    clear_supertokens_core_call_cache(user_context)
    external, internal = await asyncio.gather(
        get_user_id_mapping(rownd_user_id, "EXTERNAL", user_context),
        get_user_id_mapping(supertokens_user_id, "SUPERTOKENS", user_context),
    )
    external_ok = isinstance(external, GetUserIdMappingOkResult)
    internal_ok = isinstance(internal, GetUserIdMappingOkResult)
    if not external_ok and not internal_ok:
        return "ABSENT"
    if (
        external_ok
        and external.external_user_id == rownd_user_id
        and external.supertokens_user_id == supertokens_user_id
        and internal_ok
        and internal.external_user_id == rownd_user_id
        and internal.supertokens_user_id == supertokens_user_id
    ):
        return "EXACT"
    return "CONFLICT"


async def _create_rownd_user_id_mapping(
    source: FreshMigrationSource,
    target: PinnedMigrationTarget,
    user_context: UserContext,
    read_fresh_source: Callable[[], Awaitable[Optional[FreshMigrationSource]]],
    retry_state: _MappingRetryState,
    narrow_capability: Optional[_NarrowMappingCapability] = None,
) -> bool:
    async def preflight() -> Tuple[FreshMigrationSource, bool]:
        fresh = await read_fresh_source()
        if fresh is None or fresh.snapshot != source.snapshot:
            raise MigrationError(MigrationErrorReason.MIGRATION_INCOMPLETE, "mapping")
        snapshot = await read_fresh_migration_snapshot(
            fresh.snapshot, user_context, target
        )
        external = snapshot.mapping.external_lookup
        internal = snapshot.mapping.internal_lookups.get(target.user_id)
        if (
            external is not None and external.supertokens_user_id != target.user_id
        ) or (
            internal is not None and internal.external_user_id != fresh.snapshot.rownd_user_id
        ):
            raise MigrationError(MigrationErrorReason.MAPPING_CONFLICT, "mapping")
        disposition = classify_migration_snapshot(snapshot, target)
        if disposition.status is MigrationDispositionStatus.BLOCKED:
            raise MigrationError(
                disposition.reason or MigrationErrorReason.MIGRATION_STATE_INVALID,
                "mapping",
            )
        exact = (
            external is not None
            and external.external_user_id == fresh.snapshot.rownd_user_id
            and external.supertokens_user_id == target.user_id
            and internal is not None
            and internal.external_user_id == fresh.snapshot.rownd_user_id
            and internal.supertokens_user_id == target.user_id
        )
        if exact:
            return fresh, True
        expected_mutation = MigrationMutation("CREATE_MAPPING", target_user_id=target.user_id)
        if (
            disposition.status is not MigrationDispositionStatus.REPAIRABLE
            or expected_mutation not in disposition.mutations
        ):
            raise MigrationError(MigrationErrorReason.MAPPING_CONFLICT, "mapping")
        return fresh, False

    initial_source, mapping_exists = await preflight()
    if mapping_exists:
        return False

    try:
        result = await create_user_id_mapping(
            target.user_id,
            initial_source.snapshot.rownd_user_id,
            force=False,
            user_context=user_context,
        )
    except Exception as error:
        postcondition = await _read_mapping_postcondition(
            target.user_id, initial_source.snapshot.rownd_user_id, user_context
        )
        if postcondition == "EXACT":
            return True
        if postcondition == "CONFLICT":
            raise MigrationError(MigrationErrorReason.MAPPING_CONFLICT, "mapping", error) from error
        raise

    if (
        isinstance(result, _NonAuthRecipeUserIdReferenceError)
        and result.status == "NON_AUTH_RECIPE_USER_ID_REFERENCE_ERROR"
    ):
        second_source, mapping_exists = await preflight()
        if mapping_exists:
            return False
        if narrow_capability is None:
            raise MigrationError(MigrationErrorReason.CORE_CAPABILITY_REQUIRED, "mapping")
        if retry_state.narrow_retry_attempted:
            raise MigrationError(MigrationErrorReason.MIGRATION_INCOMPLETE, "mapping")
        retry_state.narrow_retry_attempted = True
        try:
            result = await narrow_capability(
                target.user_id, second_source.snapshot.rownd_user_id, user_context
            )
        except Exception as error:
            postcondition = await _read_mapping_postcondition(
                target.user_id, second_source.snapshot.rownd_user_id, user_context
            )
            if postcondition == "EXACT":
                return True
            if postcondition == "CONFLICT":
                raise MigrationError(
                    MigrationErrorReason.MAPPING_CONFLICT, "mapping", error
                ) from error
            raise

    if isinstance(result, (CreateUserIdMappingOkResult, UserIdMappingAlreadyExistsError)):
        postcondition = await _read_mapping_postcondition(
            target.user_id, initial_source.snapshot.rownd_user_id, user_context
        )
        if postcondition != "EXACT":
            raise MigrationError(MigrationErrorReason.MAPPING_CONFLICT, "mapping")
        return isinstance(result, CreateUserIdMappingOkResult)

    postcondition = await _read_mapping_postcondition(
        target.user_id, initial_source.snapshot.rownd_user_id, user_context
    )
    if postcondition == "EXACT":
        return True
    if postcondition == "CONFLICT":
        raise MigrationError(MigrationErrorReason.MAPPING_CONFLICT, "mapping")
    raise RuntimeError(
        "Failed to map migrated Rownd user ID: %s" % getattr(result, "status", "ERROR")
    )


def _import_method_matches_expected_identity(
    method_import: JsonDict, identity: ExpectedIdentity
) -> bool:
    if identity.recipe_id == "thirdparty":
        return (
            method_import.get("recipeId") == "thirdparty"
            and method_import.get("thirdPartyId") == identity.provider_id
            and method_import.get("thirdPartyUserId") == identity.provider_user_id
        )
    return method_import.get("recipeId") == "passwordless" and (
        normalize_email(cast(str, method_import.get("email", ""))) == identity.identifier
        if identity.identifier_type == "email"
        else method_import.get("phoneNumber") == identity.identifier
    )


def _build_online_migration_import(source: FreshMigrationSource) -> JsonDict:
    tenant_id = source.snapshot.tenant_id if source.snapshot.tenant_id != PUBLIC_TENANT_ID else None
    mapped = rownd_compatibility.map_rownd_user_to_supertokens(
        source.rownd_user, tenant_id, migration_complete=False
    )
    mapped_methods = as_json_list(mapped.get("loginMethods"))
    login_methods = [
        method
        for method in mapped_methods
        if any(
            _import_method_matches_expected_identity(method, identity)
            for identity in source.snapshot.expected_identities
        )
    ]
    if not login_methods and not source.snapshot.expected_identities:
        bridge_user = {
            **source.rownd_user,
            "data": {"user_id": source.snapshot.rownd_user_id},
            "verified_data": {},
        }
        login_methods = as_json_list(
            rownd_compatibility.map_rownd_user_to_supertokens(
                cast(JsonDict, bridge_user), tenant_id, migration_complete=False
            ).get("loginMethods")
        )
    if len(login_methods) > 1 and not any(method.get("isPrimary") for method in login_methods):
        login_methods[0]["isPrimary"] = True
    return cast(
        JsonDict,
        {
            "externalUserId": source.snapshot.rownd_user_id,
            "loginMethods": login_methods,
            "userMetadata": rownd_compatibility.build_rownd_user_metadata(
                source.rownd_user, migration_complete=False
            ),
        },
    )


async def _apply_to_fresh_migration_method(
    recipe_user_id: str,
    target_user_id: str,
    user_context: UserContext,
    mutate: Callable[[RecipeUserId], Awaitable[Any]],
    permitted_unlinked_owner: Optional[IdentityOwner] = None,
    expected_identity: Optional[ExpectedIdentity] = None,
) -> Any:
    clear_supertokens_core_call_cache(user_context)
    user = await get_user(recipe_user_id, user_context)
    method = next(
        (
            candidate
            for candidate in (user.login_methods if user else [])
            if candidate.recipe_user_id.get_as_string() == recipe_user_id
        ),
        None,
    )
    if user is None or method is None:
        raise MigrationError(MigrationErrorReason.IDENTITY_OWNED_BY_ANOTHER_USER, "account_link")
    current_primary_user_id = await resolve_supertokens_user_id(user.id, user_context)
    if permitted_unlinked_owner is not None:
        normalized_identifier = (
            "%s:%s" % (expected_identity.provider_id, expected_identity.provider_user_id)
            if expected_identity is not None and expected_identity.recipe_id == "thirdparty"
            else expected_identity.identifier if expected_identity is not None else None
        )
        mapping = await get_user_id_mapping(
            current_primary_user_id, "SUPERTOKENS", user_context
        )
        if (
            expected_identity is None
            or permitted_unlinked_owner.recipe_user_id != recipe_user_id
            or permitted_unlinked_owner.identity_key != expected_identity.key
            or permitted_unlinked_owner.recipe_id != expected_identity.recipe_id
            or permitted_unlinked_owner.normalized_identifier != normalized_identifier
            or not _migration_method_matches_identity(method, expected_identity)
            or method.verified != permitted_unlinked_owner.verified
            or (expected_identity.recipe_id == "passwordless" and not method.verified)
            or permitted_unlinked_owner.is_primary_user
            or user.is_primary_user
            or current_primary_user_id != permitted_unlinked_owner.primary_user_id
            or isinstance(mapping, GetUserIdMappingOkResult)
        ):
            raise MigrationError(
                MigrationErrorReason.IDENTITY_OWNED_BY_ANOTHER_USER, "account_link"
            )
    elif current_primary_user_id != target_user_id:
        raise MigrationError(MigrationErrorReason.IDENTITY_OWNED_BY_ANOTHER_USER, "account_link")
    return await mutate(method.recipe_user_id)


async def _assert_fresh_link_target_authority(
    source: RowndIdentitySnapshot,
    pinned_target: PinnedMigrationTarget,
    user_context: UserContext,
) -> None:
    clear_supertokens_core_call_cache(user_context)
    target_user = await get_user(pinned_target.user_id, user_context)
    if target_user is None:
        raise MigrationError(MigrationErrorReason.MAPPING_CONFLICT, "account_link")
    if await resolve_supertokens_user_id(target_user.id, user_context) != pinned_target.user_id:
        raise MigrationError(MigrationErrorReason.MAPPING_CONFLICT, "account_link")

    external = await get_user_id_mapping(source.rownd_user_id, "EXTERNAL", user_context)
    internal = await get_user_id_mapping(pinned_target.user_id, "SUPERTOKENS", user_context)
    external_ok = isinstance(external, GetUserIdMappingOkResult)
    internal_ok = isinstance(internal, GetUserIdMappingOkResult)
    exact_external = (
        external_ok
        and external.external_user_id == source.rownd_user_id
        and external.supertokens_user_id == pinned_target.user_id
    )
    exact_internal = (
        internal_ok
        and internal.external_user_id == source.rownd_user_id
        and internal.supertokens_user_id == pinned_target.user_id
    )
    if pinned_target.user_id != source.rownd_user_id:
        valid_mapping = exact_external and exact_internal
    else:
        valid_mapping = (not external_ok and not internal_ok) or (
            exact_external and exact_internal
        )
    if not valid_mapping:
        raise MigrationError(MigrationErrorReason.MAPPING_CONFLICT, "account_link")


async def _link_fresh_migration_method(
    recipe_user_id: str,
    identity: ExpectedIdentity,
    owner: IdentityOwner,
    source: FreshMigrationSource,
    pinned_target: PinnedMigrationTarget,
    user_context: UserContext,
    read_fresh_source: Callable[[], Awaitable[Optional[FreshMigrationSource]]],
) -> Tuple[Optional[Any], Optional[FreshMigrationSource]]:
    async def link(method_recipe_user_id: RecipeUserId) -> Any:
        latest_source = await read_fresh_source()
        if latest_source is None:
            raise MigrationError(MigrationErrorReason.MIGRATION_INCOMPLETE, "account_link")
        if latest_source.snapshot != source.snapshot:
            raise _MigrationSourceChanged(latest_source)
        await _assert_fresh_link_target_authority(
            latest_source.snapshot, pinned_target, user_context
        )
        return await accountlinking_asyncio.link_accounts(
            method_recipe_user_id, pinned_target.user_id, user_context
        )

    try:
        result = await _apply_to_fresh_migration_method(
            recipe_user_id,
            pinned_target.user_id,
            user_context,
            link,
            owner,
            identity,
        )
        return result, None
    except _MigrationSourceChanged as changed:
        return None, changed.source


async def _verify_migration_email(
    recipe_user_id: RecipeUserId,
    email: str,
    tenant_id: str,
    user_context: UserContext,
) -> None:
    token_result = await emailverification_asyncio.create_email_verification_token(
        tenant_id, recipe_user_id, email, user_context
    )
    token = getattr(token_result, "token", None)
    if getattr(token_result, "status", None) != "OK" or not isinstance(token, str):
        raise RuntimeError("Failed to create migration verification token")
    result = await emailverification_asyncio.verify_email_using_token(
        tenant_id, token, False, user_context
    )
    if getattr(result, "status", None) != "OK":
        raise RuntimeError("Failed to verify migrated email")


async def apply_migration_repairs(
    disposition: MigrationDisposition,
    source: FreshMigrationSource,
    pinned_target: Optional[PinnedMigrationTarget],
    supertokens_config: SupertokensConfig,
    user_context: UserContext,
    read_fresh_source: Callable[[], Awaitable[Optional[FreshMigrationSource]]],
    mapping_retry_state: Optional[_MappingRetryState] = None,
) -> Optional[FreshMigrationSource]:
    retry_state = mapping_retry_state or _MappingRetryState()

    async def read_guarded_disposition(
        mutation: MigrationMutation,
    ) -> Tuple[FreshMigrationSource, Optional[MigrationSnapshot], bool]:
        fresh = await read_fresh_source()
        if fresh is None:
            raise MigrationError(MigrationErrorReason.MIGRATION_INCOMPLETE, "state_inspect")
        if fresh.snapshot != source.snapshot:
            return fresh, None, False
        snapshot = await read_fresh_migration_snapshot(fresh.snapshot, user_context, pinned_target)
        current = classify_migration_snapshot(snapshot, pinned_target)
        if current.status is MigrationDispositionStatus.BLOCKED:
            raise MigrationError(
                current.reason or MigrationErrorReason.MIGRATION_STATE_INVALID,
                "state_inspect",
            )
        return (
            fresh,
            snapshot,
            (
                current.status is MigrationDispositionStatus.REPAIRABLE
                and mutation in current.mutations
            ),
        )

    for mutation in disposition.mutations:
        fresh, snapshot, should_apply = await read_guarded_disposition(mutation)
        if fresh.snapshot != source.snapshot:
            return fresh
        if snapshot is None:
            raise MigrationError(MigrationErrorReason.MIGRATION_INCOMPLETE, "state_inspect")
        if not should_apply:
            continue

        if mutation.type == "IMPORT_USER":
            await import_user(
                _build_online_migration_import(fresh), supertokens_config, user_context
            )
            clear_supertokens_core_call_cache(user_context)
            continue
        if pinned_target is None:
            raise MigrationError(MigrationErrorReason.MIGRATION_INCOMPLETE, "state_inspect")
        target_user_id = pinned_target.user_id
        if mutation.type == "CREATE_MAPPING":
            await _create_rownd_user_id_mapping(
                fresh,
                pinned_target,
                user_context,
                read_fresh_source,
                retry_state,
            )
            continue
        if mutation.type == "MAKE_PRIMARY":
            user = await get_user(cast(str, mutation.target_user_id), user_context)
            if user is None or not user.login_methods:
                raise RuntimeError("Migration target has no login method")
            await ensure_primary_user(
                user,
                user.login_methods[0],
                cast(str, mutation.target_user_id),
                user_context,
            )
            clear_supertokens_core_call_cache(user_context)
            continue
        if mutation.type == "CREATE_IDENTITY":
            identity = cast(ExpectedIdentity, mutation.identity)
            method_import = next(
                (
                    method
                    for method in as_json_list(
                        _build_online_migration_import(fresh).get("loginMethods")
                    )
                    if _import_method_matches_expected_identity(method, identity)
                ),
                None,
            )
            if method_import is None:
                raise MigrationError(MigrationErrorReason.MIGRATION_INCOMPLETE, "account_link")
            recipe_user_id, _ = await create_missing_login_method(
                method_import, fresh.snapshot.tenant_id, target_user_id, user_context
            )
            clear_supertokens_core_call_cache(user_context)
            created_user = await get_user(recipe_user_id.get_as_string(), user_context)
            if created_user is None:
                raise RuntimeError("Created migrated login method was not found")
            if not await sdk_user_id_matches_internal_target(
                created_user.id, target_user_id, user_context
            ):
                before_link_source = await read_fresh_source()
                if before_link_source is None:
                    raise MigrationError(MigrationErrorReason.MIGRATION_INCOMPLETE, "account_link")
                if before_link_source.snapshot != fresh.snapshot:
                    return before_link_source
                before_link = await read_fresh_migration_snapshot(
                    before_link_source.snapshot, user_context, pinned_target
                )
                created_owner = next(
                    (
                        owner
                        for owner in before_link.owners
                        if owner.identity_key == identity.key
                        and owner.recipe_user_id == recipe_user_id.get_as_string()
                    ),
                    None,
                )
                if (
                    created_owner is None
                    or created_owner.is_primary_user
                    or before_link.mapping.internal_lookups.get(created_owner.primary_user_id)
                    is not None
                ):
                    raise MigrationError(
                        MigrationErrorReason.IDENTITY_OWNED_BY_ANOTHER_USER,
                        "account_link",
                    )
                link_result, changed_source = await _link_fresh_migration_method(
                    recipe_user_id.get_as_string(),
                    identity,
                    created_owner,
                    before_link_source,
                    pinned_target,
                    user_context,
                    read_fresh_source,
                )
                if changed_source is not None:
                    return changed_source
                already_linked = isinstance(
                    link_result, LinkAccountsRecipeUserIdAlreadyLinkedError
                ) and await sdk_user_id_matches_internal_target(
                    link_result.primary_user_id, target_user_id, user_context
                )
                if not isinstance(link_result, LinkAccountsOkResult) and not already_linked:
                    raise RuntimeError(
                        "Failed to link created migration identity: %s"
                        % getattr(link_result, "status", "ERROR")
                    )
                clear_supertokens_core_call_cache(user_context)
            continue
        if mutation.type == "LINK_IDENTITY":
            owner = next(
                (
                    candidate
                    for candidate in snapshot.owners
                    if candidate.recipe_user_id == mutation.recipe_user_id
                ),
                None,
            )
            if owner is None or owner.is_primary_user:
                raise MigrationError(
                    MigrationErrorReason.PRIMARY_ACCOUNT_MERGE_REQUIRED,
                    "account_link",
                )
            identity = next(
                (
                    candidate
                    for candidate in fresh.snapshot.expected_identities
                    if candidate.key == owner.identity_key
                ),
                None,
            )
            if identity is None:
                raise MigrationError(
                    MigrationErrorReason.IDENTITY_OWNED_BY_ANOTHER_USER, "account_link"
                )

            result, changed_source = await _link_fresh_migration_method(
                cast(str, mutation.recipe_user_id),
                identity,
                owner,
                fresh,
                pinned_target,
                user_context,
                read_fresh_source,
            )
            if changed_source is not None:
                return changed_source
            if not isinstance(result, LinkAccountsOkResult):
                raise RuntimeError(
                    "Failed to link migrated login method: %s" % getattr(result, "status", "ERROR")
                )
            clear_supertokens_core_call_cache(user_context)
            continue
        if mutation.type == "ASSOCIATE_TENANT":
            owner = next(
                (
                    candidate
                    for candidate in snapshot.owners
                    if candidate.recipe_user_id == mutation.recipe_user_id
                ),
                None,
            )
            if owner is None or owner.primary_user_id != target_user_id:
                raise MigrationError(
                    MigrationErrorReason.IDENTITY_OWNED_BY_ANOTHER_USER,
                    "tenant_associate",
                )

            async def associate(recipe_user_id: RecipeUserId) -> Any:
                return await multitenancy_asyncio.associate_user_to_tenant(
                    cast(str, mutation.tenant_id), recipe_user_id, user_context
                )

            result = await _apply_to_fresh_migration_method(
                cast(str, mutation.recipe_user_id),
                target_user_id,
                user_context,
                associate,
            )
            if getattr(result, "status", None) != "OK":
                raise RuntimeError(
                    "Failed to associate migrated login method: %s"
                    % getattr(result, "status", "ERROR")
                )
            clear_supertokens_core_call_cache(user_context)
            continue
        if mutation.type == "VERIFY_IDENTITY":
            identity_key = next(
                (
                    owner.identity_key
                    for owner in snapshot.owners
                    if owner.recipe_user_id == mutation.recipe_user_id
                ),
                None,
            )
            identity = next(
                (
                    candidate
                    for candidate in fresh.snapshot.expected_identities
                    if candidate.key == identity_key
                ),
                None,
            )
            if (
                identity is None
                or identity.recipe_id != "passwordless"
                or identity.identifier_type != "email"
                or identity.identifier is None
            ):
                raise RuntimeError("Unsupported migration verification method")
            email_to_verify = cast(str, identity.identifier)

            async def verify(recipe_user_id: RecipeUserId) -> None:
                await _verify_migration_email(
                    recipe_user_id,
                    email_to_verify,
                    fresh.snapshot.tenant_id,
                    user_context,
                )

            await _apply_to_fresh_migration_method(
                cast(str, mutation.recipe_user_id),
                target_user_id,
                user_context,
                verify,
            )
            clear_supertokens_core_call_cache(user_context)
            continue

        current = classify_migration_snapshot(snapshot, pinned_target)
        if current.status is not MigrationDispositionStatus.REPAIRABLE or any(
            repair.type != "WRITE_METADATA" for repair in current.mutations
        ):
            continue
        verified_email = next(
            (
                identity.identifier
                for identity in fresh.snapshot.expected_identities
                if identity.recipe_id == "passwordless" and identity.identifier_type == "email"
            ),
            None,
        )
        email_owner = next(
            (
                owner
                for owner in snapshot.owners
                if verified_email
                and owner.identity_key == "passwordless:email:%s" % verified_email
                and owner.primary_user_id == target_user_id
                and owner.verified
                and fresh.snapshot.tenant_id in owner.tenant_ids
            ),
            None,
        )
        current_metadata = await get_raw_user_metadata(target_user_id, user_context)
        metadata_inspection = await inspect_linked_user_metadata(target_user_id, user_context)
        metadata_source_user_id = cast(
            str,
            metadata_inspection.get("rownd_metadata_source_user_id") or target_user_id,
        )
        publication_source = await read_fresh_source()
        if publication_source is None:
            raise MigrationError(MigrationErrorReason.MIGRATION_INCOMPLETE, "metadata_finalize")
        if publication_source.snapshot != fresh.snapshot:
            return publication_source
        profile_metadata = rownd_compatibility.build_rownd_user_metadata(
            publication_source.rownd_user, migration_complete=False
        )
        if metadata_source_user_id != target_user_id:
            await usermetadata_asyncio.update_user_metadata(
                metadata_source_user_id, profile_metadata, user_context
            )
        metadata = {
            **(profile_metadata if metadata_source_user_id == target_user_id else {}),
            "rownd_migration_complete": True,
            **(
                {
                    "rownd_email_recipe_user_id": email_owner.recipe_user_id,
                    "rownd_email_recipe_user_ids": {
                        **as_json_dict(current_metadata.get("rownd_email_recipe_user_ids")),
                        publication_source.snapshot.tenant_id: email_owner.recipe_user_id,
                    },
                }
                if email_owner is not None
                else {}
            ),
        }
        await usermetadata_asyncio.update_user_metadata(target_user_id, metadata, user_context)
        clear_supertokens_core_call_cache(user_context)
        completion_written = validate_migration_metadata(
            await get_raw_user_metadata(target_user_id, user_context),
            publication_source.snapshot.tenant_id,
        )
        profile_written = (
            completion_written
            if metadata_source_user_id == target_user_id
            else validate_migration_metadata(
                await get_raw_user_metadata(metadata_source_user_id, user_context),
                publication_source.snapshot.tenant_id,
            )
        )
        if (
            not completion_written.valid
            or completion_written.value is None
            or completion_written.value.legacy_complete is not True
            or not profile_written.valid
            or profile_written.value is None
            or profile_written.value.original_rownd_user_id
            != publication_source.snapshot.rownd_user_id
            or (
                email_owner is not None
                and completion_written.value.canonical_email_recipe_user_id
                != email_owner.recipe_user_id
            )
        ):
            raise MigrationError(MigrationErrorReason.MIGRATION_INCOMPLETE, "metadata_finalize")
    return None


async def read_fresh_migration_session_method(
    source: RowndIdentitySnapshot,
    target: PinnedMigrationTarget,
    user_context: UserContext,
) -> RecipeUserId:
    clear_supertokens_core_call_cache(user_context)
    user = await get_user(target.user_id, user_context)
    if user is None:
        raise MigrationError(MigrationErrorReason.MIGRATION_INCOMPLETE, "state_inspect")
    if await resolve_supertokens_user_id(user.id, user_context) != target.user_id:
        raise MigrationError(MigrationErrorReason.MAPPING_CONFLICT, "state_inspect")
    for method in user.login_methods:
        if source.tenant_id not in method.tenant_ids:
            continue
        recipe_user_id = method.recipe_user_id.get_as_string()
        owner = await get_user(recipe_user_id, user_context)
        if (
            owner is not None
            and await resolve_supertokens_user_id(owner.id, user_context) == target.user_id
            and any(
                candidate.recipe_user_id.get_as_string() == recipe_user_id
                and source.tenant_id in candidate.tenant_ids
                for candidate in owner.login_methods
            )
        ):
            return method.recipe_user_id
    raise MigrationError(MigrationErrorReason.MIGRATION_INCOMPLETE, "state_inspect")


async def reconcile_rownd_user_with_existing_login_methods(
    user_import: JsonDict,
    tenant_id: str,
    user_context: UserContext,
) -> bool:
    external_user_id = user_import.get("externalUserId")
    if not isinstance(external_user_id, str):
        raise RuntimeError("Migrated Rownd user has no external user ID")

    clear_supertokens_core_call_cache(user_context)
    method_imports = as_json_list(user_import.get("loginMethods"))
    inspections = await asyncio.gather(
        *(inspect_import_method(method, tenant_id, user_context) for method in method_imports)
    )
    matches = [
        inspection.reconciliation_match
        for inspection in inspections
        if inspection.reconciliation_match is not None
    ]
    if not matches:
        if any(inspection.owners for inspection in inspections):
            raise RuntimeError(
                "Migrated account information is reserved by an existing SuperTokens user "
                "and cannot be safely reconciled"
            )
        return False

    third_party_matches = [
        inspection.match
        for inspection in inspections
        if inspection.method_import.get("recipeId") == "thirdparty"
        and inspection.match is not None
    ]
    target_user, target_login_method = third_party_matches[0] if third_party_matches else matches[0]
    resolved_user_ids: Dict[str, "asyncio.Task[str]"] = {}

    def resolve_user_id(user_id: str) -> "asyncio.Task[str]":
        task = resolved_user_ids.get(user_id)
        if task is None:
            task = asyncio.create_task(resolve_supertokens_user_id(user_id, user_context))
            resolved_user_ids[user_id] = task
        return task

    target_supertokens_user_id = await resolve_user_id(target_user.id)
    owner_inputs = [
        (inspection.method_import, owner, login_method)
        for inspection in inspections
        for owner, login_method in inspection.owners
    ]
    owner_ids = await asyncio.gather(*(resolve_user_id(owner.id) for _, owner, _ in owner_inputs))
    inspected_owners = [
        (*owner_input, owner_id) for owner_input, owner_id in zip(owner_inputs, owner_ids)
    ]
    foreign_owners = [
        owner_info for owner_info in inspected_owners if owner_info[3] != target_supertokens_user_id
    ]
    can_link_verified_email_owners = (
        bool(third_party_matches)
        and all(
            owner_id == target_supertokens_user_id
            for method, _, _, owner_id in inspected_owners
            if method.get("recipeId") == "thirdparty"
        )
        and all(
            method.get("recipeId") == "passwordless"
            and isinstance(method.get("email"), str)
            and method.get("isVerified") is True
            and login_method.recipe_id == "passwordless"
            and login_method.has_same_email_as(cast(str, method["email"]))
            and not owner.is_primary_user
            for method, owner, login_method, _ in foreign_owners
        )
    )
    if foreign_owners and not can_link_verified_email_owners:
        raise RuntimeError("A migrated login method belongs to a different SuperTokens user")
    for _, _, _, owner_id in foreign_owners:
        await assert_user_is_not_mapped_to_another_rownd_user(
            owner_id,
            external_user_id,
            user_context,
        )
    unsupported = next(
        (
            inspection.method_import
            for inspection in inspections
            if inspection.match is None
            and inspection.method_import.get("recipeId") == "emailpassword"
        ),
        None,
    )
    if unsupported is not None:
        raise RuntimeError("Cannot reconcile unsupported login method: emailpassword")

    clear_supertokens_core_call_cache(user_context)
    existing_mapping_matches = await assert_rownd_user_id_can_be_mapped(
        target_supertokens_user_id, external_user_id, user_context
    )
    mapping_exists = target_supertokens_user_id == external_user_id or existing_mapping_matches
    primary_user_id = await ensure_primary_user(
        target_user,
        target_login_method,
        target_supertokens_user_id,
        user_context,
    )
    foreign_recipe_user_ids = {
        login_method.recipe_user_id.get_as_string(): login_method.recipe_user_id
        for _, _, login_method, _ in foreign_owners
    }
    for recipe_user_id in foreign_recipe_user_ids.values():
        link_result = await accountlinking_asyncio.link_accounts(
            recipe_user_id,
            primary_user_id,
            user_context,
        )
        if not isinstance(link_result, LinkAccountsOkResult):
            raise RuntimeError(
                "Failed to link migrated login method: %s" % getattr(link_result, "status", "ERROR")
            )
    for inspection in inspections:
        method_import = inspection.method_import
        if inspection.match is not None:
            continue
        verified_matching_email = None
        email = optional_string(method_import.get("email"))
        if method_import.get("recipeId") == "passwordless" and email:
            verified_matching_email = next(
                (
                    method
                    for method in target_user.login_methods
                    if tenant_id in method.tenant_ids
                    and method.verified
                    and method.has_same_email_as(email)
                ),
                None,
            )
        effective_import = (
            {**method_import, "isVerified": True}
            if verified_matching_email is not None
            else method_import
        )
        recipe_user_id, _ = await create_missing_login_method(
            effective_import, tenant_id, primary_user_id, user_context
        )
        created_user = await get_user(recipe_user_id.get_as_string(), user_context)
        if created_user is None:
            raise RuntimeError("Created migrated login method was not found")
        if not await sdk_user_id_matches_internal_target(
            created_user.id, primary_user_id, user_context
        ):
            link_result = await accountlinking_asyncio.link_accounts(
                recipe_user_id, primary_user_id, user_context
            )
            already_linked = isinstance(
                link_result, LinkAccountsRecipeUserIdAlreadyLinkedError
            ) and await sdk_user_id_matches_internal_target(
                link_result.primary_user_id, primary_user_id, user_context
            )
            if not isinstance(link_result, LinkAccountsOkResult) and not already_linked:
                raise RuntimeError(
                    "Failed to link migrated login method: %s"
                    % getattr(link_result, "status", "ERROR")
                )
        if (
            effective_import.get("recipeId") == "passwordless"
            and email
            and not effective_import.get("isVerified")
        ):
            await emailverification_asyncio.unverify_email(
                recipe_user_id,
                email,
                user_context,
            )

    if not mapping_exists:
        clear_supertokens_core_call_cache(user_context)
        mapping_exists = await assert_rownd_user_id_can_be_mapped(
            primary_user_id, external_user_id, user_context
        )
        if not mapping_exists:
            await create_unforced_rownd_user_id_mapping(
                primary_user_id, external_user_id, user_context
            )
    await usermetadata_asyncio.update_user_metadata(
        primary_user_id,
        as_json_dict(user_import.get("userMetadata")),
        user_context,
    )
    return True


async def sync_imported_email_verification_state(
    recipe_user_id: RecipeUserId,
    user_id: Optional[str],
    tenant_id: str,
    user_context: UserContext,
) -> None:
    metadata = await get_user_metadata(user_id or recipe_user_id.get_as_string(), user_context)
    original = as_json_dict(metadata.get("original_rownd_user"))
    data = as_json_dict(original.get("data"))
    verified_data = as_json_dict(original.get("verified_data"))
    email = data.get("email")
    if not isinstance(email, str) or not rownd_compatibility.is_rownd_email_verified(
        verified_data.get("email"), email
    ):
        return
    try:
        token_result = await emailverification_asyncio.create_email_verification_token(
            tenant_id, recipe_user_id, email, user_context
        )
        token = getattr(token_result, "token", None)
        if isinstance(token, str):
            await emailverification_asyncio.verify_email_using_token(
                tenant_id, token, False, user_context
            )
    except Exception:
        return


async def start_pending_email_verification(
    config: RowndPluginConfig,
    session: SessionContainer,
    email: str,
    user_context: UserContext,
) -> JsonDict:
    if config.email_change.get("retirement_mode", "observe") == "guard":
        raise RowndEmailChangeError(
            "EMAIL_CHANGE_DISABLED",
            409,
            "email changes are disabled while email credential retirement guard mode is active",
        )
    user_id = session.get_user_id(user_context)
    tenant_id = session.get_tenant_id(user_context)
    user = await get_user(user_id, user_context)
    if user is None:
        raise RowndPluginError("User not found in Rownd")
    metadata_inspection = await inspect_linked_user_metadata(user.id, user_context)
    metadata = cast(JsonDict, metadata_inspection["primary_metadata"])
    combined_metadata = cast(JsonDict, metadata_inspection["combined_metadata"])
    normalized_email = normalize_email(email)
    if not normalized_email:
        raise RowndEmailChangeError("INVALID_EMAIL", 400, "email must be a non-empty string")
    passwordless_method = find_canonical_passwordless_method(user, combined_metadata, tenant_id)
    tenant_login_methods = [
        method for method in user.login_methods if tenant_id in method.tenant_ids
    ]
    has_passwordless_method = any(
        method.recipe_id == "passwordless" for method in tenant_login_methods
    )
    initiating_login_method = next(
        (
            method
            for method in user.login_methods
            if method.recipe_user_id.get_as_string()
            == session.get_recipe_user_id(user_context).get_as_string()
            and tenant_id in method.tenant_ids
        ),
        None,
    )
    can_add_passwordless = (
        not has_passwordless_method
        and initiating_login_method is not None
        and rownd_compatibility.is_real_third_party_method(initiating_login_method)
        and all(
            rownd_compatibility.is_real_third_party_method(method)
            for method in tenant_login_methods
        )
    )
    if passwordless_method is None and not can_add_passwordless:
        raise RowndEmailChangeError(
            "CONFLICT", 409, "the account has no passwordless sign-in method"
        )
    current_email = as_json_dict(
        (
            await get_rownd_compat_user(
                user_id,
                config,
                tenant_id,
                metadata_override=combined_metadata,
                user_override=user,
                user_context=user_context,
            )
        ).get("data")
    ).get("email")
    pending = get_pending_verifications(metadata)
    pending_email_verifications = [item for item in pending if item.get("field") == "email"]
    if any(item.get("status") == "COMMITTING" for item in pending_email_verifications):
        raise RowndEmailChangeError("CONFLICT", 409, "an email change is already being committed")

    if isinstance(current_email, str) and normalize_email(current_email) == normalized_email:
        for verification in pending_email_verifications:
            await revoke_pending_email_verification_tokens(
                user,
                verification,
                session.get_recipe_user_id(user_context),
                user_context,
            )
        current_passwordless_method = next(
            (
                method
                for method in user.login_methods
                if method.recipe_id == "passwordless"
                and tenant_id in method.tenant_ids
                and method.verified
                and method.email
                and normalize_email(method.email) == normalized_email
            ),
            None,
        )
        updated_metadata = {
            **metadata,
            **(
                {
                    "rownd_email_recipe_user_id": (
                        current_passwordless_method.recipe_user_id.get_as_string()
                    ),
                    "rownd_email_recipe_user_ids": {
                        **as_json_dict(combined_metadata.get("rownd_email_recipe_user_ids")),
                        tenant_id: current_passwordless_method.recipe_user_id.get_as_string(),
                    },
                }
                if current_passwordless_method is not None
                else {}
            ),
            "rownd_pending_verification": [
                item for item in pending if item.get("field") != "email"
            ],
        }
        if pending_email_verifications or current_passwordless_method is not None:
            await update_primary_user_metadata(user_id, updated_metadata, user_context)
        return await get_rownd_compat_user(
            user_id,
            config,
            tenant_id,
            metadata_override={**combined_metadata, **updated_metadata},
            user_override=user,
            user_context=user_context,
        )

    await assert_email_available_for_user(normalized_email, user.id, user_context)
    purpose = "UPDATE_PASSWORDLESS" if passwordless_method else "ADD_PASSWORDLESS"
    verification_recipe_user_id = (
        passwordless_method.recipe_user_id
        if passwordless_method
        else session.get_recipe_user_id(user_context)
    )
    for verification in pending_email_verifications:
        await revoke_pending_email_verification_tokens(
            user,
            verification,
            session.get_recipe_user_id(user_context),
            user_context,
        )

    now = datetime.now(timezone.utc)
    pending_verification_id = str(uuid.uuid4())
    pending_verification: JsonDict = {
        "id": pending_verification_id,
        "field": "email",
        "value": email,
        "created_at": now.isoformat().replace("+00:00", "Z"),
        "tenantId": tenant_id,
        "purpose": purpose,
        "initiatingSessionHandle": session.get_handle(user_context),
        "verificationRecipeUserId": verification_recipe_user_id.get_as_string(),
        "status": "PENDING",
    }
    await update_primary_user_metadata(
        user_id,
        {
            **metadata,
            "rownd_pending_verification": [
                *[item for item in pending if item.get("field") != "email"],
                pending_verification,
            ],
        },
        user_context,
    )

    try:
        await emailverification_asyncio.revoke_email_verification_tokens(
            tenant_id, verification_recipe_user_id, normalized_email, user_context
        )
        await emailverification_asyncio.unverify_email(
            verification_recipe_user_id, normalized_email, user_context
        )
        result = await emailverification_asyncio.send_email_verification_email(
            tenant_id,
            user_id,
            verification_recipe_user_id,
            normalized_email,
            create_pending_email_verification_user_context(
                user_context, pending_verification_id
            ),
        )
        if getattr(result, "status", None) != "OK":
            raise RuntimeError("A fresh email verification could not be created")
    except Exception:
        with suppress(Exception):
            await emailverification_asyncio.revoke_email_verification_tokens(
                tenant_id, verification_recipe_user_id, normalized_email, user_context
            )
        await remove_pending_email_verification(user_id, pending_verification_id, user_context)
        raise
    return await get_rownd_compat_user(
        user_id,
        config,
        tenant_id,
        metadata_override=combined_metadata,
        user_override=user,
        user_context=user_context,
    )


async def resolve_pending_email_verification_token(
    token: str,
    query_pending_verification_id: Optional[str],
    tenant_id: str,
    session: Optional[SessionContainer],
    user_context: UserContext,
) -> Dict[str, str]:
    if query_pending_verification_id is None:
        return {"status": "NOT_PENDING"}
    if session is None:
        return {"status": "INVALID_PENDING"}

    session_handle = session.get_handle(user_context)
    session_user_id = session.get_user_id(user_context)
    session_tenant_id = session.get_tenant_id(user_context)
    if session_tenant_id != tenant_id:
        return {"status": "INVALID_PENDING"}
    session_information = await session_asyncio.get_session_information(
        session_handle, user_context
    )
    if (
        session_information is None
        or session_information.session_handle != session_handle
        or session_information.user_id != session_user_id
        or session_information.tenant_id != session_tenant_id
    ):
        return {"status": "INVALID_PENDING"}

    metadata = await get_raw_user_metadata(session_user_id, user_context)
    pending_verification = next(
        (
            verification
            for verification in get_pending_verifications(metadata)
            if verification.get("id") == query_pending_verification_id
            and verification.get("field") == "email"
            and verification.get("status") == "PENDING"
            and verification.get("initiatingSessionHandle") == session_handle
            and (verification.get("tenantId") or PUBLIC_TENANT_ID) == tenant_id
            and verification.get("purpose") in {"UPDATE_PASSWORDLESS", "ADD_PASSWORDLESS"}
        ),
        None,
    )
    if pending_verification is None:
        return {"status": "INVALID_PENDING"}
    return {
        "status": "OK",
        "core_token": token,
        "pending_verification_id": query_pending_verification_id,
        "user_id": session_user_id,
    }


async def complete_pending_email_verification(
    recipe_user_id: RecipeUserId,
    email: str,
    user_context: UserContext,
    tenant_id: str = PUBLIC_TENANT_ID,
    session_handle: Optional[str] = None,
    pending_verification_id: Optional[str] = None,
    pending_user_id: Optional[str] = None,
) -> Optional[Dict[str, object]]:
    if get_active_rownd_config().email_change.get("retirement_mode", "observe") == "guard":
        raise RowndEmailChangeError(
            "EMAIL_CHANGE_DISABLED",
            409,
            "email changes are disabled while email credential retirement guard mode is active",
        )
    user = await get_user(recipe_user_id.get_as_string(), user_context)
    user_id = user.id if user else recipe_user_id.get_as_string()
    if pending_user_id and user_id != pending_user_id:
        if pending_verification_id:
            await remove_pending_email_verification(
                pending_user_id, pending_verification_id, user_context
            )
        raise RowndEmailChangeError(
            "CONFLICT",
            409,
            "email change session is no longer active; start the email change again",
        )
    primary_mapping = await get_primary_user_mapping(user_id, user_context)
    primary_metadata_user_id = primary_mapping.supertokens_user_id if primary_mapping else user_id
    metadata = await get_raw_user_metadata(primary_metadata_user_id, user_context)
    pending = get_pending_verifications(metadata)
    normalized_email = normalize_email(email)
    pending_verification = next(
        (
            item
            for item in pending
            if (not pending_verification_id or item.get("id") == pending_verification_id)
            and item.get("field") == "email"
            and normalize_email(cast(str, item["value"])) == normalized_email
            and (item.get("tenantId") or PUBLIC_TENANT_ID) == tenant_id
            and (
                not item.get("verificationRecipeUserId")
                or item.get("verificationRecipeUserId") == recipe_user_id.get_as_string()
            )
        ),
        None,
    )
    if not pending_verification:
        if pending_verification_id:
            try:
                await emailverification_asyncio.unverify_email(
                    recipe_user_id, normalized_email, user_context
                )
            finally:
                await remove_pending_email_verification(
                    user_id, pending_verification_id, user_context
                )
            raise RowndEmailChangeError(
                "CONFLICT",
                409,
                "email change session is no longer active; start the email change again",
            )
        return None

    purpose = pending_verification.get("purpose")
    if purpose != "UPDATE_PASSWORDLESS" and purpose != "ADD_PASSWORDLESS":
        await reject_inactive_pending_email_verification(
            user_id, pending_verification, recipe_user_id, normalized_email, user_context
        )

    initiating_session_handle = optional_string(pending_verification.get("initiatingSessionHandle"))
    pending_status = pending_verification.get("status")
    if (
        (pending_status if pending_status is not None else "PENDING") != "PENDING"
        or not initiating_session_handle
        or initiating_session_handle != session_handle
    ):
        await reject_inactive_pending_email_verification(
            user_id, pending_verification, recipe_user_id, normalized_email, user_context
        )

    completion_phase = "PENDING"
    rollback_credential_change: Optional[Callable[[], Awaitable[None]]] = None
    try:
        await assert_email_available_for_user(normalized_email, user_id, user_context)
        initiating_session = await session_asyncio.get_session_information(
            cast(str, initiating_session_handle), user_context
        )
        if (
            initiating_session is None
            or initiating_session.user_id != user_id
            or initiating_session.tenant_id != tenant_id
        ):
            await reject_inactive_pending_email_verification(
                user_id, pending_verification, recipe_user_id, normalized_email, user_context
            )
        current_user = await get_user(user_id, user_context)
        initiating_login_method = (
            next(
                (
                    method
                    for method in current_user.login_methods
                    if method.recipe_user_id.get_as_string()
                    == initiating_session.recipe_user_id.get_as_string()
                    and tenant_id in method.tenant_ids
                ),
                None,
            )
            if current_user
            else None
        )
        if current_user is None or initiating_login_method is None:
            await reject_inactive_pending_email_verification(
                user_id, pending_verification, recipe_user_id, normalized_email, user_context
            )
        passwordless_method = find_pending_passwordless_method(
            current_user, pending_verification, tenant_id
        )
        can_add_passwordless = (
            purpose == "ADD_PASSWORDLESS"
            and all(
                rownd_compatibility.is_real_third_party_method(method)
                for method in current_user.login_methods
                if tenant_id in method.tenant_ids
            )
            and rownd_compatibility.is_real_third_party_method(initiating_login_method)
            and pending_verification.get("verificationRecipeUserId")
            == initiating_login_method.recipe_user_id.get_as_string()
        )
        if (purpose == "UPDATE_PASSWORDLESS" and passwordless_method is None) or (
            purpose == "ADD_PASSWORDLESS" and not can_add_passwordless
        ):
            await reject_inactive_pending_email_verification(
                user_id, pending_verification, recipe_user_id, normalized_email, user_context
            )

        completion_phase = "COMMITTING"
        await mark_pending_email_verification_status(
            user_id, cast(str, pending_verification["id"]), "COMMITTING", user_context
        )
        if not await session_asyncio.revoke_session(
            cast(str, initiating_session_handle), user_context
        ):
            await reject_inactive_pending_email_verification(
                user_id, pending_verification, recipe_user_id, normalized_email, user_context
            )
        initiating_recipe_user_id = initiating_login_method.recipe_user_id
        await session_asyncio.revoke_all_sessions_for_user(user_id, True, None, user_context)
        committing_metadata = await get_raw_user_metadata(user_id, user_context)
        committing_verification = next(
            (
                item
                for item in get_pending_verifications(committing_metadata)
                if item.get("field") == "email"
            ),
            None,
        )
        if (
            committing_verification is None
            or committing_verification.get("id") != pending_verification.get("id")
            or committing_verification.get("status") != "COMMITTING"
        ):
            await reject_inactive_pending_email_verification(
                user_id, pending_verification, recipe_user_id, normalized_email, user_context
            )

        passwordless_user = await passwordless_asyncio.signinup(
            tenant_id,
            normalized_email,
            None,
            None,
            create_derived_user_context(
                user_context, {"rowndDisableAutomaticAccountLinking": True}
            ),
        )
        reuses_linked_method = (
            not passwordless_user.created_new_recipe_user
            and passwordless_user.user.id == user_id
            and any(
                method.recipe_user_id.get_as_string()
                == passwordless_user.recipe_user_id.get_as_string()
                and tenant_id in method.tenant_ids
                for method in passwordless_user.user.login_methods
            )
        )
        if not passwordless_user.created_new_recipe_user and not reuses_linked_method:
            raise email_ownership_conflict()
        if passwordless_user.created_new_recipe_user:

            async def rollback_add() -> None:
                await delete_user(
                    passwordless_user.recipe_user_id.get_as_string(),
                    remove_all_linked_accounts=False,
                    user_context=user_context,
                )

            rollback_credential_change = rollback_add
            await assert_email_available_for_user(
                normalized_email,
                [user_id, passwordless_user.user.id],
                user_context,
            )
            primary_user_id = await ensure_stable_primary_user(
                current_user, initiating_recipe_user_id, user_context
            )
            if primary_user_id != user_id:
                raise RowndEmailChangeError(
                    "CONFLICT", 409, "the account changed before email verification completed"
                )
            link_result = await accountlinking_asyncio.link_accounts(
                passwordless_user.recipe_user_id, primary_user_id, user_context
            )
            if not isinstance(link_result, LinkAccountsOkResult):
                raise email_ownership_conflict()
        canonical_email_recipe_user_id = passwordless_user.recipe_user_id.get_as_string()

        await session_asyncio.revoke_all_sessions_for_user(user_id, True, None, user_context)
        final_metadata_inspection = await inspect_linked_user_metadata(user_id, user_context)
        target_metadata = cast(JsonDict, final_metadata_inspection["primary_metadata"])
        combined_metadata = cast(JsonDict, final_metadata_inspection["combined_metadata"])
        updated_metadata = build_verified_email_metadata(
            target_metadata,
            user_id,
            normalized_email,
            canonical_email_recipe_user_id,
            tenant_id,
            combined_metadata,
        )
        await update_primary_user_metadata(user_id, updated_metadata, user_context)
        completion_phase = "COMPLETED"

        async def rollback_on_session_replacement_failure() -> None:
            rollback_errors: List[Exception] = []
            operations: List[Callable[[], Awaitable[object]]] = []
            if rollback_credential_change:
                operations.append(rollback_credential_change)

            async def unverify() -> None:
                await emailverification_asyncio.unverify_email(
                    recipe_user_id, normalized_email, user_context
                )

            async def restore_metadata() -> None:
                await replace_primary_user_metadata(
                    user_id,
                    {
                        **target_metadata,
                        "rownd_pending_verification": [
                            item
                            for item in get_pending_verifications(target_metadata)
                            if item.get("id") != pending_verification.get("id")
                        ],
                    },
                    user_context,
                )

            async def revoke_sessions() -> None:
                await session_asyncio.revoke_all_sessions_for_user(
                    user_id, True, None, user_context
                )

            operations.extend([unverify, restore_metadata, revoke_sessions])
            for operation in operations:
                try:
                    await operation()
                except Exception as rollback_error:
                    rollback_errors.append(rollback_error)
            if rollback_errors:
                log_debug(
                    get_active_rownd_config(),
                    "Email change replacement-session rollback failed for user %s; "
                    "reconciliation required. Errors: %s"
                    % (user_id, "; ".join(str(error) for error in rollback_errors)),
                )
                raise RowndEmailChangeError(
                    "CONFLICT",
                    409,
                    "email change rollback failed; account reconciliation is required",
                )

        return {
            "user_id": user_id,
            "recipe_user_id": passwordless_user.recipe_user_id,
            "initiating_session_handle": initiating_session_handle,
            "replace_session": True,
            "rollback_on_session_replacement_failure": (rollback_on_session_replacement_failure),
        }
    except Exception as error:
        if completion_phase != "COMPLETED":
            rollback_error: Optional[Exception] = None
            if rollback_credential_change:
                try:
                    await rollback_credential_change()
                except Exception as caught_rollback_error:
                    rollback_error = caught_rollback_error
            if completion_phase == "COMMITTING":
                await asyncio.gather(
                    session_asyncio.revoke_all_sessions_for_user(user_id, True, None, user_context),
                    return_exceptions=True,
                )
            if rollback_error is not None:
                log_debug(
                    get_active_rownd_config(),
                    "Email change rollback failed for user %s; reconciliation required. Error: %s"
                    % (user_id, rollback_error),
                )
                raise RowndEmailChangeError(
                    "CONFLICT",
                    409,
                    "email change rollback failed; account reconciliation is required",
                ) from rollback_error
            cleanup_failed = False
            try:
                await cleanup_pending_email_verification(
                    user_id,
                    pending_verification,
                    recipe_user_id,
                    normalized_email,
                    user_context,
                )
            except Exception:
                cleanup_failed = True
            if completion_phase == "COMMITTING" and cleanup_failed:
                with suppress(Exception):
                    await mark_pending_email_verification_status(
                        user_id,
                        cast(str, pending_verification["id"]),
                        "PENDING",
                        user_context,
                    )
        raise error


def get_pending_verifications(metadata: JsonDict) -> List[JsonDict]:
    return [
        item
        for item in as_json_list(metadata.get("rownd_pending_verification"))
        if all(isinstance(item.get(key), str) for key in ("id", "field", "value", "created_at"))
    ]


def normalize_email(email: str) -> str:
    return email.strip().lower()


def _nonempty_string(value: object) -> Optional[str]:
    return value if isinstance(value, str) and bool(value.strip()) else None


def parse_tenant_pending_email_verifications(
    metadata: JsonDict, tenant_id: str
) -> Union[
    tuple[ParsedPendingEmailVerification | ParsedCommittingEmailVerification, ...],
    EmailCredentialAuthorization,
]:
    if "rownd_pending_verification" not in metadata:
        return ()
    raw_pending = metadata["rownd_pending_verification"]
    if not isinstance(raw_pending, list):
        return EmailCredentialAuthorization(
            EmailCredentialState.MALFORMED, EmailCredentialReason.SECURITY_METADATA
        )

    parsed: List[ParsedPendingEmailVerification | ParsedCommittingEmailVerification] = []
    for raw in raw_pending:
        if not isinstance(raw, dict):
            return EmailCredentialAuthorization(
                EmailCredentialState.MALFORMED, EmailCredentialReason.SECURITY_METADATA
            )
        raw_tenant_value = raw.get("tenantId", PUBLIC_TENANT_ID)
        raw_tenant = _nonempty_string(raw_tenant_value)
        if raw_tenant is None or raw_tenant != raw_tenant.strip():
            return EmailCredentialAuthorization(
                EmailCredentialState.MALFORMED, EmailCredentialReason.SECURITY_METADATA
            )
        if raw_tenant != tenant_id:
            continue
        field = raw.get("field")
        if field != "email":
            continue
        operation_id = _nonempty_string(raw.get("id"))
        normalized_value = _nonempty_string(raw.get("normalizedEmail"))
        legacy_value = _nonempty_string(raw.get("value"))
        value = normalized_value or legacy_value
        purpose = raw.get("purpose")
        verification_id = _nonempty_string(raw.get("verificationRecipeUserId"))
        created_at = _nonempty_string(raw.get("created_at"))
        status = raw.get("status", "PENDING")
        if (
            operation_id is None
            or value is None
            or purpose not in {"UPDATE_PASSWORDLESS", "ADD_PASSWORDLESS"}
            or verification_id is None
            or created_at is None
            or status not in {"PENDING", "COMMITTING"}
        ):
            return EmailCredentialAuthorization(
                EmailCredentialState.MALFORMED, EmailCredentialReason.SECURITY_METADATA
            )
        normalized = normalize_email(value)
        if (
            not normalized
            or (normalized_value is not None and normalized_value != normalized)
            or (
                normalized_value is not None
                and legacy_value is not None
                and normalize_email(legacy_value) != normalized_value
            )
        ):
            return EmailCredentialAuthorization(
                EmailCredentialState.MALFORMED, EmailCredentialReason.SECURITY_METADATA
            )
        if status == "PENDING":
            if not _nonempty_string(raw.get("initiatingSessionHandle")):
                return EmailCredentialAuthorization(
                    EmailCredentialState.MALFORMED, EmailCredentialReason.SECURITY_METADATA
                )
            parsed.append(
                ParsedPendingEmailVerification(
                    operation_id, tenant_id, normalized, cast(Any, purpose), verification_id
                )
            )
            continue

        target_id = _nonempty_string(raw.get("targetCanonicalRecipeUserId"))
        initiating_recipe_user_id = _nonempty_string(raw.get("initiatingRecipeUserId"))
        initiating_session_handle = _nonempty_string(raw.get("initiatingSessionHandle"))
        retired = raw.get("retiredMethods")
        if (
            raw.get("schemaVersion") != 2
            or target_id is None
            or initiating_recipe_user_id is None
            or initiating_session_handle is None
            or not isinstance(retired, list)
        ):
            return EmailCredentialAuthorization(
                EmailCredentialState.MALFORMED, EmailCredentialReason.SECURITY_METADATA
            )
        retired_methods: List[tuple[str, str]] = []
        for method in retired:
            if not isinstance(method, dict):
                return EmailCredentialAuthorization(
                    EmailCredentialState.MALFORMED, EmailCredentialReason.SECURITY_METADATA
                )
            retired_id = _nonempty_string(method.get("recipeUserId"))
            retired_email = _nonempty_string(method.get("normalizedEmail"))
            if retired_id is None or retired_email is None or normalize_email(retired_email) != retired_email:
                return EmailCredentialAuthorization(
                    EmailCredentialState.MALFORMED, EmailCredentialReason.SECURITY_METADATA
                )
            retired_methods.append((retired_id, retired_email))
        retired_ids = [recipe_user_id for recipe_user_id, _ in retired_methods]
        if target_id in retired_ids or len(retired_ids) != len(set(retired_ids)):
            return EmailCredentialAuthorization(
                EmailCredentialState.MALFORMED, EmailCredentialReason.SECURITY_METADATA
            )
        parsed.append(
            ParsedCommittingEmailVerification(
                operation_id,
                tenant_id,
                normalized,
                cast(Any, purpose),
                verification_id,
                initiating_recipe_user_id,
                initiating_session_handle,
                target_id,
                tuple(retired_methods),
            )
        )
    return tuple(parsed)


def classify_email_credential(
    user: User,
    metadata: JsonDict,
    tenant_id: str,
    email: str,
    consumed_recipe_user_id: Optional[str] = None,
) -> EmailCredentialAuthorization:
    normalized_email = normalize_email(email)
    methods = [
        method
        for method in user.login_methods
        if method.recipe_id == "passwordless"
        and tenant_id in method.tenant_ids
        and bool(method.email)
    ]
    method_ids = [method.recipe_user_id.get_as_string() for method in methods]
    if len(method_ids) != len(set(method_ids)) or any(
        not method.verified or not normalize_email(cast(str, method.email)) for method in methods
    ):
        return EmailCredentialAuthorization(
            EmailCredentialState.MALFORMED,
            EmailCredentialReason.CANONICAL_TOPOLOGY,
            user.id,
        )

    canonical_map_present = "rownd_email_recipe_user_ids" in metadata
    canonical_id: Optional[str]
    if canonical_map_present:
        canonical_map = metadata["rownd_email_recipe_user_ids"]
        if not isinstance(canonical_map, dict):
            return EmailCredentialAuthorization(
                EmailCredentialState.MALFORMED,
                EmailCredentialReason.SECURITY_METADATA,
                user.id,
            )
        raw_canonical = canonical_map.get(tenant_id)
        if raw_canonical is not None and _nonempty_string(raw_canonical) is None:
            return EmailCredentialAuthorization(
                EmailCredentialState.MALFORMED,
                EmailCredentialReason.SECURITY_METADATA,
                user.id,
            )
        canonical_id = cast(Optional[str], raw_canonical)
    else:
        raw_canonical = metadata.get("rownd_email_recipe_user_id")
        if raw_canonical is not None and _nonempty_string(raw_canonical) is None:
            return EmailCredentialAuthorization(
                EmailCredentialState.MALFORMED,
                EmailCredentialReason.SECURITY_METADATA,
                user.id,
            )
        canonical_id = cast(Optional[str], raw_canonical)

    pending = parse_tenant_pending_email_verifications(metadata, tenant_id)
    if isinstance(pending, EmailCredentialAuthorization):
        return EmailCredentialAuthorization(pending.state, pending.reason, user.id)
    committing = [item for item in pending if isinstance(item, ParsedCommittingEmailVerification)]
    if len(committing) > 1:
        return EmailCredentialAuthorization(
            EmailCredentialState.AMBIGUOUS, EmailCredentialReason.SECURITY_METADATA, user.id
        )
    methods_by_id = {
        method.recipe_user_id.get_as_string(): normalize_email(cast(str, method.email))
        for method in methods
    }
    if committing:
        plan = committing[0]
        expected_retired = {
            (method_id, method_email)
            for method_id, method_email in methods_by_id.items()
            if method_id != plan.target_canonical_recipe_user_id
        }
        if (
            canonical_id != plan.target_canonical_recipe_user_id
            or plan.initiating_recipe_user_id != plan.verification_recipe_user_id
            or methods_by_id.get(plan.target_canonical_recipe_user_id) != plan.normalized_email
            or set(plan.retired_methods) != expected_retired
        ):
            return EmailCredentialAuthorization(
                EmailCredentialState.MALFORMED,
                EmailCredentialReason.CANONICAL_TOPOLOGY,
                user.id,
            )
        if plan.purpose == "UPDATE_PASSWORDLESS":
            if plan.initiating_recipe_user_id not in {
                method_id for method_id, _ in plan.retired_methods
            }:
                return EmailCredentialAuthorization(
                    EmailCredentialState.MALFORMED,
                    EmailCredentialReason.CANONICAL_TOPOLOGY,
                    user.id,
                )
        else:
            initiating_method = next(
                (
                    method
                    for method in user.login_methods
                    if tenant_id in method.tenant_ids
                    and method.recipe_user_id.get_as_string() == plan.initiating_recipe_user_id
                    and method.recipe_user_id.get_as_string()
                    != plan.target_canonical_recipe_user_id
                ),
                None,
            )
            if (
                initiating_method is None
                or not rownd_compatibility.is_real_third_party_method(initiating_method)
                or len(methods) != 1
                or bool(plan.retired_methods)
            ):
                return EmailCredentialAuthorization(
                    EmailCredentialState.MALFORMED,
                    EmailCredentialReason.CANONICAL_TOPOLOGY,
                    user.id,
                )
        matching = [
            method
            for method in methods
            if normalize_email(cast(str, method.email)) == normalized_email
        ]
        if len(matching) != 1:
            return EmailCredentialAuthorization(
                EmailCredentialState.MALFORMED,
                EmailCredentialReason.METHOD_MISMATCH,
                user.id,
            )
        matching_id = matching[0].recipe_user_id.get_as_string()
        if consumed_recipe_user_id is not None and consumed_recipe_user_id != matching_id:
            return EmailCredentialAuthorization(
                EmailCredentialState.MALFORMED,
                EmailCredentialReason.METHOD_MISMATCH,
                user.id,
                matching_id,
            )
        if matching_id == plan.target_canonical_recipe_user_id:
            return EmailCredentialAuthorization(
                EmailCredentialState.TARGET_COMMITTING,
                EmailCredentialReason.COMMITTING_TARGET,
                user.id,
                matching_id,
            )
        return EmailCredentialAuthorization(
            EmailCredentialState.RETIRED,
            EmailCredentialReason.NONCANONICAL,
            user.id,
            matching_id,
        )

    if canonical_id is None:
        if not methods:
            if consumed_recipe_user_id is not None:
                return EmailCredentialAuthorization(
                    EmailCredentialState.MALFORMED,
                    EmailCredentialReason.METHOD_MISMATCH,
                    user.id,
                )
            return EmailCredentialAuthorization(
                EmailCredentialState.ALLOW,
                EmailCredentialReason.NO_OWNER,
                user.id,
            )
        if len(methods) > 1:
            return EmailCredentialAuthorization(
                EmailCredentialState.AMBIGUOUS,
                EmailCredentialReason.CANONICAL_TOPOLOGY,
                user.id,
            )
        canonical_id = method_ids[0] if method_ids else None
    if canonical_id not in method_ids:
        return EmailCredentialAuthorization(
            EmailCredentialState.MALFORMED,
            EmailCredentialReason.CANONICAL_TOPOLOGY,
            user.id,
        )

    matching = [method for method in methods if normalize_email(cast(str, method.email)) == normalized_email]
    if len(matching) != 1:
        return EmailCredentialAuthorization(
            EmailCredentialState.MALFORMED,
            EmailCredentialReason.METHOD_MISMATCH,
            user.id,
        )
    matching_id = matching[0].recipe_user_id.get_as_string()
    if consumed_recipe_user_id is not None and consumed_recipe_user_id != matching_id:
        return EmailCredentialAuthorization(
            EmailCredentialState.MALFORMED,
            EmailCredentialReason.METHOD_MISMATCH,
            user.id,
            matching_id,
        )
    if matching_id == canonical_id:
        return EmailCredentialAuthorization(
            EmailCredentialState.ALLOW,
            EmailCredentialReason.CANONICAL,
            user.id,
            matching_id,
        )
    return EmailCredentialAuthorization(
        EmailCredentialState.RETIRED,
        EmailCredentialReason.NONCANONICAL,
        user.id,
        matching_id,
    )


async def authorize_passwordless_email(
    tenant_id: str,
    email: str,
    user_context: UserContext,
    consumed_recipe_user_id: Optional[str] = None,
    expected_owner_user_id: Optional[str] = None,
) -> EmailCredentialAuthorization:
    normalized_email = normalize_email(email)
    if not normalized_email:
        return EmailCredentialAuthorization(
            EmailCredentialState.MALFORMED, EmailCredentialReason.METHOD_MISMATCH
        )
    owners = await list_users_by_account_info(
        tenant_id, AccountInfoInput(email=normalized_email), False, user_context
    )
    owners_by_id = {owner.id: owner for owner in owners}
    if not owners_by_id:
        if consumed_recipe_user_id is not None:
            return EmailCredentialAuthorization(
                EmailCredentialState.MALFORMED, EmailCredentialReason.OWNER_CHANGED
            )
        return EmailCredentialAuthorization(
            EmailCredentialState.ALLOW, EmailCredentialReason.NO_OWNER
        )
    if len(owners_by_id) != 1:
        return EmailCredentialAuthorization(
            EmailCredentialState.AMBIGUOUS, EmailCredentialReason.MULTIPLE_OWNERS
        )
    owner = next(iter(owners_by_id.values()))
    inspection = await inspect_linked_user_metadata(owner.id, user_context, owner)
    inspected_user = cast(Optional[User], inspection["user"])
    primary_user_id = cast(str, inspection["primary_user_id"])
    expected_primary_user_id = expected_owner_user_id
    if expected_owner_user_id is not None:
        expected_mapping = await get_primary_user_mapping(expected_owner_user_id, user_context)
        if expected_mapping is not None:
            expected_primary_user_id = expected_mapping.supertokens_user_id
    if (
        inspected_user is None
        or (expected_primary_user_id is not None and primary_user_id != expected_primary_user_id)
    ):
        return EmailCredentialAuthorization(
            EmailCredentialState.MALFORMED, EmailCredentialReason.OWNER_CHANGED, primary_user_id
        )
    result = classify_email_credential(
        inspected_user,
        cast(JsonDict, inspection["primary_metadata"]),
        tenant_id,
        normalized_email,
        consumed_recipe_user_id,
    )
    return EmailCredentialAuthorization(
        result.state, result.reason, primary_user_id, result.recipe_user_id
    )


async def resolve_passwordless_device_email(
    tenant_id: str,
    pre_auth_session_id: str,
    user_context: UserContext,
    device_id: Optional[str] = None,
) -> Optional[str]:
    by_pre_auth = await passwordless_asyncio.list_codes_by_pre_auth_session_id(
        tenant_id, pre_auth_session_id, user_context
    )
    if by_pre_auth is None:
        return None
    if device_id is not None:
        by_device = await passwordless_asyncio.list_codes_by_device_id(
            tenant_id, device_id, user_context
        )
        if by_device is None or by_device.pre_auth_session_id != by_pre_auth.pre_auth_session_id:
            return None
        if by_device.email != by_pre_auth.email or by_device.phone_number != by_pre_auth.phone_number:
            return None
    has_email = isinstance(by_pre_auth.email, str) and bool(by_pre_auth.email)
    has_phone = isinstance(by_pre_auth.phone_number, str) and bool(by_pre_auth.phone_number)
    if has_email == has_phone:
        return None
    return by_pre_auth.email if has_email else ""


def get_passwordless_email_login_methods(login_methods: List[LoginMethod]) -> List[LoginMethod]:
    return [
        method
        for method in login_methods
        if method.recipe_id == "passwordless" and bool(method.email)
    ]


def get_account_tenant_ids(user: User, current_tenant_id: str) -> List[str]:
    return list(
        dict.fromkeys(
            [current_tenant_id]
            + [tenant for method in user.login_methods for tenant in method.tenant_ids]
        )
    )


async def rollback_tenant_associations(
    tenant_ids: List[str], recipe_user_id: RecipeUserId, user_context: UserContext
) -> None:
    await asyncio.gather(
        *(
            multitenancy_asyncio.disassociate_user_from_tenant(
                tenant_id, recipe_user_id, user_context
            )
            for tenant_id in tenant_ids
        )
    )


async def associate_recipe_user_to_tenants(
    tenant_ids: List[str], recipe_user_id: RecipeUserId, user_context: UserContext
) -> List[str]:
    newly_associated: List[str] = []
    unknown_outcome: Optional[str] = None
    try:
        for tenant_id in tenant_ids:
            unknown_outcome = tenant_id
            result = await multitenancy_asyncio.associate_user_to_tenant(
                tenant_id, recipe_user_id, user_context
            )
            unknown_outcome = None
            if getattr(result, "status", None) != "OK":
                raise email_ownership_conflict()
            if not getattr(result, "was_already_associated", False):
                newly_associated.append(tenant_id)
        return newly_associated
    except Exception:
        await rollback_tenant_associations(
            list(dict.fromkeys(newly_associated + ([unknown_outcome] if unknown_outcome else []))),
            recipe_user_id,
            user_context,
        )
        raise


def get_verification_recipe_user_ids(
    user: User, verification: JsonDict, fallback: RecipeUserId
) -> List[RecipeUserId]:
    verification_recipe_user_id = verification.get("verificationRecipeUserId")
    method = next(
        (
            method
            for method in user.login_methods
            if method.recipe_user_id.get_as_string() == verification_recipe_user_id
        ),
        None,
    )
    if method:
        return [method.recipe_user_id]
    return list(
        {
            recipe_user_id.get_as_string(): recipe_user_id
            for recipe_user_id in [
                *(login_method.recipe_user_id for login_method in user.login_methods),
                fallback,
            ]
        }.values()
    )


async def revoke_pending_email_verification_tokens(
    user: User,
    verification: JsonDict,
    fallback: RecipeUserId,
    user_context: UserContext,
) -> None:
    await asyncio.gather(
        *(
            emailverification_asyncio.revoke_email_verification_tokens(
                cast(str, verification.get("tenantId") or PUBLIC_TENANT_ID),
                recipe_user_id,
                cast(str, verification["value"]),
                user_context,
            )
            for recipe_user_id in get_verification_recipe_user_ids(user, verification, fallback)
        )
    )


async def assert_email_available_for_user(
    email: str, allowed_user_ids: Union[str, List[str]], user_context: UserContext
) -> None:
    allowed_ids = {allowed_user_ids} if isinstance(allowed_user_ids, str) else set(allowed_user_ids)
    tenants = await multitenancy_asyncio.list_all_tenants(user_context)
    tenant_ids = list(
        dict.fromkeys([PUBLIC_TENANT_ID] + [tenant.tenant_id for tenant in tenants.tenants])
    )
    owners_by_tenant = await asyncio.gather(
        *(
            list_users_by_account_info(
                tenant_id, AccountInfoInput(email=email), False, user_context
            )
            for tenant_id in tenant_ids
        )
    )
    if any(owner.id not in allowed_ids for owners in owners_by_tenant for owner in owners):
        raise email_ownership_conflict()


def email_ownership_conflict() -> RowndEmailChangeError:
    return RowndEmailChangeError("CONFLICT", 409, "email cannot be used for this account")


def find_pending_passwordless_method(
    user: Optional[User], pending_verification: JsonDict, tenant_id: str
) -> Optional[LoginMethod]:
    if user is None:
        return None
    if pending_verification.get("purpose") != "UPDATE_PASSWORDLESS" or not pending_verification.get(
        "verificationRecipeUserId"
    ):
        return None
    pending_recipe_user_id = pending_verification.get("verificationRecipeUserId")
    method = next(
        (
            method
            for method in user.login_methods
            if method.recipe_id == "passwordless"
            and method.recipe_user_id.get_as_string() == pending_recipe_user_id
        ),
        None,
    )
    return (
        method
        if method is not None
        and tenant_id in method.tenant_ids
        and method.recipe_user_id.get_as_string() == pending_recipe_user_id
        else None
    )


def find_canonical_passwordless_method(
    user: User, metadata: JsonDict, tenant_id: str
) -> Optional[LoginMethod]:
    passwordless_methods = [
        method
        for method in user.login_methods
        if method.recipe_id == "passwordless" and tenant_id in method.tenant_ids
    ]
    canonical_recipe_user_id = rownd_compatibility.get_canonical_email_recipe_user_id(
        metadata, tenant_id
    )
    if canonical_recipe_user_id:
        canonical_method = next(
            (
                method
                for method in passwordless_methods
                if method.recipe_user_id.get_as_string() == canonical_recipe_user_id
            ),
            None,
        )
        if canonical_method is None:
            raise RowndEmailChangeError(
                "CONFLICT", 409, "the canonical email sign-in method is invalid"
            )
        return canonical_method
    if len(passwordless_methods) > 1:
        raise RowndEmailChangeError(
            "AMBIGUOUS",
            409,
            "the account has multiple email sign-in methods without a canonical method",
        )
    return passwordless_methods[0] if passwordless_methods else None


async def ensure_stable_primary_user(
    user: Optional[User], anchor: RecipeUserId, user_context: UserContext
) -> str:
    if user is None:
        raise RowndPluginError("User not found in Rownd")
    if user.is_primary_user:
        return user.id
    result = await accountlinking_asyncio.create_primary_user(anchor, user_context)
    if isinstance(result, CreatePrimaryUserOkResult):
        return result.user.id
    if isinstance(result, CreatePrimaryUserRecipeUserIdAlreadyLinkedError):
        return result.primary_user_id
    raise email_ownership_conflict()


async def remove_pending_email_verification(
    user_id: str, pending_id: str, user_context: UserContext
) -> None:
    metadata = await get_raw_user_metadata(user_id, user_context)
    await update_primary_user_metadata(
        user_id,
        {
            "rownd_pending_verification": [
                item for item in get_pending_verifications(metadata) if item.get("id") != pending_id
            ]
        },
        user_context,
    )


async def mark_pending_email_verification_status(
    user_id: str, pending_id: str, status: str, user_context: UserContext
) -> None:
    metadata = await get_raw_user_metadata(user_id, user_context)
    await update_primary_user_metadata(
        user_id,
        {
            "rownd_pending_verification": [
                {**item, "status": status} if item.get("id") == pending_id else item
                for item in get_pending_verifications(metadata)
            ]
        },
        user_context,
    )


async def cleanup_pending_email_verification(
    user_id: str,
    pending_verification: JsonDict,
    recipe_user_id: RecipeUserId,
    email: str,
    user_context: UserContext,
) -> None:
    await emailverification_asyncio.unverify_email(recipe_user_id, email, user_context)
    await remove_pending_email_verification(
        user_id, cast(str, pending_verification["id"]), user_context
    )


async def reject_inactive_pending_email_verification(
    user_id: str,
    pending_verification: JsonDict,
    recipe_user_id: RecipeUserId,
    email: str,
    user_context: UserContext,
) -> NoReturn:
    await cleanup_pending_email_verification(
        user_id, pending_verification, recipe_user_id, email, user_context
    )
    raise RowndEmailChangeError(
        "CONFLICT",
        409,
        "email change session is no longer active; start the email change again",
    )


def build_verified_email_metadata(
    metadata: JsonDict,
    user_id: str,
    email: str,
    canonical_email_recipe_user_id: str,
    tenant_id: str,
    fallback_metadata: Optional[JsonDict] = None,
) -> JsonDict:
    fallback_metadata = fallback_metadata or {}
    compatibility_user = (
        as_json_dict(metadata.get("original_rownd_user"))
        or as_json_dict(fallback_metadata.get("original_rownd_user"))
        or {
            "state": "enabled",
            "auth_level": "verified",
            "data": {"user_id": user_id},
            "verified_data": {},
            "groups": [],
            "meta": {},
        }
    )
    compatibility_data = as_json_dict(compatibility_user.get("data"))
    return {
        **metadata,
        "original_rownd_user": {
            **compatibility_user,
            "data": {
                **compatibility_data,
                "user_id": compatibility_data.get("user_id") or user_id,
                "email": email,
            },
            "verified_data": {
                **as_json_dict(compatibility_user.get("verified_data")),
                "email": email,
            },
        },
        "rownd_email_recipe_user_id": canonical_email_recipe_user_id,
        "rownd_email_recipe_user_ids": {
            **as_json_dict(fallback_metadata.get("rownd_email_recipe_user_ids")),
            **as_json_dict(metadata.get("rownd_email_recipe_user_ids")),
            tenant_id: canonical_email_recipe_user_id,
        },
        "rownd_pending_verification": [
            item for item in get_pending_verifications(metadata) if item.get("field") != "email"
        ],
    }

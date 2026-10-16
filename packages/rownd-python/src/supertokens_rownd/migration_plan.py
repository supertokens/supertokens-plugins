from __future__ import annotations

import asyncio
import hashlib
import json
from contextlib import suppress
from dataclasses import dataclass
from typing import Awaitable, Callable, Literal, Optional, TYPE_CHECKING

from supertokens_python.framework.request import BaseRequest
from supertokens_python.framework.response import BaseResponse
from supertokens_python.types import RecipeUserId, User
from supertokens_python.types.base import UserContext

from .constants import DEFAULT_ROWND_SCHEMA
from .errors import MigrationError, MigrationErrorReason
from .migration import PinnedMigrationTarget, MigrationTargetSource, validate_migration_metadata
from .migration_authority import assert_source_authority, has_authenticated_source
from .session_authentication import proven_session_authentication
from .types import JsonDict, RowndPluginConfig

if TYPE_CHECKING:
    from .supertokens_repository import FreshMigrationSource


_CANCELLATION_CLEANUP_TIMEOUT = 5.0


def _ordinary_metadata(record: JsonDict, source: FreshMigrationSource) -> bool:
    from . import supertokens_repository as repo

    allowed = {"rownd_migration_complete", "rownd_email_recipe_user_id",
               "rownd_email_recipe_user_ids", "rownd_pending_verification"}
    if any(key.startswith("rownd_") and key not in allowed for key in record):
        return False
    if not validate_migration_metadata(record, source.snapshot.tenant_id).valid:
        return False
    if "original_rownd_user" in record and record["original_rownd_user"] != source.rownd_user:
        return False
    if "rownd_migration_complete" in record and record["rownd_migration_complete"] is not True:
        return False
    legacy = record.get("rownd_email_recipe_user_id")
    scoped = record.get("rownd_email_recipe_user_ids")
    if legacy is not None and isinstance(scoped, dict) and scoped.get(source.snapshot.tenant_id, legacy) != legacy:
        return False
    pending = repo.parse_tenant_pending_email_verifications(record, source.snapshot.tenant_id)
    return isinstance(pending, tuple) and not pending and not record.get("rownd_pending_verification")


def _debt_ids(target: str, tenant: str) -> tuple[str, str]:
    from .provider_migration import _ledger_id

    return ("rownd-email-retirement-" + hashlib.sha256((target + "\0" + tenant).encode()).hexdigest(),
            _ledger_id(target, tenant))


async def _read_literal_metadata(identifier: str, context: UserContext) -> Optional[JsonDict]:
    from . import supertokens_repository as repo

    result = await repo.usermetadata_asyncio.get_user_metadata(identifier, context)
    # Unknown is not evidence of an empty literal record.
    return result.metadata if isinstance(result.metadata, dict) else None


@dataclass(frozen=True)
class _OrdinarySnapshot:
    target: str
    source_id: str
    tenant: str
    user_json: str
    metadata_json: str
    mappings: tuple[tuple[str, str, Optional[tuple[str, str]]], ...]
    records: tuple[tuple[str, str], ...]
    contacts: tuple[tuple[str, tuple[str, ...]], ...]
    recipe: str

    def user(self) -> User:
        return User.from_json(json.loads(self.user_json))


async def read_ordinary_snapshot(
    config: RowndPluginConfig, source: FreshMigrationSource, context: UserContext,
) -> Optional[_OrdinarySnapshot]:
    """Read one bounded phase using only the SDK's ordinary GET cache."""
    from . import supertokens_repository as repo

    assert_source_authority(source)
    if (not has_authenticated_source(source) or source.snapshot.app_variant_id is not None
            or config.schema != DEFAULT_ROWND_SCHEMA):
        return None
    rownd_id, tenant = source.snapshot.rownd_user_id, source.snapshot.tenant_id
    mappings = {}

    async def mapping(identifier: str, role: Literal["EXTERNAL", "SUPERTOKENS"]):
        value = repo._mapping_lookup(await repo.get_user_id_mapping(identifier, role, context))
        pair = (value.supertokens_user_id, value.external_user_id) if value else None
        mappings[identifier, role] = pair
        return pair

    source_record = await _read_literal_metadata(rownd_id, context)
    if source_record is None:
        return None
    if "rownd_migration_superseded" in source_record:
        raise MigrationError(MigrationErrorReason.IDENTITY_OWNED_BY_ANOTHER_USER, "state_inspect")
    if not _ordinary_metadata(source_record, source):
        return None
    user = await repo.get_user(rownd_id, context)
    if user is None or len(user.login_methods) > 8:
        return None
    forward = await mapping(rownd_id, "EXTERNAL")
    if forward is None:
        return None
    target = forward[0]
    if target == rownd_id:
        return None
    ids = {target, rownd_id, *(method.recipe_user_id.get_as_string() for method in user.login_methods)}
    records = {rownd_id: source_record}
    for identifier in sorted(ids - {rownd_id}):
        record = await _read_literal_metadata(identifier, context)
        if record is None:
            return None
        records[identifier] = record
    # Stop before identity discovery for administrative or uncertain state.
    if any(not _ordinary_metadata(record, source) for record in records.values()):
        return None
    for identifier in sorted(ids):
        for role in ("EXTERNAL", "SUPERTOKENS"):
            if (identifier, role) not in mappings:
                await mapping(identifier, role)
    for identifier in _debt_ids(target, tenant):
        record = await _read_literal_metadata(identifier, context)
        if record is None or record:
            return None
        records[identifier] = record
    contacts = []
    for identity in source.snapshot.expected_identities:
        if identity.identifier_type in {"email", "phone"}:
            owners = await repo._get_migration_identity_users(identity, tenant, context)
            if len(owners) > 8:
                return None
            contacts.append((identity.key, tuple(json.dumps(owner.to_json()) for owner in owners)))
    metadata = repo.combine_linked_metadata(
        target, records[target], [(identifier, records[identifier]) for identifier in sorted(ids) if identifier != target], rownd_id,
    )["combined_metadata"]
    email = next((identity for identity in source.snapshot.expected_identities if identity.identifier_type == "email"), None)
    method = next((method for method in sorted(user.login_methods, key=lambda item: item.recipe_user_id.get_as_string())
                   if tenant in method.tenant_ids and any(repo._migration_method_matches_identity(method, identity)
                   for identity in ((email,) if email else source.snapshot.expected_identities))), None)
    if method is None:
        return None
    result = _OrdinarySnapshot(target, rownd_id, tenant, json.dumps(user.to_json()), json.dumps(metadata),
        tuple((identifier, role, pair) for (identifier, role), pair in sorted(mappings.items())),
        tuple((identifier, json.dumps(record)) for identifier, record in sorted(records.items())),
        tuple(contacts), method.recipe_user_id.get_as_string())
    return result if _validate_ordinary_snapshot(source, result) else None


def _validate_ordinary_snapshot(source: FreshMigrationSource, state: _OrdinarySnapshot) -> bool:
    from . import supertokens_repository as repo

    assert_source_authority(source)
    if not has_authenticated_source(source):
        return False
    user = state.user()
    mappings = {(identifier, role): pair for identifier, role, pair in state.mappings}
    literal_ids = {state.target, state.source_id, *(method.recipe_user_id.get_as_string() for method in user.login_methods)}
    if set(mappings) != {(identifier, role) for identifier in literal_ids for role in ("EXTERNAL", "SUPERTOKENS")}:
        return False
    expected = (state.target, state.source_id)
    if (state.source_id != source.snapshot.rownd_user_id or state.tenant != source.snapshot.tenant_id
            or not user.is_primary_user or user.id not in {state.source_id, state.target}
            or mappings.get((state.source_id, "EXTERNAL")) != expected
            or mappings.get((state.target, "SUPERTOKENS")) != expected):
        return False
    for identifier, role, pair in state.mappings:
        if (identifier, role) not in {(state.source_id, "EXTERNAL"), (state.target, "SUPERTOKENS")} and pair is not None:
            return False
    metadata = json.loads(state.metadata_json)
    records = {identifier: json.loads(value) for identifier, value in state.records}
    if set(records) != literal_ids | set(_debt_ids(state.target, state.tenant)):
        return False
    if records[state.target].get("rownd_migration_complete") is not True or metadata.get("original_rownd_user") != source.rownd_user:
        return False
    for identifier, record in records.items():
        if not _ordinary_metadata(record, source) or (identifier not in literal_ids and record):
            return False
    identities = source.snapshot.expected_identities
    contacts = dict(state.contacts)
    if set(contacts) != {identity.key for identity in identities if identity.identifier_type in {"email", "phone"}}:
        return False
    for identity in identities:
        matches = [method for method in user.login_methods if state.tenant in method.tenant_ids
                   and repo._migration_method_matches_identity(method, identity)]
        if len(matches) != 1 or (identity.recipe_id == "passwordless" and identity.verified and not matches[0].verified):
            return False
        if identity.identifier_type == "email":
            recipe = matches[0].recipe_user_id.get_as_string()
            if repo.rownd_compatibility.get_canonical_email_recipe_user_id(metadata, state.tenant) != recipe:
                return False
            if any(repo.rownd_compatibility.get_canonical_email_recipe_user_id(record, state.tenant) not in {None, recipe} for record in records.values()):
                return False
        for value in contacts.get(identity.key, ()):
            owner = User.from_json(json.loads(value))
            if owner.id not in {state.target, state.source_id} and any(
                state.tenant in method.tenant_ids and repo._migration_method_reserves_identity(method, identity) for method in owner.login_methods
            ):
                raise MigrationError(MigrationErrorReason.IDENTITY_OWNED_BY_ANOTHER_USER, "state_inspect")
    if not any(identity.identifier_type == "email" for identity in identities) and any(
        repo.rownd_compatibility.get_canonical_email_recipe_user_id(record, state.tenant) is not None for record in records.values()
    ):
        return False
    return (bool(identities) and any(method.recipe_user_id.get_as_string() == state.recipe
            and state.tenant in method.tenant_ids for method in user.login_methods)
            and all(any(repo._migration_method_matches_identity(method, identity) for identity in identities)
                    for method in user.login_methods if state.tenant in method.tenant_ids))


async def _finish_cancelled_session_cleanup(revoke: Callable[[], Awaitable[None]]) -> None:
    async def attempt() -> None:
        with suppress(Exception, asyncio.CancelledError):
            await revoke()

    task = asyncio.create_task(attempt())
    loop = asyncio.get_running_loop()
    deadline = loop.time() + _CANCELLATION_CLEANUP_TIMEOUT
    # asyncio.wait leaves the cleanup task alone when the request is cancelled
    # again. A fixed deadline bounds the wait even under repeated cancellation.
    while not task.done():
        remaining = deadline - loop.time()
        if remaining <= 0:
            task.cancel()
            break
        with suppress(asyncio.CancelledError):
            await asyncio.wait({task}, timeout=remaining)


@dataclass(frozen=True)
class CompletedMigration:
    target: PinnedMigrationTarget
    recipe_user_id: RecipeUserId
    ordinary: _OrdinarySnapshot


async def read_completed_migration(
    config: RowndPluginConfig, source: FreshMigrationSource, context: UserContext,
) -> Optional[CompletedMigration]:
    state = await _read_fresh_ordinary_snapshot(config, source, context)
    if state is None:
        return None
    return CompletedMigration(PinnedMigrationTarget(state.target, MigrationTargetSource.MAPPING), RecipeUserId(state.recipe), state)


async def _read_fresh_ordinary_snapshot(config: RowndPluginConfig, source: FreshMigrationSource,
                                      context: UserContext) -> Optional[_OrdinarySnapshot]:
    from . import supertokens_repository as repo

    repo.clear_supertokens_core_call_cache(context)
    try:
        return await read_ordinary_snapshot(config, source, context)
    except MigrationError:
        raise
    except Exception as error:
        reason = (MigrationErrorReason.CORE_UNAVAILABLE if repo._is_recognizable_core_outage(error)
                  else MigrationErrorReason.MIGRATION_INCOMPLETE)
        raise MigrationError(reason, "state_inspect", error) from error


class _SessionEvidence:
    def __init__(self, config: RowndPluginConfig, source: FreshMigrationSource, state: _OrdinarySnapshot,
                 context: UserContext):
        self.config = config
        self.source = source
        self.state = state
        self.active = True
        self.phase = "claims"
        self.task = asyncio.current_task()
        self.native_entered = False
        self.bind_cache(context)

    def bind_cache(self, context: UserContext) -> None:
        # Identity witnesses only: the SDK remains the sole response cache. A
        # write or cache clear removes these entries, expiring nested read authority.
        cache = context.get("_default", {}).get("core_call_cache", {})
        self.cache_witnesses = tuple(cache.items())

    def cache_is_current(self, context: UserContext) -> bool:
        cache = context.get("_default", {}).get("core_call_cache", {})
        return bool(self.cache_witnesses) and all(cache.get(key) is value for key, value in self.cache_witnesses)


_EVIDENCE_KEY = "_rownd_completed_session_evidence"


async def _validate_session_binding(source: FreshMigrationSource, state: _OrdinarySnapshot,
                                    context: UserContext) -> None:
    from . import supertokens_repository as repo
    from .admin_orphan import ORPHAN_KEY
    from .admin_publication import PUBLICATION_KEY
    from .provider_migration import _ledger_id

    assert_source_authority(source)
    repo.clear_supertokens_core_call_cache(context)

    def invalid() -> MigrationError:
        return MigrationError(MigrationErrorReason.MIGRATION_INCOMPLETE, "session_create")

    # Only the authenticated credential remains authoritative after handoff.
    # Other methods, contact reservations and completion markers belong to the
    # next migration attempt, not to publication of this session.
    ids = {state.source_id, state.target, state.recipe}
    expected = (state.target, state.source_id)
    for identifier in sorted(ids):
        for role in ("EXTERNAL", "SUPERTOKENS"):
            mapping = repo._mapping_lookup(await repo.get_user_id_mapping(identifier, role, context))
            pair = (mapping.supertokens_user_id, mapping.external_user_id) if mapping else None
            required = expected if (identifier, role) in {
                (state.source_id, "EXTERNAL"), (state.target, "SUPERTOKENS"),
            } else None
            if pair != required:
                raise invalid()
        raw = await _read_literal_metadata(identifier, context)
        if raw is None:
            raise invalid()
        if "rownd_migration_superseded" in raw:
            raise MigrationError(MigrationErrorReason.IDENTITY_OWNED_BY_ANOTHER_USER, "session_create")
        orphan = raw.get(ORPHAN_KEY)
        if (raw.get(PUBLICATION_KEY) is not None or
                (orphan is not None and (not isinstance(orphan, dict) or orphan.get("phase") != "COMPLETE"))):
            raise invalid()
        introduction = raw.get("rownd_migration_provider_introduction")
        if identifier == state.recipe and introduction is not None and (
            not isinstance(introduction, dict) or not isinstance(introduction.get("tenant"), str)
            or introduction.get("tenant") == state.tenant
        ):
            raise invalid()

    user = await repo.get_user(state.recipe, context)
    if user is None or not user.is_primary_user or user.id not in {state.target, state.source_id}:
        raise invalid()
    previous = next(method for method in state.user().login_methods
                    if method.recipe_user_id.get_as_string() == state.recipe)
    method = next((method for method in user.login_methods
                   if method.recipe_user_id.get_as_string() == state.recipe), None)
    identity = next(identity for identity in source.snapshot.expected_identities
                    if repo._migration_method_matches_identity(previous, identity))
    if (method is None or state.tenant not in method.tenant_ids or method.time_joined != previous.time_joined
            or not repo._migration_method_matches_identity(method, identity)
            or (identity.verified and identity.recipe_id == "passwordless" and not method.verified)):
        raise invalid()
    if method.recipe_id == "thirdparty":
        ledger = await _read_literal_metadata(_ledger_id(state.target, state.tenant), context)
        if ledger is None:
            raise invalid()
        for entry in ledger.values():
            if not isinstance(entry, dict):
                raise invalid()
            applies = state.recipe in (entry.get("recipe"), entry.get("internal_recipe"))
            pending_introduction = (entry.get("kind") == "introduction" and entry.get("recipe") is None
                and repo.rownd_compatibility.get_third_party_info(method) == (entry.get("provider"), entry.get("subject")))
            if pending_introduction or (applies and (
                entry.get("state") != "complete" or entry.get("tenant") != state.tenant
                or entry.get("target") != state.target or entry.get("joined") != method.time_joined
                or entry.get("recipe") != state.recipe or entry.get("internal_recipe") != state.recipe
                or repo.rownd_compatibility.get_third_party_info(method) != (entry.get("provider"), entry.get("subject"))
            )):
                raise invalid()
    elif identity.identifier_type == "email":
        ledger = await _read_literal_metadata(_debt_ids(state.target, state.tenant)[0], context)
        if ledger is None:
            raise invalid()
        retirement = ledger.get("plan")
        if isinstance(retirement, dict) and retirement.get("state") == "removing":
            methods = retirement.get("methods")
            if not isinstance(methods, list) or any(
                not isinstance(record, dict) or record.get("recipe") == state.recipe for record in methods
            ):
                raise invalid()


def current_session_evidence(config: RowndPluginConfig, user_id: str, context: UserContext,
                             recipe: Optional[str] = None, tenant: Optional[str] = None) -> Optional[_OrdinarySnapshot]:
    evidence = context.get(_EVIDENCE_KEY)
    if (not isinstance(evidence, _SessionEvidence) or not evidence.active or evidence.config is not config
            or evidence.task is not asyncio.current_task() or not evidence.cache_is_current(context)):
        return None
    state = evidence.state
    if (user_id not in {state.target, state.source_id} or (recipe is not None and recipe != state.recipe)
            or (tenant is not None and tenant != state.tenant)):
        return None
    if recipe is not None and evidence.phase != "issuance":
        return None
    assert_source_authority(evidence.source)
    return state


def claim_session_evidence(config: RowndPluginConfig, user_id: str, context: UserContext,
                          recipe: str, tenant: str) -> Optional[_OrdinarySnapshot]:
    state = current_session_evidence(config, user_id, context, recipe, tenant)
    evidence = context.get(_EVIDENCE_KEY)
    if state is None or not isinstance(evidence, _SessionEvidence) or evidence.native_entered:
        return None
    evidence.native_entered = True
    return state


def finish_coordinated_session(config: RowndPluginConfig, state: _OrdinarySnapshot, context: UserContext) -> None:
    evidence = context.get(_EVIDENCE_KEY)
    # Session creation itself invalidates SDK GETs. Do not claim freshness here:
    # transfer publication back to the coordinator's mandatory post-hook read.
    if (not isinstance(evidence, _SessionEvidence) or not evidence.active or evidence.config is not config
            or evidence.task is not asyncio.current_task() or evidence.state is not state
            or evidence.phase != "issuance" or not evidence.native_entered):
        raise MigrationError(MigrationErrorReason.MIGRATION_INCOMPLETE, "session_create")
    assert_source_authority(evidence.source)
    evidence.phase = "awaiting_post"


async def create_completed_session(
    config: RowndPluginConfig,
    source: FreshMigrationSource,
    plan: CompletedMigration,
    request: BaseRequest,
    response: BaseResponse,
    context: UserContext,
) -> str:
    from . import supertokens_repository as repo

    evidence = _SessionEvidence(config, source, plan.ordinary, context)
    context = repo.create_derived_user_context(context, {_EVIDENCE_KEY: evidence})

    async def validate() -> None:
        try:
            await _validate_session_binding(source, plan.ordinary, context)
        except MigrationError:
            raise
        except Exception as error:
            reason = (MigrationErrorReason.CORE_UNAVAILABLE if repo._is_recognizable_core_outage(error)
                      else MigrationErrorReason.MIGRATION_INCOMPLETE)
            raise MigrationError(reason, "session_create", error) from error
        evidence.bind_cache(context)

    session = None
    try:
        claims = await repo.build_rownd_session_claims(config, plan.target.user_id, {}, None, context)
        await validate()
        evidence.phase = "issuance"
        with proven_session_authentication():
            session = await repo.session_asyncio.create_new_session(
                request, source.snapshot.tenant_id, plan.recipe_user_id, claims, {},
                repo.create_derived_user_context(context, {"rowndAppVariantId": None}),
            )
        evidence.phase = "post"
        await validate()
        if (session.get_user_id(context) != source.snapshot.rownd_user_id
                or session.get_recipe_user_id(context).get_as_string() != plan.recipe_user_id.get_as_string()
                or session.get_tenant_id(context) != source.snapshot.tenant_id):
            raise MigrationError(MigrationErrorReason.SESSION_CREATION_FAILED, "session_create")
    except asyncio.CancelledError:
        # Scrub synchronously, before any further cancellation can interrupt cleanup.
        with suppress(Exception):
            repo.scrub_migration_session_response(response, request)
        if session is not None:
            async def revoke() -> None:
                await session.revoke_session(context)
            await _finish_cancelled_session_cleanup(revoke)
        raise
    except Exception as error:
        if session is not None:
            with suppress(Exception):
                await session.revoke_session(context)
        repo.scrub_migration_session_response(response, request)
        if isinstance(error, MigrationError):
            raise
        raise MigrationError(MigrationErrorReason.SESSION_CREATION_FAILED, "session_create", error) from error
    finally:
        evidence.active = False
    return plan.target.user_id

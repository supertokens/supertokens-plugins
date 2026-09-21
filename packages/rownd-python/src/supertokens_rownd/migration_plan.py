from __future__ import annotations

import asyncio
from contextlib import suppress
from dataclasses import dataclass
from typing import Awaitable, Callable, Optional, TYPE_CHECKING

from supertokens_python.framework.request import BaseRequest
from supertokens_python.framework.response import BaseResponse
from supertokens_python.types import RecipeUserId
from supertokens_python.types.base import UserContext

from .constants import DEFAULT_ROWND_SCHEMA
from .errors import MigrationError, MigrationErrorReason
from .migration import MigrationDisposition, MigrationDispositionStatus, PinnedMigrationTarget
from .migration_authority import assert_source_authority, has_authenticated_source
from .migration_discovery import completed_identity_user
from .provider_migration import assert_source_binding
from .session_authentication import proven_session_authentication
from .types import RowndPluginConfig

if TYPE_CHECKING:
    from .supertokens_repository import FreshMigrationSource


_CANCELLATION_CLEANUP_TIMEOUT = 5.0


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


async def completed_migration(
    config: RowndPluginConfig,
    source: FreshMigrationSource,
    disposition: MigrationDisposition,
    context: UserContext,
) -> Optional[CompletedMigration]:
    from . import supertokens_repository as repo

    # Completeness alone does not account for operational debt or profile changes.
    if (disposition.status is not MigrationDispositionStatus.COMPLETE
            or disposition.target is None or disposition.target.source.value != "mapping"
            or not has_authenticated_source(source)
            or source.snapshot.app_variant_id is not None or config.schema != DEFAULT_ROWND_SCHEMA):
        return None
    user = await completed_identity_user(
        source.snapshot, disposition.target.user_id, context,
        reserved_contacts_checked=True, source_profile=source.rownd_user,
    )
    if user is None:
        return None
    email = next((identity for identity in source.snapshot.expected_identities
                  if identity.identifier_type == "email"), None)
    method = next((method for method in sorted(
        user.login_methods, key=lambda item: item.recipe_user_id.get_as_string(),
    ) if source.snapshot.tenant_id in method.tenant_ids and any(
        repo._migration_method_matches_identity(method, identity)
        for identity in ((email,) if email else source.snapshot.expected_identities)
    )), None)
    return CompletedMigration(disposition.target, method.recipe_user_id) if method else None


async def create_completed_session(
    config: RowndPluginConfig,
    source: FreshMigrationSource,
    plan: CompletedMigration,
    request: BaseRequest,
    response: BaseResponse,
    context: UserContext,
    read_fresh_source: Callable[[], Awaitable[Optional[FreshMigrationSource]]],
) -> str:
    from . import supertokens_repository as repo

    async def validate() -> None:
        assert_source_authority(source)
        fresh = await read_fresh_source()
        if fresh is None:
            raise MigrationError(MigrationErrorReason.ROWND_USER_NOT_FOUND, "rownd_profile_fetch")
        assert_source_authority(fresh)
        if (not has_authenticated_source(fresh) or fresh.snapshot != source.snapshot
                or fresh.rownd_user != source.rownd_user):
            raise MigrationError(MigrationErrorReason.MIGRATION_INCOMPLETE, "state_inspect")
        # This starts a new SDK read phase, including after arbitrary session hooks.
        await assert_source_binding(plan.target.user_id, source.snapshot.rownd_user_id, context)
        if repo._mapping_lookup(await repo.get_user_id_mapping(
            source.snapshot.rownd_user_id, "SUPERTOKENS", context,
        )) is not None:
            raise MigrationError(MigrationErrorReason.MAPPING_CONFLICT, "state_inspect")
        user = await completed_identity_user(
            source.snapshot, plan.target.user_id, context,
            reserved_contacts_checked=True, source_profile=source.rownd_user,
        )
        if user is None:
            raise MigrationError(MigrationErrorReason.MIGRATION_INCOMPLETE, "state_inspect")
        for identity in source.snapshot.expected_identities:
            if identity.identifier_type not in {"email", "phone"}:
                continue
            for owner in await repo._get_migration_identity_users(identity, source.snapshot.tenant_id, context):
                if any(source.snapshot.tenant_id in method.tenant_ids
                       and repo._migration_method_reserves_identity(method, identity)
                       for method in owner.login_methods):
                    if await repo.resolve_supertokens_user_id(owner.id, context) != plan.target.user_id:
                        raise MigrationError(MigrationErrorReason.IDENTITY_OWNED_BY_ANOTHER_USER, "state_inspect")
        owner = await repo.get_user(plan.recipe_user_id.get_as_string(), context)
        if (owner is None or await repo.resolve_supertokens_user_id(owner.id, context) != plan.target.user_id
                or not any(method.recipe_user_id.get_as_string() == plan.recipe_user_id.get_as_string()
                           and source.snapshot.tenant_id in method.tenant_ids
                           and any(repo._migration_method_matches_identity(method, identity)
                                   and (identity.recipe_id != "passwordless" or not identity.verified or method.verified)
                                   for identity in source.snapshot.expected_identities)
                           for method in owner.login_methods)):
            raise MigrationError(MigrationErrorReason.MIGRATION_INCOMPLETE, "state_inspect")

    claims = await repo.build_rownd_session_claims(config, plan.target.user_id, {}, None, context)
    await validate()
    session = None
    try:
        with proven_session_authentication():
            session = await repo.session_asyncio.create_new_session(
                request, source.snapshot.tenant_id, plan.recipe_user_id, claims, {},
                repo.create_derived_user_context(context, {"rowndAppVariantId": None}),
            )
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
    return plan.target.user_id

from __future__ import annotations

from contextlib import suppress

from supertokens_python.framework.request import BaseRequest
from supertokens_python.framework.response import BaseResponse
from supertokens_python.recipe.session import asyncio as session_asyncio
from supertokens_python.types.base import UserContext

from . import supertokens_repository as repo
from .errors import MigrationError, MigrationErrorReason
from .migration import create_rownd_identity_snapshot
from .migration_discovery import completed_identity_user
from .migration_plan import _debt_ids, _read_literal_metadata
from .provider_migration import _entries
from .rownd_repository import valid_lookup_id
from .session_authentication import proven_session_authentication
from .types import RowndPluginConfig


async def _owner(config: RowndPluginConfig, source: str, tenant: str, app_variant: str | None,
                 context: UserContext) -> tuple[str, str, str, bool]:
    repo.clear_supertokens_core_call_cache(context)

    def invalid() -> MigrationError:
        return MigrationError(MigrationErrorReason.MIGRATION_INCOMPLETE, "state_inspect")

    mapping = repo._mapping_lookup(await repo.get_user_id_mapping(source, "EXTERNAL", context))
    if mapping is None or mapping.external_user_id != source or not valid_lookup_id(mapping.supertokens_user_id):
        raise invalid()
    target = mapping.supertokens_user_id
    reverse = repo._mapping_lookup(await repo.get_user_id_mapping(target, "SUPERTOKENS", context))
    if reverse != mapping or target == source:
        raise invalid()
    if (repo._mapping_lookup(await repo.get_user_id_mapping(source, "SUPERTOKENS", context)) is not None
            or repo._mapping_lookup(await repo.get_user_id_mapping(target, "EXTERNAL", context)) is not None):
        raise invalid()
    source_metadata = await _read_literal_metadata(source, context)
    target_metadata = await _read_literal_metadata(target, context)
    if source_metadata is None or target_metadata is None:
        raise invalid()
    original = target_metadata.get("original_rownd_user")
    if (target_metadata.get("rownd_migration_complete") is not True
            or not isinstance(original, dict)
            or repo.get_original_rownd_user_id(target_metadata) != source
            or original.get("state") not in (None, "enabled")
            or ("original_rownd_user" in source_metadata
                and source_metadata["original_rownd_user"] != original)
            or source_metadata.get("rownd_migration_complete") is False):
        raise invalid()
    for metadata in (source_metadata, target_metadata):
        if (any(key.startswith("rownd_migration_") and key not in {"rownd_migration_complete"}
                for key in metadata)
                or metadata.get("rownd_migration_complete") not in (None, True)
                or metadata.get("rownd_pending_verification")):
            raise invalid()
    try:
        snapshot = create_rownd_identity_snapshot(original, tenant, app_variant, config.schema)
    except MigrationError as err:
        raise invalid() from err
    if snapshot.rownd_user_id != source:
        raise invalid()
    user = await repo.get_user(source, context)
    if user is None or not user.is_primary_user or user.id not in {target, source}:
        raise invalid()
    if snapshot.expected_identities:
        for identity in snapshot.expected_identities:
            if identity.identifier_type not in {"email", "phone"}:
                continue
            owners = await repo._get_migration_identity_users(identity, tenant, context)
            if any(owner.id not in {source, target} and any(
                tenant in method.tenant_ids and repo._migration_method_reserves_identity(method, identity)
                for method in owner.login_methods
            ) for owner in owners):
                raise invalid()
        completed = await completed_identity_user(
            snapshot, target, context, reserved_contacts_checked=True, source_profile=original,
            allow_source_anonymous_methods=True,
        )
        if completed is None or completed.id != user.id:
            raise invalid()
    else:
        # Anonymous profiles cannot use the ordinary identity reader: they have
        # no expected contact/provider identity. Keep them on their exact method.
        ids = {source, target, *(method.recipe_user_id.get_as_string() for method in user.login_methods)}
        for identifier in ids:
            record = await _read_literal_metadata(identifier, context)
            if (record is None or any(key.startswith(("rownd_migration_", "rownd_python_"))
                                      and key != "rownd_migration_complete" for key in record)):
                raise invalid()
        if any(entry.get("state") != "complete" for entry in (await _entries(target, source, tenant, context)).values()):
            raise invalid()
    email_debt, _ = _debt_ids(target, tenant)
    if await _read_literal_metadata(email_debt, context) != {}:
        raise invalid()
    methods = [method for method in user.login_methods if tenant in method.tenant_ids
               and (any(repo._migration_method_matches_identity(method, identity)
                        for identity in snapshot.expected_identities)
                    or (method.recipe_id == "thirdparty" and
                        repo.rownd_compatibility.get_third_party_info(method) in
                        {("instant", source), ("guest", source)}))]
    if not methods:
        raise invalid()
    methods.sort(key=lambda item: item.recipe_user_id.get_as_string())
    method = next((item for item in methods if item.recipe_id != "thirdparty" or
                   repo.rownd_compatibility.get_third_party_info(item)[0] not in {"instant", "guest"}), methods[0])
    recipe = method.recipe_user_id.get_as_string()
    if recipe not in {source, target} and (
            repo._mapping_lookup(await repo.get_user_id_mapping(recipe, "EXTERNAL", context)) is not None or
            repo._mapping_lookup(await repo.get_user_id_mapping(recipe, "SUPERTOKENS", context)) is not None):
        raise invalid()
    recipe_metadata = await _read_literal_metadata(recipe, context)
    if recipe_metadata is None or any(key.startswith("rownd_migration_") and key != "rownd_migration_complete"
                                      for key in recipe_metadata):
        raise invalid()
    proven = method.recipe_id != "thirdparty" or repo.rownd_compatibility.get_third_party_info(method)[0] not in {"instant", "guest"}
    return target, user.id, recipe, proven


async def create_mapped_session(config: RowndPluginConfig, source: str, tenant: str,
                                app_variant: str | None, request: BaseRequest,
                                response: BaseResponse, context: UserContext) -> str:
    try:
        owner = await _owner(config, source, tenant, app_variant, context)
        claims = await repo.build_rownd_session_claims(config, owner[1], {}, app_variant, context)
        if await _owner(config, source, tenant, app_variant, context) != owner:
            raise MigrationError(MigrationErrorReason.MIGRATION_INCOMPLETE, "session_create")
        session = None
        try:
            from supertokens_python.types import RecipeUserId

            if owner[3]:
                with proven_session_authentication():
                    session = await session_asyncio.create_new_session(
                        request, tenant, RecipeUserId(owner[2]), claims, {}, context)
            else:
                session = await session_asyncio.create_new_session(
                    request, tenant, RecipeUserId(owner[2]), claims, {}, context)
            if (session.get_user_id(context) != owner[1]
                    or session.get_recipe_user_id(context).get_as_string() != owner[2]
                    or session.get_tenant_id(context) != tenant
                    or await _owner(config, source, tenant, app_variant, context) != owner):
                raise MigrationError(MigrationErrorReason.MIGRATION_INCOMPLETE, "session_create")
        except BaseException:
            if session is not None:
                with suppress(Exception):
                    await session.revoke_session(context)
            repo.scrub_migration_session_response(response, request)
            raise
        return owner[1]
    except MigrationError:
        raise
    except Exception as err:
        reason = (MigrationErrorReason.CORE_UNAVAILABLE if repo._is_recognizable_core_outage(err)
                  else MigrationErrorReason.MIGRATION_INCOMPLETE)
        raise MigrationError(reason, "state_inspect", err) from err

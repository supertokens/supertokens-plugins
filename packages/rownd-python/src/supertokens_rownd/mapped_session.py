from __future__ import annotations

from contextlib import suppress

from supertokens_python.framework.request import BaseRequest
from supertokens_python.framework.response import BaseResponse
from supertokens_python.recipe.session import asyncio as session_asyncio
from supertokens_python.types.base import UserContext

from . import supertokens_repository as repo
from .errors import MigrationError, MigrationErrorReason
from .migration_plan import _debt_ids, _read_literal_metadata
from .provider_migration import _entries
from .rownd_repository import valid_lookup_id
from .session_authentication import proven_session_authentication
from .types import RowndPluginConfig


async def _owner(source: str, tenant: str, context: UserContext) -> tuple[str, str, str, bool]:
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
    user = await repo.get_user(source, context)
    if user is None or user.id not in {target, source}:
        raise invalid()
    records = {source: source_metadata, target: target_metadata}
    for method in user.login_methods:
        recipe = method.recipe_user_id.get_as_string()
        if recipe not in records:
            record = await _read_literal_metadata(recipe, context)
            if record is None:
                raise invalid()
            records[recipe] = record
    # A published mapping is sufficient; completion flags and saved profiles
    # are not authentication evidence. Operational debt must still block sessions.
    owner_keys = {"rownd_migration_canonical_target", "rownd_migration_target"}
    for record in records.values():
        if (any(record[key] != target for key in owner_keys if key in record)
                or any(key.startswith(("rownd_migration_", "rownd_python_"))
                       and key not in owner_keys | {"rownd_migration_complete"} for key in record)
                or record.get("rownd_pending_verification")
                or ("original_rownd_user" in record
                    and repo.get_original_rownd_user_id(record) != source)):
            raise invalid()
    if any(entry.get("state") != "complete" for entry in (await _entries(target, source, tenant, context)).values()):
        raise invalid()
    email_debt, _ = _debt_ids(target, tenant)
    if await _read_literal_metadata(email_debt, context) != {}:
        raise invalid()
    methods = [method for method in user.login_methods if tenant in method.tenant_ids]
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
    proven = method.recipe_id != "thirdparty" or repo.rownd_compatibility.get_third_party_info(method)[0] not in {"instant", "guest"}
    return target, user.id, recipe, proven


async def create_mapped_session(config: RowndPluginConfig, source: str, tenant: str,
                                app_variant: str | None, request: BaseRequest,
                                response: BaseResponse, context: UserContext) -> str:
    try:
        owner = await _owner(source, tenant, context)
        claims = await repo.build_rownd_session_claims(config, owner[1], {}, app_variant, context)
        if await _owner(source, tenant, context) != owner:
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
                    or await _owner(source, tenant, context) != owner):
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

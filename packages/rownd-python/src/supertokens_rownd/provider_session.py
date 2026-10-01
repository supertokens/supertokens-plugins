from __future__ import annotations

from supertokens_python.types.base import UserContext

from .errors import MigrationError, MigrationErrorReason
from .provider_migration import _ledger_id


async def assert_provider_session_membership(
    user_id: str, recipe_user_id: str, tenant_id: str, context: UserContext,
) -> None:
    """Validate a native session's exact recipe and tenant using fresh Core reads."""
    from . import supertokens_repository as repo

    def invalid():
        return MigrationError(MigrationErrorReason.MIGRATION_STATE_INVALID, "session_create")

    repo.clear_supertokens_core_call_cache(context)
    async def immutable(identifier: str) -> str:
        external = repo._mapping_lookup(await repo.get_user_id_mapping(identifier, "EXTERNAL", context))
        internal = repo._mapping_lookup(await repo.get_user_id_mapping(identifier, "SUPERTOKENS", context))
        if external is not None:
            if internal is not None and external.supertokens_user_id != identifier:
                raise invalid()
            reverse = repo._mapping_lookup(await repo.get_user_id_mapping(external.supertokens_user_id, "SUPERTOKENS", context))
            if reverse != external or external.external_user_id != identifier:
                raise invalid()
            return external.supertokens_user_id
        if internal is not None:
            reverse = repo._mapping_lookup(await repo.get_user_id_mapping(internal.external_user_id, "EXTERNAL", context))
            if reverse != internal or internal.supertokens_user_id != identifier:
                raise invalid()
        return identifier

    internal_recipe = await immutable(recipe_user_id)
    owner = await repo.get_user(internal_recipe, context)
    if owner is None:
        raise invalid()
    target = await immutable(user_id)
    if await immutable(owner.id) != target:
        raise invalid()
    matches = [item for item in owner.login_methods
               if await immutable(item.recipe_user_id.get_as_string()) == internal_recipe]
    if len(matches) != 1 or tenant_id not in matches[0].tenant_ids:
        raise invalid()
    method = matches[0]
    for identifier in {recipe_user_id, internal_recipe, method.recipe_user_id.get_as_string()}:
        receipt = (await repo.get_raw_user_metadata(identifier, context)).get("rownd_migration_provider_introduction")
        if receipt is not None:
            if not isinstance(receipt, dict) or not isinstance(receipt.get("tenant"), str):
                raise invalid()
            if receipt.get("tenant") == tenant_id:
                raise invalid()
    ledger = await repo.get_raw_user_metadata(_ledger_id(target, tenant_id), context)
    for entry in ledger.values():
        if not isinstance(entry, dict):
            raise invalid()
        if entry.get("tenant") != tenant_id or entry.get("target") != target:
            raise invalid()
        entry_recipe = entry.get("recipe")
        entry_internal = await immutable(entry_recipe) if isinstance(entry_recipe, str) else None
        applies = entry.get("internal_recipe") == internal_recipe or (
            entry_internal == internal_recipe)
        if applies and entry.get("state") != "complete":
            raise invalid()
        if (entry.get("kind") == "introduction" and entry.get("recipe") is None
            and repo.rownd_compatibility.get_third_party_info(method) == (entry.get("provider"), entry.get("subject"))):
            raise invalid()
        if applies:
            if (entry.get("joined") != method.time_joined
                or entry_internal != internal_recipe
                or entry.get("internal_recipe") != internal_recipe
                or repo.rownd_compatibility.get_third_party_info(method) != (entry.get("provider"), entry.get("subject"))):
                raise invalid()
            metadata = await repo.get_user_metadata(target, context)
            from .identity import provider_subject
            original = metadata.get("original_rownd_user")
            if (metadata.get("rownd_migration_complete") is not True or not isinstance(original, dict)
                or provider_subject(original, str(entry.get("provider"))) != entry.get("subject")):
                raise invalid()

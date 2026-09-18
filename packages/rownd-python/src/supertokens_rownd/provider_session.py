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
    owner = await repo.get_user(recipe_user_id, context)
    if owner is None:
        raise invalid()
    target = await repo.resolve_supertokens_user_id(user_id, context)
    if not await repo.sdk_user_id_matches_internal_target(owner.id, target, context):
        raise invalid()
    method = next((item for item in owner.login_methods
                   if item.recipe_user_id.get_as_string() == recipe_user_id), None)
    if method is None or tenant_id not in method.tenant_ids:
        raise invalid()
    receipt = (await repo.get_raw_user_metadata(recipe_user_id, context)).get("rownd_migration_provider_introduction")
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
        if entry.get("recipe") == recipe_user_id and entry.get("state") != "complete":
            raise invalid()
        if (entry.get("kind") == "introduction" and entry.get("recipe") is None
            and repo.rownd_compatibility.get_third_party_info(method) == (entry.get("provider"), entry.get("subject"))):
            raise invalid()
        if entry.get("recipe") == recipe_user_id:
            if (entry.get("joined") != method.time_joined
                or entry.get("internal_recipe") != await repo.resolve_supertokens_user_id(recipe_user_id, context)
                or repo.rownd_compatibility.get_third_party_info(method) != (entry.get("provider"), entry.get("subject"))):
                raise invalid()
            metadata = await repo.get_user_metadata(target, context)
            from .identity import provider_subject
            original = metadata.get("original_rownd_user")
            if (metadata.get("rownd_migration_complete") is not True or not isinstance(original, dict)
                or provider_subject(original, str(entry.get("provider"))) != entry.get("subject")):
                raise invalid()

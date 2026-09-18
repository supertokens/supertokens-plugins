from __future__ import annotations

import hashlib
import json
import uuid
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Dict, Optional, cast

from supertokens_python.types import RecipeUserId
from supertokens_python.types.base import UserContext

from .errors import MigrationError, MigrationErrorReason
from .identity import provider_subject
from .migration import ExpectedIdentity, PinnedMigrationTarget
from .types import JsonDict
from .utils import clear_supertokens_core_call_cache

if TYPE_CHECKING:
    from .supertokens_repository import FreshMigrationSource


def _ledger_id(target: str, tenant: str) -> str:
    digest = hashlib.sha256(json.dumps([target, tenant], separators=(",", ":")).encode()).hexdigest()
    return "rownd-provider-lifecycle-" + digest


def _invalid() -> MigrationError:
    return MigrationError(MigrationErrorReason.MIGRATION_STATE_INVALID, "account_link")


async def assert_source_binding(target: str, rownd_id: str, context: UserContext):
    from . import supertokens_repository as repo

    await repo.assert_source_not_superseded(rownd_id, context)
    clear_supertokens_core_call_cache(context)
    external = repo._mapping_lookup(await repo.get_user_id_mapping(rownd_id, "EXTERNAL", context))
    internal = repo._mapping_lookup(await repo.get_user_id_mapping(target, "SUPERTOKENS", context))
    if (target != rownd_id or external is not None or internal is not None) and (
        external is None or internal is None or external != internal
        or external.supertokens_user_id != target or external.external_user_id != rownd_id
    ):
        raise MigrationError(MigrationErrorReason.MAPPING_CONFLICT, "account_link")
    user = await repo.get_user(target, context)
    if user is None or not await repo.sdk_user_id_matches_internal_target(user.id, target, context):
        raise MigrationError(MigrationErrorReason.MAPPING_CONFLICT, "account_link")
    return user


async def _entries(target: str, rownd_id: str, tenant: str, context: UserContext):
    from . import supertokens_repository as repo

    metadata = await repo.get_raw_user_metadata(_ledger_id(target, tenant), context)
    for value in metadata.values():
        if (not isinstance(value, dict) or value.get("target") != target
            or value.get("rownd_id") != rownd_id or value.get("tenant") != tenant
            or value.get("kind") not in {"introduction", "retirement"}
            or value.get("provider") not in {"google", "apple"}
            or not isinstance(value.get("subject"), str) or not value["subject"]
            or value.get("state") not in {"prepared", "removing", "complete"}
            or (value.get("recipe") is not None and (not isinstance(value["recipe"], str) or not value["recipe"]))
            or (value.get("kind") == "retirement" and (
                not isinstance(value.get("recipe"), str) or not isinstance(value.get("joined"), int)
            ))):
            raise _invalid()
    return cast(Dict[str, Dict[str, Any]], metadata)


async def _write(target: str, tenant: str, key: str, value: Optional[JsonDict], context: UserContext):
    from . import supertokens_repository as repo

    # Independent top-level entries avoid read/modify/write loss across workers.
    await repo.usermetadata_asyncio.update_user_metadata(
        _ledger_id(target, tenant), {key: value}, context
    )
    clear_supertokens_core_call_cache(context)
    saved = await repo.get_raw_user_metadata(_ledger_id(target, tenant), context)
    if saved.get(key) != value:
        raise _invalid()


async def checkpoint_introduction(
    source: FreshMigrationSource, target: str, identity: ExpectedIdentity,
    context: UserContext, recipe: Optional[str] = None, membership: bool = False,
) -> JsonDict:
    if identity.provider_id not in {"google", "apple"}:
        return {}
    await assert_source_binding(target, source.snapshot.rownd_user_id, context)
    receipt: JsonDict = {
        "target": target, "rownd_id": source.snapshot.rownd_user_id,
        "tenant": source.snapshot.tenant_id, "provider": identity.provider_id,
        "subject": identity.provider_user_id, "recipe": recipe,
        "created": recipe is None, "kind": "introduction", "state": "prepared",
        "membership": membership,
    }
    if recipe is not None:
        from . import supertokens_repository as repo
        owner = await repo.get_user(recipe, context)
        method = next((method for method in owner.login_methods
                       if method.recipe_user_id.get_as_string() == recipe
                       and repo._migration_method_matches_identity(method, identity)), None) if owner else None
        if method is None or (not membership and source.snapshot.tenant_id not in method.tenant_ids):
            raise _invalid()
        if membership:
            if owner is None or not await repo.sdk_user_id_matches_internal_target(owner.id, target, context):
                raise _invalid()
            if source.snapshot.tenant_id in method.tenant_ids:
                return {}
        receipt.update(cast(JsonDict, {"joined": method.time_joined, "tenants": sorted(method.tenant_ids),
                        "email": method.email, "phone": method.phone_number,
                        "internal_recipe": await repo.resolve_supertokens_user_id(recipe, context)}))
    key = str(uuid.uuid4())
    await _write(target, source.snapshot.tenant_id, key, receipt, context)
    return {"rownd_migration_provider_introduction": {**receipt, "checkpoint": key}}


async def confirm_introduction(metadata: JsonDict, method, context: UserContext) -> None:
    receipt = metadata.get("rownd_migration_provider_introduction")
    if not isinstance(receipt, dict):
        return
    entry = cast(Dict[str, Any], receipt)
    from . import supertokens_repository as repo
    if (repo.rownd_compatibility.get_third_party_info(method) != (entry["provider"], entry["subject"])
        or entry["tenant"] not in method.tenant_ids):
        raise _invalid()
    immutable = {**entry, "recipe": method.recipe_user_id.get_as_string(),
                 "joined": method.time_joined, "tenants": sorted(method.tenant_ids),
                 "email": method.email, "phone": method.phone_number,
                 "internal_recipe": await repo.resolve_supertokens_user_id(method.recipe_user_id.get_as_string(), context)}
    await repo.usermetadata_asyncio.update_user_metadata(
        immutable["recipe"], {"rownd_migration_provider_introduction": immutable}, context)
    await _write(entry["target"], entry["tenant"], entry["checkpoint"],
                 {key: value for key, value in immutable.items() if key != "checkpoint"}, context)


async def _repair_provider_lifecycle(
    source: FreshMigrationSource, target: PinnedMigrationTarget, context: UserContext,
    read_fresh_source: Callable[[], Awaitable[Optional[FreshMigrationSource]]],
) -> None:
    from . import supertokens_repository as repo
    from .migration_authority import assert_source_authority

    assert_source_authority(source)

    target_id, tenant, rownd_id = target.user_id, source.snapshot.tenant_id, source.snapshot.rownd_user_id
    user = await assert_source_binding(target_id, rownd_id, context)
    entries = await _entries(target_id, rownd_id, tenant, context)
    metadata = await repo.get_user_metadata(target_id, context)
    original = metadata.get("original_rownd_user")
    original_data = repo.as_json_dict(original.get("data")) if isinstance(original, dict) else {}
    expected = {
        identity.provider_id: identity for identity in source.snapshot.expected_identities
        if identity.provider_id in {"google", "apple"}
    }
    if isinstance(original, dict) and original_data.get("user_id") == rownd_id:
        for method in user.login_methods:
            provider, subject = repo.rownd_compatibility.get_third_party_info(method)
            replacement = expected.get(provider or "")
            if (replacement is None or replacement.provider_user_id == subject
                or subject not in (original_data.get("%s_id" % provider), provider_subject(original, provider or ""))
                or tenant not in method.tenant_ids):
                continue
            recipe = method.recipe_user_id.get_as_string()
            if any(value.get("recipe") == recipe and value.get("kind") == "retirement" for value in entries.values()):
                continue
            entry: Dict[str, Any] = {"target": target_id, "rownd_id": rownd_id, "tenant": tenant,
                "recipe": recipe, "provider": provider, "subject": subject,
                "internal_recipe": await repo.resolve_supertokens_user_id(recipe, context),
                "joined": method.time_joined, "kind": "retirement", "state": "prepared"}
            key = str(uuid.uuid4())
            await _write(target_id, tenant, key, entry, context)
            entries[key] = entry
            for other_tenant in method.tenant_ids:
                if other_tenant == tenant:
                    continue
                history = await _entries(target_id, rownd_id, other_tenant, context)
                if not any(value.get("recipe") == recipe and value.get("kind") == "retirement" for value in history.values()):
                    await _write(target_id, other_tenant, str(uuid.uuid4()), {**entry, "tenant": other_tenant}, context)

    for key, entry in entries.items():
        provider, subject = entry["provider"], entry["subject"]
        replacement = expected.get(provider)
        user = await assert_source_binding(target_id, rownd_id, context)
        def matching(method):
            return method.recipe_id == "thirdparty" and repo.rownd_compatibility.get_third_party_info(method) == (provider, subject)
        if entry["kind"] == "introduction":
            identity = ExpectedIdentity("thirdparty:%s:%s" % (provider, subject), "thirdparty", provider, subject)
            if entry.get("recipe"):
                owner = await repo.get_user(entry["recipe"], context)
                owners = [owner] if owner else []
            else:
                owners = await repo._get_migration_identity_users(identity, tenant, context)
            candidates = [(owner, method) for owner in owners for method in owner.login_methods if matching(method)]
            if not candidates:
                continue
            if len(candidates) != 1:
                raise _invalid()
            owner, method = candidates[0]
            recipe = method.recipe_user_id.get_as_string()
            if entry.get("recipe") is None:
                local = (await repo.get_raw_user_metadata(recipe, context)).get("rownd_migration_provider_introduction")
                proven = isinstance(local, dict) and local == {**entry, "checkpoint": key}
                if proven and owner.id != user.id:
                    internal_owner = await repo.resolve_supertokens_user_id(owner.id, context)
                    if (owner.is_primary_user or len(owner.login_methods) != 1
                        or repo._mapping_lookup(await repo.get_user_id_mapping(internal_owner, "SUPERTOKENS", context)) is not None):
                        raise _invalid()
                if not proven and (replacement is None or replacement.provider_user_id != subject):
                    raise _invalid()
                # Only the exact atomically imported receipt proves creation. A
                # lookup alone recovers as a native donor, never deletion authority.
                entry = {**entry, "created": proven, "recipe": recipe,
                         "joined": method.time_joined, "tenants": sorted(method.tenant_ids),
                         "email": method.email, "phone": method.phone_number,
                         "internal_recipe": await repo.resolve_supertokens_user_id(recipe, context)}
                await _write(target_id, tenant, key, entry, context)
            if entry.get("recipe") != recipe or entry.get("joined") != method.time_joined or (
                entry.get("internal_recipe") != await repo.resolve_supertokens_user_id(recipe, context)
            ) or entry.get("email") != method.email or entry.get("phone") != method.phone_number:
                raise _invalid()
            if entry.get("membership") and tenant in entry.get("tenants", []):
                raise _invalid()
            if (entry.get("tenants") != sorted(method.tenant_ids)
                and not (entry.get("membership") and sorted(set(entry.get("tenants", [])) | {tenant}) == sorted(method.tenant_ids))
                and not (entry["state"] == "removing" and
                         [value for value in entry.get("tenants", []) if value != tenant] == sorted(method.tenant_ids))):
                raise _invalid()
            receipt = (await repo.get_raw_user_metadata(recipe, context)).get("rownd_migration_provider_introduction")
            published = (metadata.get("rownd_migration_complete") is True
                         and isinstance(original, dict) and provider_subject(original, provider) == subject)
            if entry.get("created") and (
                (not (isinstance(receipt, dict) and receipt.get("checkpoint") == key)
                and not (published and entry["state"] == "complete"))
                or entry.get("recipe") != recipe or entry.get("joined") != method.time_joined
            ):
                # A timed-out create may have raced a native credential; never adopt it as ours.
                raise _invalid()
            if entry["state"] == "removing":
                await repo.session_asyncio.revoke_all_sessions_for_user(target_id, True, tenant, context)
            if replacement and replacement.provider_user_id == subject:
                if owner.id == user.id and tenant in method.tenant_ids:
                    fresh = await read_fresh_source()
                    if fresh is None or fresh.snapshot != source.snapshot:
                        raise _invalid()
                    if published and isinstance(receipt, dict) and receipt.get("checkpoint") == key:
                        await repo.usermetadata_asyncio.update_user_metadata(recipe, {"rownd_migration_provider_introduction": None}, context)
                    await _write(target_id, tenant, key, None if published else {**entry, "state": "complete"}, context)
                continue
            if owner.is_primary_user and owner.id != user.id:
                raise MigrationError(MigrationErrorReason.PRIMARY_ACCOUNT_MERGE_REQUIRED, "account_link")
            await _write(target_id, tenant, key, {**entry, "state": "removing", "recipe": recipe}, context)
            preserve_anchor = owner.id == user.id and (
                len(owner.login_methods) == 1 or entry.get("internal_recipe") == target_id
            )
            if not entry.get("created") and not entry.get("membership") and not preserve_anchor:
                if owner.id == user.id:
                    await repo.accountlinking_asyncio.unlink_account(method.recipe_user_id, context)
                await repo.session_asyncio.revoke_all_sessions_for_user(recipe, False, None, context)
            elif tenant in method.tenant_ids:
                result = await repo.multitenancy_asyncio.disassociate_user_from_tenant(tenant, method.recipe_user_id, context)
                if getattr(result, "status", None) != "OK":
                    raise _invalid()
            await repo.session_asyncio.revoke_all_sessions_for_user(target_id, True, tenant, context)
            clear_supertokens_core_call_cache(context)
            after = await repo.get_user(recipe, context)
            if after and ((entry.get("created") or entry.get("membership") or preserve_anchor) and any(matching(item) and tenant in item.tenant_ids for item in after.login_methods)
                          or (not entry.get("created") and not entry.get("membership") and not preserve_anchor and after.id == user.id)):
                raise _invalid()
            # Quarantine retains the anchor and receipt for recovery in other tenants.
            await _write(target_id, tenant, key, None, context)
            continue

        if await repo.resolve_supertokens_user_id(entry["recipe"], context) != entry.get("internal_recipe"):
            raise _invalid()
        owner = await repo.get_user(entry["recipe"], context)
        obsolete = next((method for method in owner.login_methods if matching(method)), None) if owner else None
        if obsolete and owner is not None and (owner.id != user.id or obsolete.time_joined != entry.get("joined")):
            raise MigrationError(MigrationErrorReason.IDENTITY_OWNED_BY_ANOTHER_USER, "account_link")
        if obsolete is None or tenant not in obsolete.tenant_ids:
            deleted = False
            if (obsolete is not None and not obsolete.tenant_ids and replacement is not None
                and replacement.provider_user_id != subject and len(user.login_methods) > 1
                and any(repo._migration_method_matches_identity(method, replacement) and tenant in method.tenant_ids for method in user.login_methods)):
                fresh = await read_fresh_source()
                if fresh is None or fresh.snapshot != source.snapshot:
                    raise _invalid()
                await assert_source_binding(target_id, rownd_id, context)
                await _write(target_id, tenant, key, {**entry, "state": "removing"}, context)
                await repo.delete_user(entry["recipe"], remove_all_linked_accounts=False, user_context=context)
                deleted = True
            if entry["state"] == "removing" or deleted:
                await repo.session_asyncio.revoke_all_sessions_for_user(target_id, True, tenant, context)
                await assert_source_binding(target_id, rownd_id, context)
                await _write(target_id, tenant, key, {**entry, "state": "complete"}, context)
            continue
        if replacement is None or replacement.provider_user_id == subject:
            continue
        if not any(repo._migration_method_matches_identity(method, replacement) and tenant in method.tenant_ids for method in user.login_methods):
            continue
        fresh = await read_fresh_source()
        if fresh is None or fresh.snapshot != source.snapshot:
            raise _invalid()
        await assert_source_binding(target_id, rownd_id, context)
        if await repo.resolve_supertokens_user_id(entry["recipe"], context) != entry.get("internal_recipe"):
            raise _invalid()
        current_owner = await repo.get_user(entry["recipe"], context)
        if current_owner is None or current_owner.id != user.id or not any(
            matching(method) and method.time_joined == entry["joined"]
            for method in current_owner.login_methods
        ):
            raise _invalid()
        # Debt is durable before removal, including when Core commits then loses its response.
        await _write(target_id, tenant, key, {**entry, "state": "removing"}, context)
        result = await repo.multitenancy_asyncio.disassociate_user_from_tenant(tenant, RecipeUserId(entry["recipe"]), context)
        if getattr(result, "status", None) != "OK":
            raise _invalid()
        after = await assert_source_binding(target_id, rownd_id, context)
        if (any(matching(method) and tenant in method.tenant_ids for method in after.login_methods)
            or not any(repo._migration_method_matches_identity(method, replacement) and tenant in method.tenant_ids for method in after.login_methods)):
            raise _invalid()
        remaining = next((method for method in after.login_methods if matching(method)), None)
        if remaining is not None and not remaining.tenant_ids:
            if len(after.login_methods) < 2:
                raise _invalid()
            # Core's recipe-only deletion preserves the primary ID and mapping when
            # a replacement remains linked, even if this was the original anchor.
            await repo.delete_user(entry["recipe"], remove_all_linked_accounts=False, user_context=context)
        await repo.session_asyncio.revoke_all_sessions_for_user(target_id, True, tenant, context)
        after = await assert_source_binding(target_id, rownd_id, context)
        if not any(repo._migration_method_matches_identity(method, replacement) and tenant in method.tenant_ids for method in after.login_methods):
            raise _invalid()
        await _write(target_id, tenant, key, {**entry, "state": "complete"}, context)


async def repair_provider_lifecycle(
    source: FreshMigrationSource, target: PinnedMigrationTarget, context: UserContext,
    read_fresh_source: Callable[[], Awaitable[Optional[FreshMigrationSource]]],
) -> None:
    from . import supertokens_repository as repo
    try:
        from .migration_email import repair_current_email
        await repair_current_email(source, target, context, read_fresh_source)
        await _repair_provider_lifecycle(source, target, context, read_fresh_source)
    except MigrationError:
        raise
    except Exception as error:
        reason = MigrationErrorReason.CORE_UNAVAILABLE if repo._is_recognizable_core_outage(error) else MigrationErrorReason.MIGRATION_INCOMPLETE
        raise MigrationError(reason, "account_link", error) from error

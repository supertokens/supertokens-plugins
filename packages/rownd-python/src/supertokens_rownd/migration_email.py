from __future__ import annotations

import hashlib
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Dict, Optional, cast

from supertokens_python.types.base import UserContext
from supertokens_python.recipe.passwordless.interfaces import RevokeAllCodesOkResult

from .errors import MigrationError, MigrationErrorReason
from .identity import provider_subject
from .migration import PinnedMigrationTarget
from .migration_authority import assert_source_authority, authenticated_source_email
from .provider_migration import assert_source_binding
from .utils import clear_supertokens_core_call_cache

if TYPE_CHECKING:
    from .supertokens_repository import FreshMigrationSource


def _invalid():
    return MigrationError(MigrationErrorReason.MIGRATION_STATE_INVALID, "metadata_finalize")


async def repair_current_email(
    source: FreshMigrationSource, target: PinnedMigrationTarget, context: UserContext,
    read_fresh_source: Callable[[], Awaitable[Optional[FreshMigrationSource]]],
) -> None:
    from . import supertokens_repository as repo

    assert_source_authority(source)
    tenant, rownd_id = source.snapshot.tenant_id, source.snapshot.rownd_user_id
    user = await assert_source_binding(target.user_id, rownd_id, context)
    ledger_id = "rownd-email-retirement-" + hashlib.sha256(
        (target.user_id + "\0" + tenant).encode()).hexdigest()
    stored = await repo.get_raw_user_metadata(ledger_id, context)
    plan: Any = stored.get("plan")
    if isinstance(plan, dict) and plan.get("state") == "removing":
        if (plan.get("target") != target.user_id or plan.get("rownd_id") != rownd_id
            or plan.get("tenant") != tenant or not isinstance(plan.get("methods"), list)
            or not isinstance(plan.get("previous"), str) or not isinstance(plan.get("email"), str)):
            raise _invalid()
        # Settlement is not authority for another credential. It must precede all
        # current-source eligibility checks, including an absent current email.
        await repo.session_asyncio.revoke_all_sessions_for_user(target.user_id, True, tenant, context)
        result = await repo.passwordless_asyncio.revoke_all_codes(
            tenant_id=tenant, email=cast(str, plan["previous"]), user_context=context)
        if not isinstance(result, RevokeAllCodesOkResult):
            raise _invalid()
        replacement_record = plan.get("replacement")
        if not isinstance(replacement_record, dict):
            # Older removing checkpoints predate the replacement fingerprint. Their
            # published canonical pointer and original provider/email provenance
            # must still identify the exact already-authorized replacement.
            legacy = await repo.get_user_metadata(target.user_id, context)
            legacy_original = repo.as_json_dict(legacy.get("original_rownd_user"))
            legacy_data = repo.as_json_dict(legacy_original.get("data"))
            legacy_canonical = repo.rownd_compatibility.get_canonical_email_recipe_user_id(legacy, tenant)
            candidate = next((method for method in user.login_methods
                              if method.recipe_user_id.get_as_string() == legacy_canonical
                              and method.recipe_id == "passwordless" and method.verified
                              and method.has_same_email_as(plan["email"]) and tenant in method.tenant_ids), None)
            if (candidate is None or legacy_data.get("user_id") != rownd_id
                or repo.normalize_email(legacy_data.get("email")) != plan["previous"]
                or provider_subject(legacy_original, str(plan.get("provider"))) != plan.get("subject")
                or not any(repo.rownd_compatibility.get_third_party_info(method) == (plan.get("provider"), plan.get("subject"))
                           and tenant in method.tenant_ids for method in user.login_methods)):
                raise _invalid()
            replacement_record = {"recipe": candidate.recipe_user_id.get_as_string(), "joined": candidate.time_joined}
            plan = {**plan, "replacement": replacement_record}
            await repo.usermetadata_asyncio.update_user_metadata(ledger_id, {"plan": plan}, context)
        replacement = next((method for method in user.login_methods
                            if method.recipe_user_id.get_as_string() == replacement_record.get("recipe")
                            and method.time_joined == replacement_record.get("joined")
                            and method.recipe_id == "passwordless" and method.verified
                            and method.has_same_email_as(plan.get("email")) and tenant in method.tenant_ids), None)
        if replacement is None:
            raise _invalid()
        latest = await repo.get_user_metadata(target.user_id, context)
        previous_recipes = {record.get("recipe") for record in plan["methods"] if isinstance(record, dict)
                            and isinstance(record.get("recipe"), str)}
        canonical = repo.rownd_compatibility.get_canonical_email_recipe_user_id(latest, tenant)
        if canonical not in previous_recipes | {replacement.recipe_user_id.get_as_string()}:
            raise _invalid()
        await repo.usermetadata_asyncio.update_user_metadata(target.user_id, {"rownd_email_recipe_user_ids": {
            **repo.as_json_dict(latest.get("rownd_email_recipe_user_ids")), tenant: replacement.recipe_user_id.get_as_string(),
        }}, context)
        # The removing checkpoint was authorized before source drift. Finish only
        # its exact recorded retirements; it grants no authority over the new email.
        for record in plan["methods"]:
            if not isinstance(record, dict) or not isinstance(record.get("recipe"), str):
                raise _invalid()
            current = await assert_source_binding(target.user_id, rownd_id, context)
            owner = await repo.get_user(record["recipe"], context)
            method = next((item for item in owner.login_methods
                           if item.recipe_user_id.get_as_string() == record["recipe"]), None) if owner else None
            if method is None:
                continue
            if (owner is None or owner.id != current.id or method.time_joined != record.get("joined")
                or method.recipe_id != "passwordless" or not method.has_same_email_as(plan.get("previous"))
                or method.recipe_user_id == replacement.recipe_user_id):
                raise _invalid()
            if tenant in method.tenant_ids:
                removed = await repo.multitenancy_asyncio.disassociate_user_from_tenant(tenant, method.recipe_user_id, context)
                if getattr(removed, "status", None) != "OK":
                    raise _invalid()
            current = await assert_source_binding(target.user_id, rownd_id, context)
            remaining = next((item for item in current.login_methods if item.recipe_user_id == method.recipe_user_id), None)
            if remaining is not None and not remaining.tenant_ids:
                if len(current.login_methods) < 2 or not any(
                    item.recipe_user_id == replacement.recipe_user_id and item.time_joined == replacement.time_joined
                    and tenant in item.tenant_ids for item in current.login_methods
                ):
                    raise _invalid()
                await repo.delete_user(record["recipe"], remove_all_linked_accounts=False, user_context=context)
        await repo.session_asyncio.revoke_all_sessions_for_user(target.user_id, True, tenant, context)
        user = await assert_source_binding(target.user_id, rownd_id, context)
        if any(method.recipe_id == "passwordless" and method.has_same_email_as(plan.get("previous"))
               and tenant in method.tenant_ids for method in user.login_methods):
            raise _invalid()
        plan = {**plan, "state": "complete"}
        await repo.usermetadata_asyncio.update_user_metadata(ledger_id, {"plan": plan}, context)
    email_identity = next((identity for identity in source.snapshot.expected_identities
                           if identity.identifier_type == "email"), None)
    if email_identity is None:
        return
    tenant, rownd_id = source.snapshot.tenant_id, source.snapshot.rownd_user_id
    email = email_identity.identifier
    user = await assert_source_binding(target.user_id, rownd_id, context)
    metadata = await repo.get_user_metadata(target.user_id, context)
    original = repo.as_json_dict(metadata.get("original_rownd_user"))
    data = repo.as_json_dict(original.get("data"))
    previous = data.get("email")
    previous = previous.strip().lower() if isinstance(previous, str) else None
    canonical = repo.rownd_compatibility.get_canonical_email_recipe_user_id(metadata, tenant)
    methods = [method for method in user.login_methods if tenant in method.tenant_ids]
    canonical_method = next((method for method in methods if method.recipe_user_id.get_as_string() == canonical), None)
    history = []
    predecessor: Any = None
    if isinstance(plan, dict):
        if plan.get("state") == "complete" and plan.get("email") != email:
            predecessor = plan
        elif plan.get("state") == "prepared" and isinstance(plan.get("history"), list) and plan["history"]:
            predecessor = plan["history"][-1]
    if predecessor is not None:
        if not isinstance(predecessor, dict) or predecessor.get("state") != "complete":
            raise _invalid()
        replacement_record = predecessor.get("replacement")
        if (replacement_record is None and canonical_method is not None and canonical_method.verified
            and canonical_method.recipe_id == "passwordless" and previous == predecessor.get("email")
            and data.get("user_id") == rownd_id and canonical_method.has_same_email_as(previous)):
            replacement_record = {"recipe": canonical, "joined": canonical_method.time_joined}
            predecessor = {**predecessor, "replacement": replacement_record}
            if isinstance(plan, dict) and plan.get("state") == "complete":
                plan = predecessor
        if (predecessor.get("target") != target.user_id or predecessor.get("rownd_id") != rownd_id
            or predecessor.get("tenant") != tenant or not isinstance(replacement_record, dict)
            or canonical_method is None or canonical != replacement_record.get("recipe")
            or canonical_method.time_joined != replacement_record.get("joined")
            or not canonical_method.has_same_email_as(predecessor.get("email"))):
            raise _invalid()
        previous = predecessor.get("email")
        if predecessor is plan:
            history = [plan]
            plan = None
    pending = repo.parse_tenant_pending_email_verifications(metadata, tenant)
    if not isinstance(pending, tuple) or pending:
        raise _invalid()
    if canonical is not None and (canonical_method is None or canonical_method.recipe_id != "passwordless"
        or (not canonical_method.has_same_email_as(email) and not canonical_method.has_same_email_as(previous))):
        raise _invalid()
    # A native canonical credential is not replaced using a historical Rownd snapshot.
    if canonical_method and not canonical_method.has_same_email_as(email) and data.get("user_id") != rownd_id:
        raise _invalid()

    if plan is None:
        if not previous or previous == email or data.get("user_id") != rownd_id:
            return
        provider = next((method for method in methods
            if method.recipe_id == "thirdparty"
            and method.third_party is not None
            and repo.rownd_compatibility.get_third_party_info(method)[0] in {"google", "apple"}
            and any(repo._migration_method_matches_identity(method, identity) for identity in source.snapshot.expected_identities)
            and provider_subject(original, method.third_party.id) == method.third_party.user_id), None)
        obsolete = [method for method in methods if method.recipe_id == "passwordless" and method.has_same_email_as(previous)]
        if not obsolete:
            return
        if provider is None or provider.third_party is None:
            if any(method.third_party and method.third_party.id == "apple" for method in methods):
                raise _invalid()
            return
        if not email_identity.verified:
            raise _invalid()
        if any(method.recipe_id in {"passwordless", "emailpassword"} and method.email
               and not method.has_same_email_as(email) and not method.has_same_email_as(previous) for method in methods):
            raise _invalid()
        plan = {"target": target.user_id, "rownd_id": rownd_id, "tenant": tenant, "email": email,
                "previous": previous, "provider": provider.third_party.id, "subject": provider.third_party.user_id,
                "methods": [{"recipe": method.recipe_user_id.get_as_string(), "joined": method.time_joined} for method in obsolete],
                "state": "prepared", "history": history}
        await repo.usermetadata_asyncio.update_user_metadata(ledger_id, {"plan": plan}, context)
    if (not isinstance(plan, dict) or plan.get("target") != target.user_id
        or plan.get("rownd_id") != rownd_id or plan.get("tenant") != tenant
        or plan.get("state") not in {"prepared", "removing", "complete"}
        or not isinstance(plan.get("methods"), list)):
        raise _invalid()
    plan = cast(Dict[str, Any], plan)
    if plan["state"] == "complete":
        if not any(method.recipe_id == "passwordless" and method.has_same_email_as(plan.get("previous")) for method in methods):
            return
    if plan.get("email") != email:
        raise _invalid()
    replacement = next((method for method in methods if method.recipe_id == "passwordless"
                         and method.has_same_email_as(email) and method.verified), None)
    if replacement is None:
        return
    fresh = await read_fresh_source()
    if fresh is None or fresh.snapshot != source.snapshot:
        raise _invalid()
    assert_source_authority(fresh)
    if not (authenticated_source_email(fresh) == email or email_identity.verified):
        raise _invalid()
    if provider_subject(fresh.rownd_user, str(plan.get("provider"))) != plan.get("subject"):
        raise _invalid()
    user = await assert_source_binding(target.user_id, rownd_id, context)
    latest = await repo.get_user_metadata(target.user_id, context)
    pending = repo.parse_tenant_pending_email_verifications(latest, tenant)
    latest_canonical = repo.rownd_compatibility.get_canonical_email_recipe_user_id(latest, tenant)
    if (not isinstance(pending, tuple) or pending
        or latest_canonical not in {canonical, replacement.recipe_user_id.get_as_string()}
        or not any(method.recipe_user_id == replacement.recipe_user_id
                   and method.time_joined == replacement.time_joined
                   and method.verified and method.has_same_email_as(email)
                   and tenant in method.tenant_ids for method in user.login_methods)):
        raise _invalid()
    retiring = []
    for record in plan["methods"]:
        if not isinstance(record, dict) or not isinstance(record.get("recipe"), str):
            raise _invalid()
        owner = await repo.get_user(record["recipe"], context)
        method = next((method for method in owner.login_methods
                       if method.recipe_user_id.get_as_string() == record["recipe"]), None) if owner else None
        if method is None:
            continue
        if owner is None or owner.id != user.id or method.time_joined != record.get("joined") or method.recipe_id != "passwordless" or not method.has_same_email_as(plan.get("previous")):
            raise _invalid()
        retiring.append(method)
    plan = {**plan, "replacement": {"recipe": replacement.recipe_user_id.get_as_string(), "joined": replacement.time_joined}}
    await repo.usermetadata_asyncio.update_user_metadata(ledger_id, {"plan": {**plan, "state": "removing"}}, context)
    await repo.usermetadata_asyncio.update_user_metadata(target.user_id, {
        "rownd_email_recipe_user_ids": {
            **repo.as_json_dict(latest.get("rownd_email_recipe_user_ids")),
            tenant: replacement.recipe_user_id.get_as_string(),
        },
    }, context)
    result = await repo.passwordless_asyncio.revoke_all_codes(tenant_id=tenant, email=plan["previous"], user_context=context)
    if not isinstance(result, RevokeAllCodesOkResult):
        raise _invalid()
    for method in retiring:
        if tenant in method.tenant_ids:
            result = await repo.multitenancy_asyncio.disassociate_user_from_tenant(tenant, method.recipe_user_id, context)
            if getattr(result, "status", None) != "OK":
                raise _invalid()
        current = await assert_source_binding(target.user_id, rownd_id, context)
        remaining = next((item for item in current.login_methods if item.recipe_user_id == method.recipe_user_id), None)
        if remaining is not None and not remaining.tenant_ids:
            if (remaining.time_joined != method.time_joined or len(current.login_methods) < 2
                or not any(item.recipe_user_id == replacement.recipe_user_id and tenant in item.tenant_ids for item in current.login_methods)):
                raise _invalid()
            await repo.delete_user(method.recipe_user_id.get_as_string(), remove_all_linked_accounts=False, user_context=context)
    await repo.session_asyncio.revoke_all_sessions_for_user(target.user_id, True, tenant, context)
    clear_supertokens_core_call_cache(context)
    after = await assert_source_binding(target.user_id, rownd_id, context)
    if (any(method.has_same_email_as(plan["previous"]) and tenant in method.tenant_ids
            and method.recipe_id == "passwordless" for method in after.login_methods)
        or not any(method.recipe_user_id == replacement.recipe_user_id and tenant in method.tenant_ids for method in after.login_methods)):
        raise _invalid()
    await repo.usermetadata_asyncio.update_user_metadata(ledger_id, {"plan": {**plan, "state": "complete"}}, context)

from __future__ import annotations

import copy
import json
import uuid
from typing import Any

from supertokens_python import asyncio as core
from supertokens_python.recipe.passwordless import asyncio as passwordless
from supertokens_python.recipe.passwordless.interfaces import UpdateUserOkResult
from supertokens_python.recipe.session import asyncio as sessions
from supertokens_python.recipe.usermetadata import asyncio as metadata
from supertokens_python.recipe.emailverification import asyncio as verification
from supertokens_python.types import RecipeUserId

from .admin_core import AdministrativeCore, method_identity, same_json
from .admin_planning import AdministrativePolicyError, provider_subject
from .supertokens_repository import import_method_account_infos, import_user, login_method_matches_import

METHOD_KEY = "rownd_migration_admin_methods"
RECEIPT_KEY = "rownd_migration_admin_creation"


async def validate_method_recovery(store: AdministrativeCore, plan: dict[str, Any], profile: dict[str, Any]) -> None:
    from .admin_planning import owner_state_at

    target = plan["target"]
    raw = await store.raw(target)
    checkpoint = raw.get(METHOD_KEY)
    if checkpoint is None:
        observed = (await store.inspect_plan(plan))["state"]
        if not same_json(observed, owner_state_at(plan)):
            raise AdministrativePolicyError("Owner state changed before method reconciliation")
        return
    if (not isinstance(checkpoint, dict) or type(checkpoint.get("version")) is not int
            or checkpoint["version"] != 1 or checkpoint.get("target") != target
            or checkpoint.get("sourceId") != plan["sourceId"]
            or not same_json(checkpoint.get("profile"), profile)
            or checkpoint.get("status") not in {"APPLYING", "COMPLETE"}
            or type(checkpoint.get("cursor")) is not int
            or not isinstance(checkpoint.get("operations"), list)
            or not 0 <= checkpoint["cursor"] <= len(checkpoint["operations"])):
        raise AdministrativePolicyError("Invalid method reconciliation lineage")
    user = await store.user(target)
    if user is None or not user.is_primary_user or await store.immutable(user.id) != target:
        raise AdministrativePolicyError("Method reconciliation owner changed")
    actual = {}
    for method in user.login_methods:
        if method.tenant_ids != ["public"]:
            raise AdministrativePolicyError("Method reconciliation requires public-only recipes")
        actual[await store.immutable(method.recipe_user_id.get_as_string())] = method
    expected = {r["id"]: [json.loads(r["identity"])] for r in plan["recipes"]}
    optional = set()
    for index, step in enumerate(checkpoint["operations"]):
        if index > checkpoint["cursor"]:
            break
        committed = index < checkpoint["cursor"]
        if step["kind"] == "update_email":
            rid = step["id"]
            if rid not in expected or not same_json(expected[rid][0], json.loads(step["identity"])):
                raise AdministrativePolicyError("Email recovery identity is not in the owner checkpoint")
            after = copy.deepcopy(expected[rid][0])
            after[1] = step["email"]
            expected[rid] = [after] if committed else [*expected[rid], after]
        elif step["kind"] == "retire":
            rid = step["id"]
            if rid == target or rid not in expected or not same_json(expected[rid][0], json.loads(step["identity"])):
                raise AdministrativePolicyError("Retirement identity is not in the owner checkpoint")
            if committed:
                expected.pop(rid)
            else:
                optional.add(rid)
        elif step["kind"] == "create":
            receipt = step.get("receipt")
            if receipt:
                rid = receipt["id"]
                if rid in expected:
                    raise AdministrativePolicyError("Creation receipt reused an owner recipe")
                expected[rid] = [json.loads(receipt["identity"])]
                if not committed:
                    optional.add(rid)
            elif not committed:
                # The current import can commit before its receipt response. Only
                # its private nonce and exact requested identity authorize recovery.
                for rid, method in actual.items():
                    marker = (await store.raw(rid)).get(RECEIPT_KEY)
                    if marker == {"plan": checkpoint["id"], "nonce": step.get("nonce"),
                                  "target": target, "sourceId": plan["sourceId"]} and login_method_matches_import(method, step["method"]):
                        expected[rid] = [json.loads(method_identity(method))]
        else:
            raise AdministrativePolicyError("Unknown method recovery operation")
    if set(actual) - set(expected) or set(expected) - set(actual) - optional:
        raise AdministrativePolicyError("Method recovery graph changed")
    for rid, method in actual.items():
        if not any(same_json(json.loads(method_identity(method)), identity) for identity in expected[rid]):
            raise AdministrativePolicyError("Method recovery recipe identity changed")
    for mapping in owner_state_at(plan)["mappings"]:
        if not same_json(await store.mapping(mapping["id"], "SUPERTOKENS") or {"id": mapping["id"]}, mapping):
            raise AdministrativePolicyError("Method recovery mappings changed")
    if raw.get("rownd_pending_verification") not in (None, []):
        raise AdministrativePolicyError("CANONICAL_EMAIL_POLICY")


async def plan_methods(store: AdministrativeCore, target: str, source: dict[str, Any],
                       profile: dict[str, Any], users: list[Any]) -> list[dict[str, Any]]:
    methods = {}
    histories = []
    for user in users:
        for method in user.login_methods:
            recipe_id = await store.immutable(method.recipe_user_id.get_as_string())
            methods[recipe_id] = method
            for literal in {recipe_id, method.recipe_user_id.get_as_string()}:
                raw = await store.raw(literal)
                if raw.get("rownd_pending_verification") not in (None, []):
                    raise AdministrativePolicyError("CANONICAL_EMAIL_POLICY")
                if isinstance(raw.get("original_rownd_user"), dict):
                    histories.append(raw["original_rownd_user"])
    actions = []
    replacements = set()
    desired = source["loginMethods"]
    contact = profile["data"].get("email", "").lower()
    target_metadata = await store.raw(target)
    pointers = target_metadata.get("rownd_email_recipe_user_ids")
    if pointers is not None and (not isinstance(pointers, dict) or any(not isinstance(p, str) or not p for p in pointers.values())):
        raise AdministrativePolicyError("CANONICAL_EMAIL_POLICY")
    canonical = pointers.get("public", target_metadata.get("rownd_email_recipe_user_id")) if pointers is not None else target_metadata.get("rownd_email_recipe_user_id")
    if canonical is not None and (not isinstance(canonical, str) or not canonical):
        raise AdministrativePolicyError("CANONICAL_EMAIL_POLICY")
    canonical = await store.immutable(canonical) if isinstance(canonical, str) else None
    if canonical and (canonical not in methods or methods[canonical].recipe_id != "passwordless" or not methods[canonical].email):
        raise AdministrativePolicyError("CANONICAL_EMAIL_POLICY")
    old_emails = [(rid, m) for rid, m in methods.items() if m.recipe_id == "passwordless" and m.email and contact and m.email.lower() != contact]
    for recipe_id, method in old_emails:
        historical = any(p.get("data", {}).get("email", "").lower() == method.email.lower() for p in histories)
        if not historical or (canonical and canonical != recipe_id):
            raise AdministrativePolicyError("CANONICAL_EMAIL_POLICY")
        current = next((m for m in desired if m.get("recipeId") == "passwordless" and m.get("email", "").lower() == contact), None)
        if current is None:
            continue
        existing_current = any(login_method_matches_import(m, current) for m in methods.values())
        if existing_current:
            if recipe_id == target:
                raise AdministrativePolicyError("Email retirement would delete immutable primary recipe")
            actions.append({"kind": "retire", "id": recipe_id, "identity": method_identity(method)})
        else:
            if not current["isVerified"]:
                for literal in {recipe_id, method.recipe_user_id.get_as_string()}:
                    if await verification.is_email_verified(RecipeUserId(literal), current["email"], store.context):
                        raise AdministrativePolicyError("Canonical email would inherit unrelated verification")
            actions.append({"kind": "update_email", "id": recipe_id, "identity": method_identity(method),
                            "email": current["email"], "verified": current["isVerified"]})
            replacements.add(id(current))
    for method in desired:
        if id(method) not in replacements and not any(login_method_matches_import(existing, method) for existing in methods.values()):
            actions.insert(0, {"kind": "create", "method": copy.deepcopy(method)})
    for recipe_id, method in methods.items():
        provider = method.third_party
        if not provider or provider.id not in {"google", "apple"}:
            continue
        current = provider_subject(profile, provider.id)
        if current and current != provider.user_id:
            historical = any(provider_subject(p, provider.id) == provider.user_id or p.get("data", {}).get(provider.id + "_id") == provider.user_id for p in histories)
            if not historical:
                raise AdministrativePolicyError("Unproven stale provider credential")
            if recipe_id == target:
                raise AdministrativePolicyError("Provider retirement would delete immutable primary recipe")
            actions.append({"kind": "retire", "id": recipe_id, "identity": method_identity(method)})
    return actions


async def execute_methods(operation: Any, target: str, source: dict[str, Any], actions: list[dict[str, Any]]) -> None:
    store: AdministrativeCore = operation.store
    source_id = source["externalUserId"]
    prior = (await store.raw(target)).get(METHOD_KEY)
    if prior is not None and not isinstance(prior, dict):
        raise AdministrativePolicyError("Invalid method reconciliation checkpoint")
    if prior is None or prior.get("status") == "COMPLETE":
        checkpoint = {"version": 1, "id": str(uuid.uuid4()), "sourceId": source_id,
                      "target": target, "tenantId": "public", "profile": operation.profiles[source_id],
                      "operations": actions, "cursor": 0, "status": "APPLYING"}
    else:
        checkpoint = prior
        if (type(checkpoint.get("version")) is not int or checkpoint["version"] != 1
                or type(checkpoint.get("cursor")) is not int
                or not 0 <= checkpoint["cursor"] <= len(checkpoint.get("operations", []))
                or checkpoint.get("target") != target or checkpoint.get("sourceId") != source_id
                or not same_json(checkpoint.get("profile"), operation.profiles[source_id])):
            raise AdministrativePolicyError("Invalid method reconciliation checkpoint")

    async def save():
        operation.mutation_started = True
        await metadata.update_user_metadata(target, {METHOD_KEY: checkpoint}, store.context)
        store.fresh()

    await save()
    while checkpoint["cursor"] < len(checkpoint["operations"]):
        await operation.source_guard()
        step = checkpoint["operations"][checkpoint["cursor"]]
        kind = step["kind"]
        if kind == "create":
            receipt = step.get("receipt")
            if receipt is None:
                nonce = step.setdefault("nonce", str(uuid.uuid4()))
                await save()
                found = []
                for info in import_method_account_infos(step["method"]):
                    found.extend(await core.list_users_by_account_info("public", info, False, store.context))
                candidates = []
                for user in found:
                    for method in user.login_methods:
                        rid = await store.immutable(method.recipe_user_id.get_as_string())
                        marker = (await store.raw(rid)).get(RECEIPT_KEY)
                        if marker == {"plan": checkpoint["id"], "nonce": nonce, "target": target, "sourceId": source_id} and login_method_matches_import(method, step["method"]):
                            if not any(existing_id == rid for existing_id, _ in candidates):
                                candidates.append((rid, method))
                if not candidates:
                    conflicting = False
                    for existing in found:
                        if await store.immutable(existing.id) != target or any(login_method_matches_import(m, step["method"]) for m in existing.login_methods):
                            conflicting = True
                    if conflicting:
                        raise AdministrativePolicyError("Method creation identity acquired by another owner")
                    imported = await import_user({"loginMethods": [{**step["method"], "isPrimary": False}],
                        "userMetadata": {RECEIPT_KEY: {"plan": checkpoint["id"], "nonce": nonce, "target": target, "sourceId": source_id}}}, operation.core_config, store.context)
                    rid = imported.get("id")
                    if not isinstance(rid, str):
                        raise AdministrativePolicyError("Import returned no recipe ID")
                    user = await store.user(rid)
                    if user is None or len(user.login_methods) != 1:
                        raise AdministrativePolicyError("Created method graph changed")
                    candidates = [(rid, user.login_methods[0])]
                if len(candidates) != 1:
                    raise AdministrativePolicyError("Ambiguous method creation receipt")
                rid, method = candidates[0]
                receipt = {"id": rid, "identity": method_identity(method), "verified": method.verified}
                step["receipt"] = receipt
                await save()
            user = await store.user(receipt["id"])
            if user is None:
                raise AdministrativePolicyError("Created recipe disappeared")
            owned = None
            for method in user.login_methods:
                if await store.immutable(method.recipe_user_id.get_as_string()) == receipt["id"]:
                    owned = method
            if owned is None or not same_json(json.loads(method_identity(owned)), json.loads(receipt["identity"])):
                raise AdministrativePolicyError("Created recipe identity changed")
            owner = await store.immutable(user.id)
            if owner != target:
                if owner != receipt["id"] or user.is_primary_user or len(user.login_methods) != 1:
                    raise AdministrativePolicyError("Created recipe belongs to another owner")
                await operation.source_guard()
                await store.operation({"kind": "link", "id": receipt["id"]}, target)
        elif kind in {"retire", "update_email"}:
            rid = step["id"]
            user = await store.user(rid)
            methods = user.login_methods if user else []
            current = None
            for method in methods:
                if await store.immutable(method.recipe_user_id.get_as_string()) == rid:
                    current = method
            if current is None:
                if kind != "retire":
                    raise AdministrativePolicyError("Email method disappeared")
            else:
                assert user is not None
                if await store.immutable(user.id) != target:
                    raise AdministrativePolicyError("Method owner changed")
                identity = json.loads(method_identity(current))
                before = json.loads(step["identity"])
                after = copy.deepcopy(before)
                if kind == "update_email":
                    after[1] = step["email"]
                if not same_json(identity, before) and not (kind == "update_email" and same_json(identity, after)):
                    raise AdministrativePolicyError("Method identity changed")
                if kind == "retire":
                    if rid == target:
                        raise AdministrativePolicyError("Cannot retire immutable primary recipe")
                    # Revoke only sessions of the credential being retired, before
                    # deletion; owner-consolidation itself preserves live sessions.
                    await sessions.revoke_all_sessions_for_user(current.recipe_user_id.get_as_string(),
                        revoke_sessions_for_linked_accounts=False, user_context=store.context)
                    await core.delete_user(current.recipe_user_id.get_as_string(), False, store.context)
                elif same_json(identity, before):
                    if not step["verified"] and await verification.is_email_verified(current.recipe_user_id, step["email"], store.context):
                        raise AdministrativePolicyError("Canonical email verification changed")
                    result = await passwordless.update_user(current.recipe_user_id, email=step["email"], user_context=store.context)
                    if not isinstance(result, UpdateUserOkResult):
                        raise AdministrativePolicyError("Core rejected canonical email update")
        else:
            raise AdministrativePolicyError("Unknown method operation")
        store.fresh()
        checkpoint["cursor"] += 1
        await save()
    checkpoint["status"] = "COMPLETE"
    await save()

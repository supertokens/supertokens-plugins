from __future__ import annotations

import json
import copy
from importlib import import_module
from typing import Any, Awaitable, Callable, Optional

from supertokens_python.types import RecipeUserId

from .admin_core import AdministrativeCore, same_json
from .admin_planning import OWNER_PLAN_KEY, AdministrativePolicyError, administrative_source, identity_keys, owner_state_at, read_owner_plan, validate_profile
from .admin_publication import PUBLICATION_KEY, read_publication
from .admin_orphan import ORPHAN_KEY
from .supertokens_repository import login_method_matches_import


async def resolve_consolidated_token_owner(
    rownd_user_id: str, tenant_id: str, user_context: dict[str, Any],
    fetch_fresh_profile: Callable[[str], Awaitable[Optional[dict[str, Any]]]],
) -> Optional[dict[str, Any]]:
    """Resolve a validated JWT's active historical alias without merging identities."""
    store = AdministrativeCore(user_context, tenant_id)
    raw = await store.raw(rownd_user_id)
    if raw.get("rownd_migration_superseded") is not None:
        raise AdministrativePolicyError("Rownd source has been superseded")
    recovery = raw.get("rownd_migration_owner_recovery")
    if recovery is not None:
        if not isinstance(recovery, dict) or not isinstance(recovery.get("target"), str):
            raise AdministrativePolicyError("Invalid owner recovery pointer")
        recovered = read_owner_plan(await store.raw(recovery["target"]))
        if (recovered is None or recovered["id"] != recovery.get("planId")
                or not any(c["rownd_user_id"] == rownd_user_id for c in recovered["candidates"])):
            raise AdministrativePolicyError("Owner recovery pointer changed")
        await validate_completed_owner_plan(recovered, user_context)
    reservation = read_owner_plan(raw)
    if reservation is not None:
        await validate_completed_owner_plan(reservation, user_context)
    user = await store.user(rownd_user_id)
    if user is None:
        return None
    target = await store.immutable(user.id)
    plan = read_owner_plan(await store.raw(target))
    if plan is None:
        return None
    if tenant_id != "public":
        raise AdministrativePolicyError("Consolidated aliases require public tenant membership")
    await validate_completed_owner_plan(plan, user_context)
    alias = next((a for a in plan["aliases"] if a["id"] == rownd_user_id), None)
    mapping = await store.mapping(rownd_user_id)
    if alias is None or mapping is None or mapping["id"] != alias["to"]:
        raise AdministrativePolicyError("Unplanned consolidated alias")
    if rownd_user_id == plan["sourceId"]:
        return None
    requested_raw = await fetch_fresh_profile(rownd_user_id)
    canonical_raw = await fetch_fresh_profile(plan["sourceId"])
    if requested_raw is None or canonical_raw is None:
        raise AdministrativePolicyError("Consolidated source disappeared")
    requested = validate_profile(requested_raw, rownd_user_id)
    canonical = validate_profile(canonical_raw, plan["sourceId"])
    requested_source = administrative_source(requested, tenant_id)
    if not any(m.get("thirdPartyId") in {"google", "apple"} or m.get("isVerified") for m in requested_source["loginMethods"]):
        raise AdministrativePolicyError("Consolidated alias requires an authenticated source")
    if not identity_keys(requested).intersection(identity_keys(canonical)):
        raise AdministrativePolicyError("Consolidated source identities no longer overlap")
    expected_methods = administrative_source(canonical, tenant_id)["loginMethods"]
    user = await store.user(rownd_user_id)
    if (user is None or not user.is_primary_user or await store.immutable(user.id) != target
            or any(not any(tenant_id in m.tenant_ids and login_method_matches_import(m, expected)
                           for m in user.login_methods) for expected in expected_methods)):
        raise AdministrativePolicyError("Consolidated alias owner membership changed")
    await validate_completed_owner_plan(plan, user_context)
    return {"user": user, "target": target, "canonical_rownd_id": plan["sourceId"],
            "recipe_user_id": RecipeUserId(rownd_user_id)}


async def assert_session_membership(user_id: str, recipe_user_id: str, tenant_id: str,
                                    user_context: dict[str, Any]) -> None:
    """Check native session issuance separately from authentication-origin policy."""
    store = AdministrativeCore(user_context, tenant_id)
    store.fresh()
    issuance_ids = {user_id, recipe_user_id, await store.immutable(user_id), await store.immutable(recipe_user_id)}
    for literal in issuance_ids:
        raw = await store.raw(literal)
        if read_publication(raw.get(PUBLICATION_KEY)) is not None:
            raise AdministrativePolicyError("Fresh mapping publication is incomplete")
        orphan = raw.get(ORPHAN_KEY)
        if orphan is not None and (not isinstance(orphan, dict) or orphan.get("phase") != "COMPLETE"):
            raise AdministrativePolicyError("Orphan mapping recovery is incomplete")
    pending = list(issuance_ids)
    visited = set()
    while pending:
        literal = pending.pop()
        if literal in visited:
            continue
        visited.add(literal)
        immutable = await store.immutable(literal)
        if immutable not in visited:
            pending.append(immutable)
        user = await store.user(literal)
        if user:
            pending.extend(i for i in [user.id, *(m.recipe_user_id.get_as_string() for m in user.login_methods)] if i not in visited)
        raw = await store.raw(literal)
        methods = raw.get("rownd_migration_admin_methods")
        finalization = raw.get("rownd_migration_admin_finalization")
        if isinstance(methods, dict) and methods.get("tenantId") == tenant_id:
            unsettled = methods.get("status") != "COMPLETE" or (isinstance(finalization, dict) and finalization.get("status") != "COMPLETE")
            if unsettled:
                for step in methods.get("operations", []):
                    if step.get("kind") == "update_email":
                        raise AdministrativePolicyError("Canonical email reconciliation is incomplete")
                    if step.get("kind") in {"retire", "remove_tenant"}:
                        identity = json.loads(step["identity"])
                        if identity[0] == "passwordless" and identity[1]:
                            raise AdministrativePolicyError("Canonical email reconciliation is incomplete")
        recovery = raw.get("rownd_migration_owner_recovery")
        if recovery is not None:
            if not isinstance(recovery, dict) or not isinstance(recovery.get("target"), str):
                raise AdministrativePolicyError("Invalid owner recovery pointer")
            referenced = read_owner_plan(await store.raw(recovery["target"]))
            if (referenced is None or referenced["id"] != recovery.get("planId")
                    or not any(c["rownd_user_id"] == literal for c in referenced["candidates"])):
                raise AdministrativePolicyError("Owner recovery pointer changed")
            if recovery["target"] not in visited:
                pending.append(recovery["target"])
        plan = read_owner_plan(raw)
        if plan is None:
            continue
        if tenant_id != "public":
            raise AdministrativePolicyError("Owner consolidation requires public tenant membership")
        await validate_completed_owner_plan(plan, user_context)
        if user_id != plan["sourceId"]:
            raise AdministrativePolicyError("Owner consolidation session owner changed")
        member = await store.user(recipe_user_id)
        rid = await store.immutable(recipe_user_id)
        matching = []
        if member is not None:
            matching = [m for m in member.login_methods if await store.immutable(m.recipe_user_id.get_as_string()) == rid]
        if member is None or member.id != user_id or len(matching) != 1 or tenant_id not in matching[0].tenant_ids:
            raise AdministrativePolicyError("Owner consolidation session membership changed")


async def validate_completed_owner_plan(plan: dict[str, Any], user_context: dict[str, Any]) -> None:
    validated = read_owner_plan({OWNER_PLAN_KEY: plan})
    if validated is None or validated["status"] != "COMPLETE" or validated.get("reservation"):
        raise AdministrativePolicyError("Owner consolidation is incomplete")
    completion = validated.get("completion", {"recipes": validated["recipes"], "state": owner_state_at(validated)})
    if "completion" not in validated:
        completion = copy.deepcopy(completion)
        for recipe in completion["recipes"]:
            if recipe.get("email"):
                mapping = next(m for m in completion["state"]["mappings"] if m["id"] == recipe["id"])
                cell = next(c for c in completion["state"]["verifications"] if c["id"] == mapping.get("alias", recipe["id"]) and c["email"] == recipe["email"])
                recipe["verified"] = cell["verified"]
    if not isinstance(completion, dict) or not isinstance(completion.get("recipes"), list):
        raise AdministrativePolicyError("Missing completed owner state")
    store = AdministrativeCore(user_context)
    store.fresh()
    stored = read_owner_plan(await store.raw(validated["target"]))
    if not same_json(stored, validated):
        raise AdministrativePolicyError("Completed owner checkpoint changed")
    state = completion.get("state")
    if not isinstance(state, dict) or not isinstance(state.get("markers"), list):
        raise AdministrativePolicyError("Invalid completed owner state")
    observed = await store.inspect_graph([validated["target"]], [m["id"] for m in state["markers"]], completion["recipes"])
    if not same_json(observed["state"], state) or not same_json(observed["recipes"], completion["recipes"]):
        raise AdministrativePolicyError("Completed owner graph changed")
    if any(g["owner"] != validated["target"] or g["primary"] is not True for g in state["graph"]):
        raise AdministrativePolicyError("Completed owner graph has foreign recipes")
    for alias in validated["aliases"]:
        mapping = await store.mapping(alias["id"])
        if mapping is None or mapping["id"] != alias["to"]:
            raise AdministrativePolicyError("Completed owner mapping changed")
    for retired in validated.get("retiredAliases", []):
        literal = await store.raw(retired["id"])
        if await store.mapping(retired["id"]) or not same_json(literal.get("rownd_migration_superseded"), {
            "rowndUserId": validated["sourceId"], "targetUserId": validated["target"]}):
            raise AdministrativePolicyError("Retired owner alias changed")
    history = validated.get("legacySessionAliasHistory")
    if history is not None:
        anchor = next((r for r in validated["recipes"] if r["id"] == validated["target"]), None)
        if (not isinstance(history, dict) or anchor is None
                or history.get("instantRecipeId") != anchor["id"]
                or history.get("instantRecipeIdentity") != anchor["identity"]
                or not isinstance(history.get("aliases"), list)
                or any(not isinstance(a, str) or not a for a in history["aliases"])):
            raise AdministrativePolicyError("Invalid instant session alias history")
        identity = json.loads(anchor["identity"])
        if not isinstance(identity[3], dict) or identity[3].get("id") != "instant":
            raise AdministrativePolicyError("Invalid instant session anchor")


def register_session_owner_validator() -> None:
    try:
        authentication = import_module(".session_authentication", __package__)
    except ModuleNotFoundError as error:
        if error.name != "supertokens_rownd.session_authentication":
            raise
        return
    authentication.register_owner_plan_validator(validate_completed_owner_plan)
    reader_registration = getattr(authentication, "register_owner_plan_reader", None)
    if reader_registration is not None:
        reader_registration(read_owner_plan)

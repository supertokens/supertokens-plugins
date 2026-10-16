from __future__ import annotations

import copy
import json
from typing import Any

from supertokens_python.recipe.usermetadata import asyncio as metadata

from .admin_core import AdministrativeCore, same_json
from .admin_planning import AdministrativePolicyError, owner_state_at, validate_profile
from .rownd_repository import valid_lookup_id
from .admin_source import source_evidence

HISTORY_KEY = "rownd_migration_admin_source_history"
JsonDict = dict[str, Any]


def successful_profiles(raw: JsonDict, tenant_id: str, source_id: str) -> list[JsonDict]:
    history = raw.get(HISTORY_KEY, {})
    if not isinstance(history, dict):
        raise AdministrativePolicyError("Invalid tenant source history")
    result = []
    for tenant, receipt in history.items():
        if (not isinstance(tenant, str) or not tenant or not isinstance(receipt, dict)
                or receipt.get("version") != 1 or type(receipt.get("version")) is not int
                or not valid_lookup_id(receipt.get("sourceId"))
                or not valid_lookup_id(receipt.get("methodPlanId"))
                or not isinstance(receipt.get("profiles"), list) or not receipt["profiles"]):
            raise AdministrativePolicyError("Invalid tenant source history")
        profiles = [validate_profile(p, receipt["sourceId"]) for p in receipt["profiles"]]
        if tenant == tenant_id and receipt["sourceId"] == source_id:
            result.extend(profiles)
    return result


async def record_successful_profile(store: AdministrativeCore, checkpoint: JsonDict) -> None:
    """Publish only after method execution and finalization both complete."""
    target = checkpoint.get("target")
    if not isinstance(target, str) or not valid_lookup_id(target):
        raise AdministrativePolicyError("Invalid successful source target")
    store.fresh()
    raw = await store.raw(target)
    finalization = raw.get("rownd_migration_admin_finalization")
    if (checkpoint.get("status") != "COMPLETE" or checkpoint.get("tenantId") != store.tenant_id
            or not same_json(raw.get("rownd_migration_admin_methods"), checkpoint)
            or not isinstance(finalization, dict) or finalization.get("status") != "COMPLETE"
            or finalization.get("target") != target
            or finalization.get("sourceId") != checkpoint.get("sourceId")
            or finalization.get("tenantId") != store.tenant_id
            or not same_json(finalization.get("source"), source_evidence(checkpoint["profile"]))):
        raise AdministrativePolicyError("Successful source checkpoint is incomplete")
    profile = validate_profile(checkpoint.get("profile"), checkpoint["sourceId"])
    profiles = successful_profiles(raw, store.tenant_id, checkpoint["sourceId"])
    if not any(same_json(profile, previous) for previous in profiles):
        profiles.append(profile)
    history = copy.deepcopy(raw.get(HISTORY_KEY, {}))
    prior = history.get(store.tenant_id)
    if prior is not None and prior["sourceId"] != checkpoint["sourceId"]:
        raise AdministrativePolicyError("Tenant source history owner changed")
    history[store.tenant_id] = {"version": 1, "sourceId": checkpoint["sourceId"],
                              "methodPlanId": checkpoint["id"], "profiles": profiles}
    await metadata.update_user_metadata(target, {HISTORY_KEY: history}, store.context)
    store.fresh()
    if not same_json((await store.raw(target)).get(HISTORY_KEY), history):
        raise AdministrativePolicyError("Tenant source history changed")


def single_owner_lineage(plan: JsonDict) -> bool:
    """A single elected source is insufficient: reject historical donor owners too."""
    return (len(plan["candidates"]) == 1
            and plan["candidates"][0]["rownd_user_id"] == plan["sourceId"]
            and len(plan["aliases"]) == 1
            and plan["aliases"][0]["id"] == plan["sourceId"]
            and plan["aliases"][0]["to"] == plan["target"]
            and not plan.get("retiredAliases")
            and not plan.get("legacySessionAliasHistory")
            and all(g["owner"] == plan["target"] for g in plan["initial"]["graph"]))


def require_single_owner_tenant_transition(plan: JsonDict) -> None:
    if plan.get("status") != "COMPLETE" or not single_owner_lineage(plan):
        raise AdministrativePolicyError("Consolidated owner lineage cannot acquire tenant membership")


def completed_tenant_memberships(plan: JsonDict, checkpoint: JsonDict) -> list[JsonDict]:
    require_single_owner_tenant_transition(plan)
    if (checkpoint.get("status") != "COMPLETE" or checkpoint.get("target") != plan["target"]
            or checkpoint.get("sourceId") != plan["sourceId"]
            or not valid_lookup_id(checkpoint.get("id"))
            or not isinstance(checkpoint.get("tenantId"), str) or not checkpoint["tenantId"]):
        raise AdministrativePolicyError("Invalid tenant membership checkpoint")
    memberships = {m["id"]: copy.deepcopy(m) for m in plan.get("tenantMemberships", [])}
    recipes = {r["id"]: r for r in plan.get("completion", plan)["recipes"]}
    for step in checkpoint["operations"]:
        if step["kind"] != "associate":
            continue
        rid = step["id"]
        if rid not in recipes or not same_json(json.loads(step["identity"]), json.loads(recipes[rid]["identity"])):
            raise AdministrativePolicyError("Tenant association is outside owner lineage")
        tenants = json.loads(step["identity"])[4]
        memberships[rid] = {"id": rid, "methodPlanId": checkpoint["id"],
                            "tenantIds": sorted(set([*tenants, checkpoint["tenantId"]]))}
    return [memberships[rid] for rid in sorted(memberships)]


def retirement_alias_receipt(plan: JsonDict, step: JsonDict) -> JsonDict | None:
    if step.get("kind") != "retire":
        return None
    recipe = next((r for r in plan["recipes"] if r["id"] == step.get("id")), None)
    if (recipe is None or recipe["id"] == plan["target"]
            or not same_json(json.loads(recipe["identity"]), json.loads(step["identity"]))):
        raise AdministrativePolicyError("Alias retirement recipe is not in owner lineage")
    mapping = next(m for m in owner_state_at(plan)["mappings"] if m["id"] == recipe["id"])
    if "alias" not in mapping:
        return None
    if mapping["alias"] == plan["sourceId"]:
        raise AdministrativePolicyError("Cannot retire canonical source alias")
    return {"ownerPlanId": plan["id"], "sourceId": plan["sourceId"], "target": plan["target"],
            "recipe": copy.deepcopy(recipe), "mapping": copy.deepcopy(mapping)}


async def prepare_alias_retirement(store: AdministrativeCore, plan: JsonDict,
                                   step: JsonDict) -> JsonDict | None:
    """Save the returned receipt in the method step before deleting its recipe."""
    receipt = retirement_alias_receipt(plan, step)
    if receipt is None:
        return None
    mapping = receipt["mapping"]
    store.fresh()
    if (not same_json(await store.mapping(mapping["alias"]), mapping)
            or not same_json(await store.mapping(mapping["id"], "SUPERTOKENS"), mapping)):
        raise AdministrativePolicyError("Alias changed before retirement")
    marker = {"rowndUserId": plan["sourceId"], "targetUserId": plan["target"]}
    raw = await store.raw(mapping["alias"])
    if raw.get("rownd_migration_superseded") not in (None, marker):
        raise AdministrativePolicyError("Alias retirement target changed")
    await metadata.update_user_metadata(mapping["alias"], {
        "rownd_migration_superseded": marker}, store.context)
    store.fresh()
    return receipt


async def validate_retired_alias(store: AdministrativeCore, plan: JsonDict,
                                 receipt: JsonDict) -> None:
    try:
        expected = retirement_alias_receipt(plan, {
            "kind": "retire", "id": receipt["recipe"]["id"],
            "identity": receipt["recipe"]["identity"]})
        if expected is None or not same_json(expected, receipt):
            raise AdministrativePolicyError("Invalid alias retirement receipt")
        mapping = receipt["mapping"]
    except (KeyError, TypeError, ValueError, StopIteration):
        raise AdministrativePolicyError("Invalid alias retirement receipt") from None
    store.fresh()
    if (await store.user(mapping["id"]) is not None
            or await store.mapping(mapping["id"], "SUPERTOKENS") is not None
            or await store.mapping(mapping["alias"]) is not None
            or not same_json((await store.raw(mapping["alias"])).get("rownd_migration_superseded"),
                             {"rowndUserId": plan["sourceId"], "targetUserId": plan["target"]})):
        raise AdministrativePolicyError("Retired method alias changed")


async def validate_recovery_mappings(store: AdministrativeCore, plan: JsonDict,
                                     checkpoint: JsonDict) -> None:
    for mapping in owner_state_at(plan)["mappings"]:
        current = await store.mapping(mapping["id"], "SUPERTOKENS") or {"id": mapping["id"]}
        if same_json(current, mapping):
            continue
        eligible = [step for index, step in enumerate(checkpoint["operations"])
                    if index <= checkpoint["cursor"] and step.get("kind") == "retire"
                    and step.get("id") == mapping["id"] and step.get("aliasRetirement")]
        if len(eligible) != 1:
            raise AdministrativePolicyError("Method recovery mappings changed")
        await validate_retired_alias(store, plan, eligible[0]["aliasRetirement"])

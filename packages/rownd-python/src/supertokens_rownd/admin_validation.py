from __future__ import annotations

import json
from importlib import import_module
from typing import Any

from .admin_core import AdministrativeCore, same_json
from .admin_planning import OWNER_PLAN_KEY, AdministrativePolicyError, read_owner_plan


async def validate_completed_owner_plan(plan: dict[str, Any], user_context: dict[str, Any]) -> None:
    validated = read_owner_plan({OWNER_PLAN_KEY: plan})
    if validated is None or validated["status"] != "COMPLETE" or validated.get("reservation"):
        raise AdministrativePolicyError("Owner consolidation is incomplete")
    completion = validated.get("completion")
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

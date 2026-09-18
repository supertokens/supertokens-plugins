from __future__ import annotations

import copy
import re
import json
import math
from datetime import datetime, timezone
from typing import Any, Optional

from .errors import RowndPluginError
from .rownd_compatibility import (
    is_internal_metadata_field,
    is_rownd_email_verified,
    map_rownd_user_to_supertokens,
)
from .rownd_repository import valid_lookup_id
JsonDict = dict[str, Any]


class AdministrativePolicyError(RowndPluginError):
    pass


class AmbiguousElection(AdministrativePolicyError):
    def __init__(self, candidates: list[JsonDict]):
        super().__init__("Rownd activity does not establish a unique owner of the shared current identity")
        self.candidates = candidates


OWNER_PLAN_KEY = "rownd_migration_owner_consolidation"
POLICY_MARKERS = {
    "original_rownd_user", "rownd_email_recipe_user_id", "rownd_email_recipe_user_ids",
    "rownd_pending_verification", "rownd_migration_email_retirements",
    "rownd_migration_provider_retirements", "rownd_migration_provider_introductions",
    "rownd_migration_provider_introduction", "rownd_migration_target",
    "rownd_migration_canonical_target", "rownd_migration_superseded",
}


def provider_subject(profile: JsonDict, provider: str) -> Optional[str]:
    field = provider + "_id"
    for container in (profile.get("verified_data", {}), profile["data"]):
        value = container.get(field)
        if isinstance(value, str) and value.strip():
            return value
    return None


def validate_profile(profile: Any, source_id: str) -> JsonDict:
    if (not isinstance(profile, dict) or not isinstance(profile.get("data"), dict)
            or not isinstance(profile.get("verified_data", {}), dict)):
        raise AdministrativePolicyError("Invalid Rownd source payload")
    if profile["data"].get("user_id") != source_id:
        raise AdministrativePolicyError("SOURCE_ID_MISMATCH")
    if profile.get("state", "enabled") != "enabled":
        raise AdministrativePolicyError("Rownd source is not enabled")
    for container in (profile["data"], profile.get("verified_data", {})):
        for field in ("email", "phone_number", "google_id", "apple_id"):
            value = container.get(field)
            if value is not None and not isinstance(value, (str, bool)):
                raise AdministrativePolicyError("Invalid Rownd identity")
            if container is profile["data"] and isinstance(value, bool):
                raise AdministrativePolicyError("Invalid Rownd identity")
    return copy.deepcopy(profile)


def administrative_source(profile: JsonDict, tenant_id: str) -> JsonDict:
    normalized = copy.deepcopy(profile)
    for container in (normalized["data"], normalized.setdefault("verified_data", {})):
        for field in ("email", "phone_number", "google_id", "apple_id"):
            if container.get(field) in (None, ""):
                container.pop(field, None)
    for provider in ("google", "apple"):
        subject = provider_subject(normalized, provider)
        if subject:
            normalized["data"][provider + "_id"] = subject
    source: JsonDict = map_rownd_user_to_supertokens(normalized, tenant_id)
    for method in source["loginMethods"]:
        if method.get("phoneNumber"):
            phone = method["phoneNumber"]
            if not re.fullmatch(r"\+[1-9][0-9]{1,14}", phone):
                raise AdministrativePolicyError("Invalid Rownd phone identity")
            method["isVerified"] = normalized["verified_data"].get("phone_number") in (True, phone)
    source["userMetadata"] = metadata_backfill(profile, {})
    return source


def identity_keys(profile: JsonDict) -> set[str]:
    keys = set()
    email = profile["data"].get("email")
    if isinstance(email, str) and email and not email.endswith("@anonymous.local"):
        keys.add("email:" + email.lower())
    for provider in ("google", "apple"):
        subject = provider_subject(profile, provider)
        if subject:
            keys.add(provider + ":" + subject)
    return keys


def activity(profile: JsonDict, now: datetime) -> Optional[str]:
    valid = []
    meta = profile.get("meta", {})
    for key in ("last_sign_in", "last_active"):
        value = meta.get(key) if isinstance(meta, dict) else None
        if (not isinstance(value, str) or not re.fullmatch(
                r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)", value)
                or value.endswith("-00:00")):
            continue
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            continue
        if parsed <= now:
            valid.append(parsed)
    return max(valid).astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z") if valid else None


def elect(candidates: list[JsonDict], profiles: dict[str, JsonDict],
          canonical_id: Optional[str] = None, phone_proof: Optional[JsonDict] = None,
          instant_proof: Optional[JsonDict] = None, now: Optional[datetime] = None) -> JsonDict:
    unique: dict[str, JsonDict] = {}
    for candidate in candidates:
        source_id = candidate["rownd_user_id"]
        if source_id in unique and unique[source_id].get("supertokens_user_id") != candidate.get("supertokens_user_id"):
            raise AmbiguousElection(candidates)
        unique[source_id] = candidate
    observed = []
    shared: Optional[set[str]] = None
    for source_id, candidate in sorted(unique.items()):
        profile = validate_profile(profiles[source_id], source_id)
        keys = identity_keys(profile)
        shared = keys if shared is None else shared & keys
        timestamp = activity(profile, now or datetime.now(timezone.utc))
        observed.append({**candidate, **({"activity": timestamp} if timestamp else {})})
    phone_evidence = bool(phone_proof and all(
        profiles[c["rownd_user_id"]]["data"].get("phone_number") == phone_proof["phoneNumber"]
        and profiles[c["rownd_user_id"]].get("verified_data", {}).get("phone_number") == phone_proof["phoneNumber"]
        and c.get("supertokens_user_id") in (None, phone_proof["supertokensUserId"])
        for c in observed))
    if not observed or (len(observed) > 1 and not shared and not phone_evidence and not instant_proof):
        raise AmbiguousElection(observed)
    competing = [c for c in observed if not instant_proof or c["rownd_user_id"] != instant_proof["instantAlias"]]
    ranked = [c for c in competing if "activity" in c]
    latest = max((c["activity"] for c in ranked), default=None)
    tied = [c for c in ranked if c["activity"] == latest] if ranked else competing
    winner = competing[0] if len(competing) == 1 else tied[0] if len(tied) == 1 and ranked else next(
        (c for c in tied if c["rownd_user_id"] == canonical_id), None)
    if winner is None:
        raise AmbiguousElection(observed)
    return {"winner": winner, "candidates": observed, "basis": "latest_valid_activity",
            **({"canonical_rownd_user_id": canonical_id} if canonical_id else {})}


def metadata_backfill(profile: JsonDict, occupied: JsonDict) -> JsonDict:
    values = {**profile.get("meta", {}), **profile["data"]}
    identity_fields = {"user_id", "email", "phone_number", "google_id", "apple_id"}
    patch = {key: copy.deepcopy(value) for key, value in values.items()
             if key not in occupied and key not in identity_fields
             and not is_internal_metadata_field(key) and value is not None}
    if "original_rownd_user" not in occupied:
        patch["original_rownd_user"] = copy.deepcopy(profile)
    return patch


def repair_metadata_references(values: JsonDict, replacements: dict[str, str]) -> JsonDict:
    result = copy.deepcopy(values)
    reference_fields = {"rownd_email_recipe_user_id", "verificationRecipeUserId",
                        "targetCanonicalRecipeUserId", "recipeUserId"}

    def visit(value: Any) -> None:
        if isinstance(value, list):
            for item in value:
                visit(item)
        elif isinstance(value, dict):
            for key, item in value.items():
                if key in reference_fields and isinstance(item, str):
                    value[key] = replacements.get(item, item)
                elif key == "rownd_email_recipe_user_ids" and isinstance(item, dict):
                    value[key] = {tenant: replacements.get(pointer, pointer)
                                  if isinstance(pointer, str) else pointer
                                  for tenant, pointer in item.items()}
                else:
                    visit(item)
    # Custom application objects must never be rewritten as policy references.
    policy = {key: value for key, value in result.items() if key in POLICY_MARKERS and key != "original_rownd_user"}
    visit(policy)
    result.update(policy)
    return result


def apply_owner_operation(state: JsonDict, operation: JsonDict, target: str) -> JsonDict:
    result = copy.deepcopy(state)
    kind, recipe_id = operation["kind"], operation["id"]
    def entry(collection: str, predicate=None):
        found = next((e for e in result[collection] if e["id"] == recipe_id
                      and (predicate is None or predicate(e))), None)
        if found is None:
            raise AdministrativePolicyError("Invalid duplicate owner consolidation plan")
        return found
    if kind == "revoke_verification_tokens":
        return result
    if kind == "verify_email":
        entry("verifications", lambda e: e["email"] == operation["email"])["verified"] = True
    elif kind == "metadata":
        entry("markers")["values"] = copy.deepcopy(operation["values"])
    elif kind in {"delete_mapping", "create_mapping"}:
        mapping = entry("mappings")
        if kind == "delete_mapping":
            if mapping.get("alias") != operation["alias"]:
                raise AdministrativePolicyError("Mapping changed")
            mapping.pop("alias", None)
            mapping.pop("info", None)
        else:
            if mapping.get("alias") or any(e.get("alias") == operation["alias"] for e in result["mappings"]):
                raise AdministrativePolicyError("Mapping changed")
            mapping["alias"] = operation["alias"]
            if "info" in operation:
                mapping["info"] = operation["info"]
    elif kind in {"detach", "promote", "link"}:
        recipe = entry("graph")
        if kind == "detach":
            if (not recipe["primary"] or recipe["owner"] == target or
                    (recipe["owner"] == recipe_id and any(e["owner"] == recipe_id and e["id"] != recipe_id for e in result["graph"]))):
                raise AdministrativePolicyError("Unsafe owner demotion")
            recipe.update(owner=recipe_id, primary=False)
        elif kind == "promote":
            if recipe["owner"] != recipe_id or recipe_id != target or recipe["primary"]:
                raise AdministrativePolicyError("Invalid owner promotion")
            recipe["primary"] = True
        else:
            if recipe["primary"] or recipe["owner"] != recipe_id or not any(e["id"] == target and e["primary"] for e in result["graph"]):
                raise AdministrativePolicyError("Invalid owner linking")
            recipe.update(owner=target, primary=True)
            cell = operation.get("verifiedEmail")
            if cell:
                found = next((e for e in result["verifications"] if e["id"] == cell["id"] and e["email"] == cell["email"]), None)
                if found is None:
                    raise AdministrativePolicyError("Missing verification cell")
                found["verified"] = True
    else:
        raise AdministrativePolicyError("Unknown owner operation")
    return result


def owner_state_at(plan: JsonDict, cursor: Optional[int] = None) -> JsonDict:
    state = plan["initial"]
    for operation in plan["operations"][:plan["cursor"] if cursor is None else cursor]:
        state = apply_owner_operation(state, operation, plan["target"])
    return state


def plan_owner_operations(plan: JsonDict, profile: JsonDict) -> list[JsonDict]:
    state = copy.deepcopy(plan["initial"])
    actions: list[JsonDict] = []
    target = plan["target"]
    recipes = {r["id"]: r for r in plan["recipes"]}
    for recipe in recipes.values():
        if recipe.get("email"):
            address = next(e.get("alias", e["id"]) for e in state["mappings"] if e["id"] == recipe["id"])
            cell = next((c for c in state["verifications"] if c["id"] == address and c["email"] == recipe["email"]), None)
            if cell is None or type(cell["verified"]) is not bool or cell["verified"] is not recipe["verified"]:
                raise AdministrativePolicyError("Baseline recipe verification does not match literal address")
    def append(operation: JsonDict) -> None:
        nonlocal state
        state = apply_owner_operation(state, operation, target)
        actions.append(operation)
    for owner in sorted({e["owner"] for e in state["graph"] if e["primary"] and e["owner"] != target}):
        for entry in list(state["graph"]):
            if entry["owner"] == owner and entry["id"] != owner:
                append({"kind": "detach", "id": entry["id"]})
        append({"kind": "detach", "id": owner})
    if not next(e for e in state["graph"] if e["id"] == target)["primary"]:
        append({"kind": "promote", "id": target})
    for entry in list(state["graph"]):
        if entry["owner"] != target:
            recipe = recipes[entry["id"]]
            operation = {"kind": "link", "id": entry["id"]}
            if recipe.get("email"):
                for other in state["graph"]:
                    other_recipe = recipes[other["id"]]
                    if other["owner"] == target and other_recipe.get("email", "").lower() == recipe["email"].lower():
                        address = next(e.get("alias", e["id"]) for e in state["mappings"] if e["id"] == other["id"])
                        if any(c["id"] == address and c["email"] == other_recipe["email"] and c["verified"] for c in state["verifications"]):
                            operation["verifiedEmail"] = {"id": next(e.get("alias", e["id"]) for e in state["mappings"] if e["id"] == entry["id"]), "email": recipe["email"]}
            append(operation)
    retired = plan.get("retiredAliases", [])
    changed_aliases = [a for a in plan["aliases"] if a.get("from") != a["to"]] + retired
    emails = {r["email"] for r in recipes.values() if r.get("email")}
    for alias in changed_aliases:
        for email in sorted(emails):
            append({"kind": "revoke_verification_tokens", "id": alias["id"], "email": email})
    replacements = {a["id"]: a["from"] for a in retired}
    for alias in plan["aliases"]:
        if alias.get("from") and alias["from"] != alias["to"]:
            replacements[alias["id"]] = next((a["id"] for a in plan["aliases"] if a["to"] == alias["from"]), alias["from"])
    for marker in list(state["markers"]):
        values = repair_metadata_references(marker["values"], replacements)
        if values != marker["values"]:
            append({"kind": "metadata", "id": marker["id"], "values": values})
    for alias in retired:
        marker = next(e for e in state["markers"] if e["id"] == alias["id"])
        append({"kind": "metadata", "id": alias["id"], "values": {
            **marker["values"], "rownd_migration_canonical_target": target,
            "rownd_migration_superseded": {"rowndUserId": plan["sourceId"], "targetUserId": target}}})
    for alias in changed_aliases:
        if alias.get("from"):
            append({"kind": "delete_mapping", "id": alias["from"], "alias": alias["id"]})
    for alias in plan["aliases"]:
        if alias.get("from") != alias["to"]:
            append({"kind": "create_mapping", "id": alias["to"], "alias": alias["id"],
                    **({"info": alias["info"]} if "info" in alias else {})})
            recipe = recipes[alias["to"]]
            if recipe.get("email") and recipe["verified"]:
                append({"kind": "verify_email", "id": alias["id"], "email": recipe["email"]})
    for marker in list(state["markers"]):
        values = copy.deepcopy(marker["values"])
        destination = next((a["to"] for a in plan["aliases"] if a["id"] == marker["id"] or a["to"] == marker["id"]), None)
        if destination:
            for field in ("rownd_migration_target", "rownd_migration_canonical_target"):
                if field in values:
                    values[field] = destination
        if marker["id"] == plan["sourceId"]:
            values["rownd_migration_target"] = target
        if marker["id"] == target:
            values["original_rownd_user"] = copy.deepcopy(profile)
        if values != marker["values"]:
            append({"kind": "metadata", "id": marker["id"], "values": values})
    # A mapping address must never lend an unrelated verification cell to a recipe.
    verified_email = profile["data"].get("email")
    if not is_rownd_email_verified(profile.get("verified_data", {}).get("email"), verified_email):
        verified_email = None
    for cursor in range(len(actions) + 1):
        current = owner_state_at({**plan, "operations": actions}, cursor)
        for recipe in recipes.values():
            if not recipe.get("email"):
                continue
            address = next(e.get("alias", e["id"]) for e in current["mappings"] if e["id"] == recipe["id"])
            cell = next(c for c in current["verifications"] if c["id"] == address and c["email"] == recipe["email"])
            if cell["verified"] and not recipe["verified"] and recipe["email"].lower() != (verified_email or "").lower():
                raise AdministrativePolicyError("Mapping would inherit unrelated email verification")
    return actions


def read_owner_plan(metadata: JsonDict) -> Optional[JsonDict]:
    def require(condition: Any) -> None:
        if not condition:
            raise AdministrativePolicyError("Invalid duplicate owner consolidation plan")

    plan = metadata.get(OWNER_PLAN_KEY)
    if plan is None:
        return None
    try:
        require(isinstance(plan, dict) and type(plan["version"]) is int and plan["version"] == 2)
        require(all(valid_lookup_id(plan[k]) for k in ("id", "sourceId", "target")))
        require(plan["status"] in {"READY", "APPLYING", "RECONCILING", "COMPLETE"})
        require(type(plan["cursor"]) is int and 0 <= plan["cursor"] <= len(plan["operations"]))
        ids = {r["id"] for r in plan["recipes"]}
        require(ids and len(ids) == len(plan["recipes"]) and plan["target"] in ids)
        require(all(valid_lookup_id(i) for i in ids))
        require(isinstance(plan["candidates"], list) and plan["candidates"])
        candidate_ids = [c["rownd_user_id"] for c in plan["candidates"]]
        require(len(set(candidate_ids)) == len(candidate_ids) and plan["sourceId"] in candidate_ids)
        require(all(valid_lookup_id(i) for i in candidate_ids))
        require(all("supertokens_user_id" not in c or valid_lookup_id(c["supertokens_user_id"]) for c in plan["candidates"]))
        require(isinstance(plan["absentAliases"], list) and all(valid_lookup_id(i) for i in plan["absentAliases"]))
        initial = plan["initial"]
        require({e["id"] for e in initial["graph"]} == ids)
        require({e["id"] for e in initial["mappings"]} == ids)
        require(len(initial["graph"]) == len(ids) and len(initial["mappings"]) == len(ids))
        require(all(e["owner"] in ids and type(e["primary"]) is bool for e in initial["graph"]))
        require(all(isinstance(r["identity"], str) and type(r["verified"]) is bool for r in plan["recipes"]))
        for recipe in plan["recipes"]:
            identity = json.loads(recipe["identity"])
            require(isinstance(identity, list) and len(identity) == 7)
            require(identity[0] in {"passwordless", "thirdparty", "emailpassword", "webauthn"})
            require(identity[4] == ["public"])
            require(type(identity[5]) in (int, float) and math.isfinite(identity[5]) and identity[5] >= 0)
            require(identity[1] == recipe.get("email"))
            require(identity[1] is None or isinstance(identity[1], str) and bool(identity[1]))
            require(identity[2] is None or isinstance(identity[2], str) and bool(identity[2]))
            if identity[0] == "thirdparty":
                require(isinstance(identity[3], dict) and valid_lookup_id(identity[3].get("id")) and valid_lookup_id(identity[3].get("userId")))
            else:
                require(identity[3] is None)
            if identity[0] == "passwordless":
                require(identity[1] or identity[2])
        aliases = [m["alias"] for m in initial["mappings"] if "alias" in m]
        require(len(set(aliases)) == len(aliases) and not ids.intersection(aliases))
        require(all(valid_lookup_id(a) for a in aliases))
        require(all("info" not in m or isinstance(m["info"], str) for m in initial["mappings"]))
        final_aliases = [a["id"] for a in plan["aliases"]]
        final_destinations = [a["to"] for a in plan["aliases"]]
        retired_ids = [a["id"] for a in plan.get("retiredAliases", [])]
        require(len(set(final_aliases)) == len(final_aliases) and len(set(final_destinations)) == len(final_destinations))
        require(len(set(retired_ids)) == len(retired_ids) and not set(retired_ids).intersection(final_aliases))
        for alias in [*plan["aliases"], *plan.get("retiredAliases", [])]:
            require(valid_lookup_id(alias["id"]) and alias["id"] not in ids)
            require(alias.get("from") is None or alias["from"] in ids)
            require("to" not in alias or alias["to"] in ids)
        marker_ids = [m["id"] for m in initial["markers"]]
        require(len(set(marker_ids)) == len(marker_ids))
        require(ids.union(aliases).union(candidate_ids).issubset(marker_ids))
        require(all(isinstance(m["values"], dict) and set(m["values"]).issubset(POLICY_MARKERS) for m in initial["markers"]))
        emails = {r["email"] for r in plan["recipes"] if r.get("email")}
        cells = [(c["id"], c["email"]) for c in initial["verifications"]]
        require(len(set(cells)) == len(cells) and set(cells) == {(i, e) for i in marker_ids for e in emails})
        require(all(type(c["verified"]) is bool for c in initial["verifications"]))
        for operation in plan["operations"]:
            require(isinstance(operation, dict) and valid_lookup_id(operation.get("id")))
            kind = operation.get("kind")
            require(kind in {"detach", "promote", "link", "delete_mapping", "create_mapping", "metadata", "verify_email", "revoke_verification_tokens"})
            require(operation["id"] in (marker_ids if kind in {"metadata", "verify_email", "revoke_verification_tokens"} else ids))
            if kind == "metadata":
                require(isinstance(operation.get("values"), dict) and set(operation["values"]).issubset(POLICY_MARKERS))
            if kind in {"create_mapping", "delete_mapping"}:
                require(valid_lookup_id(operation.get("alias")) and operation["alias"] in marker_ids)
                require("info" not in operation or isinstance(operation["info"], str))
            if kind in {"verify_email", "revoke_verification_tokens"}:
                require(operation.get("email") in emails)
        require(plan["status"] in {"READY", "APPLYING"} or plan["cursor"] == len(plan["operations"]))
        final = owner_state_at(plan, len(plan["operations"]))
        require(all(e["owner"] == plan["target"] and e["primary"] for e in final["graph"]))
        require(all(any(m["id"] == a["to"] and m.get("alias") == a["id"] for m in final["mappings"]) for a in plan["aliases"]))
        require(any(a["id"] == plan["sourceId"] and a["to"] == plan["target"] for a in plan["aliases"]))
        require(all(m.get("alias") is None or any(a["id"] == m["alias"] and a["to"] == m["id"] for a in plan["aliases"]) for m in final["mappings"]))
        for retired in plan.get("retiredAliases", []):
            require(not any(m.get("alias") == retired["id"] for m in final["mappings"]))
            marker = next(m["values"] for m in final["markers"] if m["id"] == retired["id"])
            require(marker.get("rownd_migration_superseded") == {"rowndUserId": plan["sourceId"], "targetUserId": plan["target"]})
        if plan["status"] == "READY":
            require(plan["cursor"] == 0)
        if plan["status"] == "COMPLETE":
            completion = plan["completion"]
            require(isinstance(completion, dict) and isinstance(completion["recipes"], list) and completion["recipes"])
            completed_ids = [r["id"] for r in completion["recipes"]]
            require(len(set(completed_ids)) == len(completed_ids) and plan["target"] in completed_ids)
            for recipe in completion["recipes"]:
                identity = json.loads(recipe["identity"])
                require(isinstance(identity, list) and len(identity) == 7 and identity[4] == ["public"])
                require(type(identity[5]) in (int, float) and math.isfinite(identity[5]) and identity[5] >= 0)
                require(type(recipe["verified"]) is bool)
            state = completion["state"]
            require(set(g["id"] for g in state["graph"]) == set(completed_ids))
            require(len(state["graph"]) == len(completed_ids))
            require(all(g["owner"] == plan["target"] and g["primary"] is True for g in state["graph"]))
            require(set(m["id"] for m in state["mappings"]) == set(completed_ids))
            require(len(state["mappings"]) == len(completed_ids))
            require(all(type(c["verified"]) is bool for c in state["verifications"]))
        history = plan.get("legacySessionAliasHistory")
        if history is not None:
            anchor = next(r for r in plan["recipes"] if r["id"] == plan["target"])
            identity = json.loads(anchor["identity"])
            require(identity[0] == "thirdparty" and isinstance(identity[3], dict) and identity[3].get("id") == "instant")
            require(history["instantRecipeId"] == plan["target"] and history["instantRecipeIdentity"] == anchor["identity"])
            require(isinstance(history["aliases"], list) and history["aliases"])
            require(all(valid_lookup_id(a) and a not in ids for a in history["aliases"]))
            require(len(set(history["aliases"])) == len(history["aliases"]))
    except (KeyError, TypeError, ValueError, AssertionError, StopIteration, AdministrativePolicyError):
        raise AdministrativePolicyError("Invalid duplicate owner consolidation plan") from None
    return copy.deepcopy(plan)

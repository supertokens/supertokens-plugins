from __future__ import annotations

import json
from typing import Any, Optional

from supertokens_python.recipe.emailverification import asyncio as verification
from supertokens_python.recipe.usermetadata import asyncio as metadata
from supertokens_python.types import RecipeUserId

from .admin_core import AdministrativeCore, method_identity, same_json
from .admin_planning import AdministrativePolicyError, POLICY_MARKERS
from .rownd_compatibility import is_rownd_email_verified
from .rownd_repository import valid_lookup_id
from .supertokens_repository import login_method_matches_import

PUBLICATION_KEY = "rownd_migration_mapping_publication"


async def single_owner_snapshot(store: AdministrativeCore, target: str, source_id: str) -> dict[str, Any]:
    store.fresh()
    user = await store.user(target)
    if user is None or await store.immutable(user.id) != target or not user.login_methods:
        raise AdministrativePolicyError("Single-owner reconciliation target changed")
    if not user.is_primary_user and len(user.login_methods) != 1:
        raise AdministrativePolicyError("Invalid single-owner graph")
    recipes = []
    mappings = []
    literals = {target, source_id}
    for method in user.login_methods:
        recipe_id = await store.immutable(method.recipe_user_id.get_as_string())
        member = await store.user(recipe_id)
        if member is None or await store.immutable(member.id) != target or member.is_primary_user != user.is_primary_user:
            raise AdministrativePolicyError("Single-owner recipe membership changed")
        if not method.tenant_ids or any(t not in user.tenant_ids for t in method.tenant_ids):
            raise AdministrativePolicyError("Invalid recipe tenant membership")
        recipes.append({"id": recipe_id, "identity": method_identity(method), "verified": method.verified,
                        **({"email": method.email} if method.email else {})})
        mapping = await store.mapping(recipe_id, "SUPERTOKENS")
        if mapping and not same_json(mapping, await store.mapping(mapping["alias"])):
            raise AdministrativePolicyError("Mapping directions disagree")
        mappings.append(mapping or {"id": recipe_id})
        literals.update((recipe_id, method.recipe_user_id.get_as_string()))
    if set(user.tenant_ids) != {t for m in user.login_methods for t in m.tenant_ids}:
        raise AdministrativePolicyError("Invalid owner tenant membership")
    markers = []
    cells = []
    for literal in sorted(literals):
        raw = await store.raw(literal)
        markers.append({"id": literal, "values": {k: v for k, v in raw.items() if k in POLICY_MARKERS}})
        for email in sorted({r["email"] for r in recipes if r.get("email")}):
            cells.append({"id": literal, "email": email, "verified": await verification.is_email_verified(RecipeUserId(literal), email, store.context)})
    return {"target": target, "primary": user.is_primary_user, "tenantIds": sorted(user.tenant_ids),
            "recipes": sorted(recipes, key=lambda r: r["id"]),
            "mappings": sorted(mappings, key=lambda m: m["id"]), "markers": markers, "verifications": cells}


def read_publication(value: Any) -> Optional[dict[str, Any]]:
    if value is None:
        return None
    try:
        if (not isinstance(value, dict) or type(value.get("version")) is not int or value["version"] != 1
                or not all(valid_lookup_id(value.get(k)) for k in ("target", "sourceId", "tenantId"))
                or not isinstance(value.get("sourceIdentity"), str)
                or not isinstance(json.loads(value["sourceIdentity"]), list)
                or not isinstance(value.get("recipes"), list) or not value["recipes"]):
            raise ValueError()
        ids = set()
        for receipt in value["recipes"]:
            if (not isinstance(receipt, dict) or not valid_lookup_id(receipt.get("id")) or receipt["id"] in ids
                    or type(receipt.get("verified")) is not bool or not isinstance(receipt.get("identity"), str)):
                raise ValueError()
            identity = json.loads(receipt["identity"])
            if not isinstance(identity, list) or len(identity) != 7 or identity[1] != receipt.get("email"):
                raise ValueError()
            ids.add(receipt["id"])
        if value["target"] not in ids:
            raise ValueError()
    except (ValueError, KeyError, TypeError):
        raise AdministrativePolicyError("Invalid mapping publication checkpoint") from None
    return value


async def publish_mapping(operation: Any, target: str, source: dict[str, Any]) -> None:
    store: AdministrativeCore = operation.store
    source_id = source["externalUserId"]
    profile = operation.profiles[source_id]
    email = profile["data"].get("email")
    proof = email if is_rownd_email_verified(profile.get("verified_data", {}).get("email"), email) else None
    plan = read_publication((await store.raw(target)).get(PUBLICATION_KEY))
    if plan is None:
        before = await single_owner_snapshot(store, target, source_id)
        user = await store.user(target)
        if user is None or not any(login_method_matches_import(m, expected) for m in user.login_methods for expected in source["loginMethods"]):
            raise AdministrativePolicyError("Mapping publication lacks a matching source identity")
        if any("alias" in m for m in before["mappings"]):
            raise AdministrativePolicyError("Mapping publication would displace another alias")
        plan = {"version": 1, "target": target, "sourceId": source_id, "tenantId": operation.tenant_id,
                "sourceIdentity": json.dumps(source["loginMethods"], separators=(",", ":")), "recipes": before["recipes"]}

    async def validate() -> None:
        await operation.source_guard()
        if (plan["target"] != target or plan["sourceId"] != source_id or plan["tenantId"] != operation.tenant_id
                or not same_json(json.loads(plan["sourceIdentity"]), source["loginMethods"])):
            raise AdministrativePolicyError("Mapping publication source changed")
        snapshot = await single_owner_snapshot(store, target, source_id)
        observed = {r["id"]: r for r in snapshot["recipes"]}
        for receipt in plan["recipes"]:
            actual = observed.get(receipt["id"])
            if actual is None or not same_json(json.loads(actual["identity"]), json.loads(receipt["identity"])):
                raise AdministrativePolicyError("Mapping publication recipe changed")
            mapping = await store.mapping(receipt["id"], "SUPERTOKENS")
            if mapping and (receipt["id"] != target or mapping["alias"] != source_id):
                raise AdministrativePolicyError("Mapping publication alias changed")
            if receipt.get("email"):
                if await verification.is_email_verified(RecipeUserId(receipt["id"]), receipt["email"], store.context) is not receipt["verified"]:
                    raise AdministrativePolicyError("Mapping publication baseline verification changed")
                address = mapping["alias"] if mapping else receipt["id"]
                effective = await verification.is_email_verified(RecipeUserId(address), receipt["email"], store.context)
                if effective and not receipt["verified"] and receipt["email"].lower() != (proof or "").lower():
                    raise AdministrativePolicyError("Mapping publication would inherit unrelated verification")
        primary = next(r for r in plan["recipes"] if r["id"] == target)
        for expected in source["loginMethods"]:
            address = expected.get("email")
            if address and await verification.is_email_verified(RecipeUserId(source_id), address, store.context):
                if not (primary.get("email") == address and primary["verified"]) and address.lower() != (proof or "").lower():
                    raise AdministrativePolicyError("Mapping publication alias verification changed")
        mapping = await store.mapping(source_id)
        if mapping and mapping["id"] != target:
            raise AdministrativePolicyError("Mapping publication target changed")

    await validate()
    operation.mutation_started = True
    await metadata.update_user_metadata(target, {PUBLICATION_KEY: plan}, store.context)
    await validate()
    if await store.mapping(source_id) is None:
        for expected in source["loginMethods"]:
            if expected.get("email"):
                await store.operation({"kind": "revoke_verification_tokens", "id": source_id, "email": expected["email"]}, target)
        await validate()
        await store.operation({"kind": "create_mapping", "id": target, "alias": source_id}, target)
    await validate()

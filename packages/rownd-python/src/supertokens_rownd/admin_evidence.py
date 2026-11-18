from __future__ import annotations

import json
from typing import Any, Optional

from .admin_core import AdministrativeCore
from .admin_planning import provider_subject
from .rownd_compatibility import is_rownd_email_verified


def identityless_instant(profile: dict[str, Any]) -> bool:
    return profile.get("auth_level") == "instant" and all(
        not container.get(field)
        for container in (profile["data"], profile.get("verified_data", {}))
        for field in ("email", "phone_number", "google_id", "apple_id"))


async def instant_primary_proof(store: AdministrativeCore, candidates: list[dict[str, Any]],
                                profiles: dict[str, dict[str, Any]], checkpoint: Optional[dict[str, Any]]) -> Optional[dict[str, Any]]:
    if len(candidates) != 2:
        return None
    instant = next((c for c in candidates if identityless_instant(profiles[c["rownd_user_id"]])), None)
    if instant is None:
        return None
    authenticated = next(c for c in candidates if c is not instant)
    def original_id(candidate):
        if checkpoint:
            original = next((m["id"] for m in checkpoint["initial"]["mappings"] if m.get("alias") == candidate["rownd_user_id"]), None)
            if original:
                return original
        return candidate.get("supertokens_user_id")
    instant_id, authenticated_id = original_id(instant), original_id(authenticated)
    if not instant_id or not authenticated_id or instant_id == authenticated_id:
        return None
    user = await store.user(instant_id)
    if user is None or not user.is_primary_user or await store.immutable(user.id) != instant_id:
        return None
    if checkpoint and (checkpoint["target"] != instant_id or checkpoint["sourceId"] != authenticated["rownd_user_id"] or any(
        e["owner"] != instant_id or not e["primary"] for e in checkpoint["initial"]["graph"])):
        return None
    methods = {}
    for method in user.login_methods:
        if method.tenant_ids != ["public"]:
            return None
        methods[await store.immutable(method.recipe_user_id.get_as_string())] = method
    anchor, provider_method = methods.get(instant_id), methods.get(authenticated_id)
    if (anchor is None or not anchor.third_party or anchor.third_party.id != "instant"
            or anchor.third_party.user_id != instant["rownd_user_id"] or provider_method is None
            or not provider_method.third_party or provider_method.third_party.id not in {"google", "apple"}):
        return None
    provider = provider_method.third_party
    live = profiles[authenticated["rownd_user_id"]]
    email = live["data"].get("email")
    if not isinstance(email, str) or not provider_method.email or provider_method.email.lower() != email.lower():
        return None
    for candidate, recipe_id in ((instant, instant_id), (authenticated, authenticated_id)):
        snapshots = []
        for literal in (recipe_id, candidate["rownd_user_id"]):
            if checkpoint:
                marker = next((m["values"] for m in checkpoint["initial"]["markers"] if m["id"] == literal), {})
            else:
                marker = await store.raw(literal)
            original = marker.get("original_rownd_user")
            if original is not None:
                snapshots.append(original)
        if not snapshots:
            return None
        for profile in [profiles[candidate["rownd_user_id"]], *snapshots]:
            if not isinstance(profile, dict) or profile.get("state", "enabled") != "enabled" or profile.get("data", {}).get("user_id") != candidate["rownd_user_id"]:
                return None
            if candidate is instant:
                if not identityless_instant(profile):
                    return None
            elif (provider_subject(profile, provider.id) != provider.user_id
                  or profile["data"].get("email", "").lower() != email.lower()
                  or not is_rownd_email_verified(profile.get("verified_data", {}).get("email"), email)
                  or any(container.get(provider.id + "_id") not in (None, "", provider.user_id)
                         for container in (profile["data"], profile.get("verified_data", {})))):
                return None
        owner = await store.user(recipe_id)
        if owner is None or await store.immutable(owner.id) != instant_id:
            return None
        mapping = await store.mapping(candidate["rownd_user_id"])
        if not checkpoint and (mapping is None or mapping["id"] != recipe_id):
            return None
    return {"instantAlias": instant["rownd_user_id"], "authenticatedAlias": authenticated["rownd_user_id"],
            "target": instant_id, "provider": provider.id, "subject": provider.user_id, "email": email.lower()}


def checkpoint_phone_proof(checkpoint: dict[str, Any]) -> Optional[dict[str, Any]]:
    graph, recipes = checkpoint["initial"]["graph"], checkpoint["recipes"]
    if (len(graph) != 1 or len(recipes) != 1 or graph[0]["primary"]
            or graph[0]["id"] != checkpoint["target"] or graph[0]["owner"] != checkpoint["target"]
            or not recipes[0]["verified"]):
        return None
    identity = json.loads(recipes[0]["identity"])
    if (identity[0] != "passwordless" or identity[1] is not None or not identity[2]
            or identity[3] is not None or identity[4] != ["public"]):
        return None
    if not any(c.get("supertokens_user_id") == checkpoint["target"] for c in checkpoint["candidates"]):
        return None
    return {"phoneNumber": identity[2], "supertokensUserId": checkpoint["target"]}

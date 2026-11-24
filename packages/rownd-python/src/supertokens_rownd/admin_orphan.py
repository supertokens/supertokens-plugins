from __future__ import annotations

import copy
from typing import Any, Optional

from supertokens_python import asyncio as core
from supertokens_python.recipe.usermetadata import asyncio as metadata
from supertokens_python.types.base import AccountInfoInput

from .admin_core import AdministrativeCore, same_json
from .admin_planning import AdministrativePolicyError, provider_subject, read_owner_plan
from .rownd_compatibility import is_rownd_email_verified
from .admin_source import source_evidence

ORPHAN_KEY = "rownd_migration_orphan_mapping_repair"


async def inspect_orphan(store: AdministrativeCore, source_id: str, profile: dict[str, Any],
                         mapping: Optional[dict[str, Any]]) -> Optional[dict[str, Any]]:
    raw = await store.raw(source_id)
    prior = raw.get(ORPHAN_KEY)
    if prior is not None:
        if (not isinstance(prior, dict) or type(prior.get("version")) is not int
                or prior["version"] != 1 or prior.get("implementation") != "python"
                or prior.get("phase") not in {"PREPARED", "HANDOFF", "COMPLETE"}
                or prior.get("sourceId") != source_id):
            raise AdministrativePolicyError("Invalid orphan mapping checkpoint")
        if prior["phase"] == "COMPLETE":
            return None
        if not same_json(source_evidence(prior["profile"]), source_evidence(profile)):
            raise AdministrativePolicyError("Orphan recovery source changed")
        if prior["phase"] == "HANDOFF":
            owner_plan = read_owner_plan(await store.raw(prior["target"]))
            if owner_plan is not None:
                if (owner_plan["target"] != prior["target"] or owner_plan["sourceId"] != prior.get("winner", source_id)
                        or await store.user(prior["absentId"]) is not None
                        or (mapping is not None and mapping["id"] != prior["target"])):
                    raise AdministrativePolicyError("Orphan handoff lineage changed")
                return prior
        if mapping is not None and not same_json(mapping, prior["oldMapping"]):
            raise AdministrativePolicyError("Orphan mapping changed")
        old = prior["oldMapping"]
    elif mapping is not None and await store.user(mapping["id"]) is None and await store.user(source_id) is None:
        old = mapping
    else:
        return None
    def fail():
        raise AdministrativePolicyError("MAPPING_TARGET_MISSING: ORPHAN_MAPPING_RECOVERY_BLOCKED")
    email = profile["data"].get("email")
    if (profile.get("state") != "enabled" or not isinstance(email, str)
            or not is_rownd_email_verified(profile.get("verified_data", {}).get("email"), email)
            or await store.user(old["id"]) is not None):
        fail()
    users = await core.list_users_by_account_info("public", AccountInfoInput(email=email), False, store.context)
    owners = await store.owners(users)
    eligible = {}
    for owner, user in owners.items():
        if not user.is_primary_user or not any(m.email and m.email.lower() == email.lower() and m.verified for m in user.login_methods):
            continue
        if not any(m.third_party and m.third_party.id in {"google", "apple"}
                   and provider_subject(profile, m.third_party.id) == m.third_party.user_id for m in user.login_methods):
            continue
        eligible[owner] = user
    if len(eligible) != 1:
        fail()
    target = next(iter(eligible))
    if target in {source_id, old["id"]}:
        fail()
    evidence = await store.inspect_graph([target], [source_id, old["id"]])
    evidence["metadata"] = {}
    evidence["mappings"] = []
    for marker in evidence["state"]["markers"]:
        literal = marker["id"]
        record = await store.raw(literal)
        record.pop(ORPHAN_KEY, None)
        if prior and literal == source_id and prior.get("winner", source_id) != source_id:
            expected_marker = {"rowndUserId": prior["winner"], "targetUserId": target}
            if record.get("rownd_migration_superseded") == expected_marker:
                for field in ("rownd_migration_superseded", "rownd_migration_canonical_target"):
                    record.pop(field, None)
                    marker["values"].pop(field, None)
                    original = prior["evidence"]["metadata"][literal]
                    if field in original:
                        record[field] = original[field]
                        marker["values"][field] = original[field]
        evidence["metadata"][literal] = record
        if literal not in {source_id, old["id"]}:
            evidence["mappings"].append({"id": literal, "external": await store.mapping(literal),
                                          "internal": await store.mapping(literal, "SUPERTOKENS")})
        values = marker["values"]
        if any(k in values for k in ("rownd_migration_superseded", "rownd_pending_verification")):
            fail()
        if any(values.get(k, target) != target for k in ("rownd_migration_target", "rownd_migration_canonical_target")):
            fail()
    checkpoint = {"version": 1, "implementation": "python", "sourceId": source_id,
                  "absentId": old["id"], "target": target, "tenantId": "public",
                  "phase": "PREPARED", "oldMapping": old, "profile": copy.deepcopy(profile),
                  "evidence": evidence}
    if prior is not None and (prior["target"] != target or not same_json(prior["evidence"], evidence)):
        fail()
    return prior or checkpoint


async def retire_orphan(store: AdministrativeCore, checkpoint: dict[str, Any]) -> None:
    if checkpoint["phase"] == "HANDOFF":
        owner_plan = read_owner_plan(await store.raw(checkpoint["target"]))
        if owner_plan is not None:
            return
    current = await inspect_orphan(store, checkpoint["sourceId"], checkpoint["profile"],
                                   await store.mapping(checkpoint["sourceId"]))
    if current is None or not same_json(current["evidence"], checkpoint["evidence"]):
        raise AdministrativePolicyError("Orphan evidence changed before handoff")
    await metadata.update_user_metadata(checkpoint["sourceId"], {ORPHAN_KEY: checkpoint}, store.context)
    winner = checkpoint.get("winner", checkpoint["sourceId"])
    if winner != checkpoint["sourceId"]:
        await metadata.update_user_metadata(checkpoint["sourceId"], {
            "rownd_migration_superseded": {"rowndUserId": winner, "targetUserId": checkpoint["target"]},
            "rownd_migration_canonical_target": checkpoint["target"]}, store.context)
    mapping = await store.mapping(checkpoint["sourceId"])
    if mapping:
        if not same_json(mapping, checkpoint["oldMapping"]):
            raise AdministrativePolicyError("Orphan mapping changed before deletion")
        await core.delete_user_id_mapping(checkpoint["sourceId"], "EXTERNAL", True, store.context)
    store.fresh()
    if await store.mapping(checkpoint["sourceId"]) is not None or await store.user(checkpoint["absentId"]) is not None:
        raise AdministrativePolicyError("Orphan retirement postcondition failed")
    checkpoint["phase"] = "HANDOFF"
    await metadata.update_user_metadata(checkpoint["sourceId"], {ORPHAN_KEY: checkpoint}, store.context)

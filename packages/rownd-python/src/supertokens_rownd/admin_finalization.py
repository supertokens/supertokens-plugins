from __future__ import annotations

import copy
from typing import Any

from supertokens_python.recipe.emailverification import asyncio as verification
from supertokens_python.recipe.usermetadata import asyncio as metadata
from supertokens_python.types import RecipeUserId

from .admin_core import same_json
from .admin_planning import AdministrativePolicyError
from .admin_source import source_evidence

FINAL_KEY = "rownd_migration_admin_finalization"


async def finish(operation: Any, target: str, actions: list[dict[str, Any]]) -> None:
    store = operation.store
    source_id = operation.result["rownd_user_id"]
    evidence = source_evidence(operation.profiles[source_id])
    previous = (await store.raw(target)).get(FINAL_KEY)
    if previous is not None and not isinstance(previous, dict):
        raise AdministrativePolicyError("Invalid finalization checkpoint")
    checkpoint = copy.deepcopy(previous)
    if checkpoint is None or checkpoint.get("status") == "COMPLETE":
        checkpoint = {"version": 1, "sourceId": source_id, "target": target, "tenantId": operation.tenant_id,
                      "source": evidence, "cursor": 0, "status": "APPLYING", "operations": copy.deepcopy(actions)}
        for step in checkpoint["operations"]:
            if step["kind"] == "metadata":
                raw = await store.raw(step["id"])
                step["before"] = {k: raw[k] for k in step["values"] if k in raw}
            else:
                step["before"] = await verification.is_email_verified(RecipeUserId(step["id"]), step["email"], store.context)
    if (not isinstance(checkpoint, dict) or type(checkpoint.get("version")) is not int or checkpoint["version"] != 1
            or checkpoint.get("target") != target or checkpoint.get("sourceId") != source_id
            or checkpoint.get("tenantId") != operation.tenant_id or not same_json(checkpoint.get("source"), evidence)
            or type(checkpoint.get("cursor")) is not int or not isinstance(checkpoint.get("operations"), list)
            or not 0 <= checkpoint["cursor"] <= len(checkpoint["operations"])):
        raise AdministrativePolicyError("Invalid finalization checkpoint")
    # A retry may omit already-filled custom metadata from its backfill patch.
    # Every receipted value must still be present in the freshly derived patch
    # or already be committed at its literal target.
    desired = {(s["kind"], s["id"], s.get("email")): s for s in actions}
    for step in checkpoint["operations"]:
        expected = desired.get((step["kind"], step["id"], step.get("email")))
        if expected is None:
            raise AdministrativePolicyError("Finalization intent changed")
        if step["kind"] == "metadata":
            raw = await store.raw(step["id"])
            for key, value in step["values"].items():
                if key in expected["values"]:
                    if key == "original_rownd_user" and isinstance(value, dict) and isinstance(expected["values"][key], dict):
                        valid = same_json(source_evidence(value), source_evidence(expected["values"][key]))
                    else:
                        valid = same_json(value, expected["values"][key])
                else:
                    valid = key in raw and same_json(value, raw[key])
                if not valid:
                    raise AdministrativePolicyError("Finalization metadata intent changed")
        elif step["kind"] != "verify_email" or type(step.get("before")) is not bool:
            raise AdministrativePolicyError("Invalid finalization operation")

    expected_saved = copy.deepcopy(previous)

    async def unchanged():
        if not same_json((await store.raw(target)).get(FINAL_KEY), expected_saved):
            raise AdministrativePolicyError("Finalization checkpoint changed concurrently")

    async def save():
        nonlocal expected_saved
        await unchanged()
        operation.mutation_started = True
        await metadata.update_user_metadata(target, {FINAL_KEY: checkpoint}, store.context)
        expected_saved = copy.deepcopy(checkpoint)
        await unchanged()

    await save()
    for index, step in enumerate(checkpoint["operations"]):
        await operation.source_guard()
        await unchanged()
        for literal in {target, source_id, step["id"], await store.immutable(step["id"])}:
            pending_verifications = (await store.raw(literal)).get("rownd_pending_verification")
            if pending_verifications not in (None, []):
                raise AdministrativePolicyError("CANONICAL_EMAIL_POLICY")
        if step["kind"] == "metadata":
            raw = await store.raw(step["id"])
            actual = {k: raw[k] for k in step["values"] if k in raw}
            after = step["values"]
        else:
            actual = await verification.is_email_verified(RecipeUserId(step["id"]), step["email"], store.context)
            after = True
        if index < checkpoint["cursor"]:
            if not same_json(actual, after):
                raise AdministrativePolicyError("Committed finalization state changed")
            continue
        if not same_json(actual, after):
            if not same_json(actual, step["before"]):
                raise AdministrativePolicyError("Finalization state is neither current nor next")
            operation.mutation_started = True
            if step["kind"] == "metadata":
                await metadata.update_user_metadata(step["id"], step["values"], store.context)
                store.actions.append("metadata")
                raw = await store.raw(step["id"])
                actual = {k: raw[k] for k in step["values"] if k in raw}
            else:
                await store.operation(step, target)
                actual = await verification.is_email_verified(RecipeUserId(step["id"]), step["email"], store.context)
            if not same_json(actual, after):
                raise AdministrativePolicyError("Finalization postcondition failed")
        checkpoint["cursor"] = index + 1
        await save()
        if step["kind"] == "verify_email":
            await operation.progress("verification")
    checkpoint["status"] = "COMPLETE"
    await save()

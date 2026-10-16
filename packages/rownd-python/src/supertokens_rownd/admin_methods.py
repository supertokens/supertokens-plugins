from __future__ import annotations

import copy
import json
import uuid
from typing import Any
from types import SimpleNamespace

from supertokens_python import asyncio as core
from supertokens_python.recipe.passwordless import asyncio as passwordless
from supertokens_python.recipe.passwordless.interfaces import UpdateUserOkResult
from supertokens_python.recipe.session import asyncio as sessions
from supertokens_python.recipe.usermetadata import asyncio as metadata
from supertokens_python.recipe.emailverification import asyncio as verification
from supertokens_python.recipe.multitenancy import asyncio as multitenancy
from supertokens_python.types import RecipeUserId, LoginMethod

from .admin_core import AdministrativeCore, method_identity, same_json
from .admin_planning import OWNER_PLAN_KEY, POLICY_MARKERS, AdministrativePolicyError, provider_subject, read_owner_plan
from .admin_source import source_evidence
from .admin_lineage import prepare_alias_retirement, successful_profiles, validate_recovery_mappings, retirement_alias_receipt, validate_retired_alias, require_single_owner_tenant_transition
from .supertokens_repository import import_method_account_infos, import_user, login_method_matches_import

METHOD_KEY = "rownd_migration_admin_methods"
RECEIPT_KEY = "rownd_migration_admin_creation"


async def validate_method_recovery(store: AdministrativeCore, plan: dict[str, Any], profile: dict[str, Any]) -> None:
    from .admin_planning import owner_state_at

    target = plan["target"]
    raw = await store.raw(target)
    checkpoint = raw.get(METHOD_KEY)
    if checkpoint is None:
        if plan.get("createdRecipes"):
            originals = (await store.inspect_graph([target], [m["id"] for m in plan["initial"]["markers"]]))
            expected_recipes = {r["id"]: r for r in [*plan["recipes"], *plan["createdRecipes"]]}
            for receipt in originals["recipes"]:
                expected = expected_recipes.get(receipt["id"])
                if expected is None or not same_json(receipt, expected):
                    raise AdministrativePolicyError("Node creation receipt does not match live recipe")
            for receipt in plan["createdRecipes"]:
                user = await store.user(receipt["id"])
                if user is None:
                    raise AdministrativePolicyError("Node created recipe disappeared")
                owner = await store.immutable(user.id)
                if owner not in {target, receipt["id"]} or (owner != target and (user.is_primary_user or len(user.login_methods) != 1)):
                    raise AdministrativePolicyError("Node created recipe acquired another owner")
                matching = [m for m in user.login_methods if await store.immutable(m.recipe_user_id.get_as_string()) == receipt["id"]]
                if len(matching) != 1 or not same_json(json.loads(method_identity(matching[0])), json.loads(receipt["identity"])) or matching[0].verified is not receipt["verified"]:
                    raise AdministrativePolicyError("Node created recipe identity changed")
            original_ids = {r["id"] for r in plan["recipes"]}
            state = originals["state"]
            state["graph"] = [g for g in state["graph"] if g["id"] in original_ids]
            state["mappings"] = [m for m in state["mappings"] if m["id"] in original_ids]
            literals = {m["id"] for m in plan["initial"]["markers"]}
            state["markers"] = [m for m in state["markers"] if m["id"] in literals]
            emails = {c["email"] for c in plan["initial"]["verifications"]}
            state["verifications"] = [c for c in state["verifications"] if c["id"] in literals and c["email"] in emails]
            if not same_json(state, owner_state_at(plan)):
                raise AdministrativePolicyError("Node owner state changed outside creation receipts")
            return
        observed = (await store.inspect_plan(plan))["state"]
        if not same_json(observed, owner_state_at(plan)):
            raise AdministrativePolicyError("Owner state changed before method reconciliation")
        return
    if (not isinstance(checkpoint, dict) or type(checkpoint.get("version")) is not int
            or checkpoint["version"] != 1 or checkpoint.get("target") != target
            or checkpoint.get("sourceId") != plan["sourceId"]
            or not isinstance(checkpoint.get("profile"), dict)
            or not same_json(source_evidence(checkpoint["profile"]), source_evidence(profile))
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
    expected = {r["id"]: [json.loads(r["identity"])] for r in [*plan["recipes"], *plan.get("createdRecipes", [])]}
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
                if rid in expected and not any(r["id"] == rid and same_json(json.loads(r["identity"]), json.loads(receipt["identity"])) for r in plan.get("createdRecipes", [])):
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
        current = await store.mapping(mapping["id"], "SUPERTOKENS")
        if current is not None and "alias" in current and not same_json(await store.mapping(current["alias"]), current):
            raise AdministrativePolicyError("Method recovery reverse mapping changed")
    try:
        await validate_recovery_mappings(store, plan, checkpoint)
    except AdministrativePolicyError:
        for mapping in owner_state_at(plan)["mappings"]:
            if same_json(await store.mapping(mapping["id"], "SUPERTOKENS") or {"id": mapping["id"]}, mapping):
                continue
            eligible = [(i, s) for i, s in enumerate(checkpoint["operations"]) if i <= checkpoint["cursor"]
                        and s.get("kind") == "retire" and s.get("id") == mapping["id"] and s.get("aliasRetirement")]
            if len(eligible) != 1:
                raise AdministrativePolicyError("Unreceipted method mapping changed")
            index, step = eligible[0]
            if await store.user(mapping["id"]) is None:
                await validate_retired_alias(store, plan, step["aliasRetirement"])
            elif index == checkpoint["cursor"]:
                await validate_retirement_mapping_gap(store, plan, step)
            else:
                raise AdministrativePolicyError("Committed retirement recipe still exists")
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
    histories.extend(successful_profiles(target_metadata, store.tenant_id, source["externalUserId"]))
    previous = target_metadata.get(METHOD_KEY)
    finalization = target_metadata.get("rownd_migration_admin_finalization")
    if (isinstance(previous, dict) and previous.get("status") == "COMPLETE"
            and previous.get("tenantId") == store.tenant_id and previous.get("sourceId") == source["externalUserId"]
            and isinstance(finalization, dict) and finalization.get("status") == "COMPLETE"
            and finalization.get("tenantId") == store.tenant_id and finalization.get("sourceId") == source["externalUserId"]
            and same_json(finalization.get("source"), source_evidence(previous["profile"]))):
        histories.append(previous["profile"])
    pointers = target_metadata.get("rownd_email_recipe_user_ids")
    if pointers is not None and (not isinstance(pointers, dict) or any(not isinstance(p, str) or not p for p in pointers.values())):
        raise AdministrativePolicyError("CANONICAL_EMAIL_POLICY")
    canonical = pointers.get(store.tenant_id) if pointers is not None else target_metadata.get("rownd_email_recipe_user_id")
    if canonical is not None and (not isinstance(canonical, str) or not canonical):
        raise AdministrativePolicyError("CANONICAL_EMAIL_POLICY")
    canonical = await store.immutable(canonical) if isinstance(canonical, str) else None
    if canonical and (canonical not in methods or methods[canonical].recipe_id != "passwordless" or not methods[canonical].email):
        raise AdministrativePolicyError("CANONICAL_EMAIL_POLICY")
    old_emails = [(rid, m) for rid, m in methods.items() if store.tenant_id in m.tenant_ids and m.recipe_id == "passwordless" and m.email and contact and m.email.lower() != contact]
    for recipe_id, method in old_emails:
        historical = any(p.get("data", {}).get("email", "").lower() == method.email.lower() for p in histories)
        if not historical or (canonical and canonical != recipe_id):
            raise AdministrativePolicyError("CANONICAL_EMAIL_POLICY")
        current = next((m for m in desired if m.get("recipeId") == "passwordless" and m.get("email", "").lower() == contact), None)
        if current is None:
            continue
        existing_current = any(login_method_matches_import(m, current) for m in methods.values())
        if len(method.tenant_ids) > 1:
            actions.append({"kind": "remove_tenant", "id": recipe_id, "identity": method_identity(method)})
            continue
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
        existing_matches = [(rid, m) for rid, m in methods.items() if login_method_matches_import(m, method)]
        if existing_matches and not any(store.tenant_id in m.tenant_ids for _, m in existing_matches):
            if len(existing_matches) != 1:
                raise AdministrativePolicyError("Ambiguous recipe tenant association")
            rid, matching = existing_matches[0]
            actions.append({"kind": "associate", "id": rid, "identity": method_identity(matching)})
        if id(method) not in replacements and not any(login_method_matches_import(existing, method) for existing in methods.values()):
            if (method.get("email") and not method.get("isVerified")
                    and any(existing.email and existing.email.lower() == method["email"].lower() and existing.verified for existing in methods.values())):
                raise AdministrativePolicyError("Linking would inherit unproven email verification")
            actions.insert(0, {"kind": "create", "method": copy.deepcopy(method)})
    for recipe_id, method in methods.items():
        if store.tenant_id not in method.tenant_ids:
            continue
        provider = method.third_party
        if not provider or provider.id not in {"google", "apple"}:
            continue
        current = provider_subject(profile, provider.id)
        if current and current != provider.user_id:
            historical = any(provider_subject(p, provider.id) == provider.user_id or p.get("data", {}).get(provider.id + "_id") == provider.user_id for p in histories)
            if not historical:
                raise AdministrativePolicyError("Unproven stale provider credential")
            if recipe_id == target and len(method.tenant_ids) == 1:
                raise AdministrativePolicyError("Provider retirement would delete immutable primary recipe")
            actions.append({"kind": "remove_tenant" if len(method.tenant_ids) > 1 else "retire", "id": recipe_id, "identity": method_identity(method)})
    return actions


async def method_intent(operation: Any, target: str, source: dict[str, Any], users: list[Any]) -> dict[str, Any]:
    store = operation.store
    prior = (await store.raw(target)).get(METHOD_KEY)
    if prior is not None and not isinstance(prior, dict):
        raise AdministrativePolicyError("Invalid method checkpoint")
    owner_plan = (await store.raw(target)).get(OWNER_PLAN_KEY)
    resuming_owner = isinstance(owner_plan, dict) and owner_plan.get("status") == "RECONCILING"
    if prior and (prior.get("status") != "COMPLETE" or resuming_owner):
        await validate_intent(operation, prior, source)
        return prior
    literals = {target, source["externalUserId"]}
    recipes = {}
    aliases = {}
    for user in users:
        for method in user.login_methods:
            literal = method.recipe_user_id.get_as_string()
            rid = await store.immutable(literal)
            aliases[literal] = rid
            literals.update((literal, rid))
            recipes[rid] = method.to_json()
    baseline = {"methods": list(recipes.values()), "aliases": aliases,
                "metadata": {literal: await store.raw(literal) for literal in sorted(literals)}}
    actions = await plan_methods(store, target, source, operation.profiles[source["externalUserId"]], users)
    return {"version": 1, "id": str(uuid.uuid4()), "sourceId": source["externalUserId"],
            "target": target, "tenantId": operation.tenant_id, "profile": operation.profiles[source["externalUserId"]],
            "baseline": baseline, "operations": actions, "cursor": 0, "status": "APPLYING"}


async def validate_intent(operation: Any, checkpoint: dict[str, Any], source: dict[str, Any]) -> None:
    try:
        if (type(checkpoint["version"]) is not int or checkpoint["version"] != 1
                or checkpoint["sourceId"] != source["externalUserId"] or checkpoint["tenantId"] != operation.tenant_id
                or type(checkpoint["cursor"]) is not int or not 0 <= checkpoint["cursor"] <= len(checkpoint["operations"])
                or not same_json(source_evidence(checkpoint["profile"]), source_evidence(operation.profiles[source["externalUserId"]]))):
            raise ValueError()
        baseline = checkpoint["baseline"]
        owner_plan = read_owner_plan(await operation.store.raw(checkpoint["target"]))
        if owner_plan and owner_plan["status"] != "COMPLETE":
            owner_recipes = {r["id"]: r for r in [*owner_plan["recipes"], *owner_plan.get("createdRecipes", [])]}
            for stored_method in baseline["methods"]:
                method = LoginMethod.from_json(stored_method)
                rid = baseline["aliases"].get(method.recipe_user_id.get_as_string(), method.recipe_user_id.get_as_string())
                original = owner_recipes.get(rid)
                if original is None or not same_json(json.loads(original["identity"]), json.loads(method_identity(method))):
                    raise ValueError()
            for marker in owner_plan["initial"]["markers"]:
                if marker["id"] in baseline["metadata"]:
                    policy = {k: v for k, v in baseline["metadata"][marker["id"]].items() if k in POLICY_MARKERS}
                    if not same_json(policy, marker["values"]):
                        raise ValueError()
        class BaselineStore:
            tenant_id = operation.tenant_id
            context = operation.context

            async def immutable(self, literal):
                return baseline["aliases"].get(literal, literal)

            async def raw(self, literal):
                return copy.deepcopy(baseline["metadata"].get(literal, {}))

        users = [SimpleNamespace(login_methods=[LoginMethod.from_json(m) for m in baseline["methods"]])]
        derived = await plan_methods(BaselineStore(), checkpoint["target"], source, checkpoint["profile"], users)  # type: ignore[arg-type]
        recorded = [{k: v for k, v in step.items() if k not in {"nonce", "receipt", "aliasRetirement"}} for step in checkpoint["operations"]]
        if not same_json(derived, recorded):
            raise ValueError()
    except (KeyError, TypeError, ValueError, AttributeError):
        raise AdministrativePolicyError("Method intent does not match its source and baseline") from None


async def validate_retirement_mapping_gap(store: AdministrativeCore, plan: dict[str, Any], step: dict[str, Any]) -> None:
    receipt = retirement_alias_receipt(plan, step)
    if receipt is None or not same_json(receipt, step.get("aliasRetirement")):
        raise AdministrativePolicyError("Invalid alias retirement gap receipt")
    mapping = receipt["mapping"]
    user = await store.user(step["id"])
    methods = [] if user is None else [m for m in user.login_methods if await store.immutable(m.recipe_user_id.get_as_string()) == step["id"]]
    if (user is None or await store.immutable(user.id) != plan["target"] or len(methods) != 1
            or not same_json(json.loads(method_identity(methods[0])), json.loads(step["identity"]))
            or await store.mapping(mapping["alias"]) is not None or await store.mapping(mapping["id"], "SUPERTOKENS") is not None
            or not same_json((await store.raw(mapping["alias"])).get("rownd_migration_superseded"),
                             {"rowndUserId": plan["sourceId"], "targetUserId": plan["target"]})):
        raise AdministrativePolicyError("Alias retirement mapping gap changed")


async def validate_admin_completed_plan(operation: Any, plan: dict[str, Any]) -> None:
    from .admin_validation import validate_completed_owner_plan
    from .admin_planning import administrative_source

    try:
        await validate_completed_owner_plan(plan, operation.context)
        return
    except AdministrativePolicyError as original_error:
        require_single_owner_tenant_transition(plan)
        checkpoint = (await operation.store.raw(plan["target"])).get(METHOD_KEY)
        if (not isinstance(checkpoint, dict) or checkpoint.get("target") != plan["target"]
                or checkpoint.get("sourceId") != plan["sourceId"] or not isinstance(checkpoint.get("tenantId"), str)
                or checkpoint.get("status") not in {"APPLYING", "COMPLETE"}
                or not isinstance(checkpoint.get("operations"), list) or not checkpoint["operations"]
                or any(s.get("kind") != "associate" for s in checkpoint["operations"])):
            raise original_error
        profile = await operation.fetch(plan["sourceId"])
        if profile is None:
            raise original_error
        tenant = checkpoint["tenantId"]
        proof_operation = SimpleNamespace(tenant_id=tenant, context=operation.context,
            store=AdministrativeCore(operation.context, tenant), profiles={plan["sourceId"]: profile})
        await validate_intent(proof_operation, checkpoint, administrative_source(profile, tenant))
        await validate_method_cursor(proof_operation, checkpoint)
        completion = plan.get("completion")
        if not isinstance(completion, dict):
            raise original_error
        expected = copy.deepcopy(completion["recipes"])
        for step in checkpoint["operations"]:
            recipe = next((r for r in expected if r["id"] == step["id"]), None)
            if recipe is None or not same_json(json.loads(recipe["identity"]), json.loads(step["identity"])):
                raise original_error
        observed = await operation.store.inspect_graph([plan["target"]], [m["id"] for m in completion["state"]["markers"]], allow_tenant_membership=True)
        states = [copy.deepcopy(completion["state"])]
        finalization = (await operation.store.raw(plan["target"])).get("rownd_migration_admin_finalization")
        if not same_json(observed["state"], completion["state"]):
            if (checkpoint["status"] != "COMPLETE" or checkpoint["cursor"] != len(checkpoint["operations"])
                    or not isinstance(finalization, dict) or type(finalization.get("version")) is not int or finalization["version"] != 1
                    or finalization.get("sourceId") != plan["sourceId"] or finalization.get("target") != plan["target"]
                    or finalization.get("tenantId") != tenant or not same_json(finalization.get("source"), source_evidence(profile))
                    or finalization.get("status") not in {"APPLYING", "COMPLETE"}
                    or type(finalization.get("cursor")) is not int or not isinstance(finalization.get("operations"), list)
                    or not 0 <= finalization["cursor"] <= len(finalization["operations"])
                    or finalization["status"] == "COMPLETE" and finalization["cursor"] != len(finalization["operations"])):
                raise original_error
            state = copy.deepcopy(completion["state"])
            states = []
            allowed_counts = {finalization["cursor"], min(finalization["cursor"] + 1, len(finalization["operations"]))}
            if 0 in allowed_counts:
                states.append(copy.deepcopy(state))
            email = profile["data"].get("email")
            for index, step in enumerate(finalization["operations"]):
                if step.get("kind") == "metadata" and step.get("id") == plan["target"]:
                    marker = next(m["values"] for m in state["markers"] if m["id"] == plan["target"])
                    before, values = step.get("before"), step.get("values")
                    if not isinstance(before, dict) or not isinstance(values, dict):
                        raise original_error
                    pointers = copy.deepcopy(marker.get("rownd_email_recipe_user_ids", {}))
                    candidates = [r for r in expected if json.loads(r["identity"])[0] == "passwordless" and r.get("email", "").lower() == str(email).lower()]
                    if len(candidates) == 1:
                        mapping = next(m for m in state["mappings"] if m["id"] == candidates[0]["id"])
                        pointers[tenant] = mapping.get("alias", mapping["id"])
                    allowed = {"rownd_migration_complete": True, "rownd_email_recipe_user_ids": pointers}
                    for key, value in values.items():
                        if key not in POLICY_MARKERS:
                            continue
                        if key not in allowed or not same_json(value, allowed[key]) or not same_json(before.get(key), marker.get(key)):
                            raise original_error
                        marker[key] = value
                elif step.get("kind") == "verify_email":
                    from .rownd_compatibility import is_rownd_email_verified

                    if (not isinstance(email, str) or step.get("email", "").lower() != email.lower()
                            or not is_rownd_email_verified(profile.get("verified_data", {}).get("email"), email)
                            or type(step.get("before")) is not bool):
                        raise original_error
                    cell = next((c for c in state["verifications"] if c["id"] == step.get("id") and c["email"] == step["email"]), None)
                    if cell is None or cell["verified"] is not step["before"]:
                        raise original_error
                    cell["verified"] = True
                else:
                    raise original_error
                if index + 1 in allowed_counts:
                    states.append(copy.deepcopy(state))
            if not any(same_json(observed["state"], candidate) for candidate in states):
                raise original_error
        possibilities = []
        for count in {checkpoint["cursor"], min(checkpoint["cursor"] + 1, len(checkpoint["operations"]))}:
            recipes = copy.deepcopy(expected)
            for step in checkpoint["operations"][:count]:
                recipe = next(r for r in recipes if r["id"] == step["id"])
                identity = json.loads(recipe["identity"])
                identity[4] = sorted(set(identity[4]) | {tenant})
                recipe["identity"] = json.dumps(identity, separators=(",", ":"))
            possibilities.append(recipes)
        if not any(same_json(observed["recipes"], expected_recipes) for expected_recipes in possibilities):
            raise original_error
        operation.tenant_transition_recovery = True


async def validate_creation_receipt(operation: Any, checkpoint: dict[str, Any], step: dict[str, Any]):
    store = operation.store
    receipt = step.get("receipt")
    if not isinstance(receipt, dict) or not isinstance(receipt.get("id"), str) or type(receipt.get("verified")) is not bool:
        raise AdministrativePolicyError("Invalid method creation receipt")
    user = await store.user(receipt["id"])
    methods = [] if user is None else [m for m in user.login_methods if await store.immutable(m.recipe_user_id.get_as_string()) == receipt["id"]]
    if (user is None or len(methods) != 1 or not login_method_matches_import(methods[0], step["method"])
            or operation.tenant_id not in methods[0].tenant_ids
            or not same_json(json.loads(method_identity(methods[0])), json.loads(receipt["identity"]))
            or methods[0].verified is not receipt["verified"]):
        raise AdministrativePolicyError("Creation receipt is not the authorized source method")
    marker = (await store.raw(receipt["id"])).get(RECEIPT_KEY)
    python_proven = (isinstance(step.get("nonce"), str) and bool(step["nonce"]) and same_json(marker, {
        "plan": checkpoint["id"], "nonce": step["nonce"], "target": checkpoint["target"], "sourceId": checkpoint["sourceId"]}))
    plan = read_owner_plan(await store.raw(checkpoint["target"]))
    node_proven = plan is not None and plan["sourceId"] == checkpoint["sourceId"] and any(
        r["id"] == receipt["id"] and same_json(json.loads(r["identity"]), json.loads(receipt["identity"]))
        and r["verified"] is receipt["verified"] for r in plan.get("createdRecipes", []))
    if not python_proven and not node_proven:
        raise AdministrativePolicyError("Creation receipt lacks independent provenance")
    owner = await store.immutable(user.id)
    if owner != checkpoint["target"]:
        if owner != receipt["id"] or user.is_primary_user or len(user.login_methods) != 1 or await store.mapping(receipt["id"], "SUPERTOKENS") is not None:
            raise AdministrativePolicyError("Creation receipt ownership changed")
    return user, methods[0]


async def validate_method_cursor(operation: Any, checkpoint: dict[str, Any]) -> None:
    store = operation.store
    for step in checkpoint["operations"][:checkpoint["cursor"]]:
        if step["kind"] == "create":
            user, _ = await validate_creation_receipt(operation, checkpoint, step)
            if await store.immutable(user.id) != checkpoint["target"]:
                raise AdministrativePolicyError("Method cursor passed an unlinked creation")
            continue
        user = await store.user(step["id"])
        methods = [] if user is None else [m for m in user.login_methods if await store.immutable(m.recipe_user_id.get_as_string()) == step["id"]]
        if step["kind"] == "retire":
            if methods:
                raise AdministrativePolicyError("Method cursor passed an existing retired credential")
            continue
        after = json.loads(step["identity"])
        if step["kind"] == "update_email":
            after[1] = step["email"]
        elif step["kind"] == "associate":
            after[4] = sorted(set(after[4]) | {operation.tenant_id})
        elif step["kind"] == "remove_tenant":
            after[4] = sorted(set(after[4]) - {operation.tenant_id})
        else:
            raise AdministrativePolicyError("Unknown committed method operation")
        if (user is None or await store.immutable(user.id) != checkpoint["target"] or len(methods) != 1
                or not same_json(json.loads(method_identity(methods[0])), after)):
            raise AdministrativePolicyError("Committed method postcondition changed")


async def execute_methods(operation: Any, target: str, source: dict[str, Any], actions: list[dict[str, Any]]) -> None:
    store: AdministrativeCore = operation.store
    source_id = source["externalUserId"]
    prior = (await store.raw(target)).get(METHOD_KEY)
    pinned = getattr(operation, "pinned_method_checkpoint", prior)
    if not same_json(prior, pinned):
        raise AdministrativePolicyError("Method checkpoint changed during handoff")
    if prior is not None and not isinstance(prior, dict):
        raise AdministrativePolicyError("Invalid method reconciliation checkpoint")
    if prior and prior.get("status") == "COMPLETE" and "baseline" in prior:
        if same_json(source_evidence(prior["profile"]), source_evidence(operation.profiles[source_id])):
            await validate_intent(operation, prior, source)
            await validate_method_cursor(operation, prior)
            return
    if prior is None or prior.get("status") == "COMPLETE":
        checkpoint = {"version": 1, "id": str(uuid.uuid4()), "sourceId": source_id,
                      "target": target, "tenantId": operation.tenant_id, "profile": operation.profiles[source_id],
                      "operations": actions, "cursor": 0, "status": "APPLYING"}
    else:
        checkpoint = prior
        if (type(checkpoint.get("version")) is not int or checkpoint["version"] != 1
                or type(checkpoint.get("cursor")) is not int
                or not 0 <= checkpoint["cursor"] <= len(checkpoint.get("operations", []))
                or checkpoint.get("target") != target or checkpoint.get("sourceId") != source_id
                or checkpoint.get("tenantId") != operation.tenant_id
                or not same_json(source_evidence(checkpoint["profile"]), source_evidence(operation.profiles[source_id]))):
            raise AdministrativePolicyError("Invalid method reconciliation checkpoint")
        await validate_intent(operation, checkpoint, source)
        await validate_method_cursor(operation, checkpoint)

    expected_saved = copy.deepcopy(prior)

    async def unchanged():
        if not same_json((await store.raw(target)).get(METHOD_KEY), expected_saved):
            raise AdministrativePolicyError("Method checkpoint changed concurrently")

    async def save():
        nonlocal expected_saved
        await unchanged()
        operation.mutation_started = True
        await metadata.update_user_metadata(target, {METHOD_KEY: checkpoint}, store.context)
        expected_saved = copy.deepcopy(checkpoint)
        await unchanged()
        store.fresh()

    await save()
    while checkpoint["cursor"] < len(checkpoint["operations"]):
        await operation.source_guard()
        await unchanged()
        step = checkpoint["operations"][checkpoint["cursor"]]
        kind = step["kind"]
        if kind == "create":
            requested = step["method"]
            owner_user = await store.user(target)
            if (requested.get("email") and not requested.get("isVerified") and owner_user
                    and any(m.email and m.email.lower() == requested["email"].lower() and m.verified
                            for m in owner_user.login_methods)):
                raise AdministrativePolicyError("Linking would inherit unproven email verification")
            receipt = step.get("receipt")
            if receipt is None:
                nonce = step.setdefault("nonce", str(uuid.uuid4()))
                await save()
                found = []
                owner_plan = read_owner_plan(await store.raw(target))
                node_receipts = owner_plan.get("createdRecipes", []) if owner_plan and owner_plan["status"] == "RECONCILING" else []
                for info in import_method_account_infos(step["method"]):
                    found.extend(await core.list_users_by_account_info(operation.tenant_id, info, False, store.context))
                candidates = []
                for user in found:
                    for method in user.login_methods:
                        rid = await store.immutable(method.recipe_user_id.get_as_string())
                        marker = (await store.raw(rid)).get(RECEIPT_KEY)
                        native_receipt = next((r for r in node_receipts if r["id"] == rid), None)
                        node_proven = (native_receipt is not None and same_json(json.loads(native_receipt["identity"]), json.loads(method_identity(method)))
                                       and method.verified is native_receipt["verified"])
                        if (node_proven or marker == {"plan": checkpoint["id"], "nonce": nonce, "target": target, "sourceId": source_id}) and login_method_matches_import(method, step["method"]):
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
                if step["method"].get("email") and not step["method"].get("isVerified") and method.verified:
                    raise AdministrativePolicyError("Created recipe has unproven email verification")
                receipt = {"id": rid, "identity": method_identity(method), "verified": method.verified}
                step["receipt"] = receipt
                await save()
            user, _ = await validate_creation_receipt(operation, checkpoint, step)
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
                await unchanged()
                await validate_creation_receipt(operation, checkpoint, step)
                await store.operation({"kind": "link", "id": receipt["id"]}, target)
            linked_user = await store.user(receipt["id"])
            if linked_user is None:
                raise AdministrativePolicyError("Linked recipe disappeared")
            for method in linked_user.login_methods:
                if await store.immutable(method.recipe_user_id.get_as_string()) == receipt["id"]:
                    if method.verified is not receipt["verified"]:
                        raise AdministrativePolicyError("Linked recipe verification changed")
        elif kind in {"associate", "remove_tenant"}:
            user = await store.user(step["id"])
            matching = [] if user is None else [m for m in user.login_methods if await store.immutable(m.recipe_user_id.get_as_string()) == step["id"]]
            if user is None or await store.immutable(user.id) != target or len(matching) != 1:
                raise AdministrativePolicyError("Tenant association recipe owner changed")
            before = json.loads(step["identity"])
            after = copy.deepcopy(before)
            after[4] = sorted(set(before[4]) | {operation.tenant_id}) if kind == "associate" else sorted(set(before[4]) - {operation.tenant_id})
            if not after[4]:
                raise AdministrativePolicyError("Tenant removal would delete immutable recipe")
            actual = json.loads(method_identity(matching[0]))
            if same_json(actual, before):
                if kind == "associate":
                    result = await multitenancy.associate_user_to_tenant(operation.tenant_id, matching[0].recipe_user_id, store.context)
                    if type(result).__name__ != "AssociateUserToTenantOkResult":
                        raise AdministrativePolicyError("Core rejected tenant association")
                else:
                    if matching[0].email and matching[0].recipe_id == "passwordless":
                        await passwordless.revoke_all_codes(operation.tenant_id, email=matching[0].email, user_context=store.context)
                    email_change = matching[0].recipe_id == "passwordless" and bool(matching[0].email)
                    await sessions.revoke_all_sessions_for_user(target if email_change else matching[0].recipe_user_id.get_as_string(),
                        revoke_sessions_for_linked_accounts=email_change, tenant_id=operation.tenant_id, user_context=store.context)
                    await multitenancy.disassociate_user_from_tenant(operation.tenant_id, matching[0].recipe_user_id, store.context)
            elif not same_json(actual, after):
                raise AdministrativePolicyError("Tenant association identity changed")
            confirmed = await store.user(step["id"])
            matching = [] if confirmed is None else [m for m in confirmed.login_methods if await store.immutable(m.recipe_user_id.get_as_string()) == step["id"]]
            if confirmed is None or await store.immutable(confirmed.id) != target or len(matching) != 1 or not same_json(json.loads(method_identity(matching[0])), after):
                raise AdministrativePolicyError("Tenant membership postcondition failed")
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
                    owner_plan = read_owner_plan(await store.raw(target))
                    if owner_plan:
                        operation.mutation_started = True
                        if step.get("aliasRetirement") and await store.mapping(rid, "SUPERTOKENS") is None:
                            await validate_retirement_mapping_gap(store, owner_plan, step)
                            receipt = step["aliasRetirement"]
                        else:
                            receipt = await prepare_alias_retirement(store, owner_plan, step)
                        if receipt is not None:
                            if step.get("aliasRetirement") is not None and not same_json(step["aliasRetirement"], receipt):
                                raise AdministrativePolicyError("Alias retirement receipt changed")
                            step["aliasRetirement"] = receipt
                            await save()
                            alias_mapping = receipt["mapping"]
                            if await store.mapping(alias_mapping["alias"]):
                                for address in sorted({r["email"] for r in owner_plan["recipes"] if r.get("email")}):
                                    await store.operation({"kind": "revoke_verification_tokens", "id": alias_mapping["alias"], "email": address}, target)
                                await store.operation({"kind": "delete_mapping", "id": rid, "alias": alias_mapping["alias"]}, target)
                            await validate_retirement_mapping_gap(store, owner_plan, step)
                    email_change = current.recipe_id == "passwordless" and bool(current.email)
                    if email_change:
                        await passwordless.revoke_all_codes(operation.tenant_id, email=current.email, user_context=store.context)
                    await sessions.revoke_all_sessions_for_user(target if email_change else rid if step.get("aliasRetirement") else current.recipe_user_id.get_as_string(),
                        revoke_sessions_for_linked_accounts=email_change, tenant_id=operation.tenant_id, user_context=store.context)
                    await core.delete_user(rid if step.get("aliasRetirement") else current.recipe_user_id.get_as_string(), False, store.context)
                elif same_json(identity, before):
                    if not step["verified"] and await verification.is_email_verified(current.recipe_user_id, step["email"], store.context):
                        raise AdministrativePolicyError("Canonical email verification changed")
                    await passwordless.revoke_all_codes(operation.tenant_id, email=current.email, user_context=store.context)
                    await sessions.revoke_all_sessions_for_user(target,
                        revoke_sessions_for_linked_accounts=True, tenant_id=operation.tenant_id, user_context=store.context)
                    await unchanged()
                    result = await passwordless.update_user(current.recipe_user_id, email=step["email"], user_context=store.context)
                    if not isinstance(result, UpdateUserOkResult):
                        raise AdministrativePolicyError("Core rejected canonical email update")
        else:
            raise AdministrativePolicyError("Unknown method operation")
        store.fresh()
        store.actions.append(kind)
        checkpoint["cursor"] += 1
        await save()
    await validate_method_cursor(operation, checkpoint)
    checkpoint["status"] = "COMPLETE"
    await save()

from __future__ import annotations

import copy
import inspect
import uuid
import json
from contextlib import nullcontext
from typing import Any, Callable, Optional

from supertokens_python import Supertokens
from supertokens_python import asyncio as core
from supertokens_python.recipe.usermetadata import asyncio as metadata
from supertokens_python.recipe.emailverification import asyncio as verification
from supertokens_python.types import RecipeUserId
from supertokens_python.types.base import AccountInfoInput

from .admin_core import AdministrativeCore, same_json
from .admin_orphan import ORPHAN_KEY, inspect_orphan, retire_orphan
from .admin_methods import METHOD_KEY, execute_methods, method_intent, validate_method_recovery
from .admin_evidence import checkpoint_phone_proof, instant_primary_proof
from .admin_validation import validate_completed_owner_plan
from .admin_publication import PUBLICATION_KEY, publish_mapping, single_owner_snapshot
from .admin_metadata import inspect_occupied_metadata
from .admin_source import source_evidence
from .admin_finalization import FINAL_KEY, finish
from .admin_planning import (
    OWNER_PLAN_KEY,
    AdministrativePolicyError,
    AmbiguousElection,
    administrative_source,
    elect,
    metadata_backfill,
    owner_state_at,
    plan_owner_operations,
    read_owner_plan,
    validate_profile,
)
from .config import get_active_rownd_config
from . import config as configuration
from .rownd_repository import RowndClient, valid_lookup_id
from .rownd_compatibility import is_rownd_email_verified
from .supertokens_repository import (
    import_method_account_infos,
    import_user,
    login_method_matches_import,
)
JsonDict = dict[str, Any]


class _SourceNotFound(Exception):
    pass


class Reconciliation:
    def __init__(self, client: Any, core_config: Any, context: JsonDict,
                 tenant_id: str, result: JsonDict, on_progress: Optional[Callable[..., Any]]):
        self.client = client
        self.core_config = core_config
        self.context = context
        self.tenant_id = tenant_id
        self.result = result
        self.on_progress = on_progress
        self.store = AdministrativeCore(context, tenant_id)
        self.profiles: dict[str, JsonDict] = {}
        self.mutation_started = False
        self.orphan: Optional[JsonDict] = None
        self.single_owner_baseline: Optional[JsonDict] = None

    async def progress(self, stage: str, **details: Any) -> None:
        if self.on_progress:
            value = self.on_progress({"stage": stage, **details})
            if inspect.isawaitable(value):
                await value

    async def fetch(self, source_id: str) -> Optional[JsonDict]:
        fetch = getattr(self.client, "fetch_fresh_user_info", None)
        if fetch is None:
            fetch = self.client.fetch_optional_user_info
        profile = await fetch(source_id)
        return validate_profile(profile, source_id) if profile is not None else None

    async def source_guard(self) -> None:
        for source_id, expected in self.profiles.items():
            actual = await self.fetch(source_id)
            if actual is None or not same_json(source_evidence(actual), source_evidence(expected)):
                raise AdministrativePolicyError("Rownd source changed before reconciliation completion")

    async def discover(self, users: list[Any], initial: list[JsonDict]) -> tuple[dict[str, Any], list[JsonDict]]:
        owners = await self.store.owners(users)
        candidates: dict[str, JsonDict] = {c["rownd_user_id"]: c for c in initial}
        checkpoint_candidates: dict[str, JsonDict] = {}
        for owner, user in list(owners.items()):
            literals = {owner, user.id, *(m.recipe_user_id.get_as_string() for m in user.login_methods)}
            for literal in list(literals):
                mapping = await self.store.mapping(literal, "ANY")
                if mapping:
                    literals.update((mapping["id"], mapping["alias"]))
            for literal in sorted(literals):
                raw = await self.store.raw(literal)
                checkpoint = read_owner_plan(raw)
                if checkpoint and checkpoint["status"] == "COMPLETE":
                    await validate_completed_owner_plan(checkpoint, self.context)
                if checkpoint and checkpoint["status"] != "COMPLETE":
                    for candidate in checkpoint["candidates"]:
                        candidates[candidate["rownd_user_id"]] = candidate
                        checkpoint_candidates[candidate["rownd_user_id"]] = candidate
                    for entry in checkpoint["initial"]["graph"]:
                        original = await self.store.user(entry["id"])
                        if original is None:
                            if checkpoint["status"] == "RECONCILING":
                                continue
                            raise AdministrativePolicyError("Checkpoint recipe disappeared")
                        owners.update(await self.store.owners([original]))
                original = raw.get("original_rownd_user", {})
                source_id = original.get("data", {}).get("user_id") if isinstance(original, dict) else None
                mapping = await self.store.mapping(literal)
                source_ids = {source_id} if source_id else set()
                if mapping:
                    source_ids.add(mapping["alias"])
                for source_id in source_ids:
                    await self.store.namespace(source_id)
                    source_metadata = await self.store.raw(source_id)
                    retirement = source_metadata.get("rownd_migration_superseded")
                    source_mapping = await self.store.mapping(source_id)
                    if isinstance(retirement, dict) and source_mapping is None:
                        if retirement.get("targetUserId") == owner and retirement.get("rowndUserId") != source_id:
                            continue
                    profile = await self.fetch(source_id)
                    if profile is None:
                        continue
                    self.profiles[source_id] = profile
                    candidate = {"rownd_user_id": source_id}
                    if source_mapping:
                        candidate["supertokens_user_id"] = source_mapping["id"]
                    elif source_id == raw.get("original_rownd_user", {}).get("data", {}).get("user_id"):
                        candidate["supertokens_user_id"] = owner
                    prior = candidates.get(source_id)
                    if source_id in checkpoint_candidates:
                        candidates[source_id] = checkpoint_candidates[source_id]
                        continue
                    if prior and prior.get("supertokens_user_id") not in (None, candidate.get("supertokens_user_id")):
                        raise AmbiguousElection([prior, candidate])
                    candidates[source_id] = candidate
        for candidate in candidates.values():
            source_id = candidate["rownd_user_id"]
            if source_id not in self.profiles:
                profile = await self.fetch(source_id)
                if profile is None:
                    raise AdministrativePolicyError("Checkpoint source disappeared")
                self.profiles[source_id] = profile
        return owners, sorted(candidates.values(), key=lambda c: c["rownd_user_id"])

    async def identity_users(self, profile: JsonDict) -> list[Any]:
        users: list[Any] = []
        for method in administrative_source(profile, self.tenant_id)["loginMethods"]:
            for info in import_method_account_infos(method):
                users.extend(await core.list_users_by_account_info(self.tenant_id, info, False, self.context))
        return users

    async def select_survivor(self, owners: dict[str, Any], email: Optional[str] = None) -> Optional[str]:
        if not owners:
            return None
        eligible = {owner: user for owner, user in owners.items() if not email or any(
            m.email and m.email.lower() == email for m in user.login_methods)}
        if not eligible:
            eligible = owners
        def rank(user: Any):
            return (user.is_primary_user, len(user.login_methods), any(
                m.recipe_id == "passwordless" and m.email and (not email or m.email.lower() == email)
                for m in user.login_methods))
        best = max(rank(user) for user in eligible.values())
        tied = [owner for owner, user in eligible.items() if rank(user) == best]
        if len(tied) == 1:
            return tied[0]
        mapped = [owner for owner in tied if await self.store.mapping(owner, "SUPERTOKENS")]
        if len(mapped) == 1:
            return mapped[0]
        candidates = []
        for source_id in sorted(self.profiles):
            mapping = await self.store.mapping(source_id)
            candidates.append({"rownd_user_id": source_id,
                               **({"supertokens_user_id": mapping["id"]} if mapping else {})})
        raise AmbiguousElection(candidates)

    async def prepare(self, source_id: Optional[str], selected_id: Optional[str], email: Optional[str]) -> tuple[JsonDict, Optional[JsonDict], Optional[str]]:
        users: list[Any] = []
        initial = []
        constrained = None
        if selected_id:
            selected = await self.store.user(selected_id)
            if selected:
                constrained = await self.store.immutable(selected.id)
                users.append(selected)
        if email:
            users = await core.list_users_by_account_info(self.tenant_id, AccountInfoInput(email=email), False, self.context)
            if not users:
                raise AdministrativePolicyError("No existing SuperTokens email owner found; use a Rownd user ID to import a user")
        if source_id:
            await self.store.namespace(source_id)
            raw = await self.store.raw(source_id)
            orphan_receipt = raw.get(ORPHAN_KEY)
            pending_orphan = isinstance(orphan_receipt, dict) and orphan_receipt.get("phase") in {"PREPARED", "HANDOFF"}
            if raw.get("rownd_migration_superseded") is not None and not pending_orphan:
                raise AdministrativePolicyError("Rownd source has been superseded")
            profile = await self.fetch(source_id)
            if profile is None:
                raise _SourceNotFound("Live Rownd user not found")
            self.profiles[source_id] = profile
            recovery = raw.get("rownd_migration_owner_recovery")
            if recovery is not None:
                if (not isinstance(recovery, dict)
                        or ("version" in recovery and (type(recovery["version"]) is not int or recovery["version"] != 1))
                        or ("sourceId" in recovery and recovery["sourceId"] != source_id)
                        or not valid_lookup_id(recovery.get("planId"))
                        or not isinstance(recovery.get("target"), str)):
                    raise AdministrativePolicyError("Invalid owner recovery reference")
                recovered_plan = read_owner_plan(await self.store.raw(recovery["target"]))
                if (recovered_plan is None or recovery.get("planId") not in {recovered_plan["id"], recovered_plan.get("previousPlanId")}
                        or not any(c["rownd_user_id"] == source_id for c in recovered_plan["candidates"])):
                    raise AdministrativePolicyError("Owner recovery checkpoint changed")
                users.extend([await self.store.user(r["id"]) for r in recovered_plan["recipes"]])
            mapping = await self.store.mapping(source_id)
            user = await self.store.user(source_id)
            if (mapping and user is None) or raw.get(ORPHAN_KEY):
                self.orphan = await inspect_orphan(self.store, source_id, profile, mapping)
                if self.orphan:
                    user = await self.store.user(self.orphan["target"])
                    mapping = None
            if mapping and user is None:
                raise AdministrativePolicyError("MAPPING_TARGET_MISSING: ORPHAN_MAPPING_RECOVERY_BLOCKED")
            if user:
                users.append(user)
            initial.append({"rownd_user_id": source_id,
                            **({"supertokens_user_id": mapping["id"]} if mapping else {})})
            users.extend(await self.identity_users(profile))
            checkpoint = read_owner_plan(raw)
            if checkpoint:
                users.extend([await self.store.user(r["id"]) for r in checkpoint["recipes"]])
        owners, candidates = await self.discover(users, initial)
        if not candidates and email:
            search = getattr(self.client, "find_user_ids_by_email", None)
            if search is None:
                raise AdministrativePolicyError("ROWND_EMAIL_SEARCH_UNSUPPORTED")
            ids = await search(email)
            if not isinstance(ids, list) or not all(valid_lookup_id(i) for i in ids):
                raise AdministrativePolicyError("ROWND_EMAIL_SEARCH_INVALID_RESPONSE")
            for found_id in sorted(set(ids)):
                profile = await self.fetch(found_id)
                if profile is None:
                    raise AdministrativePolicyError("Rownd email discovery source disappeared")
                if profile["data"].get("email", "").lower() != email:
                    continue
                self.profiles[found_id] = profile
                mapping = await self.store.mapping(found_id)
                candidates.append({"rownd_user_id": found_id,
                                   **({"supertokens_user_id": mapping["id"]} if mapping else {})})
        if not candidates:
            raise AdministrativePolicyError("No Rownd source mapping or metadata found in SuperTokens")
        # Close discovery over every elected candidate's current identities.
        more_users = list(owners.values())
        for candidate in candidates:
            more_users.extend(await self.identity_users(self.profiles[candidate["rownd_user_id"]]))
        owners, candidates = await self.discover(more_users, candidates)
        checkpoints = [read_owner_plan(await self.store.raw(owner)) for owner in owners]
        pending = [p for p in checkpoints if p and p["status"] != "COMPLETE"]
        if pending and any(not same_json(pending[0], p) for p in pending):
            raise AdministrativePolicyError("Owner checkpoints disagree")
        checkpoint = pending[0] if pending else None
        target = checkpoint["target"] if checkpoint else await self.select_survivor(owners, email)
        canonical = await self.store.mapping(target, "SUPERTOKENS") if target else None
        canonical_id = checkpoint["sourceId"] if checkpoint else canonical["alias"] if canonical else None
        phone_proof = None
        if len(owners) == 1:
            owner, user = next(iter(owners.items()))
            if not user.is_primary_user and len(user.login_methods) == 1:
                method = user.login_methods[0]
                if method.recipe_id == "passwordless" and not method.email and method.phone_number and method.verified and method.tenant_ids == ["public"]:
                    phone_proof = {"phoneNumber": method.phone_number, "supertokensUserId": owner}
        if checkpoint:
            phone_proof = checkpoint_phone_proof(checkpoint)
        proof_checkpoint = checkpoint or next((p for p in checkpoints if p and p["target"] == target), None)
        instant_proof = await instant_primary_proof(self.store, candidates, self.profiles, proof_checkpoint)
        election = elect(candidates, self.profiles, canonical_id, phone_proof, instant_proof)
        winner = election["winner"]["rownd_user_id"]
        if self.orphan:
            if self.orphan.get("winner", winner) != winner:
                raise AdministrativePolicyError("Orphan recovery election changed before handoff")
            pinned_profiles = self.orphan.get("profiles")
            if pinned_profiles is not None and not same_json(
                    {k: source_evidence(v) for k, v in pinned_profiles.items()},
                    {k: source_evidence(v) for k, v in self.profiles.items()}):
                raise AdministrativePolicyError("Orphan recovery profiles changed")
            self.orphan["winner"] = winner
            self.orphan["profiles"] = copy.deepcopy(self.profiles)
        if checkpoint and checkpoint["sourceId"] != winner:
            raise AdministrativePolicyError("Checkpoint election changed")
        if checkpoint and "sourceProfile" in checkpoint and not same_json(source_evidence(checkpoint["sourceProfile"]), source_evidence(self.profiles[winner])):
            raise AdministrativePolicyError("Checkpoint source changed")
        if checkpoint:
            planned_profile = checkpoint.get("sourceProfile")
            if planned_profile is None:
                planned_profile = next((op["values"]["original_rownd_user"] for op in reversed(checkpoint["operations"])
                    if op["kind"] == "metadata" and op["id"] == target and "original_rownd_user" in op["values"]), self.profiles[winner])
            if not same_json(source_evidence(planned_profile), source_evidence(self.profiles[winner])):
                raise AdministrativePolicyError("Checkpoint source identity changed")
            if not any(same_json(checkpoint["operations"], plan_owner_operations(checkpoint, planned_profile, node_compatible=node)) for node in (False, True)):
                raise AdministrativePolicyError("Checkpoint owner operations changed")
        if constrained and constrained != target:
            raise AdministrativePolicyError("The SuperTokens selector belongs to a different canonical Rownd owner")
        self.result.update(rownd_user_id=winner, supertokens_user_id=target)
        self.result.setdefault("requested_rownd_user_id", source_id or winner)
        if len(candidates) > 1:
            self.result["election"] = {k: v for k, v in election.items() if k != "winner"}
        source = administrative_source(self.profiles[winner], self.tenant_id)
        if target is None:
            for method in source["loginMethods"]:
                if method.get("email") and not method["isVerified"] and await verification.is_email_verified(RecipeUserId(winner), method["email"], self.context):
                    raise AdministrativePolicyError("Fresh alias would inherit unrelated email verification")
            return source, None, None
        if self.tenant_id != "public" or (len(owners) == 1 and any(m.tenant_ids != ["public"] for u in owners.values() for m in u.login_methods)):
            mapping = await self.store.mapping(winner)
            if checkpoint or len(owners) != 1 or len(candidates) != 1 or (mapping and mapping["id"] != target):
                raise AdministrativePolicyError("Whole-owner consolidation requires public-only recipes")
            self.single_owner_baseline = await single_owner_snapshot(self.store, target, winner)
            for marker in self.single_owner_baseline["markers"]:
                original = marker["values"].get("original_rownd_user")
                if original and original.get("data", {}).get("user_id") != winner:
                    raise AdministrativePolicyError("Conflicting single-owner provenance")
            return source, None, target
        if checkpoint:
            if checkpoint["status"] == "RECONCILING":
                mapping = await self.store.mapping(winner)
                if mapping is None or mapping["id"] != target:
                    raise AdministrativePolicyError("Checkpoint canonical mapping changed")
                await validate_method_recovery(self.store, checkpoint, self.profiles[winner])
                return source, checkpoint, target
            observed = (await self.store.inspect_plan(checkpoint))["state"]
            current = owner_state_at(checkpoint)
            following = owner_state_at(checkpoint, checkpoint["cursor"] + 1)
            if not same_json(observed, current) and not same_json(observed, following):
                raise AdministrativePolicyError("Owner lineage changed during interrupted reconciliation")
            return source, checkpoint, target
        graph = await self.store.inspect_graph(list(owners), [c["rownd_user_id"] for c in candidates])
        if self.orphan and self.orphan["sourceId"] != winner:
            marker = next(m for m in graph["state"]["markers"] if m["id"] == self.orphan["sourceId"])
            marker["values"]["rownd_migration_superseded"] = {"rowndUserId": winner, "targetUserId": target}
            marker["values"]["rownd_migration_canonical_target"] = target
        candidate_ids = {c["rownd_user_id"] for c in candidates}
        for marker in graph["state"]["markers"]:
            values = marker["values"]
            pending_email = values.get("rownd_pending_verification")
            if pending_email not in (None, []):
                raise AdministrativePolicyError("CANONICAL_EMAIL_POLICY")
            original = values.get("original_rownd_user")
            if original and original.get("data", {}).get("user_id") not in candidate_ids:
                raise AdministrativePolicyError("Conflicting owner provenance")
            for field in ("rownd_migration_target", "rownd_migration_canonical_target"):
                if field in values and values[field] not in owners:
                    raise AdministrativePolicyError("Conflicting owner lineage")
        for mapping in graph["state"]["mappings"]:
            if mapping.get("alias") and mapping["alias"] not in candidate_ids:
                raise AdministrativePolicyError("Unproven external alias in owner graph")
        # Native owners may participate only through an exact current identity;
        # unrelated linked methods remain preserved under their proven owner.
        for owner, user in owners.items():
            if not any(login_method_matches_import(m, expected) for m in user.login_methods for expected in source["loginMethods"]):
                if not any(c.get("supertokens_user_id") == owner for c in candidates):
                    raise AdministrativePolicyError("Unproven consolidation owner")
        aliases = [{"id": m["alias"], "from": m["id"], "to": m["id"],
                    **({"info": m["info"]} if "info" in m else {})}
                   for m in graph["state"]["mappings"] if m.get("alias")]
        retired = []
        source_alias = next((a for a in aliases if a["id"] == winner), None)
        if source_alias:
            source_alias["to"] = target
        else:
            aliases.append({"id": winner, "to": target})
        displaced = next((a for a in aliases if a["id"] != winner and a["to"] == target), None)
        if displaced:
            available = sorted(r["id"] for r in graph["recipes"] if r["id"] != target and not any(
                a["id"] != displaced["id"] and a["to"] == r["id"] for a in aliases))
            previous = source_alias.get("from") if source_alias else None
            destination = previous if previous in available else available[0] if available else None
            if destination:
                displaced["to"] = destination
            else:
                retired.append({k: v for k, v in displaced.items() if k != "to"})
                aliases.remove(displaced)
        planned_profile = self.profiles[winner]
        original_profile = next(m["values"].get("original_rownd_user") for m in graph["state"]["markers"] if m["id"] == target)
        if isinstance(original_profile, dict) and same_json(source_evidence(original_profile), source_evidence(planned_profile)):
            planned_profile = original_profile
        checkpoint = {"version": 2, "id": str(uuid.uuid4()), "sourceId": winner,
                      "sourceProfile": copy.deepcopy(planned_profile),
                      "target": target, "candidates": candidates,
                      "absentAliases": [c["rownd_user_id"] for c in candidates if not any(m.get("alias") == c["rownd_user_id"] for m in graph["state"]["mappings"])],
                      "recipes": graph["recipes"], "aliases": aliases, "retiredAliases": retired,
                      "initial": graph["state"], "cursor": 0, "status": "READY"}
        checkpoint["operations"] = plan_owner_operations(checkpoint, planned_profile)
        previous_plan = next((p for p in checkpoints if p and p["target"] == target), None)
        if previous_plan:
            checkpoint["previousPlanId"] = previous_plan["id"]
        anchor = next((r for r in checkpoint["recipes"] if r["id"] == target), None)
        if anchor:
            identity = json.loads(anchor["identity"])
            if isinstance(identity[3], dict) and identity[3].get("id") == "instant":
                history = set()
                for previous in checkpoints:
                    if previous and previous.get("target") == target:
                        history.update(previous.get("legacySessionAliasHistory", {}).get("aliases", []))
                        history.update(a["id"] for a in previous.get("retiredAliases", []))
                        history.update(a["id"] for a in previous.get("aliases", []) if a.get("from") and a["from"] != a["to"])
                history.update(a["id"] for a in retired)
                history.update(a["id"] for a in aliases if a.get("from") and a["from"] != a["to"])
                if history:
                    checkpoint["legacySessionAliasHistory"] = {"instantRecipeId": target,
                        "instantRecipeIdentity": anchor["identity"], "aliases": sorted(history)}
        return source, checkpoint, target

    async def execute_owner(self, plan: JsonDict) -> None:
        await self.source_guard()
        if plan["status"] == "RECONCILING":
            return
        await self.progress("consolidation")
        await self.source_guard()
        existing = read_owner_plan(await self.store.raw(plan["target"]))
        expected_saved = copy.deepcopy(existing)

        async def unchanged() -> None:
            if not same_json((await self.store.raw(plan["target"])).get(OWNER_PLAN_KEY), expected_saved):
                raise AdministrativePolicyError("Owner checkpoint changed concurrently")

        async def save() -> None:
            nonlocal expected_saved
            await unchanged()
            self.mutation_started = True
            await metadata.update_user_metadata(plan["target"], {OWNER_PLAN_KEY: plan}, self.context)
            expected_saved = copy.deepcopy(plan)
            await unchanged()

        if existing and existing["status"] != "COMPLETE" and not same_json(existing, plan):
            raise AdministrativePolicyError("Owner checkpoint changed before execution")
        if existing is None or existing["status"] == "COMPLETE":
            observed = (await self.store.inspect_plan(plan))["state"]
            if not same_json(observed, owner_state_at(plan)):
                raise AdministrativePolicyError("Owner graph changed before checkpoint publication")
            self.mutation_started = True
            # Target owns the checkpoint; publishing a reference here would change
            # the first operation's baseline before it has been applied.
            await save()
        for candidate in plan["candidates"]:
            await unchanged()
            pointer = (await self.store.raw(candidate["rownd_user_id"])).get("rownd_migration_owner_recovery")
            if pointer is not None and (not isinstance(pointer, dict) or pointer.get("target") != plan["target"]
                    or pointer.get("planId") not in {plan["id"], plan.get("previousPlanId")}):
                raise AdministrativePolicyError("Conflicting owner recovery pointer")
            self.mutation_started = True
            await metadata.update_user_metadata(candidate["rownd_user_id"], {"rownd_migration_owner_recovery": {
                "version": 1, "sourceId": candidate["rownd_user_id"], "target": plan["target"], "planId": plan["id"]}}, self.context)
        while plan["cursor"] < len(plan["operations"]):
            await self.source_guard()
            await unchanged()
            observed = (await self.store.inspect_plan(plan))["state"]
            current = owner_state_at(plan)
            following = owner_state_at(plan, plan["cursor"] + 1)
            if same_json(observed, current):
                self.mutation_started = True
                operation = plan["operations"][plan["cursor"]]
                await unchanged()
                await self.store.operation(operation, plan["target"])
                observed = (await self.store.inspect_plan(plan))["state"]
            if not same_json(observed, following):
                raise AdministrativePolicyError("Owner operation postcondition failed")
            plan["cursor"] += 1
            plan["status"] = "APPLYING"
            await save()
            await self.progress("consolidation", completed=plan["cursor"], total=len(plan["operations"]))
        plan["status"] = "RECONCILING"
        await save()

    async def run(self, source_id: Optional[str], selected_id: Optional[str], email: Optional[str], dry_run: bool) -> JsonDict:
        await self.progress("discovery")
        source, plan, target = await self.prepare(source_id, selected_id, email)
        winner = source["externalUserId"]
        user = await self.store.user(target) if target else None
        current_methods = user.login_methods if user else []
        all_methods = list(current_methods)
        if plan:
            for recipe in plan["recipes"]:
                owner = await self.store.user(recipe["id"])
                if owner:
                    all_methods.extend(owner.login_methods)
        missing = [m for m in source["loginMethods"] if not any(self.tenant_id in existing.tenant_ids and login_method_matches_import(existing, m) for existing in all_methods)]
        method_users = []
        if target:
            for method in all_methods:
                owner = await self.store.user(method.recipe_user_id.get_as_string())
                if owner:
                    method_users.append(owner)
        intent = await method_intent(self, target, source, method_users) if target else None
        method_actions = intent["operations"] if intent else []
        occupied = await inspect_occupied_metadata(self.store, target, (winner,)) if target else {}
        if plan:
            for recipe in plan["recipes"]:
                occupied = {**await self.store.raw(recipe["id"]), **occupied}
        patch = metadata_backfill(self.profiles[winner], occupied)
        names = {"detach": "unlink_method", "promote": "create_primary", "link": "link_method",
                 "delete_mapping": "remove_mapping", "metadata": "update_migration_metadata",
                 "create": "create_method", "associate": "create_method", "remove_tenant": "review_provider_retirement",
                 "retire": "review_provider_retirement", "update_email": "set_canonical_email"}
        actions = [{"action": names.get(op["kind"], op["kind"]), "recipeUserId": op["id"]} for op in (plan["operations"][plan["cursor"]:] if plan else [])]
        actions.extend({"action": names[m["kind"]], **({"method": m["method"]} if "method" in m else {"recipeUserId": m["id"]})} for m in method_actions)
        if target is None:
            actions.append({"action": "import_user"})
        if self.single_owner_baseline:
            if not await self.store.mapping(winner):
                actions.append({"action": "restore_mapping", "supertokens_user_id": target})
            if method_actions and not self.single_owner_baseline["primary"]:
                actions.append({"action": "create_primary", "supertokens_user_id": target})
        if patch:
            actions.append({"action": "update_migration_metadata"})
        contact = self.profiles[winner]["data"].get("email")
        verified_contact = contact if is_rownd_email_verified(self.profiles[winner].get("verified_data", {}).get("email"), contact) else None
        for method in current_methods:
            if (verified_contact and method.email and method.email.lower() == verified_contact.lower()
                    and method.recipe_id in {"passwordless", "emailpassword", "thirdparty"} and not method.verified):
                actions.append({"action": "verify_email", "recipeUserId": method.recipe_user_id.get_as_string(), "email": method.email})
        if target and occupied.get("rownd_migration_complete") is not True:
            actions.append({"action": "update_migration_metadata"})
        if target:
            target_raw = await self.store.raw(target)
            final_checkpoint = target_raw.get(FINAL_KEY)
            if final_checkpoint is not None and (not isinstance(final_checkpoint, dict) or final_checkpoint.get("status") != "COMPLETE"):
                actions.append({"action": "update_migration_metadata"})
            if target_raw.get(PUBLICATION_KEY):
                actions.append({"action": "restore_mapping"})
        if plan and plan["status"] in {"APPLYING", "RECONCILING"}:
            actions.append({"action": "update_migration_metadata"})
        pointer = occupied.get("rownd_email_recipe_user_ids", {}).get(self.tenant_id, occupied.get("rownd_email_recipe_user_id"))
        if target and not pointer and any(self.tenant_id in m.tenant_ids and m.recipe_id == "passwordless" and m.email for m in current_methods):
            actions.append({"action": "set_canonical_email"})
        if self.orphan:
            actions.insert(0, {"action": "remove_mapping", "supertokens_user_id": self.orphan["absentId"], "rownd_user_id": self.orphan["sourceId"]})
        await self.source_guard()
        if self.single_owner_baseline and target:
            if not same_json(self.single_owner_baseline, await single_owner_snapshot(self.store, target, winner)):
                raise AdministrativePolicyError("Single-owner graph changed before execution")
        if dry_run:
            return {**self.result, "status": "PREVIEW", "dryRun": True, "snapshotOnly": True,
                    "canReconcile": True, "matchesSource": not actions, "proposedActions": actions,
                    "blockers": [], "requiresExecutionProof": [], "missingMethods": missing}
        if not actions and target and user:
            mapping = await self.store.mapping(winner)
            if mapping is None or mapping["id"] != target:
                raise AdministrativePolicyError("Canonical mapping changed")
            return {**self.result, "status": "OK", "changed": False, "actions": [],
                    "recipe_user_ids": [m.recipe_user_id.get_as_string() for m in user.login_methods]}
        if self.orphan:
            await self.source_guard()
            self.mutation_started = True
            await retire_orphan(self.store, self.orphan)
        if target and intent:
            previous_intent = (await self.store.raw(target)).get(METHOD_KEY)
            if previous_intent is None or previous_intent.get("status") == "COMPLETE":
                self.mutation_started = True
                await metadata.update_user_metadata(target, {METHOD_KEY: intent}, self.context)
        if plan:
            await self.execute_owner(plan)
        elif self.single_owner_baseline and target:
            if not await self.store.mapping(winner) or (await self.store.raw(target)).get(PUBLICATION_KEY):
                await publish_mapping(self, target, source)
            if method_actions and not self.single_owner_baseline["primary"]:
                await self.source_guard()
                self.mutation_started = True
                await self.store.operation({"kind": "promote", "id": target}, target)
        await self.progress("methods")
        if target is None:
            self.mutation_started = True
            imported = await import_user({k: v for k, v in source.items() if k != "externalUserId"}, self.core_config, self.context)
            target = imported.get("id")
            if not isinstance(target, str) or not valid_lookup_id(target) or target == winner:
                raise AdministrativePolicyError("Import returned no immutable user ID")
            self.result["supertokens_user_id"] = target
            await self.source_guard()
            await publish_mapping(self, target, source)
            await metadata.update_user_metadata(winner, {"rownd_migration_target": target}, self.context)
            missing = []
        assert isinstance(target, str)
        if method_actions or (await self.store.raw(target)).get(METHOD_KEY):
            await execute_methods(self, target, source, method_actions)
        await self.source_guard()
        self.store.fresh()
        final_user = await self.store.user(target)
        if final_user is None or any(not any(self.tenant_id in m.tenant_ids and login_method_matches_import(m, expected) for m in final_user.login_methods) for expected in source["loginMethods"]):
            raise AdministrativePolicyError("Current Rownd methods remain missing")
        final_actions = []
        for method in final_user.login_methods:
            if (self.tenant_id in method.tenant_ids and verified_contact and method.email and method.email.lower() == verified_contact.lower()
                    and method.recipe_id in {"passwordless", "emailpassword", "thirdparty"}):
                final_actions.append({"kind": "verify_email", "id": method.recipe_user_id.get_as_string(), "email": method.email})
        await self.source_guard()
        current = await self.store.raw(target)
        occupied = await inspect_occupied_metadata(self.store, target, (winner,))
        patch = metadata_backfill(self.profiles[winner], occupied)
        patch["rownd_migration_complete"] = True
        email_methods = [m for m in final_user.login_methods if self.tenant_id in m.tenant_ids and m.recipe_id == "passwordless" and m.email and m.email.lower() == self.profiles[winner]["data"].get("email", "").lower()]
        if len(email_methods) == 1:
            if self.tenant_id == "public":
                patch["rownd_email_recipe_user_id"] = email_methods[0].recipe_user_id.get_as_string()
            patch["rownd_email_recipe_user_ids"] = {**current.get("rownd_email_recipe_user_ids", {}),
                                                   self.tenant_id: email_methods[0].recipe_user_id.get_as_string()}
        self.mutation_started = True
        final_actions.append({"kind": "metadata", "id": target, "values": patch})
        await finish(self, target, final_actions)
        mapping = await self.store.mapping(winner)
        if mapping is None or mapping["id"] != target:
            raise AdministrativePolicyError("Canonical mapping changed")
        if (await self.store.raw(target)).get(PUBLICATION_KEY):
            await metadata.update_user_metadata(target, {PUBLICATION_KEY: None}, self.context)
        if plan:
            # Completion captures newly added recipes, while the original immutable
            # identities remain available for interrupted-owner lineage checks.
            completed = await self.store.inspect_graph([target], [m["id"] for m in plan["initial"]["markers"]])
            if not same_json((await self.store.raw(target)).get(OWNER_PLAN_KEY), plan):
                raise AdministrativePolicyError("Owner checkpoint changed before completion")
            plan["status"] = "COMPLETE"
            plan["completion"] = {"recipes": completed["recipes"], "state": completed["state"]}
            await metadata.update_user_metadata(target, {OWNER_PLAN_KEY: plan}, self.context)
            if not same_json((await self.store.raw(target)).get(OWNER_PLAN_KEY), plan):
                raise AdministrativePolicyError("Owner checkpoint completion changed")
        if self.orphan:
            self.orphan["phase"] = "COMPLETE"
            await metadata.update_user_metadata(self.orphan["sourceId"], {ORPHAN_KEY: self.orphan}, self.context)
        self.result.update(status="OK", changed=self.mutation_started, actions=[names.get(kind, kind) for kind in self.store.actions],
                           recipe_user_ids=[m.recipe_user_id.get_as_string() for m in final_user.login_methods])
        return self.result


async def reconcile_user(*, rownd_user_id: Optional[str] = None,
                         supertokens_user_id: Optional[str] = None,
                         email: Optional[str] = None, tenant_id: str = "public",
                         user_context: Optional[JsonDict] = None, dry_run: bool = False,
                         on_progress: Optional[Callable[..., Any]] = None) -> JsonDict:
    """Reconcile a fresh server-side Rownd profile. Result keys match the Node API."""
    result: JsonDict = {"status": "ERROR", "changed": False, "actions": []}
    if dry_run:
        result.update(dryRun=True, snapshotOnly=True, canReconcile=False, matchesSource=False,
                      proposedActions=[], blockers=[], requiresExecutionProof=[], missingMethods=[])
    operation = None
    try:
        if sum(value is not None for value in (rownd_user_id, supertokens_user_id, email)) != 1:
            raise ValueError("Exactly one of rownd_user_id, supertokens_user_id, email is required")
        selector = next(value for value in (rownd_user_id, supertokens_user_id, email) if value is not None)
        if not valid_lookup_id(selector) or not valid_lookup_id(tenant_id):
            raise ValueError("Invalid reconciliation selector or tenant")
        if type(dry_run) is not bool:
            raise ValueError("dry_run must be a boolean")
        config = get_active_rownd_config()
        if config.disable_rownd_user_migration:
            raise AdministrativePolicyError("Rownd migration is disabled")
        core_config = Supertokens.get_instance().supertokens_config
        context = copy.copy(user_context or {})
        resolve_config = getattr(configuration, "resolve_plugin_config_snapshot", None)
        if resolve_config is not None:
            config = await resolve_config(config, tenant_id, None, context)
        client = config.rownd_client or RowndClient(config)
        result.update({k: v for k, v in {"requested_rownd_user_id": rownd_user_id,
                                      "requested_supertokens_user_id": supertokens_user_id}.items() if v is not None})
        operation = Reconciliation(client, core_config, context, tenant_id, result, on_progress)
        bind_config = getattr(configuration, "bind_request_config", None)
        with bind_config(config) if bind_config else nullcontext():
            return await operation.run(rownd_user_id, supertokens_user_id, email.strip().lower() if email else None, dry_run)
    except AmbiguousElection as error:
        result.update(status="AMBIGUOUS", candidates=[c for c in error.candidates if c.get("supertokens_user_id")],
                      election={"candidates": error.candidates, "basis": "latest_valid_activity"}, message=str(error))
    except _SourceNotFound as error:
        result.update(status="NOT_FOUND", message=str(error))
    except Exception as error:
        policy = isinstance(error, AdministrativePolicyError)
        result.update(status="BLOCKED" if policy else "ERROR", message=str(error))
        if dry_run:
            result["blockers"] = [{"code": "POLICY_BLOCKED" if policy else "OBSERVATION_FAILED"}]
    if operation and operation.mutation_started:
        result.update(partialProgress=True, changed=None)
    else:
        result["partialProgress"] = False
    return result

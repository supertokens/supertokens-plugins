from __future__ import annotations

import copy
import hashlib
import json
from datetime import datetime
from typing import Any

from supertokens_python import asyncio as core
from supertokens_python.recipe.multitenancy import asyncio as tenants
from supertokens_python.recipe.passwordless import asyncio as passwordless
from supertokens_python.recipe.session import asyncio as sessions
from supertokens_python.recipe.usermetadata import asyncio as metadata

from .admin_core import method_identity, same_json
from .admin_planning import OWNER_PLAN_KEY, AdministrativePolicyError, administrative_source, provider_subject, read_owner_plan
from .admin_lineage import prepare_alias_retirement, retirement_alias_receipt, validate_retired_alias
from .admin_methods import validate_retirement_mapping_gap
from .admin_validation import validate_completed_owner_plan
from .admin_source import source_evidence
from .rownd_compatibility import is_rownd_email_verified, is_supertokens_fake_email

INDEX = "rownd_migration_provider_introductions"
RECORD = "rownd_migration_provider_introduction"
RETIREMENTS = "rownd_migration_provider_retirements"
PENDING = "rownd_pending_verification"
EMAIL_RETIREMENTS = "rownd_migration_email_retirements"
LINEAGE = "rownd_migration_admin_lifecycle"


def require(condition: Any) -> None:
    if not condition:
        raise AdministrativePolicyError("Administrative lifecycle checkpoint evidence changed")


def text(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


class AdministrativeLifecycle:
    """A fresh administrative capability; it never upgrades email verification proof."""

    def __init__(self, operation: Any, source_id: str, target: str, profile: dict[str, Any]):
        self.operation = operation
        self.store = operation.store
        self.source_id = source_id
        self.target = target
        self.tenant = operation.tenant_id
        self.profile = copy.deepcopy(profile)
        self.lineage: Any = None
        self.lineage_published = False
        self.source = administrative_source(profile, self.tenant)
        email = profile["data"].get("email")
        self.email = (email.lower() if isinstance(email, str) and not is_supertokens_fake_email(email.lower())
                      and is_rownd_email_verified(profile.get("verified_data", {}).get("email"), email) else None)

    async def fresh(self) -> Any:
        current = await self.operation.fetch(self.source_id)
        require(current is not None and same_json(source_evidence(current), source_evidence(self.profile)))
        self.store.fresh()
        require((await self.store.raw(self.source_id)).get("rownd_migration_superseded") is None)
        mapping = await self.store.mapping(self.source_id)
        require(mapping is not None and mapping["id"] == self.target)
        require(same_json(mapping, await self.store.mapping(self.target, "SUPERTOKENS")))
        if self.lineage_published:
            raw = await self.store.raw(self.target)
            require(same_json(raw.get(LINEAGE), self.lineage))
            require(same_json(raw.get(OWNER_PLAN_KEY), self.lineage["ownerPlan"])
                    or self.lineage.get("completedPlan") is not None and same_json(raw.get(OWNER_PLAN_KEY), self.lineage["completedPlan"]))
        user = await self.store.user(self.target)
        require(user is not None and await self.store.immutable(user.id) == self.target)
        return user

    async def method(self, recipe: str) -> tuple[Any, Any]:
        if self.lineage:
            for step in self.lineage["retirements"]:
                if recipe in {step["literal"], step["id"]}:
                    recipe = step["id"]
                    break
        user = await self.store.user(recipe)
        if user is None:
            return None, None
        methods = [m for m in user.login_methods if await self.store.immutable(m.recipe_user_id.get_as_string()) == await self.store.immutable(recipe)]
        require(len(methods) == 1)
        return user, methods[0]

    async def lineage_checkpoint(self, execute: bool) -> None:
        # Node receipts are consumed during cleanup. Pin their source and alias
        # consequences first so a lost mapping/delete response cannot erase proof.
        raw = await self.store.raw(self.target)
        saved = raw.get(LINEAGE)
        plan = read_owner_plan(raw)
        if saved is not None:
            require(isinstance(saved, dict) and type(saved.get("version")) is int and saved["version"] == 1)
            require(saved.get("sourceId") == self.source_id and saved.get("target") == self.target and saved.get("tenantId") == self.tenant)
            require(same_json(saved.get("source"), source_evidence(self.profile)))
            base = read_owner_plan({OWNER_PLAN_KEY: saved.get("ownerPlan")})
            require(base is not None and base["status"] == "COMPLETE")
            require(isinstance(saved.get("retirements"), list) and isinstance(saved.get("introductions"), list))
            self.lineage = saved
            self.lineage_published = True
            if not same_json(plan, base):
                require(same_json(plan, saved.get("completedPlan")))
                if plan is None:
                    raise AdministrativePolicyError("Lifecycle owner plan disappeared")
                await validate_completed_owner_plan(plan, self.store.context)
            await self.validate_lineage()
            return
        if plan is None:
            return
        require(plan["status"] == "COMPLETE" and plan["sourceId"] == self.source_id and plan["target"] == self.target)
        completion = plan.get("completion")
        if not isinstance(completion, dict):
            raise AdministrativePolicyError("Lifecycle owner completion is missing")
        additions = []
        for action in await self.introductions(False):
            rid = await self.store.immutable(action["recipeUserId"])
            _, method = await self.method(rid)
            additions.append({"id": rid, "identity": method_identity(method), "verified": method.verified,
                              **({"email": method.email} if method.email else {})})
        for pending in raw.get(PENDING, []):
            if pending.get("tenantId") == self.tenant and pending.get("status") == "COMMITTING" and pending.get("purpose") == "UPDATE_PASSWORDLESS":
                literal = pending.get("targetCanonicalRecipeUserId")
                require(text(literal))
                rid = await self.store.immutable(literal)
                _, method = await self.method(rid)
                require(method is not None)
                if not any(r["id"] == rid for r in completion["recipes"]):
                    additions.append({"id": rid, "identity": method_identity(method), "verified": method.verified, "email": method.email})
        retirements = []
        candidates = []
        for entry in raw.get(RETIREMENTS, []):
            replacement = provider_subject(self.profile, entry["provider"])
            if replacement is not None and replacement != entry["subject"]:
                candidates.append(entry["recipeUserId"])
        for pending in raw.get(PENDING, []):
            if pending.get("tenantId", "public") == self.tenant and pending.get("field") == "email":
                candidates.extend(item["recipeUserId"] for item in pending.get("retiredMethods", []))
        for literal in sorted(set(candidates)):
            _, method = await self.method(literal)
            if method is None or self.tenant not in method.tenant_ids:
                continue
            rid = await self.store.immutable(literal)
            require(method.tenant_ids == [self.tenant])
            step = {"kind": "retire", "id": rid, "literal": literal, "identity": method_identity(method)}
            receipt = retirement_alias_receipt(plan, step)
            if receipt:
                step["aliasRetirement"] = receipt
            retirements.append(step)
        self.lineage = {"version": 1, "sourceId": self.source_id, "target": self.target, "tenantId": self.tenant,
                        "source": source_evidence(self.profile), "ownerPlan": plan,
                        "introductions": additions, "retirements": retirements,
                        "nodeIntroductions": copy.deepcopy(getattr(self, "introduction_records", [])),
                        "nodeRetirements": copy.deepcopy(raw.get(RETIREMENTS, [])),
                        "nodeEmails": copy.deepcopy(raw.get(PENDING, [])),
                        "nodeEmailReceipts": copy.deepcopy(raw.get(EMAIL_RETIREMENTS, {}))}
        await self.validate_lineage(initial=True)
        if execute:
            await self.write(self.target, LINEAGE, None, self.lineage)
            self.lineage_published = True

    async def validate_lineage(self, *, initial: bool = False) -> dict[str, Any]:
        checkpoint = self.lineage
        base = checkpoint["ownerPlan"]
        completion = base["completion"]
        original = {r["id"]: r for r in completion["recipes"]}
        additions = {r["id"]: r for r in checkpoint["introductions"]}
        require(len(additions) == len(checkpoint["introductions"]))
        steps = {s["id"]: s for s in checkpoint["retirements"]}
        require(len(steps) == len(checkpoint["retirements"]))
        authorized = set()
        for entry in checkpoint["nodeRetirements"]:
            self.retirement(entry)
            replacement = provider_subject(self.profile, entry["provider"])
            if replacement is None or replacement == entry["subject"]:
                continue
            for rid, step in steps.items():
                identity = json.loads(step["identity"])
                if step["literal"] == entry["recipeUserId"]:
                    require(identity[0] == "thirdparty" and identity[3] == {"id": entry["provider"], "userId": entry["subject"]})
                    authorized.add(rid)
        for pending in checkpoint["nodeEmails"]:
            if pending.get("tenantId", "public") != self.tenant or pending.get("field") != "email" or not pending.get("retiredMethods"):
                continue
            provenance = pending.get("migrationSource", {})
            require(self.email is not None and pending.get("value", "").lower() == self.email
                    and pending.get("status") == "COMMITTING" and pending.get("purpose") == "UPDATE_PASSWORDLESS"
                    and provenance.get("rowndUserId") == self.source_id
                    and provenance.get("providerId") in {"google", "apple"}
                    and all(text(provenance.get(k)) for k in ("providerUserId", "providerRecipeUserId", "previousEmail"))
                    and provider_subject(self.profile, provenance.get("providerId", "")) == provenance.get("providerUserId")
                    and pending.get("id") == "migration-email-" + pending.get("targetCanonicalRecipeUserId", ""))
            provider_owner, provider = await self.method(provenance["providerRecipeUserId"])
            require(provider_owner is not None and provider is not None and await self.store.immutable(provider_owner.id) == self.target
                    and self.tenant in provider.tenant_ids and provider.third_party is not None
                    and provider.third_party.id == provenance["providerId"] and provider.third_party.user_id == provenance["providerUserId"])
            receipt = {"version": 1, "planId": pending["id"], "tenantId": self.tenant,
                       "targetRecipeUserId": pending["targetCanonicalRecipeUserId"], "targetEmail": self.email,
                       "source": provenance, "retiredMethods": sorted(pending["retiredMethods"], key=lambda r: r["recipeUserId"])}
            require(same_json(checkpoint["nodeEmailReceipts"].get(self.tenant), receipt))
            for item in pending["retiredMethods"]:
                for rid, step in steps.items():
                    if step["literal"] == item["recipeUserId"]:
                        identity = json.loads(step["identity"])
                        require(identity[0] == "passwordless" and identity[1].lower() == item["email"].lower()
                                and item["email"].lower() == provenance["previousEmail"].lower() and item["email"].lower() != self.email)
                        authorized.add(rid)
        require(authorized == set(steps))
        for rid, step in steps.items():
            require(rid != self.target and rid in original and step["kind"] == "retire"
                    and same_json(json.loads(step["identity"]), json.loads(original[rid]["identity"])))
            receipt = retirement_alias_receipt(base, step)
            require(same_json(receipt, step.get("aliasRetirement")))
        literals = [m["id"] for m in completion["state"]["markers"]]
        observed = await self.store.inspect_graph([self.target], literals, allow_tenant_membership=bool(base.get("tenantMemberships")))
        require(all(g["owner"] == self.target and g["primary"] is True for g in observed["state"]["graph"]))
        actual = {r["id"]: r for r in observed["recipes"]}
        require(set(original) - set(actual) <= (set() if initial else set(steps)))
        require(set(actual) <= set(original) | set(additions))
        for rid, recipe in actual.items():
            expected = original.get(rid, additions.get(rid))
            if expected is None:
                raise AdministrativePolicyError("Lifecycle recipe has no provenance")
            if (not initial and rid in steps and steps[rid].get("aliasRetirement")
                    and await self.store.mapping(rid, "SUPERTOKENS") is None and recipe["verified"] is False):
                await validate_retirement_mapping_gap(self.store, base, steps[rid])
                expected = {**expected, "verified": False}
            require(same_json(recipe, expected))
        for rid, recipe in additions.items():
            identity = json.loads(recipe["identity"])
            require(identity[4] == [self.tenant] and type(recipe["verified"]) is bool)
            require(rid not in original or same_json(original[rid], recipe))
            if identity[0] == "thirdparty":
                require(isinstance(identity[3], dict) and provider_subject(self.profile, identity[3]["id"]) == identity[3]["userId"])
                records = [r for r in checkpoint["nodeIntroductions"] if r.get("recipeUserId") == rid]
                require(len(records) == 1)
                record = records[0]
                require(record.get("rowndUserId") == self.source_id and record.get("internalUserId") == self.target
                        and record.get("tenantId") == self.tenant and type(record.get("created")) is bool
                        and identity[3] == {"id": record.get("provider"), "userId": record.get("subject")})
            else:
                require(identity[0] == "passwordless" and self.email is not None and identity[1].lower() == self.email and recipe["verified"] is True)
                require(any([p.get("tenantId") == self.tenant and await self.store.immutable(p.get("targetCanonicalRecipeUserId", "")) == rid
                             for p in checkpoint["nodeEmails"]]))
        mappings = {m["id"]: m for m in completion["state"]["mappings"]}
        for rid, expected in mappings.items():
            current = await self.store.mapping(rid, "SUPERTOKENS") or {"id": rid}
            if same_json(current, expected):
                if "alias" in expected:
                    require(same_json(await self.store.mapping(expected["alias"]), expected))
                require(rid in actual or not initial and rid in steps and "alias" not in expected)
                continue
            require(not initial and rid in steps and steps[rid].get("aliasRetirement") is not None)
            if rid in actual:
                await validate_retirement_mapping_gap(self.store, base, steps[rid])
            else:
                await validate_retired_alias(self.store, base, steps[rid]["aliasRetirement"])
        for rid in set(actual) - set(original):
            require(await self.store.mapping(rid, "SUPERTOKENS") is None)
        markers = {m["id"]: m["values"] for m in observed["state"]["markers"]}
        for marker in completion["state"]["markers"]:
            literal, expected = marker["id"], copy.deepcopy(marker["values"])
            email_plans = [p for p in checkpoint["nodeEmails"] if p.get("tenantId") == self.tenant and p.get("retiredMethods")]
            if literal == self.target and email_plans:
                require(len(email_plans) == 1)
                pending = email_plans[0]
                actual_marker = markers.get(literal, {})
                if not same_json(actual_marker.get("original_rownd_user"), expected.get("original_rownd_user")):
                    snapshot = actual_marker.get("original_rownd_user")
                    require(isinstance(snapshot, dict) and same_json(source_evidence(snapshot), source_evidence(self.profile)))
                    expected["original_rownd_user"] = snapshot
                for key in ("rownd_email_recipe_user_id", "rownd_email_recipe_user_ids"):
                    if not same_json(actual_marker.get(key), expected.get(key)):
                        value = pending["targetCanonicalRecipeUserId"] if key.endswith("_id") else {**expected.get(key, {}), self.tenant: pending["targetCanonicalRecipeUserId"]}
                        require(key.endswith("_ids") or self.tenant == "public")
                        require(same_json(actual_marker.get(key), value))
                        expected[key] = value
            retirement = next((s for s in steps.values() if s.get("aliasRetirement", {}).get("mapping", {}).get("alias") == literal), None)
            if not initial and retirement and markers.get(literal, {}).get("rownd_migration_superseded") is not None:
                expected["rownd_migration_superseded"] = {"rowndUserId": self.source_id, "targetUserId": self.target}
            if literal in steps and literal not in actual:
                expected = {}
            lifecycle_fields = {INDEX, RECORD, RETIREMENTS, PENDING, EMAIL_RETIREMENTS}
            require(same_json({k: v for k, v in markers.get(literal, {}).items() if k not in lifecycle_fields},
                              {k: v for k, v in expected.items() if k not in lifecycle_fields}))
        cells = {(c["id"], c["email"]): c["verified"] for c in observed["state"]["verifications"]}
        retired_literals = set(steps) | {s["aliasRetirement"]["mapping"]["alias"] for s in steps.values() if s.get("aliasRetirement")}
        for cell in completion["state"]["verifications"]:
            key = (cell["id"], cell["email"])
            if key in cells:
                require(cells[key] is cell["verified"] or not initial and cell["id"] in retired_literals and cells[key] is False)
        baseline_cells = {(c["id"], c["email"]) for c in completion["state"]["verifications"]}
        for (literal, email), verified in cells.items():
            if verified and (literal, email) not in baseline_cells:
                require(email.lower() == self.email or any(r["id"] == literal and r.get("email") == email and r["verified"] is True for r in additions.values()))
        return observed

    async def finish_lineage(self) -> None:
        if self.lineage is None:
            return
        await self.fresh()
        require(same_json((await self.store.raw(self.target)).get(LINEAGE), self.lineage))
        observed = await self.validate_lineage()
        require({r["id"] for r in self.lineage["introductions"]}.issubset({r["id"] for r in observed["recipes"]}))
        plan = copy.deepcopy(self.lineage["ownerPlan"])
        receipts = list(plan.get("methodAliasRetirements", []))
        for step in self.lineage["retirements"]:
            require(await self.store.user(step["id"]) is None)
            if step.get("aliasRetirement"):
                await validate_retired_alias(self.store, plan, step["aliasRetirement"])
                receipts.append(step["aliasRetirement"])
        plan["methodAliasRetirements"] = receipts
        plan["completion"] = observed
        require(read_owner_plan({OWNER_PLAN_KEY: plan}) is not None)
        completed = {**self.lineage, "completedPlan": plan}
        # Either owner checkpoint is valid across a committed publication whose
        # response was lost; the journal is removed only after live validation.
        await self.write(self.target, LINEAGE, self.lineage, completed)
        self.lineage = completed
        current = (await self.store.raw(self.target)).get(OWNER_PLAN_KEY)
        require(same_json(current, self.lineage["ownerPlan"]) or same_json(current, plan))
        await self.write(self.target, OWNER_PLAN_KEY, current, plan)
        await validate_completed_owner_plan(plan, self.store.context)
        await self.write(self.target, LINEAGE, self.lineage, None)
        self.lineage_published = False

    async def write(self, literal: str, field: str, before: Any, after: Any):
        await self.fresh()
        require(same_json((await self.store.raw(literal)).get(field), before))
        self.operation.mutation_started = True
        await metadata.update_user_metadata(literal, {field: after}, self.store.context)
        require(same_json((await self.store.raw(literal)).get(field), after))

    async def literals(self):
        user = await self.fresh()
        result = {self.target, self.source_id, user.id}
        for method in user.login_methods:
            literal = method.recipe_user_id.get_as_string()
            result.update((literal, await self.store.immutable(literal)))
        return result

    def retirement(self, entry: Any):
        require(isinstance(entry, dict))
        require(all(text(entry.get(k)) for k in ("rowndUserId", "recipeUserId", "subject")))
        require(entry["rowndUserId"] == self.source_id and entry.get("provider") in {"google", "apple"})
        pending = entry.get("pendingTenantIds", [])
        require(isinstance(pending, list) and all(text(t) for t in pending) and len(set(pending)) == len(pending))

    async def introductions(self, execute: bool) -> list[dict[str, Any]]:
        entries = {}
        snapshots = {}
        pending = list(await self.literals())
        while pending:
            literal = pending.pop()
            if literal in snapshots:
                continue
            raw = await self.store.raw(literal)
            snapshots[literal] = {k: raw[k] for k in (INDEX, RECORD) if k in raw}
            values = raw.get(INDEX, [])
            require(isinstance(values, list))
            local = raw.get(RECORD)
            # The Python identity engine owns its nonce-bearing private ledger.
            if isinstance(local, dict) and "checkpoint" in local and "rowndUserId" not in local:
                snapshots[literal].pop(RECORD, None)
                local = None
            for entry in [*values, *([local] if local is not None else [])]:
                self.retirement(entry)
                require(entry.get("internalUserId") == self.target and entry.get("tenantId") == self.tenant)
                require(type(entry.get("created")) is bool)
                require(provider_subject(self.profile, entry["provider"]) == entry["subject"])
                rid = entry["recipeUserId"]
                require(rid not in entries or same_json(entries[rid], entry))
                entries[rid] = entry
                pending.append(rid)
        for rid, entry in entries.items():
            user, method = await self.method(rid)
            if user is None or method is None:
                raise AdministrativePolicyError("Provider introduction recipe disappeared")
            require(self.tenant in method.tenant_ids)
            require(method.third_party is not None and method.third_party.id == entry["provider"] and method.third_party.user_id == entry["subject"])
            owner = await self.store.immutable(user.id)
            require(owner == self.target or (not user.is_primary_user and len(user.login_methods) == 1 and await self.store.mapping(rid, "SUPERTOKENS") is None))
            if owner != self.target and method.email and not method.verified:
                recipient = await self.fresh()
                require(method.email.lower() == self.email or not any(m.email and m.email.lower() == method.email.lower() and m.verified for m in recipient.login_methods))
        actions = [{"action": "link_method", "recipeUserId": rid} for rid in entries]
        self.introduction_records = list(entries.values())
        if not execute:
            return actions
        for rid in entries:
            await self.fresh()
            # Re-read the entire receipt set before linking; no subject-only adoption.
            require(same_json(await self.introductions(False), actions))
            for literal, expected in snapshots.items():
                raw = await self.store.raw(literal)
                require(all(same_json(raw.get(k), v) for k, v in expected.items()))
            user, method = await self.method(rid)
            if await self.store.immutable(user.id) != self.target:
                self.operation.mutation_started = True
                await self.store.operation({"kind": "link", "id": rid}, self.target)
            user, method = await self.method(rid)
            require(await self.store.immutable(user.id) == self.target)
        # Keep indexes until every local record has been acknowledged.
        for field in (RECORD, INDEX):
            for literal, values in snapshots.items():
                if field in values and values[field] not in (None, []):
                    await self.write(literal, field, values[field], None if field == RECORD else [])
        return actions

    async def remove_membership(self, rid: str, *, email: str | None = None):
        user, method = await self.method(rid)
        if method is None or self.tenant not in method.tenant_ids:
            return
        require(await self.store.immutable(user.id) == self.target)
        immutable = await self.store.immutable(method.recipe_user_id.get_as_string())
        require(immutable != self.target or len(method.tenant_ids) > 1)
        step = next((s for s in self.lineage["retirements"] if s["id"] == immutable), None) if self.lineage else None
        if self.lineage is not None:
            require(step is not None and same_json(json.loads(step["identity"]), json.loads(method_identity(method))))
        mapping = await self.store.mapping(immutable, "SUPERTOKENS")
        if len(method.tenant_ids) == 1 and (mapping or step and step.get("aliasRetirement")):
            if self.lineage is None or step is None or step.get("aliasRetirement") is None:
                raise AdministrativePolicyError("Mapped retirement has no lineage receipt")
            require(same_json((await self.store.raw(self.target)).get(LINEAGE), self.lineage))
            await self.validate_lineage()
            self.operation.mutation_started = True
            if mapping is not None:
                receipt = await prepare_alias_retirement(self.store, self.lineage["ownerPlan"], step)
                require(same_json(receipt, step["aliasRetirement"]))
                require(same_json((await self.store.raw(mapping["alias"])).get("rownd_migration_superseded"),
                                  {"rowndUserId": self.source_id, "targetUserId": self.target}))
                for address in sorted({r["email"] for r in self.lineage["ownerPlan"]["recipes"] if r.get("email")}):
                    await self.store.operation({"kind": "revoke_verification_tokens", "id": mapping["alias"], "email": address}, self.target)
                await self.fresh()
                await self.store.operation({"kind": "delete_mapping", "id": immutable, "alias": mapping["alias"]}, self.target)
            await validate_retirement_mapping_gap(self.store, self.lineage["ownerPlan"], step)
        await self.fresh()
        self.operation.mutation_started = True
        if email:
            await passwordless.revoke_all_codes(self.tenant, email=email, user_context=self.store.context)
        if len(method.tenant_ids) > 1:
            await tenants.disassociate_user_from_tenant(self.tenant, method.recipe_user_id, self.store.context)
        else:
            await core.delete_user(immutable, False, self.store.context)

    async def email_cleanup(self, execute: bool) -> list[dict[str, Any]]:
        user = await self.fresh()
        raw = await self.store.raw(self.target)
        entries = raw.get(PENDING, [])
        require(isinstance(entries, list) and all(isinstance(e, dict) and text(e.get("id")) for e in entries))
        require(len({e["id"] for e in entries}) == len(entries))
        applicable = [e for e in entries if e.get("field") == "email" and e.get("tenantId", "public") == self.tenant]
        actions = []
        for plan in applicable:
            require(self.email is not None and isinstance(plan.get("value"), str) and plan["value"].lower() == self.email)
            current = [m for m in user.login_methods if m.recipe_id == "passwordless" and self.tenant in m.tenant_ids and m.email and m.email.lower() == self.email]
            require(len(current) == 1)
            if plan.get("purpose") == "ADD_PASSWORDLESS" and plan.get("status", "PENDING") == "PENDING":
                require(not any(k in plan for k in ("migrationSource", "retiredMethods", "targetCanonicalRecipeUserId")))
                require(not any(m.recipe_id == "passwordless" and self.tenant in m.tenant_ids and m.email and m.email.lower() != self.email for m in user.login_methods))
                verification_id = plan.get("verificationRecipeUserId")
                if verification_id is not None:
                    owner, method = await self.method(verification_id)
                    require(owner is not None and method is not None and await self.store.immutable(owner.id) == self.target and self.tenant in method.tenant_ids)
                retired = []
            else:
                require(plan.get("status") == "COMMITTING" and plan.get("purpose") == "UPDATE_PASSWORDLESS" and plan.get("tenantId") == self.tenant)
                require(text(plan.get("created_at")))
                try:
                    datetime.fromisoformat(plan["created_at"].replace("Z", "+00:00"))
                except ValueError:
                    require(False)
                target_recipe = plan.get("targetCanonicalRecipeUserId")
                require(text(target_recipe) and plan["id"] == "migration-email-" + target_recipe)
                provenance = plan.get("migrationSource")
                require(isinstance(provenance, dict) and provenance.get("rowndUserId") == self.source_id)
                require(provenance.get("providerId") in {"google", "apple"})
                require(all(text(provenance.get(k)) for k in ("providerUserId", "providerRecipeUserId", "previousEmail")))
                require(provenance["previousEmail"].lower() != self.email and not is_supertokens_fake_email(provenance["previousEmail"].lower()))
                owner, provider = await self.method(provenance["providerRecipeUserId"])
                if owner is None or provider is None or provider.third_party is None:
                    raise AdministrativePolicyError("Email retirement provider disappeared")
                require(await self.store.immutable(owner.id) == self.target)
                require(self.tenant in provider.tenant_ids and provider.third_party.id == provenance["providerId"] and provider.third_party.user_id == provenance["providerUserId"])
                require(provider_subject(self.profile, provenance["providerId"]) == provenance["providerUserId"])
                snapshot = raw.get("original_rownd_user")
                require(isinstance(snapshot, dict) and snapshot.get("state", "enabled") == "enabled" and snapshot.get("data", {}).get("user_id") == self.source_id)
                require(snapshot["data"].get("email", "").lower() == self.email and provider_subject(snapshot, provenance["providerId"]) == provenance["providerUserId"])
                require(current[0].verified and current[0].recipe_user_id.get_as_string() == target_recipe)
                require(raw.get("rownd_email_recipe_user_ids", {}).get(self.tenant) == target_recipe)
                retired = plan.get("retiredMethods")
                require(isinstance(retired, list) and retired and all(isinstance(r, dict) and text(r.get("recipeUserId")) and isinstance(r.get("email"), str) for r in retired))
                require(len({r["recipeUserId"] for r in retired}) == len(retired))
                require(all(r["recipeUserId"] != target_recipe and r["email"].lower() == provenance["previousEmail"].lower() for r in retired))
                expected = {"version": 1, "planId": plan["id"], "tenantId": self.tenant, "targetRecipeUserId": target_recipe,
                            "targetEmail": self.email, "source": provenance, "retiredMethods": sorted(retired, key=lambda r: r["recipeUserId"])}
                ledger = raw.get(EMAIL_RETIREMENTS)
                require(isinstance(ledger, dict) and type(ledger.get(self.tenant, {}).get("version")) is int and same_json(ledger.get(self.tenant), expected))
                for item in retired:
                    owner, method = await self.method(item["recipeUserId"])
                    require(owner is None or (await self.store.immutable(owner.id) == self.target and method.recipe_id == "passwordless" and method.email and method.email.lower() == item["email"].lower()))
            actions.append({"action": "update_migration_metadata", "recipeUserId": current[0].recipe_user_id.get_as_string()})
            if not execute:
                continue
            await self.fresh()
            require(same_json((await self.store.raw(self.target)).get(PENDING), entries))
            await self.email_cleanup(False)
            self.operation.mutation_started = True
            for item in retired:
                await self.email_cleanup(False)
                await self.remove_membership(item["recipeUserId"], email=item["email"])
            if retired:
                await sessions.revoke_all_sessions_for_user(self.target, True, self.tenant, self.store.context)
            else:
                await self.store.operation({"kind": "verify_email", "id": current[0].recipe_user_id.get_as_string(), "email": self.email}, self.target)
            if plan.get("verificationRecipeUserId"):
                await self.store.operation({"kind": "revoke_verification_tokens", "id": plan["verificationRecipeUserId"], "email": self.email}, self.target)
            await self.email_cleanup(False)
            remaining = [e for e in entries if e["id"] != plan["id"]]
            if retired:
                ledger = (await self.store.raw(self.target)).get(EMAIL_RETIREMENTS, {})
                await self.fresh()
                require(same_json((await self.store.raw(self.target)).get(PENDING), entries))
                patch = {PENDING: remaining, EMAIL_RETIREMENTS: {k: v for k, v in ledger.items() if k != self.tenant}}
                await metadata.update_user_metadata(self.target, patch, self.store.context)
                saved = await self.store.raw(self.target)
                require(all(same_json(saved.get(k), v) for k, v in patch.items()))
            else:
                await self.write(self.target, PENDING, entries, remaining)
            entries = remaining
        return actions

    async def provider_cleanup(self, execute: bool) -> list[dict[str, Any]]:
        await self.fresh()
        entries = (await self.store.raw(self.target)).get(RETIREMENTS, [])
        require(isinstance(entries, list))
        ledger_id = "rownd-provider-revocations-" + hashlib.sha256(json.dumps([self.target, self.tenant], separators=(",", ":")).encode()).hexdigest()
        debt = await self.store.raw(ledger_id)
        for value in [*entries, *debt.values()]:
            self.retirement(value)
        require(len({e["recipeUserId"] for e in entries}) == len(entries))
        for value in debt.values():
            require(value.get("internalUserId") == self.target and value.get("tenantId") == self.tenant)
        actions = []
        for entry in entries:
            owner, method = await self.method(entry["recipeUserId"])
            if method is not None:
                require(await self.store.immutable(owner.id) == self.target and method.third_party is not None
                        and method.third_party.id == entry["provider"] and method.third_party.user_id == entry["subject"])
                if self.tenant in method.tenant_ids:
                    replacement = provider_subject(self.profile, entry["provider"])
                    if replacement is None or replacement == entry["subject"]:
                        if self.tenant in entry.get("pendingTenantIds", []):
                            actions.append({"action": "review_provider_retirement", "recipeUserId": entry["recipeUserId"]})
                        continue
                    user = await self.fresh()
                    linked = any(m.third_party and m.third_party.id == entry["provider"] and m.third_party.user_id == replacement
                                 and self.tenant in m.tenant_ids for m in user.login_methods)
                    if not linked and not execute:
                        await self.introductions(False)
                        index = (await self.store.raw(self.target)).get(INDEX, [])
                        linked = any(i.get("provider") == entry["provider"] and i.get("subject") == replacement for i in index)
                    require(linked)
                    require(await self.store.immutable(entry["recipeUserId"]) != self.target or len(method.tenant_ids) > 1)
            actions.append({"action": "review_provider_retirement", "recipeUserId": entry["recipeUserId"]})
        if not execute:
            return actions + ([{"action": "update_migration_metadata"}] if debt else [])
        # Settle independent revocation debt even if the live source moved again.
        for key, value in debt.items():
            await self.fresh()
            require(same_json((await self.store.raw(ledger_id)).get(key), value))
            self.operation.mutation_started = True
            await sessions.revoke_all_sessions_for_user(self.target, True, self.tenant, self.store.context)
            await self.write(ledger_id, key, value, None)
        for entry in list(entries):
            if not any(a.get("recipeUserId") == entry["recipeUserId"] for a in actions):
                continue
            await self.fresh()
            require(same_json((await self.store.raw(self.target)).get(RETIREMENTS), entries))
            owner, method = await self.method(entry["recipeUserId"])
            replacement = provider_subject(self.profile, entry["provider"])
            removing = method is not None and self.tenant in method.tenant_ids and replacement is not None and replacement != entry["subject"]
            if removing:
                await self.provider_cleanup(False)
                receipt = {**entry, "pendingTenantIds": sorted(set(entry.get("pendingTenantIds", [])) | {self.tenant})}
                updated = [receipt if e["recipeUserId"] == entry["recipeUserId"] else e for e in entries]
                await self.write(self.target, RETIREMENTS, entries, updated)
                entries = updated
                await self.remove_membership(entry["recipeUserId"])
            self.operation.mutation_started = True
            await sessions.revoke_all_sessions_for_user(self.target, True, self.tenant, self.store.context)
            owner, method = await self.method(entry["recipeUserId"])
            if removing:
                require(method is None or self.tenant not in method.tenant_ids)
            remaining = []
            for saved in entries:
                if saved["recipeUserId"] != entry["recipeUserId"]:
                    remaining.append(saved)
                else:
                    pending = [t for t in saved.get("pendingTenantIds", []) if t != self.tenant]
                    if method is not None or pending:
                        remaining.append({**saved, "pendingTenantIds": pending})
            await self.write(self.target, RETIREMENTS, entries, remaining)
            entries = remaining
        return actions


async def recover_lifecycle(operation: Any, source_id: str, target: str, dry_run: bool) -> list[dict[str, Any]]:
    user = await operation.store.user(target)
    literals = {source_id, target}
    if user:
        for method in user.login_methods:
            literal = method.recipe_user_id.get_as_string()
            literals.update((literal, await operation.store.immutable(literal)))
    debt_id = "rownd-provider-revocations-" + hashlib.sha256(json.dumps([target, operation.tenant_id], separators=(",", ":")).encode()).hexdigest()
    present = bool(await operation.store.raw(debt_id))
    for literal in literals:
        raw = await operation.store.raw(literal)
        present = present or any(raw.get(k) not in (None, [], {}) for k in (INDEX, RETIREMENTS, PENDING, EMAIL_RETIREMENTS, LINEAGE))
        local = raw.get(RECORD)
        present = present or (local is not None and not (isinstance(local, dict) and "checkpoint" in local and "rowndUserId" not in local))
    if not present:
        return []
    profile = await operation.fetch(source_id)
    require(profile is not None)
    capability = AdministrativeLifecycle(operation, source_id, target, profile)
    await capability.lineage_checkpoint(False)
    # Validate all source-bound work before acknowledging any checkpoint.
    introductions = await capability.introductions(False)
    emails = await capability.email_cleanup(False)
    providers = await capability.provider_cleanup(False)
    if not dry_run:
        await capability.lineage_checkpoint(True)
        await capability.introductions(True)
        await capability.email_cleanup(True)
        await capability.provider_cleanup(True)
        await capability.finish_lineage()
    return introductions + emails + providers

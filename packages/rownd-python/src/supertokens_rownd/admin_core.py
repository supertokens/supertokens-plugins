from __future__ import annotations

import copy
import json
from typing import Any, Optional

from supertokens_python import asyncio as core
from supertokens_python.interfaces import GetUserIdMappingOkResult, CreateUserIdMappingOkResult
from supertokens_python.recipe.accountlinking import asyncio as linking
from supertokens_python.recipe.emailverification import asyncio as verification
from supertokens_python.recipe.usermetadata import asyncio as metadata
from supertokens_python.types import RecipeUserId

from .admin_planning import AdministrativePolicyError, POLICY_MARKERS
from .supertokens_repository import get_raw_user_metadata
from .utils import clear_supertokens_core_call_cache

JsonDict = dict[str, Any]


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def same_json(left: Any, right: Any) -> bool:
    return canonical_json(left) == canonical_json(right)


def method_identity(method: Any) -> str:
    provider = method.third_party
    webauthn = getattr(method, "webauthn", None)
    return json.dumps([method.recipe_id, method.email, method.phone_number,
                       {"id": provider.id, "userId": provider.user_id} if provider else None,
                       sorted(method.tenant_ids), method.time_joined,
                       webauthn.to_json() if webauthn is not None else None], separators=(",", ":"))


class AdministrativeCore:
    def __init__(self, context: JsonDict, tenant_id: str = "public"):
        self.context = context
        self.tenant_id = tenant_id
        self.actions: list[str] = []

    def fresh(self) -> None:
        clear_supertokens_core_call_cache(self.context)

    async def mapping(self, user_id: str, kind: Any = "EXTERNAL") -> Optional[JsonDict]:
        result = await core.get_user_id_mapping(user_id, kind, self.context)
        if not isinstance(result, GetUserIdMappingOkResult):
            return None
        return {"id": result.supertokens_user_id, "alias": result.external_user_id,
                **({"info": result.external_user_info} if result.external_user_info is not None else {})}

    async def immutable(self, user_id: str) -> str:
        mapping = await self.mapping(user_id)
        return mapping["id"] if mapping else user_id

    async def user(self, user_id: str):
        return await core.get_user(user_id, self.context)

    async def raw(self, user_id: str) -> JsonDict:
        return copy.deepcopy(await get_raw_user_metadata(user_id, self.context))

    async def namespace(self, user_id: str) -> None:
        external = await self.mapping(user_id)
        internal = await self.mapping(user_id, "SUPERTOKENS")
        if external and internal and not same_json(external, internal):
            raise AdministrativePolicyError("Selector namespace collision")
        if internal and internal["alias"] != user_id:
            raise AdministrativePolicyError("Selector is another identity's immutable ID")

    async def owners(self, users: list[Any]) -> dict[str, Any]:
        result = {}
        for user in users:
            if user is not None:
                result[await self.immutable(user.id)] = user
        return result

    async def inspect_graph(self, owner_ids: list[str], extra_literals: list[str],
                             expected_recipes: Optional[list[JsonDict]] = None, *,
                             allow_tenant_membership: bool = False) -> JsonDict:
        self.fresh()
        recipes: dict[str, JsonDict] = {}
        graph: dict[str, JsonDict] = {}
        mappings: dict[str, JsonDict] = {}
        literals = set(extra_literals)
        for owner_id in owner_ids:
            user = await self.user(owner_id)
            if user is None:
                raise AdministrativePolicyError("A checkpoint owner disappeared")
            owner = await self.immutable(user.id)
            for method in user.login_methods:
                if method.tenant_ids != ["public"] and not allow_tenant_membership:
                    raise AdministrativePolicyError("Owner consolidation requires public-only recipes")
                recipe_id = await self.immutable(method.recipe_user_id.get_as_string())
                member = await self.user(recipe_id)
                if (member is None or await self.immutable(member.id) != owner
                        or member.is_primary_user != user.is_primary_user):
                    raise AdministrativePolicyError("Recipe reverse ownership changed")
                matching = []
                for entry in member.login_methods:
                    if await self.immutable(entry.recipe_user_id.get_as_string()) == recipe_id:
                        matching.append(entry)
                if len(matching) != 1 or not same_json(json.loads(method_identity(matching[0])), json.loads(method_identity(method))):
                    raise AdministrativePolicyError("Recipe reverse identity changed")
                mapping = await self.mapping(recipe_id, "SUPERTOKENS")
                recipes[recipe_id] = {"id": recipe_id, "identity": method_identity(method),
                                      "verified": method.verified,
                                      **({"email": method.email} if method.email else {})}
                graph[recipe_id] = {"id": recipe_id, "owner": owner, "primary": user.is_primary_user}
                mappings[recipe_id] = mapping or {"id": recipe_id}
                literals.add(recipe_id)
                if mapping:
                    reverse = await self.mapping(mapping["alias"])
                    if not same_json(mapping, reverse):
                        raise AdministrativePolicyError("Mapping directions disagree")
                    literals.add(mapping["alias"])
        if expected_recipes is not None:
            if set(recipes) != {r["id"] for r in expected_recipes}:
                raise AdministrativePolicyError("Owner graph recipes changed")
            for expected in expected_recipes:
                if not same_json(json.loads(recipes[expected["id"]]["identity"]), json.loads(expected["identity"])):
                    raise AdministrativePolicyError("Owner recipe identity changed")
        markers = []
        for literal in sorted(literals):
            raw = await self.raw(literal)
            markers.append({"id": literal, "values": {k: v for k, v in raw.items() if k in POLICY_MARKERS}})
        cells = []
        emails = sorted({r["email"] for r in recipes.values() if r.get("email")})
        for literal in sorted(literals):
            for email in emails:
                verified = await verification.is_email_verified(RecipeUserId(literal), email, self.context)
                cells.append({"id": literal, "email": email, "verified": verified})
        return {"recipes": [recipes[k] for k in sorted(recipes)], "state": {
            "graph": [graph[k] for k in sorted(graph)],
            "mappings": [mappings[k] for k in sorted(mappings)],
            "markers": markers, "verifications": cells}}

    async def inspect_plan(self, plan: JsonDict) -> JsonDict:
        # Every immutable recipe is queried: a detached donor is no longer reachable
        # through the original primary during an interrupted consolidation.
        return await self.inspect_graph([r["id"] for r in plan["recipes"]],
                                        [m["id"] for m in plan["initial"]["markers"]],
                                        plan["recipes"])

    async def operation(self, operation: JsonDict, target: str) -> None:
        self.fresh()
        kind, recipe_id = operation["kind"], operation["id"]
        result = None
        recipe_mapping = await self.mapping(recipe_id, "SUPERTOKENS")
        effective_id = recipe_mapping["alias"] if recipe_mapping else recipe_id
        if kind == "detach":
            donor = await self.user(recipe_id)
            if donor is None or not donor.is_primary_user or await self.immutable(donor.id) == target:
                raise AdministrativePolicyError("Donor ownership changed before unlink")
            if await self.immutable(donor.id) == recipe_id and len(donor.login_methods) != 1:
                raise AdministrativePolicyError("Donor primary still has linked recipes")
            result = await linking.unlink_account(RecipeUserId(effective_id), self.context)
            if getattr(result, "was_recipe_user_deleted", False):
                raise AdministrativePolicyError("Unlink unexpectedly deleted a recipe")
        elif kind == "promote":
            result = await linking.create_primary_user(RecipeUserId(effective_id), self.context)
        elif kind == "link":
            result = await linking.link_accounts(RecipeUserId(effective_id), target, self.context)
        elif kind == "delete_mapping":
            current = await self.mapping(operation["alias"])
            reverse = await self.mapping(recipe_id, "SUPERTOKENS")
            if current is None or current["id"] != recipe_id or not same_json(current, reverse):
                raise AdministrativePolicyError("Mapping changed before deletion")
            result = await core.delete_user_id_mapping(operation["alias"], "EXTERNAL", True, self.context)
        elif kind == "create_mapping":
            if await self.mapping(operation["alias"]) or await self.mapping(recipe_id, "SUPERTOKENS"):
                raise AdministrativePolicyError("Mapping changed before publication")
            # Force is scoped to the already validated owner plan and literal cells.
            result = await core.create_user_id_mapping(recipe_id, operation["alias"],
                                                       operation.get("info"), True, self.context)
            if not isinstance(result, CreateUserIdMappingOkResult):
                raise AdministrativePolicyError("Core rejected mapping publication")
            result = None
        elif kind == "metadata":
            raw = await self.raw(recipe_id)
            patch = {k: None for k in POLICY_MARKERS if k in raw and k not in operation["values"]}
            patch.update(operation["values"])
            await metadata.update_user_metadata(recipe_id, patch, self.context)
        elif kind == "revoke_verification_tokens":
            # Revocation is repeated until the mapping transition is committed.
            # Tokens issued in that gap must not survive alias reassignment.
            result = await verification.revoke_email_verification_tokens(
                self.tenant_id, RecipeUserId(recipe_id), operation["email"], self.context)
        elif kind == "verify_email":
            if not await verification.is_email_verified(RecipeUserId(recipe_id), operation["email"], self.context):
                token = await verification.create_email_verification_token(
                    self.tenant_id, RecipeUserId(recipe_id), operation["email"], self.context)
                if getattr(token, "token", None):
                    result = await verification.verify_email_using_token(self.tenant_id, getattr(token, "token"), False, self.context)
                elif getattr(token, "status", None) != "EMAIL_ALREADY_VERIFIED_ERROR":
                    raise AdministrativePolicyError("Email verification failed")
        else:
            raise AdministrativePolicyError("Unknown administrative operation")
        self.fresh()
        if result is not None and getattr(result, "status", "OK") != "OK":
            raise AdministrativePolicyError("Core rejected administrative operation: " + kind)
        self.actions.append(kind)

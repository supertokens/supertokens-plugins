from __future__ import annotations

import json
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Awaitable, Callable, Iterator, Optional, cast

from supertokens_python.recipe.emailverification import EmailVerificationClaim
from supertokens_python.recipe.session import asyncio as session_asyncio
from supertokens_python.recipe.session.interfaces import ClaimsValidationResult
from supertokens_python.types import User
from supertokens_python.types.base import UserContext

from .errors import RowndEmailChangeError, RowndPluginError
from .types import JsonDict

SESSION_AUTHENTICATION_KEY = "rownd_session_authentication"
_proven_authentication: ContextVar[bool] = ContextVar("rownd_proven_authentication", default=False)
_owner_plan_validator: Optional[Callable[[JsonDict, UserContext], Awaitable[None]]] = None
_owner_plan_reader: Optional[Callable[[JsonDict], Optional[JsonDict]]] = None
_verified_email_destination: ContextVar[Optional[tuple[str, str]]] = ContextVar(
    "rownd_verified_email_destination", default=None
)


@contextmanager
def verified_email_change_destination(tenant_id: str, email: str) -> Iterator[None]:
    # Only the verified completion path may bypass sign-in retirement to prepare its target.
    token = _verified_email_destination.set((tenant_id, email.strip().lower()))
    try:
        yield
    finally:
        _verified_email_destination.reset(token)


def is_verified_email_change_destination(tenant_id: str, email: str) -> bool:
    return _verified_email_destination.get() == (tenant_id, email.strip().lower())


async def assert_email_change_session_claims(handle: str, context: UserContext) -> None:
    result = await session_asyncio.validate_claims_for_session_handle(
        handle,
        lambda validators, _session, _context: [
            validator
            for validator in validators
            if getattr(getattr(validator, "claim", None), "key", None) != EmailVerificationClaim.key
        ],
        context,
    )
    if not isinstance(result, ClaimsValidationResult) or result.invalid_claims:
        raise RowndEmailChangeError("CONFLICT", 409, "email change session claims are invalid")


def register_owner_plan_reader(
    reader: Callable[[JsonDict], Optional[JsonDict]],
) -> None:
    """Bind the authoritative structural reader; input is raw owner metadata."""
    global _owner_plan_reader
    _owner_plan_reader = reader


def _read_owner_plan(metadata: JsonDict) -> Optional[JsonDict]:
    key = "rownd_migration_owner_consolidation"
    if key not in metadata:
        return None
    raw = metadata[key]
    if not isinstance(raw, dict) or type(raw.get("version")) is not int:
        raise RowndPluginError("Invalid owner consolidation checkpoint")
    if raw["version"] not in {1, 2}:
        raise RowndPluginError("Invalid owner consolidation checkpoint")
    if _owner_plan_reader is None:
        raise RowndPluginError("Owner consolidation checkpoint reader is unavailable")
    plan = _owner_plan_reader(metadata)
    if raw["version"] == 2 and plan is None:
        raise RowndPluginError("Invalid owner consolidation checkpoint")
    return plan


def register_owner_plan_validator(
    validator: Callable[[JsonDict, UserContext], Awaitable[None]],
) -> None:
    """Bind the reconciliation engine's fresh ownership, mapping, and checkpoint validator."""
    global _owner_plan_validator
    _owner_plan_validator = validator


@contextmanager
def proven_session_authentication() -> Iterator[None]:
    # Only credential-success paths may establish this private binding.
    token = _proven_authentication.set(True)
    try:
        yield
    finally:
        _proven_authentication.reset(token)


async def session_authentication_origin(
    user: Optional[User],
    recipe_user_id: Optional[str],
    payload: JsonDict,
    context: UserContext,
    creating: bool = False,
) -> Optional[str]:
    if creating and _proven_authentication.get():
        return "authenticated"
    if not creating:
        if payload.get(SESSION_AUTHENTICATION_KEY) == "authenticated":
            return "authenticated"
        if (
            payload.get(SESSION_AUTHENTICATION_KEY) == "instant"
            or payload.get("auth_level") == "instant"
        ):
            return "instant"
    if user is None or recipe_user_id is None:
        return "instant" if payload.get("auth_level") == "instant" else None

    from .supertokens_repository import freshly_resolve_sdk_user_id_to_internal

    if not creating:
        from .supertokens_repository import get_raw_user_metadata

        target = await freshly_resolve_sdk_user_id_to_internal(user.id, context)
        metadata = await get_raw_user_metadata(target, context)
        plan = _read_owner_plan(metadata)
        if plan is not None:
            if plan.get("status") != "COMPLETE" or plan.get("reservation"):
                raise RowndPluginError("Owner consolidation is incomplete")
            if _owner_plan_validator is None:
                raise RowndPluginError("Completed owner plan validation is unavailable")
            await _owner_plan_validator(plan, context)
            if recipe_user_id in ambiguous_owner_session_aliases(plan):
                # Unmarked sessions on moved aliases cannot prove their original credential.
                return "instant"

    recipe = await freshly_resolve_sdk_user_id_to_internal(recipe_user_id, context)
    for method in user.login_methods:
        method_id = await freshly_resolve_sdk_user_id_to_internal(
            method.recipe_user_id.get_as_string(), context
        )
        if method_id != recipe:
            continue
        provider = method.third_party.id if method.third_party else None
        if provider == "instant":
            return "instant"
        if provider != "guest":
            return "authenticated"
    return None


def ambiguous_owner_session_aliases(plan: JsonDict) -> set[str]:
    """Extract aliases only after the authoritative checkpoint reader has accepted the plan."""
    if type(plan.get("version")) is not int:
        raise RowndPluginError("Invalid owner consolidation checkpoint")
    if plan.get("version") == 1:
        return set()
    if plan.get("version") != 2:
        raise RowndPluginError("Invalid owner consolidation checkpoint")

    def records(key: str) -> list[JsonDict]:
        values = plan.get(key, [])
        if not isinstance(values, list) or any(not isinstance(value, dict) for value in values):
            raise RowndPluginError("Invalid owner consolidation checkpoint")
        return cast(list[JsonDict], values)

    recipes = records("recipes")
    anchor = next((recipe for recipe in recipes if recipe.get("id") == plan.get("target")), None)
    if anchor is None:
        return set()
    try:
        serialized_identity = anchor["identity"]
        if not isinstance(serialized_identity, str):
            raise RowndPluginError("Invalid owner consolidation checkpoint")
        identity = json.loads(serialized_identity)
    except (KeyError, TypeError, ValueError):
        return set()
    if not (
        isinstance(identity, list)
        and len(identity) >= 5
        and identity[0] == "thirdparty"
        and isinstance(identity[3], dict)
        and identity[3].get("id") == "instant"
        and isinstance(identity[3].get("userId"), str)
        and identity[3]["userId"]
        and identity[4] == ["public"]
    ):
        return set()
    aliases = records("aliases")
    retired = records("retiredAliases")
    history = plan.get("legacySessionAliasHistory", {})
    if not isinstance(history, dict):
        raise RowndPluginError("Invalid owner consolidation checkpoint")
    history_aliases = history.get("aliases", [])
    if not isinstance(history_aliases, list) or any(
        not isinstance(alias, str) for alias in history_aliases
    ):
        raise RowndPluginError("Invalid owner consolidation checkpoint")
    if any(not isinstance(alias.get("id"), str) for alias in aliases + retired):
        raise RowndPluginError("Invalid owner consolidation checkpoint")
    return (
        set(cast(list[str], history_aliases))
        | {
            cast(str, alias["id"])
            for alias in aliases
            if (alias.get("from") is not None and alias["from"] != alias.get("to"))
            or (alias["id"] == identity[3]["userId"] and alias.get("to") != plan.get("target"))
        }
        | {cast(str, alias["id"]) for alias in retired}
    )

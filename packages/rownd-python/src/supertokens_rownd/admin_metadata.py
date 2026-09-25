from __future__ import annotations

from typing import Any

from .admin_core import AdministrativeCore


async def inspect_occupied_metadata(store: AdministrativeCore, target: str,
                                    additional_literals: tuple[str, ...] = ()) -> dict[str, Any]:
    user = await store.user(target)
    literals = set(additional_literals)
    literals.add(target)
    if user is not None:
        literals.add(user.id)
        for method in user.login_methods:
            literal = method.recipe_user_id.get_as_string()
            literals.add(literal)
            mapping = await store.mapping(literal, "ANY")
            if mapping:
                literals.update((mapping["id"], mapping["alias"]))
    result: dict[str, Any] = {}
    visited = set()
    pending = sorted(literals)
    while pending:
        literal = pending.pop(0)
        if literal in visited:
            continue
        visited.add(literal)
        raw = await store.raw(literal)
        result.update(raw)
        reference = raw.get("rownd_migration_canonical_target", raw.get("rownd_migration_target"))
        if isinstance(reference, str) and reference not in visited:
            pending.append(reference)
    # Top-level nulls and opaque objects are occupied, not merge instructions.
    result.update(await store.raw(target))
    return result

from __future__ import annotations

from typing import Any


def source_evidence(profile: dict[str, Any]) -> dict[str, Any]:
    """Bind authorization/election evidence independently of mutable profile fields."""
    fields = ("user_id", "email", "phone_number", "google_id", "apple_id")
    def identities(container):
        result = {key: container[key] for key in fields if container.get(key) not in (None, "")}
        if isinstance(result.get("email"), str):
            result["email"] = result["email"].lower()
        return result
    meta = profile.get("meta") or {}
    return {"data": identities(profile["data"]),
            "verified_data": identities(profile.get("verified_data", {})),
            "state": profile.get("state", "enabled"), "auth_level": profile.get("auth_level"),
            "activity": {key: meta.get(key) for key in ("last_active", "last_sign_in")}}

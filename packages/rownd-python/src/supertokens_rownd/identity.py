from __future__ import annotations

import re
from copy import deepcopy
from typing import Optional

from .errors import MigrationError, MigrationErrorReason
from .types import JsonDict


def normalize_optional_identities(profile: JsonDict) -> JsonDict:
    normalized = deepcopy(profile)
    for container_name in ("data", "verified_data"):
        container = normalized.get(container_name)
        if not isinstance(container, dict):
            continue
        for field in ("email", "phone_number", "google_id", "apple_id"):
            value = container.get(field)
            if value is None or value == "":
                container.pop(field, None)
    return normalized


def validate_identity_cells(profile: JsonDict) -> None:
    for container_name in ("data", "verified_data"):
        container = profile.get(container_name)
        if not isinstance(container, dict):
            continue
        for field in ("email", "phone_number", "google_id", "apple_id"):
            if field not in container:
                continue
            value = container[field]
            if container_name == "verified_data" and isinstance(value, bool):
                continue
            if not isinstance(value, str) or not value.strip():
                raise MigrationError(MigrationErrorReason.SOURCE_IDENTITY_INVALID, "source_normalize")
            if field == "email" and not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value.strip()):
                raise MigrationError(MigrationErrorReason.SOURCE_IDENTITY_INVALID, "source_normalize")
            if field == "phone_number" and not re.fullmatch(r"\+[1-9][0-9]{1,14}", value.strip()):
                raise MigrationError(MigrationErrorReason.SOURCE_IDENTITY_INVALID, "source_normalize")


def provider_subject(profile: JsonDict, provider: str) -> Optional[str]:
    field = "%s_id" % provider
    for container_name in ("verified_data", "data"):
        container = profile.get(container_name)
        value = container.get(field) if isinstance(container, dict) else None
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def core_phone_number(phone: str) -> str:
    # Rownd proof stays literal; only Core's retired Mexico mobile prefix differs.
    return "+52" + phone[4:] if re.fullmatch(r"\+521[0-9]{10}", phone) else phone

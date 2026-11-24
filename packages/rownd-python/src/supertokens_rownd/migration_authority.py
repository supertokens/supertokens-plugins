from __future__ import annotations

import json
from dataclasses import replace
from typing import TYPE_CHECKING
from weakref import WeakKeyDictionary
from supertokens_python.types.base import UserContext

from .errors import MigrationError, MigrationErrorReason
from .rownd_compatibility import is_supertokens_fake_email

if TYPE_CHECKING:
    from .supertokens_repository import FreshMigrationSource


_authenticated: WeakKeyDictionary = WeakKeyDictionary()


def _fingerprint(source: FreshMigrationSource) -> str:
    return json.dumps([source.rownd_user, source.snapshot.rownd_user_id, source.snapshot.tenant_id, source.snapshot.app_variant_id,
                       [identity.__dict__ for identity in source.snapshot.expected_identities]], sort_keys=True)


def _bind_authenticated_source(source: FreshMigrationSource) -> FreshMigrationSource:
    """Called only by the validated-token profile reader, never from userContext."""
    from .supertokens_repository import FreshMigrationSource

    identities = tuple(
        replace(identity, verified=True)
        if identity.identifier_type == "email" and not is_supertokens_fake_email(identity.identifier)
        else identity for identity in source.snapshot.expected_identities
    )
    bound = FreshMigrationSource(source.rownd_user, replace(source.snapshot, expected_identities=identities))
    _authenticated[bound] = _fingerprint(bound)
    return bound


def has_authenticated_source(source: FreshMigrationSource) -> bool:
    proof = _authenticated.get(source)
    if proof is None:
        return False
    if proof != _fingerprint(source):
        raise MigrationError(MigrationErrorReason.SOURCE_IDENTITY_INVALID, "source_normalize")
    return True


def authenticated_source_email(source: FreshMigrationSource):
    if not has_authenticated_source(source):
        return None
    return next((identity.identifier for identity in source.snapshot.expected_identities
                 if identity.identifier_type == "email" and identity.verified), None)


def assert_source_authority(source: FreshMigrationSource) -> None:
    from .migration import create_rownd_identity_snapshot

    if source.rownd_user.get("state", "enabled") != "enabled":
        raise MigrationError(MigrationErrorReason.SOURCE_IDENTITY_INVALID, "source_normalize")
    email = authenticated_source_email(source)
    actual = create_rownd_identity_snapshot(source.rownd_user, source.snapshot.tenant_id, source.snapshot.app_variant_id)
    identities = tuple(replace(identity, verified=True) if email and identity.identifier == email
                       and identity.identifier_type == "email" else identity for identity in actual.expected_identities)
    if replace(actual, expected_identities=identities) != source.snapshot:
        raise MigrationError(MigrationErrorReason.SOURCE_IDENTITY_INVALID, "source_normalize")


async def assert_source_not_superseded(rownd_user_id: str, context: UserContext) -> None:
    from . import supertokens_repository as repo

    repo.clear_supertokens_core_call_cache(context)
    await assert_source_not_superseded_in_phase(rownd_user_id, context)


async def assert_source_not_superseded_in_phase(rownd_user_id: str, context: UserContext) -> None:
    from . import supertokens_repository as repo

    # The literal alias tombstone survives removal of its user-ID mapping. Linked
    # metadata or an administrative recovery reference must not authorize replay.
    try:
        raw = await repo.get_raw_user_metadata(rownd_user_id, context)
    except MigrationError:
        raise
    except Exception as error:
        raise MigrationError(
            MigrationErrorReason.CORE_UNAVAILABLE
            if repo._is_recognizable_core_outage(error)
            else MigrationErrorReason.MIGRATION_INCOMPLETE,
            "state_inspect",
            error,
        ) from error
    if "rownd_migration_superseded" in raw:
        raise MigrationError(MigrationErrorReason.IDENTITY_OWNED_BY_ANOTHER_USER, "state_inspect")

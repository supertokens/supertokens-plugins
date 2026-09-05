from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from types import MappingProxyType
from typing import Mapping, Optional, Tuple, TypeVar

from .errors import MigrationError, MigrationErrorReason
from .types import JsonDict, RowndSchema


@dataclass(frozen=True)
class ExpectedIdentity:
    key: str
    recipe_id: str
    provider_id: Optional[str] = None
    provider_user_id: Optional[str] = None
    identifier_type: Optional[str] = None
    identifier: Optional[str] = None


@dataclass(frozen=True)
class RowndIdentitySnapshot:
    rownd_user_id: str
    expected_identities: Tuple[ExpectedIdentity, ...]
    tenant_id: str
    app_variant_id: Optional[str]


@dataclass(frozen=True)
class IdentityOwner:
    identity_key: str
    recipe_user_id: str
    primary_user_id: str
    recipe_id: str
    normalized_identifier: str
    verified: bool
    tenant_ids: Tuple[str, ...]
    is_primary_user: bool


@dataclass(frozen=True)
class IdentityReservationOwner:
    identity_key: str
    recipe_user_id: str
    primary_user_id: str
    recipe_id: str
    is_primary_user: bool


@dataclass(frozen=True)
class MappingLookup:
    external_user_id: str
    supertokens_user_id: str


class RawIdStatus(str, Enum):
    ABSENT = "ABSENT"
    PRESENT = "PRESENT"
    UNINSPECTABLE = "UNINSPECTABLE"


@dataclass(frozen=True)
class RawIdInspection:
    status: RawIdStatus
    user_id: Optional[str] = None
    same_identity_graph: bool = False


@dataclass(frozen=True)
class MappingState:
    external_lookup: Optional[MappingLookup]
    source_internal_lookup: Optional[MappingLookup]
    internal_lookups: Mapping[str, Optional[MappingLookup]]
    raw_id_inspection: RawIdInspection


@dataclass(frozen=True)
class ValidatedMigrationMetadata:
    legacy_complete: Optional[bool] = None
    canonical_email_recipe_user_id: Optional[str] = None
    original_rownd_user_id: Optional[str] = None


@dataclass(frozen=True)
class MigrationMetadataState:
    valid: bool
    value: Optional[ValidatedMigrationMetadata] = None


class CanonicalEmailPointerStatus(str, Enum):
    ABSENT = "ABSENT"
    VALID = "VALID"
    INVALID = "INVALID"


@dataclass(frozen=True)
class CanonicalEmailPointerState:
    status: CanonicalEmailPointerStatus
    recipe_user_id: Optional[str] = None
    reason: Optional[str] = None


class MigrationTargetSource(str, Enum):
    MAPPING = "mapping"
    RAW_ID = "raw_id"
    THIRD_PARTY = "third_party"
    VERIFIED_PASSWORDLESS = "verified_passwordless"
    NEW_IMPORT = "new_import"


class MigrationMutationType(str, Enum):
    IMPORT_USER = "IMPORT_USER"
    CREATE_MAPPING = "CREATE_MAPPING"
    MAKE_PRIMARY = "MAKE_PRIMARY"
    CREATE_IDENTITY = "CREATE_IDENTITY"
    LINK_IDENTITY = "LINK_IDENTITY"
    VERIFY_IDENTITY = "VERIFY_IDENTITY"
    WRITE_METADATA = "WRITE_METADATA"


@dataclass(frozen=True)
class PinnedMigrationTarget:
    user_id: str
    source: MigrationTargetSource


@dataclass(frozen=True)
class MigrationUserState:
    exists: bool
    is_primary_user: bool


@dataclass(frozen=True)
class MigrationSnapshot:
    source: RowndIdentitySnapshot
    owners: Tuple[IdentityOwner, ...]
    reservation_owners: Tuple[IdentityReservationOwner, ...]
    mapping: MappingState
    users: Mapping[str, MigrationUserState]
    metadata: Mapping[str, MigrationMetadataState]
    metadata_source_user_ids: Mapping[str, str]
    canonical_email_pointers: Mapping[str, CanonicalEmailPointerState]


@dataclass(frozen=True)
class MigrationMutation:
    type: str
    target_user_id: Optional[str] = None
    identity: Optional[ExpectedIdentity] = None
    recipe_user_id: Optional[str] = None


class MigrationDispositionStatus(str, Enum):
    COMPLETE = "COMPLETE"
    REPAIRABLE = "REPAIRABLE"
    BLOCKED = "BLOCKED"


@dataclass(frozen=True)
class MigrationDisposition:
    status: MigrationDispositionStatus
    target: Optional[PinnedMigrationTarget] = None
    reason: Optional[MigrationErrorReason] = None
    mutations: Tuple[MigrationMutation, ...] = ()
    blocked_identity_type: Optional[str] = None


_MISSING = object()


def _normalize_email(value: object) -> Optional[str]:
    if not isinstance(value, str):
        return None
    normalized = value.strip().lower()
    return normalized or None


def _normalize_phone(value: object) -> Optional[str]:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    digits = normalized[1:]
    if (
        not normalized.startswith("+")
        or not 2 <= len(digits) <= 15
        or digits[0] == "0"
        or any(character < "0" or character > "9" for character in digits)
    ):
        return None
    return normalized


def _verified_contact(value: object, verification: object, normalizer) -> Optional[str]:
    if value is _MISSING:
        if verification is True or isinstance(verification, str):
            raise MigrationError(MigrationErrorReason.SOURCE_IDENTITY_INVALID, "source_normalize")
        return None
    # Final Node parity validates every present contact before deciding whether it is authoritative.
    normalized = normalizer(value)
    normalized_verification = normalizer(verification) if isinstance(verification, str) else None
    if not normalized or (
        isinstance(verification, str) and normalized_verification != normalized
    ):
        raise MigrationError(MigrationErrorReason.SOURCE_IDENTITY_INVALID, "source_normalize")
    return normalized if verification is True or isinstance(verification, str) else None


def create_rownd_identity_snapshot(
    rownd_user: JsonDict,
    tenant_id: str,
    app_variant_id: Optional[str] = None,
    schema: Optional[RowndSchema] = None,
) -> RowndIdentitySnapshot:
    data = rownd_user.get("data")
    verified_data = rownd_user.get("verified_data")
    if not isinstance(data, dict) or not isinstance(verified_data, dict):
        raise MigrationError(MigrationErrorReason.SOURCE_IDENTITY_INVALID, "source_normalize")
    rownd_user_id = data.get("user_id")
    if not isinstance(rownd_user_id, str) or not rownd_user_id.strip():
        raise MigrationError(MigrationErrorReason.SOURCE_IDENTITY_INVALID, "source_normalize")

    verified_email = _verified_contact(
        data.get("email", _MISSING), verified_data.get("email", _MISSING), _normalize_email
    )
    verified_phone = _verified_contact(
        data.get("phone_number", _MISSING),
        verified_data.get("phone_number", _MISSING),
        _normalize_phone,
    )

    identities = []
    for provider_id, field in (("apple", "apple_id"), ("google", "google_id")):
        verification = verified_data.get(field, _MISSING)
        if field not in data:
            if verification is True or isinstance(verification, str):
                raise MigrationError(MigrationErrorReason.SOURCE_IDENTITY_INVALID, "source_normalize")
            if verification is not _MISSING and verification is not False:
                raise MigrationError(MigrationErrorReason.SOURCE_IDENTITY_INVALID, "source_normalize")
            continue
        provider_user_id = data[field]
        if not isinstance(provider_user_id, str) or not provider_user_id.strip():
            raise MigrationError(MigrationErrorReason.SOURCE_IDENTITY_INVALID, "source_normalize")
        if verification is not _MISSING and not isinstance(verification, (bool, str)):
            raise MigrationError(MigrationErrorReason.SOURCE_IDENTITY_INVALID, "source_normalize")
        normalized_provider_user_id = provider_user_id.strip()
        normalized_verification = verification.strip() if isinstance(verification, str) else None
        if isinstance(verification, str) and normalized_verification != normalized_provider_user_id:
            raise MigrationError(MigrationErrorReason.SOURCE_IDENTITY_INVALID, "source_normalize")
        if verification is True or isinstance(verification, str):
            identities.append(
                ExpectedIdentity(
                    key="thirdparty:%s:%s" % (provider_id, normalized_provider_user_id),
                    recipe_id="thirdparty",
                    provider_id=provider_id,
                    provider_user_id=normalized_provider_user_id,
                )
            )
    if verified_email:
        identities.append(
            ExpectedIdentity(
                key="passwordless:email:%s" % verified_email,
                recipe_id="passwordless",
                identifier_type="email",
                identifier=verified_email,
            )
        )
    if verified_phone:
        identities.append(
            ExpectedIdentity(
                key="passwordless:phone:%s" % verified_phone,
                recipe_id="passwordless",
                identifier_type="phone",
                identifier=verified_phone,
            )
        )
    identities.sort(key=lambda identity: identity.key)

    return RowndIdentitySnapshot(
        rownd_user_id=rownd_user_id,
        expected_identities=tuple(identities),
        tenant_id=tenant_id,
        app_variant_id=app_variant_id,
    )


def validate_migration_metadata(
    metadata: object, tenant_id: str = "public"
) -> MigrationMetadataState:
    if not isinstance(metadata, dict):
        return MigrationMetadataState(False)
    legacy = metadata.get("rownd_migration_complete", _MISSING)
    if legacy is not _MISSING and not isinstance(legacy, bool):
        return MigrationMetadataState(False)
    legacy_canonical = metadata.get("rownd_email_recipe_user_id", _MISSING)
    if legacy_canonical is not _MISSING and (
        not isinstance(legacy_canonical, str) or not legacy_canonical
    ):
        return MigrationMetadataState(False)
    scoped = metadata.get("rownd_email_recipe_user_ids", _MISSING)
    if scoped is not _MISSING and (
        not isinstance(scoped, dict)
        or any(not isinstance(value, str) or not value for value in scoped.values())
    ):
        return MigrationMetadataState(False)
    canonical = (
        scoped.get(tenant_id)
        if isinstance(scoped, dict)
        else legacy_canonical
        if isinstance(legacy_canonical, str)
        else None
    )
    original = metadata.get("original_rownd_user", _MISSING)
    original_id = None
    if original is not _MISSING:
        original_data = original.get("data") if isinstance(original, dict) else None
        original_id = original_data.get("user_id") if isinstance(original_data, dict) else None
        if not isinstance(original_id, str) or not original_id:
            return MigrationMetadataState(False)
    return MigrationMetadataState(
        True,
        ValidatedMigrationMetadata(
            legacy_complete=legacy if isinstance(legacy, bool) else None,
            canonical_email_recipe_user_id=canonical if isinstance(canonical, str) else None,
            original_rownd_user_id=original_id if isinstance(original_id, str) else None,
        ),
    )


_T = TypeVar("_T")


def immutable_mapping(values: Mapping[str, _T]) -> Mapping[str, _T]:
    return MappingProxyType(dict(values))


def _blocked(
    reason: MigrationErrorReason,
    target: Optional[PinnedMigrationTarget] = None,
    blocked_identity_type: Optional[str] = None,
) -> MigrationDisposition:
    return MigrationDisposition(
        MigrationDispositionStatus.BLOCKED,
        target=target,
        reason=reason,
        blocked_identity_type=blocked_identity_type,
    )


def _diagnostic_identity_type(identity: ExpectedIdentity) -> str:
    if identity.recipe_id == "thirdparty":
        return "thirdparty"
    return "passwordless_%s" % identity.identifier_type


def _mapping_consistent(snapshot: MigrationSnapshot) -> Optional[bool]:
    mapping = snapshot.mapping
    source = snapshot.source
    if any(
        lookup is not None and lookup.supertokens_user_id != user_id
        for user_id, lookup in mapping.internal_lookups.items()
    ):
        return None
    if mapping.external_lookup and mapping.external_lookup.external_user_id != source.rownd_user_id:
        return None
    if (
        mapping.source_internal_lookup
        and mapping.source_internal_lookup.supertokens_user_id != source.rownd_user_id
    ):
        return None
    candidates = {owner.primary_user_id for owner in snapshot.owners}
    if mapping.raw_id_inspection.status is RawIdStatus.PRESENT and mapping.raw_id_inspection.user_id:
        candidates.add(mapping.raw_id_inspection.user_id)
    if any(user_id not in mapping.internal_lookups for user_id in candidates):
        return None
    source_mapped_ids = {
        user_id
        for user_id, lookup in mapping.internal_lookups.items()
        if lookup is not None and lookup.external_user_id == source.rownd_user_id
    }
    if mapping.external_lookup:
        if mapping.source_internal_lookup and (
            mapping.external_lookup.supertokens_user_id != source.rownd_user_id
            or mapping.source_internal_lookup.external_user_id != source.rownd_user_id
        ):
            return None
        if mapping.raw_id_inspection.status is not RawIdStatus.UNINSPECTABLE:
            return None
        reverse = mapping.internal_lookups.get(mapping.external_lookup.supertokens_user_id)
        if not reverse or (
            reverse.external_user_id != source.rownd_user_id
            or reverse.supertokens_user_id != mapping.external_lookup.supertokens_user_id
        ):
            return None
        if source_mapped_ids != {mapping.external_lookup.supertokens_user_id}:
            return None
        return True
    if (
        mapping.raw_id_inspection.status is RawIdStatus.UNINSPECTABLE
        or mapping.source_internal_lookup
        or source_mapped_ids
    ):
        return None
    return False


def classify_migration_snapshot(
    snapshot: MigrationSnapshot, pinned_target: Optional[PinnedMigrationTarget] = None
) -> MigrationDisposition:
    source = snapshot.source
    diagnostic_target = pinned_target
    if diagnostic_target is None and snapshot.mapping.external_lookup is not None:
        diagnostic_target = PinnedMigrationTarget(
            snapshot.mapping.external_lookup.supertokens_user_id,
            MigrationTargetSource.MAPPING,
        )
    mapping_exact = _mapping_consistent(snapshot)
    if mapping_exact is None:
        return _blocked(MigrationErrorReason.MAPPING_CONFLICT, diagnostic_target)
    owners_by_identity = {
        identity.key: tuple(owner for owner in snapshot.owners if owner.identity_key == identity.key)
        for identity in source.expected_identities
    }
    ambiguous_identity = next(
        (
            identity
            for identity in source.expected_identities
            if len(
                {
                    owner.primary_user_id
                    for owner in owners_by_identity[identity.key]
                }
            )
            > 1
        ),
        None,
    )
    if ambiguous_identity is not None:
        return _blocked(
            MigrationErrorReason.IDENTITY_AMBIGUOUS,
            diagnostic_target,
            blocked_identity_type=_diagnostic_identity_type(ambiguous_identity),
        )
    passwordless_owner_ids = {
        owner.primary_user_id for owner in snapshot.owners if owner.recipe_id == "passwordless"
    }
    if len(passwordless_owner_ids) > 1:
        passwordless_owner = next(
            owner for owner in snapshot.owners if owner.recipe_id == "passwordless"
        )
        identity = next(
            item
            for item in source.expected_identities
            if item.key == passwordless_owner.identity_key
        )
        return _blocked(
            MigrationErrorReason.IDENTITY_AMBIGUOUS,
            diagnostic_target,
            _diagnostic_identity_type(identity),
        )

    authoritative_target = None
    if snapshot.mapping.external_lookup:
        authoritative_target = PinnedMigrationTarget(
            snapshot.mapping.external_lookup.supertokens_user_id, MigrationTargetSource.MAPPING
        )
        if not snapshot.users.get(
            authoritative_target.user_id, MigrationUserState(False, False)
        ).exists:
            return _blocked(MigrationErrorReason.MAPPING_CONFLICT, authoritative_target)
    elif snapshot.mapping.raw_id_inspection.status is RawIdStatus.PRESENT:
        raw = snapshot.mapping.raw_id_inspection
        if not raw.same_identity_graph:
            return _blocked(MigrationErrorReason.RAW_USER_ID_COLLISION)
        authoritative_target = PinnedMigrationTarget(
            raw.user_id or source.rownd_user_id, MigrationTargetSource.RAW_ID
        )
    if (
        pinned_target
        and authoritative_target
        and pinned_target.user_id != authoritative_target.user_id
    ):
        return _blocked(MigrationErrorReason.MAPPING_CONFLICT, pinned_target)
    target = pinned_target or authoritative_target
    if target is None:
        third_party_owner_ids = {
            owner.primary_user_id
            for owner in snapshot.owners
            if owner.recipe_id == "thirdparty"
        }
        if len(third_party_owner_ids) > 1:
            return _blocked(
                MigrationErrorReason.IDENTITY_AMBIGUOUS,
                blocked_identity_type="thirdparty",
            )
        owner_target = next(
            (
                owner
                for recipe_id in ("thirdparty", "passwordless")
                for identity in source.expected_identities
                for owner in owners_by_identity[identity.key]
                if owner.recipe_id == recipe_id
            ),
            None,
        )
        if owner_target:
            target = PinnedMigrationTarget(
                owner_target.primary_user_id,
                MigrationTargetSource.THIRD_PARTY
                if owner_target.recipe_id == "thirdparty"
                else MigrationTargetSource.VERIFIED_PASSWORDLESS,
            )
    primary_reservations = [owner for owner in snapshot.reservation_owners if owner.is_primary_user]
    if not target and primary_reservations:
        return _blocked(MigrationErrorReason.IDENTITY_OWNED_BY_ANOTHER_USER)
    if not target:
        return MigrationDisposition(
            MigrationDispositionStatus.REPAIRABLE,
            mutations=(MigrationMutation("IMPORT_USER"),),
        )
    if not snapshot.users.get(target.user_id, MigrationUserState(False, False)).exists:
        return _blocked(MigrationErrorReason.MAPPING_CONFLICT, target)
    if target.user_id not in snapshot.mapping.internal_lookups:
        return _blocked(MigrationErrorReason.MAPPING_CONFLICT, target)
    internal = snapshot.mapping.internal_lookups[target.user_id]
    if not snapshot.mapping.external_lookup and internal and internal.external_user_id == source.rownd_user_id:
        return _blocked(MigrationErrorReason.MAPPING_CONFLICT, target)
    if internal and internal.external_user_id != source.rownd_user_id:
        reason = (
            MigrationErrorReason.IDENTITY_OWNED_BY_ANOTHER_USER
            if target.source in {
                MigrationTargetSource.THIRD_PARTY,
                MigrationTargetSource.VERIFIED_PASSWORDLESS,
            }
            else MigrationErrorReason.MAPPING_CONFLICT
        )
        return _blocked(reason, target)

    for owner in snapshot.owners:
        owner_mapping = snapshot.mapping.internal_lookups.get(owner.primary_user_id)
        if owner_mapping and owner_mapping.external_user_id != source.rownd_user_id:
            identity = next(
                item for item in source.expected_identities if item.key == owner.identity_key
            )
            return _blocked(
                MigrationErrorReason.IDENTITY_OWNED_BY_ANOTHER_USER,
                target,
                _diagnostic_identity_type(identity),
            )
        owner_metadata = snapshot.metadata.get(owner.primary_user_id)
        if owner_metadata is None:
            return _blocked(MigrationErrorReason.MIGRATION_STATE_INVALID)
        if (
            owner_metadata.valid
            and owner_metadata.value
            and owner_metadata.value.original_rownd_user_id is not None
            and owner_metadata.value.original_rownd_user_id != source.rownd_user_id
        ):
            identity = next(
                item for item in source.expected_identities if item.key == owner.identity_key
            )
            return _blocked(
                MigrationErrorReason.IDENTITY_OWNED_BY_ANOTHER_USER,
                target,
                _diagnostic_identity_type(identity),
            )
        if owner.primary_user_id != target.user_id and not owner_metadata.valid:
            return _blocked(MigrationErrorReason.MIGRATION_STATE_INVALID)
    foreign_third_party = tuple(
        owner
        for owner in snapshot.owners
        if owner.primary_user_id != target.user_id and owner.recipe_id == "thirdparty"
    )
    if any(owner.is_primary_user for owner in foreign_third_party):
        return _blocked(
            MigrationErrorReason.PRIMARY_ACCOUNT_MERGE_REQUIRED, target, "thirdparty"
        )
    foreign_passwordless = tuple(
        owner
        for owner in snapshot.owners
        if owner.primary_user_id != target.user_id and owner.recipe_id == "passwordless"
    )
    if any(
        not owner.verified
        or not any(
            identity.recipe_id == "passwordless"
            and identity.key == owner.identity_key
            and identity.identifier == owner.normalized_identifier
            for identity in source.expected_identities
        )
        for owner in foreign_passwordless
    ):
        blocked_owner = next(
            owner
            for owner in foreign_passwordless
            if not owner.verified
            or not any(
                identity.recipe_id == "passwordless"
                and identity.key == owner.identity_key
                and identity.identifier == owner.normalized_identifier
                for identity in source.expected_identities
            )
        )
        identity = next(
            item for item in source.expected_identities if item.key == blocked_owner.identity_key
        )
        return _blocked(
            MigrationErrorReason.IDENTITY_OWNED_BY_ANOTHER_USER,
            target,
            _diagnostic_identity_type(identity),
        )
    foreign_primary_passwordless = next(
        (owner for owner in foreign_passwordless if owner.is_primary_user), None
    )
    foreign_primary_reservation = next(
        (
            owner
            for owner in primary_reservations
            if owner.primary_user_id != target.user_id
        ),
        None,
    )
    if foreign_primary_passwordless or foreign_primary_reservation:
        if foreign_primary_passwordless is not None:
            blocked_key = foreign_primary_passwordless.identity_key
        else:
            assert foreign_primary_reservation is not None
            blocked_key = foreign_primary_reservation.identity_key
        identity = next(
            item for item in source.expected_identities if item.key == blocked_key
        )
        return _blocked(
            MigrationErrorReason.PRIMARY_ACCOUNT_MERGE_REQUIRED,
            target,
            _diagnostic_identity_type(identity),
        )

    metadata = snapshot.metadata.get(target.user_id)
    if metadata is None or not metadata.valid or metadata.value is None:
        return _blocked(MigrationErrorReason.MIGRATION_STATE_INVALID)
    if (
        metadata.value.original_rownd_user_id is not None
        and metadata.value.original_rownd_user_id != source.rownd_user_id
    ):
        return _blocked(MigrationErrorReason.MIGRATION_STATE_INVALID)

    prefix_mutations = []
    if target.user_id != source.rownd_user_id and not mapping_exact:
        prefix_mutations.append(MigrationMutation("CREATE_MAPPING", target_user_id=target.user_id))
    if not snapshot.users[target.user_id].is_primary_user:
        prefix_mutations.append(MigrationMutation("MAKE_PRIMARY", target_user_id=target.user_id))
    create_mutations = []
    link_mutations = []
    verify_mutations = []
    for identity in source.expected_identities:
        owners = owners_by_identity[identity.key]
        target_owner = next((owner for owner in owners if owner.primary_user_id == target.user_id), None)
        link_owner = next((owner for owner in owners if owner.primary_user_id != target.user_id), None)
        if link_owner:
            link_mutations.append(
                MigrationMutation(
                    "LINK_IDENTITY",
                    target_user_id=target.user_id,
                    recipe_user_id=link_owner.recipe_user_id,
                )
            )
        elif not target_owner:
            create_mutations.append(MigrationMutation("CREATE_IDENTITY", identity=identity))
            continue
        owner = target_owner or link_owner
        if (
            owner
            and owner.recipe_id == "passwordless"
            and identity.identifier_type == "phone"
            and not owner.verified
        ):
            return _blocked(MigrationErrorReason.MIGRATION_STATE_INVALID)
        if owner and source.tenant_id not in owner.tenant_ids:
            return _blocked(
                MigrationErrorReason.IDENTITY_OWNED_BY_ANOTHER_USER,
                target,
                _diagnostic_identity_type(identity),
            )
        if (
            owner
            and owner.recipe_id == "passwordless"
            and identity.identifier_type == "email"
            and not owner.verified
        ):
            verify_mutations.append(
                MigrationMutation("VERIFY_IDENTITY", recipe_user_id=owner.recipe_user_id)
            )

    mutations = [
        *prefix_mutations,
        *create_mutations,
        *link_mutations,
        *verify_mutations,
    ]

    metadata_matches = (
        metadata.value.legacy_complete is True
        and metadata.value.original_rownd_user_id == source.rownd_user_id
    )
    verified_email = next(
        (
            identity.identifier
            for identity in source.expected_identities
            if identity.recipe_id == "passwordless"
            and identity.identifier_type == "email"
        ),
        None,
    )
    email_owner = next(
        (
            owner
            for owner in snapshot.owners
            if verified_email
            and owner.identity_key == "passwordless:email:%s" % verified_email
            and owner.primary_user_id == target.user_id
        ),
        None,
    )
    pointer = snapshot.canonical_email_pointers.get(target.user_id)
    if pointer is None:
        return _blocked(MigrationErrorReason.MIGRATION_STATE_INVALID)
    email_matches = not verified_email or bool(
        email_owner
        and email_owner.verified
        and pointer.status is CanonicalEmailPointerStatus.VALID
        and pointer.recipe_user_id == email_owner.recipe_user_id
    )
    if pointer.status is CanonicalEmailPointerStatus.INVALID and not verified_email:
        return _blocked(MigrationErrorReason.MIGRATION_STATE_INVALID)
    if mutations or not metadata_matches or not email_matches:
        mutations.append(MigrationMutation("WRITE_METADATA", target_user_id=target.user_id))
    return MigrationDisposition(
        MigrationDispositionStatus.REPAIRABLE if mutations else MigrationDispositionStatus.COMPLETE,
        target=target,
        mutations=tuple(mutations),
    )

from __future__ import annotations

from types import SimpleNamespace
from typing import Any, Optional, cast

import httpx
import pytest
from supertokens_python.interfaces import (
    CreateUserIdMappingOkResult,
    GetUserIdMappingOkResult,
    UserIdMappingAlreadyExistsError,
)
from supertokens_python.types import RecipeUserId

import supertokens_rownd.supertokens_repository as repository
from supertokens_rownd.errors import MigrationError, MigrationErrorReason
from supertokens_rownd.migration import (
    CanonicalEmailPointerState,
    CanonicalEmailPointerStatus,
    IdentityOwner,
    IdentityReservationOwner,
    MappingLookup,
    MappingState,
    MigrationDisposition,
    MigrationDispositionStatus,
    MigrationMetadataState,
    MigrationSnapshot,
    MigrationMutation,
    MigrationTargetSource,
    MigrationUserState,
    PinnedMigrationTarget,
    RawIdInspection,
    RawIdStatus,
    ValidatedMigrationMetadata,
    classify_migration_snapshot,
    create_rownd_identity_snapshot,
    immutable_mapping,
    validate_migration_metadata,
)
from supertokens_rownd.types import JsonDict, RowndSchema


PHONE_SCHEMA: RowndSchema = {"phone_number": {"type": "string"}}


def source(**data: Any):
    verified_data = {
        key: True for key in ("email", "phone_number", "google_id", "apple_id") if key in data
    }
    return create_rownd_identity_snapshot(
        cast(
            JsonDict,
            {
                "state": "enabled",
                "data": {"user_id": "rownd-1", **data},
                "verified_data": verified_data,
            },
        ),
        "tenant-a",
        "variant-a",
        PHONE_SCHEMA,
    )


def valid_metadata(identity_source) -> MigrationMetadataState:
    return MigrationMetadataState(
        True,
        ValidatedMigrationMetadata(
            legacy_complete=True,
            original_rownd_user_id=identity_source.rownd_user_id,
        ),
    )


def owner(
    identity_key: str,
    user_id: str,
    *,
    recipe_user_id: str = "recipe",
    recipe_id: Optional[str] = None,
    verified: bool = True,
    tenant_ids: tuple[str, ...] = ("tenant-a",),
    is_primary: bool = True,
) -> IdentityOwner:
    effective_recipe = recipe_id or (
        "thirdparty" if identity_key.startswith("thirdparty") else "passwordless"
    )
    return IdentityOwner(
        identity_key,
        recipe_user_id,
        user_id,
        effective_recipe,
        identity_key.split(":", 2)[-1],
        verified,
        tenant_ids,
        is_primary,
    )


def login_method(
    recipe_user_id: str,
    recipe_id: str,
    *,
    provider_id: Optional[str] = None,
    provider_user_id: Optional[str] = None,
    email: Optional[str] = None,
    verified: bool = True,
    tenant_ids: tuple[str, ...] = ("tenant-a",),
) -> Any:
    return SimpleNamespace(
        recipe_id=recipe_id,
        recipe_user_id=SimpleNamespace(get_as_string=lambda: recipe_user_id),
        third_party=(
            SimpleNamespace(id=provider_id, user_id=provider_user_id) if provider_id else None
        ),
        email=email,
        phone_number=None,
        verified=verified,
        tenant_ids=list(tenant_ids),
        has_same_email_as=lambda value: (
            email is not None and value is not None and email.lower() == value.lower()
        ),
        has_same_phone_number_as=lambda value: False,
    )


def sdk_user(user_id: str, methods: list[Any], *, primary: bool = True) -> Any:
    return SimpleNamespace(id=user_id, is_primary_user=primary, login_methods=methods)


def snapshot(
    *,
    identity_source=None,
    owners: tuple[IdentityOwner, ...] = (),
    reservations: tuple[IdentityReservationOwner, ...] = (),
    external_target: Optional[str] = None,
    raw_user_id: Optional[str] = None,
    raw_same_graph: bool = False,
    users: Optional[dict[str, MigrationUserState]] = None,
    metadata: Optional[dict[str, MigrationMetadataState]] = None,
    pointers: Optional[dict[str, CanonicalEmailPointerState]] = None,
    internal: Optional[dict[str, Optional[MappingLookup]]] = None,
) -> MigrationSnapshot:
    identity_source = identity_source or source()
    candidate_ids = {
        *(owner.primary_user_id for owner in owners),
        *(reservation.primary_user_id for reservation in reservations),
        *([external_target] if external_target else []),
        *([raw_user_id] if raw_user_id else []),
    }
    internal_lookups = (
        internal
        if internal is not None
        else {
            user_id: (
                MappingLookup(identity_source.rownd_user_id, user_id)
                if external_target == user_id
                else None
            )
            for user_id in candidate_ids
        }
    )
    metadata_states = {
        user_id: MigrationMetadataState(True, ValidatedMigrationMetadata())
        for user_id in candidate_ids
    }
    metadata_states.update(metadata or {})
    pointer_states = {
        user_id: CanonicalEmailPointerState(CanonicalEmailPointerStatus.ABSENT)
        for user_id in candidate_ids
    }
    pointer_states.update(pointers or {})
    return MigrationSnapshot(
        identity_source,
        owners,
        reservations,
        MappingState(
            MappingLookup(identity_source.rownd_user_id, external_target)
            if external_target
            else None,
            None,
            immutable_mapping(internal_lookups),
            RawIdInspection(
                RawIdStatus.UNINSPECTABLE
                if external_target
                else RawIdStatus.PRESENT
                if raw_user_id
                else RawIdStatus.ABSENT,
                raw_user_id,
                raw_same_graph,
            ),
        ),
        immutable_mapping(
            users or {user_id: MigrationUserState(True, True) for user_id in candidate_ids}
        ),
        immutable_mapping(metadata_states),
        immutable_mapping({user_id: user_id for user_id in candidate_ids}),
        immutable_mapping(pointer_states),
    )


def test_snapshot_normalizes_only_verified_account_identities() -> None:
    identity_source = create_rownd_identity_snapshot(
        {
            "state": "enabled",
            "data": {
                "user_id": "rownd-1",
                "email": " User@Example.COM ",
                "phone_number": "+442079460018",
                "google_id": " google-user ",
                "apple_id": "apple-user",
                "first_name": "Mutable",
            },
            "verified_data": {
                "email": "USER@example.com",
                "phone_number": True,
                "google_id": "google-user",
                "apple_id": True,
            },
        },
        "tenant-a",
        "variant-a",
        PHONE_SCHEMA,
    )

    assert [item.key for item in identity_source.expected_identities] == [
        "passwordless:email:user@example.com",
        "passwordless:phone:+442079460018",
        "thirdparty:apple:apple-user",
        "thirdparty:google:google-user",
    ]

    equivalent = create_rownd_identity_snapshot(
        {
            "state": "enabled",
            "data": {
                "first_name": "Changed",
                "google_id": "google-user",
                "user_id": "rownd-1",
                "apple_id": "apple-user",
                "phone_number": "+442079460018",
                "email": "user@example.com",
            },
            "verified_data": {
                "phone_number": True,
                "email": True,
                "google_id": True,
                "apple_id": "apple-user",
            },
        },
        "tenant-a",
        "variant-a",
        PHONE_SCHEMA,
    )
    assert equivalent == identity_source

    changed_scope = create_rownd_identity_snapshot(
        {
            "data": {"user_id": "rownd-1"},
            "verified_data": {},
        },
        "tenant-b",
        "variant-b",
    )
    assert changed_scope != identity_source


def test_valid_unverified_contacts_are_not_authoritative() -> None:
    identity_source = create_rownd_identity_snapshot(
        {
            "state": "enabled",
            "data": {
                "user_id": "rownd-1",
                "email": " User@Example.com ",
                "phone_number": "+442079460018",
            },
            "verified_data": {"email": False, "phone_number": False},
        },
        "public",
        schema=PHONE_SCHEMA,
    )
    assert identity_source.expected_identities == ()


def test_valid_unverified_providers_are_not_authoritative() -> None:
    identity_source = create_rownd_identity_snapshot(
        {
            "data": {
                "user_id": "rownd-1",
                "google_id": "google-user",
                "apple_id": "apple-user",
            },
            "verified_data": {"google_id": False},
        },
        "public",
    )
    assert identity_source.expected_identities == ()


def test_verified_phone_is_included_without_schema_declaration() -> None:
    identity_source = create_rownd_identity_snapshot(
        {
            "data": {"user_id": "rownd-1", "phone_number": "+442079460018"},
            "verified_data": {"phone_number": True},
        },
        "public",
    )
    assert [identity.key for identity in identity_source.expected_identities] == [
        "passwordless:phone:+442079460018"
    ]


@pytest.mark.parametrize(
    ("field", "verification"),
    [
        ("email", True),
        ("email", "user@example.com"),
        ("phone_number", True),
        ("phone_number", "+442079460018"),
        ("google_id", True),
        ("google_id", "google-user"),
        ("apple_id", True),
        ("apple_id", "apple-user"),
    ],
)
def test_authoritative_evidence_without_source_value_fails_closed(
    field: str, verification: Any
) -> None:
    with pytest.raises(MigrationError) as error:
        create_rownd_identity_snapshot(
            {
                "data": {"user_id": "rownd-1"},
                "verified_data": {field: verification},
            },
            "public",
        )
    assert error.value.reason is MigrationErrorReason.SOURCE_IDENTITY_INVALID
    assert error.value.stage == "source_normalize"


@pytest.mark.parametrize("verification", [None, 1, {}, []])
def test_malformed_provider_verification_evidence_fails_closed(
    verification: Any,
) -> None:
    with pytest.raises(MigrationError) as error:
        create_rownd_identity_snapshot(
            {
                "data": {"user_id": "rownd-1", "google_id": "google-user"},
                "verified_data": {"google_id": verification},
            },
            "public",
        )
    assert error.value.reason is MigrationErrorReason.SOURCE_IDENTITY_INVALID


@pytest.mark.parametrize(
    "profile",
    [
        {},
        {"data": {"user_id": "rownd-1"}},
        {"data": {"user_id": 1}, "verified_data": {}},
        {"data": {"user_id": "rownd-1", "google_id": ""}, "verified_data": {}},
        {
            "data": {"user_id": "rownd-1", "google_id": "google-1"},
            "verified_data": {"google_id": "google-2"},
        },
        {"data": {"user_id": "rownd-1", "email": 1}, "verified_data": {}},
        {
            "data": {"user_id": "rownd-1", "email": "a@example.com"},
            "verified_data": {"email": "b@example.com"},
        },
        {
            "data": {"user_id": "rownd-1", "phone_number": "555-0100"},
            "verified_data": {"phone_number": False},
        },
        {
            "data": {"user_id": "rownd-1", "phone_number": "+1202555012345678"},
            "verified_data": {"phone_number": False},
        },
    ],
)
def test_malformed_identity_source_fails_closed(profile: JsonDict) -> None:
    with pytest.raises(MigrationError) as error:
        create_rownd_identity_snapshot(profile, "public", schema=PHONE_SCHEMA)
    assert error.value.reason is MigrationErrorReason.SOURCE_IDENTITY_INVALID
    assert error.value.stage == "source_normalize"


def test_metadata_validation_is_strict_and_tenant_scoped() -> None:
    valid = validate_migration_metadata(
        {
            "rownd_migration_complete": True,
            "rownd_migration": None,
            "rownd_email_recipe_user_id": "legacy",
            "rownd_email_recipe_user_ids": {"tenant-b": "tenant-b-recipe"},
        },
        "tenant-a",
    )
    assert valid.valid
    assert valid.value is not None
    assert valid.value.canonical_email_recipe_user_id is None
    assert not validate_migration_metadata({"rownd_migration_complete": "true"}).valid
    assert validate_migration_metadata({"rownd_migration": None}).valid


@pytest.mark.parametrize(
    "metadata",
    [
        {"rownd_migration_complete": None},
        {"rownd_email_recipe_user_id": None},
        {"rownd_email_recipe_user_ids": None},
        {"original_rownd_user": None},
        {"original_rownd_user": {"data": {"user_id": None}}},
    ],
)
def test_explicit_null_migration_metadata_is_invalid(metadata: JsonDict) -> None:
    assert not validate_migration_metadata(metadata).valid


def test_absent_optional_migration_metadata_is_valid() -> None:
    state = validate_migration_metadata({})
    assert state.valid
    assert state.value == ValidatedMigrationMetadata()


@pytest.mark.parametrize(
    ("state", "source_type", "target_id"),
    [
        (snapshot(external_target="mapped"), MigrationTargetSource.MAPPING, "mapped"),
        (
            snapshot(raw_user_id="rownd-1", raw_same_graph=True),
            MigrationTargetSource.RAW_ID,
            "rownd-1",
        ),
        (
            snapshot(
                identity_source=source(google_id="g"),
                owners=(owner("thirdparty:google:g", "provider"),),
            ),
            MigrationTargetSource.THIRD_PARTY,
            "provider",
        ),
        (
            snapshot(
                identity_source=source(email="a@example.com"),
                owners=(owner("passwordless:email:a@example.com", "email"),),
            ),
            MigrationTargetSource.VERIFIED_PASSWORDLESS,
            "email",
        ),
    ],
)
def test_canonical_target_selection_order(state, source_type, target_id) -> None:
    result = classify_migration_snapshot(state)
    assert result.status is MigrationDispositionStatus.REPAIRABLE
    assert result.target == PinnedMigrationTarget(target_id, source_type)


def test_third_party_owner_precedes_passwordless_owner() -> None:
    identity_source = source(email="user@example.com", google_id="google-user")
    result = classify_migration_snapshot(
        snapshot(
            identity_source=identity_source,
            owners=(
                owner(
                    "passwordless:email:user@example.com",
                    "email-owner",
                    recipe_user_id="email-recipe",
                    is_primary=False,
                ),
                owner(
                    "thirdparty:google:google-user",
                    "google-owner",
                    recipe_user_id="google-recipe",
                ),
            ),
        )
    )

    assert result.status is MigrationDispositionStatus.REPAIRABLE
    assert result.target == PinnedMigrationTarget("google-owner", MigrationTargetSource.THIRD_PARTY)
    assert any(
        mutation.type == "LINK_IDENTITY" and mutation.recipe_user_id == "email-recipe"
        for mutation in result.mutations
    )


def test_new_identity_graph_selects_import() -> None:
    result = classify_migration_snapshot(snapshot())
    assert result.status is MigrationDispositionStatus.REPAIRABLE
    assert [mutation.type for mutation in result.mutations] == ["IMPORT_USER"]


def test_fully_verified_mapping_requires_completion_and_canonical_state() -> None:
    identity_source = source(email="user@example.com")
    email_owner = owner(
        "passwordless:email:user@example.com", "mapped", recipe_user_id="recipe-email"
    )
    metadata = valid_metadata(identity_source)
    assert metadata.value is not None
    metadata = MigrationMetadataState(
        True,
        ValidatedMigrationMetadata(
            legacy_complete=True,
            canonical_email_recipe_user_id="recipe-email",
            original_rownd_user_id="rownd-1",
        ),
    )
    result = classify_migration_snapshot(
        snapshot(
            identity_source=identity_source,
            owners=(email_owner,),
            external_target="mapped",
            metadata={"mapped": metadata},
            pointers={
                "mapped": CanonicalEmailPointerState(
                    CanonicalEmailPointerStatus.VALID, "recipe-email"
                )
            },
        )
    )
    assert result.status is MigrationDispositionStatus.COMPLETE

    stale = classify_migration_snapshot(
        snapshot(
            identity_source=identity_source,
            owners=(email_owner,),
            external_target="mapped",
            metadata={
                "mapped": MigrationMetadataState(
                    True,
                    ValidatedMigrationMetadata(
                        legacy_complete=False,
                        original_rownd_user_id="rownd-1",
                    ),
                )
            },
            pointers={
                "mapped": CanonicalEmailPointerState(
                    CanonicalEmailPointerStatus.VALID, "recipe-email"
                )
            },
        )
    )
    assert stale.status is MigrationDispositionStatus.REPAIRABLE
    assert stale.mutations[-1].type == "WRITE_METADATA"

    missing_provenance = classify_migration_snapshot(
        snapshot(
            identity_source=identity_source,
            owners=(email_owner,),
            external_target="mapped",
            metadata={
                "mapped": MigrationMetadataState(
                    True,
                    ValidatedMigrationMetadata(
                        legacy_complete=True,
                        canonical_email_recipe_user_id="recipe-email",
                    ),
                )
            },
            pointers={
                "mapped": CanonicalEmailPointerState(
                    CanonicalEmailPointerStatus.VALID, "recipe-email"
                )
            },
        )
    )
    assert missing_provenance.status is MigrationDispositionStatus.REPAIRABLE
    assert missing_provenance.mutations[-1].type == "WRITE_METADATA"


def test_new_verified_identity_repairs_topology_before_republishing_completion() -> None:
    identity_source = source(google_id="new-google-id")
    result = classify_migration_snapshot(
        snapshot(
            identity_source=identity_source,
            external_target="mapped",
            metadata={"mapped": valid_metadata(identity_source)},
        )
    )

    assert [mutation.type for mutation in result.mutations] == [
        "CREATE_IDENTITY",
        "WRITE_METADATA",
    ]


@pytest.mark.parametrize(
    ("state", "reason"),
    [
        (
            snapshot(raw_user_id="rownd-1"),
            MigrationErrorReason.RAW_USER_ID_COLLISION,
        ),
        (
            snapshot(
                identity_source=source(google_id="g"),
                owners=(
                    owner("thirdparty:google:g", "one"),
                    owner("thirdparty:google:g", "two", recipe_user_id="recipe-2"),
                ),
            ),
            MigrationErrorReason.IDENTITY_AMBIGUOUS,
        ),
        (
            snapshot(
                external_target="mapped",
                internal={"mapped": None},
            ),
            MigrationErrorReason.MAPPING_CONFLICT,
        ),
        (
            snapshot(
                identity_source=source(google_id="g"),
                owners=(owner("thirdparty:google:g", "provider", is_primary=False),),
                internal={"provider": MappingLookup("rownd-1", "provider")},
            ),
            MigrationErrorReason.MAPPING_CONFLICT,
        ),
        (
            snapshot(
                external_target="mapped",
                metadata={"mapped": MigrationMetadataState(False)},
            ),
            MigrationErrorReason.MIGRATION_STATE_INVALID,
        ),
    ],
)
def test_contradictory_states_block(state, reason) -> None:
    result = classify_migration_snapshot(state)
    assert result.status is MigrationDispositionStatus.BLOCKED
    assert result.reason is reason
    assert result.mutations == ()


def test_distinct_passwordless_identities_with_different_owners_are_ambiguous() -> None:
    identity_source = source(email="user@example.com", phone_number="+12025550100")
    result = classify_migration_snapshot(
        snapshot(
            identity_source=identity_source,
            owners=(
                owner(
                    "passwordless:email:user@example.com",
                    "email-owner",
                    recipe_user_id="email-recipe",
                    is_primary=False,
                ),
                owner(
                    "passwordless:phone:+12025550100",
                    "phone-owner",
                    recipe_user_id="phone-recipe",
                    is_primary=False,
                ),
            ),
        )
    )

    assert result.status is MigrationDispositionStatus.BLOCKED
    assert result.reason is MigrationErrorReason.IDENTITY_AMBIGUOUS
    assert result.mutations == ()


def test_distinct_passwordless_identities_on_same_owner_are_not_ambiguous() -> None:
    identity_source = source(email="user@example.com", phone_number="+12025550100")
    result = classify_migration_snapshot(
        snapshot(
            identity_source=identity_source,
            owners=(
                owner(
                    "passwordless:email:user@example.com",
                    "contact-owner",
                    recipe_user_id="email-recipe",
                ),
                owner(
                    "passwordless:phone:+12025550100",
                    "contact-owner",
                    recipe_user_id="phone-recipe",
                ),
            ),
        )
    )

    assert result.status is MigrationDispositionStatus.REPAIRABLE
    assert result.target == PinnedMigrationTarget(
        "contact-owner", MigrationTargetSource.VERIFIED_PASSWORDLESS
    )


def test_primary_owner_cannot_displace_pinned_target() -> None:
    identity_source = source(google_id="g")
    result = classify_migration_snapshot(
        snapshot(
            identity_source=identity_source,
            owners=(owner("thirdparty:google:g", "new-owner"),),
            users={
                "new-owner": MigrationUserState(True, True),
                "pinned": MigrationUserState(True, True),
            },
            internal={"new-owner": None, "pinned": None},
            metadata={"pinned": valid_metadata(identity_source)},
            pointers={"pinned": CanonicalEmailPointerState(CanonicalEmailPointerStatus.ABSENT)},
        ),
        PinnedMigrationTarget("pinned", MigrationTargetSource.NEW_IMPORT),
    )
    assert result.status is MigrationDispositionStatus.BLOCKED
    assert result.reason is MigrationErrorReason.PRIMARY_ACCOUNT_MERGE_REQUIRED


def test_mapping_target_links_multiple_standalone_identity_owners() -> None:
    identity_source = source(apple_id="apple", google_id="google")
    result = classify_migration_snapshot(
        snapshot(
            identity_source=identity_source,
            external_target="mapped",
            owners=(
                owner(
                    "thirdparty:apple:apple",
                    "apple-owner",
                    recipe_user_id="apple-recipe",
                    is_primary=False,
                ),
                owner(
                    "thirdparty:google:google",
                    "google-owner",
                    recipe_user_id="google-recipe",
                    is_primary=False,
                ),
            ),
        )
    )
    assert result.target == PinnedMigrationTarget("mapped", MigrationTargetSource.MAPPING)
    assert [mutation.type for mutation in result.mutations] == [
        "LINK_IDENTITY",
        "LINK_IDENTITY",
        "WRITE_METADATA",
    ]


def test_pinned_target_links_multiple_standalone_identity_owners() -> None:
    identity_source = source(apple_id="apple", google_id="google")
    result = classify_migration_snapshot(
        snapshot(
            identity_source=identity_source,
            owners=(
                owner(
                    "thirdparty:apple:apple",
                    "apple-owner",
                    recipe_user_id="apple-recipe",
                    is_primary=False,
                ),
                owner(
                    "thirdparty:google:google",
                    "google-owner",
                    recipe_user_id="google-recipe",
                    is_primary=False,
                ),
            ),
            users={
                "pinned": MigrationUserState(True, True),
                "apple-owner": MigrationUserState(True, False),
                "google-owner": MigrationUserState(True, False),
            },
            internal={"pinned": None, "apple-owner": None, "google-owner": None},
            metadata={"pinned": valid_metadata(identity_source)},
            pointers={"pinned": CanonicalEmailPointerState(CanonicalEmailPointerStatus.ABSENT)},
        ),
        PinnedMigrationTarget("pinned", MigrationTargetSource.NEW_IMPORT),
    )
    assert result.target == PinnedMigrationTarget("pinned", MigrationTargetSource.NEW_IMPORT)
    assert [mutation.type for mutation in result.mutations] == [
        "CREATE_MAPPING",
        "LINK_IDENTITY",
        "LINK_IDENTITY",
        "WRITE_METADATA",
    ]


def test_mapping_target_blocks_unverified_foreign_passwordless_owner() -> None:
    identity_source = source(email="user@example.com")
    result = classify_migration_snapshot(
        snapshot(
            identity_source=identity_source,
            external_target="mapped",
            owners=(
                owner(
                    "passwordless:email:user@example.com",
                    "email-owner",
                    recipe_user_id="email-recipe",
                    verified=False,
                    is_primary=False,
                ),
            ),
        )
    )

    assert result.status is MigrationDispositionStatus.BLOCKED
    assert result.reason is MigrationErrorReason.IDENTITY_OWNED_BY_ANOTHER_USER
    assert result.mutations == ()


def test_pinned_target_must_match_authoritative_mapping() -> None:
    result = classify_migration_snapshot(
        snapshot(
            external_target="mapped",
            users={
                "mapped": MigrationUserState(True, True),
                "pinned": MigrationUserState(True, True),
            },
            internal={"mapped": MappingLookup("rownd-1", "mapped"), "pinned": None},
            metadata={"pinned": valid_metadata(source())},
            pointers={"pinned": CanonicalEmailPointerState(CanonicalEmailPointerStatus.ABSENT)},
        ),
        PinnedMigrationTarget("pinned", MigrationTargetSource.NEW_IMPORT),
    )
    assert result.status is MigrationDispositionStatus.BLOCKED
    assert result.reason is MigrationErrorReason.MAPPING_CONFLICT


def test_primary_contact_reservation_blocks_primary_merge() -> None:
    identity_source = source(email="user@example.com", google_id="g")
    result = classify_migration_snapshot(
        snapshot(
            identity_source=identity_source,
            owners=(owner("thirdparty:google:g", "provider"),),
            reservations=(
                IdentityReservationOwner(
                    "passwordless:email:user@example.com",
                    "emailpassword-recipe",
                    "password-owner",
                    "emailpassword",
                    True,
                ),
            ),
        )
    )
    assert result.status is MigrationDispositionStatus.BLOCKED
    assert result.reason is MigrationErrorReason.PRIMARY_ACCOUNT_MERGE_REQUIRED


def test_unverified_phone_owner_is_invalid_but_email_is_repairable() -> None:
    phone_source = source(phone_number="+12025550100")
    phone_result = classify_migration_snapshot(
        snapshot(
            identity_source=phone_source,
            owners=(
                owner(
                    "passwordless:phone:+12025550100",
                    "phone",
                    verified=False,
                ),
            ),
        )
    )
    assert phone_result.reason is MigrationErrorReason.MIGRATION_STATE_INVALID

    email_source = source(email="user@example.com")
    email_result = classify_migration_snapshot(
        snapshot(
            identity_source=email_source,
            owners=(
                owner(
                    "passwordless:email:user@example.com",
                    "email",
                    verified=False,
                ),
            ),
        )
    )
    assert email_result.status is MigrationDispositionStatus.REPAIRABLE
    assert "VERIFY_IDENTITY" in [mutation.type for mutation in email_result.mutations]


def test_missing_tenant_membership_is_an_explicit_repair() -> None:
    identity_source = source(google_id="g")
    result = classify_migration_snapshot(
        snapshot(
            identity_source=identity_source,
            owners=(
                owner(
                    "thirdparty:google:g",
                    "provider",
                    recipe_user_id="provider-recipe",
                    tenant_ids=(),
                ),
            ),
        )
    )
    assert result.status is MigrationDispositionStatus.REPAIRABLE
    assert any(
        mutation.type == "ASSOCIATE_TENANT"
        and mutation.recipe_user_id == "provider-recipe"
        and mutation.tenant_id == "tenant-a"
        for mutation in result.mutations
    )
    assert result.mutations[-1].type == "WRITE_METADATA"


def test_mixed_repair_plan_has_stable_global_mutation_order() -> None:
    identity_source = source(
        email="user@example.com",
        phone_number="+12025550100",
        apple_id="apple",
        google_id="google",
    )
    result = classify_migration_snapshot(
        snapshot(
            identity_source=identity_source,
            owners=(
                owner(
                    "passwordless:email:user@example.com",
                    "email-owner",
                    recipe_user_id="email-recipe",
                    verified=True,
                    tenant_ids=(),
                    is_primary=False,
                ),
                owner(
                    "thirdparty:google:google",
                    "pinned",
                    recipe_user_id="google-recipe",
                    tenant_ids=(),
                    is_primary=False,
                ),
            ),
            users={
                "pinned": MigrationUserState(True, False),
                "email-owner": MigrationUserState(True, False),
            },
            internal={"pinned": None, "email-owner": None},
            metadata={"pinned": valid_metadata(identity_source)},
            pointers={"pinned": CanonicalEmailPointerState(CanonicalEmailPointerStatus.ABSENT)},
        ),
        PinnedMigrationTarget("pinned", MigrationTargetSource.NEW_IMPORT),
    )
    assert [mutation.type for mutation in result.mutations] == [
        "CREATE_MAPPING",
        "MAKE_PRIMARY",
        "CREATE_IDENTITY",
        "CREATE_IDENTITY",
        "LINK_IDENTITY",
        "ASSOCIATE_TENANT",
        "ASSOCIATE_TENANT",
        "WRITE_METADATA",
    ]


def test_valid_existing_canonical_email_is_retained_without_verified_source_email() -> None:
    identity_source = source()
    result = classify_migration_snapshot(
        snapshot(
            identity_source=identity_source,
            external_target="mapped",
            metadata={"mapped": valid_metadata(identity_source)},
            pointers={
                "mapped": CanonicalEmailPointerState(
                    CanonicalEmailPointerStatus.VALID, "old-email-recipe"
                )
            },
        )
    )
    assert result.status is MigrationDispositionStatus.COMPLETE
    assert result.mutations == ()


def test_invalid_canonical_pointer_blocks_when_source_cannot_select_replacement() -> None:
    result = classify_migration_snapshot(
        snapshot(
            external_target="mapped",
            pointers={
                "mapped": CanonicalEmailPointerState(
                    CanonicalEmailPointerStatus.INVALID,
                    "missing-recipe",
                    "MISSING_METHOD",
                )
            },
        )
    )
    assert result.status is MigrationDispositionStatus.BLOCKED
    assert result.reason is MigrationErrorReason.MIGRATION_STATE_INVALID
    assert result.mutations == ()


@pytest.mark.asyncio
async def test_fresh_repository_inspection_clears_cache_and_reads_both_mappings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    identity_source = source()
    contexts = []
    mapping_calls = []
    user = cast(Any, SimpleNamespace(id="mapped", is_primary_user=True, login_methods=[]))

    async def get_mapping(user_id: str, mapping_type: str, context: dict):
        contexts.append(context)
        mapping_calls.append((user_id, mapping_type))
        assert context["_default"]["coreCallCache"] == {}
        if user_id == "rownd-1" and mapping_type == "EXTERNAL":
            return GetUserIdMappingOkResult("mapped", "rownd-1")
        if user_id == "mapped" and mapping_type == "SUPERTOKENS":
            return GetUserIdMappingOkResult("mapped", "rownd-1")
        return SimpleNamespace(status="UNKNOWN_MAPPING_ERROR")

    async def get_test_user(user_id: str, context: dict):
        contexts.append(context)
        return user if user_id == "mapped" else None

    async def get_metadata(user_id: str, context: dict):
        contexts.append(context)
        return {}

    monkeypatch.setattr(repository, "get_user_id_mapping", get_mapping)
    monkeypatch.setattr(repository, "get_user", get_test_user)
    monkeypatch.setattr(repository, "get_raw_user_metadata", get_metadata)
    original_context = {"_default": {"coreCallCache": {"stale": True}}}

    result = await repository.read_fresh_migration_snapshot(
        identity_source, cast(Any, original_context)
    )

    assert ("rownd-1", "EXTERNAL") in mapping_calls
    assert ("rownd-1", "SUPERTOKENS") in mapping_calls
    assert ("mapped", "SUPERTOKENS") in mapping_calls
    assert all(context is not original_context for context in contexts)
    assert all(context is contexts[0] for context in contexts)
    assert original_context["_default"]["coreCallCache"] == {}
    assert result.mapping.external_lookup == MappingLookup("rownd-1", "mapped")
    assert result.mapping.source_internal_lookup is None
    assert result.mapping.internal_lookups == {"mapped": MappingLookup("rownd-1", "mapped")}
    assert result.mapping.raw_id_inspection.status is RawIdStatus.UNINSPECTABLE


@pytest.mark.asyncio
async def test_repository_preserves_independently_returned_mapping_contradiction(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    identity_source = source()
    mapped = sdk_user("mapped", [])

    async def get_mapping(user_id: str, mapping_type: str, context: dict):
        assert context["_default"]["coreCallCache"] == {}
        if (user_id, mapping_type) == ("rownd-1", "EXTERNAL"):
            return GetUserIdMappingOkResult("mapped", "rownd-1")
        if (user_id, mapping_type) == ("rownd-1", "SUPERTOKENS"):
            return GetUserIdMappingOkResult("rownd-1", "other-rownd-id")
        if (user_id, mapping_type) == ("mapped", "SUPERTOKENS"):
            return GetUserIdMappingOkResult("mapped", "rownd-1")
        return SimpleNamespace(status="UNKNOWN_MAPPING_ERROR")

    async def get_test_user(user_id: str, context: dict):
        return mapped if user_id == "mapped" else None

    async def get_metadata(user_id: str, context: dict):
        return {}

    monkeypatch.setattr(repository, "get_user_id_mapping", get_mapping)
    monkeypatch.setattr(repository, "get_user", get_test_user)
    monkeypatch.setattr(repository, "get_raw_user_metadata", get_metadata)

    result = await repository.read_fresh_migration_snapshot(
        identity_source, {"_default": {"coreCallCache": {"stale": True}}}
    )

    assert result.mapping.external_lookup == MappingLookup("rownd-1", "mapped")
    assert result.mapping.source_internal_lookup == MappingLookup("other-rownd-id", "rownd-1")
    assert result.mapping.raw_id_inspection == RawIdInspection(
        RawIdStatus.PRESENT, "rownd-1", False
    )
    disposition = classify_migration_snapshot(result)
    assert disposition.status is MigrationDispositionStatus.BLOCKED
    assert disposition.reason is MigrationErrorReason.MAPPING_CONFLICT


@pytest.mark.asyncio
async def test_repository_reports_unrelated_raw_id_collision(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    raw_user = sdk_user("rownd-1", [], primary=False)
    contexts = []

    async def no_mapping(user_id: str, mapping_type: str, context: dict):
        contexts.append(context)
        assert context["_default"]["coreCallCache"] == {}
        return SimpleNamespace(status="UNKNOWN_MAPPING_ERROR")

    async def get_test_user(user_id: str, context: dict):
        contexts.append(context)
        return raw_user if user_id == "rownd-1" else None

    async def get_metadata(user_id: str, context: dict):
        contexts.append(context)
        return {}

    monkeypatch.setattr(repository, "get_user_id_mapping", no_mapping)
    monkeypatch.setattr(repository, "get_user", get_test_user)
    monkeypatch.setattr(repository, "get_raw_user_metadata", get_metadata)
    original = {"_default": {"coreCallCache": {"stale": True}}}

    result = await repository.read_fresh_migration_snapshot(source(), cast(Any, original))

    assert result.mapping.raw_id_inspection == RawIdInspection(
        RawIdStatus.PRESENT, "rownd-1", False
    )
    assert all(context is contexts[0] and context is not original for context in contexts)
    assert original["_default"]["coreCallCache"] == {}


@pytest.mark.asyncio
@pytest.mark.parametrize("migration_complete", [None, False, True])
async def test_repository_requires_completed_legacy_history_for_raw_id_anchor(
    monkeypatch: pytest.MonkeyPatch, migration_complete: Optional[bool]
) -> None:
    raw_user = sdk_user("rownd-1", [], primary=False)

    async def no_mapping(user_id: str, mapping_type: str, context: dict):
        return SimpleNamespace(status="UNKNOWN_MAPPING_ERROR")

    async def get_test_user(user_id: str, context: dict):
        return raw_user if user_id == "rownd-1" else None

    async def get_metadata(user_id: str, context: dict):
        metadata: dict[str, Any] = {"original_rownd_user": {"data": {"user_id": "rownd-1"}}}
        if migration_complete is not None:
            metadata["rownd_migration_complete"] = migration_complete
        return metadata

    monkeypatch.setattr(repository, "get_user_id_mapping", no_mapping)
    monkeypatch.setattr(repository, "get_user", get_test_user)
    monkeypatch.setattr(repository, "get_raw_user_metadata", get_metadata)

    result = await repository.read_fresh_migration_snapshot(source(), {})
    assert result.mapping.raw_id_inspection.same_identity_graph is (migration_complete is True)


@pytest.mark.asyncio
async def test_repository_accepts_current_exact_identity_as_raw_id_anchor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    identity_source = source(google_id="google-1")
    method = login_method(
        "google-recipe",
        "thirdparty",
        provider_id="google",
        provider_user_id="google-1",
    )
    raw_user = sdk_user("rownd-1", [method], primary=False)

    async def no_mapping(user_id: str, mapping_type: str, context: dict):
        return SimpleNamespace(status="UNKNOWN_MAPPING_ERROR")

    async def get_test_user(user_id: str, context: dict):
        return raw_user if user_id == "rownd-1" else None

    async def no_scoped_owners(*args: Any, **kwargs: Any):
        return []

    async def get_metadata(user_id: str, context: dict):
        return {}

    monkeypatch.setattr(repository, "get_user_id_mapping", no_mapping)
    monkeypatch.setattr(repository, "get_user", get_test_user)
    monkeypatch.setattr(repository, "list_users_by_account_info", no_scoped_owners)
    monkeypatch.setattr(repository, "get_raw_user_metadata", get_metadata)

    result = await repository.read_fresh_migration_snapshot(identity_source, {})
    assert result.mapping.raw_id_inspection == RawIdInspection(RawIdStatus.PRESENT, "rownd-1", True)


@pytest.mark.asyncio
async def test_repository_scans_mapped_candidate_methods_outside_request_tenant(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    identity_source = source(email="user@example.com", google_id="google-1")
    google_method = login_method(
        "google-recipe",
        "thirdparty",
        provider_id="google",
        provider_user_id="google-1",
        tenant_ids=("tenant-b",),
    )
    emailpassword_method = login_method(
        "emailpassword-recipe",
        "emailpassword",
        email="user@example.com",
        tenant_ids=("tenant-b",),
    )
    mapped = sdk_user("mapped", [google_method, emailpassword_method])

    async def get_mapping(user_id: str, mapping_type: str, context: dict):
        if (user_id, mapping_type) == ("rownd-1", "EXTERNAL"):
            return GetUserIdMappingOkResult("mapped", "rownd-1")
        if (user_id, mapping_type) == ("mapped", "SUPERTOKENS"):
            return GetUserIdMappingOkResult("mapped", "rownd-1")
        return SimpleNamespace(status="UNKNOWN_MAPPING_ERROR")

    async def get_test_user(user_id: str, context: dict):
        return mapped if user_id == "mapped" else None

    async def no_scoped_owners(*args: Any, **kwargs: Any):
        return []

    async def get_metadata(user_id: str, context: dict):
        return {}

    monkeypatch.setattr(repository, "get_user_id_mapping", get_mapping)
    monkeypatch.setattr(repository, "get_user", get_test_user)
    monkeypatch.setattr(repository, "list_users_by_account_info", no_scoped_owners)
    monkeypatch.setattr(repository, "get_raw_user_metadata", get_metadata)

    result = await repository.read_fresh_migration_snapshot(identity_source, {})
    assert [(owner.identity_key, owner.recipe_user_id) for owner in result.owners] == [
        ("thirdparty:google:google-1", "google-recipe")
    ]
    assert [
        (reservation.identity_key, reservation.recipe_user_id)
        for reservation in result.reservation_owners
    ] == [("passwordless:email:user@example.com", "emailpassword-recipe")]
    disposition = classify_migration_snapshot(result)
    assert [
        mutation.identity.key
        for mutation in disposition.mutations
        if mutation.type == "CREATE_IDENTITY" and mutation.identity is not None
    ] == ["passwordless:email:user@example.com"]
    assert "ASSOCIATE_TENANT" in [mutation.type for mutation in disposition.mutations]


@pytest.mark.asyncio
async def test_repository_resolves_linked_identity_owner_to_internal_primary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    identity_source = source(google_id="google-1")
    method = login_method(
        "google-recipe",
        "thirdparty",
        provider_id="google",
        provider_user_id="google-1",
    )
    linked_user = sdk_user("linked-external", [method], primary=False)
    primary_user = sdk_user("primary", [method])

    async def get_mapping(user_id: str, mapping_type: str, context: dict):
        if (user_id, mapping_type) == ("linked-external", "EXTERNAL"):
            return GetUserIdMappingOkResult("primary", "linked-external")
        return SimpleNamespace(status="UNKNOWN_MAPPING_ERROR")

    async def get_test_user(user_id: str, context: dict):
        return primary_user if user_id == "primary" else None

    async def list_owners(*args: Any, **kwargs: Any):
        return [linked_user]

    async def get_metadata(user_id: str, context: dict):
        return {}

    monkeypatch.setattr(repository, "get_user_id_mapping", get_mapping)
    monkeypatch.setattr(repository, "get_user", get_test_user)
    monkeypatch.setattr(repository, "list_users_by_account_info", list_owners)
    monkeypatch.setattr(repository, "get_raw_user_metadata", get_metadata)

    result = await repository.read_fresh_migration_snapshot(identity_source, {})

    assert len(result.owners) == 1
    assert result.owners[0].recipe_user_id == "google-recipe"
    assert result.owners[0].primary_user_id == "primary"
    assert result.users["primary"] == MigrationUserState(True, True)


@pytest.mark.asyncio
async def test_repository_rejects_resolved_owner_missing_reported_method(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    identity_source = source(google_id="google-1")
    method = login_method(
        "google-recipe",
        "thirdparty",
        provider_id="google",
        provider_user_id="google-1",
    )
    linked_user = sdk_user("linked-external", [method], primary=False)
    primary_user = sdk_user("primary", [])

    async def get_mapping(user_id: str, mapping_type: str, context: dict):
        if (user_id, mapping_type) == ("linked-external", "EXTERNAL"):
            return GetUserIdMappingOkResult("primary", "linked-external")
        return SimpleNamespace(status="UNKNOWN_MAPPING_ERROR")

    async def get_test_user(user_id: str, context: dict):
        return primary_user if user_id == "primary" else None

    async def list_owners(*args: Any, **kwargs: Any):
        return [linked_user]

    monkeypatch.setattr(repository, "get_user_id_mapping", get_mapping)
    monkeypatch.setattr(repository, "get_user", get_test_user)
    monkeypatch.setattr(repository, "list_users_by_account_info", list_owners)

    with pytest.raises(MigrationError) as error:
        await repository.read_fresh_migration_snapshot(identity_source, {})
    assert error.value.reason is MigrationErrorReason.MIGRATION_STATE_INVALID
    assert error.value.stage == "state_inspect"


@pytest.mark.asyncio
async def test_repository_rejects_resolved_reservation_missing_reported_method(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    identity_source = source(email="user@example.com")
    method = login_method("emailpassword-recipe", "emailpassword", email="user@example.com")
    linked_user = sdk_user("linked-external", [method], primary=False)
    primary_user = sdk_user("primary", [])

    async def get_mapping(user_id: str, mapping_type: str, context: dict):
        if (user_id, mapping_type) == ("linked-external", "EXTERNAL"):
            return GetUserIdMappingOkResult("primary", "linked-external")
        return SimpleNamespace(status="UNKNOWN_MAPPING_ERROR")

    async def get_test_user(user_id: str, context: dict):
        return primary_user if user_id == "primary" else None

    async def list_owners(*args: Any, **kwargs: Any):
        return [linked_user]

    monkeypatch.setattr(repository, "get_user_id_mapping", get_mapping)
    monkeypatch.setattr(repository, "get_user", get_test_user)
    monkeypatch.setattr(repository, "list_users_by_account_info", list_owners)

    with pytest.raises(MigrationError) as error:
        await repository.read_fresh_migration_snapshot(identity_source, {})
    assert error.value.reason is MigrationErrorReason.MIGRATION_STATE_INVALID
    assert error.value.stage == "state_inspect"


@pytest.mark.asyncio
async def test_repository_marks_foreign_canonical_pointer_invalid(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target = sdk_user("mapped", [])
    foreign_method = login_method("foreign-recipe", "passwordless", email="foreign@example.com")
    foreign = sdk_user("foreign", [foreign_method])

    async def get_mapping(user_id: str, mapping_type: str, context: dict):
        if (user_id, mapping_type) == ("rownd-1", "EXTERNAL"):
            return GetUserIdMappingOkResult("mapped", "rownd-1")
        if (user_id, mapping_type) == ("mapped", "SUPERTOKENS"):
            return GetUserIdMappingOkResult("mapped", "rownd-1")
        return SimpleNamespace(status="UNKNOWN_MAPPING_ERROR")

    async def get_test_user(user_id: str, context: dict):
        return {"mapped": target, "foreign-recipe": foreign}.get(user_id)

    async def get_metadata(user_id: str, context: dict):
        return {"rownd_email_recipe_user_ids": {"tenant-a": "foreign-recipe"}}

    monkeypatch.setattr(repository, "get_user_id_mapping", get_mapping)
    monkeypatch.setattr(repository, "get_user", get_test_user)
    monkeypatch.setattr(repository, "get_raw_user_metadata", get_metadata)

    result = await repository.read_fresh_migration_snapshot(source(), {})

    assert result.canonical_email_pointers["mapped"] == CanonicalEmailPointerState(
        CanonicalEmailPointerStatus.INVALID,
        "foreign-recipe",
        "FOREIGN_OWNER",
    )


@pytest.mark.asyncio
async def test_repository_always_inspects_pinned_target_candidate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pinned = sdk_user("pinned", [])
    user_reads = []
    contexts = []

    async def no_mapping(user_id: str, mapping_type: str, context: dict):
        contexts.append(context)
        return SimpleNamespace(status="UNKNOWN_MAPPING_ERROR")

    async def get_test_user(user_id: str, context: dict):
        contexts.append(context)
        user_reads.append(user_id)
        return pinned if user_id == "pinned" else None

    async def get_metadata(user_id: str, context: dict):
        contexts.append(context)
        return {}

    monkeypatch.setattr(repository, "get_user_id_mapping", no_mapping)
    monkeypatch.setattr(repository, "get_user", get_test_user)
    monkeypatch.setattr(repository, "get_raw_user_metadata", get_metadata)
    original = {"_default": {"coreCallCache": {"stale": True}}}

    result = await repository.read_fresh_migration_snapshot(
        source(),
        cast(Any, original),
        PinnedMigrationTarget("pinned", MigrationTargetSource.NEW_IMPORT),
    )

    assert "pinned" in user_reads
    assert result.users["pinned"] == MigrationUserState(True, True)
    assert "pinned" in result.mapping.internal_lookups
    assert all(context is contexts[0] and context is not original for context in contexts)
    assert original["_default"]["coreCallCache"] == {}


@pytest.mark.asyncio
async def test_link_rechecks_expected_identity_before_mutation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    expected = source(email="expected@example.com").expected_identities[0]
    stale_owner = IdentityOwner(
        expected.key,
        "recipe",
        "unlinked",
        "passwordless",
        "expected@example.com",
        True,
        ("tenant-a",),
        False,
    )
    changed_method = login_method(
        "recipe", "passwordless", email="replaced@example.com", verified=True
    )
    async def get_changed_user(*_args: Any):
        return sdk_user("unlinked", [changed_method], primary=False)

    async def resolve_user_id(*_args: Any):
        return "unlinked"

    async def no_mapping(*_args: Any):
        return SimpleNamespace(status="UNKNOWN_MAPPING_ERROR")

    monkeypatch.setattr(repository, "get_user", get_changed_user)
    monkeypatch.setattr(repository, "resolve_supertokens_user_id", resolve_user_id)
    monkeypatch.setattr(repository, "get_user_id_mapping", no_mapping)

    async def unexpected_mutation(*_args: Any):
        raise AssertionError("changed identity must not be linked")

    with pytest.raises(MigrationError) as raised:
        await repository._apply_to_fresh_migration_method(
            "recipe",
            "target",
            {},
            unexpected_mutation,
            stale_owner,
            expected,
        )

    assert raised.value.reason is MigrationErrorReason.IDENTITY_OWNED_BY_ANOTHER_USER


@pytest.mark.asyncio
async def test_link_rechecks_exact_third_party_identity_before_mutation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    expected = source(google_id="expected-google-user").expected_identities[0]
    stale_owner = IdentityOwner(
        expected.key,
        "google-recipe",
        "standalone-owner",
        "thirdparty",
        "google:expected-google-user",
        False,
        ("tenant-a",),
        False,
    )
    changed_method = login_method(
        "google-recipe",
        "thirdparty",
        provider_id="google",
        provider_user_id="changed-google-user",
        verified=False,
    )

    async def get_changed_user(*_args: Any):
        return sdk_user("standalone-owner", [changed_method], primary=False)

    async def resolve_user_id(*_args: Any):
        return "standalone-owner"

    async def no_mapping(*_args: Any):
        return SimpleNamespace(status="UNKNOWN_MAPPING_ERROR")

    async def unexpected_mutation(*_args: Any):
        raise AssertionError("changed provider identity must not be linked")

    monkeypatch.setattr(repository, "get_user", get_changed_user)
    monkeypatch.setattr(repository, "resolve_supertokens_user_id", resolve_user_id)
    monkeypatch.setattr(repository, "get_user_id_mapping", no_mapping)

    with pytest.raises(MigrationError) as raised:
        await repository._apply_to_fresh_migration_method(
            "google-recipe",
            "target",
            {},
            unexpected_mutation,
            stale_owner,
            expected,
        )

    assert raised.value.reason is MigrationErrorReason.IDENTITY_OWNED_BY_ANOTHER_USER


@pytest.mark.asyncio
@pytest.mark.parametrize("removed", [False, True])
async def test_link_stops_when_provider_source_changes_or_is_removed(
    monkeypatch: pytest.MonkeyPatch, removed: bool
) -> None:
    original_user = cast(
        JsonDict,
        {
            "data": {"user_id": "rownd-1", "google_id": "google-user"},
            "verified_data": {"google_id": True},
        },
    )
    revoked_user = cast(
        JsonDict,
        {
            "data": {"user_id": "rownd-1", "google_id": "google-user"},
            "verified_data": {"google_id": False},
        },
    )
    original = repository.FreshMigrationSource(
        original_user, create_rownd_identity_snapshot(original_user, "tenant-a")
    )
    revoked = repository.FreshMigrationSource(
        revoked_user, create_rownd_identity_snapshot(revoked_user, "tenant-a")
    )
    identity = original.snapshot.expected_identities[0]
    existing_owner = IdentityOwner(
        identity.key,
        "google-recipe",
        "standalone-owner",
        "thirdparty",
        "google:google-user",
        False,
        ("tenant-a",),
        False,
    )

    async def get_owner(*_args: Any):
        return sdk_user(
            "standalone-owner",
            [
                login_method(
                    "google-recipe",
                    "thirdparty",
                    provider_id="google",
                    provider_user_id="google-user",
                    verified=False,
                )
            ],
            primary=False,
        )

    async def resolve_owner(*_args: Any):
        return "standalone-owner"

    async def no_mapping(*_args: Any):
        return SimpleNamespace(status="UNKNOWN_MAPPING_ERROR")

    async def read_changed_source():
        return None if removed else revoked

    async def unexpected_link(*_args: Any):
        raise AssertionError("revoked provider identity must not be linked")

    monkeypatch.setattr(repository, "get_user", get_owner)
    monkeypatch.setattr(repository, "resolve_supertokens_user_id", resolve_owner)
    monkeypatch.setattr(repository, "get_user_id_mapping", no_mapping)
    monkeypatch.setattr(repository.accountlinking_asyncio, "link_accounts", unexpected_link)

    if removed:
        with pytest.raises(MigrationError) as raised:
            await repository._link_fresh_migration_method(
                "google-recipe",
                identity,
                existing_owner,
                original,
                PinnedMigrationTarget("target", MigrationTargetSource.MAPPING),
                {},
                read_changed_source,
            )
        assert raised.value.reason is MigrationErrorReason.MIGRATION_INCOMPLETE
    else:
        result, changed = await repository._link_fresh_migration_method(
            "google-recipe",
            identity,
            existing_owner,
            original,
            PinnedMigrationTarget("target", MigrationTargetSource.MAPPING),
            {},
            read_changed_source,
        )
        assert result is None
        assert changed == revoked


@pytest.mark.asyncio
@pytest.mark.parametrize("changed_topology", ["mapping", "primary_graph"])
async def test_link_rechecks_target_authority_before_mutation(
    monkeypatch: pytest.MonkeyPatch, changed_topology: str
) -> None:
    rownd_user = cast(
        JsonDict,
        {
            "data": {"user_id": "rownd-1", "google_id": "google-user"},
            "verified_data": {"google_id": True},
        },
    )
    fresh = repository.FreshMigrationSource(
        rownd_user, create_rownd_identity_snapshot(rownd_user, "tenant-a")
    )
    identity = fresh.snapshot.expected_identities[0]
    existing_owner = IdentityOwner(
        identity.key,
        "google-recipe",
        "standalone-owner",
        "thirdparty",
        "google:google-user",
        False,
        ("tenant-a",),
        False,
    )

    async def get_current_user(user_id: str, *_args: Any):
        if user_id == "google-recipe":
            return sdk_user(
                "standalone-owner",
                [
                    login_method(
                        "google-recipe",
                        "thirdparty",
                        provider_id="google",
                        provider_user_id="google-user",
                        verified=False,
                    )
                ],
                primary=False,
            )
        target_id = "other-primary" if changed_topology == "primary_graph" else "target"
        return sdk_user(target_id, [], primary=True)

    async def resolve_user_id(user_id: str, *_args: Any):
        return user_id

    async def get_mapping(user_id: str, mapping_type: str, *_args: Any):
        if user_id == "standalone-owner":
            return SimpleNamespace(status="UNKNOWN_MAPPING_ERROR")
        if changed_topology == "mapping" and mapping_type == "EXTERNAL":
            return GetUserIdMappingOkResult("remapped-target", "rownd-1")
        return GetUserIdMappingOkResult("target", "rownd-1")

    async def read_same_source():
        return fresh

    async def unexpected_link(*_args: Any):
        raise AssertionError("link target authority changed")

    monkeypatch.setattr(repository, "get_user", get_current_user)
    monkeypatch.setattr(repository, "resolve_supertokens_user_id", resolve_user_id)
    monkeypatch.setattr(repository, "get_user_id_mapping", get_mapping)
    monkeypatch.setattr(repository.accountlinking_asyncio, "link_accounts", unexpected_link)

    with pytest.raises(MigrationError) as raised:
        await repository._link_fresh_migration_method(
            "google-recipe",
            identity,
            existing_owner,
            fresh,
            PinnedMigrationTarget("target", MigrationTargetSource.MAPPING),
            {},
            read_same_source,
        )

    assert raised.value.reason is MigrationErrorReason.MAPPING_CONFLICT


@pytest.mark.asyncio
async def test_create_identity_rechecks_created_method_immediately_before_link(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rownd_user = cast(
        JsonDict,
        {
            "data": {"user_id": "rownd-1", "google_id": "google-user"},
            "verified_data": {"google_id": True},
        },
    )
    fresh = repository.FreshMigrationSource(
        rownd_user, create_rownd_identity_snapshot(rownd_user, "tenant-a")
    )
    identity = fresh.snapshot.expected_identities[0]
    target = PinnedMigrationTarget("target", MigrationTargetSource.MAPPING)
    disposition = MigrationDisposition(
        MigrationDispositionStatus.REPAIRABLE,
        target,
        mutations=(MigrationMutation("CREATE_IDENTITY", identity=identity),),
    )
    before_create = snapshot(
        identity_source=fresh.snapshot,
        external_target="target",
        metadata={"target": valid_metadata(fresh.snapshot)},
        pointers={"target": CanonicalEmailPointerState(CanonicalEmailPointerStatus.ABSENT)},
    )
    created_owner = IdentityOwner(
        identity.key,
        "created-recipe",
        "created-recipe",
        "thirdparty",
        "google:google-user",
        False,
        ("tenant-a",),
        False,
    )
    before_link = snapshot(
        identity_source=fresh.snapshot,
        external_target="target",
        owners=(created_owner,),
        users={
            "target": MigrationUserState(True, True),
            "created-recipe": MigrationUserState(True, False),
        },
        internal={
            "target": MappingLookup("rownd-1", "target"),
            "created-recipe": None,
        },
        metadata={"target": valid_metadata(fresh.snapshot)},
        pointers={"target": CanonicalEmailPointerState(CanonicalEmailPointerStatus.ABSENT)},
    )
    snapshot_reads = 0
    user_reads = 0

    async def read_source():
        return fresh

    async def read_snapshot(*_args: Any):
        nonlocal snapshot_reads
        snapshot_reads += 1
        return before_create if snapshot_reads == 1 else before_link

    async def create_method(*_args: Any):
        return RecipeUserId("created-recipe"), True

    async def get_created_user(*_args: Any):
        nonlocal user_reads
        user_reads += 1
        method = login_method(
            "created-recipe",
            "thirdparty",
            provider_id="google",
            provider_user_id=("google-user" if user_reads == 1 else "raced-user"),
            verified=False,
        )
        return sdk_user("created-recipe", [method], primary=False)

    async def not_linked_to_target(*_args: Any):
        return False

    async def resolve_created(*_args: Any):
        return "created-recipe"

    async def no_mapping(*_args: Any):
        return SimpleNamespace(status="UNKNOWN_MAPPING_ERROR")

    async def unexpected_link(*_args: Any):
        raise AssertionError("raced created identity must not be linked")

    monkeypatch.setattr(repository, "read_fresh_migration_snapshot", read_snapshot)
    monkeypatch.setattr(repository, "create_missing_login_method", create_method)
    monkeypatch.setattr(repository, "get_user", get_created_user)
    monkeypatch.setattr(repository, "sdk_user_id_matches_internal_target", not_linked_to_target)
    monkeypatch.setattr(repository, "resolve_supertokens_user_id", resolve_created)
    monkeypatch.setattr(repository, "get_user_id_mapping", no_mapping)
    monkeypatch.setattr(repository.accountlinking_asyncio, "link_accounts", unexpected_link)

    with pytest.raises(MigrationError) as raised:
        await repository.apply_migration_repairs(
            disposition,
            fresh,
            target,
            cast(Any, SimpleNamespace()),
            {},
            read_source,
        )

    assert raised.value.reason is MigrationErrorReason.IDENTITY_OWNED_BY_ANOTHER_USER
    assert user_reads == 2


@pytest.mark.parametrize("field", ["status", "status_code", "statusCode"])
def test_core_outage_recognizes_server_status_fields(field: str) -> None:
    assert repository._is_recognizable_core_outage(
        repository._BulkImportError(500, "down")
        if field == "status"
        else cast(BaseException, SimpleNamespace(**{field: 503}))
    )


def test_core_outage_recognizes_httpx_transport_error() -> None:
    assert repository._is_recognizable_core_outage(
        httpx.ConnectError("connection failed", request=httpx.Request("GET", "http://core"))
    )


@pytest.mark.parametrize("status", [400, 404, 499])
def test_core_outage_rejects_httpx_client_status_errors(status: int) -> None:
    request = httpx.Request("GET", "http://core")
    response = httpx.Response(status, request=request)

    with pytest.raises(httpx.HTTPStatusError) as raised:
        response.raise_for_status()

    assert repository._is_recognizable_core_outage(raised.value) is False


@pytest.mark.asyncio
async def test_metadata_repair_stops_when_refetched_source_snapshot_changed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original_user = cast(
        JsonDict,
        {
            "data": {"user_id": "rownd-1", "email": "old@example.com"},
            "verified_data": {"email": True},
        },
    )
    changed_user = cast(
        JsonDict,
        {
            "data": {"user_id": "rownd-1", "email": "new@example.com"},
            "verified_data": {"email": True},
        },
    )
    original = repository.FreshMigrationSource(
        original_user,
        create_rownd_identity_snapshot(original_user, "tenant-a"),
    )
    changed = repository.FreshMigrationSource(
        changed_user,
        create_rownd_identity_snapshot(changed_user, "tenant-a"),
    )
    target = PinnedMigrationTarget("target", MigrationTargetSource.MAPPING)
    disposition = MigrationDisposition(
        MigrationDispositionStatus.REPAIRABLE,
        target,
        mutations=(MigrationMutation("WRITE_METADATA", target_user_id="target"),),
    )

    durable = snapshot(
        identity_source=original.snapshot,
        owners=(
            owner(
                "passwordless:email:old@example.com",
                "target",
                recipe_user_id="email-recipe",
            ),
        ),
        external_target="target",
        metadata={
            "target": MigrationMetadataState(
                True,
                ValidatedMigrationMetadata(
                    legacy_complete=False,
                    canonical_email_recipe_user_id="email-recipe",
                    original_rownd_user_id="rownd-1",
                ),
            )
        },
        pointers={
            "target": CanonicalEmailPointerState(
                CanonicalEmailPointerStatus.VALID, "email-recipe"
            )
        },
    )
    source_reads = 0

    async def read_changed_source():
        nonlocal source_reads
        source_reads += 1
        return original if source_reads == 1 else changed

    async def read_snapshot(*_args: Any):
        return durable

    async def get_metadata(*_args: Any):
        return {}

    async def inspect_metadata(*_args: Any):
        return {"rownd_metadata_source_user_id": "target"}

    async def unexpected_write(*args: Any, **kwargs: Any):
        raise AssertionError("stale completion metadata must not be written")

    monkeypatch.setattr(repository.usermetadata_asyncio, "update_user_metadata", unexpected_write)
    monkeypatch.setattr(repository, "read_fresh_migration_snapshot", read_snapshot)
    monkeypatch.setattr(repository, "get_raw_user_metadata", get_metadata)
    monkeypatch.setattr(repository, "inspect_linked_user_metadata", inspect_metadata)

    result = await repository.apply_migration_repairs(
        disposition,
        original,
        target,
        cast(Any, SimpleNamespace()),
        {},
        read_changed_source,
    )

    assert result == changed
    assert source_reads == 2


def mapping_safety_snapshot(
    fresh: repository.FreshMigrationSource,
    *,
    external_target: Optional[str] = None,
    internal_external: Optional[str] = None,
    raw_collision: bool = False,
    target_exists: bool = True,
) -> MigrationSnapshot:
    target = "target"
    users = {target: MigrationUserState(target_exists, True)}
    if external_target and external_target != target:
        users[external_target] = MigrationUserState(True, True)
    return snapshot(
        identity_source=fresh.snapshot,
        external_target=external_target,
        raw_user_id=fresh.snapshot.rownd_user_id if raw_collision else None,
        users=users,
        internal={
            target: MappingLookup(internal_external, target) if internal_external else None,
            **({fresh.snapshot.rownd_user_id: None} if raw_collision else {}),
            **(
                {external_target: MappingLookup(fresh.snapshot.rownd_user_id, external_target)}
                if external_target and external_target != target
                else {}
            ),
        },
        metadata={target: valid_metadata(fresh.snapshot)},
        pointers={target: CanonicalEmailPointerState(CanonicalEmailPointerStatus.ABSENT)},
    )


class MappingSafetyArrangement:
    def __init__(
        self,
        monkeypatch: pytest.MonkeyPatch,
        *,
        initially_mapped: bool = False,
        create_result: object = None,
        create_error: Optional[Exception] = None,
        on_create: Optional[Any] = None,
    ) -> None:
        rownd_user = cast(JsonDict, {"data": {"user_id": "rownd-1"}, "verified_data": {}})
        self.fresh = repository.FreshMigrationSource(
            rownd_user, create_rownd_identity_snapshot(rownd_user, "tenant-a")
        )
        self.target = PinnedMigrationTarget("target", MigrationTargetSource.THIRD_PARTY)
        self.mapped = initially_mapped
        self.internal_external: Optional[str] = None
        self.external_target: Optional[str] = None
        self.raw_collision = False
        self.target_exists = True
        self.create_calls: list[tuple[tuple[Any, ...], dict[str, Any]]] = []
        self.create_result = create_result
        self.create_error = create_error
        self.on_create = on_create

        async def read_source():
            return self.fresh

        async def read_snapshot(*_args: Any):
            return mapping_safety_snapshot(
                self.fresh,
                external_target=self.external_target or ("target" if self.mapped else None),
                internal_external=self.internal_external or (
                    self.fresh.snapshot.rownd_user_id if self.mapped else None
                ),
                raw_collision=self.raw_collision,
                target_exists=self.target_exists,
            )

        async def get_mapping(user_id: str, mapping_type: str, *_args: Any):
            if mapping_type == "EXTERNAL" and user_id == self.fresh.snapshot.rownd_user_id:
                target = self.external_target or ("target" if self.mapped else None)
                if target:
                    return GetUserIdMappingOkResult(target, self.fresh.snapshot.rownd_user_id)
            if mapping_type == "SUPERTOKENS" and user_id == "target":
                external = self.internal_external or (
                    self.fresh.snapshot.rownd_user_id if self.mapped else None
                )
                if external:
                    return GetUserIdMappingOkResult("target", external)
            return SimpleNamespace(status="UNKNOWN_MAPPING_ERROR")

        async def create_mapping(*args: Any, **kwargs: Any):
            self.create_calls.append((args, kwargs))
            if self.on_create:
                self.on_create()
            if self.create_error:
                raise self.create_error
            if self.create_result is None or isinstance(
                self.create_result, CreateUserIdMappingOkResult
            ):
                self.mapped = True
            return self.create_result or CreateUserIdMappingOkResult()

        self.read_source = read_source
        monkeypatch.setattr(repository, "read_fresh_migration_snapshot", read_snapshot)
        monkeypatch.setattr(repository, "get_user_id_mapping", get_mapping)
        monkeypatch.setattr(repository, "create_user_id_mapping", create_mapping)

    async def create(self, narrow_capability=None, retry_state=None) -> bool:
        return await repository._create_rownd_user_id_mapping(
            self.fresh,
            self.target,
            {},
            self.read_source,
            retry_state or repository._MappingRetryState(),
            narrow_capability,
        )

    def assert_unforced(self) -> None:
        assert all(kwargs["force"] is False for _, kwargs in self.create_calls)


class StructuralMappingError(RuntimeError):
    status = "NON_AUTH_RECIPE_USER_ID_REFERENCE_ERROR"


@pytest.mark.asyncio
async def test_mapping_accepts_exact_existing_symmetric_mapping(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    arranged = MappingSafetyArrangement(monkeypatch, initially_mapped=True)

    assert await arranged.create() is False
    assert arranged.create_calls == []


@pytest.mark.asyncio
async def test_mapping_recovers_sibling_exact_mapping_race(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    arranged: MappingSafetyArrangement
    arranged = MappingSafetyArrangement(
        monkeypatch,
        create_result=UserIdMappingAlreadyExistsError(False, "true"),
        on_create=lambda: setattr(arranged, "mapped", True),
    )

    assert await arranged.create() is False
    arranged.assert_unforced()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("change", "reason"),
    [
        (lambda item: setattr(item, "raw_collision", True), MigrationErrorReason.RAW_USER_ID_COLLISION),
        (lambda item: setattr(item, "external_target", "foreign"), MigrationErrorReason.MAPPING_CONFLICT),
        (
            lambda item: setattr(item, "internal_external", "foreign-external"),
            MigrationErrorReason.MAPPING_CONFLICT,
        ),
    ],
)
async def test_mapping_preflight_rejects_collisions_without_writing(
    monkeypatch: pytest.MonkeyPatch, change: Any, reason: MigrationErrorReason
) -> None:
    arranged = MappingSafetyArrangement(monkeypatch)
    change(arranged)

    with pytest.raises(MigrationError) as raised:
        await arranged.create()

    assert raised.value.reason is reason
    assert raised.value.stage == "mapping"
    assert arranged.create_calls == []


@pytest.mark.asyncio
async def test_mapping_exact_non_auth_result_uses_one_narrow_attempt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    arranged = MappingSafetyArrangement(
        monkeypatch, create_result=repository._NonAuthRecipeUserIdReferenceError()
    )
    narrow_calls = 0

    async def narrow(*_args: Any):
        nonlocal narrow_calls
        narrow_calls += 1
        arranged.mapped = True
        return CreateUserIdMappingOkResult()

    assert await arranged.create(narrow) is True
    assert narrow_calls == 1
    arranged.assert_unforced()


@pytest.mark.asyncio
async def test_mapping_exact_non_auth_result_requires_unavailable_capability(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    arranged = MappingSafetyArrangement(
        monkeypatch, create_result=repository._NonAuthRecipeUserIdReferenceError()
    )

    with pytest.raises(MigrationError) as raised:
        await arranged.create()

    assert raised.value.reason is MigrationErrorReason.CORE_CAPABILITY_REQUIRED
    assert raised.value.stage == "mapping"
    arranged.assert_unforced()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failure",
    [
        RuntimeError("generic failure"),
        KeyError("does_external_user_id_exist"),
        StructuralMappingError("not a typed SDK result"),
    ],
)
async def test_mapping_thrown_failures_never_authorize_narrow_attempt(
    monkeypatch: pytest.MonkeyPatch, failure: Exception
) -> None:
    arranged = MappingSafetyArrangement(monkeypatch, create_error=failure)
    narrow_calls = 0

    async def narrow(*_args: Any):
        nonlocal narrow_calls
        narrow_calls += 1

    with pytest.raises(BaseException) as raised:
        await arranged.create(narrow)

    assert raised.value is failure
    assert narrow_calls == 0
    arranged.assert_unforced()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "result",
    [
        SimpleNamespace(status="NON_AUTH_RECIPE_USER_ID_REFERENCE_ERROR"),
        SimpleNamespace(status="UNKNOWN_SUPERTOKENS_USER_ID_ERROR"),
    ],
)
async def test_mapping_generic_results_never_authorize_narrow_attempt(
    monkeypatch: pytest.MonkeyPatch, result: object
) -> None:
    arranged = MappingSafetyArrangement(monkeypatch, create_result=result)
    narrow_calls = 0

    async def narrow(*_args: Any):
        nonlocal narrow_calls
        narrow_calls += 1

    with pytest.raises(RuntimeError):
        await arranged.create(narrow)

    assert narrow_calls == 0
    arranged.assert_unforced()


@pytest.mark.asyncio
async def test_mapping_shares_narrow_retry_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    arranged = MappingSafetyArrangement(
        monkeypatch, create_result=repository._NonAuthRecipeUserIdReferenceError()
    )
    retry_state = repository._MappingRetryState()
    narrow_calls = 0

    async def narrow(*_args: Any):
        nonlocal narrow_calls
        narrow_calls += 1
        return SimpleNamespace(status="UNKNOWN_SUPERTOKENS_USER_ID_ERROR")

    with pytest.raises(RuntimeError):
        await arranged.create(narrow, retry_state)
    with pytest.raises(MigrationError) as raised:
        await arranged.create(narrow, retry_state)

    assert raised.value.reason is MigrationErrorReason.MIGRATION_INCOMPLETE
    assert narrow_calls == 1
    arranged.assert_unforced()


@pytest.mark.asyncio
@pytest.mark.parametrize("topology_change", ["internal", "target_removed"])
async def test_mapping_second_preflight_rejects_topology_change(
    monkeypatch: pytest.MonkeyPatch, topology_change: str
) -> None:
    arranged: MappingSafetyArrangement

    def change_topology() -> None:
        if topology_change == "internal":
            arranged.internal_external = "foreign-external"
        else:
            arranged.target_exists = False

    arranged = MappingSafetyArrangement(
        monkeypatch,
        create_result=repository._NonAuthRecipeUserIdReferenceError(),
        on_create=change_topology,
    )
    narrow_calls = 0

    async def narrow(*_args: Any):
        nonlocal narrow_calls
        narrow_calls += 1

    with pytest.raises(MigrationError) as raised:
        await arranged.create(narrow)

    assert raised.value.reason is MigrationErrorReason.MAPPING_CONFLICT
    assert narrow_calls == 0
    arranged.assert_unforced()


@pytest.mark.asyncio
async def test_mapping_second_preflight_rejects_reparented_identity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rownd_user = cast(
        JsonDict,
        {
            "data": {"user_id": "rownd-1", "google_id": "google-user"},
            "verified_data": {"google_id": True},
        },
    )
    fresh = repository.FreshMigrationSource(
        rownd_user, create_rownd_identity_snapshot(rownd_user, "tenant-a")
    )
    identity = fresh.snapshot.expected_identities[0]
    target = PinnedMigrationTarget("target", MigrationTargetSource.THIRD_PARTY)
    reparented = False
    create_calls: list[dict[str, Any]] = []

    async def read_source():
        return fresh

    async def read_snapshot(*_args: Any):
        owner_id = "foreign" if reparented else "target"
        return snapshot(
            identity_source=fresh.snapshot,
            owners=(
                owner(
                    identity.key,
                    owner_id,
                    recipe_user_id="google-recipe",
                    recipe_id="thirdparty",
                ),
            ),
            users={
                "target": MigrationUserState(True, True),
                owner_id: MigrationUserState(True, True),
            },
            internal={
                "target": None,
                **(
                    {"foreign": MappingLookup("another-external", "foreign")}
                    if reparented
                    else {}
                ),
            },
            metadata={
                "target": valid_metadata(fresh.snapshot),
                owner_id: valid_metadata(fresh.snapshot),
            },
            pointers={
                "target": CanonicalEmailPointerState(CanonicalEmailPointerStatus.ABSENT),
                owner_id: CanonicalEmailPointerState(CanonicalEmailPointerStatus.ABSENT),
            },
        )

    async def create_mapping(*_args: Any, **kwargs: Any):
        nonlocal reparented
        create_calls.append(kwargs)
        reparented = True
        return repository._NonAuthRecipeUserIdReferenceError()

    async def no_mapping(*_args: Any):
        return SimpleNamespace(status="UNKNOWN_MAPPING_ERROR")

    narrow_calls = 0

    async def narrow(*_args: Any):
        nonlocal narrow_calls
        narrow_calls += 1

    monkeypatch.setattr(repository, "read_fresh_migration_snapshot", read_snapshot)
    monkeypatch.setattr(repository, "create_user_id_mapping", create_mapping)
    monkeypatch.setattr(repository, "get_user_id_mapping", no_mapping)

    with pytest.raises(MigrationError) as raised:
        await repository._create_rownd_user_id_mapping(
            fresh,
            target,
            {},
            read_source,
            repository._MappingRetryState(),
            narrow,
        )

    assert raised.value.reason is MigrationErrorReason.IDENTITY_OWNED_BY_ANOTHER_USER
    assert narrow_calls == 0
    assert all(call["force"] is False for call in create_calls)


@pytest.mark.asyncio
async def test_mapping_rejects_asymmetric_postcondition(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    arranged: MappingSafetyArrangement

    def create_asymmetric_mapping() -> None:
        arranged.external_target = "target"
        arranged.internal_external = "foreign-external"

    arranged = MappingSafetyArrangement(monkeypatch, on_create=create_asymmetric_mapping)

    with pytest.raises(MigrationError) as raised:
        await arranged.create()

    assert raised.value.reason is MigrationErrorReason.MAPPING_CONFLICT
    arranged.assert_unforced()


@pytest.mark.asyncio
async def test_mapping_recovers_uncertain_committed_write(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    arranged: MappingSafetyArrangement
    arranged = MappingSafetyArrangement(
        monkeypatch,
        create_error=TimeoutError("timed out"),
        on_create=lambda: setattr(arranged, "mapped", True),
    )

    assert await arranged.create() is True
    arranged.assert_unforced()


@pytest.mark.asyncio
async def test_final_mapping_repair_preserves_capability_required(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rownd_user = cast(JsonDict, {"data": {"user_id": "rownd-1"}, "verified_data": {}})
    fresh = repository.FreshMigrationSource(
        rownd_user, create_rownd_identity_snapshot(rownd_user, "tenant-a")
    )
    target = PinnedMigrationTarget("target", MigrationTargetSource.THIRD_PARTY)
    repairable = MigrationDisposition(
        MigrationDispositionStatus.REPAIRABLE,
        target,
        mutations=(MigrationMutation("CREATE_MAPPING", target_user_id="target"),),
    )

    async def read_source():
        return fresh

    async def read_snapshot(*_args: Any):
        return cast(Any, object())

    repair_attempts = 0

    async def fail_capability_then_incidentally(*_args: Any, **_kwargs: Any):
        nonlocal repair_attempts
        repair_attempts += 1
        if repair_attempts == 1:
            raise MigrationError(MigrationErrorReason.CORE_CAPABILITY_REQUIRED, "mapping")
        raise RuntimeError("incidental retry failure")

    monkeypatch.setattr(repository, "read_fresh_migration_snapshot", read_snapshot)
    monkeypatch.setattr(repository, "classify_migration_snapshot", lambda *_args: repairable)
    monkeypatch.setattr(
        repository, "apply_migration_repairs", fail_capability_then_incidentally
    )

    with pytest.raises(MigrationError) as raised:
        await repository.migrate_rownd_user_and_create_session(
            cast(Any, SimpleNamespace()),
            "rownd-1",
            fresh,
            cast(Any, SimpleNamespace()),
            cast(Any, SimpleNamespace()),
            cast(Any, SimpleNamespace()),
            "tenant-a",
            None,
            {},
            {},
            read_source,
        )

    assert raised.value.reason is MigrationErrorReason.CORE_CAPABILITY_REQUIRED
    assert raised.value.stage == "mapping"


@pytest.mark.asyncio
async def test_repository_reports_retry_recovery_truthfully(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rownd_user = cast(JsonDict, {"data": {"user_id": "rownd-1"}, "verified_data": {}})
    fresh = repository.FreshMigrationSource(
        rownd_user, create_rownd_identity_snapshot(rownd_user, "tenant-a")
    )
    target = PinnedMigrationTarget("rownd-1", MigrationTargetSource.MAPPING)
    complete = MigrationDisposition(MigrationDispositionStatus.COMPLETE, target)
    reads = 0

    async def read_snapshot(*_args: Any):
        nonlocal reads
        reads += 1
        if reads == 1:
            raise TimeoutError("first inspection failed")
        return cast(Any, object())

    async def read_source():
        return fresh

    async def no_op(*_args: Any, **_kwargs: Any) -> None:
        return None

    async def session_method(*_args: Any, **_kwargs: Any) -> RecipeUserId:
        return RecipeUserId("recipe-user")

    session = SimpleNamespace(
        get_user_id=lambda _context: "rownd-1",
        get_recipe_user_id=lambda _context: RecipeUserId("recipe-user"),
        get_tenant_id=lambda _context: "tenant-a",
    )

    async def create_session(*_args: Any, **_kwargs: Any):
        return session

    monkeypatch.setattr(repository, "read_fresh_migration_snapshot", read_snapshot)
    monkeypatch.setattr(repository, "classify_migration_snapshot", lambda *_args: complete)
    monkeypatch.setattr(repository, "record_rownd_app_variant_for_user", no_op)
    monkeypatch.setattr(repository, "read_fresh_migration_session_method", session_method)
    monkeypatch.setattr(repository, "build_rownd_session_claims", lambda *_args: no_op())
    monkeypatch.setattr(repository.session_asyncio, "create_new_session", create_session)
    migration_state: JsonDict = {}

    result = await repository.migrate_rownd_user_and_create_session(
        cast(Any, SimpleNamespace()),
        "rownd-1",
        fresh,
        cast(Any, SimpleNamespace()),
        cast(Any, SimpleNamespace()),
        cast(Any, SimpleNamespace()),
        "tenant-a",
        None,
        {},
        migration_state,
        read_source,
    )

    assert result == "rownd-1"
    assert migration_state["attempt_count"] == 2
    assert migration_state["target_source"] == "mapping"
    assert migration_state["path"] == "retry_recovery"

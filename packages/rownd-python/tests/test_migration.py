from __future__ import annotations

from copy import deepcopy
from dataclasses import replace
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
    MigrationMutationType,
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


@pytest.mark.parametrize(
    "field,value",
    [("google_id", "google-123"), ("apple_id", "apple-123"), ("phone_number", "+1234567890")],
)
@pytest.mark.parametrize("verification", [True, "matching_string"])
@pytest.mark.parametrize("with_email", [False, True])
def test_online_import_normalizes_authoritative_identities(
    field: str, value: str, verification: Any, with_email: bool,
) -> None:
    profile: JsonDict = {
        "data": {
            "user_id": "rownd-1", field: "  " + value + "  ", "email": "user@example.com"
        },
        "verified_data": {
            field: " " + value + " " if verification == "matching_string" else verification,
            "email": with_email,
        },
        "meta": {"custom": "retained"},
    }
    original = deepcopy(profile)
    snapshot = create_rownd_identity_snapshot(profile, "tenant-a")
    payload = repository._build_online_migration_import(
        repository.FreshMigrationSource(profile, snapshot)
    )
    methods = cast(list[dict[str, Any]], payload["loginMethods"])
    expected_method: dict[str, Any] = {
        "recipeId": "passwordless" if field == "phone_number" else "thirdparty",
        "isVerified": field == "phone_number",
        "tenantIds": ["tenant-a"],
        "isPrimary": True,
    }
    if field == "phone_number":
        expected_method["phoneNumber"] = value
    else:
        provider = field.removesuffix("_id")
        expected_method.update({
            "thirdPartyId": provider,
            "thirdPartyUserId": value,
            "email": repository.rownd_compatibility.build_supertokens_fake_email(value, provider),
        })
    expected_methods = [expected_method]
    if with_email:
        expected_methods.append({
            "recipeId": "passwordless", "email": "user@example.com",
            "isVerified": True, "tenantIds": ["tenant-a"],
        })
    assert methods == expected_methods
    assert profile == original
    assert cast(dict, payload["userMetadata"])["original_rownd_user"] == original


@pytest.mark.parametrize("auth_level", ["guest", "instant"])
def test_online_import_keeps_unverified_identities_out_of_bridge(auth_level: str) -> None:
    profile: JsonDict = {
        "data": {
            "user_id": "rownd-1", "google_id": " google-123 ",
            "apple_id": " apple-123 ", "phone_number": " +1234567890 ",
        },
        "verified_data": {},
        "auth_level": auth_level,
    }
    original = deepcopy(profile)
    payload = repository._build_online_migration_import(repository.FreshMigrationSource(
        profile, create_rownd_identity_snapshot(profile, "public")
    ))
    assert payload["loginMethods"] == [{
        "recipeId": "thirdparty", "thirdPartyId": auth_level,
        "thirdPartyUserId": "rownd-1", "email": "rownd-1@anonymous.local",
        "isVerified": False,
    }]
    assert profile == original
    assert cast(dict, payload["userMetadata"])["original_rownd_user"] == original


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
        ":".join(identity_key.split(":")[1:])
        if effective_recipe == "thirdparty"
        else identity_key.split(":", 2)[-1],
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
    phone_number: Optional[str] = None,
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
        phone_number=phone_number,
        verified=verified,
        tenant_ids=list(tenant_ids),
        has_same_email_as=lambda value: (
            email is not None and value is not None and email.lower() == value.lower()
        ),
        has_same_phone_number_as=lambda value: (
            phone_number is not None and value is not None and phone_number == value
        ),
    )


def sdk_user(user_id: str, methods: list[Any], *, primary: bool = True) -> Any:
    return SimpleNamespace(id=user_id, is_primary_user=primary, login_methods=methods)


@pytest.fixture
def target_already_in_tenant(monkeypatch: pytest.MonkeyPatch) -> None:
    async def get_user(user_id: str, _context: Any):
        return sdk_user(user_id, [login_method("recipe-user", "passwordless")])

    async def resolve(user_id: str, _context: Any):
        return user_id

    monkeypatch.setattr(repository, "get_user", get_user)
    monkeypatch.setattr(repository, "resolve_supertokens_user_id", resolve)


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


@pytest.mark.parametrize("missing", ["email", "phone"])
@pytest.mark.parametrize("authority", ["mapping", "pinned", "none", "raw", "pinned_raw"])
def test_split_passwordless_owners_require_safe_authority(missing: str, authority: str) -> None:
    identity_source = source(email="user@example.com", phone_number="+442079460018")
    target_id = "rownd-1" if "raw" in authority else "target"
    owners = tuple(
        owner(
            identity.key,
            "standalone" if identity.identifier_type == missing else target_id,
            recipe_user_id=identity.identifier_type or "recipe",
            is_primary=identity.identifier_type != missing,
        )
        for identity in identity_source.expected_identities
    )
    state = snapshot(
        identity_source=identity_source,
        owners=owners,
        external_target=target_id if authority == "mapping" else None,
        raw_user_id=target_id if "raw" in authority else None,
        raw_same_graph="raw" in authority,
    )
    pinned = (
        PinnedMigrationTarget(
            target_id,
            MigrationTargetSource.RAW_ID
            if authority == "pinned_raw"
            else MigrationTargetSource.VERIFIED_PASSWORDLESS,
        )
        if authority in {"pinned", "pinned_raw"}
        else None
    )
    result = classify_migration_snapshot(state, pinned)
    if authority in {"mapping", "pinned"}:
        assert result.status is MigrationDispositionStatus.REPAIRABLE
        assert result.target is not None and result.target.user_id == target_id
        assert MigrationMutation(
            "LINK_IDENTITY", target_user_id=target_id, recipe_user_id=missing
        ) in result.mutations
        assert not any(m.type == "CREATE_IDENTITY" for m in result.mutations)
    else:
        assert result.reason is MigrationErrorReason.IDENTITY_AMBIGUOUS
        assert result.mutations == ()


@pytest.mark.parametrize("missing", ["email", "phone"])
@pytest.mark.parametrize("mapped", [False, True])
@pytest.mark.parametrize(
    "unsafe,reason",
    [
        ("primary", MigrationErrorReason.PRIMARY_ACCOUNT_MERGE_REQUIRED),
        ("mapping", MigrationErrorReason.IDENTITY_OWNED_BY_ANOTHER_USER),
        ("metadata_owner", MigrationErrorReason.IDENTITY_OWNED_BY_ANOTHER_USER),
        ("metadata_invalid", MigrationErrorReason.MIGRATION_STATE_INVALID),
        ("unverified", MigrationErrorReason.IDENTITY_OWNED_BY_ANOTHER_USER),
        ("tenant", MigrationErrorReason.IDENTITY_OWNED_BY_ANOTHER_USER),
        ("same_identity", MigrationErrorReason.IDENTITY_AMBIGUOUS),
    ],
)
def test_split_passwordless_recovery_blocks_unsafe_foreign_owner(
    missing: str, mapped: bool, unsafe: str, reason: MigrationErrorReason
) -> None:
    identity_source = source(email="user@example.com", phone_number="+442079460018")
    owners = tuple(
        owner(
            identity.key,
            "standalone" if identity.identifier_type == missing else "target",
            recipe_user_id=identity.identifier_type or "recipe",
            is_primary=identity.identifier_type != missing or unsafe == "primary",
            verified=identity.identifier_type != missing or unsafe != "unverified",
            tenant_ids=("other",) if unsafe == "tenant" else ("tenant-a",),
        )
        for identity in identity_source.expected_identities
    )
    if unsafe == "same_identity":
        identity = next(i for i in identity_source.expected_identities if i.identifier_type == missing)
        owners += (owner(identity.key, "target", recipe_user_id="duplicate"),)
    metadata = {}
    if unsafe == "metadata_invalid":
        metadata["standalone"] = MigrationMetadataState(False)
    elif unsafe == "metadata_owner":
        metadata["standalone"] = MigrationMetadataState(
            True, ValidatedMigrationMetadata(original_rownd_user_id="another-rownd-user")
        )
    result = classify_migration_snapshot(
        snapshot(
            identity_source=identity_source,
            owners=owners,
            external_target="target" if mapped else None,
            metadata=metadata,
            internal={
                "target": MappingLookup("rownd-1", "target") if mapped else None,
                "standalone": MappingLookup("other", "standalone") if unsafe == "mapping" else None,
            },
        ),
        None if mapped else PinnedMigrationTarget("target", MigrationTargetSource.VERIFIED_PASSWORDLESS),
    )
    assert result.reason is reason
    assert result.mutations == ()


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


def test_multiple_unrelated_third_party_owners_are_ambiguous() -> None:
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
        )
    )

    assert result.status is MigrationDispositionStatus.BLOCKED
    assert result.reason is MigrationErrorReason.IDENTITY_AMBIGUOUS
    assert result.mutations == ()


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
    "identity_source",
    [
        source(google_id="missing-provider"),
        source(email="missing@example.com"),
        source(phone_number="+12025550199"),
    ],
)
def test_missing_verified_identity_types_repair_independently(identity_source: Any) -> None:
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


def test_missing_mapping_repairs_before_metadata() -> None:
    identity_source = source(google_id="mapped-provider")
    result = classify_migration_snapshot(
        snapshot(
            identity_source=identity_source,
            owners=(
                owner(
                    "thirdparty:google:mapped-provider",
                    "target",
                    recipe_user_id="provider-recipe",
                ),
            ),
            internal={"target": None},
            metadata={"target": valid_metadata(identity_source)},
        )
    )

    assert [mutation.type for mutation in result.mutations] == [
        "CREATE_MAPPING",
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
    assert result.target == PinnedMigrationTarget("mapped", MigrationTargetSource.MAPPING)
    assert result.blocked_identity_type == "passwordless_email"


def test_mapping_target_links_verified_standalone_passwordless_owner() -> None:
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
                    verified=True,
                    is_primary=False,
                ),
            ),
        )
    )

    assert result.status is MigrationDispositionStatus.REPAIRABLE
    assert any(
        mutation.type == "LINK_IDENTITY" and mutation.recipe_user_id == "email-recipe"
        for mutation in result.mutations
    )


def test_foreign_mapped_owner_is_never_linked() -> None:
    identity_source = source(google_id="google")
    result = classify_migration_snapshot(
        snapshot(
            identity_source=identity_source,
            external_target="mapped",
            owners=(
                owner(
                    "thirdparty:google:google",
                    "foreign",
                    recipe_user_id="google-recipe",
                    is_primary=False,
                ),
            ),
            internal={
                "mapped": MappingLookup("rownd-1", "mapped"),
                "foreign": MappingLookup("another-rownd-user", "foreign"),
            },
        )
    )

    assert result.status is MigrationDispositionStatus.BLOCKED
    assert result.reason is MigrationErrorReason.IDENTITY_OWNED_BY_ANOTHER_USER
    assert result.mutations == ()


def test_foreign_primary_owner_requires_manual_merge_without_mutation() -> None:
    identity_source = source(google_id="google")
    result = classify_migration_snapshot(
        snapshot(
            identity_source=identity_source,
            external_target="mapped",
            owners=(
                owner(
                    "thirdparty:google:google",
                    "foreign",
                    recipe_user_id="google-recipe",
                    is_primary=True,
                ),
            ),
        )
    )

    assert result.status is MigrationDispositionStatus.BLOCKED
    assert result.reason is MigrationErrorReason.PRIMARY_ACCOUNT_MERGE_REQUIRED
    assert result.mutations == ()
    assert result.target == PinnedMigrationTarget("mapped", MigrationTargetSource.MAPPING)
    assert result.blocked_identity_type == "thirdparty"


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


def test_target_missing_tenant_membership_is_repairable() -> None:
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
    assert result.target == PinnedMigrationTarget("provider", MigrationTargetSource.THIRD_PARTY)
    assert [mutation.type for mutation in result.mutations] == ["CREATE_MAPPING", "WRITE_METADATA"]


def test_foreign_owner_without_tenant_membership_is_never_linked() -> None:
    identity_source = source(google_id="g")
    result = classify_migration_snapshot(
        snapshot(
            identity_source=identity_source,
            external_target="mapped",
            owners=(
                owner(
                    "thirdparty:google:g",
                    "provider",
                    recipe_user_id="provider-recipe",
                    tenant_ids=(),
                    is_primary=False,
                ),
            ),
        )
    )

    assert result.status is MigrationDispositionStatus.BLOCKED
    assert result.reason is MigrationErrorReason.IDENTITY_OWNED_BY_ANOTHER_USER
    assert result.target == PinnedMigrationTarget("mapped", MigrationTargetSource.MAPPING)
    assert result.blocked_identity_type == "thirdparty"
    assert result.mutations == ()


@pytest.mark.parametrize("tenant_id", ["public", "tenant-a"])
def test_complete_mapped_target_does_not_require_tenant_membership(tenant_id: str) -> None:
    identity_source = replace(source(google_id="g"), tenant_id=tenant_id)
    result = classify_migration_snapshot(
        snapshot(
            identity_source=identity_source,
            external_target="mapped",
            owners=(owner("thirdparty:google:g", "mapped", tenant_ids=()),),
            metadata={"mapped": valid_metadata(identity_source)},
        )
    )
    assert result.status is MigrationDispositionStatus.COMPLETE
    assert result.mutations == ()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("tenant_id", "failure"),
    [
        ("public", None),
        ("public", "missing_membership"),
        ("public", "method_owner"),
        ("tenant-a", None),
        ("tenant-a", "association_status"),
        ("tenant-a", "association_timeout"),
        ("tenant-a", "missing_membership"),
        ("tenant-a", "missing_target"),
        ("tenant-a", "target_owner"),
        ("tenant-a", "method_owner"),
        ("tenant-a", "binding_user"),
        ("tenant-a", "binding_recipe"),
        ("tenant-a", "binding_tenant"),
    ],
)
async def test_completion_associates_before_fresh_session_resolution(
    monkeypatch: pytest.MonkeyPatch, tenant_id: str, failure: Optional[str]
) -> None:
    rownd_user = cast(JsonDict, {
        "data": {"user_id": "rownd-1", "google_id": "g"},
        "verified_data": {"google_id": True},
    })
    fresh = repository.FreshMigrationSource(
        rownd_user, create_rownd_identity_snapshot(rownd_user, tenant_id)
    )
    methods = [
        login_method("google-recipe", "thirdparty", tenant_ids=()),
        login_method("extra-recipe", "emailpassword", tenant_ids=()),
    ]
    if tenant_id == "public" and failure != "missing_membership":
        for method in methods:
            method.tenant_ids.append("public")
    user = sdk_user("rownd-1", methods)
    events: list[str] = []

    async def read_source():
        events.append("source")
        return fresh

    async def read_snapshot(*_args: Any):
        events.append("snapshot")
        return snapshot(
            identity_source=fresh.snapshot,
            external_target="mapped",
            owners=(owner("thirdparty:google:g", "mapped", tenant_ids=()),),
            metadata={"mapped": valid_metadata(fresh.snapshot)},
        )

    async def get_user(user_id: str, _context: Any):
        events.append("get:" + user_id)
        if user_id == "mapped" and failure == "missing_target":
            return None
        if failure == "target_owner" or (
            failure == "method_owner" and user_id != "mapped"
        ):
            return sdk_user("foreign", methods)
        return user

    async def get_mapping(user_id: str, mapping_type: str, _context: Any):
        if (user_id, mapping_type) == ("rownd-1", "EXTERNAL"):
            return GetUserIdMappingOkResult("mapped", "rownd-1")
        return SimpleNamespace(status="UNKNOWN_MAPPING_ERROR")

    async def associate(tenant: str, recipe: RecipeUserId, _context: Any):
        assert tenant == "tenant-a"
        events.append("associate:" + recipe.get_as_string())
        if failure == "association_timeout":
            raise TimeoutError("association unavailable")
        if failure == "association_status":
            return SimpleNamespace(status="EMAIL_ALREADY_EXISTS_ERROR")
        if failure != "missing_membership":
            next(
                method for method in methods
                if method.recipe_user_id.get_as_string() == recipe.get_as_string()
            ).tenant_ids.append(tenant)
        return SimpleNamespace(status="OK")

    async def no_op(*_args: Any, **_kwargs: Any):
        return {}

    async def revoke(_context: Any):
        events.append("revoke")

    async def create_session(_request: Any, tenant: str, recipe: RecipeUserId, *_args: Any):
        events.append("session")
        assert events[-2] == "source"
        return SimpleNamespace(
            get_user_id=lambda _context: "foreign" if failure == "binding_user" else "rownd-1",
            get_recipe_user_id=lambda _context: (
                RecipeUserId("wrong") if failure == "binding_recipe" else recipe
            ),
            get_tenant_id=lambda _context: "wrong" if failure == "binding_tenant" else tenant,
            revoke_session=revoke,
        )

    monkeypatch.setattr(repository, "read_fresh_migration_snapshot", read_snapshot)
    monkeypatch.setattr(repository, "get_user", get_user)
    monkeypatch.setattr(repository, "get_user_id_mapping", get_mapping)
    monkeypatch.setattr(repository.multitenancy_asyncio, "associate_user_to_tenant", associate)
    monkeypatch.setattr(repository, "record_rownd_app_variant_for_user", no_op)
    monkeypatch.setattr(repository, "build_rownd_session_claims", no_op)
    monkeypatch.setattr(repository.session_asyncio, "create_new_session", create_session)
    monkeypatch.setattr(
        repository, "scrub_migration_session_response", lambda *_args: events.append("scrub")
    )
    arguments = (
        cast(Any, SimpleNamespace()), "rownd-1", fresh,
        cast(Any, SimpleNamespace()), cast(Any, SimpleNamespace()),
        cast(Any, SimpleNamespace()), tenant_id, None, {}, {}, read_source,
    )
    if failure is None:
        assert await repository.migrate_rownd_user_and_create_session(*arguments) == "mapped"
        assert events[-1] == "session"
    else:
        with pytest.raises(MigrationError) as raised:
            await repository.migrate_rownd_user_and_create_session(*arguments)
        if failure.startswith("binding_"):
            assert raised.value.reason is MigrationErrorReason.SESSION_CREATION_FAILED
            assert events[-3:] == ["session", "revoke", "scrub"]
        else:
            assert "session" not in events
            expected_reason = (
                MigrationErrorReason.CORE_UNAVAILABLE if failure == "association_timeout"
                else MigrationErrorReason.MAPPING_CONFLICT if failure == "target_owner"
                else MigrationErrorReason.MIGRATION_INCOMPLETE
            )
            assert raised.value.reason is expected_reason
            assert raised.value.stage == (
                "tenant_associate" if failure in {
                    "association_status", "association_timeout", "missing_target", "target_owner"
                } else "state_inspect"
            )
    associations = [event for event in events if event.startswith("associate:")]
    if tenant_id == "public" or failure in {"missing_target", "target_owner"}:
        assert associations == []
    elif failure in {"association_status", "association_timeout"}:
        assert associations == ["associate:google-recipe"]
    else:
        assert associations == ["associate:google-recipe", "associate:extra-recipe"]
        first_get = events.index("get:mapped")
        assert events[first_get - 1] == "snapshot"
        assert events[first_get:first_get + 4] == [
            "get:mapped", "associate:google-recipe", "associate:extra-recipe", "get:mapped"
        ]


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
                    tenant_ids=("tenant-a",),
                    is_primary=False,
                ),
                owner(
                    "thirdparty:google:google",
                    "pinned",
                    recipe_user_id="google-recipe",
                    tenant_ids=("tenant-a",),
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
async def test_repository_allows_repair_of_out_of_tenant_target(
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
    assert disposition.status is MigrationDispositionStatus.REPAIRABLE
    assert [mutation.type for mutation in disposition.mutations] == [
        "CREATE_IDENTITY", "WRITE_METADATA"
    ]


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
async def test_link_rechecks_foreign_rownd_metadata_before_mutation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    expected = source(google_id="google-user").expected_identities[0]
    existing_owner = owner(
        expected.key,
        "standalone-owner",
        recipe_user_id="google-recipe",
        recipe_id="thirdparty",
        is_primary=False,
    )
    method = login_method(
        "google-recipe",
        "thirdparty",
        provider_id="google",
        provider_user_id="google-user",
    )

    async def get_owner(*_args: Any):
        return sdk_user("standalone-owner", [method], primary=False)

    async def resolve_owner(*_args: Any):
        return "standalone-owner"

    async def no_mapping(*_args: Any):
        return SimpleNamespace(status="UNKNOWN_MAPPING_ERROR")

    async def foreign_metadata(*_args: Any):
        return {"original_rownd_user": {"data": {"user_id": "another-rownd-user"}}}

    async def unexpected_link(*_args: Any):
        raise AssertionError("foreign Rownd metadata must prevent linking")

    monkeypatch.setattr(repository, "get_user", get_owner)
    monkeypatch.setattr(repository, "resolve_supertokens_user_id", resolve_owner)
    monkeypatch.setattr(repository, "get_user_id_mapping", no_mapping)
    monkeypatch.setattr(repository, "get_raw_user_metadata", foreign_metadata)

    with pytest.raises(MigrationError) as raised:
        await repository._apply_to_fresh_migration_method(
            "google-recipe",
            "target",
            {},
            unexpected_link,
            existing_owner,
            expected,
            "tenant-a",
            "rownd-1",
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

    async def exact_metadata(*_args: Any):
        return {"original_rownd_user": {"data": {"user_id": "rownd-1"}}}

    async def read_changed_source():
        return None if removed else revoked

    async def unexpected_link(*_args: Any):
        raise AssertionError("revoked provider identity must not be linked")

    monkeypatch.setattr(repository, "get_user", get_owner)
    monkeypatch.setattr(repository, "resolve_supertokens_user_id", resolve_owner)
    monkeypatch.setattr(repository, "get_user_id_mapping", no_mapping)
    monkeypatch.setattr(repository, "get_raw_user_metadata", exact_metadata)
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
        assert raised.value.reason is MigrationErrorReason.ROWND_USER_NOT_FOUND
        assert raised.value.stage == "rownd_profile_fetch"
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

    async def exact_metadata(*_args: Any):
        return {"original_rownd_user": {"data": {"user_id": "rownd-1"}}}

    async def unexpected_link(*_args: Any):
        raise AssertionError("link target authority changed")

    monkeypatch.setattr(repository, "get_user", get_current_user)
    monkeypatch.setattr(repository, "resolve_supertokens_user_id", resolve_user_id)
    monkeypatch.setattr(repository, "get_user_id_mapping", get_mapping)
    monkeypatch.setattr(repository, "get_raw_user_metadata", exact_metadata)
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
@pytest.mark.parametrize("final_owner_matches", [True, False])
async def test_concurrent_sibling_link_requires_fresh_exact_ownership(
    monkeypatch: pytest.MonkeyPatch, final_owner_matches: bool
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
    existing_owner = owner(
        identity.key,
        "standalone-owner",
        recipe_user_id="google-recipe",
        recipe_id="thirdparty",
        is_primary=False,
    )
    link_returned = False

    def current_method() -> Any:
        return login_method(
            "google-recipe",
            "thirdparty",
            provider_id="google",
            provider_user_id="google-user",
        )

    async def get_current_user(user_id: str, *_args: Any):
        if user_id == "target":
            return sdk_user("target", [current_method()])
        if user_id == "google-recipe":
            if link_returned:
                final_owner = "target" if final_owner_matches else "foreign"
                return sdk_user(final_owner, [current_method()], primary=True)
            return sdk_user("standalone-owner", [current_method()], primary=False)
        return None

    async def resolve_user_id(user_id: str, *_args: Any):
        return user_id

    async def get_mapping(user_id: str, mapping_type: str, *_args: Any):
        if (user_id, mapping_type) == ("rownd-1", "EXTERNAL"):
            return GetUserIdMappingOkResult("target", "rownd-1")
        if (user_id, mapping_type) == ("target", "SUPERTOKENS"):
            return GetUserIdMappingOkResult("target", "rownd-1")
        return SimpleNamespace(status="UNKNOWN_MAPPING_ERROR")

    async def exact_metadata(*_args: Any):
        return {"original_rownd_user": {"data": {"user_id": "rownd-1"}}}

    async def read_source():
        return fresh

    async def sibling_link(*_args: Any):
        nonlocal link_returned
        link_returned = True
        return repository.LinkAccountsRecipeUserIdAlreadyLinkedError(
            "target", sdk_user("target", [current_method()]), "linked by sibling"
        )

    monkeypatch.setattr(repository, "get_user", get_current_user)
    monkeypatch.setattr(repository, "resolve_supertokens_user_id", resolve_user_id)
    monkeypatch.setattr(repository, "get_user_id_mapping", get_mapping)
    monkeypatch.setattr(repository, "get_raw_user_metadata", exact_metadata)
    monkeypatch.setattr(repository.accountlinking_asyncio, "link_accounts", sibling_link)

    if final_owner_matches:
        result, changed = await repository._link_fresh_migration_method(
            "google-recipe", identity, existing_owner, fresh, target, {}, read_source
        )
        assert isinstance(result, repository.LinkAccountsRecipeUserIdAlreadyLinkedError)
        assert changed is None
    else:
        with pytest.raises(MigrationError) as raised:
            await repository._link_fresh_migration_method(
                "google-recipe", identity, existing_owner, fresh, target, {}, read_source
            )
        assert raised.value.reason is MigrationErrorReason.IDENTITY_OWNED_BY_ANOTHER_USER


@pytest.mark.asyncio
async def test_verified_standalone_passwordless_method_links_to_pinned_target(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rownd_user = cast(
        JsonDict,
        {
            "data": {"user_id": "rownd-1", "email": "user@example.com"},
            "verified_data": {"email": True},
        },
    )
    fresh = repository.FreshMigrationSource(
        rownd_user, create_rownd_identity_snapshot(rownd_user, "tenant-a")
    )
    identity = fresh.snapshot.expected_identities[0]
    target = PinnedMigrationTarget("target", MigrationTargetSource.MAPPING)
    existing_owner = owner(
        identity.key,
        "standalone-owner",
        recipe_user_id="email-recipe",
        recipe_id="passwordless",
        verified=True,
        is_primary=False,
    )
    method = login_method(
        "email-recipe", "passwordless", email="user@example.com", verified=True
    )
    linked = False

    async def get_current_user(user_id: str, *_args: Any):
        if user_id == "target":
            return sdk_user("target", [method] if linked else [])
        if user_id == "email-recipe":
            return sdk_user(
                "target" if linked else "standalone-owner",
                [method],
                primary=linked,
            )
        return None

    async def resolve_user_id(user_id: str, *_args: Any):
        return user_id

    async def get_mapping(user_id: str, mapping_type: str, *_args: Any):
        if (user_id, mapping_type) == ("rownd-1", "EXTERNAL"):
            return GetUserIdMappingOkResult("target", "rownd-1")
        if (user_id, mapping_type) == ("target", "SUPERTOKENS"):
            return GetUserIdMappingOkResult("target", "rownd-1")
        return SimpleNamespace(status="UNKNOWN_MAPPING_ERROR")

    async def no_metadata(*_args: Any):
        return {}

    async def read_source():
        return fresh

    async def link(*_args: Any):
        nonlocal linked
        linked = True
        return repository.LinkAccountsOkResult(False, sdk_user("target", [method]))

    monkeypatch.setattr(repository, "get_user", get_current_user)
    monkeypatch.setattr(repository, "resolve_supertokens_user_id", resolve_user_id)
    monkeypatch.setattr(repository, "get_user_id_mapping", get_mapping)
    monkeypatch.setattr(repository, "get_raw_user_metadata", no_metadata)
    monkeypatch.setattr(repository.accountlinking_asyncio, "link_accounts", link)

    result, changed = await repository._link_fresh_migration_method(
        "email-recipe", identity, existing_owner, fresh, target, {}, read_source
    )

    assert isinstance(result, repository.LinkAccountsOkResult)
    assert changed is None
    assert linked


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

    async def no_metadata(*_args: Any):
        return {}

    async def unexpected_link(*_args: Any):
        raise AssertionError("raced created identity must not be linked")

    monkeypatch.setattr(repository, "read_fresh_migration_snapshot", read_snapshot)
    monkeypatch.setattr(repository, "create_missing_login_method", create_method)
    monkeypatch.setattr(repository, "get_user", get_created_user)
    monkeypatch.setattr(repository, "sdk_user_id_matches_internal_target", not_linked_to_target)
    monkeypatch.setattr(repository, "resolve_supertokens_user_id", resolve_created)
    monkeypatch.setattr(repository, "get_user_id_mapping", no_mapping)
    monkeypatch.setattr(repository, "get_raw_user_metadata", no_metadata)
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


@pytest.mark.asyncio
async def test_metadata_finalization_detects_concurrent_canonical_change(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rownd_user = cast(
        JsonDict,
        {
            "data": {"user_id": "rownd-1", "email": "user@example.com"},
            "verified_data": {"email": True},
        },
    )
    fresh = repository.FreshMigrationSource(
        rownd_user, create_rownd_identity_snapshot(rownd_user, "tenant-a")
    )
    target = PinnedMigrationTarget("target", MigrationTargetSource.MAPPING)
    durable = snapshot(
        identity_source=fresh.snapshot,
        owners=(
            owner(
                "passwordless:email:user@example.com",
                "target",
                recipe_user_id="canonical",
            ),
        ),
        external_target="target",
        metadata={
            "target": MigrationMetadataState(
                True,
                ValidatedMigrationMetadata(
                    legacy_complete=False,
                    original_rownd_user_id="rownd-1",
                ),
            )
        },
        pointers={
            "target": CanonicalEmailPointerState(CanonicalEmailPointerStatus.ABSENT)
        },
    )
    disposition = classify_migration_snapshot(durable, target)
    assert disposition.mutations == (
        MigrationMutation("WRITE_METADATA", target_user_id="target"),
    )
    metadata_reads = 0
    writes: list[JsonDict] = []

    async def read_source():
        return fresh

    async def read_snapshot(*_args: Any):
        return durable

    async def get_metadata(*_args: Any):
        nonlocal metadata_reads
        metadata_reads += 1
        if metadata_reads == 1:
            return {}
        return {
            "original_rownd_user": {"data": {"user_id": "rownd-1"}},
            "rownd_migration_complete": True,
            "rownd_email_recipe_user_ids": {"tenant-a": "concurrent"},
        }

    async def inspect_metadata(*_args: Any):
        return {"rownd_metadata_source_user_id": "target"}

    async def update_metadata(_user_id: str, metadata: JsonDict, *_args: Any):
        writes.append(metadata)

    monkeypatch.setattr(repository, "read_fresh_migration_snapshot", read_snapshot)
    monkeypatch.setattr(repository, "get_raw_user_metadata", get_metadata)
    monkeypatch.setattr(repository, "inspect_linked_user_metadata", inspect_metadata)
    monkeypatch.setattr(repository.usermetadata_asyncio, "update_user_metadata", update_metadata)

    with pytest.raises(MigrationError) as raised:
        await repository.apply_migration_repairs(
            disposition, fresh, target, cast(Any, SimpleNamespace()), {}, read_source
        )

    assert raised.value.reason is MigrationErrorReason.MIGRATION_INCOMPLETE
    assert raised.value.stage == "metadata_finalize"
    assert len(writes) == 1
    assert writes[0]["rownd_migration_complete"] is True
    assert writes[0]["rownd_email_recipe_user_ids"] == {"tenant-a": "canonical"}


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
    assert len(arranged.create_calls) == 1
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
    target_already_in_tenant: None,
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


@pytest.mark.asyncio
@pytest.mark.parametrize("mutation_type", list(MigrationMutationType))
async def test_uncertain_mutation_result_converges_from_fresh_state_without_repeat(
    monkeypatch: pytest.MonkeyPatch, mutation_type: MigrationMutationType,
    target_already_in_tenant: None,
) -> None:
    rownd_user = cast(JsonDict, {"data": {"user_id": "rownd-1"}, "verified_data": {}})
    fresh = repository.FreshMigrationSource(
        rownd_user, create_rownd_identity_snapshot(rownd_user, "tenant-a")
    )
    target = PinnedMigrationTarget("target", MigrationTargetSource.MAPPING)
    pending = True
    mutation_calls = 0

    async def read_source():
        return fresh

    async def read_snapshot(*_args: Any):
        return cast(Any, object())

    def classify(*_args: Any):
        if pending:
            return MigrationDisposition(
                MigrationDispositionStatus.REPAIRABLE,
                target,
                mutations=(MigrationMutation(mutation_type.value, target_user_id="target"),),
            )
        return MigrationDisposition(MigrationDispositionStatus.COMPLETE, target)

    async def lose_response(*_args: Any, **_kwargs: Any):
        nonlocal pending, mutation_calls
        mutation_calls += 1
        pending = False
        raise TimeoutError("response lost after durable mutation")

    async def no_op(*_args: Any, **_kwargs: Any) -> None:
        return None

    async def session_method(*_args: Any, **_kwargs: Any) -> RecipeUserId:
        return RecipeUserId("recipe-user")

    async def create_session(*_args: Any, **_kwargs: Any):
        return SimpleNamespace(
            get_user_id=lambda _context: "rownd-1",
            get_recipe_user_id=lambda _context: RecipeUserId("recipe-user"),
            get_tenant_id=lambda _context: "tenant-a",
        )

    monkeypatch.setattr(repository, "read_fresh_migration_snapshot", read_snapshot)
    monkeypatch.setattr(repository, "classify_migration_snapshot", classify)
    monkeypatch.setattr(repository, "apply_migration_repairs", lose_response)
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

    assert result == "target"
    assert mutation_calls == 1
    assert "unresolved_mutation" not in migration_state


@pytest.mark.asyncio
async def test_import_response_loss_converges_through_real_repair_branch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rownd_user = cast(JsonDict, {"data": {"user_id": "rownd-1"}, "verified_data": {}})
    fresh = repository.FreshMigrationSource(
        rownd_user, create_rownd_identity_snapshot(rownd_user, "tenant-a")
    )
    mutation = MigrationMutation("IMPORT_USER")
    disposition = MigrationDisposition(
        MigrationDispositionStatus.REPAIRABLE, mutations=(mutation,)
    )
    imported = False
    calls = 0

    async def read_source():
        return fresh

    async def read_snapshot(*_args: Any):
        return cast(Any, object())

    def classify(*_args: Any):
        return (
            MigrationDisposition(MigrationDispositionStatus.COMPLETE)
            if imported
            else disposition
        )

    async def import_then_lose_response(*_args: Any, **_kwargs: Any):
        nonlocal imported, calls
        calls += 1
        imported = True
        raise TimeoutError("import response lost")

    monkeypatch.setattr(repository, "read_fresh_migration_snapshot", read_snapshot)
    monkeypatch.setattr(repository, "classify_migration_snapshot", classify)
    monkeypatch.setattr(repository, "import_user", import_then_lose_response)

    with pytest.raises(TimeoutError):
        await repository.apply_migration_repairs(
            disposition, fresh, None, cast(Any, SimpleNamespace()), {}, read_source
        )
    await repository.apply_migration_repairs(
        disposition, fresh, None, cast(Any, SimpleNamespace()), {}, read_source
    )

    assert imported
    assert calls == 1


@pytest.mark.asyncio
async def test_make_primary_response_loss_converges_through_real_repair_branch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rownd_user = cast(JsonDict, {"data": {"user_id": "rownd-1"}, "verified_data": {}})
    fresh = repository.FreshMigrationSource(
        rownd_user, create_rownd_identity_snapshot(rownd_user, "tenant-a")
    )
    target = PinnedMigrationTarget("target", MigrationTargetSource.MAPPING)
    disposition = MigrationDisposition(
        MigrationDispositionStatus.REPAIRABLE,
        target,
        mutations=(MigrationMutation("MAKE_PRIMARY", target_user_id="target"),),
    )
    primary = False
    calls = 0
    method = login_method("recipe", "thirdparty", provider_id="rownd", provider_user_id="id")

    async def read_source():
        return fresh

    async def read_snapshot(*_args: Any):
        return cast(Any, object())

    async def get_target(*_args: Any):
        return sdk_user("target", [method], primary=primary)

    async def make_primary_then_lose_response(*_args: Any, **_kwargs: Any):
        nonlocal primary, calls
        calls += 1
        primary = True
        raise TimeoutError("make-primary response lost")

    monkeypatch.setattr(repository, "read_fresh_migration_snapshot", read_snapshot)
    monkeypatch.setattr(
        repository,
        "classify_migration_snapshot",
        lambda *_args: MigrationDisposition(MigrationDispositionStatus.COMPLETE, target)
        if primary
        else disposition,
    )
    monkeypatch.setattr(repository, "get_user", get_target)
    monkeypatch.setattr(repository, "ensure_primary_user", make_primary_then_lose_response)

    with pytest.raises(TimeoutError):
        await repository.apply_migration_repairs(
            disposition, fresh, target, cast(Any, SimpleNamespace()), {}, read_source
        )
    await repository.apply_migration_repairs(
        disposition, fresh, target, cast(Any, SimpleNamespace()), {}, read_source
    )

    assert primary
    assert calls == 1


@pytest.mark.asyncio
async def test_identity_create_response_loss_converges_through_real_repair_branch(
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
    created = False
    calls = 0

    async def read_source():
        return fresh

    async def read_snapshot(*_args: Any):
        return cast(Any, object())

    async def create_then_lose_response(*_args: Any, **_kwargs: Any):
        nonlocal created, calls
        calls += 1
        created = True
        raise TimeoutError("identity-create response lost")

    monkeypatch.setattr(repository, "read_fresh_migration_snapshot", read_snapshot)
    monkeypatch.setattr(
        repository,
        "classify_migration_snapshot",
        lambda *_args: MigrationDisposition(MigrationDispositionStatus.COMPLETE, target)
        if created
        else disposition,
    )
    monkeypatch.setattr(repository, "create_missing_login_method", create_then_lose_response)

    with pytest.raises(TimeoutError):
        await repository.apply_migration_repairs(
            disposition, fresh, target, cast(Any, SimpleNamespace()), {}, read_source
        )
    await repository.apply_migration_repairs(
        disposition, fresh, target, cast(Any, SimpleNamespace()), {}, read_source
    )

    assert created
    assert calls == 1


@pytest.mark.asyncio
async def test_email_verification_response_loss_converges_through_real_repair_branch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rownd_user = cast(
        JsonDict,
        {
            "data": {"user_id": "rownd-1", "email": "user@example.com"},
            "verified_data": {"email": True},
        },
    )
    fresh = repository.FreshMigrationSource(
        rownd_user, create_rownd_identity_snapshot(rownd_user, "tenant-a")
    )
    target = PinnedMigrationTarget("target", MigrationTargetSource.MAPPING)
    email_owner = owner(
        "passwordless:email:user@example.com",
        "target",
        recipe_user_id="email-recipe",
        verified=False,
    )
    durable = snapshot(identity_source=fresh.snapshot, owners=(email_owner,))
    disposition = MigrationDisposition(
        MigrationDispositionStatus.REPAIRABLE,
        target,
        mutations=(MigrationMutation("VERIFY_IDENTITY", recipe_user_id="email-recipe"),),
    )
    verified = False
    calls = 0
    method = login_method(
        "email-recipe", "passwordless", email="user@example.com", verified=False
    )

    async def read_source():
        return fresh

    async def read_snapshot(*_args: Any):
        return durable

    async def get_target(*_args: Any):
        return sdk_user("target", [method])

    async def resolve_target(*_args: Any):
        return "target"

    async def create_token(*_args: Any, **_kwargs: Any):
        return SimpleNamespace(status="OK", token="verification-token")

    async def verify_then_lose_response(*_args: Any, **_kwargs: Any):
        nonlocal verified, calls
        calls += 1
        verified = True
        raise TimeoutError("verification response lost")

    monkeypatch.setattr(repository, "read_fresh_migration_snapshot", read_snapshot)
    monkeypatch.setattr(
        repository,
        "classify_migration_snapshot",
        lambda *_args: MigrationDisposition(MigrationDispositionStatus.COMPLETE, target)
        if verified
        else disposition,
    )
    monkeypatch.setattr(repository, "get_user", get_target)
    monkeypatch.setattr(repository, "resolve_supertokens_user_id", resolve_target)
    monkeypatch.setattr(
        repository.emailverification_asyncio, "create_email_verification_token", create_token
    )
    monkeypatch.setattr(
        repository.emailverification_asyncio, "verify_email_using_token", verify_then_lose_response
    )

    with pytest.raises(TimeoutError):
        await repository.apply_migration_repairs(
            disposition, fresh, target, cast(Any, SimpleNamespace()), {}, read_source
        )
    await repository.apply_migration_repairs(
        disposition, fresh, target, cast(Any, SimpleNamespace()), {}, read_source
    )

    assert verified
    assert calls == 1


@pytest.mark.asyncio
async def test_metadata_response_loss_converges_through_real_repair_branch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rownd_user = cast(JsonDict, {"data": {"user_id": "rownd-1"}, "verified_data": {}})
    fresh = repository.FreshMigrationSource(
        rownd_user, create_rownd_identity_snapshot(rownd_user, "tenant-a")
    )
    target = PinnedMigrationTarget("target", MigrationTargetSource.MAPPING)
    durable = snapshot(identity_source=fresh.snapshot, external_target="target")
    disposition = MigrationDisposition(
        MigrationDispositionStatus.REPAIRABLE,
        target,
        mutations=(MigrationMutation("WRITE_METADATA", target_user_id="target"),),
    )
    complete = False
    calls = 0

    async def read_source():
        return fresh

    async def read_snapshot(*_args: Any):
        return durable

    async def get_metadata(*_args: Any):
        return {}

    async def inspect_metadata(*_args: Any):
        return {"rownd_metadata_source_user_id": "target"}

    async def write_then_lose_response(*_args: Any, **_kwargs: Any):
        nonlocal complete, calls
        calls += 1
        complete = True
        raise TimeoutError("metadata response lost")

    monkeypatch.setattr(repository, "read_fresh_migration_snapshot", read_snapshot)
    monkeypatch.setattr(
        repository,
        "classify_migration_snapshot",
        lambda *_args: MigrationDisposition(MigrationDispositionStatus.COMPLETE, target)
        if complete
        else disposition,
    )
    monkeypatch.setattr(repository, "get_raw_user_metadata", get_metadata)
    monkeypatch.setattr(repository, "inspect_linked_user_metadata", inspect_metadata)
    monkeypatch.setattr(
        repository.usermetadata_asyncio, "update_user_metadata", write_then_lose_response
    )

    with pytest.raises(TimeoutError):
        await repository.apply_migration_repairs(
            disposition, fresh, target, cast(Any, SimpleNamespace()), {}, read_source
        )
    await repository.apply_migration_repairs(
        disposition, fresh, target, cast(Any, SimpleNamespace()), {}, read_source
    )

    assert complete
    assert calls == 1


@pytest.mark.asyncio
async def test_link_response_loss_converges_through_real_repair_branch(
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
    foreign_owner = owner(
        identity.key,
        "foreign",
        recipe_user_id="google-recipe",
        recipe_id="thirdparty",
        is_primary=False,
    )
    durable = snapshot(identity_source=fresh.snapshot, owners=(foreign_owner,))
    disposition = MigrationDisposition(
        MigrationDispositionStatus.REPAIRABLE,
        target,
        mutations=(
            MigrationMutation(
                "LINK_IDENTITY", target_user_id="target", recipe_user_id="google-recipe"
            ),
        ),
    )
    linked = False
    calls = 0
    foreign_method = login_method(
        "google-recipe",
        "thirdparty",
        provider_id="google",
        provider_user_id="google-user",
    )

    async def read_source():
        return fresh

    async def read_snapshot(*_args: Any):
        return durable

    async def get_current_user(user_id: str, *_args: Any):
        if user_id == "target":
            return sdk_user("target", [], primary=True)
        return sdk_user("foreign", [foreign_method], primary=False)

    async def resolve(user_id: str, *_args: Any):
        return "target" if linked and user_id == "foreign" else user_id

    async def get_mapping(user_id: str, mapping_type: str, *_args: Any):
        if (user_id, mapping_type) in {
            ("rownd-1", "EXTERNAL"),
            ("target", "SUPERTOKENS"),
        }:
            return GetUserIdMappingOkResult("target", "rownd-1")
        return SimpleNamespace(status="UNKNOWN_MAPPING_ERROR")

    async def get_metadata(*_args: Any):
        return {}

    async def link_then_lose_response(*_args: Any, **_kwargs: Any):
        nonlocal linked, calls
        calls += 1
        linked = True
        raise TimeoutError("link response lost")

    monkeypatch.setattr(repository, "read_fresh_migration_snapshot", read_snapshot)
    monkeypatch.setattr(
        repository,
        "classify_migration_snapshot",
        lambda *_args: MigrationDisposition(MigrationDispositionStatus.COMPLETE, target)
        if linked
        else disposition,
    )
    monkeypatch.setattr(repository, "get_user", get_current_user)
    monkeypatch.setattr(repository, "resolve_supertokens_user_id", resolve)
    monkeypatch.setattr(repository, "get_user_id_mapping", get_mapping)
    monkeypatch.setattr(repository, "get_raw_user_metadata", get_metadata)
    monkeypatch.setattr(repository.accountlinking_asyncio, "link_accounts", link_then_lose_response)

    with pytest.raises(TimeoutError):
        await repository.apply_migration_repairs(
            disposition, fresh, target, cast(Any, SimpleNamespace()), {}, read_source
        )
    await repository.apply_migration_repairs(
        disposition, fresh, target, cast(Any, SimpleNamespace()), {}, read_source
    )

    assert linked
    assert calls == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("mutation_type", list(MigrationMutationType))
async def test_source_change_at_each_repair_boundary_restarts_without_mutation(
    monkeypatch: pytest.MonkeyPatch, mutation_type: MigrationMutationType
) -> None:
    original_user = cast(JsonDict, {"data": {"user_id": "rownd-1"}, "verified_data": {}})
    changed_user = cast(
        JsonDict,
        {
            "data": {"user_id": "rownd-1", "email": "changed@example.com"},
            "verified_data": {"email": True},
        },
    )
    original = repository.FreshMigrationSource(
        original_user, create_rownd_identity_snapshot(original_user, "tenant-a")
    )
    changed = repository.FreshMigrationSource(
        changed_user, create_rownd_identity_snapshot(changed_user, "tenant-a")
    )
    disposition = MigrationDisposition(
        MigrationDispositionStatus.REPAIRABLE,
        PinnedMigrationTarget("target", MigrationTargetSource.THIRD_PARTY),
        mutations=(MigrationMutation(mutation_type.value, target_user_id="target"),),
    )

    async def changed_source():
        return changed

    async def unexpected_snapshot(*_args: Any):
        raise AssertionError("changed source must restart before Core classification")

    monkeypatch.setattr(repository, "read_fresh_migration_snapshot", unexpected_snapshot)

    result = await repository.apply_migration_repairs(
        disposition,
        original,
        disposition.target,
        cast(Any, SimpleNamespace()),
        {},
        changed_source,
    )

    assert result == changed


@pytest.mark.asyncio
async def test_source_change_discards_identity_derived_pin_before_reclassification(
    monkeypatch: pytest.MonkeyPatch,
    target_already_in_tenant: None,
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
        original_user, create_rownd_identity_snapshot(original_user, "tenant-a")
    )
    changed = repository.FreshMigrationSource(
        changed_user, create_rownd_identity_snapshot(changed_user, "tenant-a")
    )
    old_target = PinnedMigrationTarget("old-owner", MigrationTargetSource.VERIFIED_PASSWORDLESS)
    new_target = PinnedMigrationTarget("new-owner", MigrationTargetSource.VERIFIED_PASSWORDLESS)
    source_reads = 0
    classifications = 0

    async def read_source():
        nonlocal source_reads
        source_reads += 1
        return original if source_reads == 1 else changed

    async def read_snapshot(*_args: Any):
        return cast(Any, object())

    def classify(_snapshot: Any, pinned: Optional[PinnedMigrationTarget]):
        nonlocal classifications
        classifications += 1
        if classifications == 1:
            assert pinned is None
            return MigrationDisposition(
                MigrationDispositionStatus.REPAIRABLE,
                old_target,
                mutations=(MigrationMutation("CREATE_MAPPING", target_user_id="old-owner"),),
            )
        assert pinned is None
        return MigrationDisposition(MigrationDispositionStatus.COMPLETE, new_target)

    async def source_changes(*_args: Any, **_kwargs: Any):
        return changed

    async def no_op(*_args: Any, **_kwargs: Any) -> None:
        return None

    async def session_method(*_args: Any, **_kwargs: Any) -> RecipeUserId:
        return RecipeUserId("recipe-user")

    async def create_session(*_args: Any, **_kwargs: Any):
        return SimpleNamespace(
            get_user_id=lambda _context: "rownd-1",
            get_recipe_user_id=lambda _context: RecipeUserId("recipe-user"),
            get_tenant_id=lambda _context: "tenant-a",
        )

    monkeypatch.setattr(repository, "read_fresh_migration_snapshot", read_snapshot)
    monkeypatch.setattr(repository, "classify_migration_snapshot", classify)
    monkeypatch.setattr(repository, "apply_migration_repairs", source_changes)
    monkeypatch.setattr(repository, "record_rownd_app_variant_for_user", no_op)
    monkeypatch.setattr(repository, "read_fresh_migration_session_method", session_method)
    monkeypatch.setattr(repository, "build_rownd_session_claims", lambda *_args: no_op())
    monkeypatch.setattr(repository.session_asyncio, "create_new_session", create_session)

    result = await repository.migrate_rownd_user_and_create_session(
        cast(Any, SimpleNamespace()),
        "rownd-1",
        original,
        cast(Any, SimpleNamespace()),
        cast(Any, SimpleNamespace()),
        cast(Any, SimpleNamespace()),
        "tenant-a",
        None,
        {},
        {},
        read_source,
    )

    assert result == "new-owner"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("final_disposition", "expected_reason", "expected_unresolved"),
    [
        (
            MigrationDisposition(
                MigrationDispositionStatus.BLOCKED,
                reason=MigrationErrorReason.IDENTITY_OWNED_BY_ANOTHER_USER,
            ),
            MigrationErrorReason.IDENTITY_OWNED_BY_ANOTHER_USER,
            None,
        ),
        (
            MigrationDisposition(
                MigrationDispositionStatus.REPAIRABLE,
                mutations=(MigrationMutation("VERIFY_IDENTITY"),),
            ),
            MigrationErrorReason.MIGRATION_INCOMPLETE,
            "VERIFY_IDENTITY",
        ),
        (
            MigrationDisposition(
                MigrationDispositionStatus.REPAIRABLE,
                mutations=(MigrationMutation("FUTURE_MUTATION"),),
            ),
            MigrationErrorReason.MIGRATION_INCOMPLETE,
            None,
        ),
        (
            MigrationDisposition(
                MigrationDispositionStatus.REPAIRABLE,
                mutations=(
                    MigrationMutation("FUTURE_MUTATION"),
                    MigrationMutation("WRITE_METADATA"),
                ),
            ),
            MigrationErrorReason.MIGRATION_INCOMPLETE,
            None,
        ),
    ],
)
async def test_budget_exhaustion_uses_final_fresh_disposition(
    monkeypatch: pytest.MonkeyPatch,
    final_disposition: MigrationDisposition,
    expected_reason: MigrationErrorReason,
    expected_unresolved: Optional[str],
) -> None:
    rownd_user = cast(JsonDict, {"data": {"user_id": "rownd-1"}, "verified_data": {}})
    fresh = repository.FreshMigrationSource(
        rownd_user, create_rownd_identity_snapshot(rownd_user, "tenant-a")
    )
    target = PinnedMigrationTarget("target", MigrationTargetSource.MAPPING)
    repairable = MigrationDisposition(
        MigrationDispositionStatus.REPAIRABLE,
        target,
        mutations=(MigrationMutation("VERIFY_IDENTITY"),),
    )
    classifications = 0

    async def read_source():
        return fresh

    async def read_snapshot(*_args: Any):
        return cast(Any, object())

    def classify(*_args: Any):
        nonlocal classifications
        classifications += 1
        return repairable if classifications <= 2 else final_disposition

    async def no_progress(*_args: Any, **_kwargs: Any) -> None:
        return None

    monkeypatch.setattr(repository, "read_fresh_migration_snapshot", read_snapshot)
    monkeypatch.setattr(repository, "classify_migration_snapshot", classify)
    monkeypatch.setattr(repository, "apply_migration_repairs", no_progress)
    migration_state: JsonDict = {}

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
            migration_state,
            read_source,
        )

    assert raised.value.reason is expected_reason
    assert migration_state.get("unresolved_mutation") == expected_unresolved


@pytest.mark.asyncio
async def test_metadata_failure_reclassifies_without_recreating_identity(
    monkeypatch: pytest.MonkeyPatch,
    target_already_in_tenant: None,
) -> None:
    rownd_user = cast(JsonDict, {"data": {"user_id": "rownd-1"}, "verified_data": {}})
    fresh = repository.FreshMigrationSource(
        rownd_user, create_rownd_identity_snapshot(rownd_user, "tenant-a")
    )
    target = PinnedMigrationTarget("target", MigrationTargetSource.MAPPING)
    identity_exists = False
    complete = False
    identity_creates = 0
    metadata_writes = 0

    async def read_source():
        return fresh

    async def read_snapshot(*_args: Any):
        return cast(Any, object())

    def classify(*_args: Any):
        if complete:
            return MigrationDisposition(MigrationDispositionStatus.COMPLETE, target)
        mutations = []
        if not identity_exists:
            mutations.append(MigrationMutation("CREATE_IDENTITY"))
        mutations.append(MigrationMutation("WRITE_METADATA", target_user_id="target"))
        return MigrationDisposition(
            MigrationDispositionStatus.REPAIRABLE, target, mutations=tuple(mutations)
        )

    async def repair(disposition: MigrationDisposition, *_args: Any, **_kwargs: Any):
        nonlocal identity_exists, complete, identity_creates, metadata_writes
        if any(item.type == "CREATE_IDENTITY" for item in disposition.mutations):
            identity_creates += 1
            identity_exists = True
        metadata_writes += 1
        if metadata_writes == 1:
            raise TimeoutError("metadata response lost")
        complete = True

    async def no_op(*_args: Any, **_kwargs: Any) -> None:
        return None

    async def session_method(*_args: Any, **_kwargs: Any) -> RecipeUserId:
        return RecipeUserId("recipe-user")

    async def create_session(*_args: Any, **_kwargs: Any):
        return SimpleNamespace(
            get_user_id=lambda _context: "rownd-1",
            get_recipe_user_id=lambda _context: RecipeUserId("recipe-user"),
            get_tenant_id=lambda _context: "tenant-a",
        )

    monkeypatch.setattr(repository, "read_fresh_migration_snapshot", read_snapshot)
    monkeypatch.setattr(repository, "classify_migration_snapshot", classify)
    monkeypatch.setattr(repository, "apply_migration_repairs", repair)
    monkeypatch.setattr(repository, "record_rownd_app_variant_for_user", no_op)
    monkeypatch.setattr(repository, "read_fresh_migration_session_method", session_method)
    monkeypatch.setattr(repository, "build_rownd_session_claims", lambda *_args: no_op())
    monkeypatch.setattr(repository.session_asyncio, "create_new_session", create_session)

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

    assert identity_creates == 1
    assert metadata_writes == 2


@pytest.mark.asyncio
async def test_session_failure_retry_reuses_complete_state_without_account_repairs(
    monkeypatch: pytest.MonkeyPatch,
    target_already_in_tenant: None,
) -> None:
    rownd_user = cast(JsonDict, {"data": {"user_id": "rownd-1"}, "verified_data": {}})
    fresh = repository.FreshMigrationSource(
        rownd_user, create_rownd_identity_snapshot(rownd_user, "tenant-a")
    )
    target = PinnedMigrationTarget("target", MigrationTargetSource.MAPPING)
    complete = MigrationDisposition(MigrationDispositionStatus.COMPLETE, target)
    session_calls = 0

    async def read_source():
        return fresh

    async def read_snapshot(*_args: Any):
        return cast(Any, object())

    async def unexpected_repair(*_args: Any, **_kwargs: Any):
        raise AssertionError("complete retry must not mutate account state")

    async def no_op(*_args: Any, **_kwargs: Any) -> None:
        return None

    async def session_method(*_args: Any, **_kwargs: Any) -> RecipeUserId:
        return RecipeUserId("recipe-user")

    async def create_session(*_args: Any, **_kwargs: Any):
        nonlocal session_calls
        session_calls += 1
        if session_calls == 1:
            raise RuntimeError("session transport failed")
        return SimpleNamespace(
            get_user_id=lambda _context: "rownd-1",
            get_recipe_user_id=lambda _context: RecipeUserId("recipe-user"),
            get_tenant_id=lambda _context: "tenant-a",
        )

    monkeypatch.setattr(repository, "read_fresh_migration_snapshot", read_snapshot)
    monkeypatch.setattr(repository, "classify_migration_snapshot", lambda *_args: complete)
    monkeypatch.setattr(repository, "apply_migration_repairs", unexpected_repair)
    monkeypatch.setattr(repository, "record_rownd_app_variant_for_user", no_op)
    monkeypatch.setattr(repository, "read_fresh_migration_session_method", session_method)
    monkeypatch.setattr(repository, "build_rownd_session_claims", lambda *_args: no_op())
    monkeypatch.setattr(repository.session_asyncio, "create_new_session", create_session)

    arguments = (
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
    with pytest.raises(MigrationError) as raised:
        await repository.migrate_rownd_user_and_create_session(*arguments)
    assert raised.value.reason is MigrationErrorReason.SESSION_CREATION_FAILED

    assert await repository.migrate_rownd_user_and_create_session(*arguments) == "target"
    assert session_calls == 2


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("change_during", "blocked_after_change"),
    [("app_variant_metadata", False), ("claim_preparation", True)],
)
async def test_session_preparation_source_change_restarts_before_session_creation(
    monkeypatch: pytest.MonkeyPatch,
    target_already_in_tenant: None,
    change_during: str,
    blocked_after_change: bool,
) -> None:
    user_a = cast(
        JsonDict,
        {
            "data": {"user_id": "rownd-1", "email": "a@example.com"},
            "verified_data": {"email": True},
        },
    )
    user_b = cast(
        JsonDict,
        {
            "data": {"user_id": "rownd-1", "google_id": "source-b"},
            "verified_data": {"google_id": True},
        },
    )
    source_a = repository.FreshMigrationSource(
        user_a, create_rownd_identity_snapshot(user_a, "tenant-a")
    )
    source_b = repository.FreshMigrationSource(
        user_b, create_rownd_identity_snapshot(user_b, "tenant-a")
    )
    current_source = source_a
    target_a = PinnedMigrationTarget("source-a-owner", MigrationTargetSource.THIRD_PARTY)
    target_b = PinnedMigrationTarget("source-b-owner", MigrationTargetSource.MAPPING)
    prepared_targets: list[tuple[str, str]] = []
    session_targets: list[str] = []

    async def read_source():
        return current_source

    async def read_snapshot(source, *_args: Any):
        return source

    def classify(source, pinned):
        is_source_b = any(identity.recipe_id == "thirdparty" for identity in source.expected_identities)
        if is_source_b and blocked_after_change:
            return MigrationDisposition(
                MigrationDispositionStatus.BLOCKED,
                target_b,
                reason=MigrationErrorReason.IDENTITY_OWNED_BY_ANOTHER_USER,
                blocked_identity_type="thirdparty",
            )
        return MigrationDisposition(
            MigrationDispositionStatus.COMPLETE,
            target_b if is_source_b else target_a,
        )

    async def session_method(_source: Any, target: PinnedMigrationTarget, *_args: Any):
        return RecipeUserId("%s-recipe" % target.user_id)

    async def record_variant(_config: Any, target_id: str, *_args: Any):
        nonlocal current_source
        prepared_targets.append(("metadata", target_id))
        if change_during == "app_variant_metadata" and target_id == target_a.user_id:
            current_source = source_b

    async def build_claims(_config: Any, target_id: str, *_args: Any):
        nonlocal current_source
        prepared_targets.append(("claims", target_id))
        if change_during == "claim_preparation" and target_id == target_a.user_id:
            current_source = source_b
        return {"preparedFor": target_id}

    async def create_session(
        _request: Any,
        _tenant_id: str,
        recipe_user_id: RecipeUserId,
        claims: JsonDict,
        *_args: Any,
    ):
        target_id = cast(str, claims["preparedFor"])
        session_targets.append(target_id)
        return SimpleNamespace(
            get_user_id=lambda _context: "rownd-1",
            get_recipe_user_id=lambda _context: recipe_user_id,
            get_tenant_id=lambda _context: "tenant-a",
        )

    monkeypatch.setattr(repository, "read_fresh_migration_snapshot", read_snapshot)
    monkeypatch.setattr(repository, "classify_migration_snapshot", classify)
    monkeypatch.setattr(repository, "read_fresh_migration_session_method", session_method)
    monkeypatch.setattr(repository, "record_rownd_app_variant_for_user", record_variant)
    monkeypatch.setattr(repository, "build_rownd_session_claims", build_claims)
    monkeypatch.setattr(repository.session_asyncio, "create_new_session", create_session)
    migration_state: JsonDict = {
        "path": "source-a-path",
        "blocked_identity_type": "passwordless_email",
        "unresolved_mutation": "WRITE_METADATA",
    }
    arguments = (
        cast(Any, SimpleNamespace()),
        "rownd-1",
        source_a,
        cast(Any, SimpleNamespace()),
        cast(Any, SimpleNamespace()),
        cast(Any, SimpleNamespace()),
        "tenant-a",
        None,
        {},
        migration_state,
        read_source,
    )

    if blocked_after_change:
        with pytest.raises(MigrationError) as raised:
            await repository.migrate_rownd_user_and_create_session(*arguments)
        assert raised.value.reason is MigrationErrorReason.IDENTITY_OWNED_BY_ANOTHER_USER
        assert session_targets == []
        assert migration_state["target_source"] == "mapping"
        assert migration_state["blocked_identity_type"] == "thirdparty"
        assert "path" not in migration_state
        assert "unresolved_mutation" not in migration_state
        assert "supertokens_user_id" not in migration_state
    else:
        result = await repository.migrate_rownd_user_and_create_session(*arguments)
        assert result == target_b.user_id
        assert session_targets == [target_b.user_id]
        assert migration_state["target_source"] == "mapping"
        assert migration_state["path"] == "already_complete"
        assert "blocked_identity_type" not in migration_state
        assert "unresolved_mutation" not in migration_state

    assert ("metadata", target_a.user_id) in prepared_targets
    assert ("claims", target_a.user_id) in prepared_targets


@pytest.mark.asyncio
async def test_metadata_is_not_written_while_other_durable_invariants_are_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rownd_user = cast(JsonDict, {"data": {"user_id": "rownd-1"}, "verified_data": {}})
    fresh = repository.FreshMigrationSource(
        rownd_user, create_rownd_identity_snapshot(rownd_user, "tenant-a")
    )
    target = PinnedMigrationTarget("target", MigrationTargetSource.MAPPING)
    stale_plan = MigrationDisposition(
        MigrationDispositionStatus.REPAIRABLE,
        target,
        mutations=(MigrationMutation("WRITE_METADATA", target_user_id="target"),),
    )
    current_plan = MigrationDisposition(
        MigrationDispositionStatus.REPAIRABLE,
        target,
        mutations=(
            MigrationMutation("CREATE_IDENTITY"),
            MigrationMutation("WRITE_METADATA", target_user_id="target"),
        ),
    )

    async def read_source():
        return fresh

    async def read_snapshot(*_args: Any):
        return cast(Any, object())

    async def unexpected_write(*_args: Any, **_kwargs: Any):
        raise AssertionError("completion metadata must remain last")

    monkeypatch.setattr(repository, "read_fresh_migration_snapshot", read_snapshot)
    monkeypatch.setattr(repository, "classify_migration_snapshot", lambda *_args: current_plan)
    monkeypatch.setattr(repository.usermetadata_asyncio, "update_user_metadata", unexpected_write)

    assert (
        await repository.apply_migration_repairs(
            stale_plan,
            fresh,
            target,
            cast(Any, SimpleNamespace()),
            {},
            read_source,
        )
        is None
    )

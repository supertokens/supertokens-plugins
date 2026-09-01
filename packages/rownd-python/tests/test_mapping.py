from types import SimpleNamespace
from typing import Any, cast

import pytest
from supertokens_python.interfaces import GetUserIdMappingOkResult
from supertokens_python.recipe.accountlinking.interfaces import (
    CreatePrimaryUserRecipeUserIdAlreadyLinkedError,
)
from supertokens_python.recipe.thirdparty.interfaces import ManuallyCreateOrUpdateUserOkResult
from supertokens_python.types import RecipeUserId

import supertokens_rownd.supertokens_repository as impl
from supertokens_rownd.config import (
    as_json_dict,
    build_app_config,
)
from supertokens_rownd.errors import RowndEmailChangeError, RowndPluginError
from supertokens_rownd.supertokens_repository import (
    combine_linked_metadata,
    find_canonical_passwordless_method,
    get_rownd_compat_user,
)
from supertokens_rownd.rownd_compatibility import (
    build_supertokens_fake_email,
    get_canonical_email_recipe_user_id,
    map_rownd_user_to_supertokens,
)
from supertokens_rownd.types import (
    JsonDict,
    JsonList,
    JsonValue,
    RowndPluginConfig,
)
from supertokens_rownd.utils import (
    add_hub_bootstrap_params,
    assert_allowed_bypass_redirect_path,
    clear_supertokens_core_call_cache,
    get_magic_link_bootstrap_params,
    normalize_redirect_to_path_for_client_domain,
    resolve_allowed_client_domain,
    resolve_tenant_id,
)


def rownd_snapshot(user_id: str, **data: Any) -> JsonDict:
    return {
        "state": "enabled",
        "auth_level": "verified",
        "data": {"user_id": user_id, **data},
        "verified_data": {},
    }


def test_combines_linked_metadata_recursively_with_primary_values_winning():
    result = combine_linked_metadata(
        "primary",
        {"shared": "primary", "nested": {"primary": True}},
        [
            (
                "secondary",
                {
                    "shared": "secondary",
                    "nested": {"primary": False, "secondary": True},
                    "original_rownd_user": rownd_snapshot("rownd-user", first_name="Jane"),
                },
            )
        ],
    )

    assert result["combined_metadata"] == {
        "shared": "primary",
        "nested": {"primary": True, "secondary": True},
        "original_rownd_user": rownd_snapshot("rownd-user", first_name="Jane"),
    }


def test_combined_metadata_preserves_defined_empty_values():
    primary = {"none": None, "false": False, "empty": "", "list": [], "zero": 0}
    secondary = {"none": 1, "false": True, "empty": "x", "list": [1], "zero": 1}

    result = combine_linked_metadata("primary", primary, [("secondary", secondary)])

    assert result["combined_metadata"] == primary


def test_combined_metadata_replaces_malformed_primary_rownd_snapshot():
    snapshot = rownd_snapshot("rownd-user")

    result = combine_linked_metadata(
        "primary",
        {"original_rownd_user": {}},
        [("secondary", {"original_rownd_user": snapshot})],
    )
    combined_metadata = cast(JsonDict, result["combined_metadata"])

    assert combined_metadata["original_rownd_user"] == snapshot
    assert result["rownd_metadata_source_user_id"] == "secondary"


def test_combined_metadata_order_is_deterministic_and_prefers_mapped_identity():
    linked: list[tuple[str, JsonDict]] = [
        ("a-stale", {"original_rownd_user": rownd_snapshot("stale", first_name="Stale")}),
        (
            "z-canonical",
            {"original_rownd_user": rownd_snapshot("canonical", first_name="Canonical")},
        ),
    ]

    forward = combine_linked_metadata("primary", {}, linked, "canonical")
    reversed_result = combine_linked_metadata("primary", {}, list(reversed(linked)), "canonical")
    combined_metadata = cast(JsonDict, forward["combined_metadata"])

    assert forward == reversed_result
    assert combined_metadata["original_rownd_user"] == rownd_snapshot(
        "canonical", first_name="Canonical"
    )
    assert forward["rownd_metadata_source_user_id"] == "z-canonical"


def test_combined_metadata_without_mapping_uses_user_id_ordering():
    result = combine_linked_metadata(
        "primary",
        {},
        [
            ("a-rownd", {"shared": "rownd", "original_rownd_user": rownd_snapshot("rownd")}),
            ("z-generic", {"shared": "generic"}),
        ],
    )

    assert cast(JsonDict, result["combined_metadata"])["shared"] == "rownd"


def test_combined_metadata_excludes_linked_pending_verification():
    result = combine_linked_metadata(
        "primary",
        {},
        [
            (
                "secondary",
                {
                    "original_rownd_user": rownd_snapshot("rownd-user"),
                    "rownd_pending_verification": [{"id": "stale"}],
                },
            )
        ],
    )
    combined_metadata = cast(JsonDict, result["combined_metadata"])

    assert "rownd_pending_verification" not in combined_metadata


def test_combined_metadata_excludes_linked_operational_metadata():
    pending: JsonList = [{"id": "primary-pending"}]
    result = combine_linked_metadata(
        "primary",
        {
            "rownd_email_recipe_user_ids": {"public": "primary-email-user"},
            "rownd_pending_verification": pending,
        },
        [
            (
                "secondary",
                {
                    "linked_profile": True,
                    "rownd_email_recipe_user_id": "stale-email-user",
                    "rownd_email_recipe_user_ids": {"tenant": "stale-email-user"},
                    "rownd_migration_complete": True,
                    "rownd_pending_verification": [],
                },
            )
        ],
    )

    assert result["combined_metadata"] == {
        "linked_profile": True,
        "rownd_email_recipe_user_ids": {"public": "primary-email-user"},
        "rownd_pending_verification": pending,
    }
    assert result["metadata_update"] == {"linked_profile": True}


def test_combined_metadata_replaces_stale_primary_snapshot_with_mapped_identity():
    canonical = rownd_snapshot("canonical", first_name="Canonical")
    result = combine_linked_metadata(
        "primary",
        {
            "primary_only": True,
            "original_rownd_user": rownd_snapshot("stale", first_name="Stale"),
        },
        [("canonical-recipe-user", {"original_rownd_user": canonical})],
        "canonical",
    )

    assert result["combined_metadata"] == {
        "primary_only": True,
        "original_rownd_user": canonical,
    }
    assert result["metadata_update"] == {"original_rownd_user": canonical}
    assert result["rownd_metadata_source_user_id"] == "canonical-recipe-user"


def test_combined_metadata_keeps_stale_primary_when_mapped_metadata_is_missing():
    stale_primary = rownd_snapshot("primary-stale")
    result = combine_linked_metadata(
        "primary",
        {"original_rownd_user": stale_primary},
        [("secondary", {"original_rownd_user": rownd_snapshot("secondary-stale")})],
        "canonical",
    )

    assert cast(JsonDict, result["combined_metadata"])["original_rownd_user"] == stale_primary
    assert result["rownd_metadata_source_user_id"] == "primary"


def test_tenant_canonical_id_only_uses_legacy_scalar_when_map_is_absent():
    assert (
        get_canonical_email_recipe_user_id({"rownd_email_recipe_user_id": "legacy"}, "tenant-a")
        == "legacy"
    )
    assert (
        get_canonical_email_recipe_user_id(
            {
                "rownd_email_recipe_user_id": "legacy",
                "rownd_email_recipe_user_ids": {"tenant-b": "tenant-b-method"},
            },
            "tenant-a",
        )
        is None
    )
    assert (
        get_canonical_email_recipe_user_id(
            {"rownd_email_recipe_user_ids": {"tenant-a": "tenant-a-method"}}, "tenant-a"
        )
        == "tenant-a-method"
    )


def test_canonical_passwordless_method_is_tenant_local_and_requires_marker_for_multiple():
    methods = [
        SimpleNamespace(
            recipe_id="passwordless",
            recipe_user_id=SimpleNamespace(get_as_string=lambda value=value: value),
            tenant_ids=[tenant_id],
        )
        for value, tenant_id in (
            ("tenant-a-first", "tenant-a"),
            ("tenant-a-second", "tenant-a"),
            ("tenant-b-method", "tenant-b"),
        )
    ]
    user = cast(Any, SimpleNamespace(login_methods=methods))

    with pytest.raises(RowndEmailChangeError) as error:
        find_canonical_passwordless_method(user, {}, "tenant-a")
    assert error.value.code == "AMBIGUOUS"
    assert (
        find_canonical_passwordless_method(
            user,
            {"rownd_email_recipe_user_ids": {"tenant-a": "tenant-a-second"}},
            "tenant-a",
        )
        is methods[1]
    )
    assert find_canonical_passwordless_method(user, {}, "tenant-b") is methods[2]


def test_throws_when_payload_has_no_data_object():
    try:
        map_rownd_user_to_supertokens({"app_user_id": "rownd-no-data"})
    except RowndPluginError as err:
        assert str(err) == "Rownd user has no user_id"
    else:
        raise AssertionError("expected RowndPluginError")


def test_throws_when_data_user_id_is_missing():
    try:
        map_rownd_user_to_supertokens(
            {"data": {"email": "missing@example.com"}, "verified_data": {"email": True}}
        )
    except RowndPluginError as err:
        assert str(err) == "Rownd user has no user_id"
    else:
        raise AssertionError("expected RowndPluginError")


@pytest.mark.parametrize("provider_id, field", [("google", "google_id"), ("apple", "apple_id")])
def test_maps_provider_user_without_email(provider_id: str, field: str):
    provider_user_id = "%s-user-id" % provider_id
    mapped = map_rownd_user_to_supertokens(
        {
            "data": {"user_id": "u", field: provider_user_id},
            "verified_data": {field: True},
        }
    )

    login_methods = mapped["loginMethods"]
    assert isinstance(login_methods, list)
    login_method = login_methods[0]
    assert isinstance(login_method, dict)
    email = login_method["email"]
    assert isinstance(email, str)
    assert email.startswith("st-%s-" % provider_id)
    assert email.endswith("@stfakeemail.supertokens.com")
    assert login_method["isVerified"] is False


def test_magic_link_bootstrap_params_include_oauth_login_challenge():
    params = get_magic_link_bootstrap_params(
        RowndPluginConfig(rownd_app_key="app-key", rownd_app_secret="secret"),
        oauth_login_challenge="challenge_123",
    )

    assert params["oauthLoginChallenge"] == "challenge_123"


def test_maps_email_passwordless_user():
    mapped = map_rownd_user_to_supertokens(
        {
            "data": {"user_id": "user-1", "email": "a@example.com", "first_name": "Ada"},
            "verified_data": {"email": True},
            "meta": {"source": "rownd"},
        }
    )

    assert mapped["externalUserId"] == "user-1"
    assert mapped["loginMethods"] == [
        {"recipeId": "passwordless", "email": "a@example.com", "isVerified": True}
    ]
    user_metadata = as_json_dict(mapped["userMetadata"])
    assert user_metadata["first_name"] == "Ada"
    assert user_metadata["source"] == "rownd"


@pytest.mark.parametrize(
    ("verified_email", "expected"),
    [
        (True, True),
        ("VERIFIED@example.com", True),
        ("another@example.com", False),
        ("not-a-verification", False),
    ],
)
def test_maps_matching_rownd_email_verification_value(verified_email: JsonValue, expected: bool):
    mapped = map_rownd_user_to_supertokens(
        {
            "data": {"user_id": "verified-email-value", "email": "verified@example.com"},
            "verified_data": {"email": verified_email},
        }
    )

    login_method = cast(dict, cast(list, mapped["loginMethods"])[0])
    assert login_method["isVerified"] is expected


def test_maps_login_methods_to_requested_tenant():
    mapped = map_rownd_user_to_supertokens(
        {
            "data": {"user_id": "user-1", "email": "a@example.com"},
            "verified_data": {"email": True},
        },
        tenant_id="customer-a",
    )

    assert mapped["loginMethods"] == [
        {
            "recipeId": "passwordless",
            "email": "a@example.com",
            "isVerified": True,
            "tenantIds": ["customer-a"],
        }
    ]


def test_resolve_tenant_id_defaults_to_public():
    assert (
        resolve_tenant_id(cast(Any, SimpleNamespace(get_query_param=lambda name: None))) == "public"
    )
    assert (
        resolve_tenant_id(cast(Any, SimpleNamespace(get_query_param=lambda name: "customer-a")))
        == "customer-a"
    )


def test_maps_multiple_rownd_login_methods():
    mapped = map_rownd_user_to_supertokens(
        {
            "data": {
                "user_id": "rownd-existing-google-plus-phone",
                "google_id": "google-existing-plus-phone",
                "phone_number": "+15555550123",
                "email": "existing-google-plus-phone@example.com",
            },
            "verified_data": {"google_id": True, "phone_number": True},
        }
    )

    assert mapped["loginMethods"] == [
        {
            "recipeId": "thirdparty",
            "thirdPartyId": "google",
            "thirdPartyUserId": "google-existing-plus-phone",
            "email": build_supertokens_fake_email("google-existing-plus-phone", "google"),
            "isVerified": False,
            "isPrimary": True,
        },
        {
            "recipeId": "passwordless",
            "phoneNumber": "+15555550123",
            "isVerified": True,
        },
        {
            "recipeId": "passwordless",
            "email": "existing-google-plus-phone@example.com",
            "isVerified": False,
        },
    ]


def test_maps_guest_user():
    mapped = map_rownd_user_to_supertokens(
        {
            "auth_level": "guest",
            "data": {"user_id": "guest-1"},
            "verified_data": {},
        }
    )

    assert mapped["loginMethods"] == [
        {
            "recipeId": "thirdparty",
            "thirdPartyId": "guest",
            "thirdPartyUserId": "guest-1",
            "email": "guest-1@anonymous.local",
            "isVerified": False,
        }
    ]


def test_maps_instant_user():
    mapped = map_rownd_user_to_supertokens(
        {
            "auth_level": "instant",
            "data": {"user_id": "instant-1"},
            "verified_data": {},
        }
    )

    assert mapped["loginMethods"] == [
        {
            "recipeId": "thirdparty",
            "thirdPartyId": "instant",
            "thirdPartyUserId": "instant-1",
            "email": "instant-1@anonymous.local",
            "isVerified": False,
        }
    ]


def test_maps_missing_verified_data_as_unverified_email_user():
    mapped = map_rownd_user_to_supertokens(
        {"data": {"user_id": "rownd-missing-verified-data", "email": "missing@example.com"}}
    )

    assert mapped == {
        "externalUserId": "rownd-missing-verified-data",
        "loginMethods": [
            {"recipeId": "passwordless", "email": "missing@example.com", "isVerified": False}
        ],
        "userMetadata": {
            "rownd_migration_complete": True,
            "original_rownd_user": {
                "data": {"user_id": "rownd-missing-verified-data", "email": "missing@example.com"}
            },
        },
    }


def test_preserves_rownd_app_variants_in_metadata():
    mapped = map_rownd_user_to_supertokens(
        {
            "data": {"user_id": "rownd-variant-user", "email": "variant@example.com"},
            "verified_data": {},
            "attributes": {"rownd:app_variants": ["variant_123"]},
        }
    )

    user_metadata = as_json_dict(mapped["userMetadata"])
    original_rownd_user = as_json_dict(user_metadata["original_rownd_user"])
    assert original_rownd_user["attributes"] == {"rownd:app_variants": ["variant_123"]}


def test_handles_email_and_phone_user():
    mapped = map_rownd_user_to_supertokens(
        {
            "data": {
                "user_id": "rownd-dual",
                "email": "dual@example.com",
                "phone_number": "+1234567890",
            },
            "verified_data": {"email": True, "phone_number": True},
        }
    )

    assert mapped["loginMethods"] == [
        {
            "recipeId": "passwordless",
            "phoneNumber": "+1234567890",
            "isVerified": True,
            "isPrimary": True,
        },
        {"recipeId": "passwordless", "email": "dual@example.com", "isVerified": True},
    ]


def test_adds_hub_bootstrap_params_to_magic_link():
    config = RowndPluginConfig(
        rownd_app_key="app-key",
        rownd_app_secret="secret",
        api_base_path="/auth",
        api_domain="https://api.example.com",
    )

    link = add_hub_bootstrap_params(
        "https://api.example.com/auth/verify?preAuthSessionId=preauth",
        "account/login",
        config,
        {
            "rowndAppVariantId": "variant_123",
            "rowndDisplayContext": "mobile_app",
            "rowndRedirectToPath": "/dashboard",
        },
    )

    assert link == (
        "https://api.example.com/account/login?preAuthSessionId=preauth&appKey=app-key"
        "&apiBasePath=%2Fauth&apiDomain=https%3A%2F%2Fapi.example.com"
        "&appVariantId=variant_123&displayContext=mobile_app&redirectToPath=%2Fdashboard"
    )


def test_adds_hub_bootstrap_params_to_relative_link():
    config = RowndPluginConfig(rownd_app_key="app-key", rownd_app_secret="secret")

    link = add_hub_bootstrap_params(
        "/auth/verify?linkCode=abc",
        "account/verify-email",
        config,
        None,
    )

    assert link == "/account/verify-email?linkCode=abc&appKey=app-key&apiBasePath=%2Fauth"


def test_resolves_allowed_client_domain_from_config_key():
    config = RowndPluginConfig(
        rownd_app_key="app-key",
        rownd_app_secret="secret",
        client_domains={"browser_local": "http://localhost:3000/settings"},
    )

    assert (
        resolve_allowed_client_domain(
            config,
            "https://app.example.com",
            "browser_local",
        )
        == "http://localhost:3000"
    )


def test_resolve_allowed_client_domain_rejects_unknown_key():
    config = RowndPluginConfig(rownd_app_key="app-key", rownd_app_secret="secret")

    with pytest.raises(RowndPluginError, match="Unknown clientDomain key"):
        resolve_allowed_client_domain(config, "https://app.example.com", "missing")


def test_normalizes_confirmation_bypass_absolute_redirect_to_relative_path():
    assert (
        normalize_redirect_to_path_for_client_domain(
            "http://localhost:3000/profile?tab=security#email",
            "http://localhost:3000",
        )
        == "/profile?tab=security#email"
    )


def test_confirmation_bypass_redirect_rejects_cross_domain_url():
    with pytest.raises(RowndPluginError, match="redirectToPath must match clientDomain"):
        normalize_redirect_to_path_for_client_domain(
            "https://evil.example.com/profile",
            "https://app.example.com",
        )


def test_confirmation_bypass_redirect_rejects_schemaless_url():
    with pytest.raises(RowndPluginError, match="redirectToPath cannot be schemaless"):
        normalize_redirect_to_path_for_client_domain(
            "//evil.example.com/profile", "https://app.example.com"
        )


def test_assert_allowed_bypass_redirect_path_requires_allowlist_match():
    config = RowndPluginConfig(
        rownd_app_key="app-key",
        rownd_app_secret="secret",
        cross_device_confirmation_bypass={"allowed_redirect_paths": ["/profile"]},
    )

    assert_allowed_bypass_redirect_path(config, "/profile")
    with pytest.raises(RowndPluginError, match="redirectToPath is not allowed"):
        assert_allowed_bypass_redirect_path(config, "/settings")


def test_assert_allowed_bypass_redirect_path_requires_configuration():
    config = RowndPluginConfig(rownd_app_key="app-key", rownd_app_secret="secret")

    with pytest.raises(RowndPluginError, match="allowed_redirect_paths must be configured"):
        assert_allowed_bypass_redirect_path(config, "/profile")


def test_magic_link_bootstrap_params_include_confirmation_context():
    config = RowndPluginConfig(
        rownd_app_key="app-key",
        rownd_app_secret="secret",
        api_base_path="/auth",
        api_domain="https://api.example.com",
    )

    assert get_magic_link_bootstrap_params(
        config,
        app_variant_id="variant_123",
        display_context="browser",
        redirect_to_path="/profile",
        client_domain_key="browser",
    ) == {
        "appKey": "app-key",
        "apiBasePath": "/auth",
        "apiDomain": "https://api.example.com",
        "appVariantId": "variant_123",
        "displayContext": "browser",
        "redirectToPath": "/profile",
        "clientDomain": "browser",
    }


def test_clear_supertokens_core_call_cache_handles_known_cache_keys():
    user_context = {
        "_default": {
            "coreCallCache": {"/recipe/user": "stale"},
            "core_call_cache": {"/recipe/user": "stale"},
        },
        "custom": "value",
    }

    clear_supertokens_core_call_cache(user_context)

    assert user_context == {
        "_default": {
            "coreCallCache": {},
            "core_call_cache": {},
        },
        "custom": "value",
    }


async def test_existing_thirdparty_owner_is_compared_in_internal_id_space(
    monkeypatch: pytest.MonkeyPatch,
):
    recipe_user_id = RecipeUserId("thirdparty-recipe-user")
    user_context = {"_default": {"coreCallCache": {"mapping": "UNKNOWN_MAPPING_ERROR"}}}

    async def create_or_update(**_kwargs: Any):
        return ManuallyCreateOrUpdateUserOkResult(
            cast(Any, SimpleNamespace(id="rownd-external-id")), recipe_user_id, False
        )

    async def get_mapping(user_id: str, mapping_type: str, context: dict):
        assert mapping_type == "EXTERNAL"
        assert context["_default"]["coreCallCache"] == {}
        if user_id == "rownd-external-id":
            return GetUserIdMappingOkResult("internal-primary-id", user_id)
        return SimpleNamespace(status="UNKNOWN_MAPPING_ERROR")

    monkeypatch.setattr(impl.thirdparty_asyncio, "manually_create_or_update_user", create_or_update)
    monkeypatch.setattr(impl, "get_user_id_mapping", get_mapping)

    result = await impl.create_missing_login_method(
        {
            "recipeId": "thirdparty",
            "thirdPartyId": "google",
            "thirdPartyUserId": "google-user-id",
            "email": "google-user@example.com",
        },
        "public",
        "internal-primary-id",
        cast(Any, user_context),
    )

    assert result == (recipe_user_id, False)


async def test_ensure_primary_user_rejects_concurrent_link_to_foreign_primary(
    monkeypatch: pytest.MonkeyPatch,
):
    recipe_user_id = RecipeUserId("target-recipe-user")
    user_context = {"_default": {"coreCallCache": {"mapping": "stale"}}}

    async def create_primary_user(_recipe_user_id: RecipeUserId, _context: dict):
        return CreatePrimaryUserRecipeUserIdAlreadyLinkedError("foreign-external-id")

    async def get_mapping(user_id: str, mapping_type: str, context: dict):
        assert mapping_type == "EXTERNAL"
        assert context["_default"]["coreCallCache"] == {}
        assert user_id == "foreign-external-id"
        return GetUserIdMappingOkResult("foreign-internal-id", user_id)

    monkeypatch.setattr(impl.accountlinking_asyncio, "create_primary_user", create_primary_user)
    monkeypatch.setattr(impl, "get_user_id_mapping", get_mapping)

    with pytest.raises(RuntimeError, match="different primary user"):
        await impl.ensure_primary_user(
            cast(Any, SimpleNamespace(is_primary_user=False)),
            cast(Any, SimpleNamespace(recipe_user_id=recipe_user_id)),
            "expected-internal-id",
            cast(Any, user_context),
        )


async def test_mapping_conflict_parser_error_requires_fresh_normalized_match(
    monkeypatch: pytest.MonkeyPatch,
):
    user_context = {"_default": {"coreCallCache": {"mapping": "stale"}}}
    mapping_lookups: list[str] = []

    async def create_mapping(*_args: Any, **_kwargs: Any):
        raise KeyError("does_external_user_id_exist")

    async def get_mapping(user_id: str, mapping_type: str, context: dict):
        assert mapping_type == "EXTERNAL"
        assert context["_default"]["coreCallCache"] == {}
        mapping_lookups.append(user_id)
        if user_id == "rownd-user-id":
            return GetUserIdMappingOkResult("externalized-primary-id", user_id)
        return GetUserIdMappingOkResult("expected-internal-id", user_id)

    monkeypatch.setattr(impl, "create_user_id_mapping", create_mapping)
    monkeypatch.setattr(impl, "get_user_id_mapping", get_mapping)

    created = await impl.create_rownd_user_id_mapping(
        "expected-internal-id", "rownd-user-id", cast(Any, user_context)
    )

    assert created is False
    assert mapping_lookups == ["rownd-user-id", "externalized-primary-id"]


async def test_mapping_creation_does_not_hide_unrelated_error(
    monkeypatch: pytest.MonkeyPatch,
):
    async def create_mapping(*_args: Any, **_kwargs: Any):
        raise RuntimeError("network failed")

    monkeypatch.setattr(impl, "create_user_id_mapping", create_mapping)

    with pytest.raises(RuntimeError, match="network failed"):
        await impl.create_rownd_user_id_mapping("expected-internal-id", "rownd-user-id", {})


async def test_raw_bulk_import_clears_active_context_on_unknown_write_outcome(
    monkeypatch: pytest.MonkeyPatch,
):
    class FailingClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args: Any):
            return None

        async def post(self, *args: Any, **kwargs: Any):
            raise RuntimeError("connection lost")

    monkeypatch.setattr(impl.httpx, "AsyncClient", lambda **kwargs: FailingClient())
    context = {"_default": {"core_call_cache": {"user": "stale"}}}

    with pytest.raises(RuntimeError, match="connection lost"):
        await impl.import_user(
            {},
            cast(Any, SimpleNamespace(api_key=None, connection_uri="http://core")),
            context,
        )

    assert context["_default"]["core_call_cache"] == {}


@pytest.mark.parametrize(
    "status,response_text,expected",
    [
        (400, '{"errors":["E006: duplicate identity"]}', True),
        (400, '{"errors":["E006: first","E006: second"]}', True),
        (500, '{"errors":["E006: duplicate identity"]}', False),
        (400, "not-json", False),
        (400, "{}", False),
        (400, '{"errors":[]}', False),
        (400, '{"errors":"E006: duplicate identity"}', False),
        (400, '{"errors":[6]}', False),
        (400, '{"errors":["E006: duplicate identity","E007: invalid user"]}', False),
    ],
)
async def test_bulk_import_duplicate_identity_classifier(
    status: int,
    response_text: str,
    expected: bool,
):
    error = impl._BulkImportError(status, response_text)

    assert impl.is_bulk_import_duplicate_identity_error(error) is expected


async def test_e006_recovery_preserves_import_error_when_reconciliation_finds_nothing(
    monkeypatch: pytest.MonkeyPatch,
):
    import_error = impl._BulkImportError(400, '{"errors":["E006: duplicate identity"]}')

    async def failed_import(*args: Any, **kwargs: Any):
        raise import_error

    async def reconcile_nothing(*args: Any, **kwargs: Any):
        return False

    monkeypatch.setattr(impl, "import_user", failed_import)
    monkeypatch.setattr(impl, "reconcile_rownd_user_with_existing_login_methods", reconcile_nothing)

    with pytest.raises(impl._BulkImportError) as caught:
        await impl._import_user_with_e006_recovery(
            {},
            "public",
            cast(Any, SimpleNamespace()),
            {},
        )

    assert caught.value is import_error


async def test_e006_recovery_propagates_reconciliation_diagnostic(
    monkeypatch: pytest.MonkeyPatch,
):
    import_error = impl._BulkImportError(400, '{"errors":["E006: duplicate identity"]}')
    reconciliation_error = RuntimeError("owner is mapped to another Rownd user")

    async def failed_import(*args: Any, **kwargs: Any):
        raise import_error

    async def unsafe_reconciliation(*args: Any, **kwargs: Any):
        raise reconciliation_error

    monkeypatch.setattr(impl, "import_user", failed_import)
    monkeypatch.setattr(
        impl,
        "reconcile_rownd_user_with_existing_login_methods",
        unsafe_reconciliation,
    )

    with pytest.raises(RuntimeError, match="owner is mapped to another Rownd user") as caught:
        await impl._import_user_with_e006_recovery(
            {},
            "public",
            cast(Any, SimpleNamespace()),
            {},
        )

    assert caught.value is reconciliation_error
    assert caught.value.__cause__ is import_error


async def test_tenant_association_failure_does_not_disassociate_published_state(
    monkeypatch: pytest.MonkeyPatch,
):
    first_recipe_user_id = RecipeUserId("first-recipe-user")
    second_recipe_user_id = RecipeUserId("second-recipe-user")
    association_calls: list[str] = []
    disassociation_calls: list[str] = []

    async def associate(_tenant_id: str, recipe_user_id: RecipeUserId, _context: dict):
        association_calls.append(recipe_user_id.get_as_string())
        if recipe_user_id.get_as_string() == first_recipe_user_id.get_as_string():
            return SimpleNamespace(status="OK", was_already_associated=False)
        return SimpleNamespace(status="UNKNOWN_USER_ID_ERROR")

    async def disassociate(_tenant_id: str, recipe_user_id: RecipeUserId, _context: dict):
        disassociation_calls.append(recipe_user_id.get_as_string())

    monkeypatch.setattr(impl.multitenancy_asyncio, "associate_user_to_tenant", associate)
    monkeypatch.setattr(impl.multitenancy_asyncio, "disassociate_user_from_tenant", disassociate)
    user = SimpleNamespace(
        login_methods=[
            SimpleNamespace(recipe_user_id=first_recipe_user_id, tenant_ids=["public"]),
            SimpleNamespace(recipe_user_id=second_recipe_user_id, tenant_ids=["public"]),
        ]
    )

    with pytest.raises(RuntimeError, match="UNKNOWN_USER_ID_ERROR"):
        await impl.associate_user_login_methods_to_tenant(cast(Any, user), "tenant-a", {})

    assert association_calls == ["first-recipe-user", "second-recipe-user"]
    assert disassociation_calls == []


@pytest.mark.parametrize(
    ("input_auth", "expected"),
    [
        pytest.param({"enforceSameDevicePasswordlessSignIn": True}, True, id="enabled"),
        pytest.param({"enforceSameDevicePasswordlessSignIn": False}, False, id="disabled"),
        pytest.param({}, None, id="omitted"),
    ],
)
def test_same_device_passwordless_policy_maps_to_hub_auth(input_auth: dict, expected: Any):
    config = RowndPluginConfig(
        rownd_app_key="app-key",
        rownd_app_secret="secret",
        app_config={"auth": input_auth},
    )

    body = build_app_config(config, None)

    assert body is not None
    app = as_json_dict(body.get("app"))
    app_config = as_json_dict(app.get("config"))
    hub = as_json_dict(app_config.get("hub"))
    hub_auth = as_json_dict(hub.get("auth"))
    if expected is None:
        assert "enforce_same_device_passwordless_sign_in" not in hub_auth
    else:
        assert hub_auth["enforce_same_device_passwordless_sign_in"] is expected
    assert "enforce_same_device_passwordless_sign_in" not in as_json_dict(hub_auth.get("mobile"))


def test_sub_brand_can_override_same_device_passwordless_policy_without_replacing_auth():
    config = RowndPluginConfig(
        rownd_app_key="app-key",
        rownd_app_secret="secret",
        app_config={
            "auth": {
                "enforceSameDevicePasswordlessSignIn": True,
                "rememberSignInMethod": True,
            }
        },
        sub_brands={"variant_123": {"auth": {"enforceSameDevicePasswordlessSignIn": False}}},
    )

    body = build_app_config(config, "variant_123")

    assert body is not None
    app = as_json_dict(body.get("app"))
    app_config = as_json_dict(app.get("config"))
    hub = as_json_dict(app_config.get("hub"))
    hub_auth = as_json_dict(hub.get("auth"))
    assert hub_auth["enforce_same_device_passwordless_sign_in"] is False
    assert hub_auth["remember_sign_in_method"] is True


def test_google_sign_in_method_matches_node_config_shape():
    config = RowndPluginConfig(
        rownd_app_key="app-key",
        rownd_app_secret="secret",
        app_config={
            "signInMethods": [
                {
                    "method": "google",
                    "clientId": "google-client-id",
                    "signInFasterWithGoogle": "enabled",
                    "oneTap": {
                        "browser": {"autoPrompt": True},
                        "mobileApp": {"delay": 3000},
                    },
                }
            ]
        },
    )

    body = build_app_config(config, None)
    assert body is not None
    app = as_json_dict(body.get("app"))
    app_config = as_json_dict(app.get("config"))
    hub = as_json_dict(app_config.get("hub"))
    auth = as_json_dict(hub.get("auth"))
    sign_in_methods = as_json_dict(auth.get("sign_in_methods"))
    google = as_json_dict(sign_in_methods.get("google"))

    assert google["client_id"] == "google-client-id"
    assert google["sign_in_faster_with_google"] == "enabled"
    assert google["one_tap"] == {
        "browser": {"auto_prompt": True, "delay": 7000},
        "mobile_app": {"auto_prompt": False, "delay": 3000},
    }


def test_apple_sign_in_method_matches_node_config_shape():
    config = RowndPluginConfig(
        rownd_app_key="app-key",
        rownd_app_secret="secret",
        app_config={
            "signInMethods": [
                {
                    "method": "apple",
                    "clientId": "apple-client-id",
                    "webClientType": "web",
                    "iosClientType": "ios",
                    "androidClientType": "android",
                }
            ]
        },
    )

    body = build_app_config(config, None)
    assert body is not None
    app = as_json_dict(body.get("app"))
    app_config = as_json_dict(app.get("config"))
    hub = as_json_dict(app_config.get("hub"))
    auth = as_json_dict(hub.get("auth"))
    sign_in_methods = as_json_dict(auth.get("sign_in_methods"))
    apple = as_json_dict(sign_in_methods.get("apple"))

    assert apple == {
        "enabled": True,
        "client_id": "apple-client-id",
        "web_client_type": "web",
        "ios_client_type": "ios",
        "android_client_type": "android",
    }


def test_anonymous_sign_in_method_matches_node_config_shape():
    guest_config = RowndPluginConfig(
        rownd_app_key="app-key",
        rownd_app_secret="secret",
        app_config={
            "signInMethods": [
                {
                    "method": "anonymous",
                    "displayName": "Continue as guest",
                    "iconLightUrl": "https://cdn.example.com/light.svg",
                    "iconDarkUrl": "https://cdn.example.com/dark.svg",
                }
            ]
        },
    )
    instant_config = RowndPluginConfig(
        rownd_app_key="app-key",
        rownd_app_secret="secret",
        app_config={"signInMethods": [{"method": "anonymous", "type": "instant"}]},
    )

    guest_body = build_app_config(guest_config, None)
    instant_body = build_app_config(instant_config, None)
    assert guest_body is not None
    assert instant_body is not None
    guest_app = as_json_dict(guest_body.get("app"))
    guest_app_config = as_json_dict(guest_app.get("config"))
    guest_hub = as_json_dict(guest_app_config.get("hub"))
    guest_auth = as_json_dict(guest_hub.get("auth"))
    guest_methods = as_json_dict(guest_auth.get("sign_in_methods"))
    instant_app = as_json_dict(instant_body.get("app"))
    instant_app_config = as_json_dict(instant_app.get("config"))
    instant_hub = as_json_dict(instant_app_config.get("hub"))
    instant_auth = as_json_dict(instant_hub.get("auth"))
    instant_methods = as_json_dict(instant_auth.get("sign_in_methods"))

    assert guest_methods["anonymous"] == {
        "enabled": True,
        "type": "guest",
        "display_name": "Continue as guest",
        "icon_light_url": "https://cdn.example.com/light.svg",
        "icon_dark_url": "https://cdn.example.com/dark.svg",
    }
    assert instant_methods["anonymous"] == {"enabled": False}


def test_custom_provider_omits_missing_optional_icons():
    config = RowndPluginConfig(
        rownd_app_key="app-key",
        rownd_app_secret="secret",
        app_config={"signInMethods": [{"method": "github", "displayName": "GitHub"}]},
    )

    body = build_app_config(config, None)
    assert body is not None
    app = as_json_dict(body.get("app"))
    app_config = as_json_dict(app.get("config"))
    hub = as_json_dict(app_config.get("hub"))
    auth = as_json_dict(hub.get("auth"))
    methods = as_json_dict(auth.get("sign_in_methods"))
    github = methods.get("github")

    assert github == {"enabled": True, "display_name": "GitHub"}


@pytest.mark.asyncio
async def test_rownd_compat_user_uses_latest_session_for_last_sign_in_method(
    monkeypatch: pytest.MonkeyPatch,
):
    async def get_user_metadata(user_id: str):
        return {}

    async def get_user(user_id: str, user_context=None):
        passwordless_recipe_user_id = SimpleNamespace(
            get_as_string=lambda: "passwordless-recipe-user"
        )
        google_recipe_user_id = SimpleNamespace(get_as_string=lambda: "google-recipe-user")
        return SimpleNamespace(
            id=user_id,
            time_joined=1000,
            login_methods=[
                SimpleNamespace(
                    recipe_id="passwordless",
                    email="user@example.com",
                    phone_number=None,
                    recipe_user_id=passwordless_recipe_user_id,
                    tenant_ids=["public"],
                    time_joined=2000,
                    last_used=5000,
                ),
                SimpleNamespace(
                    recipe_id="thirdparty",
                    email="user@example.com",
                    phone_number=None,
                    recipe_user_id=google_recipe_user_id,
                    third_party=SimpleNamespace(id="google", user_id="google-123"),
                    verified=True,
                    tenant_ids=["public"],
                    time_joined=3000,
                    last_used=4000,
                ),
            ],
        )

    async def get_latest_session_info(user_id: str, tenant_id: str, user_context=None):
        assert tenant_id == "public"
        return SimpleNamespace(
            recipe_user_id=SimpleNamespace(get_as_string=lambda: "passwordless-recipe-user"),
            time_created=6000,
        )

    async def inspect(user_id: str, user_context=None, user_override=None):
        return {
            "user": user_override or await get_user(user_id, user_context),
            "combined_metadata": await get_user_metadata(user_id),
        }

    monkeypatch.setattr(impl, "inspect_linked_user_metadata", inspect)
    monkeypatch.setattr(impl, "get_latest_session_info", get_latest_session_info)

    user = await get_rownd_compat_user("st-user")
    meta = as_json_dict(user.get("meta"))

    assert meta["first_sign_in_method"] == "email"
    assert meta["last_sign_in_method"] == "email"
    assert meta["last_sign_in"] == "1970-01-01T00:00:06Z"


@pytest.mark.parametrize(
    ("provider_id", "field"),
    [("google", "google_id"), ("apple", "apple_id")],
)
@pytest.mark.asyncio
async def test_rownd_compat_user_includes_provider_id_for_imported_linked_user(
    monkeypatch: pytest.MonkeyPatch, provider_id: str, field: str
):
    async def get_user_metadata(user_id: str):
        return {
            "original_rownd_user": {
                "state": "enabled",
                "auth_level": "verified",
                "data": {"user_id": "rownd-imported-user", "email": "linked@example.com"},
                "verified_data": {"email": True},
                "attributes": {},
            }
        }

    async def get_user(user_id: str, user_context=None):
        return SimpleNamespace(
            id=user_id,
            time_joined=1000,
            login_methods=[
                SimpleNamespace(
                    recipe_id="passwordless",
                    email="linked@example.com",
                    phone_number=None,
                    recipe_user_id=SimpleNamespace(
                        get_as_string=lambda: "passwordless-recipe-user"
                    ),
                    time_joined=2000,
                    verified=True,
                    tenant_ids=["public"],
                ),
                SimpleNamespace(
                    recipe_id="thirdparty",
                    email="linked@example.com",
                    phone_number=None,
                    recipe_user_id=SimpleNamespace(
                        get_as_string=lambda: "%s-recipe-user" % provider_id
                    ),
                    third_party=SimpleNamespace(
                        id=provider_id, user_id="%s-linked-id" % provider_id
                    ),
                    verified=True,
                    tenant_ids=["public"],
                    time_joined=3000,
                ),
            ],
        )

    async def get_latest_session_info(user_id: str, tenant_id: str, user_context=None):
        assert tenant_id == "public"
        return None

    async def inspect(user_id: str, user_context=None, user_override=None):
        return {
            "user": user_override or await get_user(user_id, user_context),
            "combined_metadata": await get_user_metadata(user_id),
        }

    monkeypatch.setattr(impl, "inspect_linked_user_metadata", inspect)
    monkeypatch.setattr(impl, "get_latest_session_info", get_latest_session_info)

    user = await get_rownd_compat_user("st-user")
    data = as_json_dict(user.get("data"))
    verified_data = as_json_dict(user.get("verified_data"))

    assert user["rownd_user"] == "rownd-imported-user"
    assert data["email"] == "linked@example.com"
    assert data[field] == "%s-linked-id" % provider_id
    assert verified_data["email"] == "linked@example.com"
    assert verified_data[field] == "%s-linked-id" % provider_id


@pytest.mark.asyncio
async def test_rownd_compat_user_prefers_canonical_email_method(
    monkeypatch: pytest.MonkeyPatch,
):
    canonical_id = SimpleNamespace(get_as_string=lambda: "canonical-email-method")
    older_id = SimpleNamespace(get_as_string=lambda: "older-email-method")

    async def get_user_metadata(user_id: str):
        return {
            "original_rownd_user": {
                "data": {"user_id": user_id, "email": "stale@example.com"},
                "verified_data": {"email": "stale@example.com"},
            },
            "rownd_email_recipe_user_id": "older-email-method",
            "rownd_email_recipe_user_ids": {"public": "canonical-email-method"},
        }

    async def get_user(user_id: str, user_context=None):
        return SimpleNamespace(
            id=user_id,
            time_joined=1000,
            login_methods=[
                SimpleNamespace(
                    recipe_id="passwordless",
                    email="older@example.com",
                    phone_number=None,
                    recipe_user_id=older_id,
                    verified=True,
                    tenant_ids=["public"],
                    time_joined=1000,
                ),
                SimpleNamespace(
                    recipe_id="passwordless",
                    email="canonical@example.com",
                    phone_number=None,
                    recipe_user_id=canonical_id,
                    verified=True,
                    tenant_ids=["public"],
                    time_joined=2000,
                ),
            ],
        )

    async def get_latest_session_info(user_id: str, tenant_id: str, user_context=None):
        return None

    async def inspect(user_id: str, user_context=None, user_override=None):
        return {
            "user": user_override or await get_user(user_id, user_context),
            "combined_metadata": await get_user_metadata(user_id),
        }

    monkeypatch.setattr(impl, "inspect_linked_user_metadata", inspect)
    monkeypatch.setattr(impl, "get_latest_session_info", get_latest_session_info)

    user = await get_rownd_compat_user("st-user")

    assert as_json_dict(user["data"])["email"] == "canonical@example.com"
    assert as_json_dict(user["verified_data"])["email"] == "canonical@example.com"

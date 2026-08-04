from types import SimpleNamespace
from typing import Any, cast

import pytest

import supertokens_rownd.plugin_implementation as impl
from supertokens_rownd.plugin_implementation import (
    add_hub_bootstrap_params,
    assert_allowed_bypass_redirect_path,
    as_json_dict,
    build_app_config,
    clear_supertokens_core_call_cache,
    get_magic_link_bootstrap_params,
    get_rownd_compat_user,
    map_rownd_user_to_supertokens,
    normalize_redirect_to_path_for_client_domain,
    resolve_allowed_client_domain,
    resolve_tenant_id,
)
from supertokens_rownd.types import RowndPluginConfig, RowndPluginError


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
            "email": "existing-google-plus-phone@example.com",
            "isVerified": True,
            "isPrimary": True,
        },
        {
            "recipeId": "passwordless",
            "phoneNumber": "+15555550123",
            "isVerified": True,
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
            "original_rownd_user": {
                "data": {"user_id": "rownd-missing-verified-data", "email": "missing@example.com"}
            }
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

    async def get_latest_session_info(user_id: str, tenant_id: str):
        assert tenant_id == "public"
        return SimpleNamespace(
            recipe_user_id=SimpleNamespace(get_as_string=lambda: "passwordless-recipe-user"),
            time_created=6000,
        )

    monkeypatch.setattr(impl, "get_user_metadata", get_user_metadata)
    monkeypatch.setattr(impl, "get_user", get_user)
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

    async def get_latest_session_info(user_id: str, tenant_id: str):
        assert tenant_id == "public"
        return None

    monkeypatch.setattr(impl, "get_user_metadata", get_user_metadata)
    monkeypatch.setattr(impl, "get_user", get_user)
    monkeypatch.setattr(impl, "get_latest_session_info", get_latest_session_info)

    user = await get_rownd_compat_user("st-user")
    data = as_json_dict(user.get("data"))
    verified_data = as_json_dict(user.get("verified_data"))

    assert user["rownd_user"] == "rownd-imported-user"
    assert data["email"] == "linked@example.com"
    assert data[field] == "%s-linked-id" % provider_id
    assert verified_data["email"] == "linked@example.com"
    assert verified_data[field] == "%s-linked-id" % provider_id

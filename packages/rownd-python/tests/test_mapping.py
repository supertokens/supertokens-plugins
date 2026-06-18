from types import SimpleNamespace

import pytest

import supertokens_rownd.plugin_implementation as impl
from supertokens_rownd.plugin_implementation import (
    add_hub_bootstrap_params,
    as_json_dict,
    build_app_config,
    get_rownd_compat_user,
    map_rownd_user_to_supertokens,
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


def test_throws_when_google_user_is_missing_email():
    try:
        map_rownd_user_to_supertokens(
            {"data": {"user_id": "u", "google_id": "g"}, "verified_data": {"google_id": True}}
        )
    except RowndPluginError as err:
        assert str(err) == "Rownd Google user is missing email"
    else:
        raise AssertionError("expected RowndPluginError")


def test_throws_when_apple_user_is_missing_email():
    try:
        map_rownd_user_to_supertokens(
            {"data": {"user_id": "u", "apple_id": "a"}, "verified_data": {"apple_id": True}}
        )
    except RowndPluginError as err:
        assert str(err) == "Rownd Apple user is missing email"
    else:
        raise AssertionError("expected RowndPluginError")


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
    assert original_rownd_user["attributes"] == {
        "rownd:app_variants": ["variant_123"]
    }


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
        {"recipeId": "passwordless", "phoneNumber": "+1234567890", "isVerified": True},
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
async def test_rownd_compat_user_uses_latest_session_for_last_sign_in_method(monkeypatch: pytest.MonkeyPatch):
    async def get_user_metadata(user_id: str):
        return {}

    async def get_user(user_id: str, user_context=None):
        passwordless_recipe_user_id = SimpleNamespace(get_as_string=lambda: "passwordless-recipe-user")
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
                    time_joined=3000,
                    last_used=4000,
                ),
            ],
        )

    async def get_latest_session_info(user_id: str):
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

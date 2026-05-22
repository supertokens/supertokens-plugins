from supertokens_rownd.plugin_implementation import add_hub_bootstrap_params, map_rownd_user_to_supertokens
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
    assert mapped["userMetadata"]["first_name"] == "Ada"
    assert mapped["userMetadata"]["source"] == "rownd"


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

    assert mapped["userMetadata"]["original_rownd_user"]["attributes"] == {
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

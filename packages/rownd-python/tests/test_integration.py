from __future__ import annotations

import pytest
import jwt
import httpx
from typing import Any, cast
from urllib.parse import parse_qs, urlparse

from supertokens_python.asyncio import get_user
from supertokens_python.recipe.emailverification import asyncio as emailverification_asyncio
from supertokens_python.recipe.passwordless import asyncio as passwordless_asyncio
from supertokens_python.recipe.session import asyncio as session_asyncio
from supertokens_python.recipe.thirdparty import asyncio as thirdparty_asyncio
from supertokens_python.recipe.usermetadata import asyncio as usermetadata_asyncio

from supertokens_rownd.constants import ROWND_JWT_CLAIMS
from supertokens_rownd.plugin_implementation import complete_pending_email_verification
from supertokens_rownd import create_magic_link_with_confirmation_bypass
from supertokens_rownd.types import RowndPluginError

from conftest import MockRowndClient, auth_headers, make_client, session_headers

pytestmark = pytest.mark.asyncio


class CapturingTelemetryClient:
    def __init__(self, fail: bool = False) -> None:
        self.fail = fail
        self.events: list[dict] = []

    async def record_event(self, event: dict) -> None:
        self.events.append(event)
        if self.fail:
            raise RuntimeError("Telemetry down")


def migrate_rownd_user(client, rownd_client: MockRowndClient, user_id: str, user_info: dict):
    rownd_client.user_id = user_id
    rownd_client.user_info = user_info
    return client.post(
        "/auth/plugin/rownd/migrate",
        headers={"Authorization": "Bearer rownd-token", **session_headers()},
    )


async def test_migrate_user_successfully(core_url: str, rownd_client: MockRowndClient):
    rownd_client.user_id = "py-migrate-user"
    rownd_client.user_info = {
        "data": {
            "user_id": "py-migrate-user",
            "email": "py-migrate-user@example.com",
            "first_name": "Ada",
        },
        "verified_data": {"email": True},
        "meta": {"created": "2026-01-01T00:00:00.000Z"},
    }
    client = make_client(core_url, rownd_client)

    res = client.post(
        "/auth/plugin/rownd/migrate",
        headers={"Authorization": "Bearer rownd-token", **session_headers()},
    )

    assert res.status_code == 200
    assert res.json() == {"status": "OK"}
    assert res.headers.get("st-access-token")

    user = await get_user("py-migrate-user")
    assert user is not None
    metadata = await usermetadata_asyncio.get_user_metadata("py-migrate-user")
    assert metadata.metadata["first_name"] == "Ada"
    assert metadata.metadata["original_rownd_user"]["data"]["user_id"] == "py-migrate-user"


async def test_migrate_missing_auth_header_returns_error(core_url: str, rownd_client: MockRowndClient):
    client = make_client(core_url, rownd_client)

    res = client.post("/auth/plugin/rownd/migrate", headers=session_headers())

    assert res.status_code == 200
    assert res.json() == {"status": "ERROR", "message": "Missing authorization header"}


async def test_migrate_rownd_validation_error_returns_error(
    core_url: str, rownd_client: MockRowndClient
):
    rownd_client.validate_error = RowndPluginError("Invalid token")
    client = make_client(core_url, rownd_client)

    res = client.post(
        "/auth/plugin/rownd/migrate",
        headers={"Authorization": "Bearer bad-token", **session_headers()},
    )

    assert res.status_code == 200
    assert res.json() == {"status": "ERROR", "message": "Invalid token"}


async def test_migrate_rownd_fetch_error_returns_error(core_url: str, rownd_client: MockRowndClient):
    rownd_client.user_id = "py-fetch-fail-user"
    rownd_client.fetch_error = RuntimeError("Fetch failed")
    client = make_client(core_url, rownd_client)

    res = client.post(
        "/auth/plugin/rownd/migrate",
        headers={"Authorization": "Bearer rownd-token", **session_headers()},
    )

    assert res.status_code == 200
    assert res.json() == {"status": "ERROR", "message": "Migration failed"}


async def test_migrate_missing_rownd_user_skips_migration(
    core_url: str, rownd_client: MockRowndClient
):
    rownd_client.user_id = "py-missing-rownd-user"
    rownd_client.user_info = None
    client = make_client(core_url, rownd_client)

    res = client.post(
        "/auth/plugin/rownd/migrate",
        headers={"Authorization": "Bearer rownd-token", **session_headers()},
    )

    assert res.status_code == 200
    assert res.json() == {"status": "OK"}
    assert res.headers.get("st-access-token") is None
    assert await get_user("py-missing-rownd-user") is None


async def test_migrate_bulk_import_500_returns_error(
    core_url: str, rownd_client: MockRowndClient, monkeypatch: pytest.MonkeyPatch
):
    async def post(self, url: str, *args, **kwargs):  # type: ignore[no-untyped-def]
        if str(url).endswith("/bulk-import/import"):
            return httpx.Response(500, text="Internal Server Error")
        return await original_post(self, url, *args, **kwargs)

    original_post = httpx.AsyncClient.post
    monkeypatch.setattr(httpx.AsyncClient, "post", post)
    client = make_client(core_url, rownd_client)

    res = migrate_rownd_user(
        client,
        rownd_client,
        "py-import-fail-user",
        {
            "data": {"user_id": "py-import-fail-user", "email": "import-fail@example.com"},
            "verified_data": {"email": True},
        },
    )

    assert res.status_code == 200
    assert res.json() == {"status": "ERROR", "message": "Migration failed"}


async def test_migrate_bulk_import_malformed_json_returns_error(
    core_url: str, rownd_client: MockRowndClient, monkeypatch: pytest.MonkeyPatch
):
    async def post(self, url: str, *args, **kwargs):  # type: ignore[no-untyped-def]
        if str(url).endswith("/bulk-import/import"):
            return httpx.Response(200, content=b"not-json")
        return await original_post(self, url, *args, **kwargs)

    original_post = httpx.AsyncClient.post
    monkeypatch.setattr(httpx.AsyncClient, "post", post)
    client = make_client(core_url, rownd_client)

    res = migrate_rownd_user(
        client,
        rownd_client,
        "py-import-malformed-user",
        {
            "data": {"user_id": "py-import-malformed-user", "email": "malformed@example.com"},
            "verified_data": {"email": True},
        },
    )

    assert res.status_code == 200
    assert res.json() == {"status": "ERROR", "message": "Migration failed"}


async def test_migrate_bulk_import_missing_user_returns_error(
    core_url: str, rownd_client: MockRowndClient, monkeypatch: pytest.MonkeyPatch
):
    async def post(self, url: str, *args, **kwargs):  # type: ignore[no-untyped-def]
        if str(url).endswith("/bulk-import/import"):
            return httpx.Response(200, json={"status": "OK"})
        return await original_post(self, url, *args, **kwargs)

    original_post = httpx.AsyncClient.post
    monkeypatch.setattr(httpx.AsyncClient, "post", post)
    client = make_client(core_url, rownd_client)

    res = migrate_rownd_user(
        client,
        rownd_client,
        "py-import-missing-user",
        {
            "data": {"user_id": "py-import-missing-user", "email": "missing-user@example.com"},
            "verified_data": {"email": True},
        },
    )

    assert res.status_code == 200
    assert res.json() == {"status": "ERROR", "message": "Migration failed"}


async def test_migrate_phone_user_successfully(core_url: str, rownd_client: MockRowndClient):
    client = make_client(core_url, rownd_client)

    res = migrate_rownd_user(
        client,
        rownd_client,
        "py-phone-user",
        {
            "data": {"user_id": "py-phone-user", "phone_number": "+1234567890"},
            "verified_data": {"phone_number": True},
        },
    )

    assert res.status_code == 200
    assert res.json() == {"status": "OK"}
    user = await get_user("py-phone-user")
    assert user is not None
    assert user.login_methods[0].phone_number == "+1234567890"


async def test_migrate_guest_user_successfully(core_url: str, rownd_client: MockRowndClient):
    client = make_client(core_url, rownd_client)

    res = migrate_rownd_user(
        client,
        rownd_client,
        "py-rownd-guest-user",
        {
            "data": {"user_id": "py-rownd-guest-user"},
            "verified_data": {},
            "auth_level": "guest",
        },
    )

    assert res.status_code == 200
    access_token = res.headers.get("st-access-token")
    assert access_token is not None
    user = await get_user("py-rownd-guest-user")
    assert user is not None
    assert user.login_methods[0].recipe_id == "thirdparty"
    assert user.login_methods[0].third_party is not None
    assert user.login_methods[0].third_party.id == "guest"

    user_res = client.get("/auth/plugin/rownd/user", headers=auth_headers(access_token))
    assert user_res.status_code == 200
    assert user_res.json()["auth_level"] == "guest"


async def test_migrate_google_user_successfully(core_url: str, rownd_client: MockRowndClient):
    client = make_client(core_url, rownd_client)

    res = migrate_rownd_user(
        client,
        rownd_client,
        "py-google-user",
        {
            "data": {
                "user_id": "py-google-user",
                "google_id": "google-123",
                "email": "google-user@example.com",
            },
            "verified_data": {"google_id": True},
        },
    )

    assert res.status_code == 200
    assert res.json() == {"status": "OK"}
    user = await get_user("py-google-user")
    assert user is not None
    assert user.login_methods[0].recipe_id == "thirdparty"
    assert user.login_methods[0].third_party is not None
    assert user.login_methods[0].third_party.id == "google"


async def test_migrate_existing_user_does_not_duplicate(core_url: str, rownd_client: MockRowndClient):
    client = make_client(core_url, rownd_client)
    user_info = {
        "data": {"user_id": "py-duplicate-user", "email": "duplicate@example.com"},
        "verified_data": {"email": True},
    }

    first = migrate_rownd_user(client, rownd_client, "py-duplicate-user", user_info)
    second = migrate_rownd_user(client, rownd_client, "py-duplicate-user", user_info)

    assert first.json() == {"status": "OK"}
    assert second.json() == {"status": "OK"}
    user = await get_user("py-duplicate-user")
    assert user is not None
    assert len(user.login_methods) == 1


async def test_migrate_with_emailverification_enabled_succeeds(
    core_url: str, rownd_client: MockRowndClient
):
    client = make_client(core_url, rownd_client, enable_email_verification=True)

    res = migrate_rownd_user(
        client,
        rownd_client,
        "py-emailverification-migrate-user",
        {
            "data": {
                "user_id": "py-emailverification-migrate-user",
                "email": "ev-migrate@example.com",
            },
            "verified_data": {"email": True},
        },
    )

    assert res.status_code == 200
    assert res.json() == {"status": "OK"}
    assert res.headers.get("st-access-token")


async def test_migrate_records_success_telemetry(core_url: str, rownd_client: MockRowndClient):
    telemetry = CapturingTelemetryClient()
    client = make_client(
        core_url,
        rownd_client,
        plugin_config={"telemetry": {"provider": "custom", "factory": lambda: telemetry}},
    )

    res = migrate_rownd_user(
        client,
        rownd_client,
        "py-telemetry-success-user",
        {
            "data": {"user_id": "py-telemetry-success-user", "email": "telemetry@example.com"},
            "verified_data": {"email": True},
        },
    )

    assert res.json() == {"status": "OK"}
    assert telemetry.events
    assert telemetry.events[-1]["outcome"] == "success"
    assert telemetry.events[-1]["rowndUserId"] == "py-telemetry-success-user"
    assert telemetry.events[-1]["superTokensUserId"] == "py-telemetry-success-user"


async def test_migrate_records_error_telemetry(core_url: str, rownd_client: MockRowndClient):
    telemetry = CapturingTelemetryClient()
    rownd_client.user_id = "py-telemetry-error-user"
    rownd_client.fetch_error = RuntimeError("Fetch failed")
    client = make_client(
        core_url,
        rownd_client,
        plugin_config={"telemetry": {"provider": "custom", "factory": lambda: telemetry}},
    )

    res = client.post(
        "/auth/plugin/rownd/migrate",
        headers={"Authorization": "Bearer rownd-token", **session_headers()},
    )

    assert res.json() == {"status": "ERROR", "message": "Migration failed"}
    assert telemetry.events
    assert telemetry.events[-1]["outcome"] == "error"
    assert telemetry.events[-1]["rowndUserId"] == "py-telemetry-error-user"
    assert telemetry.events[-1]["error"]["message"] == "Fetch failed"


async def test_telemetry_failure_does_not_affect_response(
    core_url: str, rownd_client: MockRowndClient
):
    telemetry = CapturingTelemetryClient(fail=True)
    client = make_client(
        core_url,
        rownd_client,
        plugin_config={"telemetry": {"provider": "custom", "factory": lambda: telemetry}},
    )

    res = migrate_rownd_user(
        client,
        rownd_client,
        "py-telemetry-fail-user",
        {
            "data": {"user_id": "py-telemetry-fail-user", "email": "telemetry-fail@example.com"},
            "verified_data": {"email": True},
        },
    )

    assert res.json() == {"status": "OK"}
    assert telemetry.events


async def test_legacy_session_migration_adds_configured_claims(
    core_url: str, rownd_client: MockRowndClient
):
    rownd_client.user_id = "py-session-user"
    rownd_client.user_info = {
        "data": {
            "user_id": "py-session-user",
            "email": "session@example.com",
            "employee_id": "emp-123",
        },
        "verified_data": {"email": True},
    }
    client = make_client(
        core_url,
        rownd_client,
        plugin_config={
            "schema": {
                "employee_id": {
                    "display_name": "Employee ID",
                    "type": "string",
                    "user_visible": False,
                    "include_in_session_claims": True,
                    "session_claim_name": "employee_id_claim",
                }
            },
            "app_config": {"id": "app_123"},
        },
    )

    res = client.post(
        "/auth/plugin/migrate-session",
        headers={"Authorization": "Bearer rownd-token", **session_headers()},
    )

    assert res.status_code == 200
    access_token = res.headers.get("st-access-token")
    assert access_token is not None
    payload = jwt.decode(access_token, options={"verify_signature": False, "verify_aud": False})
    assert payload["employee_id_claim"] == "emp-123"
    assert payload["app_user_id"] == "py-session-user"
    assert payload[ROWND_JWT_CLAIMS["app_user_id"]] == "py-session-user"
    assert "aud" not in payload

    user_res = client.get("/auth/plugin/rownd/user", headers=auth_headers(access_token))
    assert user_res.status_code == 200
    assert user_res.json()["status"] == "OK"


async def test_legacy_session_migration_uses_metadata_fallback_for_claims(
    core_url: str, rownd_client: MockRowndClient
):
    rownd_client.user_id = "py-session-metadata-user"
    rownd_client.user_info = {
        "data": {"user_id": "py-session-metadata-user", "email": "metadata-session@example.com"},
        "verified_data": {"email": True},
        "meta": {"employee_id": "emp-meta-123"},
    }
    client = make_client(
        core_url,
        rownd_client,
        plugin_config={
            "schema": {
                "employee_id": {
                    "display_name": "Employee ID",
                    "type": "string",
                    "include_in_session_claims": True,
                    "session_claim_name": "employee_id_claim",
                }
            }
        },
    )

    res = client.post(
        "/auth/plugin/migrate-session",
        headers={"Authorization": "Bearer rownd-token", **session_headers()},
    )

    access_token = res.headers.get("st-access-token")
    assert access_token is not None
    payload = jwt.decode(access_token, options={"verify_signature": False, "verify_aud": False})
    assert payload["employee_id_claim"] == "emp-meta-123"


async def test_legacy_session_migration_missing_auth_header_returns_error(
    core_url: str, rownd_client: MockRowndClient
):
    client = make_client(core_url, rownd_client)

    res = client.post("/auth/plugin/migrate-session", headers=session_headers())

    assert res.status_code == 200
    assert res.json() == {"status": "ERROR", "message": "Missing authorization header"}


async def test_legacy_session_migration_validation_error_returns_error(
    core_url: str, rownd_client: MockRowndClient
):
    rownd_client.validate_error = RowndPluginError("Invalid token")
    client = make_client(core_url, rownd_client)

    res = client.post(
        "/auth/plugin/migrate-session",
        headers={"Authorization": "Bearer bad-token", **session_headers()},
    )

    assert res.status_code == 200
    assert res.json() == {"status": "ERROR", "message": "Invalid token"}


async def test_legacy_session_migration_fetch_error_returns_error(
    core_url: str, rownd_client: MockRowndClient
):
    rownd_client.user_id = "py-session-fetch-fail-user"
    rownd_client.fetch_error = RuntimeError("Fetch failed")
    client = make_client(core_url, rownd_client)

    res = client.post(
        "/auth/plugin/migrate-session",
        headers={"Authorization": "Bearer rownd-token", **session_headers()},
    )

    assert res.status_code == 200
    assert res.json() == {"status": "ERROR", "message": "Migration failed"}


async def test_legacy_session_migration_adds_instant_claims(
    core_url: str, rownd_client: MockRowndClient
):
    rownd_client.user_id = "py-session-instant-user"
    rownd_client.user_info = {
        "data": {"user_id": "py-session-instant-user"},
        "verified_data": {},
        "auth_level": "instant",
    }
    client = make_client(core_url, rownd_client)

    res = client.post(
        "/auth/plugin/migrate-session",
        headers={"Authorization": "Bearer rownd-token", **session_headers()},
    )

    access_token = res.headers.get("st-access-token")
    assert access_token is not None
    payload = jwt.decode(access_token, options={"verify_signature": False, "verify_aud": False})
    assert payload["auth_level"] == "instant"
    assert "is_anonymous" not in payload
    assert payload[ROWND_JWT_CLAIMS["is_anonymous"]] is True
    assert "anonymous_id" not in payload


async def test_records_app_variant_membership_once(core_url: str, rownd_client: MockRowndClient):
    client = make_client(
        core_url,
        rownd_client,
        plugin_config={"sub_brands": {"variant_123": {"id": "app_xyz", "name": "Variant App"}}},
    )
    rownd_client.user_id = "py-variant-member-user"
    rownd_client.user_info = {
        "data": {"user_id": "py-variant-member-user", "email": "variant-member@example.com"},
        "verified_data": {"email": True},
    }

    first = client.post(
        "/auth/plugin/rownd/migrate?app_variant_id=variant_123",
        headers={"Authorization": "Bearer rownd-token", **session_headers()},
    )
    second = client.post(
        "/auth/plugin/rownd/migrate?app_variant_id=variant_123",
        headers={"Authorization": "Bearer rownd-token", **session_headers()},
    )

    assert first.json() == {"status": "OK"}
    assert second.json() == {"status": "OK"}
    metadata = await usermetadata_asyncio.get_user_metadata("py-variant-member-user")
    assert metadata.metadata["original_rownd_user"]["attributes"]["rownd:app_variants"] == [
        "variant_123"
    ]


async def test_app_config_defaults_do_not_require_auth(core_url: str, rownd_client: MockRowndClient):
    client = make_client(core_url, rownd_client)

    res = client.get("/auth/plugin/rownd/app-config")

    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "OK"
    assert body["app"]["id"] == ""
    assert body["app"]["name"] == "Test App"
    assert body["app"]["schema"]["first_name"]["display_name"] == "First name"


async def test_app_config_unknown_sub_brand_returns_error(
    core_url: str, rownd_client: MockRowndClient
):
    client = make_client(
        core_url,
        rownd_client,
        plugin_config={
            "sub_brands": {
                "known": {"id": "app_1", "variant": {"id": "known"}},
            }
        },
    )

    res = client.get("/auth/plugin/rownd/app-config?app_variant_id=unknown")

    assert res.status_code == 200
    assert res.json() == {"status": "ERROR", "message": "Unknown Rownd app variant: unknown"}


async def test_app_config_returns_sign_in_methods_from_plugin_config(
    core_url: str, rownd_client: MockRowndClient
):
    client = make_client(
        core_url,
        rownd_client,
        plugin_config={
            "app_config": {
                "signInMethods": [
                    {"method": "email"},
                    {"method": "phone"},
                    {"method": "google", "clientId": "google-client-id"},
                    {"method": "apple", "clientId": "apple-client-id"},
                ]
            }
        },
    )

    res = client.get("/auth/plugin/rownd/app-config")
    methods = res.json()["app"]["config"]["hub"]["auth"]["sign_in_methods"]

    assert res.status_code == 200
    assert methods["email"]["enabled"] is True
    assert methods["phone"]["enabled"] is True
    assert methods["google"]["enabled"] is True
    assert methods["google"]["client_id"] == "google-client-id"
    assert methods["apple"]["enabled"] is True
    assert methods["apple"]["client_id"] == "apple-client-id"


async def test_app_config_returns_branding_and_legal_fields(
    core_url: str, rownd_client: MockRowndClient
):
    client = make_client(
        core_url,
        rownd_client,
        plugin_config={
            "app_config": {
                "id": "app_xyz",
                "name": "Acme App",
                "icon": "https://cdn.acme.com/icon.png",
                "branding": {
                    "primaryColor": "#ff0000",
                    "roundedCorners": False,
                    "darkMode": "dark",
                    "showAppIcon": True,
                },
                "legal": {
                    "companyName": "Acme Corp",
                    "privacyPolicyUrl": "https://acme.com/privacy",
                    "termsConditionsUrl": "https://acme.com/terms",
                    "supportEmail": "support@acme.com",
                },
            }
        },
    )

    res = client.get("/auth/plugin/rownd/app-config")
    app = res.json()["app"]

    assert app["id"] == "app_xyz"
    assert app["name"] == "Acme App"
    assert app["icon"] == "https://cdn.acme.com/icon.png"
    assert app["config"]["customizations"]["primary_color"] == "#ff0000"
    assert app["config"]["hub"]["customizations"]["rounded_corners"] is False
    assert app["config"]["hub"]["customizations"]["dark_mode"] == "dark"
    assert app["config"]["hub"]["auth"]["show_app_icon"] is True
    assert app["config"]["hub"]["legal"] == {
        "company_name": "Acme Corp",
        "privacy_policy_url": "https://acme.com/privacy",
        "terms_conditions_url": "https://acme.com/terms",
        "support_email": "support@acme.com",
    }


async def test_app_config_returns_sub_brand_variant(core_url: str, rownd_client: MockRowndClient):
    client = make_client(
        core_url,
        rownd_client,
        plugin_config={
            "app_config": {
                "id": "app_xyz",
                "name": "Base App",
                "branding": {"primaryColor": "#111111"},
                "signInMethods": [{"method": "email"}],
            },
            "sub_brands": {
                "variant_123": {
                    "id": "app_xyz",
                    "name": "Variant App",
                    "branding": {"primaryColor": "#222222"},
                    "variant": {"id": "variant_123", "name": "Variant App"},
                }
            },
        },
    )

    res = client.get("/auth/plugin/rownd/app-config?app_variant_id=variant_123")
    body = res.json()

    assert body["status"] == "OK"
    assert body["config_type"] == "variant"
    assert body["variant"]["id"] == "variant_123"
    assert body["app"]["name"] == "Variant App"
    assert body["app"]["config"]["customizations"]["primary_color"] == "#222222"


async def test_app_config_returns_operator_schema_and_custom_provider(
    core_url: str, rownd_client: MockRowndClient
):
    client = make_client(
        core_url,
        rownd_client,
        plugin_config={
            "schema": {
                "employee_id": {
                    "display_name": "Employee ID",
                    "type": "string",
                    "owned_by": "app",
                    "user_visible": False,
                    "read_only": True,
                },
                "nickname": {"display_name": "Nickname", "type": "string", "user_visible": True},
            },
            "app_config": {
                "signInMethods": [
                    {
                        "method": "github",
                        "displayName": "GitHub",
                        "iconLightUrl": "https://cdn.example.com/github.png",
                    }
                ]
            },
        },
    )

    res = client.get("/auth/plugin/rownd/app-config")
    app = res.json()["app"]
    github = app["config"]["hub"]["auth"]["sign_in_methods"]["github"]

    assert app["schema"]["employee_id"]["owned_by"] == "app"
    assert app["schema"]["employee_id"]["read_only"] is True
    assert app["schema"]["nickname"]["owned_by"] == "user"
    assert app["schema"]["nickname"]["read_only"] is False
    assert github["enabled"] is True
    assert github["display_name"] == "GitHub"
    assert github["icon_light_url"] == "https://cdn.example.com/github.png"


async def test_app_config_returns_auth_mobile_verification_and_capabilities(
    core_url: str, rownd_client: MockRowndClient
):
    client = make_client(
        core_url,
        rownd_client,
        plugin_config={
            "app_config": {
                "userVerificationFields": ["email", "employee_id"],
                "capabilities": {
                    "ios_app": {
                        "enabled": True,
                        "app_store_url": "https://apps.apple.com/app/acme",
                        "team_id": "TEAM123",
                        "bundle_ids": ["com.acme.app"],
                    },
                    "android_app": {
                        "enabled": True,
                        "play_store_url": "https://play.google.com/store/apps/details?id=com.acme.app",
                        "package_names": ["com.acme.app"],
                    },
                    "web_app": {"enabled": True},
                },
                "auth": {
                    "allowUnverifiedUsers": True,
                    "email": {
                        "fromAddress": "Acme <login@acme.com>",
                        "image": "https://cdn.acme.com/email.png",
                        "subject": "Sign in to Acme",
                        "callToActionText": "Continue",
                        "verifyTemplate": "postmark-template",
                        "customContent": "Use this link to continue.",
                        "customClosingContent": "Thanks, Acme",
                    },
                    "mobile": {
                        "title": "Get Acme",
                        "image": "https://cdn.acme.com/mobile.png",
                        "callToActionText": "Download",
                        "hyperlinkText": "Continue on web",
                        "hyperlinkRedirectUrl": "https://acme.com/web",
                        "customContent": "Install the app for the best experience.",
                    },
                },
            }
        },
    )

    res = client.get("/auth/plugin/rownd/app-config")
    body = res.json()
    auth = body["app"]["config"]["hub"]["auth"]

    assert body["app"]["user_verification_fields"] == ["email", "employee_id"]
    assert body["app"]["config"]["capabilities"]["ios_app"]["team_id"] == "TEAM123"
    assert body["app"]["config"]["capabilities"]["android_app"]["package_names"] == [
        "com.acme.app"
    ]
    assert auth["allow_unverified_users"] is True
    assert auth["email"] == {
        "from_address": "Acme <login@acme.com>",
        "image": "https://cdn.acme.com/email.png",
        "subject": "Sign in to Acme",
        "call_to_action_text": "Continue",
        "verify_template": "postmark-template",
        "custom_content": "Use this link to continue.",
        "custom_closing_content": "Thanks, Acme",
    }
    assert auth["mobile"] == {
        "title": "Get Acme",
        "image": "https://cdn.acme.com/mobile.png",
        "call_to_action_text": "Download",
        "hyperlink_text": "Continue on web",
        "hyperlink_redirect_url": "https://acme.com/web",
        "custom_content": "Install the app for the best experience.",
    }


async def test_app_config_returns_selected_hub_ui_fields(
    core_url: str, rownd_client: MockRowndClient
):
    client = make_client(
        core_url,
        rownd_client,
        plugin_config={
            "app_config": {
                "web": {"enabled": True},
                "bottomSheet": {"enabled": True},
                "profileStorageVersion": "v2",
                "allowedWebOrigins": ["https://app.acme.com"],
                "branding": {
                    "animations": {"loading": "https://cdn.acme.com/loading.json"},
                    "hubPrimaryColor": "#111111",
                    "backgroundColor": "#222222",
                    "fontFamily": "Inter",
                    "hideVerificationIcons": True,
                    "blurBackgroundOpacity": 0.5,
                    "offsetX": 12,
                    "offsetY": 24,
                    "propertyOverrides": {"--rph-button-radius": "20px"},
                    "customScripts": [
                        {"type": "application/javascript", "content": "window.acme = true;"}
                    ],
                },
                "customContent": {
                    "signInModal": {"signInButton": "Log in", "signUpButton": "Create account"},
                    "noAccountMessage": {"title": "No account found"},
                    "mobile": {"origins_to_show_in_bottom_sheet": ["https://app.acme.com"]},
                },
                "profile": {"addSignInMethodsButton": {"enabled": False}},
            }
        },
    )

    res = client.get("/auth/plugin/rownd/app-config")
    config = res.json()["app"]["config"]
    hub = config["hub"]

    assert config["web"] == {"enabled": True}
    assert config["bottom_sheet"] == {"enabled": True}
    assert config["profile_storage_version"] == "v2"
    assert config["customizations"]["animations"] == {
        "loading": "https://cdn.acme.com/loading.json"
    }
    assert hub["allowed_web_origins"] == ["https://app.acme.com"]
    assert hub["customizations"]["primary_color"] == "#111111"
    assert hub["customizations"]["background_color"] == "#222222"
    assert hub["customizations"]["font_family"] == "Inter"
    assert hub["customizations"]["hide_verification_icons"] is True
    assert hub["customizations"]["blur_background_opacity"] == 0.5
    assert hub["customizations"]["offset_x"] == 12
    assert hub["customizations"]["offset_y"] == 24
    assert hub["customizations"]["property_overrides"] == {"--rph-button-radius": "20px"}
    assert hub["custom_scripts"] == [
        {"type": "application/javascript", "content": "window.acme = true;"}
    ]
    assert hub["custom_content"]["sign_in_modal"] == {
        "sign_in_button": "Log in",
        "sign_up_button": "Create account",
    }
    assert hub["custom_content"]["no_account_message"] == {"title": "No account found"}
    assert hub["custom_content"]["mobile"] == {
        "origins_to_show_in_bottom_sheet": ["https://app.acme.com"]
    }
    assert hub["profile"]["add_sign_in_methods_button"] == {"enabled": False}


async def test_app_config_returns_anonymous_instant_config(
    core_url: str, rownd_client: MockRowndClient
):
    instant_client = make_client(
        core_url,
        rownd_client,
        plugin_config={"app_config": {"signInMethods": [{"method": "anonymous", "type": "instant"}]}},
    )
    instant_body = instant_client.get("/auth/plugin/rownd/app-config").json()
    assert instant_body["app"]["config"]["hub"]["auth"]["instant_user"] == {"enabled": True}
    assert (
        instant_body["app"]["config"]["hub"]["auth"]["sign_in_methods"]["anonymous"]["enabled"]
        is False
    )


async def test_app_config_returns_anonymous_guest_config(
    core_url: str, rownd_client: MockRowndClient
):
    guest_client = make_client(
        core_url,
        rownd_client,
        plugin_config={
            "app_config": {
                "signInMethods": [
                    {"method": "anonymous", "type": "guest", "displayName": "Continue as guest"}
                ]
            }
        },
    )
    guest_auth = guest_client.get("/auth/plugin/rownd/app-config").json()["app"]["config"]["hub"]["auth"]
    assert "instant_user" not in guest_auth
    assert guest_auth["sign_in_methods"]["anonymous"] == {
        "enabled": True,
        "type": "guest",
        "display_name": "Continue as guest",
    }


async def test_guest_login_creates_session_with_claims(core_url: str, rownd_client: MockRowndClient):
    client = make_client(core_url, rownd_client)

    res = client.post(
        "/auth/plugin/rownd/guest",
        headers={"Content-Type": "application/json", **session_headers()},
        json={"auth_level": "guest"},
    )

    assert res.status_code == 200
    assert res.json()["status"] == "OK"
    access_token = res.headers.get("st-access-token")
    assert access_token is not None
    st_session = await session_asyncio.get_session_without_request_response(access_token)
    assert st_session is not None
    payload = st_session.get_access_token_payload()
    assert payload["auth_level"] == "guest"
    assert payload["is_anonymous"] is True


async def test_guest_login_uses_instant_provider_for_instant_auth_level(
    core_url: str, rownd_client: MockRowndClient
):
    client = make_client(core_url, rownd_client)

    res = client.post(
        "/auth/plugin/rownd/guest",
        headers={"Content-Type": "application/json", **session_headers()},
        json={"auth_level": "instant"},
    )

    assert res.status_code == 200
    access_token = res.headers.get("st-access-token")
    assert access_token is not None
    st_session = await session_asyncio.get_session_without_request_response(access_token)
    assert st_session is not None
    payload = st_session.get_access_token_payload()
    user = await get_user(st_session.get_user_id())

    assert payload["auth_level"] == "instant"
    assert "anonymous_id" not in payload
    assert user is not None
    assert user.login_methods[0].third_party is not None
    assert user.login_methods[0].third_party.id == "instant"


async def test_creates_confirmation_bypass_magic_link_for_allowlisted_redirect(
    core_url: str, rownd_client: MockRowndClient
):
    make_client(
        core_url,
        rownd_client,
        plugin_config={
            "client_domains": {"browser_local": "http://localhost:3000"},
            "cross_device_confirmation_bypass": {
                "allowed_redirect_paths": ["/profile?tab=security"],
            },
        },
    )

    link = await create_magic_link_with_confirmation_bypass(
        email="bypass@example.com",
        client_domain="browser_local",
        redirect_to_path="http://localhost:3000/profile?tab=security",
        display_context="browser",
    )
    parsed = urlparse(link)
    query = parse_qs(parsed.query)

    assert parsed.scheme == "http"
    assert parsed.netloc == "localhost:3000"
    assert parsed.path == "/account/login"
    assert query["bypassDeviceConfirmation"] == ["true"]
    assert query["redirectToPath"] == ["/profile?tab=security"]
    assert query["clientDomain"] == ["browser_local"]
    assert query["displayContext"] == ["browser"]
    assert parsed.fragment


async def test_confirmation_bypass_magic_link_rejects_unconfigured_allowlist(
    core_url: str, rownd_client: MockRowndClient
):
    make_client(
        core_url,
        rownd_client,
        plugin_config={"client_domains": {"browser": "http://localhost:3000"}},
    )

    with pytest.raises(RowndPluginError, match="allowed_redirect_paths must be configured"):
        await create_magic_link_with_confirmation_bypass(
            email="bypass@example.com",
            redirect_to_path="/profile",
            client_domain="browser",
        )


async def test_confirmation_bypass_validation_endpoint_accepts_allowed_redirect(
    core_url: str, rownd_client: MockRowndClient
):
    client = make_client(
        core_url,
        rownd_client,
        plugin_config={
            "client_domains": {"browser_local": "http://localhost:3000"},
            "cross_device_confirmation_bypass": {"allowed_redirect_paths": ["/profile"]},
        },
    )

    res = client.post(
        "/auth/plugin/passwordless-cross-device-confirmation/validate",
        headers={"Content-Type": "application/json"},
        json={
            "clientDomain": "browser_local",
            "redirectToPath": "http://localhost:3000/profile",
        },
    )

    assert res.status_code == 200
    assert res.json() == {"status": "OK", "bypass": True}


async def test_confirmation_bypass_validation_endpoint_rejects_disallowed_redirect(
    core_url: str, rownd_client: MockRowndClient
):
    client = make_client(
        core_url,
        rownd_client,
        plugin_config={
            "client_domains": {"browser_local": "http://localhost:3000"},
            "cross_device_confirmation_bypass": {"allowed_redirect_paths": ["/profile"]},
        },
    )

    res = client.post(
        "/auth/plugin/passwordless-cross-device-confirmation/validate",
        headers={"Content-Type": "application/json"},
        json={
            "clientDomain": "browser_local",
            "redirectToPath": "https://evil.example.com/profile",
        },
    )

    assert res.status_code == 200
    assert res.json() == {"status": "ERROR", "bypass": False}


async def test_get_user_returns_compatibility_payload(core_url: str, rownd_client: MockRowndClient):
    client = make_client(core_url, rownd_client)
    migrate = migrate_rownd_user(
        client,
        rownd_client,
        "py-compat-user",
        {
            "data": {"user_id": "py-compat-user", "email": "compat@example.com"},
            "verified_data": {"email": True},
            "meta": {"created": "2026-01-01T00:00:00.000Z"},
        },
    )
    access_token = migrate.headers["st-access-token"]

    res = client.get("/auth/plugin/rownd/user", headers=auth_headers(access_token))
    body = res.json()

    assert res.status_code == 200
    assert body["status"] == "OK"
    assert body["rownd_user"] == "py-compat-user"
    assert body["data"]["email"] == "compat@example.com"
    assert body["data"]["first_name"] == ""
    assert body["verified_data"]["email"] == "compat@example.com"
    assert body["state"] == "enabled"
    assert body["auth_level"] == "verified"


async def test_user_endpoint_rejects_without_session(core_url: str, rownd_client: MockRowndClient):
    client = make_client(core_url, rownd_client)

    res = client.get("/auth/plugin/rownd/user")

    assert res.json().get("status") != "OK"


async def test_get_user_returns_payload_for_existing_passwordless_user(
    core_url: str, rownd_client: MockRowndClient
):
    client = make_client(core_url, rownd_client)
    sign_in = await passwordless_asyncio.signinup(
        "public", "non-migrated@example.com", None, None, {}
    )
    session_res = migrate_rownd_user(
        client,
        rownd_client,
        sign_in.user.id,
        {
            "data": {"user_id": sign_in.user.id, "email": "non-migrated@example.com"},
            "verified_data": {"email": True},
        },
    )
    access_token = session_res.headers["st-access-token"]

    res = client.get("/auth/plugin/rownd/user", headers=auth_headers(access_token))
    body = res.json()

    assert res.status_code == 200
    assert body["rownd_user"] == sign_in.user.id
    assert body["data"]["email"] == "non-migrated@example.com"
    assert body["verified_data"]["email"] == "non-migrated@example.com"


@pytest.mark.parametrize(
    ("provider_id", "field"),
    [("google", "google_id"), ("apple", "apple_id")],
)
async def test_get_user_includes_provider_id_for_thirdparty_only_user(
    core_url: str, rownd_client: MockRowndClient, provider_id: str, field: str
):
    client = make_client(core_url, rownd_client)
    email = "%s-thirdparty-only@example.com" % provider_id
    provider_user_id = "%s-thirdparty-only-id" % provider_id
    result = await thirdparty_asyncio.manually_create_or_update_user(
        tenant_id="public",
        third_party_id=provider_id,
        third_party_user_id=provider_user_id,
        email=email,
        is_verified=True,
        user_context={},
    )
    result = cast(Any, result)
    st_session = await session_asyncio.create_new_session_without_request_response(
        "public", result.recipe_user_id, {}, {}, True
    )

    res = client.get(
        "/auth/plugin/rownd/user", headers=auth_headers(st_session.get_access_token())
    )
    body = res.json()

    assert res.status_code == 200
    assert body["status"] == "OK"
    assert body["rownd_user"] == result.user.id
    assert body["data"]["user_id"] == result.user.id
    assert body["data"]["email"] == email
    assert body["data"][field] == provider_user_id
    assert body["verified_data"]["email"] == email
    assert body["verified_data"][field] == provider_user_id
    assert body["auth_level"] == "verified"


async def test_update_user_data_and_reject_app_owned_fields(
    core_url: str, rownd_client: MockRowndClient
):
    client = make_client(
        core_url,
        rownd_client,
        plugin_config={
            "schema": {
                "first_name": {"display_name": "First name", "type": "string"},
                "employee_id": {
                    "display_name": "Employee ID",
                    "type": "string",
                    "owned_by": "app",
                },
            }
        },
    )
    migrate = migrate_rownd_user(
        client,
        rownd_client,
        "py-update-user",
        {
            "data": {"user_id": "py-update-user", "email": "update@example.com"},
            "verified_data": {"email": True},
        },
    )
    access_token = migrate.headers["st-access-token"]

    update_res = client.put(
        "/auth/plugin/rownd/user",
        headers={**auth_headers(access_token), "Content-Type": "application/json"},
        json={"data": {"first_name": "Ada"}},
    )
    reject_res = client.put(
        "/auth/plugin/rownd/user",
        headers={**auth_headers(access_token), "Content-Type": "application/json"},
        json={"data": {"employee_id": "E-123"}},
    )

    assert update_res.status_code == 200
    assert update_res.json()["data"]["first_name"] == "Ada"
    assert reject_res.status_code == 403
    assert reject_res.json()["message"] == "field is not writable: employee_id"


async def test_user_email_update_stores_pending_verification(
    core_url: str, rownd_client: MockRowndClient
):
    client = make_client(core_url, rownd_client, enable_email_verification=True)
    guest = client.post(
        "/auth/plugin/rownd/guest",
        headers={"Content-Type": "application/json", **session_headers()},
        json={"auth_level": "guest"},
    )
    access_token = guest.headers["st-access-token"]
    st_session = await session_asyncio.get_session_without_request_response(access_token)
    assert st_session is not None
    user_id = st_session.get_user_id()

    res = client.put(
        "/auth/plugin/rownd/user",
        headers={**auth_headers(access_token), "Content-Type": "application/json"},
        json={"data": {"email": "new-email@example.com", "first_name": "Grace"}},
    )

    assert res.status_code == 200
    body = res.json()
    assert body["data"].get("email") != "new-email@example.com"
    assert body["data"]["first_name"] == "Grace"
    assert body["verified_data"].get("email") is None
    metadata = await usermetadata_asyncio.get_user_metadata(user_id)
    assert metadata.metadata["first_name"] == "Grace"
    pending = metadata.metadata["rownd_pending_verification"]
    assert len(pending) == 1
    assert pending[0]["field"] == "email"
    assert pending[0]["value"] == "new-email@example.com"


async def test_guest_email_verification_links_passwordless_user(
    memory_core_url: str, rownd_client: MockRowndClient
):
    client = make_client(memory_core_url, rownd_client, enable_email_verification=True)
    guest = client.post(
        "/auth/plugin/rownd/guest",
        headers={"Content-Type": "application/json", **session_headers()},
        json={"auth_level": "instant"},
    )
    access_token = guest.headers["st-access-token"]
    st_session = await session_asyncio.get_session_without_request_response(access_token)
    assert st_session is not None
    guest_user_id = st_session.get_user_id()
    recipe_user_id = st_session.get_recipe_user_id()

    update_res = client.put(
        "/auth/plugin/rownd/user",
        headers={**auth_headers(access_token), "Content-Type": "application/json"},
        json={"data": {"email": "guest-linked@example.com"}},
    )
    assert update_res.status_code == 200

    await complete_pending_email_verification(recipe_user_id, "guest-linked@example.com", {})

    linked_user = await get_user(guest_user_id)
    assert linked_user is not None
    assert linked_user.is_primary_user is True
    assert any(
        method.recipe_id == "passwordless" and method.email == "guest-linked@example.com"
        for method in linked_user.login_methods
    )
    assert any(method.recipe_id == "thirdparty" for method in linked_user.login_methods)
    metadata = await usermetadata_asyncio.get_user_metadata(linked_user.id)
    assert metadata.metadata["rownd_pending_verification"] == []
    assert metadata.metadata["original_rownd_user"]["data"]["email"] == "guest-linked@example.com"
    assert metadata.metadata["original_rownd_user"]["verified_data"]["email"] == "guest-linked@example.com"


async def test_guest_email_verification_links_existing_passwordless_primary(
    memory_core_url: str, rownd_client: MockRowndClient
):
    client = make_client(memory_core_url, rownd_client, enable_email_verification=True)
    existing = await passwordless_asyncio.signinup(
        "public", "existing-primary@example.com", None, None, {}
    )
    guest = client.post(
        "/auth/plugin/rownd/guest",
        headers={"Content-Type": "application/json", **session_headers()},
        json={"auth_level": "guest"},
    )
    access_token = guest.headers["st-access-token"]
    st_session = await session_asyncio.get_session_without_request_response(access_token)
    assert st_session is not None

    update_res = client.put(
        "/auth/plugin/rownd/user",
        headers={**auth_headers(access_token), "Content-Type": "application/json"},
        json={"data": {"email": "existing-primary@example.com"}},
    )
    assert update_res.status_code == 200

    await complete_pending_email_verification(
        st_session.get_recipe_user_id(), "existing-primary@example.com", {}
    )

    linked_user = await get_user(existing.user.id)
    assert linked_user is not None
    assert linked_user.is_primary_user is True
    assert any(
        method.recipe_id == "passwordless" and method.email == "existing-primary@example.com"
        for method in linked_user.login_methods
    )
    assert any(method.recipe_id == "thirdparty" for method in linked_user.login_methods)
    metadata = await usermetadata_asyncio.get_user_metadata(existing.user.id)
    assert metadata.metadata["rownd_pending_verification"] == []
    assert metadata.metadata["original_rownd_user"]["data"]["email"] == "existing-primary@example.com"


async def test_email_verify_route_completes_pending_verification(
    memory_core_url: str, rownd_client: MockRowndClient
):
    client = make_client(memory_core_url, rownd_client, enable_email_verification=True)
    guest = client.post(
        "/auth/plugin/rownd/guest",
        headers={"Content-Type": "application/json", **session_headers()},
        json={"auth_level": "instant"},
    )
    access_token = guest.headers["st-access-token"]
    st_session = await session_asyncio.get_session_without_request_response(access_token)
    assert st_session is not None

    update_res = client.put(
        "/auth/plugin/rownd/user",
        headers={**auth_headers(access_token), "Content-Type": "application/json"},
        json={"data": {"email": "route-verified@example.com"}},
    )
    assert update_res.status_code == 200
    token_result = await emailverification_asyncio.create_email_verification_token(
        "public", st_session.get_recipe_user_id(), "route-verified@example.com", {}
    )
    token = getattr(token_result, "token", None)
    assert isinstance(token, str)

    verify_res = client.post(
        "/auth/user/email/verify",
        headers={"Content-Type": "application/json", "rid": "emailverification", "fdi-version": "1.18"},
        json={"method": "token", "token": token},
    )

    assert verify_res.status_code == 200
    assert verify_res.json() == {"status": "OK"}
    linked_user = await get_user(st_session.get_user_id())
    assert linked_user is not None
    metadata = await usermetadata_asyncio.get_user_metadata(linked_user.id)
    assert metadata.metadata["rownd_pending_verification"] == []
    assert metadata.metadata["original_rownd_user"]["data"]["email"] == "route-verified@example.com"


async def test_email_update_replaces_only_pending_email_entry(
    core_url: str, rownd_client: MockRowndClient
):
    client = make_client(core_url, rownd_client, enable_email_verification=True)
    guest = client.post(
        "/auth/plugin/rownd/guest",
        headers={"Content-Type": "application/json", **session_headers()},
        json={"auth_level": "guest"},
    )
    access_token = guest.headers["st-access-token"]
    st_session = await session_asyncio.get_session_without_request_response(access_token)
    assert st_session is not None
    user_id = st_session.get_user_id()

    old_res = client.put(
        "/auth/plugin/rownd/user",
        headers={**auth_headers(access_token), "Content-Type": "application/json"},
        json={"data": {"email": "old-pending@example.com"}},
    )
    assert old_res.status_code == 200
    metadata = await usermetadata_asyncio.get_user_metadata(user_id)
    old_pending = metadata.metadata["rownd_pending_verification"][0]
    await usermetadata_asyncio.update_user_metadata(
        user_id,
        {
            **metadata.metadata,
            "rownd_pending_verification": [
                old_pending,
                {"id": "phone-pending", "field": "phone_number", "value": "+15555550123"},
            ],
        },
    )

    new_res = client.put(
        "/auth/plugin/rownd/user",
        headers={**auth_headers(access_token), "Content-Type": "application/json"},
        json={"data": {"email": "new-pending@example.com"}},
    )

    assert new_res.status_code == 200
    metadata = await usermetadata_asyncio.get_user_metadata(user_id)
    pending = metadata.metadata["rownd_pending_verification"]
    assert len(pending) == 2
    assert pending[0] == {"id": "phone-pending", "field": "phone_number", "value": "+15555550123"}
    assert pending[1]["field"] == "email"
    assert pending[1]["value"] == "new-pending@example.com"


async def test_email_verification_updates_existing_passwordless_method(
    core_url: str, rownd_client: MockRowndClient
):
    make_client(core_url, rownd_client, enable_email_verification=True)
    sign_in = await passwordless_asyncio.signinup(
        "public", "old-passwordless@example.com", None, None, {}
    )
    await usermetadata_asyncio.update_user_metadata(
        sign_in.user.id,
        {
            "original_rownd_user": {
                "data": {"user_id": sign_in.user.id, "email": "old-passwordless@example.com"},
                "verified_data": {"email": "old-passwordless@example.com"},
            },
            "rownd_pending_verification": [
                {"id": "pending-email", "field": "email", "value": "new-passwordless@example.com"}
            ],
        },
    )

    await complete_pending_email_verification(
        sign_in.recipe_user_id, "new-passwordless@example.com", {}
    )

    user = await get_user(sign_in.user.id)
    assert user is not None
    assert any(
        method.recipe_id == "passwordless" and method.email == "new-passwordless@example.com"
        for method in user.login_methods
    )
    metadata = await usermetadata_asyncio.get_user_metadata(sign_in.user.id)
    assert metadata.metadata["rownd_pending_verification"] == []
    assert metadata.metadata["original_rownd_user"]["data"]["email"] == "new-passwordless@example.com"


async def test_email_verification_does_not_add_passwordless_to_real_thirdparty_user(
    core_url: str, rownd_client: MockRowndClient
):
    make_client(core_url, rownd_client, enable_email_verification=True)
    result = await thirdparty_asyncio.manually_create_or_update_user(
        tenant_id="public",
        third_party_id="google",
        third_party_user_id="google-real-user",
        email="thirdparty-original@example.com",
        is_verified=True,
        user_context={},
    )
    assert getattr(result, "status", "OK") == "OK"
    result = cast(Any, result)
    await usermetadata_asyncio.update_user_metadata(
        result.user.id,
        {
            "original_rownd_user": {
                "data": {"user_id": result.user.id, "email": "thirdparty-original@example.com"},
                "verified_data": {"email": "thirdparty-original@example.com"},
            },
            "rownd_pending_verification": [
                {"id": "pending-email", "field": "email", "value": "thirdparty-updated@example.com"}
            ],
        },
    )

    await complete_pending_email_verification(
        result.recipe_user_id, "thirdparty-updated@example.com", {}
    )

    user = await get_user(result.user.id)
    assert user is not None
    assert len(user.login_methods) == 1
    assert user.login_methods[0].recipe_id == "thirdparty"
    metadata = await usermetadata_asyncio.get_user_metadata(result.user.id)
    assert metadata.metadata["original_rownd_user"]["data"]["email"] == "thirdparty-updated@example.com"


async def test_delete_user_removes_compatibility_user(core_url: str, rownd_client: MockRowndClient):
    client = make_client(core_url, rownd_client)
    migrate = migrate_rownd_user(
        client,
        rownd_client,
        "py-delete-user",
        {
            "data": {"user_id": "py-delete-user", "email": "delete@example.com"},
            "verified_data": {"email": True},
        },
    )
    access_token = migrate.headers["st-access-token"]

    res = client.delete("/auth/plugin/rownd/user", headers=auth_headers(access_token))

    assert res.status_code == 200
    assert res.json() == {"status": "OK"}
    assert await get_user("py-delete-user") is None


async def test_signout_revokes_all_sessions_for_user(core_url: str, rownd_client: MockRowndClient):
    client = make_client(core_url, rownd_client)
    user_info = {
        "data": {"user_id": "py-signout-user", "email": "signout@example.com"},
        "verified_data": {"email": True},
    }
    first = migrate_rownd_user(client, rownd_client, "py-signout-user", user_info)
    second = migrate_rownd_user(client, rownd_client, "py-signout-user", user_info)
    first_access_token = first.headers["st-access-token"]
    second_access_token = second.headers["st-access-token"]
    first_session = await session_asyncio.get_session_without_request_response(first_access_token)
    second_session = await session_asyncio.get_session_without_request_response(second_access_token)
    assert first_session is not None
    assert second_session is not None

    res = client.post("/auth/plugin/rownd/signout", headers=auth_headers(first_access_token))

    assert res.status_code == 200
    assert res.json() == {"status": "OK"}
    assert await session_asyncio.get_session_information(first_session.get_handle()) is None
    assert await session_asyncio.get_session_information(second_session.get_handle()) is None


async def test_signout_rejects_without_session(core_url: str, rownd_client: MockRowndClient):
    client = make_client(core_url, rownd_client)

    res = client.post("/auth/plugin/rownd/signout")

    assert res.json().get("status") != "OK"


async def test_user_meta_rejects_internal_field(core_url: str, rownd_client: MockRowndClient):
    rownd_client.user_id = "py-meta-user"
    rownd_client.user_info = {
        "data": {"user_id": "py-meta-user", "email": "py-meta-user@example.com"},
        "verified_data": {"email": True},
    }
    client = make_client(core_url, rownd_client)
    migrate = client.post(
        "/auth/plugin/rownd/migrate",
        headers={"Authorization": "Bearer rownd-token", **session_headers()},
    )
    access_token = migrate.headers["st-access-token"]

    res = client.put(
        "/auth/plugin/rownd/user/meta",
        headers={**auth_headers(access_token), "Content-Type": "application/json"},
        json={"meta": {"original_rownd_user": {"data": {"user_id": "attacker"}}}},
    )

    assert res.status_code == 403
    assert res.json() == {
        "status": "ERROR",
        "code": 403,
        "message": "field is not writable: original_rownd_user",
    }


async def test_user_meta_gets_and_updates_public_metadata(
    core_url: str, rownd_client: MockRowndClient
):
    client = make_client(core_url, rownd_client)
    migrate = migrate_rownd_user(
        client,
        rownd_client,
        "py-meta-public-user",
        {
            "data": {"user_id": "py-meta-public-user", "email": "meta-public@example.com"},
            "verified_data": {"email": True},
            "meta": {"created": "2026-01-01T00:00:00.000Z"},
        },
    )
    access_token = migrate.headers["st-access-token"]

    update_res = client.put(
        "/auth/plugin/rownd/user/meta",
        headers={**auth_headers(access_token), "Content-Type": "application/json"},
        json={"meta": {"last_passkey_registration_prompt": "2026-04-23T00:00:00.000Z"}},
    )
    get_res = client.get("/auth/plugin/rownd/user/meta", headers=auth_headers(access_token))

    assert update_res.status_code == 200
    assert update_res.json()["meta"] == {
        "created": "2026-01-01T00:00:00.000Z",
        "last_passkey_registration_prompt": "2026-04-23T00:00:00.000Z",
    }
    assert get_res.status_code == 200
    assert get_res.json() == update_res.json()


async def test_user_meta_rejects_without_session(core_url: str, rownd_client: MockRowndClient):
    client = make_client(core_url, rownd_client)

    res = client.put(
        "/auth/plugin/rownd/user/meta",
        headers={"Content-Type": "application/json"},
        json={"meta": {}},
    )

    assert res.json().get("status") != "OK"


async def test_user_field_missing_returns_400(core_url: str, rownd_client: MockRowndClient):
    rownd_client.user_id = "py-field-user"
    rownd_client.user_info = {
        "data": {"user_id": "py-field-user", "email": "py-field-user@example.com"},
        "verified_data": {"email": True},
    }
    client = make_client(core_url, rownd_client)
    migrate = client.post(
        "/auth/plugin/rownd/migrate",
        headers={"Authorization": "Bearer rownd-token", **session_headers()},
    )
    access_token = migrate.headers["st-access-token"]

    res = client.get("/auth/plugin/rownd/user/field", headers=auth_headers(access_token))

    assert res.status_code == 400
    assert res.json() == {"status": "ERROR", "code": 400, "message": "field is required"}


async def test_user_field_gets_updates_and_rejects_app_owned_fields(
    core_url: str, rownd_client: MockRowndClient
):
    client = make_client(core_url, rownd_client)
    migrate = migrate_rownd_user(
        client,
        rownd_client,
        "py-field-update-user",
        {
            "data": {"user_id": "py-field-update-user", "email": "field-update@example.com"},
            "verified_data": {"email": True},
        },
    )
    access_token = migrate.headers["st-access-token"]

    update_res = client.put(
        "/auth/plugin/rownd/user/field?field=last_name",
        headers={**auth_headers(access_token), "Content-Type": "application/json"},
        json={"value": "Lovelace"},
    )
    get_res = client.get(
        "/auth/plugin/rownd/user/field?field=last_name", headers=auth_headers(access_token)
    )
    reject_res = client.put(
        "/auth/plugin/rownd/user/field?field=google_id",
        headers={**auth_headers(access_token), "Content-Type": "application/json"},
        json={"value": "google-123"},
    )

    assert update_res.status_code == 200
    assert update_res.json()["data"]["last_name"] == "Lovelace"
    assert get_res.status_code == 200
    assert get_res.json() == {"status": "OK", "value": "Lovelace"}
    assert reject_res.status_code == 403
    assert reject_res.json()["message"] == "field is not writable: google_id"


async def test_user_field_returns_auth_identity_over_metadata(
    core_url: str, rownd_client: MockRowndClient
):
    client = make_client(core_url, rownd_client)
    migrate = migrate_rownd_user(
        client,
        rownd_client,
        "py-auth-identity-user",
        {
            "data": {"user_id": "py-auth-identity-user", "email": "auth-email@example.com"},
            "verified_data": {"email": True},
        },
    )
    access_token = migrate.headers["st-access-token"]
    await usermetadata_asyncio.update_user_metadata(
        "py-auth-identity-user",
        {
            "email": "metadata-email@example.com",
            "original_rownd_user": {
                "data": {"user_id": "py-auth-identity-user", "email": "rownd-email@example.com"},
                "verified_data": {},
            },
        },
    )

    res = client.get(
        "/auth/plugin/rownd/user/field?field=email", headers=auth_headers(access_token)
    )

    assert res.status_code == 200
    assert res.json() == {"status": "OK", "value": "auth-email@example.com"}


async def test_metadata_structure_preserved_after_user_and_meta_updates(
    core_url: str, rownd_client: MockRowndClient
):
    client = make_client(core_url, rownd_client)
    migrate = migrate_rownd_user(
        client,
        rownd_client,
        "py-metadata-structure-user",
        {
            "data": {"user_id": "py-metadata-structure-user", "email": "structure@example.com"},
            "verified_data": {"email": True},
        },
    )
    access_token = migrate.headers["st-access-token"]

    client.put(
        "/auth/plugin/rownd/user",
        headers={**auth_headers(access_token), "Content-Type": "application/json"},
        json={"data": {"first_name": "John"}},
    )
    client.put(
        "/auth/plugin/rownd/user/meta",
        headers={**auth_headers(access_token), "Content-Type": "application/json"},
        json={"meta": {"custom_field": "custom_value"}},
    )

    metadata = await usermetadata_asyncio.get_user_metadata("py-metadata-structure-user")
    assert metadata.metadata["first_name"] == "John"
    assert metadata.metadata["custom_field"] == "custom_value"
    assert metadata.metadata["original_rownd_user"]["data"]["user_id"] == "py-metadata-structure-user"
    assert "data" not in metadata.metadata
    assert "meta" not in metadata.metadata
    assert "verified_data" not in metadata.metadata
    assert "attributes" not in metadata.metadata

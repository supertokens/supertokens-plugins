from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
import jwt
import httpx
from typing import Any, Optional, cast
from urllib.parse import parse_qs, urlparse

from supertokens_python.asyncio import (
    create_user_id_mapping,
    get_user,
    get_user_count,
    get_user_id_mapping,
    list_users_by_account_info as supertokens_list_users_by_account_info,
)
from supertokens_python.interfaces import GetUserIdMappingOkResult
from supertokens_python.recipe.accountlinking import asyncio as accountlinking_asyncio
from supertokens_python.recipe.emailverification import asyncio as emailverification_asyncio
from supertokens_python.recipe.emailpassword import asyncio as emailpassword_asyncio
from supertokens_python.recipe.multitenancy import asyncio as multitenancy_asyncio
from supertokens_python.recipe.passwordless import asyncio as passwordless_asyncio
from supertokens_python.recipe.session import asyncio as session_asyncio
from supertokens_python.recipe.thirdparty import asyncio as thirdparty_asyncio
from supertokens_python.recipe.thirdparty.types import ThirdPartyInfo
from supertokens_python.recipe.usermetadata import asyncio as usermetadata_asyncio
from supertokens_python.types.base import AccountInfoInput

import supertokens_rownd.plugin_implementation as impl
import supertokens_rownd.plugin as rownd_plugin
from supertokens_rownd.constants import ROWND_JWT_CLAIMS
from supertokens_rownd.plugin_implementation import build_rownd_session_claims, complete_pending_email_verification
from supertokens_rownd import create_magic_link_with_confirmation_bypass
from supertokens_rownd.types import RowndEmailChangeError, RowndPluginConfig, RowndPluginError

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


async def create_primary_thirdparty_and_standalone_passwordless(
    email: str,
    google_id: str,
    thirdparty_email: Optional[str] = None,
    thirdparty_verified: bool = True,
):
    reconciliation_context = {"rowndDisableAutomaticAccountLinking": True}
    thirdparty = cast(
        Any,
        await thirdparty_asyncio.manually_create_or_update_user(
            tenant_id="public",
            third_party_id="google",
            third_party_user_id=google_id,
            email=thirdparty_email or email,
            is_verified=thirdparty_verified,
            user_context=reconciliation_context,
        ),
    )
    thirdparty_primary = await accountlinking_asyncio.create_primary_user(
        thirdparty.recipe_user_id, {}
    )
    passwordless = await passwordless_asyncio.signinup(
        "public", email, None, None, reconciliation_context
    )
    assert getattr(thirdparty_primary, "status", None) == "OK"
    thirdparty_user = await get_user(thirdparty.recipe_user_id.get_as_string())
    passwordless_user = await get_user(passwordless.recipe_user_id.get_as_string())
    assert thirdparty_user is not None and thirdparty_user.is_primary_user
    assert passwordless_user is not None and not passwordless_user.is_primary_user
    assert thirdparty_user.id != passwordless_user.id
    return thirdparty, passwordless


async def start_native_email_change(client, current_email: str, target_email: str):
    sign_in = await passwordless_asyncio.signinup(
        "public", current_email, None, None, {}
    )
    st_session = await session_asyncio.create_new_session_without_request_response(
        "public", sign_in.recipe_user_id, {}, {}, True
    )
    response = client.put(
        "/auth/plugin/rownd/user",
        headers={
            **auth_headers(st_session.get_access_token()),
            "Content-Type": "application/json",
        },
        json={"data": {"email": target_email}},
    )
    assert response.status_code == 200
    return sign_in, st_session


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
    assert res.headers.get("st-refresh-token")
    assert res.headers.get("front-token")

    user = await get_user("py-migrate-user")
    assert user is not None
    metadata = await usermetadata_asyncio.get_user_metadata("py-migrate-user")
    assert metadata.metadata["first_name"] == "Ada"
    assert metadata.metadata["original_rownd_user"]["data"]["user_id"] == "py-migrate-user"
    assert metadata.metadata["rownd_migration_complete"] is True
    session = await session_asyncio.get_session_without_request_response(
        cast(str, res.headers.get("st-access-token"))
    )
    assert session is not None


async def test_migrate_missing_auth_header_returns_error(core_url: str, rownd_client: MockRowndClient):
    client = make_client(core_url, rownd_client)

    res = client.post("/auth/plugin/rownd/migrate", headers=session_headers())

    assert res.status_code == 400
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

    assert res.status_code == 400
    assert res.json() == {"status": "ERROR", "message": "Invalid token"}


async def test_migrate_rownd_fetch_error_returns_error(core_url: str, rownd_client: MockRowndClient):
    rownd_client.user_id = "py-fetch-fail-user"
    rownd_client.fetch_error = RuntimeError("Fetch failed")
    client = make_client(core_url, rownd_client)

    res = client.post(
        "/auth/plugin/rownd/migrate",
        headers={"Authorization": "Bearer rownd-token", **session_headers()},
    )

    assert res.status_code == 400
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

    assert res.status_code == 400
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

    assert res.status_code == 400
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

    assert res.status_code == 400
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
    assert len(user.login_methods) == 2
    thirdparty_method = next(method for method in user.login_methods if method.recipe_id == "thirdparty")
    passwordless_method = next(
        method for method in user.login_methods if method.recipe_id == "passwordless"
    )
    assert thirdparty_method.third_party is not None
    assert thirdparty_method.third_party.id == "google"
    assert thirdparty_method.email is not None
    assert thirdparty_method.email.endswith("@stfakeemail.supertokens.com")
    assert thirdparty_method.verified is False
    assert passwordless_method.email == "google-user@example.com"
    assert passwordless_method.verified is False


async def test_migrate_reconciles_unverified_rownd_email_with_existing_passwordless_account(
    core_url: str, rownd_client: MockRowndClient
):
    client = make_client(core_url, rownd_client)
    email = "migration-unverified-collision@example.com"
    owner = await passwordless_asyncio.signinup("public", email, None, None, {})

    res = migrate_rownd_user(
        client,
        rownd_client,
        "migration-unverified-collision",
        {
            "data": {
                "user_id": "migration-unverified-collision",
                "google_id": "migration-unverified-google",
                "email": email,
            },
            "verified_data": {"google_id": True},
        },
    )

    assert res.status_code == 200
    assert res.json() == {"status": "OK"}
    access_token = res.headers.get("st-access-token")
    assert access_token is not None
    session = await session_asyncio.get_session_without_request_response(access_token)
    assert session is not None
    assert session.get_user_id() == "migration-unverified-collision"
    mapping = await get_user_id_mapping("migration-unverified-collision", "EXTERNAL", {})
    assert getattr(mapping, "supertokens_user_id", None) == owner.user.id
    migrated_user = await get_user("migration-unverified-collision")
    assert migrated_user is not None
    assert any(
        method.recipe_id == "passwordless" and method.email == email
        for method in migrated_user.login_methods
    )
    assert any(
        method.recipe_id == "thirdparty"
        and method.third_party is not None
        and method.third_party.id == "google"
        and method.third_party.user_id == "migration-unverified-google"
        for method in migrated_user.login_methods
    )
    google_owners = await supertokens_list_users_by_account_info(
        "public",
        AccountInfoInput(
            third_party=ThirdPartyInfo("migration-unverified-google", "google")
        ),
        False,
        {},
    )
    assert len(google_owners) == 1


async def test_migration_merges_verified_same_email_singleton_primaries(
    core_url: str, rownd_client: MockRowndClient
):
    client = make_client(core_url, rownd_client)
    rownd_user_id = "migration-split-primary"
    google_id = "migration-split-primary-google"
    email = "migration-split-primary@example.com"
    thirdparty, passwordless = await create_primary_thirdparty_and_standalone_passwordless(
        email, google_id
    )
    passwordless_id = passwordless.recipe_user_id.get_as_string()
    mapping = await create_user_id_mapping(
        thirdparty.user.id, rownd_user_id, force=False, user_context={}
    )
    assert mapping.__class__.__name__ == "CreateUserIdMappingOkResult"

    res = migrate_rownd_user(
        client,
        rownd_client,
        rownd_user_id,
        {
            "data": {
                "user_id": rownd_user_id,
                "google_id": google_id,
                "email": email,
            },
            "verified_data": {"google_id": True, "email": True},
        },
    )

    assert res.status_code == 200
    assert res.json() == {"status": "OK"}
    assert res.headers.get("st-access-token") is not None
    merged = await get_user(rownd_user_id)
    assert merged is not None
    assert merged.id == rownd_user_id
    assert merged.is_primary_user is True
    assert {method.recipe_user_id.get_as_string() for method in merged.login_methods} == {
        rownd_user_id,
        passwordless_id,
    }
    assert all(method.verified for method in merged.login_methods)
    assert (
        len(
            await supertokens_list_users_by_account_info(
                "public",
                AccountInfoInput(third_party=ThirdPartyInfo(google_id, "google")),
                False,
                {},
            )
        )
        == 1
    )
    email_owners = await supertokens_list_users_by_account_info(
        "public", AccountInfoInput(email=email), False, {}
    )
    assert {owner.id for owner in email_owners} == {rownd_user_id}
    metadata = await usermetadata_asyncio.get_user_metadata(thirdparty.user.id)
    assert metadata.metadata["rownd_migration_complete"] is True


async def test_migration_restores_split_user_when_finalization_fails(
    core_url: str,
    rownd_client: MockRowndClient,
    monkeypatch: pytest.MonkeyPatch,
):
    client = make_client(core_url, rownd_client)
    rownd_user_id = "migration-split-primary-rollback"
    google_id = "migration-split-primary-rollback-google"
    email = "migration-split-primary-rollback@example.com"
    thirdparty, passwordless = await create_primary_thirdparty_and_standalone_passwordless(
        email, google_id
    )
    thirdparty_id = thirdparty.recipe_user_id.get_as_string()
    passwordless_id = passwordless.recipe_user_id.get_as_string()
    mapping = await create_user_id_mapping(
        thirdparty.user.id, rownd_user_id, force=False, user_context={}
    )
    assert mapping.__class__.__name__ == "CreateUserIdMappingOkResult"

    async def fail_finalization(*_args: Any, **_kwargs: Any):
        raise RuntimeError("metadata finalization failed")

    monkeypatch.setattr(impl.usermetadata_asyncio, "update_user_metadata", fail_finalization)
    res = migrate_rownd_user(
        client,
        rownd_client,
        rownd_user_id,
        {
            "data": {
                "user_id": rownd_user_id,
                "google_id": google_id,
                "email": email,
            },
            "verified_data": {"google_id": True, "email": True},
        },
    )

    assert res.status_code == 400
    assert res.json() == {"status": "ERROR", "message": "Migration failed"}
    assert res.headers.get("st-access-token") is None
    thirdparty_after = await get_user(thirdparty_id)
    passwordless_after = await get_user(passwordless_id)
    assert thirdparty_after is not None
    assert passwordless_after is not None
    assert thirdparty_after.id == rownd_user_id
    assert passwordless_after.id == passwordless.user.id
    assert thirdparty_after.id != passwordless_after.id
    assert thirdparty_after.is_primary_user is True
    assert passwordless_after.is_primary_user is False
    assert len(thirdparty_after.login_methods) == 1
    assert len(passwordless_after.login_methods) == 1


@pytest.mark.parametrize(
    ("thirdparty_email", "thirdparty_verified"),
    [
        ("migration-split-rejected-other@example.com", True),
        (None, False),
    ],
    ids=["different-email", "unverified-thirdparty"],
)
async def test_migration_rejects_unsafe_split_user_linking(
    core_url: str,
    rownd_client: MockRowndClient,
    thirdparty_email: Optional[str],
    thirdparty_verified: bool,
):
    client = make_client(core_url, rownd_client)
    rownd_user_id = "migration-split-rejected-%s" % (
        "email" if thirdparty_email else "verification"
    )
    google_id = rownd_user_id + "-google"
    email = rownd_user_id + "@example.com"
    thirdparty, passwordless = await create_primary_thirdparty_and_standalone_passwordless(
        email, google_id, thirdparty_email, thirdparty_verified
    )
    mapping = await create_user_id_mapping(
        thirdparty.user.id, rownd_user_id, force=False, user_context={}
    )
    assert mapping.__class__.__name__ == "CreateUserIdMappingOkResult"

    res = migrate_rownd_user(
        client,
        rownd_client,
        rownd_user_id,
        {
            "data": {
                "user_id": rownd_user_id,
                "google_id": google_id,
                "email": email,
            },
            "verified_data": {"google_id": True, "email": True},
        },
    )

    assert res.status_code == 400
    assert res.json() == {"status": "ERROR", "message": "Migration failed"}
    thirdparty_after = await get_user(thirdparty.recipe_user_id.get_as_string())
    passwordless_after = await get_user(passwordless.recipe_user_id.get_as_string())
    assert thirdparty_after is not None and thirdparty_after.is_primary_user
    assert passwordless_after is not None and not passwordless_after.is_primary_user
    assert thirdparty_after.id != passwordless_after.id


async def test_migration_preflights_later_collision_before_creating_phone_method(
    core_url: str, rownd_client: MockRowndClient
):
    client = make_client(core_url, rownd_client)
    rownd_user_id = "migration-later-collision"
    google_id = "migration-later-collision-google"
    phone_number = "+15555550129"
    collision_email = "migration-later-collision@example.com"
    provider = await thirdparty_asyncio.manually_create_or_update_user(
        tenant_id="public",
        third_party_id="google",
        third_party_user_id=google_id,
        email="provider-before-collision@example.com",
        is_verified=True,
        user_context={},
    )
    provider = cast(Any, provider)
    await passwordless_asyncio.signinup("public", collision_email, None, None, {})

    res = migrate_rownd_user(
        client,
        rownd_client,
        rownd_user_id,
        {
            "data": {
                "user_id": rownd_user_id,
                "google_id": google_id,
                "phone_number": phone_number,
                "email": collision_email,
            },
            "verified_data": {"google_id": True, "phone_number": True},
        },
    )

    assert res.status_code == 400
    assert res.json() == {"status": "ERROR", "message": "Migration failed"}
    unchanged_provider = await get_user(provider.user.id)
    assert unchanged_provider is not None
    assert unchanged_provider.is_primary_user is False
    assert len(unchanged_provider.login_methods) == 1
    assert unchanged_provider.login_methods[0].third_party is not None
    assert unchanged_provider.login_methods[0].third_party.user_id == google_id
    assert await supertokens_list_users_by_account_info(
        "public", AccountInfoInput(phone_number=phone_number), False, {}
    ) == []
    assert (await get_user_id_mapping(rownd_user_id, "EXTERNAL", {})).__class__.__name__ == (
        "UnknownMappingError"
    )


async def test_migration_finalization_failure_removes_created_method_and_mapping(
    core_url: str,
    rownd_client: MockRowndClient,
    monkeypatch: pytest.MonkeyPatch,
):
    client = make_client(core_url, rownd_client)
    rownd_user_id = "migration-compensation"
    google_id = "migration-compensation-google"
    phone_number = "+15555550130"
    provider = await thirdparty_asyncio.manually_create_or_update_user(
        tenant_id="public",
        third_party_id="google",
        third_party_user_id=google_id,
        email="migration-compensation-provider@example.com",
        is_verified=True,
        user_context={},
    )
    provider = cast(Any, provider)

    async def fail_metadata_finalization(*_args: Any, **_kwargs: Any):
        raise RuntimeError("metadata finalization failed")

    monkeypatch.setattr(
        impl.usermetadata_asyncio, "update_user_metadata", fail_metadata_finalization
    )
    res = migrate_rownd_user(
        client,
        rownd_client,
        rownd_user_id,
        {
            "data": {
                "user_id": rownd_user_id,
                "google_id": google_id,
                "phone_number": phone_number,
            },
            "verified_data": {"google_id": True, "phone_number": True},
        },
    )

    assert res.status_code == 400
    assert res.json() == {"status": "ERROR", "message": "Migration failed"}
    compensated_provider = await get_user(provider.user.id)
    assert compensated_provider is not None
    assert len(compensated_provider.login_methods) == 1
    assert compensated_provider.login_methods[0].third_party is not None
    assert compensated_provider.login_methods[0].third_party.user_id == google_id
    assert await supertokens_list_users_by_account_info(
        "public", AccountInfoInput(phone_number=phone_number), False, {}
    ) == []
    assert (await get_user_id_mapping(rownd_user_id, "EXTERNAL", {})).__class__.__name__ == (
        "UnknownMappingError"
    )


async def test_migrate_does_not_force_map_user_referenced_by_metadata(
    core_url: str, rownd_client: MockRowndClient
):
    client = make_client(core_url, rownd_client)
    rownd_user_id = "py-existing-google-plus-phone"
    email = "py-existing-google-plus-phone@example.com"
    google_id = "py-google-existing-plus-phone"
    phone_number = "+15555550123"
    existing = await thirdparty_asyncio.manually_create_or_update_user(
        tenant_id="public",
        third_party_id="google",
        third_party_user_id=google_id,
        email=email,
        is_verified=True,
        user_context={},
    )
    existing = cast(Any, existing)
    await usermetadata_asyncio.update_user_metadata(
        existing.user.id,
        {"existing_metadata": "preserved"},
    )
    existing_metadata = await usermetadata_asyncio.get_user_metadata(existing.user.id)
    assert existing_metadata.metadata["existing_metadata"] == "preserved"

    res = migrate_rownd_user(
        client,
        rownd_client,
        rownd_user_id,
        {
            "data": {
                "user_id": rownd_user_id,
                "google_id": google_id,
                "phone_number": phone_number,
                "email": email,
            },
            "verified_data": {"google_id": True, "phone_number": True},
        },
    )

    assert res.status_code == 400
    assert res.json() == {"status": "ERROR", "message": "Migration failed"}
    user = await get_user(existing.user.id)
    assert user is not None
    assert user.is_primary_user is True
    assert len(user.login_methods) == 1
    assert user.login_methods[0].third_party is not None
    assert user.login_methods[0].third_party.user_id == google_id
    assert all(method.phone_number != phone_number for method in user.login_methods)
    metadata = await usermetadata_asyncio.get_user_metadata(existing.user.id)
    assert metadata.metadata == {"existing_metadata": "preserved"}


async def test_migrate_does_not_modify_user_mapped_to_another_external_id(
    core_url: str, rownd_client: MockRowndClient
):
    client = make_client(core_url, rownd_client)
    rownd_user_id = "py-conflicting-mapping"
    email = "py-conflicting-mapping@example.com"
    google_id = "py-google-conflicting-mapping"
    phone_number = "+15555550124"
    existing = await thirdparty_asyncio.manually_create_or_update_user(
        tenant_id="public",
        third_party_id="google",
        third_party_user_id=google_id,
        email=email,
        is_verified=True,
        user_context={},
    )
    existing = cast(Any, existing)
    mapping = await create_user_id_mapping(
        existing.user.id,
        "another-rownd-user",
        user_context={},
    )
    assert getattr(mapping, "status", "OK") == "OK"

    res = migrate_rownd_user(
        client,
        rownd_client,
        rownd_user_id,
        {
            "data": {
                "user_id": rownd_user_id,
                "google_id": google_id,
                "phone_number": phone_number,
                "email": email,
            },
            "verified_data": {"google_id": True, "phone_number": True},
        },
    )

    assert res.status_code == 400
    assert res.json() == {"status": "ERROR", "message": "Migration failed"}
    unchanged_user = await get_user(existing.user.id)
    assert unchanged_user is not None
    assert unchanged_user.is_primary_user is False
    assert len(unchanged_user.login_methods) == 1
    assert all(method.phone_number != phone_number for method in unchanged_user.login_methods)


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
    user = await get_user("py-emailverification-migrate-user")
    assert user is not None
    assert user.login_methods[0].recipe_id == "passwordless"
    assert user.login_methods[0].email == "ev-migrate@example.com"


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

    assert res.status_code == 400
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

    assert res.status_code == 400
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

    assert res.status_code == 400
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

    assert res.status_code == 400
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
    assert payload["is_anonymous"]["v"] is True
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
    methods = body["app"]["config"]["hub"]["auth"]["sign_in_methods"]
    assert methods["email"]["enabled"] is False
    assert methods["google"]["enabled"] is False
    assert "email" not in body["app"]["schema"]
    assert "google_id" not in body["app"]["schema"]


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


async def test_app_config_returns_platform_specific_auth_order(
    core_url: str, rownd_client: MockRowndClient
):
    auth_order = {
        "default": [
            {"name": "email", "type": "input"},
            {"name": "google", "type": "button"},
        ],
        "ios": [
            {"name": "apple", "type": "button"},
            {"name": "google", "type": "button", "hidden": True},
            {"name": "email", "type": "input"},
        ],
        "android": [
            {"name": "google", "type": "button"},
            {"name": "apple", "type": "button", "hidden": True},
        ],
    }
    client = make_client(
        core_url,
        rownd_client,
        plugin_config={
            "app_config": {
                "auth": {"order": auth_order},
                "signInMethods": [{"method": "email"}, {"method": "google"}, {"method": "apple"}],
            }
        },
    )

    res = client.get("/auth/plugin/rownd/app-config")

    assert res.status_code == 200
    assert res.json()["app"]["config"]["hub"]["auth"]["order"] == auth_order


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


async def test_app_config_fills_optional_schema_defaults(core_url: str, rownd_client: MockRowndClient):
    client = make_client(
        core_url,
        rownd_client,
        plugin_config={
            "schema": {
                "nickname": {"display_name": "Nickname", "type": "string", "user_visible": True}
            }
        },
    )

    res = client.get("/auth/plugin/rownd/app-config")
    field = res.json()["app"]["schema"]["nickname"]

    assert res.status_code == 200
    assert field["owned_by"] == "user"
    assert field["read_only"] is False
    assert field["show_empty"] is False


async def test_app_config_schema_from_plugin_config_appears_in_response(
    core_url: str, rownd_client: MockRowndClient
):
    client = make_client(
        core_url,
        rownd_client,
        plugin_config={
            "schema": {
                "first_name": {"display_name": "First name", "type": "string", "user_visible": True},
                "last_name": {"display_name": "Last name", "type": "string", "user_visible": True},
            }
        },
    )

    res = client.get("/auth/plugin/rownd/app-config")
    schema = res.json()["app"]["schema"]

    assert res.status_code == 200
    assert schema["first_name"]["display_name"] == "First name"
    assert schema["last_name"]["display_name"] == "Last name"


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
                    "enforceSameDevicePasswordlessSignIn": True,
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
    assert auth["enforce_same_device_passwordless_sign_in"] is True
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


async def test_app_config_returns_verification_modal_custom_content(
    core_url: str, rownd_client: MockRowndClient
):
    client = make_client(
        core_url,
        rownd_client,
        plugin_config={
            "app_config": {
                "customContent": {
                    "verificationModal": {
                        "title": "Verify your account",
                        "subtitle": "Enter the code we sent you",
                    }
                }
            }
        },
    )

    res = client.get("/auth/plugin/rownd/app-config")

    assert res.status_code == 200
    assert res.json()["app"]["config"]["hub"]["custom_content"]["verification_modal"] == {
        "title": "Verify your account",
        "subtitle": "Enter the code we sent you",
    }


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
    client = make_client(
        core_url,
        rownd_client,
        plugin_config={"sub_brands": {"variant_123": {"id": "app_xyz"}}},
    )

    res = client.post(
        "/auth/plugin/rownd/guest?app_variant_id=variant_123",
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
    assert payload["is_anonymous"]["v"] is True
    metadata = await usermetadata_asyncio.get_user_metadata(st_session.get_user_id())
    assert metadata.metadata["original_rownd_user"]["attributes"]["rownd:app_variants"] == [
        "variant_123"
    ]


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


async def test_get_user_includes_provider_id_for_linked_thirdparty_user(
    memory_core_url: str, rownd_client: MockRowndClient
):
    client = make_client(memory_core_url, rownd_client)
    passwordless = await passwordless_asyncio.signinup(
        "public", "linked-thirdparty@example.com", None, None, {}
    )
    thirdparty = await thirdparty_asyncio.manually_create_or_update_user(
        tenant_id="public",
        third_party_id="google",
        third_party_user_id="google-linked-thirdparty-id",
        email="linked-thirdparty@example.com",
        is_verified=True,
        user_context={},
    )
    thirdparty = cast(Any, thirdparty)
    primary = await accountlinking_asyncio.create_primary_user(passwordless.recipe_user_id, {})
    assert getattr(primary, "status", "OK") == "OK"
    link_result = await accountlinking_asyncio.link_accounts(
        thirdparty.recipe_user_id, passwordless.user.id, {}
    )
    assert getattr(link_result, "status", "OK") == "OK"
    await usermetadata_asyncio.update_user_metadata(
        passwordless.user.id,
        {
            "original_rownd_user": {
                "data": {"user_id": passwordless.user.id, "email": "linked-thirdparty@example.com"},
                "verified_data": {"email": True},
            }
        },
    )
    st_session = await session_asyncio.create_new_session_without_request_response(
        "public", passwordless.recipe_user_id, {}, {}, True
    )

    res = client.get(
        "/auth/plugin/rownd/user", headers=auth_headers(st_session.get_access_token())
    )
    body = res.json()

    assert res.status_code == 200
    assert body["data"]["google_id"] == "google-linked-thirdparty-id"
    assert body["verified_data"]["google_id"] == "google-linked-thirdparty-id"


async def test_linked_rownd_metadata_survives_primary_metadata_write(
    memory_core_url: str, rownd_client: MockRowndClient
):
    client = make_client(memory_core_url, rownd_client)
    email = "linked-metadata@example.com"
    rownd_user_id = "rownd-linked-metadata"
    passwordless = await passwordless_asyncio.signinup("public", email, None, None, {})
    mapping = await create_user_id_mapping(passwordless.user.id, rownd_user_id, user_context={})
    assert getattr(mapping, "status", "OK") == "OK"
    thirdparty = await thirdparty_asyncio.manually_create_or_update_user(
        tenant_id="public",
        third_party_id="google",
        third_party_user_id="google-linked-metadata",
        email=email,
        is_verified=True,
        user_context={"rowndDisableAutomaticAccountLinking": True},
    )
    thirdparty = cast(Any, thirdparty)
    await usermetadata_asyncio.update_user_metadata(
        passwordless.user.id, {"primary_metadata": "preserved"}
    )
    await usermetadata_asyncio.update_user_metadata(
        thirdparty.recipe_user_id.get_as_string(),
        {
            "original_rownd_user": {
                "state": "enabled",
                "auth_level": "verified",
                "data": {"user_id": rownd_user_id, "email": email, "first_name": "Jane"},
                "verified_data": {"email": email},
                "attributes": {},
            },
            "secondary_metadata": "preserved",
        },
    )
    primary = await accountlinking_asyncio.create_primary_user(passwordless.recipe_user_id, {})
    assert getattr(primary, "status", "OK") == "OK"
    linked = await accountlinking_asyncio.link_accounts(
        thirdparty.recipe_user_id, passwordless.user.id, {}
    )
    assert getattr(linked, "status", "OK") == "OK"
    secondary_before = await usermetadata_asyncio.get_user_metadata(
        thirdparty.recipe_user_id.get_as_string()
    )
    st_session = await session_asyncio.create_new_session_without_request_response(
        "public", passwordless.recipe_user_id, {}, {}, True
    )
    headers = auth_headers(st_session.get_access_token())

    user_res = client.get("/auth/plugin/rownd/user", headers=headers)
    update_res = client.put(
        "/auth/plugin/rownd/user/meta",
        headers={**headers, "Content-Type": "application/json"},
        json={"meta": {"profile_note": "updated"}},
    )

    assert user_res.status_code == 200
    assert user_res.json()["rownd_user"] == rownd_user_id
    assert user_res.json()["data"]["first_name"] == "Jane"
    assert user_res.json()["meta"]["primary_metadata"] == "preserved"
    assert user_res.json()["meta"]["secondary_metadata"] == "preserved"
    assert update_res.status_code == 200
    assert update_res.json()["id"] == passwordless.user.id
    primary_after = await usermetadata_asyncio.get_user_metadata(passwordless.user.id)
    assert primary_after.metadata == {
        "primary_metadata": "preserved",
        "profile_note": "updated",
    }
    assert (
        await usermetadata_asyncio.get_user_metadata(thirdparty.recipe_user_id.get_as_string())
    ).metadata == secondary_before.metadata


async def test_verified_thirdparty_login_links_existing_passwordless_account(
    core_url: str, rownd_client: MockRowndClient
):
    make_client(core_url, rownd_client)
    email = "automatic-link-passwordless-thirdparty@example.com"
    initial_count = await get_user_count(tenant_id="public")
    passwordless = await passwordless_asyncio.signinup("public", email, None, None, {})

    thirdparty = await thirdparty_asyncio.manually_create_or_update_user(
        tenant_id="public",
        third_party_id="google",
        third_party_user_id="automatic-link-google-user",
        email=email,
        is_verified=True,
        user_context={},
    )
    assert getattr(thirdparty, "status", "OK") == "OK"
    thirdparty = cast(Any, thirdparty)

    assert thirdparty.user.id == passwordless.user.id
    assert await get_user_count(tenant_id="public") == initial_count + 1
    linked_user = await get_user(passwordless.user.id)
    assert linked_user is not None
    assert {method.recipe_id for method in linked_user.login_methods} == {
        "passwordless",
        "thirdparty",
    }

    later_login = await thirdparty_asyncio.manually_create_or_update_user(
        tenant_id="public",
        third_party_id="google",
        third_party_user_id="automatic-link-google-user",
        email=email,
        is_verified=True,
        user_context={},
    )
    assert getattr(later_login, "status", "OK") == "OK"
    later_login = cast(Any, later_login)

    assert later_login.user.id == passwordless.user.id
    assert later_login.recipe_user_id == thirdparty.recipe_user_id
    assert await get_user_count(tenant_id="public") == initial_count + 1


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
    sign_in = await passwordless_asyncio.signinup(
        "public", "pending-current@example.com", None, None, {}
    )
    st_session = await session_asyncio.create_new_session_without_request_response(
        "public", sign_in.recipe_user_id, {}, {}, True
    )
    access_token = st_session.get_access_token()
    user_id = sign_in.user.id

    res = client.put(
        "/auth/plugin/rownd/user",
        headers={**auth_headers(access_token), "Content-Type": "application/json"},
        json={"data": {"email": " New-Email@Example.com ", "first_name": "Grace"}},
    )

    assert res.status_code == 200
    body = res.json()
    assert body["email_verification_pending"] is True
    assert body["data"].get("email") != "new-email@example.com"
    assert body["data"]["first_name"] == "Grace"
    assert body["verified_data"]["email"] == "pending-current@example.com"
    metadata = await usermetadata_asyncio.get_user_metadata(user_id)
    assert metadata.metadata["first_name"] == "Grace"
    pending = metadata.metadata["rownd_pending_verification"]
    assert len(pending) == 1
    assert pending[0]["field"] == "email"
    assert pending[0] == {
        "id": pending[0]["id"],
        "field": "email",
        "value": " New-Email@Example.com ",
        "created_at": pending[0]["created_at"],
        "tenantId": "public",
        "purpose": "UPDATE_PASSWORDLESS",
        "initiatingSessionHandle": st_session.get_handle(),
        "verificationRecipeUserId": sign_in.recipe_user_id.get_as_string(),
        "status": "PENDING",
    }

    result = await complete_pending_email_verification(
        sign_in.recipe_user_id,
        "new-email@example.com",
        {},
        "public",
        st_session.get_handle(),
    )

    assert result is not None
    user = await get_user(user_id)
    assert user is not None
    passwordless_methods = [
        method for method in user.login_methods if method.recipe_id == "passwordless"
    ]
    assert {method.email for method in passwordless_methods} == {
        "pending-current@example.com",
        "new-email@example.com",
    }
    canonical_method = next(
        method for method in passwordless_methods if method.email == "new-email@example.com"
    )
    assert canonical_method.recipe_user_id.get_as_string() != sign_in.recipe_user_id.get_as_string()
    metadata = await usermetadata_asyncio.get_user_metadata(user_id)
    assert metadata.metadata["original_rownd_user"]["data"]["email"] == (
        "new-email@example.com"
    )
    assert metadata.metadata["original_rownd_user"]["verified_data"]["email"] == (
        "new-email@example.com"
    )
    assert metadata.metadata["rownd_email_recipe_user_id"] == (
        canonical_method.recipe_user_id.get_as_string()
    )
    assert metadata.metadata["rownd_email_recipe_user_ids"] == {
        "public": canonical_method.recipe_user_id.get_as_string()
    }
    assert metadata.metadata["rownd_pending_verification"] == []


async def test_fresh_migrated_session_can_start_email_change(
    core_url: str, rownd_client: MockRowndClient
):
    client = make_client(core_url, rownd_client, enable_email_verification=True)
    migrate = migrate_rownd_user(
        client,
        rownd_client,
        "migration-email-change-user",
        {
            "data": {
                "user_id": "migration-email-change-user",
                "email": "migration-current@example.com",
            },
            "verified_data": {"email": True},
        },
    )

    res = client.put(
        "/auth/plugin/rownd/user",
        headers={
            **auth_headers(migrate.headers["st-access-token"]),
            "Content-Type": "application/json",
        },
        json={"data": {"email": "migration-target@example.com"}},
    )

    assert res.status_code == 200
    assert res.json()["status"] == "OK"
    user = await get_user("migration-email-change-user")
    assert user is not None
    mapping = await get_user_id_mapping("migration-email-change-user", "EXTERNAL")
    assert isinstance(mapping, GetUserIdMappingOkResult)
    metadata = await usermetadata_asyncio.get_user_metadata(mapping.supertokens_user_id)
    assert metadata.metadata["rownd_pending_verification"][0]["value"] == (
        "migration-target@example.com"
    )


async def test_repeated_fresh_migrated_sessions_can_start_email_change(
    core_url: str, rownd_client: MockRowndClient
):
    client = make_client(core_url, rownd_client, enable_email_verification=True)
    user_info = {
        "data": {
            "user_id": "repeated-migration-email-user",
            "email": "repeated-migration-current@example.com",
        },
        "verified_data": {"email": True},
    }
    first = migrate_rownd_user(
        client, rownd_client, "repeated-migration-email-user", user_info
    )
    second = migrate_rownd_user(
        client, rownd_client, "repeated-migration-email-user", user_info
    )
    access_tokens = [first.headers["st-access-token"], second.headers["st-access-token"]]
    for index, access_token in enumerate(access_tokens):
        res = client.put(
            "/auth/plugin/rownd/user",
            headers={
                **auth_headers(access_token),
                "Content-Type": "application/json",
            },
            json={"data": {"email": f"repeated-migration-target-{index}@example.com"}},
        )
        assert res.status_code == 200
        assert res.json()["status"] == "OK"


async def test_stale_native_session_cannot_start_email_change(
    core_url: str, rownd_client: MockRowndClient
):
    client = make_client(
        core_url,
        rownd_client,
        plugin_config={"email_change": {"max_session_age_seconds": 0.001}},
        enable_email_verification=True,
    )
    sign_in = await passwordless_asyncio.signinup(
        "public", "stale-current@example.com", None, None, {}
    )
    st_session = await session_asyncio.create_new_session_without_request_response(
        "public", sign_in.recipe_user_id, {}, {}, True
    )
    await asyncio.sleep(0.01)

    res = client.put(
        "/auth/plugin/rownd/user",
        headers={
            **auth_headers(st_session.get_access_token()),
            "Content-Type": "application/json",
        },
        json={"data": {"email": "stale-target@example.com"}},
    )

    assert res.status_code == 403
    assert res.json()["message"] == "recent authentication is required to change email"


@pytest.mark.parametrize(
    ("path", "body"),
    [
        (
            "/auth/plugin/rownd/user",
            {
                "data": {"email": "mobile-upgrade-user-target@example.com"},
                "context": {"rowndDisplayContext": "mobile_app"},
            },
        ),
        (
            "/auth/plugin/rownd/user/field?field=email",
            {
                "value": "mobile-upgrade-field-target@example.com",
                "context": {
                    "rowndDisplayContext": "mobile_app",
                    "rowndNativeEmailVerification": False,
                },
            },
        ),
    ],
)
async def test_mobile_email_change_requires_native_verification_before_side_effects(
    core_url: str,
    rownd_client: MockRowndClient,
    monkeypatch: pytest.MonkeyPatch,
    path: str,
    body: dict[str, Any],
):
    delivery_links: list[str] = []
    send_calls = 0
    original_send = impl.emailverification_asyncio.send_email_verification_email

    async def capture_send(*args: Any, **kwargs: Any):
        nonlocal send_calls
        send_calls += 1
        return await original_send(*args, **kwargs)

    monkeypatch.setattr(
        impl.emailverification_asyncio,
        "send_email_verification_email",
        capture_send,
    )
    client = make_client(
        core_url,
        rownd_client,
        enable_email_verification=True,
        email_verification_links=delivery_links,
    )
    current_email = (
        "mobile-upgrade-field-current@example.com"
        if "field=email" in path
        else "mobile-upgrade-user-current@example.com"
    )
    sign_in = await passwordless_asyncio.signinup(
        "public", current_email, None, None, {}
    )
    st_session = await session_asyncio.create_new_session_without_request_response(
        "public", sign_in.recipe_user_id, {}, {}, True
    )
    metadata_before = await usermetadata_asyncio.get_user_metadata(sign_in.user.id)

    response = client.put(
        path,
        headers={
            **auth_headers(st_session.get_access_token()),
            "Content-Type": "application/json",
        },
        json=body,
    )

    assert response.status_code == 426
    assert response.json() == {
        "status": "ERROR",
        "code": 426,
        "message": "native email verification requires a Rownd SDK upgrade",
    }
    metadata_after = await usermetadata_asyncio.get_user_metadata(sign_in.user.id)
    assert metadata_after.metadata == metadata_before.metadata
    assert send_calls == 0
    assert delivery_links == []
    user = await get_user(sign_in.user.id)
    assert user is not None
    assert user.login_methods[0].email == current_email


async def test_refresh_preserves_original_authentication_age_for_email_change(
    core_url: str, rownd_client: MockRowndClient
):
    client = make_client(
        core_url,
        rownd_client,
        plugin_config={"email_change": {"max_session_age_seconds": 0.001}},
        enable_email_verification=True,
    )
    sign_in = await passwordless_asyncio.signinup(
        "public", "refreshed-stale-current@example.com", None, None, {}
    )
    st_session = await session_asyncio.create_new_session_without_request_response(
        "public", sign_in.recipe_user_id, {}, {}, True
    )
    refresh_token = st_session.get_all_session_tokens_dangerously()["refreshToken"]
    assert refresh_token is not None
    original_info = await session_asyncio.get_session_information(st_session.get_handle())
    assert original_info is not None
    await asyncio.sleep(0.01)

    refreshed = await session_asyncio.refresh_session_without_request_response(
        refresh_token, True
    )
    refreshed_info = await session_asyncio.get_session_information(refreshed.get_handle())
    assert refreshed_info is not None
    assert refreshed.get_handle() == st_session.get_handle()
    assert refreshed_info.time_created == original_info.time_created

    res = client.put(
        "/auth/plugin/rownd/user",
        headers={
            **auth_headers(refreshed.get_access_token()),
            "Content-Type": "application/json",
        },
        json={"data": {"email": "refreshed-stale-target@example.com"}},
    )

    assert res.status_code == 403
    assert res.json()["message"] == "recent authentication is required to change email"


async def test_email_change_rejects_global_owner(
    core_url: str, rownd_client: MockRowndClient
):
    client = make_client(core_url, rownd_client, enable_email_verification=True)
    await multitenancy_asyncio.create_or_update_tenant("ownership-tenant", None, {})
    await passwordless_asyncio.signinup(
        "ownership-tenant", "globally-owned@example.com", None, None, {}
    )
    changing_user = await passwordless_asyncio.signinup(
        "public", "ownership-current@example.com", None, None, {}
    )
    st_session = await session_asyncio.create_new_session_without_request_response(
        "public", changing_user.recipe_user_id, {}, {}, True
    )

    res = client.put(
        "/auth/plugin/rownd/user",
        headers={
            **auth_headers(st_session.get_access_token()),
            "Content-Type": "application/json",
        },
        json={"data": {"email": " GLOBALLY-OWNED@example.com "}},
    )

    assert res.status_code == 409
    assert res.json() == {
        "status": "ERROR",
        "code": 409,
        "message": "email cannot be used for this account",
    }
    metadata = await usermetadata_asyncio.get_user_metadata(changing_user.user.id)
    assert "rownd_pending_verification" not in metadata.metadata


async def test_email_change_rejects_multiple_passwordless_email_methods(
    memory_core_url: str, rownd_client: MockRowndClient
):
    client = make_client(memory_core_url, rownd_client, enable_email_verification=True)
    first = await passwordless_asyncio.signinup(
        "public", "ambiguous-first@example.com", None, None, {}
    )
    second = await passwordless_asyncio.signinup(
        "public", "ambiguous-second@example.com", None, None, {}
    )
    primary = await accountlinking_asyncio.create_primary_user(first.recipe_user_id, {})
    assert getattr(primary, "status", "OK") == "OK"
    linked = await accountlinking_asyncio.link_accounts(
        second.recipe_user_id, first.user.id, {}
    )
    assert getattr(linked, "status", "OK") == "OK"
    st_session = await session_asyncio.create_new_session_without_request_response(
        "public", first.recipe_user_id, {}, {}, True
    )

    res = client.put(
        "/auth/plugin/rownd/user",
        headers={
            **auth_headers(st_session.get_access_token()),
            "Content-Type": "application/json",
        },
        json={"data": {"email": "ambiguous-target@example.com"}},
    )

    assert res.status_code == 409
    assert res.json()["message"] == (
        "the account has multiple email sign-in methods without a canonical method"
    )


async def test_email_change_uses_recorded_canonical_among_multiple_passwordless_methods(
    memory_core_url: str, rownd_client: MockRowndClient
):
    client = make_client(memory_core_url, rownd_client, enable_email_verification=True)
    first = await passwordless_asyncio.signinup(
        "public", "recorded-canonical-first@example.com", None, None, {}
    )
    second = await passwordless_asyncio.signinup(
        "public", "recorded-canonical-second@example.com", None, None, {}
    )
    primary = await accountlinking_asyncio.create_primary_user(first.recipe_user_id, {})
    assert getattr(primary, "status", "OK") == "OK"
    linked = await accountlinking_asyncio.link_accounts(second.recipe_user_id, first.user.id, {})
    assert getattr(linked, "status", "OK") == "OK"
    await usermetadata_asyncio.update_user_metadata(
        first.user.id,
        {"rownd_email_recipe_user_ids": {"public": second.recipe_user_id.get_as_string()}},
    )
    st_session = await session_asyncio.create_new_session_without_request_response(
        "public", first.recipe_user_id, {}, {}, True
    )

    res = client.put(
        "/auth/plugin/rownd/user",
        headers={
            **auth_headers(st_session.get_access_token()),
            "Content-Type": "application/json",
        },
        json={"data": {"email": "recorded-canonical-target@example.com"}},
    )

    assert res.status_code == 200
    metadata = await usermetadata_asyncio.get_user_metadata(first.user.id)
    pending = metadata.metadata["rownd_pending_verification"][0]
    assert pending["verificationRecipeUserId"] == second.recipe_user_id.get_as_string()
    await complete_pending_email_verification(
        second.recipe_user_id,
        "recorded-canonical-target@example.com",
        {},
        "public",
        st_session.get_handle(),
    )
    user = await get_user(first.user.id)
    assert user is not None
    assert {method.email for method in user.login_methods if method.recipe_id == "passwordless"} == {
        "recorded-canonical-first@example.com",
        "recorded-canonical-second@example.com",
        "recorded-canonical-target@example.com",
    }


async def test_email_change_finalization_uses_linked_rownd_metadata_without_copying_it(
    memory_core_url: str, rownd_client: MockRowndClient
):
    client = make_client(memory_core_url, rownd_client, enable_email_verification=True)
    primary_method = await passwordless_asyncio.signinup(
        "public", "linked-metadata-primary@example.com", None, None, {}
    )
    canonical_method = await passwordless_asyncio.signinup(
        "public", "linked-metadata-canonical@example.com", None, None, {}
    )
    primary = await accountlinking_asyncio.create_primary_user(
        primary_method.recipe_user_id, {}
    )
    assert getattr(primary, "status", "OK") == "OK"
    linked = await accountlinking_asyncio.link_accounts(
        canonical_method.recipe_user_id, primary_method.user.id, {}
    )
    assert getattr(linked, "status", "OK") == "OK"
    linked_snapshot = {
        "state": "enabled",
        "auth_level": "verified",
        "data": {
            "user_id": "linked-rownd-user",
            "email": "linked-metadata-canonical@example.com",
            "first_name": "Linked",
            "profile": {"theme": "dark"},
        },
        "verified_data": {"email": "linked-metadata-canonical@example.com"},
        "groups": [{"id": "linked-group"}],
        "meta": {"created": "2026-01-01T00:00:00.000Z"},
    }
    linked_recipe_user_id = canonical_method.recipe_user_id.get_as_string()
    await usermetadata_asyncio.update_user_metadata(
        linked_recipe_user_id,
        {
            "original_rownd_user": linked_snapshot,
            "linked_only": "do-not-copy",
        },
    )
    await usermetadata_asyncio.update_user_metadata(
        primary_method.user.id,
        {
            "primary_only": "keep",
            "rownd_email_recipe_user_ids": {
                "public": linked_recipe_user_id,
                "tenant-b": "tenant-b-canonical",
            },
        },
    )
    st_session = await session_asyncio.create_new_session_without_request_response(
        "public", primary_method.recipe_user_id, {}, {}, True
    )
    target_email = "linked-metadata-target@example.com"

    unchanged_response = client.put(
        "/auth/plugin/rownd/user",
        headers={
            **auth_headers(st_session.get_access_token()),
            "Content-Type": "application/json",
        },
        json={"data": {"email": "linked-metadata-canonical@example.com"}},
    )
    unchanged_primary = await usermetadata_asyncio.get_user_metadata(
        primary_method.user.id
    )
    assert unchanged_response.status_code == 200
    assert unchanged_response.json()["email_verification_pending"] is False
    assert "original_rownd_user" not in unchanged_primary.metadata
    assert "linked_only" not in unchanged_primary.metadata

    response = client.put(
        "/auth/plugin/rownd/user",
        headers={
            **auth_headers(st_session.get_access_token()),
            "Content-Type": "application/json",
        },
        json={"data": {"email": target_email}},
    )

    assert response.status_code == 200
    pending_primary = await usermetadata_asyncio.get_user_metadata(primary_method.user.id)
    assert "original_rownd_user" not in pending_primary.metadata
    assert "linked_only" not in pending_primary.metadata
    pending = pending_primary.metadata["rownd_pending_verification"][0]
    assert pending["verificationRecipeUserId"] == linked_recipe_user_id

    completion = await complete_pending_email_verification(
        canonical_method.recipe_user_id,
        target_email,
        {},
        "public",
        st_session.get_handle(),
    )

    assert completion is not None
    user = await get_user(primary_method.user.id)
    assert user is not None
    target_method = next(method for method in user.login_methods if method.email == target_email)
    primary_metadata = (
        await usermetadata_asyncio.get_user_metadata(primary_method.user.id)
    ).metadata
    original = cast(dict[str, Any], primary_metadata["original_rownd_user"])
    assert original["data"] == {
        **linked_snapshot["data"],
        "email": target_email,
    }
    assert original["verified_data"] == {"email": target_email}
    assert original["groups"] == linked_snapshot["groups"]
    assert original["meta"] == linked_snapshot["meta"]
    assert primary_metadata["primary_only"] == "keep"
    assert primary_metadata["rownd_pending_verification"] == []
    assert primary_metadata["rownd_email_recipe_user_ids"] == {
        "public": target_method.recipe_user_id.get_as_string(),
        "tenant-b": "tenant-b-canonical",
    }
    assert "linked_only" not in primary_metadata
    linked_metadata = (
        await usermetadata_asyncio.get_user_metadata(linked_recipe_user_id)
    ).metadata
    assert linked_metadata["original_rownd_user"] == linked_snapshot
    assert linked_metadata["linked_only"] == "do-not-copy"


async def test_email_update_clears_pending_verification_when_reset_to_current_email(
    core_url: str, rownd_client: MockRowndClient
):
    client = make_client(core_url, rownd_client, enable_email_verification=True)
    sign_in = await passwordless_asyncio.signinup(
        "public", "email-reset-current@example.com", None, None, {}
    )
    st_session = await session_asyncio.create_new_session_without_request_response(
        "public", sign_in.recipe_user_id, {}, {}, True
    )
    access_token = st_session.get_access_token()
    await usermetadata_asyncio.update_user_metadata(
        sign_in.user.id,
        {
            "original_rownd_user": {
                "data": {"user_id": sign_in.user.id, "email": "email-reset-current@example.com"},
                "verified_data": {"email": "email-reset-current@example.com"},
            }
        },
    )

    pending_res = client.put(
        "/auth/plugin/rownd/user",
        headers={**auth_headers(access_token), "Content-Type": "application/json"},
        json={"data": {"email": "email-reset-pending@example.com"}},
    )
    reset_res = client.put(
        "/auth/plugin/rownd/user",
        headers={**auth_headers(access_token), "Content-Type": "application/json"},
        json={"data": {"email": "email-reset-current@example.com"}},
    )

    assert pending_res.status_code == 200
    assert reset_res.status_code == 200
    assert pending_res.json()["email_verification_pending"] is True
    assert reset_res.json()["email_verification_pending"] is False
    metadata = await usermetadata_asyncio.get_user_metadata(sign_in.user.id)
    assert metadata.metadata["rownd_pending_verification"] == []


async def test_email_field_update_reports_whether_verification_is_pending(
    core_url: str, rownd_client: MockRowndClient
):
    client = make_client(core_url, rownd_client, enable_email_verification=True)
    current_email = "field-pending-current@example.com"
    sign_in = await passwordless_asyncio.signinup("public", current_email, None, None, {})
    st_session = await session_asyncio.create_new_session_without_request_response(
        "public", sign_in.recipe_user_id, {}, {}, True
    )
    headers = {
        **auth_headers(st_session.get_access_token()),
        "Content-Type": "application/json",
    }

    unchanged = client.put(
        "/auth/plugin/rownd/user/field?field=email",
        headers=headers,
        json={"value": current_email.upper()},
    )
    changed = client.put(
        "/auth/plugin/rownd/user/field?field=email",
        headers=headers,
        json={"value": "field-pending-target@example.com"},
    )

    assert unchanged.status_code == 200
    assert unchanged.json()["email_verification_pending"] is False
    assert changed.status_code == 200
    assert changed.json()["email_verification_pending"] is True


async def test_instant_user_cannot_start_email_verification_when_required(
    core_url: str, rownd_client: MockRowndClient
):
    client = make_client(
        core_url,
        rownd_client,
        enable_email_verification=True,
        email_verification_mode="REQUIRED",
    )
    guest = client.post(
        "/auth/plugin/rownd/guest",
        headers={"Content-Type": "application/json", **session_headers()},
        json={"auth_level": "instant"},
    )
    access_token = guest.headers["st-access-token"]
    st_session = await session_asyncio.get_session_without_request_response(
        access_token,
        override_global_claim_validators=lambda validators, _session, _user_context: [],
    )
    assert st_session is not None

    res = client.put(
        "/auth/plugin/rownd/user",
        headers={**auth_headers(access_token), "Content-Type": "application/json"},
        json={"data": {"email": "required-instant@example.com"}},
    )

    assert res.status_code == 409
    body = res.json()
    assert body == {
        "status": "ERROR",
        "code": 409,
        "message": "the account has no passwordless sign-in method",
    }
    metadata = await usermetadata_asyncio.get_user_metadata(st_session.get_user_id())
    assert "rownd_pending_verification" not in metadata.metadata


async def test_required_email_verification_does_not_bypass_missing_session(
    core_url: str, rownd_client: MockRowndClient
):
    client = make_client(
        core_url,
        rownd_client,
        enable_email_verification=True,
        email_verification_mode="REQUIRED",
    )

    res = client.put(
        "/auth/plugin/rownd/user",
        headers={"Content-Type": "application/json"},
        json={"data": {"email": "missing-session@example.com"}},
    )

    assert res.json().get("status") != "OK"


async def test_instant_profile_email_change_is_rejected(
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
        json={"data": {"email": "guest-linked@example.com"}},
    )
    assert update_res.status_code == 409
    assert update_res.json()["message"] == "the account has no passwordless sign-in method"
    user = await get_user(st_session.get_user_id())
    assert user is not None
    assert len(user.login_methods) == 1
    metadata = await usermetadata_asyncio.get_user_metadata(user.id)
    assert "rownd_pending_verification" not in metadata.metadata


async def test_email_verify_route_completes_pending_verification(
    memory_core_url: str, rownd_client: MockRowndClient
):
    client = make_client(memory_core_url, rownd_client, enable_email_verification=True)
    sign_in = await passwordless_asyncio.signinup(
        "public", "route-current@example.com", None, None, {}
    )
    st_session = await session_asyncio.create_new_session_without_request_response(
        "public", sign_in.recipe_user_id, {}, {}, True
    )
    access_token = st_session.get_access_token()

    update_res = client.put(
        "/auth/plugin/rownd/user",
        headers={**auth_headers(access_token), "Content-Type": "application/json"},
        json={"data": {"email": "route-verified@example.com"}},
    )
    assert update_res.status_code == 200
    assert update_res.json()["email_verification_pending"] is True
    metadata = await usermetadata_asyncio.get_user_metadata(sign_in.user.id)
    pending_id = metadata.metadata["rownd_pending_verification"][0]["id"]
    token_result = await emailverification_asyncio.create_email_verification_token(
        "public", st_session.get_recipe_user_id(), "route-verified@example.com", {}
    )
    token = getattr(token_result, "token", None)
    assert isinstance(token, str)

    mismatched_res = client.post(
        "/auth/user/email/verify?rowndPendingVerificationId=wrong-pending-id",
        headers={
            **auth_headers(access_token),
            "Content-Type": "application/json",
            "rid": "emailverification",
        },
        json={"method": "token", "token": token},
    )
    assert mismatched_res.json() == {
        "status": "GENERAL_ERROR",
        "message": "email change verification requires the initiating session",
    }

    verify_res = client.post(
        "/auth/user/email/verify?rowndPendingVerificationId=%s" % pending_id,
        headers={
            **auth_headers(access_token),
            "Content-Type": "application/json",
            "rid": "emailverification",
        },
        json={"method": "token", "token": token},
    )

    assert verify_res.status_code == 200
    assert verify_res.json() == {"status": "OK"}
    replacement_access_token = verify_res.headers.get("st-access-token")
    assert replacement_access_token
    linked_user = await get_user(st_session.get_user_id())
    assert linked_user is not None
    metadata = await usermetadata_asyncio.get_user_metadata(linked_user.id)
    assert metadata.metadata["rownd_pending_verification"] == []
    assert metadata.metadata["original_rownd_user"]["data"]["email"] == "route-verified@example.com"
    canonical_method = next(
        method for method in linked_user.login_methods if method.email == "route-verified@example.com"
    )
    assert metadata.metadata["rownd_email_recipe_user_id"] == (
        canonical_method.recipe_user_id.get_as_string()
    )


async def test_unmarked_email_verification_is_session_optional_and_does_not_change_profile(
    core_url: str, rownd_client: MockRowndClient
):
    client = make_client(core_url, rownd_client, enable_email_verification=True)
    current_email = "ordinary-pending-current@example.com"
    target_email = "ordinary-pending-target@example.com"
    sign_in = await passwordless_asyncio.signinup(
        "public", current_email, None, None, {}
    )
    st_session = await session_asyncio.create_new_session_without_request_response(
        "public", sign_in.recipe_user_id, {}, {}, True
    )
    update_res = client.put(
        "/auth/plugin/rownd/user",
        headers={
            **auth_headers(st_session.get_access_token()),
            "Content-Type": "application/json",
        },
        json={"data": {"email": target_email}},
    )
    assert update_res.status_code == 200
    token_result = await emailverification_asyncio.create_email_verification_token(
        "public", sign_in.recipe_user_id, target_email, {}
    )
    token = getattr(token_result, "token", None)
    assert isinstance(token, str)

    verify_res = client.post(
        "/auth/user/email/verify",
        headers={
            "Content-Type": "application/json",
            "rid": "emailverification",
        },
        json={"method": "token", "token": token},
    )

    assert verify_res.json() == {"status": "OK"}
    user = await get_user(sign_in.user.id)
    assert user is not None
    assert user.login_methods[0].email == current_email
    metadata = await usermetadata_asyncio.get_user_metadata(user.id)
    assert len(metadata.metadata["rownd_pending_verification"]) == 1


async def test_route_replacement_session_failure_rolls_back_email_change(
    core_url: str,
    rownd_client: MockRowndClient,
    monkeypatch: pytest.MonkeyPatch,
):
    delivery_links: list[str] = []
    client = make_client(
        core_url,
        rownd_client,
        enable_email_verification=True,
        email_verification_links=delivery_links,
    )
    current_email = "route-rollback-current@example.com"
    target_email = "route-rollback-target@example.com"
    sign_in = await passwordless_asyncio.signinup(
        "public", current_email, None, None, {}
    )
    st_session = await session_asyncio.create_new_session_without_request_response(
        "public", sign_in.recipe_user_id, {}, {}, True
    )
    update_res = client.put(
        "/auth/plugin/rownd/user",
        headers={
            **auth_headers(st_session.get_access_token()),
            "Content-Type": "application/json",
        },
        json={"data": {"email": target_email}},
    )
    assert update_res.status_code == 200
    delivered_query = parse_qs(urlparse(delivery_links[0]).query)

    async def fail_replacement_session(*_args: Any, **_kwargs: Any):
        raise RuntimeError("replacement session failed")

    monkeypatch.setattr(
        rownd_plugin.session_asyncio,
        "create_new_session",
        fail_replacement_session,
    )
    verify_res = client.post(
        "/auth/user/email/verify?rowndPendingVerificationId=%s"
        % delivered_query["rowndPendingVerificationId"][0],
        headers={
            **auth_headers(st_session.get_access_token()),
            "Content-Type": "application/json",
            "rid": "emailverification",
        },
        json={"method": "token", "token": delivered_query["token"][0]},
    )

    assert verify_res.status_code == 500
    user = await get_user(sign_in.user.id)
    assert user is not None
    assert {method.email for method in user.login_methods if method.recipe_id == "passwordless"} == {
        current_email
    }
    metadata = await usermetadata_asyncio.get_user_metadata(user.id)
    assert metadata.metadata.get("rownd_pending_verification") == []
    assert "rownd_email_recipe_user_id" not in metadata.metadata
    assert "rownd_email_recipe_user_ids" not in metadata.metadata
    assert "original_rownd_user" not in metadata.metadata
    assert not await emailverification_asyncio.is_email_verified(
        sign_in.recipe_user_id, target_email
    )


async def test_marked_email_change_fails_closed_when_target_becomes_owned_before_completion(
    core_url: str,
    rownd_client: MockRowndClient,
    monkeypatch: pytest.MonkeyPatch,
):
    delivery_links: list[str] = []
    client = make_client(
        core_url,
        rownd_client,
        enable_email_verification=True,
        email_verification_links=delivery_links,
    )
    current_email = "ownership-race-current@example.com"
    target_email = "ownership-race-target@example.com"
    sign_in = await passwordless_asyncio.signinup(
        "public", current_email, None, None, {}
    )
    initiating_session = await session_asyncio.create_new_session_without_request_response(
        "public", sign_in.recipe_user_id, {}, {}, True
    )
    await session_asyncio.create_new_session_without_request_response(
        "public", sign_in.recipe_user_id, {}, {}, True
    )

    update_res = client.put(
        "/auth/plugin/rownd/user",
        headers={
            **auth_headers(initiating_session.get_access_token()),
            "Content-Type": "application/json",
        },
        json={"data": {"email": target_email}},
    )
    assert update_res.status_code == 200
    assert len(delivery_links) == 1
    delivered_query = parse_qs(urlparse(delivery_links[0]).query)
    original_assert_email_available = impl.assert_email_available_for_user
    new_owner: Any = None

    async def claim_email_after_completion_preflight(*args: Any, **kwargs: Any):
        nonlocal new_owner
        await original_assert_email_available(*args, **kwargs)
        new_owner = await passwordless_asyncio.signinup(
            "public", target_email, None, None, {}
        )

    monkeypatch.setattr(
        impl, "assert_email_available_for_user", claim_email_after_completion_preflight
    )

    verify_res = client.post(
        "/auth/user/email/verify?rowndPendingVerificationId=%s"
        % delivered_query["rowndPendingVerificationId"][0],
        headers={
            **auth_headers(initiating_session.get_access_token()),
            "Content-Type": "application/json",
            "rid": "emailverification",
        },
        json={"method": "token", "token": delivered_query["token"][0]},
    )

    assert verify_res.json() == {
        "status": "GENERAL_ERROR",
        "message": "email cannot be used for this account",
    }
    unchanged_user = await get_user(sign_in.user.id)
    assert unchanged_user is not None
    assert unchanged_user.login_methods[0].email == current_email
    owner = await get_user(new_owner.user.id)
    assert owner is not None
    assert owner.login_methods[0].email == target_email
    metadata = await usermetadata_asyncio.get_user_metadata(sign_in.user.id)
    assert metadata.metadata["rownd_pending_verification"] == []
    assert not await emailverification_asyncio.is_email_verified(
        sign_in.recipe_user_id, target_email
    )
    assert await session_asyncio.get_all_session_handles_for_user(
        sign_in.user.id, True, None, {}
    ) == []


async def test_add_passwordless_finalization_failure_removes_created_method_and_cleans_security_state(
    core_url: str,
    rownd_client: MockRowndClient,
    monkeypatch: pytest.MonkeyPatch,
):
    delivery_links: list[str] = []
    client = make_client(
        core_url,
        rownd_client,
        enable_email_verification=True,
        email_verification_links=delivery_links,
    )
    target_email = "add-passwordless-finalization@example.com"
    third_party = cast(
        Any,
        await thirdparty_asyncio.manually_create_or_update_user(
            tenant_id="public",
            third_party_id="google",
            third_party_user_id="add-passwordless-finalization-google",
            email="add-passwordless-provider@example.com",
            is_verified=True,
            user_context={},
        ),
    )
    initiating_session = await session_asyncio.create_new_session_without_request_response(
        "public", third_party.recipe_user_id, {}, {}, True
    )
    await session_asyncio.create_new_session_without_request_response(
        "public", third_party.recipe_user_id, {}, {}, True
    )
    update_res = client.put(
        "/auth/plugin/rownd/user",
        headers={
            **auth_headers(initiating_session.get_access_token()),
            "Content-Type": "application/json",
        },
        json={"data": {"email": target_email}},
    )
    assert update_res.status_code == 200
    assert len(delivery_links) == 1
    delivered_query = parse_qs(urlparse(delivery_links[0]).query)
    original_update_user_metadata = impl.usermetadata_asyncio.update_user_metadata
    linked_method_seen = False

    async def fail_finalization(user_id: str, metadata_update: dict, *args: Any, **kwargs: Any):
        nonlocal linked_method_seen
        rownd_user = metadata_update.get("original_rownd_user", {})
        if rownd_user.get("data", {}).get("email") == target_email:
            user_at_failure = await get_user(user_id)
            linked_method_seen = user_at_failure is not None and any(
                method.recipe_id == "passwordless" and method.email == target_email
                for method in user_at_failure.login_methods
            )
            raise RuntimeError("email metadata finalization failed")
        return await original_update_user_metadata(user_id, metadata_update, *args, **kwargs)

    monkeypatch.setattr(
        impl.usermetadata_asyncio, "update_user_metadata", fail_finalization
    )
    verify_res = client.post(
        "/auth/user/email/verify?rowndPendingVerificationId=%s"
        % delivered_query["rowndPendingVerificationId"][0],
        headers={
            **auth_headers(initiating_session.get_access_token()),
            "Content-Type": "application/json",
            "rid": "emailverification",
        },
        json={"method": "token", "token": delivered_query["token"][0]},
    )

    assert verify_res.status_code == 500
    assert linked_method_seen is True
    compensated_user = await get_user(third_party.user.id)
    assert compensated_user is not None
    assert len(compensated_user.login_methods) == 1
    assert compensated_user.login_methods[0].recipe_id == "thirdparty"
    metadata = await usermetadata_asyncio.get_user_metadata(third_party.user.id)
    assert metadata.metadata.get("rownd_pending_verification") == []
    assert await supertokens_list_users_by_account_info(
        "public", AccountInfoInput(email=target_email), False, {}
    ) == []
    assert not await emailverification_asyncio.is_email_verified(
        third_party.recipe_user_id, target_email
    )
    assert await session_asyncio.get_all_session_handles_for_user(
        third_party.user.id, True, None, {}
    ) == []


@pytest.mark.parametrize("callback_session", ["missing", "revoked", "different"])
async def test_marked_verification_rejects_invalid_callback_session_before_token_consumption(
    core_url: str,
    rownd_client: MockRowndClient,
    callback_session: str,
):
    delivery_links: list[str] = []
    client = make_client(
        core_url,
        rownd_client,
        enable_email_verification=True,
        email_verification_links=delivery_links,
    )
    current_email = "marked-%s-current@example.com" % callback_session
    target_email = "marked-%s-target@example.com" % callback_session
    sign_in = await passwordless_asyncio.signinup(
        "public", current_email, None, None, {}
    )
    initiating_session = await session_asyncio.create_new_session_without_request_response(
        "public", sign_in.recipe_user_id, {}, {}, True
    )
    update_res = client.put(
        "/auth/plugin/rownd/user",
        headers={
            **auth_headers(initiating_session.get_access_token()),
            "Content-Type": "application/json",
        },
        json={"data": {"email": target_email}},
    )
    assert update_res.status_code == 200
    delivered_query = parse_qs(urlparse(delivery_links[0]).query)
    marker = delivered_query["rowndPendingVerificationId"][0]
    token = delivered_query["token"][0]
    callback_headers = {"Content-Type": "application/json", "rid": "emailverification"}
    if callback_session == "different":
        different_session = await session_asyncio.create_new_session_without_request_response(
            "public", sign_in.recipe_user_id, {}, {}, True
        )
        callback_headers.update(auth_headers(different_session.get_access_token()))
        callback_headers["rid"] = "emailverification"
    elif callback_session == "revoked":
        assert await session_asyncio.revoke_session(initiating_session.get_handle())
        callback_headers.update(auth_headers(initiating_session.get_access_token()))
        callback_headers["rid"] = "emailverification"

    rejected_res = client.post(
        "/auth/user/email/verify?rowndPendingVerificationId=%s" % marker,
        headers=callback_headers,
        json={"method": "token", "token": token},
    )
    assert rejected_res.json().get("status") != "OK"

    if callback_session == "revoked":
        retry_headers = {"Content-Type": "application/json", "rid": "emailverification"}
        retry_path = "/auth/user/email/verify"
    else:
        retry_headers = {
            **auth_headers(initiating_session.get_access_token()),
            "Content-Type": "application/json",
            "rid": "emailverification",
        }
        retry_path = "/auth/user/email/verify?rowndPendingVerificationId=%s" % marker
    retry_res = client.post(
        retry_path,
        headers=retry_headers,
        json={"method": "token", "token": token},
    )
    assert retry_res.json() == {"status": "OK"}


async def test_completion_failure_after_committing_cleans_pending_and_sessions(
    core_url: str,
    rownd_client: MockRowndClient,
    monkeypatch: pytest.MonkeyPatch,
):
    client = make_client(core_url, rownd_client, enable_email_verification=True)
    current_email = "committing-failure-current@example.com"
    target_email = "committing-failure-target@example.com"
    sign_in, st_session = await start_native_email_change(
        client, current_email, target_email
    )
    status_at_failure: Optional[str] = None
    original_get_session_information = impl.session_asyncio.get_session_information

    async def fail_after_committing(*_args: Any, **_kwargs: Any):
        nonlocal status_at_failure
        metadata = await usermetadata_asyncio.get_user_metadata(sign_in.user.id)
        status_at_failure = metadata.metadata["rownd_pending_verification"][0]["status"]
        raise RuntimeError("session lookup failed after COMMITTING")

    monkeypatch.setattr(
        impl.session_asyncio, "get_session_information", fail_after_committing
    )
    with pytest.raises(RuntimeError, match="session lookup failed after COMMITTING"):
        await complete_pending_email_verification(
            sign_in.recipe_user_id,
            target_email,
            {},
            "public",
            st_session.get_handle(),
        )

    assert status_at_failure == "PENDING"
    user = await get_user(sign_in.user.id)
    assert user is not None
    assert user.login_methods[0].email == current_email
    metadata = await usermetadata_asyncio.get_user_metadata(sign_in.user.id)
    assert metadata.metadata["rownd_pending_verification"] == []
    monkeypatch.setattr(
        impl.session_asyncio, "get_session_information", original_get_session_information
    )
    assert await session_asyncio.get_session_information(st_session.get_handle()) is not None


async def test_later_completion_failure_rolls_back_changed_credential(
    core_url: str,
    rownd_client: MockRowndClient,
    monkeypatch: pytest.MonkeyPatch,
):
    client = make_client(core_url, rownd_client, enable_email_verification=True)
    current_email = "credential-rollback-current@example.com"
    target_email = "credential-rollback-target@example.com"
    sign_in, st_session = await start_native_email_change(
        client, current_email, target_email
    )
    original_revoke_all = impl.session_asyncio.revoke_all_sessions_for_user
    revoke_count = 0
    email_at_failure: Optional[str] = None

    async def fail_second_revocation(*args: Any, **kwargs: Any):
        nonlocal revoke_count, email_at_failure
        revoke_count += 1
        if revoke_count == 2:
            user = await get_user(sign_in.user.id)
            assert user is not None
            email_at_failure = user.login_methods[0].email
            raise RuntimeError("second account revocation failed")
        return await original_revoke_all(*args, **kwargs)

    monkeypatch.setattr(
        impl.session_asyncio, "revoke_all_sessions_for_user", fail_second_revocation
    )
    with pytest.raises(RuntimeError, match="second account revocation failed"):
        await complete_pending_email_verification(
            sign_in.recipe_user_id,
            target_email,
            {},
            "public",
            st_session.get_handle(),
        )

    assert revoke_count == 3
    assert email_at_failure == current_email
    user = await get_user(sign_in.user.id)
    assert user is not None
    assert {method.email for method in user.login_methods if method.recipe_id == "passwordless"} == {
        current_email
    }
    metadata = await usermetadata_asyncio.get_user_metadata(sign_in.user.id)
    assert metadata.metadata["rownd_pending_verification"] == []
    assert await session_asyncio.get_all_session_handles_for_user(
        sign_in.user.id, True, None, {}
    ) == []


async def test_completion_revokes_session_raced_between_account_revocations(
    core_url: str,
    rownd_client: MockRowndClient,
    monkeypatch: pytest.MonkeyPatch,
):
    client = make_client(core_url, rownd_client, enable_email_verification=True)
    current_email = "revocation-race-current@example.com"
    target_email = "revocation-race-target@example.com"
    sign_in, st_session = await start_native_email_change(
        client, current_email, target_email
    )
    original_revoke_all = impl.session_asyncio.revoke_all_sessions_for_user
    revoke_count = 0
    raced_session_handle: Optional[str] = None

    async def create_raced_session(*args: Any, **kwargs: Any):
        nonlocal revoke_count, raced_session_handle
        result = await original_revoke_all(*args, **kwargs)
        revoke_count += 1
        if revoke_count == 1:
            raced_sign_in = await passwordless_asyncio.signinup(
                "public", current_email, None, None, {}
            )
            raced_session = await session_asyncio.create_new_session_without_request_response(
                "public", raced_sign_in.recipe_user_id, {}, {}, True
            )
            raced_session_handle = raced_session.get_handle()
        return result

    monkeypatch.setattr(
        impl.session_asyncio, "revoke_all_sessions_for_user", create_raced_session
    )
    result = await complete_pending_email_verification(
        sign_in.recipe_user_id,
        target_email,
        {},
        "public",
        st_session.get_handle(),
    )

    assert result is not None
    assert revoke_count == 2
    assert raced_session_handle is not None
    assert await session_asyncio.get_session_information(raced_session_handle) is None
    user = await get_user(sign_in.user.id)
    assert user is not None
    assert {method.email for method in user.login_methods if method.recipe_id == "passwordless"} == {
        current_email,
        target_email,
    }


async def test_email_verification_rejects_revoked_initiating_session(
    memory_core_url: str, rownd_client: MockRowndClient
):
    client = make_client(memory_core_url, rownd_client, enable_email_verification=True)
    sign_in = await passwordless_asyncio.signinup(
        "public", "revoked-current@example.com", None, None, {}
    )
    st_session = await session_asyncio.create_new_session_without_request_response(
        "public", sign_in.recipe_user_id, {}, {}, True
    )
    access_token = st_session.get_access_token()
    old_session_handle = st_session.get_handle()
    verified_email = "revoked-target@example.com"

    update_res = client.put(
        "/auth/plugin/rownd/user",
        headers={**auth_headers(access_token), "Content-Type": "application/json"},
        json={"data": {"email": verified_email}},
    )
    assert update_res.status_code == 200

    assert await session_asyncio.revoke_session(old_session_handle)
    with pytest.raises(RowndEmailChangeError, match="email change session is no longer active"):
        await complete_pending_email_verification(
            sign_in.recipe_user_id,
            verified_email,
            {},
            "public",
            old_session_handle,
        )
    user = await get_user(sign_in.user.id)
    assert user is not None
    assert user.login_methods[0].email == "revoked-current@example.com"
    metadata = await usermetadata_asyncio.get_user_metadata(sign_in.user.id)
    assert metadata.metadata["rownd_pending_verification"] == []


async def test_email_verification_rejects_unsupported_pending_purpose(
    core_url: str, rownd_client: MockRowndClient
):
    client = make_client(core_url, rownd_client, enable_email_verification=True)
    current_email = "unsupported-purpose-current@example.com"
    target_email = "unsupported-purpose-target@example.com"
    sign_in, st_session = await start_native_email_change(client, current_email, target_email)
    metadata = await usermetadata_asyncio.get_user_metadata(sign_in.user.id)
    pending = metadata.metadata["rownd_pending_verification"][0]
    await usermetadata_asyncio.update_user_metadata(
        sign_in.user.id,
        {"rownd_pending_verification": [{**pending, "purpose": "UPGRADE_GUEST"}]},
    )

    with pytest.raises(RowndEmailChangeError, match="email change session is no longer active"):
        await complete_pending_email_verification(
            sign_in.recipe_user_id, target_email, {}, "public", st_session.get_handle()
        )

    user = await get_user(sign_in.user.id)
    assert user is not None
    assert user.login_methods[0].email == current_email
    metadata = await usermetadata_asyncio.get_user_metadata(sign_in.user.id)
    assert metadata.metadata["rownd_pending_verification"] == []


async def test_email_verification_rejects_detached_initiating_method(
    core_url: str, rownd_client: MockRowndClient, monkeypatch: pytest.MonkeyPatch
):
    client = make_client(core_url, rownd_client, enable_email_verification=True)
    current_email = "detached-session-current@example.com"
    target_email = "detached-session-target@example.com"
    sign_in, st_session = await start_native_email_change(client, current_email, target_email)
    original_get_user = impl.get_user
    get_user_calls = 0

    async def get_user_with_detached_method(*args: Any, **kwargs: Any):
        nonlocal get_user_calls
        user = await original_get_user(*args, **kwargs)
        get_user_calls += 1
        if get_user_calls == 2 and user is not None:
            return SimpleNamespace(
                id=user.id, is_primary_user=user.is_primary_user, login_methods=[]
            )
        return user

    monkeypatch.setattr(impl, "get_user", get_user_with_detached_method)
    with pytest.raises(RowndEmailChangeError, match="email change session is no longer active"):
        await complete_pending_email_verification(
            sign_in.recipe_user_id, target_email, {}, "public", st_session.get_handle()
        )

    monkeypatch.setattr(impl, "get_user", original_get_user)
    user = await get_user(sign_in.user.id)
    assert user is not None
    assert user.login_methods[0].email == current_email


async def test_email_verification_rejects_changed_passwordless_topology(
    core_url: str, rownd_client: MockRowndClient
):
    client = make_client(core_url, rownd_client, enable_email_verification=True)
    target_email = "topology-target@example.com"
    third_party = cast(
        Any,
        await thirdparty_asyncio.manually_create_or_update_user(
            tenant_id="public",
            third_party_id="google",
            third_party_user_id="topology-google-user",
            email="topology-google@example.com",
            is_verified=True,
            user_context={},
        ),
    )
    st_session = await session_asyncio.create_new_session_without_request_response(
        "public", third_party.recipe_user_id, {}, {}, True
    )
    update_res = client.put(
        "/auth/plugin/rownd/user",
        headers={
            **auth_headers(st_session.get_access_token()),
            "Content-Type": "application/json",
        },
        json={"data": {"email": target_email}},
    )
    assert update_res.status_code == 200
    primary = await accountlinking_asyncio.create_primary_user(third_party.recipe_user_id, {})
    assert getattr(primary, "status", "OK") == "OK"
    passwordless = await passwordless_asyncio.signinup(
        "public", "topology-added@example.com", None, None, {}
    )
    linked = await accountlinking_asyncio.link_accounts(
        passwordless.recipe_user_id, third_party.user.id, {}
    )
    assert getattr(linked, "status", "OK") == "OK"

    with pytest.raises(
        RowndEmailChangeError,
        match="email change session is no longer active",
    ):
        await complete_pending_email_verification(
            third_party.recipe_user_id, target_email, {}, "public", st_session.get_handle()
        )

    user = await get_user(third_party.user.id)
    assert user is not None
    assert all(method.email != target_email for method in user.login_methods)


@pytest.mark.parametrize("mixed_method", ["guest", "emailpassword"])
async def test_email_change_rejects_mixed_non_passwordless_topology(
    core_url: str,
    rownd_client: MockRowndClient,
    mixed_method: str,
):
    delivery_links: list[str] = []
    client = make_client(
        core_url,
        rownd_client,
        enable_email_verification=True,
        email_verification_links=delivery_links,
        enable_email_password=mixed_method == "emailpassword",
    )
    third_party = cast(
        Any,
        await thirdparty_asyncio.manually_create_or_update_user(
            tenant_id="public",
            third_party_id="google",
            third_party_user_id="mixed-%s-google" % mixed_method,
            email="mixed-%s-google@example.com" % mixed_method,
            is_verified=True,
            user_context={},
        ),
    )
    primary = await accountlinking_asyncio.create_primary_user(
        third_party.recipe_user_id, {}
    )
    assert getattr(primary, "status", "OK") == "OK"
    if mixed_method == "guest":
        additional_method = cast(
            Any,
            await thirdparty_asyncio.manually_create_or_update_user(
                tenant_id="public",
                third_party_id="guest",
                third_party_user_id="mixed-guest-id",
                email="mixed-guest@anonymous.local",
                is_verified=False,
                user_context={},
            ),
        )
    else:
        additional_method = cast(
            Any,
            await emailpassword_asyncio.sign_up(
                "public",
                "mixed-emailpassword@example.com",
                "correct horse battery staple",
                None,
                {},
            ),
        )
    linked = await accountlinking_asyncio.link_accounts(
        additional_method.recipe_user_id, third_party.user.id, {}
    )
    assert getattr(linked, "status", "OK") == "OK"
    st_session = await session_asyncio.create_new_session_without_request_response(
        "public", third_party.recipe_user_id, {}, {}, True
    )

    update_res = client.put(
        "/auth/plugin/rownd/user",
        headers={
            **auth_headers(st_session.get_access_token()),
            "Content-Type": "application/json",
        },
        json={"data": {"email": "mixed-%s-target@example.com" % mixed_method}},
    )

    assert update_res.status_code == 409
    assert update_res.json()["message"] == "the account has no passwordless sign-in method"
    metadata = await usermetadata_asyncio.get_user_metadata(third_party.user.id)
    assert "rownd_pending_verification" not in metadata.metadata
    assert delivery_links == []


async def test_replacing_legacy_pending_verification_revokes_tokens_for_all_methods(
    core_url: str, rownd_client: MockRowndClient
):
    client = make_client(core_url, rownd_client, enable_email_verification=True)
    current_email = "legacy-revocation-current@example.com"
    old_target_email = "legacy-revocation-old@example.com"
    sign_in, st_session = await start_native_email_change(
        client, current_email, old_target_email
    )
    primary = await accountlinking_asyncio.create_primary_user(sign_in.recipe_user_id, {})
    assert getattr(primary, "status", "OK") == "OK"
    third_party = cast(
        Any,
        await thirdparty_asyncio.manually_create_or_update_user(
            tenant_id="public",
            third_party_id="google",
            third_party_user_id="legacy-revocation-google-user",
            email="legacy-revocation-google@example.com",
            is_verified=True,
            user_context={},
        ),
    )
    linked = await accountlinking_asyncio.link_accounts(
        third_party.recipe_user_id, sign_in.user.id, {}
    )
    assert getattr(linked, "status", "OK") == "OK"
    token_result = await emailverification_asyncio.create_email_verification_token(
        "public", third_party.recipe_user_id, old_target_email, {}
    )
    token = getattr(token_result, "token", None)
    assert isinstance(token, str)
    metadata = await usermetadata_asyncio.get_user_metadata(sign_in.user.id)
    pending = metadata.metadata["rownd_pending_verification"][0]
    legacy_pending = {
        key: value
        for key, value in pending.items()
        if key not in {"verificationRecipeUserId", "status"}
    }
    await usermetadata_asyncio.update_user_metadata(
        sign_in.user.id, {"rownd_pending_verification": [legacy_pending]}
    )

    replacement_res = client.put(
        "/auth/plugin/rownd/user",
        headers={
            **auth_headers(st_session.get_access_token()),
            "Content-Type": "application/json",
        },
        json={"data": {"email": "legacy-revocation-new@example.com"}},
    )

    assert replacement_res.status_code == 200
    verification_result = await emailverification_asyncio.verify_email_using_token(
        "public", token, False, {}
    )
    assert verification_result.__class__.__name__ == "VerifyEmailUsingTokenInvalidTokenError"


async def test_email_verification_completes_valid_legacy_pending_record_without_status(
    core_url: str, rownd_client: MockRowndClient
):
    client = make_client(core_url, rownd_client, enable_email_verification=True)
    target_email = "legacy-completion-target@example.com"
    sign_in, st_session = await start_native_email_change(
        client, "legacy-completion-current@example.com", target_email
    )
    metadata = await usermetadata_asyncio.get_user_metadata(sign_in.user.id)
    pending = metadata.metadata["rownd_pending_verification"][0]
    legacy_pending = {
        key: pending[key]
        for key in (
            "id",
            "field",
            "value",
            "created_at",
            "tenantId",
            "purpose",
            "initiatingSessionHandle",
            "verificationRecipeUserId",
        )
    }
    await usermetadata_asyncio.update_user_metadata(
        sign_in.user.id, {"rownd_pending_verification": [legacy_pending]}
    )

    result = await complete_pending_email_verification(
        sign_in.recipe_user_id,
        target_email,
        {},
        "public",
        st_session.get_handle(),
    )

    assert result is not None
    user = await get_user(sign_in.user.id)
    assert user is not None
    assert {method.email for method in user.login_methods if method.recipe_id == "passwordless"} == {
        "legacy-completion-current@example.com",
        target_email,
    }
    canonical_method = next(method for method in user.login_methods if method.email == target_email)
    metadata = await usermetadata_asyncio.get_user_metadata(sign_in.user.id)
    assert metadata.metadata["original_rownd_user"]["data"]["email"] == target_email
    assert metadata.metadata["original_rownd_user"]["verified_data"]["email"] == target_email
    assert metadata.metadata["rownd_email_recipe_user_id"] == (
        canonical_method.recipe_user_id.get_as_string()
    )
    assert metadata.metadata["rownd_pending_verification"] == []


async def test_email_update_replaces_only_pending_email_entry(
    core_url: str, rownd_client: MockRowndClient
):
    client = make_client(core_url, rownd_client, enable_email_verification=True)
    sign_in = await passwordless_asyncio.signinup(
        "public", "replace-pending-current@example.com", None, None, {}
    )
    st_session = await session_asyncio.create_new_session_without_request_response(
        "public", sign_in.recipe_user_id, {}, {}, True
    )
    access_token = st_session.get_access_token()
    user_id = sign_in.user.id

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
                {
                    "id": "phone-pending",
                    "field": "phone_number",
                    "value": "+15555550123",
                    "created_at": "2026-01-01T00:00:00Z",
                },
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
    assert pending[0] == {
        "id": "phone-pending",
        "field": "phone_number",
        "value": "+15555550123",
        "created_at": "2026-01-01T00:00:00Z",
    }
    assert pending[1]["field"] == "email"
    assert pending[1]["value"] == "new-pending@example.com"


async def test_email_verification_removes_duplicate_matching_pending_entries(
    core_url: str, rownd_client: MockRowndClient
):
    client = make_client(core_url, rownd_client, enable_email_verification=True)
    sign_in = await passwordless_asyncio.signinup(
        "public", "duplicate-pending-current@example.com", None, None, {}
    )
    st_session = await session_asyncio.create_new_session_without_request_response(
        "public", sign_in.recipe_user_id, {}, {}, True
    )
    update_res = client.put(
        "/auth/plugin/rownd/user",
        headers={
            **auth_headers(st_session.get_access_token()),
            "Content-Type": "application/json",
        },
        json={"data": {"email": "duplicate-target@example.com"}},
    )
    assert update_res.status_code == 200
    pending_metadata = await usermetadata_asyncio.get_user_metadata(sign_in.user.id)
    pending = pending_metadata.metadata["rownd_pending_verification"][0]
    await usermetadata_asyncio.update_user_metadata(
        sign_in.user.id,
        {
            "rownd_pending_verification": [
                pending,
                {**pending, "id": "duplicate-email-2"},
                {
                    "id": "future-phone",
                    "field": "phone_number",
                    "value": "+15555550123",
                    "created_at": "2026-01-01T00:00:00Z",
                },
            ]
        },
    )

    await complete_pending_email_verification(
        sign_in.recipe_user_id,
        "duplicate-target@example.com",
        {},
        "public",
        st_session.get_handle(),
    )

    metadata = await usermetadata_asyncio.get_user_metadata(sign_in.user.id)
    assert metadata.metadata["rownd_pending_verification"] == [
        {
            "id": "future-phone",
            "field": "phone_number",
            "value": "+15555550123",
            "created_at": "2026-01-01T00:00:00Z",
        }
    ]


@pytest.mark.parametrize("authenticated_recipe", ["passwordless", "thirdparty"])
async def test_linked_guest_claims_keep_exact_anonymous_id_but_clear_anonymous_flags(
    memory_core_url: str,
    rownd_client: MockRowndClient,
    authenticated_recipe: str,
):
    client = make_client(memory_core_url, rownd_client)
    guest = client.post(
        "/auth/plugin/rownd/guest",
        headers={"Content-Type": "application/json", **session_headers()},
        json={"auth_level": "guest"},
    )
    access_token = guest.headers["st-access-token"]
    st_session = await session_asyncio.get_session_without_request_response(access_token)
    assert st_session is not None
    pre_link_payload = st_session.get_access_token_payload()
    anonymous_id = pre_link_payload["anonymous_id"]
    if authenticated_recipe == "passwordless":
        authenticated_result = await passwordless_asyncio.signinup(
            "public", "linked@example.com", None, None, {}
        )
    else:
        authenticated_result = await thirdparty_asyncio.manually_create_or_update_user(
            "public", "google", "linked-google-id", "linked-google@example.com", True, None, {}
        )
    authenticated_result = cast(Any, authenticated_result)

    primary = await accountlinking_asyncio.create_primary_user(
        st_session.get_recipe_user_id(), {}
    )
    assert getattr(primary, "status", "OK") == "OK"
    link_result = await accountlinking_asyncio.link_accounts(
        authenticated_result.recipe_user_id, cast(Any, primary).user.id, {}
    )
    assert getattr(link_result, "status", "OK") == "OK"

    claims = await build_rownd_session_claims(
        RowndPluginConfig(rownd_app_key="test-key", rownd_app_secret="test-secret"),
        cast(Any, link_result).user.id,
        pre_link_payload,
        None,
    )
    assert claims["auth_level"] == "verified"
    assert claims["anonymous_id"] == anonymous_id
    assert "is_anonymous" not in claims
    assert ROWND_JWT_CLAIMS["is_anonymous"] not in claims
    assert "aud" not in claims

    await rownd_plugin.refresh_rownd_session_claims(
        RowndPluginConfig(rownd_app_key="test-key", rownd_app_secret="test-secret"),
        st_session,
        cast(Any, link_result).user.id,
        None,
        {},
    )
    refreshed_payload = st_session.get_access_token_payload()
    assert refreshed_payload["auth_level"] == "verified"
    assert refreshed_payload["anonymous_id"] == anonymous_id
    assert refreshed_payload["is_anonymous"]["v"] is False
    assert ROWND_JWT_CLAIMS["is_anonymous"] not in refreshed_payload
    assert "aud" not in refreshed_payload


async def test_email_verification_preserves_existing_passwordless_method_as_alias(
    core_url: str, rownd_client: MockRowndClient
):
    client = make_client(core_url, rownd_client, enable_email_verification=True)
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
            "rownd_email_recipe_user_ids": {"tenant-b": "tenant-b-canonical"},
        },
    )
    st_session = await session_asyncio.create_new_session_without_request_response(
        "public", sign_in.recipe_user_id, {}, {}, True
    )
    update_res = client.put(
        "/auth/plugin/rownd/user",
        headers={
            **auth_headers(st_session.get_access_token()),
            "Content-Type": "application/json",
        },
        json={"data": {"email": "new-passwordless@example.com"}},
    )
    assert update_res.status_code == 200

    await complete_pending_email_verification(
        sign_in.recipe_user_id,
        "new-passwordless@example.com",
        {},
        "public",
        st_session.get_handle(),
    )

    user = await get_user(sign_in.user.id)
    assert user is not None
    passwordless_methods = [
        method for method in user.login_methods if method.recipe_id == "passwordless"
    ]
    assert {method.email for method in passwordless_methods} == {
        "old-passwordless@example.com",
        "new-passwordless@example.com",
    }
    canonical_method = next(
        method for method in passwordless_methods if method.email == "new-passwordless@example.com"
    )
    metadata = await usermetadata_asyncio.get_user_metadata(sign_in.user.id)
    assert metadata.metadata["rownd_pending_verification"] == []
    assert metadata.metadata["original_rownd_user"]["data"]["email"] == "new-passwordless@example.com"
    assert metadata.metadata["rownd_email_recipe_user_ids"] == {
        "tenant-b": "tenant-b-canonical",
        "public": canonical_method.recipe_user_id.get_as_string(),
    }

    replacement_session = await session_asyncio.create_new_session_without_request_response(
        "public", canonical_method.recipe_user_id, {}, {}, True
    )
    restore_res = client.put(
        "/auth/plugin/rownd/user",
        headers={
            **auth_headers(replacement_session.get_access_token()),
            "Content-Type": "application/json",
        },
        json={"data": {"email": "old-passwordless@example.com"}},
    )
    assert restore_res.status_code == 200
    restore_completion = await complete_pending_email_verification(
        canonical_method.recipe_user_id,
        "old-passwordless@example.com",
        {},
        "public",
        replacement_session.get_handle(),
    )
    restored_user = await get_user(sign_in.user.id)
    assert restored_user is not None
    restored_methods = [
        method for method in restored_user.login_methods if method.recipe_id == "passwordless"
    ]
    assert len(restored_methods) == 2
    restored_metadata = await usermetadata_asyncio.get_user_metadata(sign_in.user.id)
    assert restored_metadata.metadata["rownd_email_recipe_user_ids"]["public"] == (
        sign_in.recipe_user_id.get_as_string()
    )
    assert restore_completion is not None
    rollback = cast(Any, restore_completion["rollback_on_session_replacement_failure"])
    await rollback()
    rolled_back_user = await get_user(sign_in.user.id)
    assert rolled_back_user is not None
    assert {method.email for method in rolled_back_user.login_methods} == {
        "old-passwordless@example.com",
        "new-passwordless@example.com",
    }
    rolled_back_metadata = await usermetadata_asyncio.get_user_metadata(sign_in.user.id)
    assert rolled_back_metadata.metadata["original_rownd_user"]["data"]["email"] == (
        "new-passwordless@example.com"
    )
    assert rolled_back_metadata.metadata["original_rownd_user"]["verified_data"][
        "email"
    ] == "new-passwordless@example.com"
    assert rolled_back_metadata.metadata["rownd_email_recipe_user_id"] == (
        canonical_method.recipe_user_id.get_as_string()
    )
    assert rolled_back_metadata.metadata["rownd_email_recipe_user_ids"] == {
        "tenant-b": "tenant-b-canonical",
        "public": canonical_method.recipe_user_id.get_as_string(),
    }


async def test_email_verification_adds_canonical_passwordless_to_thirdparty_user(
    core_url: str, rownd_client: MockRowndClient
):
    client = make_client(core_url, rownd_client, enable_email_verification=True)
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
        },
    )
    st_session = await session_asyncio.create_new_session_without_request_response(
        "public", result.recipe_user_id, {}, {}, True
    )
    update_res = client.put(
        "/auth/plugin/rownd/user",
        headers={
            **auth_headers(st_session.get_access_token()),
            "Content-Type": "application/json",
        },
        json={"data": {"email": "thirdparty-updated@example.com"}},
    )
    assert update_res.status_code == 200

    metadata = await usermetadata_asyncio.get_user_metadata(result.user.id)
    pending_id = metadata.metadata["rownd_pending_verification"][0]["id"]
    token_result = await emailverification_asyncio.create_email_verification_token(
        "public", result.recipe_user_id, "thirdparty-updated@example.com", {}
    )
    token = getattr(token_result, "token", None)
    assert isinstance(token, str)
    verify_res = client.post(
        "/auth/user/email/verify?rowndPendingVerificationId=%s" % pending_id,
        headers={
            **auth_headers(st_session.get_access_token()),
            "Content-Type": "application/json",
            "rid": "emailverification",
        },
        json={"method": "token", "token": token},
    )
    assert verify_res.json() == {"status": "OK"}
    assert verify_res.headers.get("st-access-token")

    user = await get_user(result.user.id)
    assert user is not None
    assert len(user.login_methods) == 2
    assert any(method.recipe_id == "thirdparty" for method in user.login_methods)
    passwordless_method = next(
        method for method in user.login_methods if method.recipe_id == "passwordless"
    )
    assert passwordless_method.email == "thirdparty-updated@example.com"
    metadata = await usermetadata_asyncio.get_user_metadata(result.user.id)
    assert metadata.metadata["original_rownd_user"]["data"]["email"] == "thirdparty-updated@example.com"
    assert metadata.metadata["rownd_email_recipe_user_id"] == (
        passwordless_method.recipe_user_id.get_as_string()
    )


async def test_email_verification_ignores_passwordless_methods_in_other_tenants(
    core_url: str, rownd_client: MockRowndClient
):
    client = make_client(core_url, rownd_client, enable_email_verification=True)
    tenant_id = "email-topology-other-tenant"
    await multitenancy_asyncio.create_or_update_tenant(tenant_id, None, {})
    thirdparty = await thirdparty_asyncio.manually_create_or_update_user(
        tenant_id="public",
        third_party_id="google",
        third_party_user_id="cross-tenant-topology-user",
        email="cross-tenant-thirdparty@example.com",
        is_verified=True,
        user_context={},
    )
    assert getattr(thirdparty, "status", "OK") == "OK"
    thirdparty = cast(Any, thirdparty)
    foreign_passwordless = await passwordless_asyncio.signinup(
        tenant_id, "cross-tenant-passwordless@example.com", None, None, {}
    )
    primary = await accountlinking_asyncio.create_primary_user(
        thirdparty.recipe_user_id, {}
    )
    assert getattr(primary, "status", "OK") == "OK"
    linked = await accountlinking_asyncio.link_accounts(
        foreign_passwordless.recipe_user_id, thirdparty.user.id, {}
    )
    assert getattr(linked, "status", "OK") == "OK"
    st_session = await session_asyncio.create_new_session_without_request_response(
        "public", thirdparty.recipe_user_id, {}, {}, True
    )
    target_email = "cross-tenant-target@example.com"

    response = client.put(
        "/auth/plugin/rownd/user",
        headers={
            **auth_headers(st_session.get_access_token()),
            "Content-Type": "application/json",
        },
        json={"data": {"email": target_email}},
    )

    assert response.status_code == 200
    completion = await complete_pending_email_verification(
        thirdparty.recipe_user_id,
        target_email,
        {},
        "public",
        st_session.get_handle(),
    )
    assert completion is not None
    user = await get_user(thirdparty.user.id)
    assert user is not None
    public_passwordless = [
        method
        for method in user.login_methods
        if method.recipe_id == "passwordless" and "public" in method.tenant_ids
    ]
    assert [method.email for method in public_passwordless] == [target_email]
    assert any(
        method.recipe_user_id.get_as_string()
        == foreign_passwordless.recipe_user_id.get_as_string()
        and method.tenant_ids == [tenant_id]
        for method in user.login_methods
    )


async def test_email_verification_links_email_without_mutating_phone_only_method(
    core_url: str, rownd_client: MockRowndClient
):
    delivery_links: list[str] = []
    client = make_client(
        core_url,
        rownd_client,
        enable_email_verification=True,
        email_verification_links=delivery_links,
    )
    phone_number = "+15555550199"
    target_email = "phone-only-target@example.com"
    sign_in = await passwordless_asyncio.signinup(
        "public", None, phone_number, None, {}
    )
    st_session = await session_asyncio.create_new_session_without_request_response(
        "public", sign_in.recipe_user_id, {}, {}, True
    )

    update_res = client.put(
        "/auth/plugin/rownd/user",
        headers={
            **auth_headers(st_session.get_access_token()),
            "Content-Type": "application/json",
        },
        json={"data": {"email": target_email}},
    )
    assert update_res.status_code == 200
    assert len(delivery_links) == 1
    delivered_query = parse_qs(urlparse(delivery_links[0]).query)
    assert delivered_query["rowndPendingVerificationId"]
    assert delivered_query["token"]

    verify_res = client.post(
        "/auth/user/email/verify?rowndPendingVerificationId=%s"
        % delivered_query["rowndPendingVerificationId"][0],
        headers={
            **auth_headers(st_session.get_access_token()),
            "Content-Type": "application/json",
            "rid": "emailverification",
        },
        json={"method": "token", "token": delivered_query["token"][0]},
    )
    assert verify_res.json() == {"status": "OK"}
    assert verify_res.headers.get("st-access-token")

    user = await get_user(sign_in.user.id)
    assert user is not None
    methods = [method for method in user.login_methods if method.recipe_id == "passwordless"]
    assert len(methods) == 2
    phone_method = next(
        method
        for method in methods
        if method.recipe_user_id.get_as_string() == sign_in.recipe_user_id.get_as_string()
    )
    email_method = next(method for method in methods if method.email == target_email)
    assert phone_method.email is None
    assert phone_method.phone_number == phone_number
    assert email_method.recipe_user_id.get_as_string() != phone_method.recipe_user_id.get_as_string()


async def test_thirdparty_email_addition_rolls_back_if_replacement_session_fails(
    core_url: str, rownd_client: MockRowndClient
):
    client = make_client(core_url, rownd_client, enable_email_verification=True)
    target_email = "thirdparty-rollback-target@example.com"
    third_party = cast(
        Any,
        await thirdparty_asyncio.manually_create_or_update_user(
            tenant_id="public",
            third_party_id="google",
            third_party_user_id="thirdparty-rollback-google",
            email="thirdparty-rollback-provider@example.com",
            is_verified=True,
            user_context={},
        ),
    )
    linked_third_party = cast(
        Any,
        await thirdparty_asyncio.manually_create_or_update_user(
            tenant_id="public",
            third_party_id="github",
            third_party_user_id="thirdparty-rollback-github",
            email="thirdparty-rollback-linked@example.com",
            is_verified=True,
            user_context={"rowndDisableAutomaticAccountLinking": True},
        ),
    )
    primary = await accountlinking_asyncio.create_primary_user(
        third_party.recipe_user_id, {}
    )
    assert getattr(primary, "status", "OK") == "OK"
    linked = await accountlinking_asyncio.link_accounts(
        linked_third_party.recipe_user_id, third_party.user.id, {}
    )
    assert getattr(linked, "status", "OK") == "OK"
    linked_snapshot = {
        "original_rownd_user": {
            "state": "enabled",
            "auth_level": "verified",
            "data": {
                "user_id": "thirdparty-rollback-rownd-user",
                "email": "thirdparty-rollback-provider@example.com",
            },
            "verified_data": {"email": "thirdparty-rollback-provider@example.com"},
        },
        "linked_only": "preserve",
    }
    linked_recipe_user_id = linked_third_party.recipe_user_id.get_as_string()
    await usermetadata_asyncio.update_user_metadata(
        linked_recipe_user_id, linked_snapshot
    )
    st_session = await session_asyncio.create_new_session_without_request_response(
        "public", third_party.recipe_user_id, {}, {}, True
    )
    update_res = client.put(
        "/auth/plugin/rownd/user",
        headers={
            **auth_headers(st_session.get_access_token()),
            "Content-Type": "application/json",
        },
        json={"data": {"email": target_email}},
    )
    assert update_res.status_code == 200
    completion = await complete_pending_email_verification(
        third_party.recipe_user_id,
        target_email,
        {},
        "public",
        st_session.get_handle(),
    )
    assert completion is not None

    rollback = cast(Any, completion["rollback_on_session_replacement_failure"])
    await rollback()

    user = await get_user(third_party.user.id)
    assert user is not None
    assert len(user.login_methods) == 2
    assert all(method.recipe_id == "thirdparty" for method in user.login_methods)
    assert all(method.email != target_email for method in user.login_methods)
    metadata = await usermetadata_asyncio.get_user_metadata(user.id)
    assert metadata.metadata.get("rownd_pending_verification") == []
    assert "rownd_email_recipe_user_id" not in metadata.metadata
    assert "rownd_email_recipe_user_ids" not in metadata.metadata
    assert "original_rownd_user" not in metadata.metadata
    linked_metadata = await usermetadata_asyncio.get_user_metadata(
        linked_recipe_user_id
    )
    assert linked_metadata.metadata == linked_snapshot


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
        "last_passkey_registration_prompt": "2026-04-23T00:00:00.000Z",
    }
    assert get_res.status_code == 200
    assert get_res.json()["meta"] == {
        "created": "2026-01-01T00:00:00.000Z",
        "last_passkey_registration_prompt": "2026-04-23T00:00:00.000Z",
    }


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

    mapping = await get_user_id_mapping("py-metadata-structure-user", "EXTERNAL")
    assert isinstance(mapping, GetUserIdMappingOkResult)
    primary_metadata = await usermetadata_asyncio.get_user_metadata(mapping.supertokens_user_id)
    secondary_metadata = await usermetadata_asyncio.get_user_metadata(
        "py-metadata-structure-user"
    )
    assert primary_metadata.metadata == {
        "first_name": "John",
        "custom_field": "custom_value",
    }
    assert secondary_metadata.metadata["original_rownd_user"]["data"]["user_id"] == (
        "py-metadata-structure-user"
    )
    assert "first_name" not in secondary_metadata.metadata
    assert "custom_field" not in secondary_metadata.metadata
    assert "data" not in secondary_metadata.metadata
    assert "meta" not in secondary_metadata.metadata
    assert "verified_data" not in secondary_metadata.metadata
    assert "attributes" not in secondary_metadata.metadata

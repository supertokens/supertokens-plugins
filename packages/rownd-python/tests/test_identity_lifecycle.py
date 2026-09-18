from __future__ import annotations

import uuid
from copy import deepcopy
from typing import Any, cast
from unittest.mock import AsyncMock

import pytest
from supertokens_python.asyncio import get_user as sdk_get_user, get_user_id_mapping, delete_user_id_mapping
from supertokens_python.interfaces import GetUserIdMappingOkResult
from supertokens_python.recipe.session import asyncio as sessions
from supertokens_python.recipe.multitenancy import asyncio as tenants
from supertokens_python.recipe.thirdparty import asyncio as providers
from supertokens_python.recipe.thirdparty.interfaces import ManuallyCreateOrUpdateUserOkResult
from supertokens_python.recipe.accountlinking import asyncio as linking
from supertokens_python.recipe.usermetadata import asyncio as metadata_api

from conftest import make_client
from supertokens_rownd import supertokens_repository as repo
from supertokens_rownd.errors import MigrationError
from supertokens_rownd.migration import create_rownd_identity_snapshot
from supertokens_rownd.migration_authority import (
    _bind_authenticated_source, assert_source_authority, authenticated_source_email,
)


async def get_user(user_id: str):
    user = await sdk_get_user(user_id)
    assert user is not None
    return user


def subject(method):
    assert method.third_party is not None
    return method.third_party.user_id


@pytest.mark.parametrize("value", [None, ""])
@pytest.mark.parametrize("field", ["email", "phone_number", "google_id", "apple_id"])
def test_optional_identity_cells(value, field):
    profile: dict[str, Any] = {"data": {"user_id": "r", field: value}, "verified_data": {field: value}}
    assert create_rownd_identity_snapshot(profile, "public").expected_identities == ()


def test_verified_subject_and_boolean_evidence():
    profile: dict[str, Any] = {"data": {"user_id": "r", "google_id": "old", "apple_id": "apple"},
               "verified_data": {"google_id": "new", "apple_id": True}}
    identities = create_rownd_identity_snapshot(profile, "public").expected_identities
    assert {(item.provider_user_id, item.verified) for item in identities} == {("new", True), ("apple", True)}
    assert profile["verified_data"]["apple_id"] is True


@pytest.mark.parametrize("provider", ["google", "apple"])
@pytest.mark.parametrize("evidence", [None, False, True, "", "   ", 123])
def test_provider_mapper_falls_back_but_online_source_rejects_malformed_evidence(provider, evidence):
    profile: dict[str, Any] = {"data": {"user_id": "r", provider + "_id": "subject"},
                               "verified_data": {provider + "_id": evidence}}
    methods = repo.as_json_list(repo.rownd_compatibility.map_rownd_user_to_supertokens(profile)["loginMethods"])
    assert methods[0]["thirdPartyUserId"] == "subject"
    if evidence == "   " or evidence == 123:
        with pytest.raises(MigrationError):
            create_rownd_identity_snapshot(profile, "public")


def test_mexico_core_normalization_does_not_expand_rownd_proof():
    profile: dict[str, Any] = {"data": {"user_id": "r", "phone_number": "+5215512345678"},
               "verified_data": {"phone_number": "+525512345678"}}
    with pytest.raises(MigrationError):
        create_rownd_identity_snapshot(profile, "public")
    profile["verified_data"]["phone_number"] = "+5215512345678"
    source = repo.FreshMigrationSource(profile, create_rownd_identity_snapshot(profile, "public"))
    methods = repo.as_json_list(repo._build_online_migration_import(source)["loginMethods"])
    assert methods[0]["phoneNumber"] == "+525512345678"


def test_private_jwt_email_authority_is_not_an_admin_contact_flag():
    profile = {"data": {"user_id": "r", "email": "current@example.com"}, "verified_data": {}}
    source = repo.FreshMigrationSource(profile, create_rownd_identity_snapshot(profile, "public"))
    assert authenticated_source_email(source) is None
    assert not source.snapshot.expected_identities[0].verified
    bound = _bind_authenticated_source(source)
    assert authenticated_source_email(bound) == "current@example.com"
    assert_source_authority(bound)
    cast(dict, bound.rownd_user["data"])["email"] = "other@example.com"
    with pytest.raises(MigrationError):
        assert_source_authority(bound)


def migrate(client):
    return client.post("/auth/plugin/rownd/migrate", headers={"Authorization": "Bearer token", "st-auth-mode": "header"})


async def test_mexico_phone_migration_converges_on_core_canonical_number(core_url, rownd_client):
    client = make_client(core_url, rownd_client)
    rownd_client.user_id = "mexico-" + str(uuid.uuid4())
    phone = "+52155%08d" % (uuid.uuid4().int % 100000000)
    rownd_client.user_info = {"data": {"user_id": rownd_client.user_id, "phone_number": phone},
                              "verified_data": {"phone_number": phone}}
    response = migrate(client)
    assert response.status_code == 200, response.json()
    user = await get_user(rownd_client.user_id)
    assert len(user.login_methods) == 1
    assert user.login_methods[0].phone_number == "+52" + phone[4:]
    assert migrate(client).status_code == 200
    repeated = await get_user(rownd_client.user_id)
    assert [method.recipe_user_id for method in repeated.login_methods] == [method.recipe_user_id for method in user.login_methods]


@pytest.mark.parametrize("interruption", [None, "creation_checkpoint", "link", "remove", "delete", "revoke"])
async def test_online_provider_replacement_preserves_anchor_and_recovers_committed_mutations(
    core_url, rownd_client, monkeypatch, interruption,
):
    client = make_client(core_url, rownd_client)
    rownd_client.user_id = "provider-" + str(uuid.uuid4())
    old = "old-" + rownd_client.user_id
    new = "new-" + rownd_client.user_id
    rownd_client.user_info = {"data": {"user_id": rownd_client.user_id, "google_id": old},
                              "verified_data": {"google_id": True}}
    response = migrate(client)
    assert response.status_code == 200, response.json()
    mapping = await get_user_id_mapping(rownd_client.user_id, "EXTERNAL")
    assert isinstance(mapping, GetUserIdMappingOkResult)
    before = await get_user(mapping.supertokens_user_id)
    old_method = before.login_methods[0]
    old_recipe = old_method.recipe_user_id
    old_session = await sessions.create_new_session_without_request_response("public", old_recipe, {}, {}, True)
    native_revoke = repo.session_asyncio.revoke_all_sessions_for_user
    native_remove = repo.multitenancy_asyncio.disassociate_user_from_tenant
    native_link = repo.accountlinking_asyncio.link_accounts
    native_confirm = repo.confirm_introduction
    native_delete = repo.delete_user
    failed = False

    async def remove(*args, **kwargs):
        nonlocal failed
        result = await native_remove(*args, **kwargs)
        if interruption == "remove" and not failed:
            failed = True
            raise TimeoutError("response lost after committed disassociation")
        return result

    async def revoke(*args, **kwargs):
        nonlocal failed
        result = await native_revoke(*args, **kwargs)
        if interruption == "revoke" and not failed:
            failed = True
            raise TimeoutError("response lost after committed revocation")
        return result

    async def link(*args, **kwargs):
        nonlocal failed
        result = await native_link(*args, **kwargs)
        if interruption == "link" and not failed:
            failed = True
            raise TimeoutError("response lost after committed link")
        return result

    async def confirm(*args, **kwargs):
        nonlocal failed
        await native_confirm(*args, **kwargs)
        if interruption == "creation_checkpoint" and not failed:
            failed = True
            raise TimeoutError("response lost after durable creation receipt")

    async def delete(*args, **kwargs):
        nonlocal failed
        result = await native_delete(*args, **kwargs)
        if interruption == "delete" and not failed:
            failed = True
            raise TimeoutError("response lost after recipe-only deletion")
        return result

    monkeypatch.setattr(repo.multitenancy_asyncio, "disassociate_user_from_tenant", remove)
    monkeypatch.setattr(repo.session_asyncio, "revoke_all_sessions_for_user", revoke)
    monkeypatch.setattr(repo.accountlinking_asyncio, "link_accounts", link)
    monkeypatch.setattr(repo, "confirm_introduction", confirm)
    monkeypatch.setattr(repo, "delete_user", delete)
    rownd_client.user_info["verified_data"]["google_id"] = new
    response = migrate(client)
    if response.status_code != 200:
        response = migrate(client)
    assert response.status_code == 200, response.json()
    after = await get_user(mapping.supertokens_user_id)
    assert after is not None and after.is_primary_user
    assert await get_user_id_mapping(rownd_client.user_id, "EXTERNAL") is not None
    assert any(subject(method) == new and "public" in method.tenant_ids for method in after.login_methods)
    assert not any(subject(method) == old and "public" in method.tenant_ids for method in after.login_methods)
    assert not any(method.recipe_user_id == old_recipe for method in after.login_methods)
    after_mapping = await get_user_id_mapping(rownd_client.user_id, "EXTERNAL")
    assert isinstance(after_mapping, GetUserIdMappingOkResult)
    assert after_mapping.supertokens_user_id == mapping.supertokens_user_id
    assert await sessions.get_session_information(old_session.get_handle()) is None
    metadata = await repo.get_user_metadata(mapping.supertokens_user_id)
    assert cast(dict, cast(dict, metadata["original_rownd_user"])["verified_data"])["google_id"] == new
    current_session = await sessions.get_session_without_request_response(response.headers["st-access-token"])
    assert current_session is not None and current_session.get_access_token_payload()["auth_level"] == "verified"
    for method in after.login_methods:
        assert "rownd_migration_provider_introduction" not in await repo.get_raw_user_metadata(method.recipe_user_id.get_as_string())
    if interruption:
        assert failed


async def test_online_current_email_uses_jwt_authority_and_retires_snapshot_email(core_url, rownd_client):
    client = make_client(core_url, rownd_client)
    rownd_client.user_id = "email-" + str(uuid.uuid4())
    profile = {"data": {"user_id": rownd_client.user_id, "google_id": "google-" + rownd_client.user_id,
                        "email": rownd_client.user_id + "@old.example"},
               "verified_data": {"google_id": True}}
    rownd_client.user_info = deepcopy(profile)
    assert migrate(client).status_code == 200
    rownd_client.user_info["data"]["email"] = rownd_client.user_id + "@new.example"
    response = migrate(client)
    assert response.status_code == 200, response.json()
    user = await get_user(rownd_client.user_id)
    assert any(method.email == rownd_client.user_info["data"]["email"] and method.verified for method in user.login_methods)
    assert not any(method.email == profile["data"]["email"] for method in user.login_methods)


@pytest.mark.parametrize("legacy", [False, True])
async def test_email_revocation_debt_survives_source_drift(core_url, rownd_client, monkeypatch, legacy):
    import hashlib
    client = make_client(core_url, rownd_client)
    rownd_client.user_id = "email-debt-" + str(uuid.uuid4())
    old = rownd_client.user_id + "@old.example"
    rownd_client.user_info = {"data": {"user_id": rownd_client.user_id, "google_id": rownd_client.user_id, "email": old},
                              "verified_data": {"google_id": True}}
    assert migrate(client).status_code == 200
    mapping = await get_user_id_mapping(rownd_client.user_id, "EXTERNAL")
    assert isinstance(mapping, GetUserIdMappingOkResult)
    ledger = "rownd-email-retirement-" + hashlib.sha256((mapping.supertokens_user_id + "\0public").encode()).hexdigest()
    native_remove = tenants.disassociate_user_from_tenant
    issued = []

    async def remove(tenant, recipe, *args, **kwargs):
        result = await native_remove(tenant, recipe, *args, **kwargs)
        if not issued:
            if legacy:
                stored = await repo.get_raw_user_metadata(ledger)
                plan = cast(dict, stored["plan"])
                await metadata_api.update_user_metadata(ledger, {"plan": {key: value for key, value in plan.items() if key != "replacement"}})
            # Model issuance already past its membership check when removal commits.
            from supertokens_rownd import provider_session
            with monkeypatch.context() as inflight:
                inflight.setattr(provider_session, "assert_provider_session_membership", AsyncMock())
                issued.append(await sessions.create_new_session_without_request_response(tenant, recipe, {}, {}, True))
            await repo.passwordless_asyncio.create_code(tenant, email=old)
            await repo.passwordless_asyncio.create_code(tenant, email=rownd_client.user_id + "@new.example")
            rownd_client.user_info["data"]["email"] = rownd_client.user_id + "@third.example"
            raise TimeoutError("committed email removal followed by source drift")
        return result

    monkeypatch.setattr(tenants, "disassociate_user_from_tenant", remove)
    rownd_client.user_info["data"]["email"] = rownd_client.user_id + "@new.example"
    response = migrate(client)
    for _ in range(3):
        if response.status_code == 200:
            break
        response = migrate(client)
    assert response.status_code == 200, response.json()
    assert issued
    assert await sessions.get_session_information(issued[0].get_handle()) is None
    user = await get_user(rownd_client.user_id)
    assert {method.email for method in user.login_methods if method.recipe_id == "passwordless"} == {
        rownd_client.user_id + "@third.example"
    }
    assert await repo.passwordless_asyncio.list_codes_by_email("public", old) == []
    assert await repo.passwordless_asyncio.list_codes_by_email("public", rownd_client.user_id + "@new.example") == []
    completed = cast(dict, (await repo.get_raw_user_metadata(ledger))["plan"])
    assert completed["state"] == "complete"
    assert completed["email"] == rownd_client.user_id + "@third.example"
    assert completed["history"][0]["previous"] == old
    assert completed["history"][0]["email"] == rownd_client.user_id + "@new.example"


@pytest.mark.parametrize("operation", ["import", "membership"])
async def test_provider_introduction_source_drift_recovers_exact_scope(core_url, rownd_client, monkeypatch, operation):
    client = make_client(core_url, rownd_client)
    rownd_client.user_id = "drift-" + str(uuid.uuid4())
    old, intermediate, current = [prefix + rownd_client.user_id for prefix in ("a", "b", "c")]
    rownd_client.user_info = {"data": {"user_id": rownd_client.user_id, "google_id": old}, "verified_data": {"google_id": True}}
    assert migrate(client).status_code == 200
    mapping = await get_user_id_mapping(rownd_client.user_id, "EXTERNAL")
    assert isinstance(mapping, GetUserIdMappingOkResult)
    other = "other-" + str(uuid.uuid4())
    donor = None
    if operation == "membership":
        await tenants.create_or_update_tenant(other, None)
        donor = await providers.manually_create_or_update_user(other, "google", intermediate, intermediate + "@example.com", True)
        assert isinstance(donor, ManuallyCreateOrUpdateUserOkResult)
        await linking.link_accounts(donor.recipe_user_id, mapping.supertokens_user_id)
    native = repo.import_user if operation == "import" else tenants.associate_user_to_tenant
    interrupted = False

    async def interrupt(*args, **kwargs):
        nonlocal interrupted
        result = await native(*args, **kwargs)
        if not interrupted:
            interrupted = True
            rownd_client.user_info["verified_data"]["google_id"] = current
            raise TimeoutError("committed introduction before source change")
        return result

    monkeypatch.setattr(repo if operation == "import" else tenants,
                        "import_user" if operation == "import" else "associate_user_to_tenant", interrupt)
    rownd_client.user_info["verified_data"]["google_id"] = intermediate
    response = migrate(client)
    if response.status_code != 200:
        response = migrate(client)
    assert interrupted
    assert response.status_code == 200, response.json()
    user = await get_user(rownd_client.user_id)
    assert not any(subject(method) == intermediate and "public" in method.tenant_ids for method in user.login_methods)
    if donor is not None:
        restored = next(method for method in user.login_methods if method.recipe_user_id == donor.recipe_user_id)
        assert restored.tenant_ids == [other]


@pytest.mark.parametrize("change", [None, "stable_email", "missing", "canonical", "provider", "email", "tenant", "checkpoint", "email_debt", "provider_debt"])
async def test_completed_discovery_avoids_searches_only_for_stable_state(core_url, rownd_client, monkeypatch, change):
    client = make_client(core_url, rownd_client)
    rownd_client.user_id = "discovery-" + str(uuid.uuid4())
    rownd_client.user_info = {"data": {"user_id": rownd_client.user_id, "google_id": rownd_client.user_id},
                              "verified_data": {"google_id": True}}
    if change in {"stable_email", "missing", "canonical"}:
        rownd_client.user_info["data"]["email"] = rownd_client.user_id + "@example.com"
    assert migrate(client).status_code == 200
    if change == "missing":
        user = await get_user(rownd_client.user_id)
        method = next(method for method in user.login_methods if method.third_party)
        await repo.delete_user(method.recipe_user_id.get_as_string(), remove_all_linked_accounts=False)
    if change == "canonical":
        mapping = await get_user_id_mapping(rownd_client.user_id, "EXTERNAL")
        assert isinstance(mapping, GetUserIdMappingOkResult)
        await metadata_api.update_user_metadata(mapping.supertokens_user_id, {"rownd_email_recipe_user_ids": {"public": "unknown"}})
    if change in {"provider", "email"}:
        rownd_client.user_info["data"]["apple_id" if change == "provider" else "email"] = (
            "apple-" + rownd_client.user_id if change == "provider" else rownd_client.user_id + "@example.com")
    tenant = "public"
    if change == "tenant":
        tenant = "new-" + str(uuid.uuid4())
        await tenants.create_or_update_tenant(tenant, None)
    if change == "checkpoint":
        await metadata_api.update_user_metadata(rownd_client.user_id, {"rownd_migration_owner_recovery": {"pending": True}})
    if change in {"email_debt", "provider_debt"}:
        import hashlib
        from supertokens_rownd.provider_migration import _ledger_id
        mapping = await get_user_id_mapping(rownd_client.user_id, "EXTERNAL")
        assert isinstance(mapping, GetUserIdMappingOkResult)
        ledger = (_ledger_id(mapping.supertokens_user_id, tenant) if change == "provider_debt" else
                  "rownd-email-retirement-" + hashlib.sha256((mapping.supertokens_user_id + "\0" + tenant).encode()).hexdigest())
        await metadata_api.update_user_metadata(ledger, {"plan": {
            "state": "removing", "target": mapping.supertokens_user_id,
            "rownd_id": rownd_client.user_id, "tenant": tenant,
            "kind": "introduction", "provider": "google", "subject": rownd_client.user_id,
            "recipe": None,
        }})
    searches = AsyncMock(wraps=repo.list_users_by_account_info)
    monkeypatch.setattr(repo, "list_users_by_account_info", searches)
    source = create_rownd_identity_snapshot(rownd_client.user_info, tenant)
    optimized = await repo.read_fresh_migration_snapshot(source, {})
    stable = change in {None, "stable_email"}
    assert (searches.await_count == 0) is (change is None)
    if stable:
        response = migrate(client)
        assert response.status_code == 200, response.json()
        assert (searches.await_count == 0) is (change is None)
    from supertokens_rownd import migration_discovery
    monkeypatch.setattr(migration_discovery, "completed_identity_user", AsyncMock(return_value=None))
    full = await repo.read_fresh_migration_snapshot(source, {})
    from supertokens_rownd.migration import classify_migration_snapshot
    assert classify_migration_snapshot(optimized) == classify_migration_snapshot(full)
    if stable:
        forced = migrate(client)
        assert forced.status_code == 200, forced.json()
        assert searches.await_count > 0
        fast_session = await sessions.get_session_without_request_response(response.headers["st-access-token"])
        full_session = await sessions.get_session_without_request_response(forced.headers["st-access-token"])
        assert fast_session is not None and full_session is not None
        assert fast_session.get_recipe_user_id() == full_session.get_recipe_user_id()
        assert fast_session.get_user_id() == full_session.get_user_id()
        assert fast_session.get_access_token_payload()["auth_level"] == full_session.get_access_token_payload()["auth_level"]


@pytest.mark.parametrize("reservation", ["emailpassword", "thirdparty"])
async def test_completed_email_reservations_match_full_discovery(core_url, rownd_client, monkeypatch, reservation):
    from supertokens_rownd import migration_discovery
    from supertokens_python.recipe.emailpassword import asyncio as emailpassword
    client = make_client(core_url, rownd_client, enable_email_password=True)
    rownd_client.user_id = "reservation-" + str(uuid.uuid4())
    email = rownd_client.user_id + "@example.com"
    rownd_client.user_info = {"data": {"user_id": rownd_client.user_id, "email": email}, "verified_data": {}}
    assert migrate(client).status_code == 200
    if reservation == "emailpassword":
        foreign = await emailpassword.sign_up("public", email, "Password123!")
    else:
        foreign = await providers.manually_create_or_update_user("public", "google", rownd_client.user_id, email, False)
    assert getattr(foreign, "user").id != (await get_user(rownd_client.user_id)).id
    optimized = migrate(client)
    monkeypatch.setattr(migration_discovery, "completed_identity_user", AsyncMock(return_value=None))
    full = migrate(client)
    assert optimized.status_code == full.status_code == 422
    assert optimized.json()["reason"] == full.json()["reason"] == "IDENTITY_OWNED_BY_ANOTHER_USER"
    assert "st-access-token" not in optimized.headers and "st-access-token" not in full.headers


async def test_native_session_guard_is_recipe_and_tenant_scoped(core_url, rownd_client):
    from supertokens_rownd.provider_migration import _ledger_id
    client = make_client(core_url, rownd_client)
    rownd_client.user_id = "session-guard-" + str(uuid.uuid4())
    rownd_client.user_info = {"data": {"user_id": rownd_client.user_id, "google_id": rownd_client.user_id},
                              "verified_data": {"google_id": True}}
    assert migrate(client).status_code == 200
    mapping = await get_user_id_mapping(rownd_client.user_id, "EXTERNAL")
    assert isinstance(mapping, GetUserIdMappingOkResult)
    user = await get_user(rownd_client.user_id)
    recipe = user.login_methods[0].recipe_user_id
    other = "safe-" + str(uuid.uuid4())
    await tenants.create_or_update_tenant(other, None)
    await tenants.associate_user_to_tenant(other, recipe)
    existing = await sessions.create_new_session_without_request_response("public", recipe, {}, {}, True)
    refresh_token = existing.get_all_session_tokens_dangerously()["refreshToken"]
    assert refresh_token is not None
    ledger = _ledger_id(mapping.supertokens_user_id, "public")
    await metadata_api.update_user_metadata(ledger, {"test": {
        "target": mapping.supertokens_user_id, "tenant": "public", "recipe": recipe.get_as_string(),
        "kind": "introduction", "state": "prepared",
    }})
    with pytest.raises(MigrationError):
        await sessions.create_new_session_without_request_response("public", recipe, {}, {}, True)
    with pytest.raises(MigrationError):
        await sessions.refresh_session_without_request_response(refresh_token, True)
    assert await sessions.get_session_information(existing.get_handle()) is None
    safe = await sessions.create_new_session_without_request_response(other, recipe, {}, {}, True)
    assert safe is not None
    await metadata_api.update_user_metadata(ledger, {"test": None})
    await tenants.disassociate_user_from_tenant("public", recipe)
    with pytest.raises(MigrationError):
        await sessions.create_new_session_without_request_response("public", recipe, {}, {}, True)
    assert await sessions.create_new_session_without_request_response(other, recipe, {}, {}, True)


async def test_obsolete_provider_retirement_is_tenant_scoped(core_url, rownd_client):
    client = make_client(core_url, rownd_client)
    rownd_client.user_id = "scoped-" + str(uuid.uuid4())
    old, new = "old-" + rownd_client.user_id, "new-" + rownd_client.user_id
    rownd_client.user_info = {"data": {"user_id": rownd_client.user_id, "apple_id": old},
                              "verified_data": {"apple_id": True}}
    assert migrate(client).status_code == 200
    user = await get_user(rownd_client.user_id)
    other_tenant = "other-" + str(uuid.uuid4())
    await tenants.create_or_update_tenant(other_tenant, None)
    await tenants.associate_user_to_tenant(other_tenant, user.login_methods[0].recipe_user_id)
    rownd_client.user_info["verified_data"]["apple_id"] = new
    response = migrate(client)
    assert response.status_code == 200, response.json()
    user = await get_user(rownd_client.user_id)
    old_method = next(method for method in user.login_methods if subject(method) == old)
    assert old_method.tenant_ids == [other_tenant]
    assert migrate(client).status_code == 200
    user = await get_user(rownd_client.user_id)
    assert next(method for method in user.login_methods if subject(method) == old).tenant_ids == [other_tenant]


async def test_replacement_owned_by_foreign_primary_never_retires_old_provider(core_url, rownd_client):
    client = make_client(core_url, rownd_client)
    rownd_client.user_id = "conflict-" + str(uuid.uuid4())
    old, new = "old-" + rownd_client.user_id, "new-" + rownd_client.user_id
    rownd_client.user_info = {"data": {"user_id": rownd_client.user_id, "google_id": old},
                              "verified_data": {"google_id": True}}
    assert migrate(client).status_code == 200
    foreign = await providers.manually_create_or_update_user("public", "google", new, "native-" + rownd_client.user_id + "@example.com", True)
    assert isinstance(foreign, ManuallyCreateOrUpdateUserOkResult)
    await linking.create_primary_user(foreign.recipe_user_id)
    rownd_client.user_info["verified_data"]["google_id"] = new
    response = migrate(client)
    assert response.status_code == 422, response.json()
    user = await get_user(rownd_client.user_id)
    assert len(user.login_methods) == 1
    assert subject(user.login_methods[0]) == old
    assert "public" in user.login_methods[0].tenant_ids


async def test_native_pending_email_blocks_migration_replacement(core_url, rownd_client):
    client = make_client(core_url, rownd_client)
    rownd_client.user_id = "pending-" + str(uuid.uuid4())
    old_email = rownd_client.user_id + "@old.example"
    rownd_client.user_info = {"data": {"user_id": rownd_client.user_id, "email": old_email,
                                      "google_id": "google-" + rownd_client.user_id},
                              "verified_data": {"google_id": True}}
    assert migrate(client).status_code == 200
    mapping = await get_user_id_mapping(rownd_client.user_id, "EXTERNAL")
    assert isinstance(mapping, GetUserIdMappingOkResult)
    await metadata_api.update_user_metadata(mapping.supertokens_user_id, {"rownd_pending_verification": [
        {"id": "native", "field": "email", "value": "native@example.com", "tenantId": "public"},
    ]})
    rownd_client.user_info["data"]["email"] = "changed-" + old_email
    response = migrate(client)
    assert response.status_code == 422, response.json()
    user = await get_user(rownd_client.user_id)
    assert any(method.email == old_email and "public" in method.tenant_ids for method in user.login_methods)
    assert not any(method.email == "changed-" + old_email for method in user.login_methods)


async def test_source_change_after_link_restores_native_donor(core_url, rownd_client, monkeypatch):
    client = make_client(core_url, rownd_client)
    rownd_client.user_id = "rollback-" + str(uuid.uuid4())
    old, native, current = [prefix + rownd_client.user_id for prefix in ("old-", "native-", "current-")]
    rownd_client.user_info = {"data": {"user_id": rownd_client.user_id, "google_id": old},
                              "verified_data": {"google_id": True}}
    assert migrate(client).status_code == 200
    donor = await providers.manually_create_or_update_user("public", "google", native, native + "@example.com", True)
    assert isinstance(donor, ManuallyCreateOrUpdateUserOkResult)
    native_link = repo.accountlinking_asyncio.link_accounts
    interrupted = False

    async def link(*args, **kwargs):
        nonlocal interrupted
        result = await native_link(*args, **kwargs)
        if not interrupted:
            interrupted = True
            rownd_client.user_info["verified_data"]["google_id"] = current
            raise TimeoutError("committed native donor link lost its response")
        return result

    monkeypatch.setattr(repo.accountlinking_asyncio, "link_accounts", link)
    rownd_client.user_info["verified_data"]["google_id"] = native
    response = migrate(client)
    if response.status_code != 200:
        response = migrate(client)
    assert response.status_code == 200, response.json()
    restored = await get_user(donor.recipe_user_id.get_as_string())
    assert restored.id == donor.user.id
    assert len(restored.login_methods) == 1
    assert restored.login_methods[0].email == native + "@example.com"
    assert restored.login_methods[0].tenant_ids == ["public"]
    assert await sessions.create_new_session_without_request_response("public", donor.recipe_user_id, {}, {}, True)
    target = await get_user(rownd_client.user_id)
    assert not any(subject(method) == native for method in target.login_methods)
    assert any(subject(method) == current and "public" in method.tenant_ids for method in target.login_methods)


@pytest.mark.parametrize("conflict", [False, True])
async def test_target_tenant_membership_is_repaired_only_without_foreign_email_owner(core_url, rownd_client, conflict):
    client = make_client(core_url, rownd_client)
    rownd_client.user_id = "membership-" + str(uuid.uuid4())
    email = rownd_client.user_id + "@example.com"
    rownd_client.user_info = {"data": {"user_id": rownd_client.user_id, "email": email,
                                      "google_id": "google-" + rownd_client.user_id},
                              "verified_data": {"google_id": True}}
    assert migrate(client).status_code == 200
    tenant = "new-" + str(uuid.uuid4())
    await tenants.create_or_update_tenant(tenant, None)
    if conflict:
        await repo.passwordless_asyncio.signinup(tenant, email=email, phone_number=None)
    response = client.post("/auth/plugin/rownd/migrate?tenantId=" + tenant,
                           headers={"Authorization": "Bearer token", "st-auth-mode": "header"})
    assert response.status_code == (422 if conflict else 200), response.json()
    target = await get_user(rownd_client.user_id)
    assert all((tenant in method.tenant_ids) is (not conflict) for method in target.login_methods)
    assert all("public" in method.tenant_ids for method in target.login_methods)


@pytest.mark.parametrize("remove_alias", [False, True])
async def test_superseded_raw_alias_rejects_jwt_replay_before_reconciliation(core_url, rownd_client, monkeypatch, remove_alias):
    client = make_client(core_url, rownd_client)
    rownd_client.user_id = "superseded-" + str(uuid.uuid4())
    rownd_client.user_info = {"data": {"user_id": rownd_client.user_id, "google_id": "google-" + rownd_client.user_id},
                              "verified_data": {"google_id": True}}
    assert migrate(client).status_code == 200
    mapping = await get_user_id_mapping(rownd_client.user_id, "EXTERNAL")
    assert isinstance(mapping, GetUserIdMappingOkResult)
    await metadata_api.update_user_metadata(rownd_client.user_id, {
        "rownd_migration_superseded": {"targetUserId": mapping.supertokens_user_id, "rowndUserId": "elected-winner"},
        "rownd_migration_owner_recovery": {"version": 1, "sourceId": rownd_client.user_id, "target": mapping.supertokens_user_id, "planId": "retired"},
    })
    if remove_alias:
        # This models administrative retirement; the JWT path retains force=False.
        await delete_user_id_mapping(rownd_client.user_id, "EXTERNAL", force=True)
    importer = AsyncMock(wraps=repo.import_user)
    monkeypatch.setattr(repo, "import_user", importer)
    response = migrate(client)
    assert response.status_code == 422, response.json()
    assert response.json()["reason"] == "IDENTITY_OWNED_BY_ANOTHER_USER"
    assert "st-access-token" not in response.headers
    importer.assert_not_awaited()

from __future__ import annotations

import hashlib
import asyncio
from copy import deepcopy
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from supertokens_python.asyncio import get_user_id_mapping
from supertokens_python.interfaces import GetUserIdMappingOkResult
from supertokens_python.recipe.usermetadata import asyncio as metadata

from conftest import MockRowndClient, auth_headers, make_client
from supertokens_rownd import migration_plan
from supertokens_rownd import supertokens_repository as repo
from supertokens_rownd.provider_migration import _ledger_id


def migrated(core_url, kind="provider"):
    rownd = MockRowndClient()
    rownd.user_id = "noop-" + uuid4().hex
    rownd.user_info = {"data": {"user_id": rownd.user_id, **(
        {"google_id": rownd.user_id, "email": rownd.user_id + "@example.com"} if kind == "mixed"
        else {"google_id": rownd.user_id} if kind == "provider"
        else {"email": rownd.user_id + "@example.com"}
    )}}
    client = make_client(core_url, rownd, enable_email_verification=True)
    assert client.post("/auth/plugin/rownd/migrate", headers=auth_headers("synthetic")).status_code == 200
    return client, rownd


@pytest.mark.parametrize("kind", ["email", "provider"])
async def test_unchanged_migration_skips_repair(core_url, monkeypatch, kind):
    client, _ = migrated(core_url, kind)
    repair = AsyncMock(side_effect=AssertionError("unexpected repair"))
    monkeypatch.setattr(repo, "repair_provider_lifecycle", repair)
    monkeypatch.setattr(repo, "apply_migration_repairs", repair)
    for path in ("/auth/plugin/rownd/migrate", "/auth/plugin/migrate-session"):
        response = client.post(path, headers=auth_headers("synthetic"))
        assert response.status_code == 200, response.text
    repair.assert_not_awaited()


@pytest.mark.parametrize("kind", ["email", "provider"])
async def test_native_sessions_and_refresh_do_not_require_rownd(core_url, monkeypatch, kind):
    _, rownd = migrated(core_url, kind)
    fetch = AsyncMock(side_effect=RuntimeError("Rownd unavailable"))
    monkeypatch.setattr(rownd, "fetch_optional_user_info", fetch)
    user = await repo.get_user(rownd.user_id)
    assert user is not None
    session = await repo.session_asyncio.create_new_session_without_request_response(
        "public", user.login_methods[0].recipe_user_id,
    )
    token = session.get_all_session_tokens_dangerously()["refreshToken"]
    assert token is not None
    refreshed = await repo.session_asyncio.refresh_session_without_request_response(token, disable_anti_csrf=True)
    assert refreshed.get_user_id() == rownd.user_id
    fetch.assert_not_awaited()


@pytest.mark.parametrize("kind", ["email", "provider"])
@pytest.mark.parametrize("path", ["/auth/plugin/rownd/migrate", "/auth/plugin/migrate-session"])
async def test_handoff_uses_one_profile_fetch_despite_rownd_outage(core_url, monkeypatch, kind, path):
    client, rownd = migrated(core_url, kind)
    fetch = rownd.fetch_optional_user_info
    calls = []

    async def once(user_id):
        calls.append(user_id)
        if len(calls) > 1:
            raise RuntimeError("Rownd unavailable after authentication")
        return await fetch(user_id)

    monkeypatch.setattr(rownd, "fetch_optional_user_info", once)
    response = client.post(path, headers=auth_headers("synthetic"))
    assert response.status_code == 200, response.text
    assert calls == [rownd.user_id]


@pytest.mark.parametrize("when", ["claims", "session"])
@pytest.mark.parametrize("change", ["removed", "tenant", "retired", "email_retired", "mapping", "publication", "verification"])
async def test_selected_authentication_changes_prevent_publication(core_url, monkeypatch, when, change):
    kind = "email" if change in {"verification", "email_retired"} else "provider"
    client, rownd = migrated(core_url, kind)
    mapping = await get_user_id_mapping(rownd.user_id, "EXTERNAL")
    assert isinstance(mapping, GetUserIdMappingOkResult)
    user = await repo.get_user(rownd.user_id)
    assert user is not None
    recipe = user.login_methods[0].recipe_user_id
    target = mapping.supertokens_user_id
    original = repo.build_rownd_session_claims if when == "claims" else repo.session_asyncio.create_new_session
    sessions = []
    changed = False
    get_mapping = repo.get_user_id_mapping

    async def maps(identifier, role=None, context=None):
        if changed and change == "mapping" and (identifier, role) == (rownd.user_id, "EXTERNAL"):
            return GetUserIdMappingOkResult("another-owner", rownd.user_id)
        return await get_mapping(identifier, role, context)

    async def hook(*args, **kwargs):
        nonlocal changed
        result = await original(*args, **kwargs)
        if when == "session":
            sessions.append(result)
        if change == "removed":
            await repo.delete_user(recipe.get_as_string(), remove_all_linked_accounts=False)
        elif change == "tenant":
            await repo.multitenancy_asyncio.disassociate_user_from_tenant("public", recipe)
        elif change == "retired":
            await metadata.update_user_metadata(_ledger_id(target, "public"), {"retirement": {
                "target": target, "tenant": "public", "recipe": recipe.get_as_string(),
                "internal_recipe": recipe.get_as_string(), "state": "removing",
            }})
        elif change == "email_retired":
            ledger = "rownd-email-retirement-" + hashlib.sha256((target + "\0public").encode()).hexdigest()
            await metadata.update_user_metadata(ledger, {"plan": {
                "state": "removing", "methods": [{"recipe": recipe.get_as_string()}],
            }})
        elif change == "publication":
            await metadata.update_user_metadata(target, {"rownd_migration_mapping_publication": {"version": 1}})
        elif change == "verification":
            await repo.emailverification_asyncio.unverify_email(recipe, user.login_methods[0].email)
        changed = True
        return result

    monkeypatch.setattr(repo, "get_user_id_mapping", maps)
    monkeypatch.setattr(repo if when == "claims" else repo.session_asyncio,
                        "build_rownd_session_claims" if when == "claims" else "create_new_session", hook)
    response = client.post("/auth/plugin/rownd/migrate", headers=auth_headers("synthetic"))
    assert response.status_code == 503, response.text
    assert not response.headers.get("st-access-token")
    assert len(sessions) == (1 if when == "session" else 0)
    for session in sessions:
        assert await repo.session_asyncio.get_session_information(session.get_handle()) is None


@pytest.mark.parametrize("change", [
    "provider", "email", "profile", "marker", "malformed_marker", "provider_debt",
    "email_debt", "completion", "canonical",
])
async def test_changed_or_indebted_migration_does_not_take_noop(core_url, monkeypatch, change):
    client, rownd = migrated(core_url)
    mapping = await get_user_id_mapping(rownd.user_id, "EXTERNAL")
    assert isinstance(mapping, GetUserIdMappingOkResult)
    assert rownd.user_info is not None
    target = mapping.supertokens_user_id
    if change in {"provider", "email", "profile"}:
        rownd.user_info["data"][{"provider": "google_id", "email": "email", "profile": "first_name"}[change]] = (
            "changed@example.com" if change == "email" else "changed"
        )
    elif change == "provider_debt":
        await metadata.update_user_metadata(_ledger_id(target, "public"), {"pending": {
            "target": target, "rownd_id": rownd.user_id, "tenant": "public",
            "kind": "introduction", "provider": "apple", "subject": "absent-provider", "state": "prepared",
        }})
    elif change == "email_debt":
        ledger = "rownd-email-retirement-" + hashlib.sha256((target + "\0public").encode()).hexdigest()
        await metadata.update_user_metadata(ledger, {"plan": {"state": "removing"}})
    else:
        patch = {
            "marker": {"rownd_migration_owner_recovery": {"pending": True}},
            "malformed_marker": {"rownd_python_unknown": "invalid"},
            "completion": {"rownd_migration_complete": "true"},
            "canonical": {"rownd_email_recipe_user_ids": {"public": "foreign-method"}},
        }[change]
        await metadata.update_user_metadata(target, patch)
    noop = AsyncMock(side_effect=AssertionError("unsafe NOOP"))
    monkeypatch.setattr(migration_plan, "create_completed_session", noop)
    response = client.post("/auth/plugin/rownd/migrate", headers=auth_headers("synthetic"))
    if change in {"email_debt", "completion", "canonical"}:
        assert response.status_code == 422, response.text
        assert response.json()["reason"] == "MIGRATION_STATE_INVALID"
    else:
        assert response.status_code in {200, 409, 503}, response.text
    noop.assert_not_awaited()


@pytest.mark.parametrize("when", ["before", "after"])
async def test_source_changes_after_handoff_do_not_reauthenticate(core_url, monkeypatch, when):
    client, rownd = migrated(core_url)
    original_create = repo.session_asyncio.create_new_session
    original_claims = repo.build_rownd_session_claims
    sessions = []

    async def create(*args, **kwargs):
        session = await original_create(*args, **kwargs)
        sessions.append(session)
        if when == "after":
            assert rownd.user_info is not None
            rownd.user_info = deepcopy(rownd.user_info)
            rownd.user_info["data"]["google_id"] = "replacement"
        return session

    async def claims(*args, **kwargs):
        result = await original_claims(*args, **kwargs)
        if when == "before":
            assert rownd.user_info is not None
            rownd.user_info = deepcopy(rownd.user_info)
            rownd.user_info["data"]["google_id"] = "replacement"
        return result

    monkeypatch.setattr(repo.session_asyncio, "create_new_session", create)
    monkeypatch.setattr(repo, "build_rownd_session_claims", claims)
    response = client.post("/auth/plugin/rownd/migrate", headers=auth_headers("synthetic"))
    assert response.status_code == 200, response.text
    assert len(sessions) == 1
    assert await repo.session_asyncio.get_session_information(sessions[0].get_handle()) is not None


@pytest.mark.parametrize("debt", ["provider", "metadata", "completion", "tombstone"])
@pytest.mark.parametrize("when", ["claims", "session"])
async def test_handoff_defers_migration_debt_but_rejects_tombstones(core_url, monkeypatch, debt, when):
    client, rownd = migrated(core_url)
    mapping = await get_user_id_mapping(rownd.user_id, "EXTERNAL")
    assert isinstance(mapping, GetUserIdMappingOkResult)
    target = mapping.supertokens_user_id
    original = repo.build_rownd_session_claims if when == "claims" else repo.session_asyncio.create_new_session
    sessions = []

    async def claims(*args, **kwargs):
        result = await original(*args, **kwargs)
        if when == "session":
            sessions.append(result)
        if debt == "provider":
            await metadata.update_user_metadata(_ledger_id(target, "public"), {"pending": {
                "target": target, "rownd_id": rownd.user_id, "tenant": "public",
                "kind": "introduction", "provider": "apple", "subject": "absent-provider",
                "state": "prepared",
            }})
        elif debt == "metadata":
            await metadata.update_user_metadata(target, {"rownd_email_recipe_user_ids": {"public": "missing"}})
        elif debt == "completion":
            await metadata.update_user_metadata(target, {"rownd_migration_complete": False})
        else:
            await metadata.update_user_metadata(rownd.user_id, {"rownd_migration_superseded": {"target": "elsewhere"}})
        return result

    monkeypatch.setattr(repo if when == "claims" else repo.session_asyncio,
                        "build_rownd_session_claims" if when == "claims" else "create_new_session", claims)
    response = client.post("/auth/plugin/rownd/migrate", headers=auth_headers("synthetic"))
    if debt != "tombstone":
        assert response.status_code == 200, response.text
        noop = AsyncMock(side_effect=AssertionError("debt must be reconsidered next request"))
        monkeypatch.setattr(migration_plan, "create_completed_session", noop)
        client.post("/auth/plugin/rownd/migrate", headers=auth_headers("synthetic"))
        noop.assert_not_awaited()
        return
    assert response.status_code == 422, response.text
    assert response.json()["reason"] == "IDENTITY_OWNED_BY_ANOTHER_USER"
    assert not response.headers.get("st-access-token")
    assert len(sessions) == (1 if when == "session" else 0)
    if sessions:
        assert await repo.session_asyncio.get_session_information(sessions[0].get_handle()) is None


@pytest.mark.parametrize("change", ["nonselected", "contact"])
async def test_handoff_does_not_reinspect_nonselected_identities(core_url, monkeypatch, change):
    from supertokens_python.recipe.thirdparty import asyncio as thirdparty

    client, rownd = migrated(core_url, "mixed")
    original = repo.session_asyncio.create_new_session
    sessions = []

    async def create(*args, **kwargs):
        session = await original(*args, **kwargs)
        sessions.append(session)
        user = await repo.get_user(rownd.user_id)
        assert user is not None
        if change == "nonselected":
            method = next(method for method in user.login_methods if method.recipe_id == "thirdparty")
            assert method.recipe_user_id != session.get_recipe_user_id()
            await repo.multitenancy_asyncio.disassociate_user_from_tenant("public", method.recipe_user_id)
        else:
            assert rownd.user_info is not None
            await thirdparty.manually_create_or_update_user(
                "public", "apple", "foreign-" + rownd.user_id, rownd.user_info["data"]["email"], False,
            )
        return session

    monkeypatch.setattr(repo.session_asyncio, "create_new_session", create)
    response = client.post("/auth/plugin/rownd/migrate", headers=auth_headers("synthetic"))
    assert response.status_code == 200, response.text
    assert len(sessions) == 1
    assert await repo.session_asyncio.get_session_information(sessions[0].get_handle()) is not None


async def test_noop_rechecks_tenant_after_session_hook(core_url, monkeypatch):
    client, _ = migrated(core_url)
    original = repo.session_asyncio.create_new_session
    sessions = []

    async def create(*args, **kwargs):
        session = await original(*args, **kwargs)
        sessions.append(session)
        await repo.multitenancy_asyncio.disassociate_user_from_tenant("public", session.get_recipe_user_id())
        return session

    monkeypatch.setattr(repo.session_asyncio, "create_new_session", create)
    response = client.post("/auth/plugin/rownd/migrate", headers=auth_headers("synthetic"))
    assert response.status_code == 503, response.text
    assert response.json()["reason"] == "MIGRATION_INCOMPLETE"
    assert not response.headers.get("st-access-token")
    assert len(sessions) == 1
    assert await repo.session_asyncio.get_session_information(sessions[0].get_handle()) is None


@pytest.mark.parametrize("cleanup", ["normal", "failure", "repeated_cancel", "timeout"])
async def test_noop_postissuance_cancellation(core_url, monkeypatch, cleanup):
    from starlette.requests import Request
    from starlette.responses import Response
    from supertokens_python.framework.fastapi.fastapi_request import FastApiRequest
    from supertokens_python.framework.fastapi.fastapi_response import FastApiResponse
    from supertokens_rownd.migration import create_rownd_identity_snapshot
    from supertokens_rownd.migration_authority import _bind_authenticated_source
    from supertokens_rownd.types import RowndPluginConfig

    _, rownd = migrated(core_url)
    assert rownd.user_info is not None
    source = _bind_authenticated_source(repo.FreshMigrationSource(
        rownd.user_info, create_rownd_identity_snapshot(rownd.user_info, "public"),
    ))
    config = RowndPluginConfig(rownd_app_key="test-key", rownd_app_secret="test-secret")
    context = {}
    plan = await migration_plan.read_completed_migration(config, source, context)
    assert plan is not None
    request = FastApiRequest(Request({
        "type": "http", "method": "POST", "path": "/auth/plugin/rownd/migrate",
        "headers": [(key.lower().encode(), value.encode()) for key, value in auth_headers("synthetic").items()],
        "scheme": "http", "server": ("testserver", 80), "query_string": b"",
    }))
    raw_response = Response()
    response = FastApiResponse(raw_response)
    original = repo.session_asyncio.create_new_session
    sessions = []
    cancellation = asyncio.CancelledError("original cancellation")
    revoking = asyncio.Event()
    release = asyncio.Event()
    original_revokers = []

    async def create(*args, **kwargs):
        session = await original(*args, **kwargs)
        sessions.append(session)
        for mutator in session.response_mutators:
            mutator(response, context)
        original_revoke = session.revoke_session
        original_revokers.append(original_revoke)

        async def revoke(user_context):
            revoking.set()
            if cleanup in {"repeated_cancel", "timeout"}:
                await release.wait()
            result = await original_revoke(user_context)
            if cleanup == "failure":
                raise RuntimeError("uncertain revocation response")
            return result

        monkeypatch.setattr(session, "revoke_session", revoke)
        return session

    validate_binding = migration_plan._validate_session_binding

    async def validate(*args):
        if sessions:
            raise cancellation
        return await validate_binding(*args)

    monkeypatch.setattr(migration_plan, "_validate_session_binding", validate)
    monkeypatch.setattr(repo.session_asyncio, "create_new_session", create)
    if cleanup == "timeout":
        monkeypatch.setattr(migration_plan, "_CANCELLATION_CLEANUP_TIMEOUT", 0.02)
    propagated = []

    async def invoke():
        try:
            return await migration_plan.create_completed_session(
                config, source, plan, request, response, context,
            )
        except asyncio.CancelledError as error:
            propagated.append(error)
            raise

    task = asyncio.create_task(invoke())
    await asyncio.wait_for(revoking.wait(), 10)
    if cleanup == "repeated_cancel":
        task.cancel("second cancellation")
        await asyncio.sleep(0)
        task.cancel("third cancellation")
        release.set()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 10)
    # Python 3.9 Task.result() may replace the exception; inspect at the call boundary.
    assert propagated == [cancellation]
    assert len(sessions) == 1
    for header in ("st-access-token", "st-refresh-token", "front-token", "anti-csrf"):
        assert header not in raw_response.headers
    assert request.get_session() is None
    if cleanup == "timeout":
        # An unavailable revoker cannot guarantee deletion; release only our test session.
        await original_revokers[0](context)
    assert await repo.session_asyncio.get_session_information(sessions[0].get_handle()) is None

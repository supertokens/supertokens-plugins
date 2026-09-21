from __future__ import annotations

import json
from copy import deepcopy
from dataclasses import FrozenInstanceError
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from supertokens_python.types import RecipeUserId
from supertokens_python.interfaces import GetUserIdMappingOkResult
from supertokens_python.recipe.emailverification import asyncio as verification
from supertokens_python.recipe.usermetadata import asyncio as metadata

from conftest import auth_headers
from test_migration_noop import migrated
from supertokens_rownd import migration_plan, plugin
from supertokens_rownd import supertokens_repository as repo
from supertokens_rownd.migration import create_rownd_identity_snapshot
from supertokens_rownd.errors import MigrationError
from supertokens_rownd.migration_authority import _bind_authenticated_source
from supertokens_rownd.types import RowndPluginConfig


def source_for(rownd):
    return _bind_authenticated_source(repo.FreshMigrationSource(
        rownd.user_info, create_rownd_identity_snapshot(rownd.user_info, "public"),
    ))


async def account_state(rownd_id):
    mapping = await repo.get_user_id_mapping(rownd_id, "EXTERNAL", {})
    assert isinstance(mapping, GetUserIdMappingOkResult)
    user = await repo.get_user(rownd_id, {})
    assert user is not None
    identifiers = {rownd_id, mapping.supertokens_user_id, *(m.recipe_user_id.get_as_string() for m in user.login_methods)}
    return (
        user.to_json(),
        {identifier: await repo.get_raw_user_metadata(identifier, {}) for identifier in identifiers},
        [(m.recipe_user_id.get_as_string(), await verification.is_email_verified(m.recipe_user_id, m.email, {}))
         for m in user.login_methods if m.email],
    )


@pytest.mark.parametrize("kind", ["email", "provider", "mixed"])
async def test_first_ordinary_request_is_read_only_and_skips_full_discovery(core_url, monkeypatch, kind):
    client, rownd = migrated(core_url, kind)
    before = await account_state(rownd.user_id)
    snapshot = AsyncMock(side_effect=AssertionError("full snapshot"))
    monkeypatch.setattr(repo, "read_fresh_migration_snapshot", snapshot)
    for path in ("/auth/plugin/rownd/migrate", "/auth/plugin/migrate-session"):
        response = client.post(path, headers=auth_headers("synthetic"))
        assert response.status_code == 200, response.text
        assert await account_state(rownd.user_id) == before
    snapshot.assert_not_awaited()


async def test_snapshot_is_immutable_and_claim_inputs_are_defensively_owned(core_url):
    _, rownd = migrated(core_url)
    source = source_for(rownd)
    plan = await migration_plan.read_completed_migration(RowndPluginConfig(), source, {})
    assert plan is not None
    state = plan.ordinary
    with pytest.raises(FrozenInstanceError):
        setattr(state, "recipe", "changed")
    user = state.user()
    user.login_methods.clear()
    metadata_copy = json.loads(state.metadata_json)
    metadata_copy["original_rownd_user"]["data"].clear()
    assert state.user().login_methods
    assert migration_plan._validate_ordinary_snapshot(source, state)


async def test_reused_sdk_context_has_fresh_account_and_request_reads(core_url):
    client, rownd = migrated(core_url)
    context = {}
    config = RowndPluginConfig()
    first_source = source_for(rownd)
    first_plan = await migration_plan.read_completed_migration(config, first_source, context)
    assert first_plan is not None
    rownd.user_id = "next-request-" + uuid4().hex
    rownd.user_info = {"data": {"user_id": rownd.user_id, "google_id": rownd.user_id}}
    assert client.post("/auth/plugin/rownd/migrate", headers=auth_headers("synthetic")).status_code == 200
    second_plan = await migration_plan.read_completed_migration(config, source_for(rownd), context)
    assert second_plan is not None
    assert first_plan.target != second_plan.target
    await metadata.update_user_metadata(first_plan.target.user_id, {"rownd_migration_complete": False})
    assert await migration_plan.read_completed_migration(config, first_source, context) is None
    assert migration_plan._EVIDENCE_KEY not in context


@pytest.mark.parametrize("fake", [False, True])
async def test_standalone_native_guards_ignore_expired_or_caller_evidence(core_url, monkeypatch, fake):
    client, rownd = migrated(core_url)
    contexts = []
    build = repo.build_rownd_session_claims

    async def claims(config, user_id, payload, app_variant_id, context):
        contexts.append((config, context))
        return await build(config, user_id, payload, app_variant_id, context)

    monkeypatch.setattr(repo, "build_rownd_session_claims", claims)
    assert client.post("/auth/plugin/rownd/migrate", headers=auth_headers("synthetic")).status_code == 200
    config, context = contexts[0]
    assert migration_plan.current_session_evidence(config, rownd.user_id, context) is None
    if fake:
        context = {migration_plan._EVIDENCE_KEY: {"active": True, "phase": "issuance"}}
    await metadata.update_user_metadata(rownd.user_id, {"rownd_migration_provider_introduction": {"tenant": "public"}})
    publication = AsyncMock(wraps=plugin._assert_native_session_publication)
    monkeypatch.setattr(plugin, "_assert_native_session_publication", publication)
    with pytest.raises(MigrationError):
        await repo.session_asyncio.create_new_session_without_request_response(
            "public", RecipeUserId(rownd.user_id), user_context=context,
        )
    publication.assert_awaited_once()


@pytest.mark.parametrize("value", [None, {}, {"data": {"user_id": "foreign"}}])
async def test_literal_foreign_or_unknown_provenance_excludes_ordinary_path(core_url, monkeypatch, value):
    _, rownd = migrated(core_url)
    # None must remain a literal malformed value rather than an SDK delete patch.
    original = metadata.get_user_metadata

    async def raw(identifier, context=None):
        result = await original(identifier, context)
        if identifier == rownd.user_id:
            result.metadata = {**result.metadata, "original_rownd_user": value}
        return result

    monkeypatch.setattr(metadata, "get_user_metadata", raw)
    assert await migration_plan.read_completed_migration(RowndPluginConfig(), source_for(rownd), {}) is None


@pytest.mark.parametrize("literal", ["source", "provider_ledger"])
async def test_unknown_raw_record_is_not_empty_evidence(core_url, monkeypatch, literal):
    from supertokens_rownd.provider_migration import _ledger_id

    _, rownd = migrated(core_url)
    mapping = await repo.get_user_id_mapping(rownd.user_id, "EXTERNAL", {})
    assert isinstance(mapping, GetUserIdMappingOkResult)
    identifier = rownd.user_id if literal == "source" else _ledger_id(mapping.supertokens_user_id, "public")
    original = metadata.get_user_metadata

    async def raw(user_id, context=None):
        result = await original(user_id, context)
        if user_id == identifier:
            setattr(result, "metadata", None)
        return result

    monkeypatch.setattr(metadata, "get_user_metadata", raw)
    assert await migration_plan.read_completed_migration(RowndPluginConfig(), source_for(rownd), {}) is None


@pytest.mark.parametrize("debt", ["unknown", "pending", "foreign_source", "provider_history"])
async def test_post_session_fresh_phase_rejects_new_literal_evidence(core_url, monkeypatch, debt):
    client, rownd = migrated(core_url)
    original = repo.session_asyncio.create_new_session
    sessions = []

    async def create(*args, **kwargs):
        session = await original(*args, **kwargs)
        sessions.append(session)
        mapping = await repo.get_user_id_mapping(rownd.user_id, "EXTERNAL", {})
        assert isinstance(mapping, GetUserIdMappingOkResult)
        target = mapping.supertokens_user_id
        if debt == "provider_history":
            from supertokens_rownd.provider_migration import _ledger_id
            await metadata.update_user_metadata(_ledger_id(target, "public"), {"unknown": {"state": "complete"}})
        else:
            patch = {
                "unknown": {"rownd_unknown_operational": "unknown"},
                "pending": {"rownd_pending_verification": [{}]},
                "foreign_source": {"original_rownd_user": {"data": {"user_id": "foreign"}}},
            }[debt]
            await metadata.update_user_metadata(rownd.user_id, patch)
        return session

    monkeypatch.setattr(repo.session_asyncio, "create_new_session", create)
    response = client.post("/auth/plugin/rownd/migrate", headers=auth_headers("synthetic"))
    assert response.status_code == 503, response.text
    assert not response.headers.get("st-access-token")
    assert len(sessions) == 1
    assert await repo.session_asyncio.get_session_information(sessions[0].get_handle()) is None


async def test_write_between_prephase_and_native_entry_expires_evidence(core_url, monkeypatch):
    client, rownd = migrated(core_url)
    original = repo.session_asyncio.create_new_session
    publication = AsyncMock(wraps=plugin._assert_native_session_publication)
    monkeypatch.setattr(plugin, "_assert_native_session_publication", publication)

    async def create(*args, **kwargs):
        context = args[5]
        await metadata.update_user_metadata(rownd.user_id, {
            "rownd_migration_provider_introduction": {"tenant": "public"},
        }, context)
        return await original(*args, **kwargs)

    monkeypatch.setattr(repo.session_asyncio, "create_new_session", create)
    response = client.post("/auth/plugin/rownd/migrate", headers=auth_headers("synthetic"))
    assert response.status_code == 422, response.text
    assert not response.headers.get("st-access-token")
    publication.assert_awaited_once()


@pytest.mark.parametrize("change", ["primary", "source_namespace", "target_namespace"])
async def test_post_session_rechecks_primary_and_both_literal_namespaces(core_url, monkeypatch, change):
    client, rownd = migrated(core_url)
    mapping = await repo.get_user_id_mapping(rownd.user_id, "EXTERNAL", {})
    assert isinstance(mapping, GetUserIdMappingOkResult)
    target = mapping.supertokens_user_id
    original_create = repo.session_asyncio.create_new_session
    original_user = repo.get_user
    original_mapping = repo.get_user_id_mapping
    sessions = []

    async def create(*args, **kwargs):
        session = await original_create(*args, **kwargs)
        sessions.append(session)
        return session

    async def user(identifier, context=None):
        result = await original_user(identifier, context)
        if sessions and change == "primary" and result is not None:
            result = deepcopy(result)
            result.is_primary_user = False
        return result

    async def maps(identifier, role=None, context=None):
        result = await original_mapping(identifier, role, context)
        if sessions:
            if change == "source_namespace" and (identifier, role) == (rownd.user_id, "SUPERTOKENS"):
                return GetUserIdMappingOkResult(rownd.user_id, "foreign-alias")
            if change == "target_namespace" and (identifier, role) == (target, "EXTERNAL"):
                return GetUserIdMappingOkResult("foreign-target", target)
        return result

    monkeypatch.setattr(repo.session_asyncio, "create_new_session", create)
    monkeypatch.setattr(repo, "get_user", user)
    monkeypatch.setattr(repo, "get_user_id_mapping", maps)
    response = client.post("/auth/plugin/rownd/migrate", headers=auth_headers("synthetic"))
    assert response.status_code == 503, response.text
    assert not response.headers.get("st-access-token")
    assert len(sessions) == 1
    assert await repo.session_asyncio.get_session_information(sessions[0].get_handle()) is None


@pytest.mark.parametrize("kind", ["schema", "variant"])
async def test_custom_configuration_falls_back_before_core_probe(core_url, monkeypatch, kind):
    _, rownd = migrated(core_url)
    assert rownd.user_info is not None
    config = RowndPluginConfig(schema={}) if kind == "schema" else RowndPluginConfig()
    source = _bind_authenticated_source(repo.FreshMigrationSource(
        rownd.user_info, create_rownd_identity_snapshot(rownd.user_info, "public", "variant" if kind == "variant" else None),
    ))
    mapping = AsyncMock(side_effect=AssertionError("ineligible Core probe"))
    monkeypatch.setattr(repo, "get_user_id_mapping", mapping)
    assert await migration_plan.read_completed_migration(config, source, {}) is None
    mapping.assert_not_awaited()

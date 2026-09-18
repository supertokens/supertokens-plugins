import copy
from types import SimpleNamespace
from typing import Any, cast
from unittest.mock import AsyncMock, Mock

import pytest
from supertokens_python import SupertokensConfig
from supertokens_python.recipe.passwordless import asyncio as passwordless
from supertokens_python.recipe.session import asyncio as sessions
from supertokens_python.recipe.usermetadata import asyncio as metadata
from supertokens_python.types import RecipeUserId

from supertokens_rownd import plugin, provider_session
from supertokens_rownd import plugin_implementation, session_authentication
from supertokens_rownd import supertokens_repository as repository
from supertokens_rownd.admin_planning import AdministrativePolicyError
from supertokens_rownd.errors import MigrationError, MigrationErrorReason
from supertokens_rownd.migration import create_rownd_identity_snapshot
from supertokens_rownd.migration_authority import _bind_authenticated_source
from supertokens_rownd.reconcile_user import reconcile_user
from supertokens_rownd.rownd_repository import RowndAPIError, RowndAPIErrorReason
from supertokens_rownd.types import RowndPluginConfig

from test_reconciliation_acceptance import merge_fixture
from test_migration_contract import CapturingTelemetry, FakeRequest, FakeResponse


@pytest.mark.parametrize("failure_at", ["before", "after", "refresh"])
@pytest.mark.parametrize("revoke_fails", [False, True])
async def test_pending_publication_prevents_or_revokes_issuance(monkeypatch, failure_at, revoke_fails):
    failure = AdministrativePolicyError("Fresh mapping publication is incomplete")
    guard = AsyncMock(side_effect=[None, failure] if failure_at == "after" else failure)
    monkeypatch.setattr(plugin, "_assert_native_session_publication", guard)
    provider = AsyncMock()
    monkeypatch.setattr(provider_session, "assert_provider_session_membership", provider)
    monkeypatch.setattr(plugin, "build_rownd_session_and_anonymous_claims", AsyncMock(return_value=({}, {})))
    session = SimpleNamespace(
        get_user_id=lambda: "canonical",
        get_recipe_user_id=lambda: RecipeUserId("alias"),
        get_tenant_id=lambda: "public",
        revoke_session=AsyncMock(side_effect=RuntimeError("cleanup failed") if revoke_fails else None),
    )
    create = AsyncMock(return_value=session)
    refresh = AsyncMock(return_value=session)
    implementation = plugin._session_function_override(RowndPluginConfig())(
        cast(Any, SimpleNamespace(create_new_session=create, refresh_session=refresh))
    )
    context = {}
    with pytest.raises(AdministrativePolicyError) as caught:
        if failure_at == "refresh":
            await implementation.refresh_session("refresh-token", None, True, context)
        else:
            await implementation.create_new_session(
                "canonical", RecipeUserId("alias"), {}, {}, False, "public", context,
            )
    assert caught.value is failure
    if failure_at == "before":
        create.assert_not_awaited()
        session.revoke_session.assert_not_awaited()
    else:
        session.revoke_session.assert_awaited_once_with(context)
    assert guard.await_args is not None
    assert guard.await_args.args == ("canonical", "alias", context)


async def test_malformed_completed_owner_preserves_native_credentials_but_blocks_unmarked_origin(core_url):
    fixture = await merge_fixture(core_url)
    assert (await reconcile_user(rownd_user_id=fixture.new))["status"] == "OK"
    issued = await sessions.create_new_session_without_request_response("public", RecipeUserId(fixture.new))
    refresh_token = issued.get_all_session_tokens_dangerously()["refreshToken"]
    assert refresh_token is not None
    raw = (await metadata.get_user_metadata(fixture.target)).metadata
    plan = copy.deepcopy(raw["rownd_migration_owner_consolidation"])
    plan["completion"] = {"recipes": [], "state": {"graph": [], "mappings": [], "markers": [], "verifications": []}}
    await metadata.update_user_metadata(fixture.target, {"rownd_migration_owner_consolidation": plan})
    native = await sessions.create_new_session_without_request_response("public", RecipeUserId(fixture.new))
    assert native.get_user_id() == fixture.new
    refreshed = await sessions.refresh_session_without_request_response(refresh_token, disable_anti_csrf=True)
    assert refreshed.get_user_id() == fixture.new
    assert await sessions.get_session_information(issued.get_handle()) is not None
    user = await repository.get_user(fixture.new, {})
    with pytest.raises(AdministrativePolicyError):
        await session_authentication.session_authentication_origin(user, fixture.new, {}, {})
    assert (await reconcile_user(rownd_user_id=fixture.new))["status"] == "BLOCKED"
    unrelated = await passwordless.signinup("public", email=fixture.new + "-unrelated@example.com", phone_number=None)
    native = await sessions.create_new_session_without_request_response("public", unrelated.recipe_user_id)
    assert native.get_user_id() == unrelated.user.id
    assert await sessions.get_session_information(native.get_handle()) is not None
    for key, value in (
        ("rownd_migration_mapping_publication", {"version": 1}),
        ("rownd_migration_orphan_mapping_repair", {"phase": "APPLYING"}),
    ):
        await metadata.update_user_metadata(fixture.target, {key: value})
        with pytest.raises(AdministrativePolicyError):
            await sessions.create_new_session_without_request_response("public", RecipeUserId(fixture.new))
        await metadata.update_user_metadata(fixture.target, {key: None})


@pytest.mark.parametrize("changed", ["source", "owner", "recipe", "session_owner", "disabled", "proof"])
async def test_alias_issuance_rechecks_source_authority_and_canonical_binding(monkeypatch, changed):
    profile = {"state": "enabled", "data": {"user_id": "alias", "email": "user@example.com"},
               "verified_data": {"email": True}}

    def source(raw, authenticated=True):
        result = repository.FreshMigrationSource(raw, create_rownd_identity_snapshot(raw, "public", None))
        return _bind_authenticated_source(result) if authenticated else result

    original_source = source(profile)
    updated = copy.deepcopy(profile)
    if changed == "source":
        updated["data"]["email"] = "different@example.com"
    if changed == "disabled":
        updated["state"] = "disabled"
    fresh_source = source(updated, changed != "proof")
    reader = AsyncMock(side_effect=[original_source, fresh_source])
    owner = {"target": "internal", "canonical_rownd_id": "canonical", "recipe_user_id": RecipeUserId("alias")}
    changed_owner = dict(owner)
    if changed == "owner":
        changed_owner["target"] = "other-internal"
    if changed == "recipe":
        changed_owner["recipe_user_id"] = RecipeUserId("other-alias")
    resolver = AsyncMock(side_effect=[owner, changed_owner])
    monkeypatch.setattr(plugin_implementation, "resolve_consolidated_token_owner", resolver)
    monkeypatch.setattr(repository, "record_rownd_app_variant_for_user", AsyncMock())
    monkeypatch.setattr(repository, "build_rownd_session_claims", AsyncMock(return_value={}))
    scrub = Mock()
    monkeypatch.setattr(repository, "scrub_migration_session_response", scrub)
    session = SimpleNamespace(
        get_user_id=lambda context: "wrong" if changed == "session_owner" else "canonical",
        get_recipe_user_id=lambda context: RecipeUserId("alias"),
        get_tenant_id=lambda context: "public",
        revoke_session=AsyncMock(),
    )

    async def create(*args):
        assert session_authentication._proven_authentication.get() is True
        assert args[2].get_as_string() == "alias"
        return session

    monkeypatch.setattr(plugin_implementation.session_asyncio, "create_new_session", create)
    request, response = cast(Any, object()), cast(Any, object())
    context = {}
    with pytest.raises(MigrationError):
        await plugin_implementation._create_consolidated_alias_session(
            RowndPluginConfig(), original_source, owner, request, response, "public", None,
            context, {}, reader, AsyncMock(),
        )
    session.revoke_session.assert_awaited_once_with(context)
    scrub.assert_called_once_with(response, request)
    assert session_authentication._proven_authentication.get() is False


@pytest.mark.parametrize("phase", ["initial", "before", "after"])
@pytest.mark.parametrize("failure_kind", ["rownd", "core", "unexpected", "typed", "policy"])
async def test_alias_resolution_errors_keep_transport_classification_and_cleanup(monkeypatch, phase, failure_kind):
    owner = {"target": "internal", "canonical_rownd_id": "canonical", "recipe_user_id": RecipeUserId("alias")}
    profile = {"state": "enabled", "data": {"user_id": "alias", "email": "user@example.com"},
               "verified_data": {"email": True}}
    context = {}
    session = SimpleNamespace(
        get_user_id=lambda context: "canonical",
        get_recipe_user_id=lambda context: RecipeUserId("alias"),
        get_tenant_id=lambda context: "public",
        revoke_session=AsyncMock(),
    )
    create = AsyncMock(return_value=session)
    scrub = Mock()
    monkeypatch.setattr(plugin_implementation, "assert_source_not_superseded", AsyncMock())
    monkeypatch.setattr(repository, "record_rownd_app_variant_for_user", AsyncMock())
    monkeypatch.setattr(repository, "build_rownd_session_claims", AsyncMock(return_value={}))
    monkeypatch.setattr(repository, "scrub_migration_session_response", scrub)
    monkeypatch.setattr(plugin_implementation.session_asyncio, "create_new_session", create)
    fail_profile = False

    async def fetch_profile(identifier):
        if fail_profile:
            raise RowndAPIError(RowndAPIErrorReason.UNAVAILABLE)
        return profile if identifier == "alias" else {
            **profile, "data": {**profile["data"], "user_id": identifier},
        }

    phases = iter(["initial", "before", "after"])

    async def resolve(identifier, tenant, user_context, fetch):
        nonlocal fail_profile
        current = next(phases)
        if current == phase:
            if failure_kind == "core":
                raise ConnectionError("Core connection lost")
            if failure_kind == "unexpected":
                raise RuntimeError("unexpected resolver failure")
            if failure_kind == "typed":
                raise MigrationError(MigrationErrorReason.MAPPING_CONFLICT, "mapping")
            if failure_kind == "policy":
                raise AdministrativePolicyError("Completed owner graph changed")
            fail_profile = True
        try:
            await fetch(identifier if current == "initial" else "canonical")
        finally:
            fail_profile = False
        return owner

    monkeypatch.setattr(plugin_implementation, "resolve_consolidated_token_owner", resolve)
    client = SimpleNamespace(validate_token=AsyncMock(return_value="alias"), fetch_optional_user_info=fetch_profile)
    request, response, telemetry = FakeRequest(), FakeResponse(), CapturingTelemetry()
    await plugin_implementation.handle_migrate(
        RowndPluginConfig(), cast(Any, client), telemetry, SupertokensConfig("http://localhost:3567"),
        cast(Any, request), cast(Any, response), context,
    )
    expected = {
        "rownd": (503, "ROWND_UNAVAILABLE", "rownd_profile_fetch"),
        "core": (503, "CORE_UNAVAILABLE", "state_inspect"),
        "unexpected": (500, "INTERNAL_ERROR", "state_inspect"),
        "typed": (422, "MAPPING_CONFLICT", "mapping"),
        "policy": (422, "MIGRATION_STATE_INVALID", "state_inspect"),
    }[failure_kind]
    assert response.status_code == expected[0]
    assert response.body is not None and response.body["reason"] == expected[1]
    assert len(telemetry.events) == 1
    assert telemetry.events[0]["stage"] == expected[2]
    if phase == "after":
        create.assert_awaited_once()
        session.revoke_session.assert_awaited_once_with(context)
        scrub.assert_called_once_with(response, request)
    else:
        create.assert_not_awaited()
        session.revoke_session.assert_not_awaited()
        scrub.assert_not_called()

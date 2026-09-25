from __future__ import annotations

from unittest.mock import AsyncMock
from types import SimpleNamespace

import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from supertokens_python.interfaces import GetUserIdMappingOkResult

from supertokens_rownd import mapped_session
from supertokens_rownd.errors import MigrationError
from supertokens_rownd.rownd_repository import HostedRowndTokenValidator, RowndTokenValidationError
from supertokens_rownd.types import RowndPluginConfig
from test_rownd_repository import _jwk, _token, APP_ID


@pytest.mark.parametrize("claims,omit", [
    ({}, ()),
    ({"iss": "https://wrong.example"}, ()),
    ({"aud": "app:other"}, ()),
    ({}, ("exp",)),
    ({}, ("https://auth.rownd.io/app_user_id",)),
    ({"exp": 1}, ()),
    ({"https://auth.rownd.io/app_user_id": ".."}, ()),
])
async def test_hosted_keys_and_required_claims(claims, omit):
    key = Ed25519PrivateKey.generate()
    calls = []

    def serve(request):
        calls.append(str(request.url))
        return httpx.Response(200, json={"keys": [_jwk("A", key)]})

    transport = httpx.MockTransport(serve)
    validator = HostedRowndTokenValidator(RowndPluginConfig(rownd_app_id=APP_ID), transport=transport)
    token = _token("A", key, claims={"iss": "https://api.rownd.io", **claims}, omit_claims=omit)
    if not claims and not omit:
        assert await validator.validate_token(token) == "rownd-user-id"
        assert await validator.validate_token(token) == "rownd-user-id"
        assert calls == [HostedRowndTokenValidator.JWKS_URL]
    else:
        with pytest.raises(RowndTokenValidationError):
            await validator.validate_token(token)
    assert calls == [HostedRowndTokenValidator.JWKS_URL]


async def test_credentials_can_discover_audience_for_hosted_validation():
    key = Ed25519PrivateKey.generate()

    def serve(request):
        if request.url.path == "/hub/app-config":
            return httpx.Response(200, json={"app": {"id": APP_ID}})
        return httpx.Response(200, json={"keys": [_jwk("A", key)]})

    validator = HostedRowndTokenValidator(
        RowndPluginConfig(rownd_app_key="key", rownd_app_secret="secret"),
        transport=httpx.MockTransport(serve),
    )
    assert await validator.validate_token(_token("A", key, claims={"iss": "https://api.rownd.io"})) == "rownd-user-id"


async def test_mapping_rejects_inconsistent_reverse_before_session(monkeypatch):
    from supertokens_rownd import supertokens_repository as repo

    monkeypatch.setattr(repo, "clear_supertokens_core_call_cache", lambda context: None)

    async def mapping(identifier, role, context):
        if (identifier, role) == ("rownd", "EXTERNAL"):
            return GetUserIdMappingOkResult("internal", "rownd")
        if (identifier, role) == ("internal", "SUPERTOKENS"):
            return GetUserIdMappingOkResult("internal", "someone-else")
        return None

    monkeypatch.setattr(repo, "get_user_id_mapping", mapping)
    create = AsyncMock(side_effect=AssertionError("must not create session"))
    monkeypatch.setattr(mapped_session.session_asyncio, "create_new_session", create)
    with pytest.raises(MigrationError):
        await mapped_session.create_mapped_session(
            RowndPluginConfig(rownd_app_id=APP_ID), "rownd", "public", None,
            object(), object(), {},  # type: ignore[arg-type]
        )
    create.assert_not_awaited()


@pytest.mark.parametrize("tenant_member,owner_changes,provenance_matches,target_complete", [
    (False, False, True, True), (True, False, True, True), (True, True, True, True),
    (True, False, False, True), (True, False, True, False),
])
async def test_mapped_session_checks_tenant_and_revokes_on_owner_change(
    monkeypatch, tenant_member, owner_changes, provenance_matches, target_complete,
):
    from supertokens_rownd import supertokens_repository as repo

    state = {"owner": "rownd"}
    monkeypatch.setattr(repo, "clear_supertokens_core_call_cache", lambda context: None)

    async def mapping(identifier, role, context):
        if (identifier, role) == ("rownd", "EXTERNAL"):
            return GetUserIdMappingOkResult("internal", "rownd")
        if (identifier, role) == ("internal", "SUPERTOKENS"):
            return GetUserIdMappingOkResult("internal", "rownd")
        return None

    monkeypatch.setattr(repo, "get_user_id_mapping", mapping)
    profile = {"state": "enabled", "data": {"user_id": "rownd" if provenance_matches else "another-user",
                                            "email": "person@example.com"},
               "verified_data": {"email": True}}

    async def metadata(identifier, context):
        return {"rownd_migration_complete": target_complete, "original_rownd_user": profile} if identifier == "internal" else {}

    monkeypatch.setattr(mapped_session, "_read_literal_metadata", metadata)
    method = SimpleNamespace(recipe_user_id=SimpleNamespace(get_as_string=lambda: "recipe"),
                             tenant_ids=["public"] if tenant_member else [], recipe_id="passwordless",
                             has_same_email_as=lambda email: email == "person@example.com")
    async def user(identifier, context):
        return SimpleNamespace(is_primary_user=True, id=state["owner"], login_methods=[method])

    monkeypatch.setattr(repo, "get_user", user)
    monkeypatch.setattr(repo, "_get_migration_identity_users", AsyncMock(return_value=[]))
    async def completed(snapshot, target, context, **kwargs):
        return await user(target, context)

    monkeypatch.setattr(mapped_session, "completed_identity_user", completed)
    monkeypatch.setattr(repo, "build_rownd_session_claims", AsyncMock(return_value={}))
    session = SimpleNamespace(get_user_id=lambda context: "rownd",
                              get_recipe_user_id=lambda context: method.recipe_user_id,
                              get_tenant_id=lambda context: "public", revoke_session=AsyncMock())

    async def create(*args):
        if owner_changes:
            state["owner"] = "other"
        return session

    create_mock = AsyncMock(side_effect=create)
    monkeypatch.setattr(mapped_session.session_asyncio, "create_new_session", create_mock)
    monkeypatch.setattr(repo, "scrub_migration_session_response", lambda response, request: None)
    async def run():
        return await mapped_session.create_mapped_session(
            RowndPluginConfig(rownd_app_id=APP_ID), "rownd", "public", None,
            object(), object(), {},  # type: ignore[arg-type]
        )

    if tenant_member and not owner_changes and provenance_matches and target_complete:
        assert await run() == "rownd"
    else:
        with pytest.raises(MigrationError):
            await run()
    if tenant_member and provenance_matches and target_complete:
        create_mock.assert_awaited_once()
        if owner_changes:
            session.revoke_session.assert_awaited_once()
        else:
            session.revoke_session.assert_not_awaited()
    else:
        create_mock.assert_not_awaited()

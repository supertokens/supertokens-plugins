from __future__ import annotations

import time
from datetime import datetime, timezone
from unittest.mock import AsyncMock
from types import SimpleNamespace

import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from supertokens_python.interfaces import GetUserIdMappingOkResult

from supertokens_rownd import mapped_session
from supertokens_rownd.errors import MigrationError
from supertokens_rownd.rownd_repository import HostedRowndTokenValidator, RowndTokenValidationError, validate_profile_token_cutoff
from supertokens_rownd.types import RowndPluginConfig, RowndTokenInfo
from test_rownd_repository import _jwk, _token, APP_ID


@pytest.mark.parametrize("claims,omit", [
    ({}, ()),
    ({"iss": "https://wrong.example"}, ()),
    ({"aud": "app:other"}, ()),
    ({}, ("exp",)),
    ({}, ("iat",)),
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
        validated = await validator.validate_migration_token(token)
        assert validated.user_id == "rownd-user-id"
        assert isinstance(validated.iat, int)
        assert await validator.validate_migration_token(token) == validated
        assert await validator.validate_token(token) == validated.user_id
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
    assert (await validator.validate_migration_token(_token("A", key, claims={"iss": "https://api.rownd.io"}))).user_id == "rownd-user-id"


@pytest.mark.parametrize("token_type", ["access_token", "refresh_token", "id_token", "", None, 123, {}])
async def test_signed_token_types(token_type):
    key = Ed25519PrivateKey.generate()
    validator = HostedRowndTokenValidator(RowndPluginConfig(rownd_app_id=APP_ID), transport=httpx.MockTransport(
        lambda request: httpx.Response(200, json={"keys": [_jwk("A", key)]})))
    issued_at = int(time.time()) - 60
    token = _token("A", key, claims={"iss": "https://api.rownd.io", "iat": issued_at,
                                    "https://auth.rownd.io/jwt_type": token_type})
    if token_type in ("access_token", "refresh_token"):
        assert await validator.validate_migration_token(token) == RowndTokenInfo("rownd-user-id", issued_at)
    else:
        with pytest.raises(RowndTokenValidationError):
            await validator.validate_token(token)


@pytest.mark.parametrize("claims,omit", [
    ({}, ("exp",)), ({"exp": 1}, ()), ({}, ("iat",)),
    ({"iat": "invalid"}, ()), ({"iat": "123"}, ()), ({"iat": True}, ()),
    ({"iat": float("inf")}, ()), ({"iat": float("nan")}, ()),
    ({"exp": float("inf")}, ()), ({"exp": "9999999999"}, ()),
])
async def test_refresh_requires_valid_expiry_and_issued_at(claims, omit):
    key = Ed25519PrivateKey.generate()
    validator = HostedRowndTokenValidator(RowndPluginConfig(rownd_app_id=APP_ID), transport=httpx.MockTransport(
        lambda request: httpx.Response(200, json={"keys": [_jwk("A", key)]})))
    token = _token("A", key, claims={"iss": "https://api.rownd.io",
                                    "https://auth.rownd.io/jwt_type": "refresh_token", **claims}, omit_claims=omit)
    with pytest.raises(RowndTokenValidationError):
        await validator.validate_token(token)


@pytest.mark.parametrize("cutoff,issued_at,allowed", [
    ("2026-01-01T00:00:00Z", 1767225600, True),
    ("2026-01-01T01:00:00+01:00", 1767225600, True),
    ("2026-01-01T00:00:00Z", 1767225601, True),
    ("2026-01-01T00:00:00.001Z", 1767225600, False),
    ("invalid", 1767225600, False), (None, 1767225600, False), (123, 1767225600, False),
    ("2026-01-01T00:00:00Z", None, False), ("2026-01-01T00:00:00Z", float("nan"), False),
    ("2026-01-01T00:00:00Z", float("inf"), False), ("2026-01-01T00:00:00Z", True, False),
])
def test_profile_cutoff(cutoff, issued_at, allowed):
    if allowed:
        validate_profile_token_cutoff({"meta": {"tokens_valid_since": cutoff}}, issued_at)
    else:
        with pytest.raises(RowndTokenValidationError):
            validate_profile_token_cutoff({"meta": {"tokens_valid_since": cutoff}}, issued_at)


def test_profile_without_cutoff_accepts_legacy_client():
    validate_profile_token_cutoff({"meta": {}}, None)


@pytest.mark.parametrize("cutoff,token_info", [
    ("2026-01-01T00:00:00Z", "rownd"),
    ("2026-01-01T00:00:00Z", RowndTokenInfo("rownd")),
    ("invalid", RowndTokenInfo("rownd", 1767225600)),
    (None, RowndTokenInfo("rownd", 1767225600)),
    (123, RowndTokenInfo("rownd", 1767225600)),
])
async def test_cutoff_failures_stop_migration_before_core_reads(monkeypatch, cutoff, token_info):
    from supertokens_python import SupertokensConfig
    from supertokens_rownd import migration_plan
    from supertokens_rownd.plugin_implementation import handle_migrate
    from test_migration_contract import CapturingTelemetry, FakeRequest, FakeResponse, FakeRowndClient

    client = FakeRowndClient(user_info={
        "data": {"user_id": "rownd"}, "meta": {"tokens_valid_since": cutoff},
    })
    monkeypatch.setattr(client, "validate_token", AsyncMock(return_value=token_info))
    inspect = AsyncMock(side_effect=AssertionError("cutoff must be checked before migration inspection"))
    monkeypatch.setattr(migration_plan, "read_completed_migration", inspect)
    config = RowndPluginConfig(rownd_app_key="key", rownd_app_secret="secret", rownd_client=client)
    response = FakeResponse()
    await handle_migrate(config, client, CapturingTelemetry(), SupertokensConfig("http://localhost:3567"),
                         FakeRequest(), response, {})  # type: ignore[arg-type]
    assert response.status_code == 401
    assert response.body is not None and response.body["reason"] == "TOKEN_CLAIMS_INVALID"
    inspect.assert_not_awaited()


@pytest.mark.parametrize("token_type", ["access_token", "refresh_token", "id_token"])
async def test_credential_free_signed_migration_never_reads_profile(monkeypatch, token_type):
    from supertokens_python import SupertokensConfig
    from supertokens_rownd.plugin_implementation import handle_migrate
    from test_migration_contract import CapturingTelemetry, FakeRequest, FakeResponse

    key = Ed25519PrivateKey.generate()
    config = RowndPluginConfig(rownd_app_id=APP_ID)
    validator = HostedRowndTokenValidator(config, transport=httpx.MockTransport(
        lambda request: httpx.Response(200, json={"keys": [_jwk("A", key)]})))
    fetch_profile = AsyncMock(side_effect=AssertionError("keys-only migration must not fetch profiles"))
    monkeypatch.setattr(validator, "fetch_optional_user_info", fetch_profile)
    migrate = AsyncMock(return_value="rownd-user-id")
    monkeypatch.setattr(mapped_session, "create_mapped_session", migrate)
    token = _token("A", key, claims={"iss": "https://api.rownd.io", "https://auth.rownd.io/jwt_type": token_type})
    for _ in range(2):
        response = FakeResponse()
        await handle_migrate(config, validator, CapturingTelemetry(), SupertokensConfig("http://localhost:3567"),
                             FakeRequest("Bearer " + token), response, {})  # type: ignore[arg-type]
        assert response.status_code == (401 if token_type == "id_token" else 200)
    assert migrate.await_count == (0 if token_type == "id_token" else 2)
    fetch_profile.assert_not_awaited()


@pytest.mark.parametrize("record", [
    {"rownd_migration_target": "other"}, {"rownd_migration_canonical_target": "other"},
    {"rownd_migration_operation": {}}, {"rownd_python_owner_plan": {}},
    {"rownd_pending_verification": {"public": "email"}},
    {"original_rownd_user": {"data": {"user_id": "other"}}},
])
@pytest.mark.parametrize("identifier", ["rownd", "internal", "recipe"])
async def test_keys_only_completion_does_not_bypass_pending_or_conflicting_ownership(monkeypatch, record, identifier):
    from supertokens_rownd import supertokens_repository as repo

    async def mapping(user_id, role, context):
        if (user_id, role) in {("rownd", "EXTERNAL"), ("internal", "SUPERTOKENS")}:
            return GetUserIdMappingOkResult("internal", "rownd")
        return None

    async def metadata(user_id, context):
        return {"rownd_migration_complete": True, **record} if user_id == identifier else {}

    monkeypatch.setattr(repo, "clear_supertokens_core_call_cache", lambda context: None)
    monkeypatch.setattr(repo, "get_user_id_mapping", mapping)
    monkeypatch.setattr(mapped_session, "_read_literal_metadata", metadata)
    method = SimpleNamespace(recipe_user_id=SimpleNamespace(get_as_string=lambda: "recipe"),
                             tenant_ids=["public"], recipe_id="passwordless")
    monkeypatch.setattr(repo, "get_user", AsyncMock(return_value=SimpleNamespace(id="rownd", login_methods=[method])))
    create = AsyncMock()
    monkeypatch.setattr(mapped_session.session_asyncio, "create_new_session", create)
    with pytest.raises(MigrationError):
        await mapped_session.create_mapped_session(
            RowndPluginConfig(rownd_app_id=APP_ID), "rownd", "public", None,
            object(), object(), {},  # type: ignore[arg-type]
        )
    create.assert_not_awaited()


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


@pytest.mark.parametrize("target_complete,source_complete", [
    (None, None), (False, False), (True, False), (False, True), (True, True),
])
@pytest.mark.parametrize("saved_profile", [False, True])
@pytest.mark.parametrize("tenant_member,owner_changes,provenance_matches", [
    (False, False, True), (True, False, True), (True, True, True),
    (True, False, False),
])
async def test_mapped_session_checks_tenant_and_revokes_on_owner_change(
    monkeypatch, tenant_member, owner_changes, provenance_matches, target_complete, source_complete, saved_profile,
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
        result = {}
        if identifier == "internal":
            if target_complete is not None:
                result["rownd_migration_complete"] = target_complete
            if saved_profile:
                result["original_rownd_user"] = profile
        if identifier == "rownd" and source_complete is not None:
            result["rownd_migration_complete"] = source_complete
        return result

    monkeypatch.setattr(mapped_session, "_read_literal_metadata", metadata)
    method = SimpleNamespace(recipe_user_id=SimpleNamespace(get_as_string=lambda: "recipe"),
                             tenant_ids=["public"] if tenant_member else [], recipe_id="passwordless",
                             has_same_email_as=lambda email: email == "person@example.com")
    async def user(identifier, context):
        return SimpleNamespace(is_primary_user=True, id=state["owner"], login_methods=[method])

    monkeypatch.setattr(repo, "get_user", user)
    monkeypatch.setattr(mapped_session, "_entries", AsyncMock(return_value={}))
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

    if tenant_member and not owner_changes and (provenance_matches or not saved_profile):
        assert await run() == "rownd"
    else:
        with pytest.raises(MigrationError):
            await run()
    if tenant_member and (provenance_matches or not saved_profile):
        create_mock.assert_awaited_once()
        if owner_changes:
            session.revoke_session.assert_awaited_once()
        else:
            session.revoke_session.assert_not_awaited()
    else:
        create_mock.assert_not_awaited()


@pytest.mark.parametrize("route", ["/auth/plugin/rownd/migrate", "/auth/plugin/migrate-session"])
@pytest.mark.parametrize("token_type", [None, "access_token", "refresh_token"])
async def test_signed_migration_cutoff_before_writes_and_token_reuse(core_url, rownd_client, monkeypatch, route, token_type):
    from uuid import uuid4
    from conftest import make_client, session_headers
    from supertokens_python.asyncio import get_user, get_user_id_mapping
    from supertokens_python.recipe.session import asyncio as sessions
    from supertokens_rownd import supertokens_repository as repo

    key = Ed25519PrivateKey.generate()
    validator = HostedRowndTokenValidator(RowndPluginConfig(rownd_app_id=APP_ID), transport=httpx.MockTransport(
        lambda request: httpx.Response(200, json={"keys": [_jwk("A", key)]})))
    monkeypatch.setattr(rownd_client, "validate_token", validator.validate_migration_token)
    source = "cutoff-" + str(uuid4())
    cutoff = int(time.time()) - 60
    rownd_client.user_info = {
        "state": "enabled", "data": {"user_id": source, "email": source + "@example.com"},
        "verified_data": {"email": True},
        "meta": {"tokens_valid_since": datetime.fromtimestamp(cutoff, timezone.utc).isoformat()},
    }
    client = make_client(core_url, rownd_client)
    writes = AsyncMock(wraps=repo.usermetadata_asyncio.update_user_metadata)
    create_session = AsyncMock(wraps=repo.session_asyncio.create_new_session)
    monkeypatch.setattr(repo.usermetadata_asyncio, "update_user_metadata", writes)
    monkeypatch.setattr(repo.session_asyncio, "create_new_session", create_session)

    def token(iat):
        claims = {"iss": "https://api.rownd.io", "iat": iat, "https://auth.rownd.io/app_user_id": source}
        if token_type is not None:
            claims["https://auth.rownd.io/jwt_type"] = token_type
        return _token("A", key, claims=claims)

    rejected = client.post(route, headers={**session_headers(), "Authorization": "Bearer " + token(cutoff - 1)})
    assert rejected.status_code == 401, rejected.text
    assert rejected.json()["reason"] == "TOKEN_CLAIMS_INVALID"
    assert all(header not in rejected.headers for header in ("set-cookie", "st-access-token", "st-refresh-token", "front-token"))
    writes.assert_not_awaited()
    create_session.assert_not_awaited()
    assert await get_user(source) is None
    assert not isinstance(await get_user_id_mapping(source, "EXTERNAL"), GetUserIdMappingOkResult)

    bearer = token(cutoff)
    for _ in range(2):
        accepted = client.post(route, headers={**session_headers(), "Authorization": "Bearer " + bearer})
        assert accepted.status_code == 200, accepted.text
        assert accepted.json() == {"status": "OK"}
        assert all(accepted.headers.get(header) for header in ("st-access-token", "st-refresh-token", "front-token"))
        session = await sessions.get_session_without_request_response(accepted.headers["st-access-token"])
        assert session is not None and session.get_user_id() == source


@pytest.mark.parametrize("complete", [None, False, True])
async def test_keys_only_real_mapped_user_without_saved_profile(core_url, monkeypatch, complete):
    from uuid import uuid4
    from fastapi import FastAPI
    from conftest import TestClientWithNoCookieJar, session_headers
    from supertokens_python import InputAppInfo, SupertokensConfig, SupertokensExperimentalConfig, init
    from supertokens_python.asyncio import create_user_id_mapping
    from supertokens_python.framework.fastapi import get_middleware
    from supertokens_python.recipe import accountlinking, passwordless, session, usermetadata
    from supertokens_python.recipe.passwordless import asyncio as passwordless_api
    from supertokens_python.recipe.session import asyncio as sessions
    from supertokens_python.recipe.usermetadata import asyncio as metadata
    from supertokens_rownd import init as rownd_init
    from supertokens_rownd.rownd_repository import RowndClient

    key = Ed25519PrivateKey.generate()
    config = RowndPluginConfig(rownd_app_id=APP_ID)
    validator = HostedRowndTokenValidator(config, transport=httpx.MockTransport(
        lambda request: httpx.Response(200, json={"keys": [_jwk("A", key)]})))
    async def validate(client, token):
        return await validator.validate_migration_token(token)

    fetch_profile = AsyncMock(side_effect=AssertionError("no live profile in keys-only mode"))
    monkeypatch.setattr(RowndClient, "validate_migration_token", validate)
    monkeypatch.setattr(RowndClient, "fetch_optional_user_info", fetch_profile)
    init(app_info=InputAppInfo(app_name="Test", api_domain="http://testserver", website_domain="http://website.example.com", api_base_path="/auth"),
         framework="fastapi", supertokens_config=SupertokensConfig(core_url),
         recipe_list=[accountlinking.init(), session.init(anti_csrf="NONE"), usermetadata.init(),
                      passwordless.init(contact_config=passwordless.ContactEmailOnlyConfig(), flow_type="MAGIC_LINK")],
         experimental=SupertokensExperimentalConfig(plugins=[rownd_init(config)]))
    source = "keys-only-" + str(uuid4())
    result = await passwordless_api.signinup("public", email=source + "@example.com", phone_number=None)
    target = result.user.id
    await create_user_id_mapping(target, source)
    if complete is not None:
        await metadata.update_user_metadata(target, {"rownd_migration_complete": complete})
        await metadata.update_user_metadata(source, {"rownd_migration_complete": not complete})
    app = FastAPI()
    app.add_middleware(get_middleware())
    client = TestClientWithNoCookieJar(app, raise_server_exceptions=False)
    token = _token("A", key, claims={"iss": "https://api.rownd.io", "https://auth.rownd.io/app_user_id": source,
                                    "https://auth.rownd.io/jwt_type": "refresh_token"})
    for route in ("/auth/plugin/rownd/migrate", "/auth/plugin/migrate-session"):
        response = client.post(route, headers={**session_headers(), "Authorization": "Bearer " + token})
        assert response.status_code == 200, response.text
        assert all(response.headers.get(header) for header in ("st-access-token", "st-refresh-token", "front-token"))
        created = await sessions.get_session_without_request_response(response.headers["st-access-token"])
        assert created is not None and created.get_user_id() == source
        assert created.get_recipe_user_id().get_as_string() == source
    fetch_profile.assert_not_awaited()

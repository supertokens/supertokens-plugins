from __future__ import annotations

import uuid

from supertokens_python.asyncio import get_user, get_user_id_mapping
from supertokens_python.interfaces import GetUserIdMappingOkResult
from supertokens_python.recipe.accountlinking import asyncio as linking
from supertokens_python.recipe.session import asyncio as sessions
from supertokens_python.recipe.thirdparty import asyncio as providers
from supertokens_python.recipe.thirdparty.interfaces import ManuallyCreateOrUpdateUserOkResult

from conftest import make_client, session_headers
from supertokens_rownd.session_authentication import SESSION_AUTHENTICATION_KEY


async def test_instant_token_cannot_select_linked_authenticated_recipe(core_url, rownd_client):
    client = make_client(core_url, rownd_client)
    rownd_id = "instant-session-" + uuid.uuid4().hex
    rownd_client.user_id = rownd_id
    rownd_client.user_info = {
        "data": {"user_id": rownd_id}, "verified_data": {}, "auth_level": "instant",
    }

    def migrate():
        return client.post(
            "/auth/plugin/rownd/migrate",
            headers={"Authorization": "Bearer rownd-token", **session_headers()},
        )

    initial = migrate()
    assert initial.status_code == 200, initial.text
    mapping = await get_user_id_mapping(rownd_id, "EXTERNAL")
    assert isinstance(mapping, GetUserIdMappingOkResult)
    provider = await providers.manually_create_or_update_user(
        "public", "google", uuid.uuid4().hex, rownd_id + "@example.com", True,
    )
    assert isinstance(provider, ManuallyCreateOrUpdateUserOkResult)
    linked = await linking.link_accounts(provider.recipe_user_id, mapping.supertokens_user_id)
    assert linked.status == "OK"

    repeated = migrate()
    assert repeated.status_code == 200, repeated.text
    migrated = await sessions.get_session_without_request_response(repeated.headers["st-access-token"])
    assert migrated is not None
    claims = migrated.get_access_token_payload()
    assert claims[SESSION_AUTHENTICATION_KEY] == "instant"
    assert claims["auth_level"] == "instant"
    assert claims["is_verified_user"] is False
    assert claims["is_anonymous"]["v"] is True
    owner = await get_user(migrated.get_recipe_user_id().get_as_string())
    assert owner is not None
    bound_method = next(
        method for method in owner.login_methods
        if method.recipe_user_id == migrated.get_recipe_user_id()
    )
    assert bound_method.third_party is not None
    assert bound_method.third_party.id == "instant"

    authenticated = await sessions.create_new_session_without_request_response(
        "public", provider.recipe_user_id, {}, {}, True,
    )
    assert authenticated.get_access_token_payload()[SESSION_AUTHENTICATION_KEY] == "authenticated"


async def test_authenticated_migration_marks_session_from_private_token_proof(core_url, rownd_client):
    client = make_client(core_url, rownd_client)
    rownd_id = "authenticated-session-" + uuid.uuid4().hex
    rownd_client.user_id = rownd_id
    rownd_client.user_info = {
        "data": {"user_id": rownd_id, "email": rownd_id + "@example.com"},
        "verified_data": {},
    }
    response = client.post(
        "/auth/plugin/rownd/migrate",
        headers={"Authorization": "Bearer rownd-token", **session_headers()},
    )
    assert response.status_code == 200, response.text
    session = await sessions.get_session_without_request_response(response.headers["st-access-token"])
    assert session is not None
    claims = session.get_access_token_payload()
    assert claims[SESSION_AUTHENTICATION_KEY] == "authenticated"
    assert claims["is_verified_user"] is True
    assert claims["is_anonymous"]["v"] is False

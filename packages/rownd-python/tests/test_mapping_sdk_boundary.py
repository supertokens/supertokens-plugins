from __future__ import annotations

import json
import uuid
from collections.abc import Awaitable, Callable

import httpx
import pytest
import supertokens_python.querier as sdk_querier
from supertokens_python.asyncio import get_user_id_mapping
from supertokens_python.interfaces import GetUserIdMappingOkResult, UnknownMappingError
from supertokens_python.recipe.session import asyncio as session_asyncio
from supertokens_python.recipe.thirdparty import asyncio as thirdparty_asyncio
from supertokens_python.recipe.thirdparty.interfaces import ManuallyCreateOrUpdateUserOkResult
from supertokens_python.recipe.usermetadata import asyncio as usermetadata_asyncio

from conftest import MockRowndClient, make_client, session_headers

pytestmark = pytest.mark.asyncio

MAPPING_PATH = "/recipe/userid/map"
SESSION_REFERENCE = "UserId is already in use in Session recipe\n"
METADATA_REFERENCE = "UserId is already in use in UserMetadata recipe\n"


@pytest.fixture
def intercept_sdk_transport(monkeypatch: pytest.MonkeyPatch):
    def install(handler: Callable[[httpx.Request], Awaitable[httpx.Response | None]]) -> None:
        async def dispatch(request: httpx.Request) -> httpx.Response:
            response = await handler(request)
            if response is not None:
                return response
            async with httpx.AsyncClient() as client:
                return await client.send(request)

        # Replace only the SDK's client construction, not SDK methods or exception decoding.
        monkeypatch.setattr(
            sdk_querier,
            "AsyncClient",
            lambda **kwargs: httpx.AsyncClient(transport=httpx.MockTransport(dispatch), **kwargs),
        )

    return install


@pytest.fixture
async def native_target(core_url: str, rownd_client: MockRowndClient):
    client = make_client(core_url, rownd_client)
    rownd_client.user_id = "sdk-mapping-%s" % uuid.uuid4()
    google_id = "google-" + rownd_client.user_id
    rownd_client.user_info = {
        "data": {"user_id": rownd_client.user_id, "google_id": google_id},
        "verified_data": {"google_id": True},
    }
    provider = await thirdparty_asyncio.manually_create_or_update_user(
        "public", "google", google_id, rownd_client.user_id + "@example.com", True,
    )
    assert isinstance(provider, ManuallyCreateOrUpdateUserOkResult)
    assert provider.created_new_recipe_user
    return client, provider, rownd_client.user_id


@pytest.mark.parametrize(
    ("method", "path", "status", "message", "reason", "retryable", "stage"),
    [
        ("POST", MAPPING_PATH, 400, SESSION_REFERENCE, "CORE_CAPABILITY_REQUIRED", False, "mapping"),
        ("POST", MAPPING_PATH, 400, METADATA_REFERENCE, "CORE_CAPABILITY_REQUIRED", False, "mapping"),
        ("GET", "/recipe/user/metadata", 400, SESSION_REFERENCE, "MIGRATION_INCOMPLETE", True, "state_inspect"),
        ("POST", MAPPING_PATH, 403, SESSION_REFERENCE, "MIGRATION_INCOMPLETE", True, "state_inspect"),
        ("POST", MAPPING_PATH, 400, "Invalid user ID", "MIGRATION_INCOMPLETE", True, "state_inspect"),
        ("POST", MAPPING_PATH, 500, SESSION_REFERENCE, "CORE_UNAVAILABLE", True, "state_inspect"),
        ("GET", "/recipe/user/metadata", 503, "private diagnostic", "CORE_UNAVAILABLE", True, "state_inspect"),
    ],
    ids=["session", "metadata", "wrong-endpoint", "wrong-status", "unrelated-400", "core-500", "read-503"],
)
async def test_sdk_http_errors_preserve_narrow_mapping_failure_contract(
    native_target, intercept_sdk_transport, method, path, status, message, reason, retryable, stage,
) -> None:
    client, provider, rownd_user_id = native_target
    target_id = provider.user.id
    metadata = {"native_preference": "retained"}
    if message == METADATA_REFERENCE:
        await usermetadata_asyncio.update_user_metadata(target_id, metadata)
    else:
        await session_asyncio.create_new_session_without_request_response(
            "public", provider.recipe_user_id, {}, {"native": True}, True,
        )
    original_handles = await session_asyncio.get_all_session_handles_for_user(target_id)
    intercepted = []

    async def handler(request: httpx.Request) -> httpx.Response | None:
        if request.method == method and request.url.path == path:
            intercepted.append(request)
            return httpx.Response(status, text=message)
        return None

    intercept_sdk_transport(handler)
    response = client.post(
        "/auth/plugin/rownd/migrate",
        headers={"Authorization": "Bearer rownd-token", **session_headers()},
    )

    assert intercepted, "The SDK must reach the intended HTTP boundary"
    for request in intercepted:
        if request.method == "POST":
            assert json.loads(request.content).get("force", False) is False
    # Stop fault injection before inspecting durable state through the same real SDK.
    intercept_sdk_transport(no_fault)
    assert isinstance(await get_user_id_mapping(target_id, "SUPERTOKENS"), UnknownMappingError)
    assert isinstance(await get_user_id_mapping(rownd_user_id, "EXTERNAL"), UnknownMappingError)
    assert set(await session_asyncio.get_all_session_handles_for_user(target_id)) == set(original_handles)
    assert await session_asyncio.get_all_session_handles_for_user(rownd_user_id) == []
    if message == METADATA_REFERENCE:
        assert (await usermetadata_asyncio.get_user_metadata(target_id)).metadata == metadata
    for handle in original_handles:
        preserved = await session_asyncio.get_session_information(handle)
        assert preserved is not None
        assert preserved.user_id == target_id
        assert preserved.session_data_in_database == {"native": True}
    for header in ("st-access-token", "st-refresh-token", "front-token", "set-cookie"):
        assert header not in response.headers
    assert response.status_code == 503, response.text
    body = response.json()
    assert (body["status"], body["reason"], body["retryable"], body["stage"]) == (
        "ERROR", reason, retryable, stage,
    ), body


async def no_fault(request: httpx.Request) -> None:
    return None


@pytest.mark.parametrize("failure", ["reference-400", "core-500", "duplicate-response"])
async def test_exact_mapping_postcondition_recovers_despite_sdk_error(
    native_target, intercept_sdk_transport, failure: str,
) -> None:
    client, provider, rownd_user_id = native_target
    mapping_responses = []

    async def handler(request: httpx.Request) -> httpx.Response | None:
        if request.method != "POST" or request.url.path != MAPPING_PATH:
            return None
        assert json.loads(request.content).get("force", False) is False
        async with httpx.AsyncClient() as core:
            committed = await core.send(request)
            assert committed.status_code == 200, committed.text
            assert committed.json()["status"] == "OK", committed.text
            if failure == "duplicate-response":
                duplicate = await core.send(request)
                mapping_responses.append(duplicate)
                return duplicate
        response = httpx.Response(
            500 if failure == "core-500" else 400, text=SESSION_REFERENCE,
        )
        mapping_responses.append(response)
        return response

    intercept_sdk_transport(handler)
    response = client.post(
        "/auth/plugin/rownd/migrate",
        headers={"Authorization": "Bearer rownd-token", **session_headers()},
    )

    assert len(mapping_responses) == 1
    if failure == "duplicate-response":
        duplicate_body = mapping_responses[0].json()
        assert duplicate_body["status"] == "USER_ID_MAPPING_ALREADY_EXISTS_ERROR"
        assert duplicate_body["doesExternalUserIdExist"] is True
        assert "does_external_user_id_exist" not in duplicate_body
    assert response.status_code == 200, response.text
    assert response.json() == {"status": "OK"}
    mapping = await get_user_id_mapping(rownd_user_id, "EXTERNAL")
    assert isinstance(mapping, GetUserIdMappingOkResult)
    assert mapping.supertokens_user_id == provider.user.id
    session = await session_asyncio.get_session_without_request_response(
        response.headers["st-access-token"],
    )
    assert session is not None
    assert session.get_user_id() == rownd_user_id
    assert session.get_recipe_user_id().get_as_string() == rownd_user_id


async def test_conflicting_mapping_postcondition_blocks_after_real_duplicate_response(
    native_target, intercept_sdk_transport,
) -> None:
    client, provider, rownd_user_id = native_target
    conflicting_id = "other-" + rownd_user_id
    duplicate_responses = []

    async def handler(request: httpx.Request) -> httpx.Response | None:
        if request.method != "POST" or request.url.path != MAPPING_PATH:
            return None
        payload = json.loads(request.content)
        assert payload.get("force", False) is False
        async with httpx.AsyncClient() as core:
            committed = await core.post(
                request.url,
                headers={key: value for key, value in request.headers.items() if key != "content-length"},
                json={**payload, "externalUserId": conflicting_id},
            )
            assert committed.status_code == 200, committed.text
            assert committed.json()["status"] == "OK", committed.text
            duplicate = await core.send(request)
            duplicate_responses.append(duplicate)
            return duplicate

    intercept_sdk_transport(handler)
    response = client.post(
        "/auth/plugin/rownd/migrate",
        headers={"Authorization": "Bearer rownd-token", **session_headers()},
    )

    assert len(duplicate_responses) == 1
    duplicate_body = duplicate_responses[0].json()
    assert duplicate_body["status"] == "USER_ID_MAPPING_ALREADY_EXISTS_ERROR"
    assert duplicate_body["doesSuperTokensUserIdExist"] is True
    assert duplicate_body["doesExternalUserIdExist"] is False
    assert "does_external_user_id_exist" not in duplicate_body
    mapping = await get_user_id_mapping(provider.user.id, "SUPERTOKENS")
    assert isinstance(mapping, GetUserIdMappingOkResult)
    assert mapping.external_user_id == conflicting_id
    assert isinstance(await get_user_id_mapping(rownd_user_id, "EXTERNAL"), UnknownMappingError)
    for user_id in (provider.user.id, conflicting_id, rownd_user_id):
        assert await session_asyncio.get_all_session_handles_for_user(user_id) == []
    for header in ("st-access-token", "st-refresh-token", "front-token", "set-cookie"):
        assert header not in response.headers
    assert response.status_code == 422, response.text
    body = response.json()
    # Final source inspection sees the provider as owned by the competing Rownd identity.
    assert (body["reason"], body["retryable"], body["stage"]) == (
        "IDENTITY_OWNED_BY_ANOTHER_USER", False, "state_inspect",
    ), body

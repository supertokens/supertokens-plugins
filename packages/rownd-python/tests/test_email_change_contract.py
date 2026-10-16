from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any, cast
from unittest.mock import AsyncMock

import pytest

from supertokens_rownd import config as configs
from supertokens_rownd import plugin, plugin_implementation as impl
from supertokens_rownd import rownd_compatibility as compatibility
from supertokens_rownd import supertokens_repository as repository
from supertokens_rownd.types import RowndPluginConfig
from supertokens_rownd.session_authentication import (
    is_verified_email_change_destination,
    verified_email_change_destination,
)


def config(**kwargs: Any) -> RowndPluginConfig:
    return RowndPluginConfig(
        rownd_app_key="test",
        rownd_app_secret="test",
        app_config={"signInMethods": [{"method": "email"}]},
        **kwargs,
    )


class Request:
    def __init__(self, body: dict[str, Any], query: dict[str, str]):
        self.body = body
        self.query = query

    async def json(self):
        return self.body

    def get_query_param(self, key: str):
        return self.query.get(key)


class Response:
    status_code = 0
    body: dict[str, Any]

    def set_status_code(self, code: int):
        self.status_code = code

    def set_json_content(self, body: dict[str, Any]):
        self.body = body


@pytest.mark.parametrize("value", [0, -1, True, False, "600", float("nan"), float("inf")])
def test_invalid_freshness(value: Any):
    with pytest.raises(ValueError, match="max_session_age_seconds"):
        plugin._validate_config(config(email_change={"max_session_age_seconds": value}))


async def test_dynamic_nullable_policy_is_isolated_and_inherits():
    async def resolve(context: dict[str, Any]):
        await asyncio.sleep(0)
        return (
            {"email_change": {"max_session_age_seconds": None}}
            if context["tenant_id"] == "legacy"
            else {"email_change": {}}
        )

    base = config(email_change={"max_session_age_seconds": 123}, resolve_config=resolve)
    legacy, modern = await asyncio.gather(
        *[
            configs.resolve_plugin_config_snapshot(base, tenant, None, {})
            for tenant in ["legacy", "modern"]
        ]
    )
    assert legacy.email_change.get("max_session_age_seconds") is None
    assert modern.email_change.get("max_session_age_seconds") == 123
    assert base.email_change == {"max_session_age_seconds": 123}
    default = config(email_change={})
    plugin._validate_config(default)
    assert default.email_change == {"max_session_age_seconds": 600, "retirement_mode": "enforce"}


@pytest.mark.parametrize("field_route", [False, True])
@pytest.mark.parametrize(
    "context,query",
    [
        ({"rowndExpectedUserId": None}, {}),
        ({"rowndExpectedUserId": "unknown"}, {}),
        ({"rowndExpectedUserId": "foreign"}, {}),
        ({"rowndExpectedTenantId": "tenant"}, {}),
        ({"rowndExpectedUserId": "external", "rowndExpectedTenantId": None}, {}),
        ({"rowndExpectedUserId": "external", "rowndExpectedTenantId": "public"}, {}),
        ({}, {"tenantId": "public"}),
        ({}, {"tenantId": ""}),
    ],
)
async def test_owner_fence_precedes_config_and_mutation(monkeypatch, field_route, context, query):
    resolver = AsyncMock(side_effect=AssertionError("must not resolve config"))
    writes = AsyncMock(side_effect=AssertionError("must not mutate"))
    owners = {"external": "internal", "foreign": "different"}
    monkeypatch.setattr(
        repository,
        "get_internal_primary_user_id",
        AsyncMock(side_effect=lambda uid, _: owners.get(uid)),
    )
    monkeypatch.setattr(repository, "update_user_data", writes)
    monkeypatch.setattr(repository, "start_pending_email_verification", writes)
    session = SimpleNamespace(get_user_id=lambda _: "external", get_tenant_id=lambda _: "tenant")
    request = Request(
        {
            "context": context,
            "data": {"email": "b@test.com", "first_name": "New"},
            "value": "b@test.com",
        },
        {"field": "email", **query},
    )
    response = Response()
    handler = impl.handle_update_user_field if field_route else impl.handle_update_user
    await handler(
        config(resolve_config=resolver),
        cast(Any, request),
        cast(Any, response),
        cast(Any, session),
        {},
    )
    assert response.status_code == 409
    assert response.body["error_code"] == "EMAIL_CHANGE_ACCOUNT_MISMATCH"
    resolver.assert_not_called()
    writes.assert_not_called()


@pytest.mark.parametrize("field_route", [False, True])
@pytest.mark.parametrize(
    "age,policy,expected", [(601, 600, 403), (600, 600, 200), (601, None, 200)]
)
async def test_freshness_contract_before_any_write(monkeypatch, field_route, age, policy, expected):
    monkeypatch.setattr(impl.time, "time", lambda: 1000)
    monkeypatch.setattr(impl, "is_recipe_initialized", lambda _: True)
    monkeypatch.setattr(impl, "_get_current_email", AsyncMock(return_value="a@test.com"))
    pending = AsyncMock(return_value={"data": {"email": "a@test.com"}})
    update = AsyncMock(return_value={"data": {"email": "a@test.com"}})
    monkeypatch.setattr(repository, "start_pending_email_verification", pending)
    monkeypatch.setattr(repository, "update_user_data", update)
    session = SimpleNamespace(
        get_user_id=lambda _: "owner",
        get_tenant_id=lambda _: "public",
        get_time_created=AsyncMock(return_value=(1000 - age) * 1000),
    )
    response = Response()
    handler = impl.handle_update_user_field if field_route else impl.handle_update_user
    request = Request(
        {"data": {"email": "b@test.com", "first_name": "New"}, "value": "b@test.com"},
        {"field": "email"},
    )
    await handler(
        config(email_change={"max_session_age_seconds": policy}),
        cast(Any, request),
        cast(Any, response),
        cast(Any, session),
        {},
    )
    assert response.status_code == expected
    if expected == 403:
        assert response.body["error_code"] == "EMAIL_CHANGE_REAUTHENTICATION_REQUIRED"
        pending.assert_not_called()
        update.assert_not_called()
    else:
        assert response.body["email_verification_pending"] is True
        pending.assert_awaited_once()


@pytest.mark.parametrize("field_route", [False, True])
@pytest.mark.parametrize("restriction", [{"read_only": True}, {"owned_by": "app"}])
async def test_explicit_email_permission_prevents_all_writes(monkeypatch, field_route, restriction):
    write = AsyncMock(side_effect=AssertionError("must not mutate"))
    monkeypatch.setattr(repository, "start_pending_email_verification", write)
    monkeypatch.setattr(repository, "update_user_data", write)
    response = Response()
    request = Request({"data": {"email": "b@test.com"}, "value": "b@test.com"}, {"field": "email"})
    session = SimpleNamespace(get_tenant_id=lambda _: "public")
    handler = impl.handle_update_user_field if field_route else impl.handle_update_user
    await handler(
        config(schema={"email": restriction}),
        cast(Any, request),
        cast(Any, response),
        cast(Any, session),
        {},
    )
    assert response.status_code == 403
    write.assert_not_called()
    assert compatibility.validate_writable_fields(config(schema={}), ["email"]) is None


def test_profile_authority_prevents_linked_and_snapshot_resurrection():
    primary = {
        "original_rownd_user": {"data": {"first_name": "Old", "preferences": {"removed": True}}},
        "rownd_profile_authoritative_fields": ["first_name", "preferences"],
        "preferences": {"kept": True},
    }
    combined = repository.combine_linked_metadata(
        "owner", primary, [("linked", {"first_name": "Linked", "preferences": {"removed": True}})]
    )["combined_metadata"]
    combined = configs.as_json_dict(combined)
    assert compatibility.get_rownd_profile_data(combined) == {"preferences": {"kept": True}}
    claims = compatibility.build_configured_session_claims(
        config(
            schema={
                "first_name": {"include_in_session_claims": True},
                "preferences": {"include_in_session_claims": True},
                "rownd_profile_authoritative_fields": {"include_in_session_claims": True},
            }
        ),
        combined,
    )
    assert claims == {"preferences": {"kept": True}}


@pytest.mark.parametrize(
    "primary",
    [
        {"rownd_email_metadata_version": 1},
        {"rownd_email_recipe_user_ids": {}},
        {"rownd_email_recipe_user_id": "primary-wins"},
    ],
)
def test_primary_email_authority_blocks_alias_fallback(primary):
    user = SimpleNamespace(login_methods=[])
    assert (
        repository.get_mapped_email_pointer_fallback(
            primary, {"rownd_email_recipe_user_ids": {"public": "alias"}}, cast(Any, user)
        )
        == {}
    )


def test_alias_email_pointer_is_bounded_by_actual_tenant_membership():
    user = SimpleNamespace(
        login_methods=[
            SimpleNamespace(
                recipe_user_id=SimpleNamespace(get_as_string=lambda: "linked"),
                email="b@example.com",
                tenant_ids=["public"],
            )
        ]
    )
    assert repository.get_mapped_email_pointer_fallback(
        {},
        {
            "rownd_email_recipe_user_ids": {
                "public": "linked",
                "foreign": "linked",
                "missing": "unknown",
            },
            "rownd_email_recipe_user_id": "ignored",
        },
        cast(Any, user),
    ) == {"rownd_email_recipe_user_ids": {"public": "linked"}}


async def test_owner_hints_require_existing_primary_even_when_ids_equal(monkeypatch):
    monkeypatch.setattr(repository, "get_user", AsyncMock(return_value=None))
    mapping = AsyncMock(side_effect=AssertionError("nonexistent user must not establish ownership"))
    monkeypatch.setattr(repository, "get_primary_user_mapping", mapping)
    assert await repository.get_internal_primary_user_id("deleted", {}) is None
    mapping.assert_not_called()


async def test_unchanged_normalized_email_skips_freshness(monkeypatch):
    monkeypatch.setattr(impl, "_get_current_email", AsyncMock(return_value="a@example.com"))
    session = SimpleNamespace(get_time_created=AsyncMock(side_effect=AssertionError("age lookup")))
    assert await impl._validate_email_change(
        config(), cast(Any, session), " A@EXAMPLE.COM ", None, {}, {}
    ) == (False, None)
    session.get_time_created.assert_not_called()


async def test_verified_destination_scope_is_exact_and_task_local():
    async def prepare_target():
        with verified_email_change_destination("tenant", "B@example.com"):
            await asyncio.sleep(0)
            assert is_verified_email_change_destination("tenant", "b@example.com")
            assert not is_verified_email_change_destination("public", "b@example.com")
            assert not is_verified_email_change_destination("tenant", "a@example.com")
        assert not is_verified_email_change_destination("tenant", "b@example.com")

    async def unrelated_request():
        await asyncio.sleep(0)
        assert not is_verified_email_change_destination("tenant", "b@example.com")

    await asyncio.gather(prepare_target(), unrelated_request())

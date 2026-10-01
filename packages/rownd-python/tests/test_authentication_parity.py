import asyncio
import json
from types import SimpleNamespace
from typing import Any, cast
from unittest.mock import AsyncMock, Mock

import pytest
from supertokens_python.types import RecipeUserId

from supertokens_rownd import config, plugin, plugin_implementation
from supertokens_rownd import supertokens_repository as repository
from supertokens_rownd import session_authentication
from supertokens_rownd.constants import ROWND_JWT_CLAIMS
from supertokens_rownd.errors import RowndPluginError
from supertokens_rownd.rownd_compatibility import (
    build_rownd_session_claim_payload,
    is_internal_metadata_field,
    validate_writable_fields,
)
from supertokens_rownd.session_authentication import (
    SESSION_AUTHENTICATION_KEY,
    ambiguous_owner_session_aliases,
    proven_session_authentication,
    session_authentication_origin,
)
from supertokens_rownd.types import JsonDict, RowndPluginConfig


def method(recipe_id="passwordless", identifier="email", email="real@example.com", provider=None):
    return SimpleNamespace(
        recipe_id=recipe_id,
        recipe_user_id=RecipeUserId(identifier),
        email=email,
        third_party=SimpleNamespace(id=provider, user_id="original-alias") if provider else None,
        verified=True,
        tenant_ids=["public"],
        phone_number=None,
        time_joined=1,
    )


@pytest.fixture
def linked_user(monkeypatch):
    user = SimpleNamespace(
        id="owner",
        login_methods=[
            method("thirdparty", "instant", "anon@anonymous.local", "instant"),
            method(),
        ],
    )

    async def immutable(value, context):
        return {"external-instant": "instant"}.get(value, value)

    monkeypatch.setattr(repository, "freshly_resolve_sdk_user_id_to_internal", immutable)
    monkeypatch.setattr(repository, "get_raw_user_metadata", AsyncMock(return_value={}))
    monkeypatch.setattr(
        repository,
        "inspect_linked_user_metadata",
        AsyncMock(
            return_value={
                "user": user,
                "combined_metadata": {},
            }
        ),
    )
    return user


async def test_instant_creation_ignores_forged_context_and_payload_proofs(linked_user, monkeypatch):
    from supertokens_rownd import provider_session

    monkeypatch.setattr(plugin, "_assert_native_session_publication", AsyncMock())
    monkeypatch.setattr(provider_session, "assert_provider_session_membership", AsyncMock())
    create = AsyncMock()
    original = SimpleNamespace(create_new_session=create, refresh_session=AsyncMock())
    overridden = plugin._session_function_override(RowndPluginConfig())(cast(Any, original))
    await overridden.create_new_session(
        "owner",
        RecipeUserId("external-instant"),
        {SESSION_AUTHENTICATION_KEY: "authenticated", "auth_level": "verified"},
        {},
        False,
        "public",
        {"rowndProvenSessionAuthentication": True, "provenAuthentication": True},
    )
    assert create.await_args is not None
    claims = create.await_args.args[2]
    assert claims[SESSION_AUTHENTICATION_KEY] == "instant"
    assert claims["is_verified_user"] is False
    assert claims["is_anonymous"]["v"] is True


@pytest.mark.parametrize("payload", [{}, {"auth_level": "verified"}, {"auth_level": "instant"}])
async def test_instant_binding_remains_anonymous_after_linking(linked_user, payload):
    rownd, anonymous = await repository.build_rownd_session_and_anonymous_claims(
        RowndPluginConfig(),
        "owner",
        payload,
        None,
        {},
        "external-instant",
    )
    assert rownd["auth_level"] == "instant"
    assert rownd[SESSION_AUTHENTICATION_KEY] == "instant"
    assert rownd["is_verified_user"] is False
    assert rownd[ROWND_JWT_CLAIMS["is_verified_user"]] is False
    assert cast(dict, anonymous["is_anonymous"])["v"] is True


async def test_credential_success_upgrades_and_refresh_preserves_proof(linked_user):
    session = SimpleNamespace(
        get_access_token_payload=lambda context: {
            "auth_level": "instant",
            SESSION_AUTHENTICATION_KEY: "instant",
            ROWND_JWT_CLAIMS["is_anonymous"]: True,
        },
        get_recipe_user_id=lambda context: RecipeUserId("instant"),
        merge_into_access_token_payload=AsyncMock(),
    )
    await plugin.refresh_rownd_session_claims(
        RowndPluginConfig(), cast(Any, session), "owner", None, {}, True
    )
    upgraded = session.merge_into_access_token_payload.await_args.args[0]
    assert upgraded["auth_level"] == "verified"
    assert upgraded[SESSION_AUTHENTICATION_KEY] == "authenticated"
    assert upgraded["is_anonymous"]["v"] is False
    assert upgraded[ROWND_JWT_CLAIMS["is_anonymous"]] is None
    assert (
        await session_authentication_origin(linked_user, "instant", upgraded, {}) == "authenticated"
    )
    assert await session_authentication_origin(linked_user, "instant", {}, {}, True) == "instant"


async def test_private_proof_is_task_local_and_reset_on_error(linked_user):
    entered = asyncio.Event()
    release = asyncio.Event()

    async def successful_credential():
        with proven_session_authentication():
            entered.set()
            await release.wait()
            assert (
                await session_authentication_origin(linked_user, "instant", {}, {}, True)
                == "authenticated"
            )
            raise ValueError("after credentials")

    task = asyncio.create_task(successful_credential())
    await entered.wait()
    assert await session_authentication_origin(linked_user, "instant", {}, {}, True) == "instant"
    release.set()
    with pytest.raises(ValueError):
        await task
    assert await session_authentication_origin(linked_user, "instant", {}, {}, True) == "instant"


@pytest.mark.parametrize("checkpoint", [[], False, "authenticated"])
async def test_malformed_owner_checkpoint_cannot_attest_authentication(
    linked_user,
    monkeypatch,
    checkpoint,
):
    monkeypatch.setattr(
        repository,
        "get_raw_user_metadata",
        AsyncMock(
            return_value={
                "rownd_migration_owner_consolidation": checkpoint,
            }
        ),
    )
    with pytest.raises(Exception, match="Invalid owner consolidation checkpoint"):
        await session_authentication_origin(linked_user, "email", {"auth_level": "verified"}, {})


def owner_plan():
    return {
        "version": 2,
        "target": "instant",
        "status": "COMPLETE",
        "recipes": [
            {
                "id": "instant",
                "identity": json.dumps(
                    [
                        "thirdparty",
                        None,
                        None,
                        {"id": "instant", "userId": "original-alias"},
                        ["public"],
                    ]
                ),
            }
        ],
        "aliases": [{"id": "original-alias", "to": "email"}],
        "retiredAliases": [{"id": "retired", "from": "email"}],
        "legacySessionAliasHistory": {"aliases": ["earlier-alias"]},
    }


async def test_moved_unmarked_alias_requires_fresh_authentication(linked_user, monkeypatch):
    plan = owner_plan()
    assert ambiguous_owner_session_aliases(cast(JsonDict, plan)) == {
        "original-alias",
        "retired",
        "earlier-alias",
    }
    monkeypatch.setattr(
        repository,
        "get_raw_user_metadata",
        AsyncMock(
            return_value={
                "rownd_migration_owner_consolidation": plan,
            }
        ),
    )

    async def immutable(value, context):
        return "email" if value == "original-alias" else value

    monkeypatch.setattr(repository, "freshly_resolve_sdk_user_id_to_internal", immutable)
    monkeypatch.setattr(session_authentication, "_owner_plan_reader", Mock(return_value=plan))
    monkeypatch.setattr(session_authentication, "_owner_plan_validator", None)
    with pytest.raises(Exception, match="validation is unavailable"):
        await session_authentication_origin(linked_user, "original-alias", {}, {})
    validator = AsyncMock()
    monkeypatch.setattr(session_authentication, "_owner_plan_validator", validator)
    assert (
        await session_authentication_origin(
            linked_user, "original-alias", {"auth_level": "verified"}, {}
        )
        == "instant"
    )
    validator.assert_awaited_once_with(plan, {})
    assert (
        await session_authentication_origin(
            linked_user, "earlier-alias", {"auth_level": "verified"}, {}
        )
        == "instant"
    )
    validator.side_effect = ValueError("owner graph changed")
    with pytest.raises(ValueError, match="owner graph changed"):
        await session_authentication_origin(linked_user, "original-alias", {}, {})
    assert (
        await session_authentication_origin(linked_user, "original-alias", {}, {}, True)
        == "authenticated"
    )
    plan["status"] = "APPLYING"
    with pytest.raises(Exception, match="incomplete"):
        await session_authentication_origin(linked_user, "original-alias", {}, {})


@pytest.mark.parametrize(
    "field,value,remove",
    [
        ("recipes", None, True),
        ("recipes", [], False),
        ("recipes", {}, False),
        ("recipes", [{"id": "another", "identity": "broken"}], False),
        ("recipes", [{"id": "instant", "identity": "broken"}], False),
        ("recipes", [{"id": "instant", "identity": "[]"}], False),
        ("target", None, True),
        ("target", "missing", False),
        ("target", [], False),
        ("aliases", None, True),
        ("aliases", [], False),
        ("aliases", {}, False),
        ("legacySessionAliasHistory", None, True),
        ("legacySessionAliasHistory", {}, False),
        ("legacySessionAliasHistory", {"aliases": []}, False),
        ("legacySessionAliasHistory", {"aliases": "earlier-alias"}, False),
        ("version", True, False),
    ],
)
async def test_corrupt_checkpoint_is_read_before_alias_authentication(
    linked_user,
    monkeypatch,
    field,
    value,
    remove,
):
    plan = owner_plan()
    if remove:
        del plan[field]
    else:
        plan[field] = value
    metadata = {"rownd_migration_owner_consolidation": plan}
    monkeypatch.setattr(repository, "get_raw_user_metadata", AsyncMock(return_value=metadata))
    linked_user.login_methods[1] = method("thirdparty", "email", provider="google")

    async def immutable(value, context):
        return "email" if value == "original-alias" else value

    monkeypatch.setattr(repository, "freshly_resolve_sdk_user_id_to_internal", immutable)
    reader = Mock(side_effect=RowndPluginError("Invalid owner consolidation checkpoint"))
    validator = AsyncMock(side_effect=RowndPluginError("Invalid completed checkpoint"))
    monkeypatch.setattr(session_authentication, "_owner_plan_reader", None)
    monkeypatch.setattr(session_authentication, "_owner_plan_validator", None)
    session_authentication.register_owner_plan_reader(reader)
    session_authentication.register_owner_plan_validator(validator)
    with pytest.raises(RowndPluginError, match="Invalid owner consolidation checkpoint"):
        await session_authentication_origin(
            linked_user, "original-alias", {"auth_level": "verified"}, {}
        )
    if field == "version":
        reader.assert_not_called()
    else:
        reader.assert_called_once_with(metadata)
    validator.assert_not_awaited()


@pytest.mark.parametrize("reader", [None, Mock(return_value=None)])
async def test_present_checkpoint_requires_authoritative_reader(linked_user, monkeypatch, reader):
    plan = owner_plan()
    plan["recipes"] = []
    monkeypatch.setattr(
        repository,
        "get_raw_user_metadata",
        AsyncMock(
            return_value={
                "rownd_migration_owner_consolidation": plan,
            }
        ),
    )
    monkeypatch.setattr(session_authentication, "_owner_plan_reader", reader)
    validator = AsyncMock(side_effect=RowndPluginError("Invalid completed checkpoint"))
    monkeypatch.setattr(session_authentication, "_owner_plan_validator", validator)
    with pytest.raises(RowndPluginError):
        await session_authentication_origin(linked_user, "email", {"auth_level": "verified"}, {})
    validator.assert_not_awaited()


async def test_structurally_valid_unambiguous_binding_requires_fresh_completed_validation(
    linked_user,
    monkeypatch,
):
    plan = owner_plan()
    metadata = {"rownd_migration_owner_consolidation": plan}
    monkeypatch.setattr(repository, "get_raw_user_metadata", AsyncMock(return_value=metadata))
    reader = Mock(return_value=plan)
    validator = AsyncMock(side_effect=RowndPluginError("Completed owner graph changed"))
    monkeypatch.setattr(session_authentication, "_owner_plan_reader", reader)
    monkeypatch.setattr(session_authentication, "_owner_plan_validator", validator)
    with pytest.raises(RowndPluginError, match="Completed owner graph changed"):
        await session_authentication_origin(linked_user, "email", {}, {})
    reader.assert_called_once_with(metadata)
    validator.assert_awaited_once_with(plan, {})


@pytest.mark.parametrize(
    "creating,origin,expected",
    [
        (True, None, "authenticated"),
        (False, "authenticated", "authenticated"),
        (False, "instant", "instant"),
    ],
)
async def test_creation_and_signed_provenance_do_not_read_checkpoints(
    linked_user,
    monkeypatch,
    creating,
    origin,
    expected,
):
    metadata = AsyncMock(side_effect=AssertionError("must not read checkpoints"))
    reader = Mock(side_effect=AssertionError("must not parse checkpoints"))
    monkeypatch.setattr(repository, "get_raw_user_metadata", metadata)
    monkeypatch.setattr(session_authentication, "_owner_plan_reader", reader)
    payload = {SESSION_AUTHENTICATION_KEY: origin} if origin else {}
    assert (
        await session_authentication_origin(linked_user, "email", payload, {}, creating) == expected
    )
    metadata.assert_not_awaited()
    reader.assert_not_called()


def test_historical_display_preference_allows_attached_alias_but_explicit_pointer_retires_it():
    user = cast(
        Any,
        SimpleNamespace(
            id="owner",
            login_methods=[
                method(identifier="relay", email="relay@privaterelay.appleid.com"),
                method(),
                method(identifier="fake", email="synthetic@stfakeemail.supertokens.com"),
            ],
        ),
    )
    metadata: JsonDict = {
        "original_rownd_user": {"data": {"email": "relay@privaterelay.appleid.com"}}
    }
    assert repository.classify_email_credential(
        user, metadata, "public", "real@example.com", "email"
    ).allowed
    assert not repository.classify_email_credential(
        user, metadata, "public", "real@example.com", "relay"
    ).allowed
    assert not repository.classify_email_credential(
        user, metadata, "other", "real@example.com", "email"
    ).allowed
    metadata["rownd_email_recipe_user_id"] = "relay"
    assert not repository.classify_email_credential(
        user, metadata, "public", "real@example.com", "email"
    ).allowed


@pytest.mark.parametrize("auth_level", ["guest", "instant"])
@pytest.mark.parametrize("enabled", [False, True])
async def test_guest_route_uses_tenant_snapshot_and_subbrand_override(
    monkeypatch, auth_level, enabled
):
    resolver = AsyncMock(
        return_value={
            "app_config": {"signInMethods": [{"method": "anonymous", "type": auth_level}]},
            "sub_brands": {
                "brand": {
                    "signInMethods": [{"method": "anonymous", "type": auth_level}]
                    if enabled
                    else []
                }
            },
        }
    )
    settings = RowndPluginConfig(resolve_config=resolver)
    request = SimpleNamespace(
        json=AsyncMock(return_value={"auth_level": auth_level}),
        get_query_param=lambda key: {"tenantId": "tenant-b", "app_variant_id": "brand"}.get(key),
    )
    response = SimpleNamespace(set_status_code=Mock(), set_json_content=Mock())

    async def create_session(resolved, *args):
        assert config.get_request_config(settings) is resolved
        assert args[1] == "tenant-b"
        return SimpleNamespace(user=SimpleNamespace(id="new"), created_new_recipe_user=True)

    create = AsyncMock(side_effect=create_session)
    monkeypatch.setattr(repository, "create_guest_session", create)
    await plugin_implementation.handle_guest_login(
        settings,
        cast(Any, SimpleNamespace(record_event=AsyncMock())),
        cast(Any, request),
        cast(Any, response),
        {},
    )
    assert resolver.await_args is not None
    assert resolver.await_args.args[0]["tenant_id"] == "tenant-b"
    assert create.await_count == int(enabled)
    assert response.set_json_content.call_args.args[0]["status"] == ("OK" if enabled else "ERROR")
    assert config.get_request_config(settings) is settings


@pytest.mark.parametrize("level", ["guest", "instant"])
def test_anonymous_sign_in_is_disabled_by_default_and_type_specific(level):
    settings = RowndPluginConfig()
    assert not config.is_anonymous_sign_in_enabled(settings, level)
    settings.app_config = {"signInMethods": [{"method": "anonymous", "type": level}]}
    assert config.is_anonymous_sign_in_enabled(settings, level)
    assert not config.is_anonymous_sign_in_enabled(
        settings, "instant" if level == "guest" else "guest"
    )


def test_provenance_is_reserved_from_profile_and_configured_claims(linked_user):
    settings = RowndPluginConfig(
        schema={
            SESSION_AUTHENTICATION_KEY: {"include_in_session_claims": True},
            "custom": {
                "include_in_session_claims": True,
                "session_claim_name": SESSION_AUTHENTICATION_KEY,
            },
        }
    )
    assert is_internal_metadata_field(SESSION_AUTHENTICATION_KEY)
    assert validate_writable_fields(settings, [SESSION_AUTHENTICATION_KEY]) is not None
    claims = build_rownd_session_claim_payload(
        settings,
        "owner",
        linked_user,
        {
            SESSION_AUTHENTICATION_KEY: "authenticated",
            "custom": "authenticated",
        },
        {},
        None,
    )
    assert SESSION_AUTHENTICATION_KEY not in claims


@pytest.mark.parametrize("status", ["GENERAL_ERROR", "OK"])
@pytest.mark.parametrize("provider", ["google", "instant", "guest"])
async def test_only_successful_real_provider_attests_authentication(monkeypatch, status, provider):
    original = SimpleNamespace(
        sign_in_up_post=AsyncMock(
            return_value=SimpleNamespace(
                status=status,
                user=SimpleNamespace(id="owner"),
                session=SimpleNamespace(),
            )
        )
    )
    record = AsyncMock()
    refresh = AsyncMock()
    monkeypatch.setattr(plugin, "record_rownd_app_variant_for_user", record)
    monkeypatch.setattr(plugin, "_refresh_rownd_session_claims_or_revoke", refresh)
    api = plugin._thirdparty_api_override(RowndPluginConfig())(cast(Any, original))
    await api.sign_in_up_post(
        cast(Any, SimpleNamespace(id=provider)),
        None,
        None,
        None,
        None,
        "public",
        cast(
            Any,
            SimpleNamespace(
                request=SimpleNamespace(get_query_param=lambda key: None),
            ),
        ),
        {"provenAuthentication": True},
    )
    if status == "OK":
        assert refresh.await_args is not None
        assert refresh.await_args.args[-1] is (provider == "google")
    else:
        refresh.assert_not_awaited()


async def test_tenant_resolution_failure_cannot_create_guest(monkeypatch):
    resolver = AsyncMock(side_effect=ValueError("tenant config unavailable"))
    create = AsyncMock()
    monkeypatch.setattr(repository, "create_guest_session", create)
    response = SimpleNamespace(set_status_code=Mock(), set_json_content=Mock())
    await plugin_implementation.handle_guest_login(
        RowndPluginConfig(resolve_config=resolver),
        cast(Any, SimpleNamespace(record_event=AsyncMock())),
        cast(Any, SimpleNamespace(get_query_param=lambda key: "tenant-b")),
        cast(Any, response),
        {},
    )
    create.assert_not_awaited()
    assert response.set_json_content.call_args.args[0]["status"] == "ERROR"

from __future__ import annotations

import time
from types import SimpleNamespace
from typing import Any
from urllib.parse import parse_qs, urlparse
from uuid import uuid4

import pytest
from supertokens_python.asyncio import get_user, get_user_id_mapping
from supertokens_python.recipe.passwordless import asyncio as passwordless
from supertokens_python.recipe.accountlinking import asyncio as linking
from supertokens_python.recipe.multitenancy import asyncio as tenants
from supertokens_python.recipe.session import asyncio as sessions
from supertokens_python.recipe.session import SessionRecipe
from supertokens_python.recipe.session.claims import BooleanClaim
from supertokens_python.recipe.thirdparty import asyncio as thirdparty
from supertokens_python.recipe.thirdparty.interfaces import ManuallyCreateOrUpdateUserOkResult
from supertokens_python.recipe.thirdparty.types import UserInfo, UserInfoEmail
from supertokens_python.recipe.usermetadata import asyncio as metadata
from supertokens_python.utils import resolve

from conftest import PersistentCore, auth_headers, make_client, reset_st, session_headers
from supertokens_rownd import plugin_implementation as impl
from supertokens_rownd import rownd_compatibility as compatibility
from supertokens_rownd import supertokens_repository as repository
from supertokens_rownd.errors import RowndEmailChangeError, RowndPluginError
from supertokens_rownd.plugin import create_magic_link_with_confirmation_bypass


def passwordless_login(client, email: str, links: list[str]):
    response = client.post(
        "/auth/signinup/code",
        headers={**session_headers(), "rid": "passwordless"},
        json={"email": email},
    )
    assert response.json()["status"] == "OK", response.text
    link = urlparse(links[-1])
    return client.post(
        "/auth/signinup/code/consume",
        headers={**session_headers(), "rid": "passwordless"},
        json={
            "preAuthSessionId": parse_qs(link.query)["preAuthSessionId"][0],
            "linkCode": link.fragment,
        },
    )


@pytest.mark.parametrize("provider_id", ["google", "apple"])
@pytest.mark.parametrize("policy", [600, None])
async def test_mapped_provider_email_change_survives_relogin_and_core_restart(
    persistent_core: PersistentCore,
    rownd_client,
    provider_id,
    policy,
):
    """Real Core/HTTP/session transport; provider exchange and delivery are local mocks."""
    suffix = uuid4().hex
    owner = "rownd-" + suffix
    subject = "subject-" + suffix
    old_email, new_email = "a-" + suffix + "@example.com", "b-" + suffix + "@example.com"
    verification_links: list[str] = []
    login_links: list[str] = []

    def provider_override(provider):
        async def exchange(redirect_uri_info, user_context):
            return {"access_token": "test-provider-token"}

        async def user_info(oauth_tokens, user_context):
            return UserInfo(subject, UserInfoEmail(old_email, True))

        provider.exchange_auth_code_for_oauth_tokens = exchange
        provider.get_user_info = user_info
        return provider

    def client_for(url):
        return make_client(
            url,
            rownd_client,
            enable_email_verification=True,
            raise_server_exceptions=True,
            email_verification_links=verification_links,
            passwordless_links=login_links,
            provider_override=provider_override,
            plugin_config={
                "email_change": {"max_session_age_seconds": policy},
                "website_domain": "http://website.example.com",
                "cross_device_confirmation_bypass": {"allowed_redirect_paths": ["/profile"]},
            },
        )

    client = client_for(persistent_core.url)
    await thirdparty.manually_create_or_update_user("public", provider_id, subject, old_email, True)
    rownd_client.user_id = owner
    rownd_client.user_info = {
        "data": {"user_id": owner, "email": old_email, provider_id + "_id": subject},
        "verified_data": {"email": True, provider_id + "_id": True},
    }
    migrated = client.post(
        "/auth/plugin/rownd/migrate",
        headers={"Authorization": "Bearer local-rownd-token", **session_headers()},
    )
    assert migrated.json() == {"status": "OK"}, migrated.text
    mapping = await get_user_id_mapping(owner, "EXTERNAL")
    internal = getattr(mapping, "supertokens_user_id")
    before = await get_user(owner)
    assert before is not None
    provider_before = next(
        method for method in before.login_methods if method.recipe_id == "thirdparty"
    )
    assert provider_before.email == old_email
    old_code = await passwordless.create_code("public", email=old_email)
    login = passwordless_login(client, old_email, login_links)
    assert login.json()["status"] == "OK", login.text
    access = login.headers["st-access-token"]
    old_session = await sessions.get_session_without_request_response(access)
    assert old_session is not None
    for expected_owner in [owner, internal, provider_before.recipe_user_id.get_as_string()]:
        corroborated = client.put(
            "/auth/plugin/rownd/user",
            headers=auth_headers(access),
            json={
                "data": {"first_name": "Before"},
                "context": {
                    "rowndExpectedUserId": expected_owner,
                    "rowndExpectedTenantId": "public",
                },
            },
        )
        assert corroborated.status_code == 200, corroborated.text
    update = client.put(
        "/auth/plugin/rownd/user",
        headers=auth_headers(access),
        json={
            "data": {"email": new_email},
            "context": {"rowndExpectedUserId": owner, "rowndExpectedTenantId": "public"},
        },
    )
    assert update.status_code == 200, update.text
    assert update.json()["data"]["email"] == old_email
    query = parse_qs(urlparse(verification_links[-1]).query)
    verified = client.post(
        "/auth/user/email/verify",
        params={"rowndPendingVerificationId": query["rowndPendingVerificationId"][0]},
        headers={**auth_headers(access), "rid": "emailverification"},
        json={"method": "token", "token": query["token"][0]},
    )
    assert verified.json() == {"status": "OK"}, verified.text
    assert verified.headers.get("st-refresh-token")
    assert verified.headers.get("front-token")
    replacement_access = verified.headers["st-access-token"]
    assert await sessions.get_session_information(old_session.get_handle()) is None

    async def assert_state(token):
        profile = client.get("/auth/plugin/rownd/user", headers=auth_headers(token))
        assert profile.status_code == 200, profile.text
        assert profile.json()["data"]["user_id"] == owner
        assert profile.json()["data"]["email"] == new_email
        current = await get_user(owner)
        assert current is not None and current.id == owner
        provider_after = next(
            method for method in current.login_methods if method.recipe_id == "thirdparty"
        )
        assert (
            provider_after.recipe_user_id.get_as_string()
            == provider_before.recipe_user_id.get_as_string()
        )
        assert provider_after.third_party == provider_before.third_party
        assert provider_after.email == old_email
        assert provider_after.verified == provider_before.verified
        assert not any(
            method.recipe_id == "passwordless"
            and method.email == old_email
            and "public" in method.tenant_ids
            for method in current.login_methods
        )
        state = await repository.get_user_metadata(owner)
        canonical = compatibility.get_canonical_email_recipe_user_id(state, "public")
        assert any(
            method.recipe_user_id.get_as_string() == canonical
            and method.email == new_email
            and method.verified
            for method in current.login_methods
        )
        assert (
            compatibility.build_standard_oauth_claims(current, ["email"], state, "public")["email"]
            == new_email
        )
        assert (
            getattr(await get_user_id_mapping(owner, "EXTERNAL"), "supertokens_user_id") == internal
        )
        before_delivery = len(login_links)
        rejected = client.post(
            "/auth/signinup/code",
            headers={**session_headers(), "rid": "passwordless"},
            json={"email": old_email},
        )
        assert rejected.json()["status"] == "GENERAL_ERROR"
        assert len(login_links) == before_delivery
        with pytest.raises(RowndPluginError, match="could not be completed"):
            await create_magic_link_with_confirmation_bypass(
                email=old_email, redirect_to_path="/profile"
            )
        resent = client.post(
            "/auth/signinup/code/resend",
            headers={**session_headers(), "rid": "passwordless"},
            json={"deviceId": old_code.device_id, "preAuthSessionId": old_code.pre_auth_session_id},
        )
        assert resent.json()["status"] == "RESTART_FLOW_ERROR"
        consumed = client.post(
            "/auth/signinup/code/consume",
            headers={**session_headers(), "rid": "passwordless"},
            json={"preAuthSessionId": old_code.pre_auth_session_id, "linkCode": old_code.link_code},
        )
        assert consumed.json() == {"status": "RESTART_FLOW_ERROR"}
        assert "st-access-token" not in consumed.headers

    await assert_state(replacement_access)
    assert await passwordless.list_codes_by_email("public", old_email) == []
    edited = client.put(
        "/auth/plugin/rownd/user",
        headers=auth_headers(replacement_access),
        json={"data": {"first_name": "New name"}},
    )
    assert edited.json()["data"]["email"] == new_email
    assert edited.json()["data"]["user_id"] == owner
    refresh = client.post(
        "/auth/session/refresh",
        headers={
            **session_headers(),
            "Authorization": "Bearer " + verified.headers["st-refresh-token"],
        },
    )
    assert refresh.status_code == 200, refresh.text

    for restart in [False, True]:
        client.post("/auth/signout", headers=auth_headers(replacement_access))
        if restart:
            reset_st()
            client = client_for(persistent_core.restart())
        provider_login = client.post(
            "/auth/signinup",
            headers={**session_headers(), "rid": "thirdparty"},
            json={
                "thirdPartyId": provider_id,
                "redirectURIInfo": {
                    "redirectURIOnProviderDashboard": "http://website.example.com/callback",
                    "redirectURIQueryParams": {"code": "local-code"},
                },
            },
        )
        assert provider_login.json()["status"] == "OK", provider_login.text
        await assert_state(provider_login.headers["st-access-token"])
        canonical_login = passwordless_login(client, new_email, login_links)
        assert canonical_login.json()["status"] == "OK", canonical_login.text
        replacement_access = canonical_login.headers["st-access-token"]
        await assert_state(replacement_access)


@pytest.mark.parametrize("provider_id", ["google", "apple"])
@pytest.mark.parametrize(
    "interruption", ["publish", "disassociate", "delete", "finalize", "session"]
)
async def test_email_retirement_recovers_after_interrupted_commit(
    persistent_core,
    rownd_client,
    monkeypatch,
    provider_id,
    interruption,
):
    suffix = uuid4().hex
    old_email, new_email = f"old-{suffix}@example.com", f"new-{suffix}@example.com"
    verification_links, login_links = [], []

    def client_for():
        return make_client(
            persistent_core.url,
            rownd_client,
            enable_email_verification=True,
            email_verification_links=verification_links,
            passwordless_links=login_links,
            raise_server_exceptions=False,
        )

    client = client_for()
    provider = await thirdparty.manually_create_or_update_user(
        "public",
        provider_id,
        suffix,
        old_email,
        True,
    )
    assert isinstance(provider, ManuallyCreateOrUpdateUserOkResult)
    await linking.create_primary_user(provider.recipe_user_id)
    old = await passwordless.signinup("public", old_email, None)
    await linking.link_accounts(old.recipe_user_id, provider.user.id)
    owner_id = provider.user.id
    login = passwordless_login(client, old_email, login_links)
    assert login.json()["status"] == "OK", login.text
    access = login.headers["st-access-token"]
    outstanding = await passwordless.create_code("public", email=old_email)
    requested = client.put(
        "/auth/plugin/rownd/user",
        headers=auth_headers(access),
        json={"data": {"email": new_email}},
    )
    assert requested.status_code == 200, requested.text
    query = parse_qs(urlparse(verification_links[-1]).query)
    fired = False

    with monkeypatch.context() as fault:
        if interruption in {"publish", "finalize"}:
            original_update = repository.update_primary_user_metadata

            async def update(user_id, patch, user_context):
                nonlocal fired
                pending = patch.get("rownd_pending_verification")
                is_plan = isinstance(pending, list) and any(
                    item.get("status") == "COMMITTING" for item in pending
                )
                if not fired and interruption == "finalize" and pending == []:
                    fired = True
                    raise RuntimeError("crash before final publication")
                result = await original_update(user_id, patch, user_context)
                if not fired and interruption == "publish" and is_plan:
                    fired = True
                    raise RuntimeError("lost checkpoint response")
                return result

            fault.setattr(repository, "update_primary_user_metadata", update)
        elif interruption == "disassociate":
            original_disassociate = tenants.disassociate_user_from_tenant

            async def disassociate(tenant, recipe, context):
                nonlocal fired
                result = await original_disassociate(tenant, recipe, context)
                if recipe.get_as_string() == old.recipe_user_id.get_as_string() and not fired:
                    fired = True
                    raise RuntimeError("crash after tenant removal")
                return result

            fault.setattr(tenants, "disassociate_user_from_tenant", disassociate)
        elif interruption == "delete":
            original_delete = repository.delete_user

            async def delete(user_id, *args, **kwargs):
                nonlocal fired
                result = await original_delete(user_id, *args, **kwargs)
                if user_id == old.recipe_user_id.get_as_string() and not fired:
                    fired = True
                    raise RuntimeError("lost deletion response")
                return result

            fault.setattr(repository, "delete_user", delete)
        else:
            original_session = sessions.create_new_session

            async def fail_session(*args, **kwargs):
                nonlocal fired
                await original_session(*args, **kwargs)
                fired = True
                raise RuntimeError("lost replacement session response")

            fault.setattr(sessions, "create_new_session", fail_session)

        verified = client.post(
            "/auth/user/email/verify",
            params={"rowndPendingVerificationId": query["rowndPendingVerificationId"][0]},
            headers={**auth_headers(access), "rid": "emailverification"},
            json={"method": "token", "token": query["token"][0]},
        )
    assert fired, verified.text
    assert not verified.headers.get("st-access-token")
    assert await sessions.get_all_session_handles_for_user(owner_id) == []
    state = await repository.get_user_metadata(owner_id)
    if interruption != "session":
        assert repository.get_pending_verifications(state)[0]["status"] == "COMMITTING"
    target_id = compatibility.get_canonical_email_recipe_user_id(state, "public")
    assert target_id
    reset_st()
    persistent_core.restart()
    client = client_for()
    recovered = passwordless_login(client, new_email, login_links)
    assert recovered.json()["status"] == "OK", recovered.text
    current = await get_user(owner_id)
    assert current is not None
    assert {method.recipe_user_id.get_as_string() for method in current.login_methods} == {
        provider.recipe_user_id.get_as_string(),
        target_id,
    }
    provider_after = next(
        method for method in current.login_methods if method.recipe_id == "thirdparty"
    )
    assert provider_after.email == old_email and provider_after.verified
    assert provider_after.third_party == provider.user.login_methods[0].third_party
    assert await get_user(old.recipe_user_id.get_as_string()) is None
    assert await passwordless.list_codes_by_email("public", old_email) == []
    assert (await repository.get_user_metadata(owner_id))["rownd_pending_verification"] == []
    refused = client.post(
        "/auth/signinup/code",
        headers={**session_headers(), "rid": "passwordless"},
        json={"email": old_email},
    )
    assert refused.json()["status"] == "GENERAL_ERROR"
    consumed = client.post(
        "/auth/signinup/code/consume",
        headers={**session_headers(), "rid": "passwordless"},
        json={
            "preAuthSessionId": outstanding.pre_auth_session_id,
            "linkCode": outstanding.link_code,
        },
    )
    assert consumed.json()["status"] == "RESTART_FLOW_ERROR"
    assert "st-access-token" not in consumed.headers
    # A second retry uses the same durable identity and creates no extra method.
    again = passwordless_login(client, new_email, login_links)
    assert again.json()["status"] == "OK", again.text
    final_owner = await get_user(owner_id)
    assert final_owner is not None and len(final_owner.login_methods) == 2


async def test_email_retirement_preserves_other_tenant_credentials(core_url, rownd_client):
    links: list[str] = []
    client = make_client(
        core_url, rownd_client, enable_email_verification=True, email_verification_links=links
    )
    suffix = uuid4().hex
    old_email, new_email, tenant = f"a-{suffix}@example.com", f"b-{suffix}@example.com", suffix
    await tenants.create_or_update_tenant(tenant, None)
    old = await passwordless.signinup("public", old_email, None)
    await tenants.associate_user_to_tenant(tenant, old.recipe_user_id)
    other_code = await passwordless.create_code(tenant, email=old_email)
    session = await sessions.create_new_session_without_request_response(
        "public",
        old.recipe_user_id,
        {},
        {},
        True,
    )
    update = client.put(
        "/auth/plugin/rownd/user",
        headers=auth_headers(session.get_access_token()),
        json={"data": {"email": new_email}},
    )
    assert update.status_code == 200, update.text
    query = parse_qs(urlparse(links[-1]).query)
    verified = client.post(
        "/auth/user/email/verify",
        params={"rowndPendingVerificationId": query["rowndPendingVerificationId"][0]},
        headers={**auth_headers(session.get_access_token()), "rid": "emailverification"},
        json={"method": "token", "token": query["token"][0]},
    )
    assert verified.json()["status"] == "OK", verified.text
    owner = await get_user(old.user.id)
    assert owner is not None
    retained = next(method for method in owner.login_methods if method.email == old_email)
    assert retained.tenant_ids == [tenant]
    assert retained.recipe_user_id.get_as_string() == old.recipe_user_id.get_as_string()
    consumed = await passwordless.consume_code(
        tenant,
        other_code.pre_auth_session_id,
        link_code=other_code.link_code,
    )
    assert getattr(consumed, "user").id == owner.id


@pytest.mark.parametrize(
    "corruption", ["foreign_target", "provider_retirement", "foreign_retirement", "duplicate_plan"]
)
async def test_email_recovery_rejects_unsafe_plan_before_cleanup(
    core_url, rownd_client, corruption
):
    make_client(core_url, rownd_client)
    suffix = uuid4().hex
    old = await passwordless.signinup("public", f"old-{suffix}@example.com", None)
    target = await passwordless.signinup("public", f"target-{suffix}@example.com", None)
    foreign = await passwordless.signinup("public", f"foreign-{suffix}@example.com", None)
    provider = await thirdparty.manually_create_or_update_user(
        "public", "google", suffix, f"provider-{suffix}@example.com", True
    )
    assert isinstance(provider, ManuallyCreateOrUpdateUserOkResult)
    await linking.create_primary_user(old.recipe_user_id)
    await linking.link_accounts(target.recipe_user_id, old.user.id)
    await linking.link_accounts(provider.recipe_user_id, old.user.id)
    outstanding = await passwordless.create_code("public", email=old.user.login_methods[0].email)
    plan = {
        "id": suffix,
        "field": "email",
        "value": target.user.login_methods[0].email,
        "created_at": "2026-10-16T00:00:00Z",
        "tenantId": "public",
        "schemaVersion": 2,
        "status": "COMMITTING",
        "purpose": "UPDATE_PASSWORDLESS",
        "verificationRecipeUserId": old.recipe_user_id.get_as_string(),
        "initiatingRecipeUserId": old.recipe_user_id.get_as_string(),
        "initiatingSessionHandle": "revoked-session",
        "targetCanonicalRecipeUserId": target.recipe_user_id.get_as_string(),
        "retiredMethods": [
            {
                "recipeUserId": old.recipe_user_id.get_as_string(),
                "normalizedEmail": old.user.login_methods[0].email,
            }
        ],
    }
    if corruption == "foreign_target":
        plan["targetCanonicalRecipeUserId"] = foreign.recipe_user_id.get_as_string()
        plan["value"] = foreign.user.login_methods[0].email
    if corruption in {"provider_retirement", "foreign_retirement"}:
        unsafe = provider if corruption == "provider_retirement" else foreign
        plan["retiredMethods"] = [
            {
                "recipeUserId": unsafe.recipe_user_id.get_as_string(),
                "normalizedEmail": unsafe.user.login_methods[0].email,
            }
        ]
    plans = [plan, {**plan, "id": "duplicate"}] if corruption == "duplicate_plan" else [plan]
    await metadata.update_user_metadata(old.user.id, {"rownd_pending_verification": plans})
    with pytest.raises(RowndEmailChangeError):
        await repository.reconcile_committing_email_verification(old.user.id, plan, {})
    current = await get_user(old.user.id)
    assert current is not None and len(current.login_methods) == 3
    assert all("public" in method.tenant_ids for method in current.login_methods)
    assert await get_user(foreign.user.id) is not None
    assert (
        await passwordless.list_codes_by_pre_auth_session_id(
            "public", outstanding.pre_auth_session_id
        )
        is not None
    )


@pytest.mark.parametrize("field_route", [False, True])
@pytest.mark.parametrize("dynamic_policy", [False, True])
async def test_real_session_typed_age_null_and_owner_guards(
    core_url, rownd_client, monkeypatch, field_route, dynamic_policy
):
    links: list[str] = []
    overrides = {}

    async def resolve_config(context):
        assert context["tenant_id"] == "public"
        return overrides

    client = make_client(
        core_url,
        rownd_client,
        enable_email_verification=True,
        email_verification_links=links,
        plugin_config={"resolve_config": resolve_config} if dynamic_policy else None,
    )
    suffix = uuid4().hex
    user = await passwordless.signinup("public", suffix + "@example.com", None)
    session = await sessions.create_new_session_without_request_response(
        "public", user.recipe_user_id
    )
    path = "/auth/plugin/rownd/user" + ("/field?field=email" if field_route else "")
    body = (
        {"value": "new-" + suffix + "@example.com"}
        if field_route
        else {"data": {"email": "new-" + suffix + "@example.com", "first_name": "Must not save"}}
    )
    monkeypatch.setattr(impl, "time", SimpleNamespace(time=lambda: time.time() + 601))
    rejected = client.put(path, headers=auth_headers(session.get_access_token()), json=body)
    assert rejected.status_code == 403, rejected.text
    assert rejected.json()["error_code"] == "EMAIL_CHANGE_REAUTHENTICATION_REQUIRED"
    assert not links
    assert not (await metadata.get_user_metadata(user.user.id)).metadata.get("first_name")
    wrong = client.put(
        path,
        headers=auth_headers(session.get_access_token()),
        json={
            **body,
            "context": {"rowndExpectedUserId": "missing", "rowndExpectedTenantId": "public"},
        },
    )
    assert wrong.status_code == 409
    assert wrong.json()["error_code"] == "EMAIL_CHANGE_ACCOUNT_MISMATCH"
    assert not links
    from supertokens_rownd.config import get_active_rownd_config

    if dynamic_policy:
        overrides["email_change"] = {"max_session_age_seconds": None}
    else:
        get_active_rownd_config().email_change["max_session_age_seconds"] = None
    accepted = client.put(path, headers=auth_headers(session.get_access_token()), json=body)
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["email_verification_pending"] is True
    assert len(links) == 1


async def test_mandatory_claim_blocks_without_consuming_token_or_mutating_pending(
    core_url, rownd_client, monkeypatch
):
    links: list[str] = []
    client = make_client(
        core_url, rownd_client, enable_email_verification=True, email_verification_links=links
    )
    suffix = uuid4().hex
    user = await passwordless.signinup("public", suffix + "@example.com", None)
    session = await sessions.create_new_session_without_request_response(
        "public", user.recipe_user_id
    )
    target = "new-" + suffix + "@example.com"
    update = client.put(
        "/auth/plugin/rownd/user",
        headers=auth_headers(session.get_access_token()),
        json={"data": {"email": target}},
    )
    assert update.status_code == 200
    query = parse_qs(urlparse(links[-1]).query)
    state = (await metadata.get_user_metadata(user.user.id)).metadata
    permission = {"allowed": False}
    claim = BooleanClaim("application-permission", lambda *_: permission["allowed"])
    recipe = SessionRecipe.get_instance().recipe_implementation
    original = recipe.get_global_claim_validators

    async def validators(*args):
        return [*await resolve(original(*args)), claim.validators.is_true(None)]

    monkeypatch.setattr(recipe, "get_global_claim_validators", validators)
    with pytest.raises(RowndEmailChangeError, match="claims"):
        await repository.complete_pending_email_verification(
            user.recipe_user_id,
            target,
            {},
            "public",
            session.get_handle(),
            query["rowndPendingVerificationId"][0],
            user.user.id,
        )
    assert (await metadata.get_user_metadata(user.user.id)).metadata == state
    verify_kwargs: dict[str, Any] = {
        "params": {"rowndPendingVerificationId": query["rowndPendingVerificationId"][0]},
        "headers": {**auth_headers(session.get_access_token()), "rid": "emailverification"},
        "json": {"method": "token", "token": query["token"][0]},
    }
    rejected = client.post("/auth/user/email/verify", **verify_kwargs)
    assert rejected.json()["status"] != "OK"
    assert (await metadata.get_user_metadata(user.user.id)).metadata == state
    permission["allowed"] = True
    await sessions.set_claim_value(session.get_handle(), claim, True)
    accepted = client.post("/auth/user/email/verify", **verify_kwargs)
    assert accepted.json() == {"status": "OK"}, accepted.text
    assert accepted.headers.get("st-access-token")


@pytest.mark.parametrize("field_route", [False, True])
async def test_nonpublic_session_rejects_public_empty_and_wrong_owner_before_dynamic_config(
    core_url, rownd_client, field_route
):
    calls = []

    async def dynamic(context):
        calls.append(context["tenant_id"])
        return {"email_change": {"max_session_age_seconds": None}}

    client = make_client(
        core_url,
        rownd_client,
        enable_email_verification=True,
        plugin_config={"resolve_config": dynamic},
    )
    tenant = "tenant-" + uuid4().hex
    await tenants.create_or_update_tenant(tenant, None)
    user = await passwordless.signinup(tenant, uuid4().hex + "@example.com", None)
    session = await sessions.create_new_session_without_request_response(
        tenant, user.recipe_user_id
    )
    path = "/auth/plugin/rownd/user" + ("/field" if field_route else "")
    data = {"value": "Name"} if field_route else {"data": {"first_name": "Name"}}
    calls.clear()
    for query, context in [
        ({"tenantId": "public"}, {}),
        ({"tenantId": ""}, {}),
        ({}, {"rowndExpectedUserId": user.user.id, "rowndExpectedTenantId": "public"}),
        ({}, {"rowndExpectedUserId": "unknown", "rowndExpectedTenantId": tenant}),
        ({}, {"rowndExpectedTenantId": tenant}),
    ]:
        response = client.put(
            path,
            params={"field": "first_name", **query},
            headers=auth_headers(session.get_access_token()),
            json={**data, "context": context},
        )
        assert response.status_code == 409, response.text
        assert response.json()["error_code"] == "EMAIL_CHANGE_ACCOUNT_MISMATCH"
    assert calls == []
    assert not (await metadata.get_user_metadata(user.user.id)).metadata.get("first_name")
    accepted = client.put(
        path,
        params={"field": "first_name", "tenantId": tenant},
        headers=auth_headers(session.get_access_token()),
        json={
            **data,
            "context": {"rowndExpectedUserId": user.user.id, "rowndExpectedTenantId": tenant},
        },
    )
    assert accepted.status_code == 200, accepted.text
    assert calls == [tenant]


async def test_profile_deletion_and_object_replacement_survive_core_metadata_merge(
    core_url, rownd_client
):
    client = make_client(
        core_url,
        rownd_client,
        plugin_config={
            "schema": {
                "first_name": {"type": "string", "include_in_session_claims": True},
                "preferences": {"type": "object", "include_in_session_claims": True},
            }
        },
    )
    suffix = uuid4().hex
    owner = await passwordless.signinup("public", suffix + "@example.com", None)
    linked = await passwordless.signinup("public", "linked-" + suffix + "@example.com", None)
    await linking.create_primary_user(owner.recipe_user_id)
    await linking.link_accounts(linked.recipe_user_id, owner.user.id)
    await metadata.update_user_metadata(
        owner.user.id,
        {
            "original_rownd_user": {
                "data": {
                    "user_id": owner.user.id,
                    "first_name": "Old",
                    "preferences": {"old": True},
                }
            }
        },
    )
    await metadata.update_user_metadata(
        linked.recipe_user_id.get_as_string(),
        {
            "first_name": "Fallback",
            "preferences": {"old": True, "linked": True},
        },
    )
    session = await sessions.create_new_session_without_request_response(
        "public", owner.recipe_user_id
    )
    response = client.put(
        "/auth/plugin/rownd/user",
        headers=auth_headers(session.get_access_token()),
        json={
            "data": {"first_name": None, "preferences": {"only": None}},
        },
    )
    assert response.status_code == 200, response.text
    assert "first_name" not in response.json()["data"]
    assert response.json()["data"]["preferences"] == {"only": None}
    current = client.get(
        "/auth/plugin/rownd/user", headers=auth_headers(session.get_access_token())
    )
    assert "first_name" not in current.json()["data"]
    assert current.json()["data"]["preferences"] == {"only": None}
    new_session = await sessions.create_new_session_without_request_response(
        "public", owner.recipe_user_id
    )
    assert "first_name" not in new_session.get_access_token_payload()
    assert new_session.get_access_token_payload()["preferences"] == {"only": None}


async def test_cookie_replacement_adoption_and_refresh(core_url, rownd_client):
    links: list[str] = []
    client = make_client(
        core_url,
        rownd_client,
        enable_email_verification=True,
        email_verification_links=links,
        raise_server_exceptions=True,
        api_domain="https://testserver",
    )
    email = uuid4().hex + "@example.com"
    await passwordless.signinup("public", email, None)
    code = await passwordless.create_code("public", email=email)
    headers = {"rid": "passwordless", "fdi-version": "1.18", "st-auth-mode": "cookie"}
    signed_in = client.post(
        "/auth/signinup/code/consume",
        headers=headers,
        json={"preAuthSessionId": code.pre_auth_session_id, "linkCode": code.link_code},
    )
    assert signed_in.json()["status"] == "OK", signed_in.text
    old_access = signed_in.cookies["sAccessToken"]
    old_session = await sessions.get_session_without_request_response(old_access)
    headers["rid"] = "session"
    headers["Cookie"] = "sAccessToken=" + old_access
    response = client.put(
        "/auth/plugin/rownd/user", headers=headers, json={"data": {"email": "new-" + email}}
    )
    assert response.status_code == 200, response.text
    query = parse_qs(urlparse(links[-1]).query)
    verified = client.post(
        "/auth/user/email/verify",
        params={"rowndPendingVerificationId": query["rowndPendingVerificationId"][0]},
        headers={**headers, "rid": "emailverification"},
        json={"method": "token", "token": query["token"][0]},
    )
    assert verified.json() == {"status": "OK"}, verified.text
    assert verified.headers.get("front-token")
    new_access = verified.cookies["sAccessToken"]
    new_refresh = verified.cookies["sRefreshToken"]
    assert new_access and new_refresh
    assert old_session is not None
    assert await sessions.get_session_information(old_session.get_handle()) is None
    profile = client.get(
        "/auth/plugin/rownd/user", headers={**headers, "Cookie": "sAccessToken=" + new_access}
    )
    assert profile.json()["data"]["email"] == "new-" + email
    refreshed = client.post(
        "/auth/session/refresh", headers={**headers, "Cookie": "sRefreshToken=" + new_refresh}
    )
    assert refreshed.status_code == 200, refreshed.text
    assert refreshed.cookies["sAccessToken"]

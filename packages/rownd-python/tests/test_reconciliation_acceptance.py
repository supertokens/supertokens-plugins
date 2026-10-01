from __future__ import annotations

import copy
import uuid
from dataclasses import dataclass
from typing import Any

import pytest
from supertokens_python import Supertokens
from supertokens_python import asyncio as core
from supertokens_python.interfaces import GetUserIdMappingOkResult, UnknownMappingError
from supertokens_python.recipe.accountlinking import asyncio as linking
from supertokens_python.recipe.emailpassword import asyncio as passwords
from supertokens_python.recipe.emailpassword.interfaces import SignUpOkResult
from supertokens_python.recipe.emailverification import asyncio as verification
from supertokens_python.recipe.emailverification.interfaces import (
    CreateEmailVerificationTokenOkResult,
    VerifyEmailUsingTokenOkResult,
)
from supertokens_python.recipe.passwordless import asyncio as passwordless
from supertokens_python.recipe.session import asyncio as sessions
from supertokens_python.recipe.usermetadata import asyncio as metadata
from supertokens_python.types import RecipeUserId

from conftest import auth_headers, make_client, reset_st, session_headers
from test_admin_reconciliation import ProfilesClient, existing_user, mapping_for, profile
from supertokens_rownd import reconcile_user
from supertokens_rownd.admin_core import AdministrativeCore
from supertokens_rownd.supertokens_repository import import_user


class SearchableProfiles(ProfilesClient):
    async def find_user_ids_by_email(self, email):
        return [key for key, value in self.profiles.items() if value["data"].get("email") == email]


@dataclass
class Owners:
    client: Any
    rownd: SearchableProfiles
    old: str
    new: str
    email: str
    target: str
    recipes: dict


async def immutable(recipe_id):
    mapping = await core.get_user_id_mapping(recipe_id, "EXTERNAL")
    return mapping.supertokens_user_id if isinstance(mapping, GetUserIdMappingOkResult) else recipe_id


async def identities(*ids):
    result = {}
    for user_id in ids:
        user = await existing_user(user_id)
        for method in user.login_methods:
            key = await immutable(method.recipe_user_id.get_as_string())
            result[key] = (method.recipe_id, method.email, method.phone_number,
                           (method.third_party.id, method.third_party.user_id) if method.third_party else None,
                           tuple(sorted(method.tenant_ids)), method.time_joined)
    return result


async def assert_graph(fixture, aliases):
    assert (await mapping_for(fixture.new)).supertokens_user_id == fixture.target
    assert (await mapping_for(fixture.target, "SUPERTOKENS")).external_user_id == fixture.new
    user = await existing_user(fixture.new)
    assert user.is_primary_user
    assert await identities(fixture.new) == fixture.recipes
    destinations = []
    for alias in aliases:
        destination = (await mapping_for(alias)).supertokens_user_id
        assert destination in fixture.recipes
        assert (await mapping_for(destination, "SUPERTOKENS")).external_user_id == alias
        assert (await existing_user(alias)).id == fixture.new
        destinations.append(destination)
    assert len(set(destinations)) == len(destinations)
    for recipe_id in fixture.recipes:
        assert (await existing_user(recipe_id)).id == fixture.new


async def verify(recipe_id, email):
    token = await verification.create_email_verification_token("public", RecipeUserId(recipe_id), email)
    if isinstance(token, CreateEmailVerificationTokenOkResult):
        result = await verification.verify_email_using_token("public", token.token, False)
        assert isinstance(result, VerifyEmailUsingTokenOkResult)
    assert await verification.is_email_verified(RecipeUserId(recipe_id), email)


async def snapshot(ids, emails=()):
    result = {}
    for user_id in sorted(set(ids)):
        user = await core.get_user(user_id)
        mapping = await core.get_user_id_mapping(user_id, "ANY")
        result[user_id] = {
            "user": user.to_json() if user else None,
            "mapping": vars(mapping),
            "metadata": copy.deepcopy((await metadata.get_user_metadata(user_id)).metadata),
            "verification": {email: await verification.is_email_verified(RecipeUserId(user_id), email)
                             for email in emails},
        }
    return result


async def merge_fixture(core_url, unverified_source=False):
    suffix = uuid.uuid4().hex
    old, new, email = "old-" + suffix, "new-" + suffix, suffix + "@example.com"
    profiles = {old: profile(old, email, "2025-01-01T00:00:00Z"),
                new: profile(new, email, "2025-02-01T00:00:00Z")}
    profiles[new]["data"]["google_id"] = suffix
    if unverified_source:
        profiles[new]["verified_data"]["email"] = False
    rownd = SearchableProfiles(profiles)
    client = make_client(core_url, rownd, enable_email_verification=True)
    config = Supertokens.get_instance().supertokens_config
    await import_user({"externalUserId": old, "loginMethods": [
        {"recipeId": "passwordless", "email": email, "isVerified": True, "isPrimary": True, "tenantIds": ["public"]},
        {"recipeId": "thirdparty", "thirdPartyId": "apple", "thirdPartyUserId": "apple-" + suffix,
         "email": email, "isVerified": True, "isPrimary": False, "tenantIds": ["public"]}],
        "userMetadata": {"original_rownd_user": profiles[old]}}, config, {})
    await import_user({"externalUserId": new, "loginMethods": [
        {"recipeId": "thirdparty", "thirdPartyId": "google", "thirdPartyUserId": suffix,
         "email": suffix + "@stfakeemail.supertokens.com", "isVerified": False, "isPrimary": True, "tenantIds": ["public"]},
        {"recipeId": "thirdparty", "thirdPartyId": "test-donor", "thirdPartyUserId": suffix,
         "email": "donor-" + email, "isVerified": False, "isPrimary": False, "tenantIds": ["public"]}],
        "userMetadata": {"original_rownd_user": profiles[new]}}, config, {})
    return Owners(client, rownd, old, new, email, (await mapping_for(old)).supertokens_user_id,
                  await identities(old, new))


async def ownerless_fixture(core_url, spare=True):
    suffix = uuid.uuid4().hex
    old, new, email = "old-" + suffix, "new-" + suffix, suffix + "@example.com"
    rownd = SearchableProfiles({old: profile(old, email, "2025-01-01T00:00:00Z"),
                               new: profile(new, email, "2025-02-01T00:00:00Z")})
    client = make_client(core_url, rownd, enable_email_verification=True, enable_email_password=True)
    owner = await passwordless.signinup("public", email=email, phone_number=None)
    target = owner.user.id
    assert (await linking.create_primary_user(owner.recipe_user_id)).status == "OK"
    if spare:
        phone = "+1555" + str(int(suffix[:8], 16)).zfill(10)[-7:]
        extra = await passwordless.signinup("public", email=None, phone_number=phone)
        assert (await linking.link_accounts(extra.recipe_user_id, target)).status == "OK"
    await core.create_user_id_mapping(target, old, force=True)
    await verify(old, email)
    await metadata.update_user_metadata(target, {"original_rownd_user": rownd.profiles[old], "rownd_migration_complete": True})
    return Owners(client, rownd, old, new, email, target, await identities(target))


async def assert_noop_selectors(fixture, aliases):
    selectors = [{"rownd_user_id": alias} for alias in aliases]
    selectors += [{"supertokens_user_id": recipe} for recipe in fixture.recipes]
    selectors.append({"email": fixture.email})
    for selector in selectors:
        result = await reconcile_user(**selector)
        assert result["status"] == "OK", (selector, result)
        assert result["changed"] is False and result["actions"] == [], (selector, result)
        assert result["rownd_user_id"] == fixture.new
        assert result["supertokens_user_id"] == fixture.target


async def test_merge_preserves_exact_graph_and_noops_through_all_selectors(core_url):
    fixture = await merge_fixture(core_url)
    ids = [fixture.old, fixture.new, *fixture.recipes]
    before = await snapshot(ids, [fixture.email])
    preview = await reconcile_user(rownd_user_id=fixture.new, dry_run=True)
    assert preview["status"] == "PREVIEW", preview
    assert preview["supertokens_user_id"] == fixture.target
    assert await snapshot(ids, [fixture.email]) == before
    result = await reconcile_user(rownd_user_id=fixture.new)
    assert result["status"] == "OK", result
    await assert_graph(fixture, [fixture.old, fixture.new])
    await assert_noop_selectors(fixture, [fixture.old, fixture.new])
    await assert_graph(fixture, [fixture.old, fixture.new])


async def test_alias_movement_keeps_native_verification_when_winner_email_is_unverified(core_url):
    fixture = await merge_fixture(core_url, unverified_source=True)
    result = await reconcile_user(rownd_user_id=fixture.new)
    assert result["status"] == "OK", result
    await assert_graph(fixture, [fixture.old, fixture.new])
    user = await existing_user(fixture.new)
    method = next(m for m in user.login_methods if m.recipe_id == "passwordless" and m.email == fixture.email)
    assert method.verified
    assert await verification.is_email_verified(method.recipe_user_id, fixture.email)


async def test_alias_relocation_cannot_lend_stale_verification_to_different_email(core_url):
    fixture = await ownerless_fixture(core_url, spare=False)
    other_email = "unverified-" + fixture.email
    native = await passwords.sign_up("public", other_email, "password123!")
    assert isinstance(native, SignUpOkResult)
    assert (await linking.link_accounts(native.recipe_user_id, fixture.old)).status == "OK"
    await verify(fixture.old, other_email)
    assert not await verification.is_email_verified(native.recipe_user_id, other_email)
    ids = [fixture.target, fixture.old, fixture.new, native.recipe_user_id.get_as_string()]
    before = await snapshot(ids, [fixture.email, other_email])
    for dry_run in (True, False):
        result = await reconcile_user(rownd_user_id=fixture.new, dry_run=dry_run)
        assert result["status"] == "BLOCKED" and result["changed"] is False, result
        assert await snapshot(ids, [fixture.email, other_email]) == before


@pytest.mark.parametrize("phase", ["detach-secondary", "demote-primary", "link", "delete_mapping", "create_mapping", "verify_email"])
async def test_committed_operation_recovers_after_sdk_restart(core_url, monkeypatch, phase):
    fixture = await ownerless_fixture(core_url) if phase == "verify_email" else await merge_fixture(core_url)
    donor = (await mapping_for(fixture.new)).supertokens_user_id if phase != "verify_email" else None
    original = AdministrativeCore.operation
    committed = []

    async def lose_response(self, operation, target):
        await original(self, operation, target)
        selected = operation["kind"] == phase
        if phase in ("detach-secondary", "demote-primary"):
            selected = operation["kind"] == "detach" and (operation["id"] == donor) == (phase == "demote-primary")
        if selected and not committed:
            committed.append(copy.deepcopy(operation))
            raise ConnectionError("acceptance: committed response lost")

    monkeypatch.setattr(AdministrativeCore, "operation", lose_response)
    interrupted = await reconcile_user(rownd_user_id=fixture.new)
    assert len(committed) == 1, interrupted
    assert interrupted["status"] == "ERROR" and interrupted["partialProgress"], interrupted
    monkeypatch.setattr(AdministrativeCore, "operation", original)
    reset_st()
    make_client(core_url, fixture.rownd, enable_email_verification=True, enable_email_password=True)
    recovered = await reconcile_user(rownd_user_id=fixture.new)
    assert recovered["status"] == "OK", recovered
    await assert_graph(fixture, [fixture.old, fixture.new])
    for method in (await existing_user(fixture.new)).login_methods:
        if method.email == fixture.email:
            assert method.verified
            assert await verification.is_email_verified(method.recipe_user_id, fixture.email)
    await assert_noop_selectors(fixture, [fixture.old, fixture.new])


async def test_ownerless_winner_retires_alias_without_resurrection_or_session(core_url):
    fixture = await ownerless_fixture(core_url, spare=False)
    result = await reconcile_user(rownd_user_id=fixture.new)
    assert result["status"] == "OK", result
    await assert_graph(fixture, [fixture.new])
    assert isinstance(await core.get_user_id_mapping(fixture.old, "EXTERNAL"), UnknownMappingError)
    retired = (await metadata.get_user_metadata(fixture.old)).metadata["rownd_migration_superseded"]
    assert retired["rowndUserId"] == fixture.new and retired["targetUserId"] == fixture.target
    assert await verification.is_email_verified(RecipeUserId(fixture.new), fixture.email)
    fixture.rownd.user_id = fixture.old
    response = fixture.client.post("/auth/plugin/rownd/migrate", headers={
        "Authorization": "Bearer retired-rownd-token", **session_headers()})
    assert response.json().get("status") != "OK", response.text
    for header in ("st-access-token", "st-refresh-token", "front-token"):
        assert header not in response.headers
    fixture.rownd.profiles[fixture.old]["meta"]["last_active"] = "2026-01-01T00:00:00Z"
    blocked = await reconcile_user(rownd_user_id=fixture.old)
    assert blocked["status"] == "BLOCKED" and blocked["changed"] is False, blocked
    await assert_noop_selectors(fixture, [fixture.new])


@pytest.mark.parametrize("anchored", [True, False])
async def test_email_selector_requires_native_anchor_and_preview_preserves_core(core_url, anchored):
    source = "lookup-" + uuid.uuid4().hex
    email = source + "@example.com"
    rownd = SearchableProfiles({source: profile(source, email)})
    make_client(core_url, rownd, enable_email_verification=True)
    target = None
    if anchored:
        native = await passwordless.signinup("public", email=email, phone_number=None)
        target = native.user.id
    ids = [source] + ([target] if target else [])
    before = await snapshot(ids, [email])
    preview = await reconcile_user(email=email, dry_run=True)
    assert preview["status"] == ("PREVIEW" if anchored else "BLOCKED"), preview
    assert await snapshot(ids, [email]) == before
    result = await reconcile_user(email=email)
    assert result["status"] == ("OK" if anchored else "BLOCKED"), result
    if anchored:
        assert result["supertokens_user_id"] == target == preview["supertokens_user_id"]
        assert (await mapping_for(source)).supertokens_user_id == target
        repeated = await reconcile_user(email=email)
        assert repeated["status"] == "OK" and repeated["changed"] is False, repeated
    else:
        assert await snapshot(ids, [email]) == before


@pytest.mark.parametrize("drift", ["missing-source", "foreign-mapping"])
async def test_interrupted_merge_blocks_fresh_evidence_drift_without_further_mutation(core_url, monkeypatch, drift):
    fixture = await merge_fixture(core_url)
    original = AdministrativeCore.operation
    committed = []

    async def lose_link(self, operation, target):
        await original(self, operation, target)
        if operation["kind"] == "link" and not committed:
            committed.append(operation["id"])
            raise ConnectionError("acceptance: committed link response lost")

    monkeypatch.setattr(AdministrativeCore, "operation", lose_link)
    interrupted = await reconcile_user(rownd_user_id=fixture.new)
    assert committed and interrupted["status"] == "ERROR", interrupted
    monkeypatch.setattr(AdministrativeCore, "operation", original)
    ids = [fixture.old, fixture.new, *fixture.recipes]
    original_source = copy.deepcopy(fixture.rownd.profiles[fixture.new])
    original_mapping = await mapping_for(fixture.new)
    if drift == "missing-source":
        fixture.rownd.profiles.pop(fixture.new)
    else:
        foreign = await passwordless.signinup("public", email="foreign-" + fixture.email, phone_number=None)
        ids.append(foreign.user.id)
        await core.delete_user_id_mapping(fixture.new, "EXTERNAL", True)
        await core.create_user_id_mapping(foreign.user.id, fixture.new, force=True)
    before = await snapshot(ids, [fixture.email])
    for dry_run in (True, False):
        result = await reconcile_user(rownd_user_id=fixture.old, dry_run=dry_run)
        assert result["status"] == "BLOCKED" and result["changed"] is False, result
        assert await snapshot(ids, [fixture.email]) == before
    if drift == "missing-source":
        fixture.rownd.profiles[fixture.new] = original_source
    else:
        await core.delete_user_id_mapping(fixture.new, "EXTERNAL", True)
        await core.create_user_id_mapping(original_mapping.supertokens_user_id, fixture.new, force=True)
    recovered = await reconcile_user(rownd_user_id=fixture.new)
    assert recovered["status"] == "OK", recovered
    await assert_graph(fixture, [fixture.old, fixture.new])


@pytest.mark.parametrize("requested", ["old", "new"])
async def test_consolidated_aliases_publish_native_and_rownd_sessions_with_exact_origin(core_url, requested):
    fixture = await merge_fixture(core_url)
    result = await reconcile_user(rownd_user_id=fixture.new)
    assert result["status"] == "OK", result
    alias = getattr(fixture, requested)
    native = await sessions.create_new_session_without_request_response("public", RecipeUserId(alias))
    assert native.get_user_id() == fixture.new
    # Mapping relocation changes which immutable credential an alias names.
    assert await immutable(native.get_recipe_user_id().get_as_string()) == await immutable(alias)
    assert await sessions.get_session_information(native.get_handle()) is not None
    fixture.rownd.user_id = alias
    response = fixture.client.post("/auth/plugin/rownd/migrate", headers={
        "Authorization": "Bearer rownd-token", **session_headers()})
    assert response.status_code == 200 and response.json() == {"status": "OK"}, response.text
    migrated = await sessions.get_session_without_request_response(response.headers["st-access-token"])
    assert migrated is not None
    assert migrated.get_user_id() == fixture.new and migrated.get_tenant_id() == "public"
    user_response = fixture.client.get("/auth/plugin/rownd/user", headers=auth_headers(response.headers["st-access-token"]))
    assert user_response.status_code == 200, user_response.text
    assert user_response.json()["rownd_user"] == fixture.new


async def test_native_access_and_refresh_survive_administrative_mapping_publication(core_url):
    source = "native-session-" + uuid.uuid4().hex
    email = source + "@example.com"
    rownd = SearchableProfiles({source: profile(source, email)})
    make_client(core_url, rownd, enable_email_verification=True)
    native = await passwordless.signinup("public", email=email, phone_number=None)
    assert (await linking.create_primary_user(native.recipe_user_id)).status == "OK"
    issued = await sessions.create_new_session_without_request_response(
        "public", native.recipe_user_id, {"applicationUserId": native.user.id})
    tokens = issued.get_all_session_tokens_dangerously()
    refresh_token = tokens["refreshToken"]
    assert refresh_token is not None
    result = await reconcile_user(rownd_user_id=source)
    assert result["status"] == "OK", result
    authenticated = await sessions.get_session_without_request_response(tokens["accessToken"])
    assert authenticated is not None
    assert authenticated.get_user_id() == native.user.id
    assert authenticated.get_recipe_user_id().get_as_string() == native.recipe_user_id.get_as_string()
    assert authenticated.get_handle() == issued.get_handle()
    refreshed = await sessions.refresh_session_without_request_response(refresh_token, disable_anti_csrf=True)
    assert refreshed.get_handle() == issued.get_handle()
    assert refreshed.get_user_id() == source
    assert refreshed.get_recipe_user_id().get_as_string() == native.recipe_user_id.get_as_string()
    assert refreshed.get_access_token_payload()["applicationUserId"] == native.user.id


async def test_instant_session_stays_instant_after_alias_move_and_real_refresh(core_url):
    suffix = uuid.uuid4().hex
    instant, authenticated = "instant-" + suffix, "authenticated-" + suffix
    email = suffix + "@example.com"
    profiles = {instant: {"state": "enabled", "auth_level": "instant", "data": {"user_id": instant}, "verified_data": {}},
                authenticated: profile(authenticated, email)}
    profiles[authenticated]["data"]["google_id"] = suffix
    rownd = SearchableProfiles(profiles)
    client = make_client(core_url, rownd, enable_email_verification=True)
    config = Supertokens.get_instance().supertokens_config
    await import_user({"externalUserId": instant, "loginMethods": [
        {"recipeId": "thirdparty", "thirdPartyId": "instant", "thirdPartyUserId": instant,
         "email": instant + "@anonymous.local", "isVerified": False, "isPrimary": True, "tenantIds": ["public"]}],
        "userMetadata": {"original_rownd_user": profiles[instant]}}, config, {})
    origin = (await mapping_for(instant)).supertokens_user_id
    issued = await sessions.create_new_session_without_request_response("public", RecipeUserId(instant))
    assert issued.get_access_token_payload()["rownd_session_authentication"] == "instant"
    tokens = issued.get_all_session_tokens_dangerously()
    refresh_token = tokens["refreshToken"]
    assert refresh_token is not None
    await import_user({"externalUserId": authenticated, "loginMethods": [
        {"recipeId": "thirdparty", "thirdPartyId": "google", "thirdPartyUserId": suffix,
         "email": email, "isVerified": True, "isPrimary": False, "tenantIds": ["public"]}],
        "userMetadata": {"original_rownd_user": profiles[authenticated]}}, config, {})
    assert (await linking.link_accounts(RecipeUserId(authenticated), origin)).status == "OK"
    result = await reconcile_user(rownd_user_id=authenticated)
    assert result["status"] == "OK", result
    response = client.post("/auth/session/refresh", headers={
        **session_headers(), "Authorization": "Bearer " + refresh_token})
    assert response.status_code == 200, response.text
    refreshed = await sessions.get_session_without_request_response(response.headers["st-access-token"])
    assert refreshed is not None
    assert refreshed.get_handle() == issued.get_handle()
    assert refreshed.get_user_id() == authenticated
    payload = refreshed.get_access_token_payload()
    assert payload["rownd_session_authentication"] == "instant"
    assert payload["auth_level"] == "instant" and payload["is_verified_user"] is False
    assert payload["is_anonymous"]["v"] is True


async def test_malformed_completion_blocks_admin_but_not_native_session_issuance(core_url):
    fixture = await merge_fixture(core_url)
    result = await reconcile_user(rownd_user_id=fixture.new)
    assert result["status"] == "OK", result
    raw = (await metadata.get_user_metadata(fixture.target)).metadata
    plan = copy.deepcopy(raw["rownd_migration_owner_consolidation"])
    plan["completion"] = {"recipes": [], "state": {"graph": [], "mappings": [], "markers": [], "verifications": []}}
    await metadata.update_user_metadata(fixture.target, {"rownd_migration_owner_consolidation": plan})
    native = await sessions.create_new_session_without_request_response("public", RecipeUserId(fixture.new))
    assert native.get_user_id() == fixture.new
    assert await sessions.get_session_information(native.get_handle()) is not None
    result = await reconcile_user(rownd_user_id=fixture.new)
    assert result["status"] == "BLOCKED", result
    assert await sessions.get_session_information(native.get_handle()) is not None

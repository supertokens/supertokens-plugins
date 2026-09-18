from __future__ import annotations

import copy
import uuid
from contextlib import closing
from urllib.parse import urlsplit
from typing import Any, cast
from datetime import datetime, timezone

import httpx
import pytest
from supertokens_python import Supertokens
from supertokens_python import asyncio as core
from supertokens_python.recipe.session import asyncio as sessions
from supertokens_python.recipe.accountlinking import asyncio as linking
from supertokens_python.recipe.usermetadata import asyncio as metadata
from supertokens_python.types import RecipeUserId
from supertokens_python.interfaces import GetUserIdMappingOkResult

from conftest import MockRowndClient, make_client
from supertokens_rownd import reconcile_user
from supertokens_rownd.admin_core import AdministrativeCore, same_json
from supertokens_rownd.admin_planning import (
    AmbiguousElection, activity, elect, metadata_backfill, read_owner_plan, OWNER_PLAN_KEY,
    AdministrativePolicyError,
)
from supertokens_rownd.rownd_repository import RowndClient
from supertokens_rownd.supertokens_repository import import_user
from supertokens_rownd.supertokens_repository import get_user_metadata, get_raw_user_metadata
from supertokens_rownd.admin_validation import validate_completed_owner_plan
from supertokens_rownd.types import RowndPluginConfig


def profile(user_id, email="shared@example.com", activity_time=None):
    return {"state": "enabled", "data": {"user_id": user_id, "email": email},
            "verified_data": {"email": email},
            "meta": {"last_active": activity_time} if activity_time else {}}


def test_activity_rejects_invalid_calendar_future_naive_and_unknown_offset():
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    for value in ("2025-02-30T00:00:00Z", "2027-01-01T00:00:00Z", "2025-01-01T00:00:00", "2025-01-01T00:00:00-00:00"):
        assert activity(profile("a", activity_time=value), now) is None
    assert activity(profile("a", activity_time="2025-01-01T01:00:00+01:00"), now) == "2025-01-01T00:00:00.000Z"


def test_election_keeps_activity_winner_distinct_from_survivor():
    profiles = {"a": profile("a", activity_time="2025-01-01T00:00:00Z"),
                "b": profile("b", activity_time="2025-02-01T00:00:00Z")}
    candidates = [{"rownd_user_id": "a", "supertokens_user_id": "primary"},
                  {"rownd_user_id": "b", "supertokens_user_id": "donor"}]
    election = elect(candidates, profiles, "a")
    assert election["winner"]["rownd_user_id"] == "b"
    assert election["canonical_rownd_user_id"] == "a"
    profiles["b"]["data"]["email"] = "unrelated@example.com"
    with pytest.raises(AmbiguousElection):
        elect(candidates, profiles, "a")


def test_metadata_backfill_preserves_occupied_null_and_filters_authority():
    source = profile("a")
    source["data"].update({"custom": 42, "original_rownd_user": {"data": {"user_id": "forged"}},
                           "rownd_migration_target": "forged"})
    patch = metadata_backfill(source, {"custom": None})
    assert "custom" not in patch
    assert "rownd_migration_target" not in patch
    assert patch["original_rownd_user"]["data"]["user_id"] == "a"
    assert not same_json({"cursor": True}, {"cursor": 1})
    with pytest.raises(AdministrativePolicyError):
        read_owner_plan({OWNER_PLAN_KEY: {"version": True}})


async def test_email_search_follows_all_pages_and_rejects_changed_total():
    pages = []
    def handle(request):
        pages.append(request)
        after = request.url.params.get("after")
        return httpx.Response(200, json={"total_results": 2,
            "results": [{"data": {"user_id": "a" if after is None else "b"}}]})
    config = RowndPluginConfig(rownd_app_key="key", rownd_app_secret="secret", rownd_app_id="app")
    client = RowndClient(config, transport=httpx.MockTransport(handle))
    assert await client.find_user_ids_by_email("a+tag@example.com") == ["a", "b"]
    assert pages[1].url.params["after"] == "a"
    assert pages[0].url.params["lookup_filter"] == "a+tag@example.com"


@pytest.mark.parametrize("second,code", [
    ({"total_results": 3, "results": []}, "ROWND_EMAIL_SEARCH_CHANGED"),
    ({"total_results": 2, "results": [{"data": {"user_id": "a"}}]}, "ROWND_EMAIL_SEARCH_INCOMPLETE"),
    ({"total_results": True, "results": []}, "ROWND_EMAIL_SEARCH_INVALID_RESPONSE"),
])
async def test_email_lookup_never_returns_partial_pages(second, code):
    calls = 0
    def handle(request):
        nonlocal calls
        calls += 1
        return httpx.Response(200, json={"total_results": 2, "results": [{"data": {"user_id": "a"}}]} if calls == 1 else second)
    config = RowndPluginConfig(rownd_app_key="key", rownd_app_secret="secret", rownd_app_id="app")
    with pytest.raises(Exception, match=code):
        await RowndClient(config, transport=httpx.MockTransport(handle)).find_user_ids_by_email("a@example.com")


@pytest.mark.parametrize("selectors", [{}, {"rownd_user_id": "a", "email": "a@example.com"},
                                       {"supertokens_user_id": ""}, {"rownd_user_id": ".."}])
async def test_selectors_are_exactly_one_nonempty_identifier(selectors):
    result = await reconcile_user(**selectors)
    assert result["status"] == "ERROR" and result["changed"] is False
    assert result["partialProgress"] is False


class ProfilesClient(MockRowndClient):
    def __init__(self, profiles):
        super().__init__()
        self.profiles = profiles

    async def fetch_optional_user_info(self, user_id):
        return copy.deepcopy(self.profiles.get(user_id))


async def mapping_for(user_id: str, kind: Any = "EXTERNAL") -> GetUserIdMappingOkResult:
    result = await core.get_user_id_mapping(user_id, kind)
    assert isinstance(result, GetUserIdMappingOkResult)
    return result


async def existing_user(user_id: str):
    result = await core.get_user(user_id)
    assert result is not None
    return result


async def test_real_core_fresh_import_then_readonly_preview(core_url):
    source_id = "admin-" + uuid.uuid4().hex
    client = ProfilesClient({source_id: profile(source_id, source_id + "@example.com")})
    make_client(core_url, client, enable_email_verification=True)
    preview = await reconcile_user(rownd_user_id=source_id, dry_run=True)
    assert preview["status"] == "PREVIEW", preview
    assert preview["matchesSource"] is False
    assert await core.get_user(source_id) is None
    result = await reconcile_user(rownd_user_id=source_id)
    assert result["status"] == "OK", result
    assert result["supertokens_user_id"] != source_id
    user = await core.get_user(source_id)
    assert user is not None and user.login_methods[0].verified
    preview = await reconcile_user(rownd_user_id=source_id, dry_run=True)
    assert preview["status"] == "PREVIEW", preview
    assert preview["matchesSource"] is True
    repeated = await reconcile_user(rownd_user_id=source_id)
    assert repeated["status"] == "OK" and repeated["changed"] is False, repeated


@pytest.mark.parametrize("interrupt", [None, "link", "delete_mapping", "create_mapping"])
async def test_real_core_two_primary_merge_preserves_recipes_and_alias_reverse(core_url, monkeypatch, interrupt):
    suffix = uuid.uuid4().hex
    old_id, new_id = "old-" + suffix, "new-" + suffix
    email = suffix + "@example.com"
    profiles = {old_id: profile(old_id, email, "2025-01-01T00:00:00Z"),
                new_id: profile(new_id, email, "2025-02-01T00:00:00Z")}
    profiles[new_id]["data"]["google_id"] = "google-" + suffix
    client = ProfilesClient(profiles)
    make_client(core_url, client, enable_email_verification=True)
    config = Supertokens.get_instance().supertokens_config
    await import_user({"externalUserId": old_id, "loginMethods": [
        {"recipeId": "passwordless", "email": email, "isVerified": True, "isPrimary": True, "tenantIds": ["public"]},
        {"recipeId": "thirdparty", "thirdPartyId": "apple", "thirdPartyUserId": "apple-" + suffix,
         "email": email, "isVerified": True, "isPrimary": False, "tenantIds": ["public"]}],
        "userMetadata": {"original_rownd_user": profiles[old_id]}}, config, {})
    await import_user({"externalUserId": new_id, "loginMethods": [
        {"recipeId": "thirdparty", "thirdPartyId": "google", "thirdPartyUserId": "google-" + suffix,
         "email": "google-" + suffix + "@stfakeemail.supertokens.com", "isVerified": False, "isPrimary": True, "tenantIds": ["public"]},
        {"recipeId": "thirdparty", "thirdPartyId": "test-donor", "thirdPartyUserId": suffix,
         "email": "donor-" + suffix + "@example.com", "isVerified": False, "isPrimary": False, "tenantIds": ["public"]}],
        "userMetadata": {"original_rownd_user": profiles[new_id]}}, config, {})
    before = await core.get_user(old_id)
    mapping = await mapping_for(old_id)
    target = mapping.supertokens_user_id
    assert before is not None
    session = await sessions.create_new_session_without_request_response("public", before.login_methods[0].recipe_user_id)
    session_handle = session.get_handle()
    original = AdministrativeCore.operation
    failed = False
    async def fault(self, operation, target):
        nonlocal failed
        await original(self, operation, target)
        if operation["kind"] == interrupt and not failed:
            failed = True
            raise ConnectionError("committed response lost")
    monkeypatch.setattr(AdministrativeCore, "operation", fault)
    result = await reconcile_user(rownd_user_id=new_id)
    if interrupt:
        assert result["status"] == "ERROR" and result["partialProgress"] is True, result
        result = await reconcile_user(rownd_user_id=new_id)
    assert result["status"] == "OK", result.get("message", result)
    assert result["supertokens_user_id"] == target
    final = await core.get_user(new_id)
    assert final is not None and len(final.login_methods) == 4
    assert (await mapping_for(new_id)).supertokens_user_id == target
    assert (await mapping_for(target, "SUPERTOKENS")).external_user_id == new_id
    assert (await existing_user(old_id)).id == new_id
    assert await sessions.get_session_information(session_handle) is not None


async def test_real_core_add_provider_and_change_canonical_email(core_url):
    source_id = "methods-" + uuid.uuid4().hex
    original_email = source_id + "@example.com"
    client = ProfilesClient({source_id: profile(source_id, original_email)})
    make_client(core_url, client, enable_email_verification=True)
    first = await reconcile_user(rownd_user_id=source_id)
    assert first["status"] == "OK", first
    client.profiles[source_id]["data"]["google_id"] = source_id
    result = await reconcile_user(rownd_user_id=source_id)
    assert result["status"] == "OK", result
    assert len((await existing_user(source_id)).login_methods) == 2
    new_email = "changed-" + original_email
    client.profiles[source_id]["data"]["email"] = new_email
    client.profiles[source_id]["verified_data"]["email"] = new_email
    result = await reconcile_user(rownd_user_id=source_id)
    assert result["status"] == "OK", result
    assert result["supertokens_user_id"] == first["supertokens_user_id"]
    user = await existing_user(source_id)
    assert any(m.recipe_id == "passwordless" and m.email == new_email and m.verified for m in user.login_methods)


async def test_real_core_standalone_verified_phone_election(core_url):
    suffix = uuid.uuid4().hex
    old_id, new_id = "phone-old-" + suffix, "phone-new-" + suffix
    phone = "+1555" + str(int(suffix[:10], 16))[:9]
    def phone_profile(source_id, timestamp):
        return {"state": "enabled", "data": {"user_id": source_id, "phone_number": phone},
                "verified_data": {"phone_number": phone}, "meta": {"last_active": timestamp}}
    profiles = {old_id: phone_profile(old_id, "2025-01-01T00:00:00Z"),
                new_id: phone_profile(new_id, "2025-02-01T00:00:00Z")}
    client = ProfilesClient(profiles)
    make_client(core_url, client, enable_email_verification=True)
    await import_user({"externalUserId": old_id, "loginMethods": [
        {"recipeId": "passwordless", "phoneNumber": phone, "isVerified": True,
         "isPrimary": False, "tenantIds": ["public"]}],
         "userMetadata": {"original_rownd_user": profiles[old_id]}}, Supertokens.get_instance().supertokens_config, {})
    target = (await mapping_for(old_id)).supertokens_user_id
    result = await reconcile_user(rownd_user_id=new_id)
    assert result["status"] == "OK", result
    assert result["supertokens_user_id"] == target
    assert (await existing_user(new_id)).login_methods[0].phone_number == phone


async def test_real_core_proven_instant_primary_alias_move_and_validator(core_url):
    suffix = uuid.uuid4().hex
    instant, authenticated = "instant-" + suffix, "authenticated-" + suffix
    email = suffix + "@example.com"
    profiles = {instant: {"state": "enabled", "auth_level": "instant", "data": {"user_id": instant}, "verified_data": {}},
                authenticated: profile(authenticated, email)}
    profiles[authenticated]["data"]["google_id"] = suffix
    client = ProfilesClient(profiles)
    make_client(core_url, client, enable_email_verification=True)
    config = Supertokens.get_instance().supertokens_config
    await import_user({"externalUserId": instant, "loginMethods": [
        {"recipeId": "thirdparty", "thirdPartyId": "instant", "thirdPartyUserId": instant,
         "email": instant + "@anonymous.local", "isVerified": False, "isPrimary": True, "tenantIds": ["public"]}],
         "userMetadata": {"original_rownd_user": profiles[instant]}}, config, {})
    await import_user({"externalUserId": authenticated, "loginMethods": [
        {"recipeId": "thirdparty", "thirdPartyId": "google", "thirdPartyUserId": suffix,
         "email": email, "isVerified": True, "isPrimary": False, "tenantIds": ["public"]}],
         "userMetadata": {"original_rownd_user": profiles[authenticated]}}, config, {})
    target = (await mapping_for(instant)).supertokens_user_id
    await linking.link_accounts(RecipeUserId(authenticated), target)
    result = await reconcile_user(rownd_user_id=authenticated)
    assert result["status"] == "OK", result
    assert result["supertokens_user_id"] == target
    raw = await get_raw_user_metadata(target)
    plan = cast(dict[str, Any], raw[OWNER_PLAN_KEY])
    assert set(plan["legacySessionAliasHistory"]["aliases"]) == {instant, authenticated}
    await validate_completed_owner_plan(plan, {})
    corrupted = copy.deepcopy(plan)
    corrupted["recipes"] = []
    with pytest.raises(AdministrativePolicyError):
        read_owner_plan({OWNER_PLAN_KEY: corrupted})
    for field, value in (("version", True), ("version", 2.0), ("cursor", True), ("cursor", -1)):
        corrupted = {**plan, field: value}
        with pytest.raises(AdministrativePolicyError):
            read_owner_plan({OWNER_PLAN_KEY: corrupted})
    await metadata.update_user_metadata(target, {"rownd_pending_verification": [{"id": "changed"}]})
    with pytest.raises(AdministrativePolicyError):
        await validate_completed_owner_plan(plan, {})


async def test_real_core_metadata_references_are_readonly_and_cycles_return_literal(core_url):
    source_id = "reference-" + uuid.uuid4().hex
    client = ProfilesClient({source_id: profile(source_id, source_id + "@example.com")})
    make_client(core_url, client, enable_email_verification=True)
    result = await reconcile_user(rownd_user_id=source_id)
    assert result["status"] == "OK", result
    alias = "retired-" + source_id
    await metadata.update_user_metadata(alias, {"rownd_migration_canonical_target": result["supertokens_user_id"], "custom": "literal"})
    before = await get_raw_user_metadata(alias)
    projected: dict[str, Any] = await get_user_metadata(alias)
    assert projected["original_rownd_user"]["data"]["user_id"] == source_id
    assert await get_raw_user_metadata(alias) == before
    await metadata.update_user_metadata(alias, {"rownd_migration_canonical_target": alias})
    assert (await get_user_metadata(alias))["custom"] == "literal"


async def test_real_core_narrow_orphan_mapping_handoff(core_url):
    import docker

    suffix = uuid.uuid4().hex
    alias, source_id, absent = "alias-" + suffix, "orphan-" + suffix, str(uuid.uuid4())
    email = suffix + "@example.com"
    profiles = {alias: profile(alias, email, "2025-01-01T00:00:00Z"),
                source_id: profile(source_id, email, "2025-02-01T00:00:00Z")}
    for value in profiles.values():
        value["data"]["google_id"] = suffix
    client = ProfilesClient(profiles)
    make_client(core_url, client, enable_email_verification=True)
    await import_user({"externalUserId": alias, "loginMethods": [
        {"recipeId": "passwordless", "email": email, "isVerified": True, "isPrimary": True, "tenantIds": ["public"]},
        {"recipeId": "thirdparty", "thirdPartyId": "google", "thirdPartyUserId": suffix,
         "email": email, "isVerified": True, "isPrimary": False, "tenantIds": ["public"]}],
        "userMetadata": {"original_rownd_user": profiles[alias]}}, Supertokens.get_instance().supertokens_config, {})
    target = (await mapping_for(alias)).supertokens_user_id
    # Public APIs cannot produce this historical inconsistency. Locate only this
    # fixture's private database by its Core port/network, then seed the orphan.
    with closing(docker.from_env()) as engine:
        containers = engine.containers.list()
        port = str(urlsplit(core_url).port)
        core_container = next(c for c in containers if any(
            binding["HostPort"] == port for binding in c.attrs["NetworkSettings"]["Ports"].get("3567/tcp", []) or []))
        networks = set(core_container.attrs["NetworkSettings"]["Networks"])
        postgres = next(c for c in containers if c.attrs["Config"]["Image"] == "postgres:14"
                        and networks.intersection(c.attrs["NetworkSettings"]["Networks"]))
        sql = ("INSERT INTO app_id_to_user_id SELECT (jsonb_populate_record(NULL::app_id_to_user_id, "
               "to_jsonb(t) || jsonb_build_object('user_id', '%s', 'primary_or_recipe_user_id', '%s'))).* "
               "FROM app_id_to_user_id t WHERE user_id = '%s'; "
               "INSERT INTO userid_mapping (app_id, supertokens_user_id, external_user_id) "
               "VALUES ('public', '%s', '%s')") % (absent, absent, target, absent, source_id)
        status, output = postgres.exec_run(["psql", "-U", "supertokens", "-d", "supertokens", "-c", sql])
        assert status == 0, output
    assert await core.get_user(source_id) is None
    preview = await reconcile_user(rownd_user_id=source_id, dry_run=True)
    assert preview["status"] == "PREVIEW", preview
    assert (await mapping_for(source_id)).supertokens_user_id == absent
    result = await reconcile_user(rownd_user_id=source_id)
    assert result["status"] == "OK", result
    assert result["supertokens_user_id"] == target
    assert (await mapping_for(source_id)).supertokens_user_id == target


async def test_real_core_recovers_method_import_committed_before_receipt(core_url, monkeypatch):
    import supertokens_rownd.admin_methods as methods

    source_id = "receipt-" + uuid.uuid4().hex
    client = ProfilesClient({source_id: profile(source_id, source_id + "@example.com")})
    make_client(core_url, client, enable_email_verification=True)
    first = await reconcile_user(rownd_user_id=source_id)
    assert first["status"] == "OK", first
    client.profiles[source_id]["data"]["google_id"] = source_id
    original = methods.import_user
    async def lost_response(*args, **kwargs):
        await original(*args, **kwargs)
        raise ConnectionError("committed response lost")
    monkeypatch.setattr(methods, "import_user", lost_response)
    partial = await reconcile_user(rownd_user_id=source_id)
    assert partial["status"] == "ERROR" and partial["partialProgress"], partial
    monkeypatch.setattr(methods, "import_user", original)
    recovered = await reconcile_user(rownd_user_id=source_id)
    assert recovered["status"] == "OK", recovered
    assert recovered["supertokens_user_id"] == first["supertokens_user_id"]
    assert len((await existing_user(source_id)).login_methods) == 2


async def test_real_core_pending_native_email_blocks_without_writes(core_url):
    source_id = "pending-" + uuid.uuid4().hex
    client = ProfilesClient({source_id: profile(source_id, source_id + "@example.com")})
    make_client(core_url, client, enable_email_verification=True)
    result = await reconcile_user(rownd_user_id=source_id)
    assert result["status"] == "OK", result
    target = result["supertokens_user_id"]
    await metadata.update_user_metadata(target, {"rownd_pending_verification": [{
        "id": "native-change", "field": "email", "value": "native@example.com",
        "purpose": "CHANGE_EMAIL", "tenantId": "public"}]})
    before = await get_raw_user_metadata(target)
    for dry_run in (True, False):
        blocked = await reconcile_user(rownd_user_id=source_id, dry_run=dry_run)
        assert blocked["status"] == "BLOCKED" and blocked["changed"] is False, blocked
        assert await get_raw_user_metadata(target) == before


async def test_real_core_contact_change_does_not_fabricate_verification(core_url):
    source_id = "contact-" + uuid.uuid4().hex
    client = ProfilesClient({source_id: profile(source_id, source_id + "@example.com")})
    make_client(core_url, client, enable_email_verification=True)
    result = await reconcile_user(rownd_user_id=source_id)
    assert result["status"] == "OK", result
    client.profiles[source_id]["data"]["email"] = "changed-" + source_id + "@example.com"
    client.profiles[source_id]["verified_data"]["email"] = False
    result = await reconcile_user(rownd_user_id=source_id)
    assert result["status"] == "OK", result
    user = await existing_user(source_id)
    method = next(m for m in user.login_methods if m.recipe_id == "passwordless")
    assert method.email == client.profiles[source_id]["data"]["email"]
    assert method.verified is False

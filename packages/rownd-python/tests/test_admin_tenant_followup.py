from __future__ import annotations

import uuid
import copy
import pytest
from supertokens_python.recipe.usermetadata import asyncio as metadata

from supertokens_python import asyncio as core
from supertokens_python import Supertokens
from supertokens_python.recipe.multitenancy import asyncio as tenants
from supertokens_python.recipe.session import asyncio as sessions
from supertokens_python.recipe.passwordless import asyncio as passwordless

from conftest import make_client
from test_admin_reconciliation import ProfilesClient, existing_user, mapping_for, profile
from supertokens_rownd import reconcile_user
from supertokens_rownd.admin_core import AdministrativeCore
from supertokens_rownd.supertokens_repository import get_raw_user_metadata, import_user
from supertokens_rownd.admin_planning import identity_keys
from supertokens_rownd.admin_planning import AdministrativePolicyError
from supertokens_rownd.admin_planning import plan_owner_operations, read_owner_plan
from supertokens_rownd.admin_validation import assert_session_membership


def test_synthetic_email_does_not_prove_shared_identity():
    assert identity_keys({"data": {"email": "Other@STFAKEEMAIL.SUPERTOKENS.COM"}}) == set()


def test_present_null_checkpoint_is_not_an_absent_checkpoint():
    assert read_owner_plan({}) is None
    with pytest.raises(AdministrativePolicyError):
        read_owner_plan({"rownd_migration_owner_consolidation": None})


async def test_method_intent_survives_owner_provenance_publication(core_url):
    source_id = "handoff-" + uuid.uuid4().hex
    client = ProfilesClient({source_id: profile(source_id, source_id + "@example.com")})
    make_client(core_url, client, enable_email_verification=True)
    imported = await reconcile_user(rownd_user_id=source_id)
    assert imported["status"] == "OK", imported
    client.profiles[source_id]["data"]["email"] = "new-" + source_id + "@example.com"
    client.profiles[source_id]["verified_data"]["email"] = True
    def interrupt(event):
        if event["stage"] == "methods":
            raise ConnectionError("handoff interrupted")
    interrupted = await reconcile_user(rownd_user_id=source_id, on_progress=interrupt)
    assert interrupted["status"] == "ERROR" and interrupted["partialProgress"], interrupted
    client.profiles[source_id]["data"]["display_name"] = "Changed while recovering"
    repaired = await reconcile_user(rownd_user_id=source_id)
    assert repaired["status"] == "OK", repaired
    assert any(m.email == client.profiles[source_id]["data"]["email"] for m in (await existing_user(source_id)).login_methods)


@pytest.mark.parametrize("boundary", ["verification", "pointer", "retirement"])
async def test_final_method_boundaries_resume_committed_writes(core_url, monkeypatch, boundary):
    source_id = "boundary-" + uuid.uuid4().hex
    client = ProfilesClient({source_id: profile(source_id, source_id + "@example.com")})
    make_client(core_url, client, enable_email_verification=True)
    imported = await reconcile_user(rownd_user_id=source_id)
    assert imported["status"] == "OK", imported
    client.profiles[source_id]["data"]["google_id"] = "old-" + source_id
    added = await reconcile_user(rownd_user_id=source_id)
    assert added["status"] == "OK", added
    client.profiles[source_id]["data"]["email"] = "new-" + source_id + "@example.com"
    client.profiles[source_id]["verified_data"]["email"] = client.profiles[source_id]["data"]["email"]
    if boundary == "retirement":
        client.profiles[source_id]["data"]["google_id"] = "new-" + source_id
    original_metadata = metadata.update_user_metadata
    original_delete = core.delete_user
    failed = False
    async def metadata_response_lost(user_id, values, user_context=None):
        nonlocal failed
        result = await original_metadata(user_id, values, user_context)
        if boundary == "pointer" and "rownd_email_recipe_user_ids" in values and not failed:
            failed = True
            raise ConnectionError("pointer response lost")
        return result
    async def deletion_response_lost(*args, **kwargs):
        nonlocal failed
        result = await original_delete(*args, **kwargs)
        if boundary == "retirement" and not failed:
            failed = True
            raise ConnectionError("retirement response lost")
        return result
    def progress(event):
        nonlocal failed
        if boundary == "verification" and event["stage"] == "verification" and not failed:
            failed = True
            raise ConnectionError("verification committed")
    monkeypatch.setattr(metadata, "update_user_metadata", metadata_response_lost)
    monkeypatch.setattr(core, "delete_user", deletion_response_lost)
    interrupted = await reconcile_user(rownd_user_id=source_id, on_progress=progress)
    assert failed and interrupted["status"] == "ERROR" and interrupted["partialProgress"], interrupted
    recovered = await reconcile_user(rownd_user_id=source_id)
    assert recovered["status"] == "OK", recovered
    assert recovered["supertokens_user_id"] == imported["supertokens_user_id"]


async def test_nonpublic_fresh_import_and_single_owner_method_repair(core_url):
    tenant = "tenant-" + uuid.uuid4().hex
    source_id = "rownd-" + uuid.uuid4().hex
    client = ProfilesClient({source_id: profile(source_id, source_id + "@example.com")})
    make_client(core_url, client, enable_email_verification=True)
    await tenants.create_or_update_tenant(tenant, None)
    preview = await reconcile_user(rownd_user_id=source_id, tenant_id=tenant, dry_run=True)
    assert preview["status"] == "PREVIEW", preview
    imported = await reconcile_user(rownd_user_id=source_id, tenant_id=tenant)
    assert imported["status"] == "OK", imported
    target = imported["supertokens_user_id"]
    client.profiles[source_id]["data"]["google_id"] = source_id
    repaired = await reconcile_user(rownd_user_id=source_id, tenant_id=tenant)
    assert repaired["status"] == "OK", repaired
    assert repaired["supertokens_user_id"] == target
    user = await existing_user(source_id)
    assert len(user.login_methods) == 2
    assert all(m.tenant_ids == [tenant] for m in user.login_methods)
    stored = await get_raw_user_metadata(target)
    assert "rownd_migration_owner_consolidation" not in stored
    assert "rownd_migration_mapping_publication" not in stored
    repeated = await reconcile_user(rownd_user_id=source_id, tenant_id=tenant, dry_run=True)
    assert repeated["status"] == "PREVIEW" and repeated["matchesSource"], repeated


async def test_nonpublic_shared_recipe_contact_change_is_tenant_local(core_url):
    first_tenant, second_tenant = "first-" + uuid.uuid4().hex, "second-" + uuid.uuid4().hex
    source_id = "shared-" + uuid.uuid4().hex
    original_email = source_id + "@example.com"
    client = ProfilesClient({source_id: profile(source_id, original_email)})
    make_client(core_url, client, enable_email_verification=True)
    for tenant in (first_tenant, second_tenant):
        await tenants.create_or_update_tenant(tenant, None)
        result = await reconcile_user(rownd_user_id=source_id, tenant_id=tenant)
        assert result["status"] == "OK", result
    user = await existing_user(source_id)
    assert len(user.login_methods) == 1 and set(user.login_methods[0].tenant_ids) == {first_tenant, second_tenant}
    retained_session = await sessions.create_new_session_without_request_response(first_tenant, user.login_methods[0].recipe_user_id)
    revoked_session = await sessions.create_new_session_without_request_response(second_tenant, user.login_methods[0].recipe_user_id)
    await passwordless.create_code(first_tenant, email=original_email)
    await passwordless.create_code(second_tenant, email=original_email)
    client.profiles[source_id]["data"]["email"] = "new-" + original_email
    client.profiles[source_id]["verified_data"]["email"] = "new-" + original_email
    changed = await reconcile_user(rownd_user_id=source_id, tenant_id=second_tenant)
    assert changed["status"] == "OK", changed
    user = await existing_user(source_id)
    assert [(m.email, m.tenant_ids) for m in user.login_methods if first_tenant in m.tenant_ids] == [(original_email, [first_tenant])]
    assert [(m.email, m.tenant_ids) for m in user.login_methods if second_tenant in m.tenant_ids] == [("new-" + original_email, [second_tenant])]
    assert await sessions.get_session_information(retained_session.get_handle()) is not None
    assert await sessions.get_session_information(revoked_session.get_handle()) is None
    assert await passwordless.list_codes_by_email(first_tenant, original_email)
    assert not await passwordless.list_codes_by_email(second_tenant, original_email)


async def test_expected_alias_delete_never_deletes_concurrent_replacement(core_url, monkeypatch):
    source_id = "race-" + uuid.uuid4().hex
    replacement = "replacement-" + uuid.uuid4().hex
    client = ProfilesClient({source_id: profile(source_id, source_id + "@example.com")})
    make_client(core_url, client, enable_email_verification=True)
    imported = await reconcile_user(rownd_user_id=source_id)
    assert imported["status"] == "OK", imported
    target = imported["supertokens_user_id"]
    original = core.delete_user_id_mapping
    calls = []
    async def race(user_id, user_id_type=None, force=None, user_context=None):
        calls.append((user_id, user_id_type))
        await original(source_id, "EXTERNAL", True, {})
        await core.create_user_id_mapping(target, replacement, force=True, user_context={})
        return await original(user_id, user_id_type, force, user_context)
    monkeypatch.setattr(core, "delete_user_id_mapping", race)
    await AdministrativeCore({}).operation({"kind": "delete_mapping", "id": target, "alias": source_id}, target)
    assert calls == [(source_id, "EXTERNAL")]
    assert (await mapping_for(replacement)).supertokens_user_id == target
    assert (await mapping_for(target, "SUPERTOKENS")).external_user_id == replacement


async def test_native_session_membership_blocks_publication_only_for_target(core_url, monkeypatch):
    source_id = "issuance-" + uuid.uuid4().hex
    other_id = "unrelated-" + uuid.uuid4().hex
    client = ProfilesClient({i: profile(i, i + "@example.com") for i in (source_id, other_id)})
    make_client(core_url, client, enable_email_verification=True)
    unrelated = await reconcile_user(rownd_user_id=other_id)
    assert unrelated["status"] == "OK", unrelated
    original = core.create_user_id_mapping
    checked = False
    async def publication(*args, **kwargs):
        nonlocal checked
        result = await original(*args, **kwargs)
        if args[1] == source_id:
            checked = True
            with pytest.raises(AdministrativePolicyError, match="publication is incomplete"):
                await assert_session_membership(source_id, source_id, "public", {})
            await assert_session_membership(other_id, other_id, "public", {})
        return result
    monkeypatch.setattr(core, "create_user_id_mapping", publication)
    imported = await reconcile_user(rownd_user_id=source_id)
    assert imported["status"] == "OK" and checked, imported
    await assert_session_membership(source_id, source_id, "public", {})
    await metadata.update_user_metadata(source_id, {"rownd_migration_orphan_mapping_repair": {"phase": "HANDOFF"}})
    with pytest.raises(AdministrativePolicyError, match="Orphan mapping recovery is incomplete"):
        await assert_session_membership(source_id, source_id, "public", {})
    await assert_session_membership(other_id, other_id, "public", {})


async def test_alias_only_opaque_metadata_is_occupied_for_preview_and_execution(core_url):
    source_id = "occupied-" + uuid.uuid4().hex
    client = ProfilesClient({source_id: profile(source_id, source_id + "@example.com")})
    make_client(core_url, client, enable_email_verification=True)
    imported = await reconcile_user(rownd_user_id=source_id)
    assert imported["status"] == "OK", imported
    await metadata.update_user_metadata(source_id, {"custom": {"keep": None}})
    client.profiles[source_id]["data"]["custom"] = {"replace": True}
    preview = await reconcile_user(rownd_user_id=source_id, dry_run=True)
    assert preview["status"] == "PREVIEW" and preview["matchesSource"], preview
    repeated = await reconcile_user(rownd_user_id=source_id)
    assert repeated["status"] == "OK" and repeated["changed"] is False, repeated
    assert (await get_raw_user_metadata(source_id))["custom"] == {"keep": None}
    assert "custom" not in await get_raw_user_metadata(imported["supertokens_user_id"])


async def test_owner_worker_never_overwrites_concurrently_replaced_checkpoint(core_url):
    source_id = "checkpoint-race-" + uuid.uuid4().hex
    client = ProfilesClient({source_id: profile(source_id, source_id + "@example.com")})
    make_client(core_url, client, enable_email_verification=True)
    imported = await reconcile_user(rownd_user_id=source_id)
    assert imported["status"] == "OK", imported
    target = imported["supertokens_user_id"]
    client.profiles[source_id]["data"]["google_id"] = source_id
    changed = False
    async def progress(event):
        nonlocal changed
        if event["stage"] == "consolidation" and event.get("completed") and not changed:
            raw = await get_raw_user_metadata(target)
            plan = raw["rownd_migration_owner_consolidation"]
            assert isinstance(plan, dict)
            plan["id"] = "concurrent-plan"
            await metadata.update_user_metadata(target, {"rownd_migration_owner_consolidation": plan})
            changed = True
    result = await reconcile_user(rownd_user_id=source_id, on_progress=progress)
    assert changed and result["status"] == "BLOCKED" and result["partialProgress"], result
    raw = await get_raw_user_metadata(target)
    plan = raw["rownd_migration_owner_consolidation"]
    assert isinstance(plan, dict) and plan["id"] == "concurrent-plan"


async def test_node_v2_owner_checkpoint_without_python_profile_resumes(core_url):
    source_id = "node-owner-" + uuid.uuid4().hex
    client = ProfilesClient({source_id: profile(source_id, source_id + "@example.com")})
    make_client(core_url, client, enable_email_verification=True)
    imported = await reconcile_user(rownd_user_id=source_id)
    assert imported["status"] == "OK", imported
    client.profiles[source_id]["data"]["google_id"] = source_id
    def progress(event):
        if event["stage"] == "methods":
            raise ConnectionError("owner committed")
    interrupted = await reconcile_user(rownd_user_id=source_id, on_progress=progress)
    assert interrupted["status"] == "ERROR", interrupted
    target = imported["supertokens_user_id"]
    raw = await get_raw_user_metadata(target)
    plan = read_owner_plan(raw)
    assert plan is not None
    node_plan = copy.deepcopy(plan)
    node_plan.pop("sourceProfile")
    node_plan["operations"] = plan_owner_operations(node_plan, client.profiles[source_id], node_compatible=True)
    node_plan["cursor"] = len(node_plan["operations"])
    await metadata.update_user_metadata(target, {"rownd_migration_owner_consolidation": node_plan})
    await metadata.update_user_metadata(source_id, {"rownd_migration_owner_recovery": {"target": target, "planId": node_plan["id"]}})
    recovered = await reconcile_user(rownd_user_id=source_id)
    assert recovered["status"] == "OK", recovered
    assert len((await existing_user(source_id)).login_methods) == 2


async def test_unverified_contact_cannot_inherit_native_provider_verification(core_url):
    source_id = "ev-inheritance-" + uuid.uuid4().hex
    email = source_id + "@example.com"
    current = profile(source_id, email)
    current["data"]["google_id"] = source_id
    current["verified_data"]["email"] = False
    client = ProfilesClient({source_id: current})
    make_client(core_url, client, enable_email_verification=True)
    await import_user({"externalUserId": source_id, "loginMethods": [{
        "recipeId": "thirdparty", "thirdPartyId": "google", "thirdPartyUserId": source_id,
        "email": email, "isVerified": True, "isPrimary": True, "tenantIds": ["public"]}],
        "userMetadata": {"original_rownd_user": current}}, Supertokens.get_instance().supertokens_config, {})
    target = (await mapping_for(source_id)).supertokens_user_id
    before = await get_raw_user_metadata(target)
    result = await reconcile_user(rownd_user_id=source_id)
    assert result["status"] == "BLOCKED" and result["changed"] is False, result
    assert len((await existing_user(source_id)).login_methods) == 1
    assert await get_raw_user_metadata(target) == before


async def test_injected_method_intent_cannot_create_an_unrelated_provider(core_url):
    source_id = "intent-injection-" + uuid.uuid4().hex
    client = ProfilesClient({source_id: profile(source_id, source_id + "@example.com")})
    make_client(core_url, client, enable_email_verification=True)
    imported = await reconcile_user(rownd_user_id=source_id)
    assert imported["status"] == "OK", imported
    target = imported["supertokens_user_id"]
    client.profiles[source_id]["data"]["google_id"] = source_id
    async def corrupt(event):
        if event["stage"] == "methods":
            raw = await get_raw_user_metadata(target)
            intent = raw["rownd_migration_admin_methods"]
            assert isinstance(intent, dict)
            operations = intent["operations"]
            assert isinstance(operations, list)
            step = operations[0]
            assert isinstance(step, dict)
            requested = step["method"]
            assert isinstance(requested, dict)
            requested["thirdPartyUserId"] = "unrelated-account"
            await metadata.update_user_metadata(target, {"rownd_migration_admin_methods": intent})
    result = await reconcile_user(rownd_user_id=source_id, on_progress=corrupt)
    assert result["status"] == "BLOCKED", result
    assert len((await existing_user(source_id)).login_methods) == 1

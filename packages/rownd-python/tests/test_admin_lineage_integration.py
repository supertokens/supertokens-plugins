import uuid

import pytest
from supertokens_python import asyncio as core
from supertokens_python.recipe.multitenancy import asyncio as tenants
from supertokens_python.recipe.session import asyncio as sessions
from supertokens_python.recipe.usermetadata import asyncio as metadata

from conftest import make_client
from test_admin_reconciliation import ProfilesClient, profile, existing_user, mapping_for
from test_admin_lifecycle import imported, email_method, provider_method
from supertokens_rownd import reconcile_user
from supertokens_rownd.admin_validation import validate_completed_owner_plan
from supertokens_rownd.admin_core import AdministrativeCore
from supertokens_rownd.admin_planning import metadata_backfill
from supertokens_rownd.admin_lineage import HISTORY_KEY
from supertokens_rownd.constants import INTERNAL_METADATA_FIELDS
from supertokens_rownd.admin_lifecycle import INDEX, RECORD, RETIREMENTS, PENDING, EMAIL_RETIREMENTS, LINEAGE
from supertokens_rownd.supertokens_repository import get_raw_user_metadata


@pytest.mark.parametrize("lost_response", [False, True, "mapping"])
async def test_mapped_secondary_retirement_preserves_valid_owner_lineage(core_url, monkeypatch, lost_response):
    suffix = uuid.uuid4().hex
    old, winner = "old-" + suffix, "winner-" + suffix
    email = suffix + "@example.com"
    profiles = {old: profile(old, email, "2025-01-01T00:00:00Z"), winner: profile(winner, email, "2025-02-01T00:00:00Z")}
    profiles[winner]["data"]["google_id"] = "first-" + suffix
    client = ProfilesClient(profiles)
    make_client(core_url, client, enable_email_verification=True)
    await imported([email_method(email, True)], profiles[old], old)
    await imported([{**provider_method("first-" + suffix), "isPrimary": True}], profiles[winner], winner)
    merged = await reconcile_user(rownd_user_id=winner)
    assert merged["status"] == "OK", merged
    target = merged["supertokens_user_id"]
    retired_id = (await mapping_for(old)).supertokens_user_id
    assert retired_id != target
    client.profiles[winner]["data"]["google_id"] = "second-" + suffix
    if lost_response:
        original = core.delete_user
        original_operation = AdministrativeCore.operation
        async def lost(*args, **kwargs):
            await original(*args, **kwargs)
            raise ConnectionError("retired response lost")
        async def lost_mapping(self, operation, target):
            await original_operation(self, operation, target)
            if operation["kind"] == "delete_mapping" and operation["alias"] == old:
                raise ConnectionError("mapping retirement response lost")
        if lost_response == "mapping":
            monkeypatch.setattr(AdministrativeCore, "operation", lost_mapping)
        else:
            monkeypatch.setattr(core, "delete_user", lost)
        failed = await reconcile_user(rownd_user_id=winner)
        assert failed["status"] == "ERROR", failed
        monkeypatch.setattr(core, "delete_user", original)
        monkeypatch.setattr(AdministrativeCore, "operation", original_operation)
    result = await reconcile_user(rownd_user_id=winner)
    assert result["status"] == "OK", result
    assert await core.get_user(retired_id) is None
    marker = await get_raw_user_metadata(old)
    assert marker["rownd_migration_superseded"] == {"rowndUserId": winner, "targetUserId": target}
    raw = await get_raw_user_metadata(target)
    plan = raw["rownd_migration_owner_consolidation"]
    assert isinstance(plan, dict)
    await validate_completed_owner_plan(plan, {})
    repeated = await reconcile_user(rownd_user_id=winner)
    assert repeated["status"] == "OK" and not repeated["changed"], repeated


async def test_nonpublic_repeated_email_and_provider_updates_keep_provenance(core_url):
    source, tenant = "history-" + uuid.uuid4().hex, "tenant-" + uuid.uuid4().hex
    client = ProfilesClient({source: profile(source, "a-" + source + "@example.com")})
    make_client(core_url, client, enable_email_verification=True)
    await tenants.create_or_update_tenant(tenant, None)
    for epoch in ("a", "b", "c"):
        address = epoch + "-" + source + "@example.com"
        client.profiles[source]["data"]["email"] = address
        client.profiles[source]["verified_data"]["email"] = address
        if epoch != "a":
            client.profiles[source]["data"]["google_id"] = epoch + "-" + source
        result = await reconcile_user(rownd_user_id=source, tenant_id=tenant)
        assert result["status"] == "OK", result
    user = await existing_user(source)
    assert any(m.email == "c-" + source + "@example.com" for m in user.login_methods)
    assert any(m.third_party and m.third_party.user_id == "c-" + source for m in user.login_methods)
    assert not any(m.third_party and m.third_party.user_id == "b-" + source for m in user.login_methods)


@pytest.mark.parametrize("interrupt", [False, True, "pointer", "finish", "forged_pointer"])
async def test_single_owner_public_checkpoint_can_add_tenant_and_replay(core_url, monkeypatch, interrupt):
    source, tenant = "membership-" + uuid.uuid4().hex, "tenant-" + uuid.uuid4().hex
    client = ProfilesClient({source: profile(source, source + "@example.com")})
    make_client(core_url, client, enable_email_verification=True)
    initial = await reconcile_user(rownd_user_id=source)
    assert initial["status"] == "OK", initial
    client.profiles[source]["data"]["google_id"] = source
    checkpointed = await reconcile_user(rownd_user_id=source)
    assert checkpointed["status"] == "OK", checkpointed
    await tenants.create_or_update_tenant(tenant, None)
    original_update = metadata.update_user_metadata
    if interrupt in {"pointer", "finish", "forged_pointer"}:
        async def lost_finalization(user_id, update, *args, **kwargs):
            result = await original_update(user_id, update, *args, **kwargs)
            if (interrupt in {"pointer", "forged_pointer"} and tenant in update.get("rownd_email_recipe_user_ids", {})
                    or interrupt == "finish" and update.get("rownd_migration_admin_finalization", {}).get("status") == "COMPLETE"):
                raise ConnectionError("finalization response lost")
            return result
        monkeypatch.setattr(metadata, "update_user_metadata", lost_finalization)
        failed = await reconcile_user(rownd_user_id=source, tenant_id=tenant)
        assert failed["status"] == "ERROR" and failed["partialProgress"], failed
        monkeypatch.setattr(metadata, "update_user_metadata", original_update)
        if interrupt == "forged_pointer":
            target = initial["supertokens_user_id"]
            raw = await get_raw_user_metadata(target)
            finalization = raw["rownd_migration_admin_finalization"]
            pointers = raw["rownd_email_recipe_user_ids"]
            assert isinstance(finalization, dict) and isinstance(pointers, dict)
            pointers["unrequested-tenant"] = source
            assert isinstance(finalization["operations"], list)
            for step in finalization["operations"]:
                assert isinstance(step, dict)
                if step["kind"] == "metadata":
                    assert isinstance(step["values"], dict)
                    step["values"]["rownd_email_recipe_user_ids"] = pointers
            await metadata.update_user_metadata(target, {"rownd_email_recipe_user_ids": pointers, "rownd_migration_admin_finalization": finalization})
            blocked = await reconcile_user(rownd_user_id=source, tenant_id=tenant)
            assert blocked["status"] == "BLOCKED" and not blocked["changed"], blocked
            assert (await get_raw_user_metadata(target))["rownd_migration_owner_consolidation"] == raw["rownd_migration_owner_consolidation"]
            return
    elif interrupt:
        original = tenants.associate_user_to_tenant
        async def lost(*args, **kwargs):
            await original(*args, **kwargs)
            raise ConnectionError("associated response lost")
        monkeypatch.setattr(tenants, "associate_user_to_tenant", lost)
        failed = await reconcile_user(rownd_user_id=source, tenant_id=tenant)
        assert failed["status"] == "ERROR", failed
        monkeypatch.setattr(tenants, "associate_user_to_tenant", original)
    added = await reconcile_user(rownd_user_id=source, tenant_id=tenant)
    assert added["status"] == "OK", added
    raw = await get_raw_user_metadata(initial["supertokens_user_id"])
    owner_plan = raw["rownd_migration_owner_consolidation"]
    assert isinstance(owner_plan, dict)
    await validate_completed_owner_plan(owner_plan, {})
    for current in ("public", tenant):
        repeated = await reconcile_user(rownd_user_id=source, tenant_id=current)
        assert repeated["status"] == "OK" and not repeated["changed"], repeated


async def test_source_history_is_reserved_from_profile_and_public_metadata(core_url):
    source = "reserved-" + uuid.uuid4().hex
    snapshot = profile(source, source + "@example.com")
    snapshot["data"][HISTORY_KEY] = {"public": {"forged": True}}
    assert HISTORY_KEY in INTERNAL_METADATA_FIELDS
    assert HISTORY_KEY not in metadata_backfill(snapshot, {})
    reserved = {HISTORY_KEY, INDEX, RECORD, RETIREMENTS, PENDING, EMAIL_RETIREMENTS, LINEAGE}
    assert reserved.issubset(INTERNAL_METADATA_FIELDS)
    assert not reserved.intersection(metadata_backfill({**snapshot, "data": {**snapshot["data"], **dict.fromkeys(reserved, {"forged": True})}}, {}))
    client = make_client(core_url, ProfilesClient({source: snapshot}), enable_email_verification=True)
    result = await reconcile_user(rownd_user_id=source)
    assert result["status"] == "OK", result
    user = await existing_user(source)
    session = await sessions.create_new_session_without_request_response("public", user.login_methods[0].recipe_user_id)
    for key in reserved:
        response = client.put("/auth/plugin/rownd/user/meta", headers={"Authorization": "Bearer " + session.get_access_token(), "st-auth-mode": "header"},
                              json={"meta": {key: {"public": {"forged": True}}}})
        assert response.status_code == 403, response.text
    assert HISTORY_KEY not in await get_raw_user_metadata(result["supertokens_user_id"])
    await metadata.update_user_metadata(result["supertokens_user_id"], {HISTORY_KEY: {"private": True}})
    displayed = client.get("/auth/plugin/rownd/user", headers={"Authorization": "Bearer " + session.get_access_token(), "st-auth-mode": "header"})
    assert displayed.status_code == 200, displayed.text
    assert HISTORY_KEY not in displayed.json().get("meta", {})
    assert HISTORY_KEY not in displayed.json().get("data", {})

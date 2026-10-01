from __future__ import annotations

import copy
import uuid
from typing import Any

import pytest
from supertokens_python import Supertokens, asyncio as core
from supertokens_python.recipe.usermetadata import asyncio as metadata
from supertokens_python.recipe.session import asyncio as sessions
from supertokens_python.recipe.multitenancy import asyncio as tenants
from supertokens_python.recipe.accountlinking import asyncio as linking
from supertokens_python.types import RecipeUserId

from conftest import make_client
from test_admin_reconciliation import ProfilesClient, existing_user, mapping_for, profile
from supertokens_rownd import reconcile_user
from supertokens_rownd.supertokens_repository import import_user, get_raw_user_metadata
from supertokens_rownd.admin_core import AdministrativeCore
from supertokens_rownd.admin_validation import validate_completed_owner_plan
from supertokens_rownd.admin_lifecycle import LINEAGE


async def imported(methods, snapshot, alias=None):
    return await import_user({"loginMethods": methods, "userMetadata": {"original_rownd_user": snapshot},
                              **({"externalUserId": alias} if alias else {})}, Supertokens.get_instance().supertokens_config, {})


def email_method(email, primary=False):
    return {"recipeId": "passwordless", "email": email, "isVerified": True, "isPrimary": primary, "tenantIds": ["public"]}


def provider_method(subject):
    return {"recipeId": "thirdparty", "thirdPartyId": "google", "thirdPartyUserId": subject,
            "email": subject + "@stfakeemail.supertokens.com", "isVerified": False, "isPrimary": False, "tenantIds": ["public"]}


@pytest.mark.parametrize("lose_response", [False, True])
async def test_node_provider_introduction_links_only_receipted_donor(core_url, monkeypatch, lose_response):
    source = "intro-" + uuid.uuid4().hex
    current = profile(source, source + "@example.com")
    current["data"]["google_id"] = source
    client = ProfilesClient({source: current})
    make_client(core_url, client, enable_email_verification=True)
    await imported([email_method(current["data"]["email"], True)], current, source)
    target = (await mapping_for(source)).supertokens_user_id
    donor = await imported([provider_method(source)], current)
    rid = donor["id"]
    assert isinstance(rid, str)
    entry = {"rowndUserId": source, "internalUserId": target, "recipeUserId": rid,
             "tenantId": "public", "created": True, "provider": "google", "subject": source}
    await metadata.update_user_metadata(target, {"rownd_migration_provider_introductions": [entry]})
    await metadata.update_user_metadata(rid, {"rownd_migration_provider_introduction": entry})
    preview = await reconcile_user(rownd_user_id=source, dry_run=True)
    assert preview["status"] == "PREVIEW", preview
    assert (await existing_user(rid)).is_primary_user is False
    if lose_response:
        original = metadata.update_user_metadata
        async def interrupted(user_id, update, *args, **kwargs):
            result = await original(user_id, update, *args, **kwargs)
            if update.get("rownd_migration_provider_introduction", "absent") is None:
                raise ConnectionError("introduction cleanup response lost")
            return result
        monkeypatch.setattr(metadata, "update_user_metadata", interrupted)
        failed = await reconcile_user(rownd_user_id=source)
        assert failed["status"] == "ERROR" and failed["partialProgress"], failed
        monkeypatch.setattr(metadata, "update_user_metadata", original)
    result = await reconcile_user(rownd_user_id=source)
    assert result["status"] == "OK", result
    assert (await existing_user(rid)).id == source
    assert "rownd_migration_provider_introduction" not in await get_raw_user_metadata(rid)
    assert (await get_raw_user_metadata(target))["rownd_migration_provider_introductions"] == []


@pytest.mark.parametrize("lose_response", [False, True])
async def test_node_provider_retirement_resumes_deleted_recipe(core_url, monkeypatch, lose_response):
    source = "retire-" + uuid.uuid4().hex
    old_subject, new_subject = "old-" + source, "new-" + source
    current = profile(source, source + "@example.com")
    current["data"]["google_id"] = new_subject
    client = ProfilesClient({source: current})
    make_client(core_url, client, enable_email_verification=True)
    await imported([email_method(current["data"]["email"], True), provider_method(old_subject), provider_method(new_subject)], current, source)
    target = (await mapping_for(source)).supertokens_user_id
    user = await existing_user(source)
    old = next(m for m in user.login_methods if m.third_party and m.third_party.user_id == old_subject)
    rid = old.recipe_user_id.get_as_string()
    session = await sessions.create_new_session_without_request_response("public", old.recipe_user_id)
    entry = {"rowndUserId": source, "recipeUserId": rid, "provider": "google", "subject": old_subject}
    await metadata.update_user_metadata(target, {"rownd_migration_provider_retirements": [entry]})
    if lose_response:
        original = core.delete_user
        async def interrupted(*args, **kwargs):
            await original(*args, **kwargs)
            raise ConnectionError("deleted response lost")
        monkeypatch.setattr(core, "delete_user", interrupted)
        result = await reconcile_user(rownd_user_id=source)
        assert result["status"] == "ERROR" and result["partialProgress"], result
        monkeypatch.setattr(core, "delete_user", original)
    result = await reconcile_user(rownd_user_id=source)
    assert result["status"] == "OK", result
    assert await core.get_user(rid) is None
    assert await sessions.get_session_information(session.get_handle()) is None
    assert (await get_raw_user_metadata(target))["rownd_migration_provider_retirements"] == []


@pytest.mark.parametrize("verified,lose_response,corrupt", [(True, False, False), (True, True, False), (False, False, False), (True, False, True)])
async def test_node_committing_email_requires_independent_receipt_and_exact_proof(core_url, monkeypatch, verified, lose_response, corrupt):
    source = "email-" + uuid.uuid4().hex
    old_email, new_email = "old-" + source + "@example.com", source + "@example.com"
    current = profile(source, new_email)
    current["data"]["google_id"] = source
    if not verified:
        current["verified_data"]["email"] = False
    client = ProfilesClient({source: current})
    make_client(core_url, client, enable_email_verification=True)
    await imported([email_method(new_email, True), email_method(old_email), provider_method(source)], current, source)
    target = (await mapping_for(source)).supertokens_user_id
    user = await existing_user(source)
    obsolete = next(m for m in user.login_methods if m.email == old_email)
    provider = next(m for m in user.login_methods if m.third_party)
    retired = [{"recipeUserId": obsolete.recipe_user_id.get_as_string(), "email": old_email}]
    provenance = {"rowndUserId": source, "providerId": "google", "providerUserId": source,
                  "providerRecipeUserId": provider.recipe_user_id.get_as_string(), "previousEmail": old_email}
    plan = {"id": "migration-email-" + source, "field": "email", "tenantId": "public", "value": new_email,
            "status": "COMMITTING", "purpose": "UPDATE_PASSWORDLESS", "created_at": "2026-01-01T00:00:00Z",
            "targetCanonicalRecipeUserId": source, "migrationSource": provenance, "retiredMethods": retired}
    receipt = {"version": 1, "planId": plan["id"], "tenantId": "public", "targetRecipeUserId": source,
               "targetEmail": new_email, "source": provenance, "retiredMethods": retired}
    if corrupt:
        receipt["targetEmail"] = old_email
    await metadata.update_user_metadata(target, {"rownd_pending_verification": [plan],
        "original_rownd_user": current,
        "rownd_migration_email_retirements": {"public": receipt}, "rownd_email_recipe_user_ids": {"public": source}})
    before = copy.deepcopy(await get_raw_user_metadata(target))
    if lose_response:
        original = core.delete_user
        async def interrupted(*args, **kwargs):
            await original(*args, **kwargs)
            raise ConnectionError("email deletion response lost")
        monkeypatch.setattr(core, "delete_user", interrupted)
        result = await reconcile_user(rownd_user_id=source)
        assert result["status"] == "ERROR" and result["partialProgress"], result
        monkeypatch.setattr(core, "delete_user", original)
    result = await reconcile_user(rownd_user_id=source)
    if verified and not corrupt:
        assert result["status"] == "OK", result
        assert await core.get_user(obsolete.recipe_user_id.get_as_string()) is None
        saved: dict[str, Any] = await get_raw_user_metadata(target)
        assert saved["rownd_pending_verification"] == [] and saved["rownd_migration_email_retirements"] == {}
    else:
        assert result["status"] == "BLOCKED" and not result["changed"], result
        assert await get_raw_user_metadata(target) == before


async def test_node_first_email_pending_uses_fresh_exact_verification(core_url):
    source = "first-email-" + uuid.uuid4().hex
    current = profile(source, source + "@example.com")
    current["data"]["google_id"] = source
    make_client(core_url, ProfilesClient({source: current}), enable_email_verification=True)
    await imported([{**provider_method(source), "isPrimary": True},
                    {**email_method(current["data"]["email"]), "isVerified": False}], current, source)
    target = (await mapping_for(source)).supertokens_user_id
    user = await existing_user(source)
    email = next(m for m in user.login_methods if m.recipe_id == "passwordless")
    plan = {"id": "pending-" + source, "field": "email", "tenantId": "public",
            "value": current["data"]["email"], "status": "PENDING", "purpose": "ADD_PASSWORDLESS",
            "verificationRecipeUserId": email.recipe_user_id.get_as_string()}
    await metadata.update_user_metadata(target, {"rownd_pending_verification": [plan]})
    before = await get_raw_user_metadata(target)
    preview = await reconcile_user(rownd_user_id=source, dry_run=True)
    assert preview["status"] == "PREVIEW", preview
    assert await get_raw_user_metadata(target) == before
    assert not next(m for m in (await existing_user(source)).login_methods if m.recipe_id == "passwordless").verified
    result = await reconcile_user(rownd_user_id=source)
    assert result["status"] == "OK", result
    assert next(m for m in (await existing_user(source)).login_methods if m.recipe_id == "passwordless").verified
    assert (await get_raw_user_metadata(target))["rownd_pending_verification"] == []


async def test_node_provider_retirement_preserves_other_tenant_membership_and_session(core_url):
    source = "shared-retirement-" + uuid.uuid4().hex
    tenant = "other-" + uuid.uuid4().hex
    current = profile(source, source + "@example.com")
    current["data"]["google_id"] = "new-" + source
    make_client(core_url, ProfilesClient({source: current}), enable_email_verification=True)
    await tenants.create_or_update_tenant(tenant, None)
    await imported([email_method(current["data"]["email"], True), provider_method(source),
                    provider_method("new-" + source)], current, source)
    target = (await mapping_for(source)).supertokens_user_id
    old = next(m for m in (await existing_user(source)).login_methods if m.third_party and m.third_party.user_id == source)
    await tenants.associate_user_to_tenant(tenant, old.recipe_user_id)
    public_session = await sessions.create_new_session_without_request_response("public", old.recipe_user_id)
    other_session = await sessions.create_new_session_without_request_response(tenant, old.recipe_user_id)
    entry = {"rowndUserId": source, "recipeUserId": old.recipe_user_id.get_as_string(), "provider": "google", "subject": source}
    await metadata.update_user_metadata(target, {"rownd_migration_provider_retirements": [entry]})
    result = await reconcile_user(rownd_user_id=source)
    assert result["status"] == "OK", result
    preserved = next(m for m in (await existing_user(source)).login_methods if m.recipe_user_id.get_as_string() == old.recipe_user_id.get_as_string())
    assert preserved.tenant_ids == [tenant]
    assert await sessions.get_session_information(public_session.get_handle()) is None
    assert await sessions.get_session_information(other_session.get_handle()) is not None


@pytest.mark.parametrize("fault", [None, "mapping", "delete", "completion", "marker", "journal", "unproven_mapping", "source_change"])
async def test_node_mapped_secondary_retirement_preserves_completed_lineage(core_url, monkeypatch, fault):
    suffix = uuid.uuid4().hex
    old, winner = "node-old-" + suffix, "node-winner-" + suffix
    email = suffix + "@example.com"
    snapshots = {old: profile(old, email, "2025-01-01T00:00:00Z"), winner: profile(winner, email, "2025-02-01T00:00:00Z")}
    snapshots[winner]["data"]["google_id"] = "first-" + suffix
    client = ProfilesClient(snapshots)
    make_client(core_url, client, enable_email_verification=True)
    await imported([email_method(email, True)], snapshots[old], old)
    await imported([{**provider_method("first-" + suffix), "isPrimary": True}], snapshots[winner], winner)
    merged = await reconcile_user(rownd_user_id=winner)
    assert merged["status"] == "OK", merged
    target = merged["supertokens_user_id"]
    retired = (await mapping_for(old)).supertokens_user_id
    assert retired != target
    client.profiles[winner]["data"]["google_id"] = "second-" + suffix
    donor = await imported([provider_method("second-" + suffix)], client.profiles[winner])
    rid = donor["id"]
    assert isinstance(rid, str)
    introduction = {"rowndUserId": winner, "internalUserId": target, "recipeUserId": rid,
                    "tenantId": "public", "created": True, "provider": "google", "subject": "second-" + suffix}
    await metadata.update_user_metadata(target, {"rownd_migration_provider_introductions": [introduction],
        "rownd_migration_provider_retirements": [{"rowndUserId": winner, "recipeUserId": old, "provider": "google", "subject": "first-" + suffix}]})
    await metadata.update_user_metadata(rid, {"rownd_migration_provider_introduction": introduction})
    before = await get_raw_user_metadata(target)
    preview = await reconcile_user(rownd_user_id=winner, dry_run=True)
    assert preview["status"] == "PREVIEW", preview
    assert await get_raw_user_metadata(target) == before
    original_delete, original_operation, original_update = core.delete_user, AdministrativeCore.operation, metadata.update_user_metadata
    if fault:
        async def lose_delete(*args, **kwargs):
            result = await original_delete(*args, **kwargs)
            if args[0] == retired:
                raise ConnectionError("Node recipe deletion response lost")
            return result
        async def lose_mapping(self, operation, owner):
            result = await original_operation(self, operation, owner)
            if operation["kind"] == "delete_mapping" and operation["alias"] == old:
                raise ConnectionError("Node alias mapping deletion response lost")
            return result
        async def lose_completion(user_id, update, *args, **kwargs):
            result = await original_update(user_id, update, *args, **kwargs)
            if fault == "source_change" and user_id == old and "rownd_migration_superseded" in update:
                client.profiles[winner]["data"]["google_id"] = "changed-again-" + suffix
            if (fault == "completion" and user_id == target and "rownd_migration_owner_consolidation" in update
                    or fault == "marker" and user_id == old and "rownd_migration_superseded" in update
                    or fault in {"journal", "unproven_mapping"} and user_id == target and LINEAGE in update):
                raise ConnectionError("Node completion response lost")
            return result
        if fault == "delete":
            monkeypatch.setattr(core, "delete_user", lose_delete)
        elif fault == "mapping":
            monkeypatch.setattr(AdministrativeCore, "operation", lose_mapping)
        else:
            monkeypatch.setattr(metadata, "update_user_metadata", lose_completion)
        failed = await reconcile_user(rownd_user_id=winner)
        assert failed["status"] == ("BLOCKED" if fault == "source_change" else "ERROR") and failed["partialProgress"], failed
        assert LINEAGE in await get_raw_user_metadata(target)
        monkeypatch.setattr(core, "delete_user", original_delete)
        monkeypatch.setattr(AdministrativeCore, "operation", original_operation)
        monkeypatch.setattr(metadata, "update_user_metadata", original_update)
        if fault == "source_change":
            assert (await mapping_for(old)).supertokens_user_id == retired
            assert await core.get_user(retired) is not None
            client.profiles[winner]["data"]["google_id"] = "second-" + suffix
    if fault == "unproven_mapping":
        await core.delete_user_id_mapping(old, "EXTERNAL", True)
        blocked = await reconcile_user(rownd_user_id=winner)
        assert blocked["status"] == "BLOCKED" and not blocked["changed"], blocked
        assert await core.get_user(retired) is not None
        assert (await existing_user(rid)).is_primary_user is False
        return
    result = await reconcile_user(rownd_user_id=winner)
    assert result["status"] == "OK", result
    assert await core.get_user(retired) is None
    assert (await get_raw_user_metadata(old))["rownd_migration_superseded"] == {"rowndUserId": winner, "targetUserId": target}
    raw = await get_raw_user_metadata(target)
    assert LINEAGE not in raw and raw["rownd_migration_provider_retirements"] == []
    completed = raw["rownd_migration_owner_consolidation"]
    assert isinstance(completed, dict)
    await validate_completed_owner_plan(completed, {})
    repeated = await reconcile_user(rownd_user_id=winner)
    assert repeated["status"] == "OK" and not repeated["changed"], repeated


@pytest.mark.parametrize("fault", [None, "mapping", "delete"])
async def test_node_email_mapped_secondary_retirement_preserves_lineage(core_url, monkeypatch, fault):
    suffix = uuid.uuid4().hex
    old, winner = "node-email-old-" + suffix, "node-email-winner-" + suffix
    email, replacement = suffix + "@example.com", "new-" + suffix + "@example.com"
    snapshots = {old: profile(old, email, "2025-01-01T00:00:00Z"), winner: profile(winner, email, "2025-02-01T00:00:00Z")}
    snapshots[winner]["data"].update(google_id=suffix, apple_id="apple-" + suffix)
    client = ProfilesClient(snapshots)
    make_client(core_url, client, enable_email_verification=True)
    await imported([email_method(email, True)], snapshots[old], old)
    await imported([{**provider_method(suffix), "isPrimary": True},
                    {**provider_method("apple-" + suffix), "thirdPartyId": "apple"}], snapshots[winner], winner)
    merged = await reconcile_user(rownd_user_id=winner)
    assert merged["status"] == "OK", merged
    target = merged["supertokens_user_id"]
    retired = (await mapping_for(old)).supertokens_user_id
    assert retired != target
    client.profiles[winner]["data"]["email"] = replacement
    client.profiles[winner]["verified_data"]["email"] = replacement
    donor = await imported([email_method(replacement)], client.profiles[winner])
    rid = donor["id"]
    assert isinstance(rid, str)
    await linking.link_accounts(RecipeUserId(rid), target)
    provider = next(m for m in (await existing_user(winner)).login_methods if m.third_party and m.third_party.id == "google")
    provenance = {"rowndUserId": winner, "providerId": "google", "providerUserId": suffix,
                  "providerRecipeUserId": provider.recipe_user_id.get_as_string(), "previousEmail": email}
    methods = [{"recipeUserId": old, "email": email}]
    pending = {"id": "migration-email-" + rid, "field": "email", "tenantId": "public", "value": replacement,
               "status": "COMMITTING", "purpose": "UPDATE_PASSWORDLESS", "created_at": "2026-01-01T00:00:00Z",
               "targetCanonicalRecipeUserId": rid, "migrationSource": provenance, "retiredMethods": methods}
    receipt = {"version": 1, "planId": pending["id"], "tenantId": "public", "targetRecipeUserId": rid,
               "targetEmail": replacement, "source": provenance, "retiredMethods": methods}
    await metadata.update_user_metadata(target, {"rownd_pending_verification": [pending], "original_rownd_user": client.profiles[winner],
        "rownd_migration_email_retirements": {"public": receipt}, "rownd_email_recipe_user_ids": {"public": rid}})
    original_delete, original_operation = core.delete_user, AdministrativeCore.operation
    if fault:
        async def lose_delete(*args, **kwargs):
            await original_delete(*args, **kwargs)
            raise ConnectionError("Node email retirement response lost")
        async def lose_mapping(self, operation, owner):
            result = await original_operation(self, operation, owner)
            if operation["kind"] == "delete_mapping" and operation["alias"] == old:
                raise ConnectionError("Node email mapping response lost")
            return result
        if fault == "delete":
            monkeypatch.setattr(core, "delete_user", lose_delete)
        else:
            monkeypatch.setattr(AdministrativeCore, "operation", lose_mapping)
        failed = await reconcile_user(rownd_user_id=winner)
        assert failed["status"] == "ERROR" and failed["partialProgress"], failed
        monkeypatch.setattr(core, "delete_user", original_delete)
        monkeypatch.setattr(AdministrativeCore, "operation", original_operation)
    result = await reconcile_user(rownd_user_id=winner)
    assert result["status"] == "OK", result
    assert await core.get_user(retired) is None
    assert (await get_raw_user_metadata(old))["rownd_migration_superseded"] == {"rowndUserId": winner, "targetUserId": target}
    raw = await get_raw_user_metadata(target)
    completed = raw["rownd_migration_owner_consolidation"]
    assert isinstance(completed, dict)
    await validate_completed_owner_plan(completed, {})
    assert LINEAGE not in raw and raw["rownd_pending_verification"] == [] and raw["rownd_migration_email_retirements"] == {}
    repeated = await reconcile_user(rownd_user_id=winner)
    assert repeated["status"] == "OK" and not repeated["changed"], repeated

from __future__ import annotations

import copy
import json

import pytest

from supertokens_rownd.admin_core import AdministrativeCore
from supertokens_rownd.admin_lineage import (
    HISTORY_KEY, completed_tenant_memberships, prepare_alias_retirement,
    record_successful_profile, require_single_owner_tenant_transition,
    retirement_alias_receipt, successful_profiles, validate_retired_alias,
)
from supertokens_rownd.admin_planning import AdministrativePolicyError
from supertokens_rownd.admin_source import source_evidence


class Store(AdministrativeCore):
    def __init__(self, tenant="public"):
        super().__init__({}, tenant)
        self.values = {}
        self.mappings = {}
        self.users = {}

    def fresh(self):
        pass

    async def raw(self, user_id):
        return copy.deepcopy(self.values.get(user_id, {}))

    async def mapping(self, user_id, kind="EXTERNAL"):
        return next((m for m in self.mappings.values()
                     if m["alias" if kind == "EXTERNAL" else "id"] == user_id), None)

    async def user(self, user_id):
        return self.users.get(user_id)

    async def update(self, literal, values, context):
        self.values.setdefault(literal, {}).update(copy.deepcopy(values))


def plan():
    identity = json.dumps(["thirdparty", "a@example.com", None,
                           {"id": "google", "userId": "old"}, ["public"], 1, None])
    return {"id": "owner-plan", "sourceId": "source", "target": "primary", "status": "COMPLETE",
            "cursor": 0, "operations": [], "candidates": [{"rownd_user_id": "source"}],
            "aliases": [{"id": "source", "to": "primary"}],
            "recipes": [{"id": "secondary", "identity": identity, "verified": True, "email": "a@example.com"}],
            "initial": {"graph": [{"id": "secondary", "owner": "primary", "primary": True}],
                        "mappings": [{"id": "secondary", "alias": "historical", "info": "keep"}]}}


async def test_retired_alias_requires_durable_marker_and_absent_both_directions(monkeypatch):
    store = Store()
    owner = plan()
    step = {"kind": "retire", "id": "secondary", "identity": owner["recipes"][0]["identity"]}
    store.mappings["secondary"] = owner["initial"]["mappings"][0]
    monkeypatch.setattr("supertokens_rownd.admin_lineage.metadata.update_user_metadata", store.update)
    receipt = await prepare_alias_retirement(store, owner, step)
    assert receipt is not None
    assert receipt["mapping"]["info"] == "keep"
    with pytest.raises(AdministrativePolicyError):
        await validate_retired_alias(store, owner, receipt)
    store.mappings.clear()
    await validate_retired_alias(store, owner, receipt)
    store.values["historical"].clear()
    with pytest.raises(AdministrativePolicyError):
        await validate_retired_alias(store, owner, receipt)


async def test_retirement_rejects_alias_reassignment_and_forged_receipt():
    store = Store()
    owner = plan()
    receipt = retirement_alias_receipt(owner, {"kind": "retire", "id": "secondary", "identity": owner["recipes"][0]["identity"]})
    assert receipt is not None
    store.values["historical"] = {"rownd_migration_superseded": {"rowndUserId": "source", "targetUserId": "primary"}}
    store.mappings["foreign"] = {"id": "foreign", "alias": "historical"}
    with pytest.raises(AdministrativePolicyError):
        await validate_retired_alias(store, owner, receipt)
    store.mappings.clear()
    receipt["mapping"]["info"] = "forged"
    with pytest.raises(AdministrativePolicyError):
        await validate_retired_alias(store, owner, receipt)


async def test_successful_history_is_tenant_scoped_and_response_loss_is_idempotent(monkeypatch):
    store = Store("tenant-a")
    monkeypatch.setattr("supertokens_rownd.admin_lineage.metadata.update_user_metadata", store.update)
    for tenant, email in [("tenant-b", "other"), ("tenant-a", "a"), ("tenant-a", "b"), ("tenant-a", "c")]:
        store.tenant_id = tenant
        profile = {"data": {"user_id": "source", "email": email + "@example.com"}, "verified_data": {}}
        checkpoint = {"id": "method-" + email, "target": "primary", "sourceId": "source", "tenantId": tenant,
                      "status": "COMPLETE", "profile": profile}
        store.values.setdefault("primary", {}).update({"rownd_migration_admin_methods": checkpoint,
            "rownd_migration_admin_finalization": {"status": "COMPLETE", "target": "primary",
                "sourceId": "source", "tenantId": tenant, "source": source_evidence(profile)}})
        if email == "b":
            async def response_lost(literal, values, context):
                await store.update(literal, values, context)
                raise ConnectionError("history write committed")
            monkeypatch.setattr("supertokens_rownd.admin_lineage.metadata.update_user_metadata", response_lost)
            with pytest.raises(ConnectionError):
                await record_successful_profile(store, checkpoint)
            monkeypatch.setattr("supertokens_rownd.admin_lineage.metadata.update_user_metadata", store.update)
        await record_successful_profile(store, checkpoint)
        await record_successful_profile(store, checkpoint)
    raw = await store.raw("primary")
    assert [p["data"]["email"] for p in successful_profiles(raw, "tenant-a", "source")] == ["a@example.com", "b@example.com", "c@example.com"]
    assert [p["data"]["email"] for p in successful_profiles(raw, "tenant-b", "source")] == ["other@example.com"]
    assert successful_profiles(raw, "tenant-a", "other-source") == []
    raw[HISTORY_KEY]["tenant-b"]["profiles"][0]["data"]["user_id"] = "forged"
    with pytest.raises(AdministrativePolicyError):
        successful_profiles(raw, "tenant-a", "source")


def test_tenant_transition_rejects_real_consolidation_before_mutation():
    owner = plan()
    require_single_owner_tenant_transition(owner)
    checkpoint = {"id": "method-plan", "target": "primary", "sourceId": "source", "tenantId": "tenant-b",
                  "status": "COMPLETE", "operations": [{"kind": "associate", "id": "secondary", "identity": owner["recipes"][0]["identity"]}]}
    assert completed_tenant_memberships(owner, checkpoint) == [{"id": "secondary", "methodPlanId": "method-plan", "tenantIds": ["public", "tenant-b"]}]
    owner["initial"]["graph"][0]["owner"] = "donor"
    with pytest.raises(AdministrativePolicyError):
        require_single_owner_tenant_transition(owner)

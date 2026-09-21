"""Opt-in real-Core request budgets: ROWND_TEST_REQUEST_COUNTS=1 pytest -s <this file>."""

from __future__ import annotations

import json
import os
from collections import Counter
from contextvars import ContextVar
from unittest.mock import AsyncMock
from uuid import uuid4

import httpx
import pytest

from conftest import MockRowndClient, auth_headers, make_client
from supertokens_rownd import reconcile_user
from supertokens_rownd import migration_plan
from supertokens_rownd import supertokens_repository as repo
from test_reconciliation_acceptance import merge_fixture


pytestmark = pytest.mark.skipif(
    os.environ.get("ROWND_TEST_REQUEST_COUNTS") != "1",
    reason="opt-in real-Core request budget benchmark",
)


@pytest.fixture
def core_requests(core_url, monkeypatch):
    origin = httpx.URL(core_url)
    requests = []
    send = httpx.AsyncClient.send

    async def observe(self, request, *args, **kwargs):
        if (request.url.host, request.url.port) == (origin.host, origin.port):
            requests.append((request.method, request.url.path, tuple(request.url.params.multi_items())))
        return await send(self, request, *args, **kwargs)

    monkeypatch.setattr(httpx.AsyncClient, "send", observe)
    return requests


def report(label, requests, source_fetches):
    counts = Counter((method, path) for method, path, _ in requests)
    print(json.dumps({
        "label": label,
        "core_requests": len(requests),
        "source_fetches": source_fetches,
        "endpoints": [[method, path, count] for (method, path), count in sorted(counts.items())],
    }))
    assert counts["POST", "/public/recipe/session"] == 1


@pytest.fixture
def read_phases(core_url, monkeypatch):
    origin = httpx.URL(core_url)
    phase = ContextVar("test_read_phase", default="sdk_or_fallback")
    requests = []
    phases = []
    read = migration_plan.read_ordinary_snapshot
    send = httpx.AsyncClient.send

    async def observe_read(*args, **kwargs):
        label = "plugin-" + str(len(phases))
        phases.append(label)
        token = phase.set(label)
        try:
            return await read(*args, **kwargs)
        finally:
            phase.reset(token)

    async def observe_send(self, request, *args, **kwargs):
        if (request.url.host, request.url.port) == (origin.host, origin.port):
            requests.append((phase.get(), request.method, request.url.path, tuple(request.url.params.multi_items())))
        return await send(self, request, *args, **kwargs)

    monkeypatch.setattr(migration_plan, "read_ordinary_snapshot", observe_read)
    monkeypatch.setattr(httpx.AsyncClient, "send", observe_send)
    return phases, requests


@pytest.mark.parametrize("kind,first_budget,stable_budget", [("email", 138, 32), ("provider", 148, 29)])
def test_migration_request_budget(core_url, core_requests, read_phases, monkeypatch, kind, first_budget, stable_budget):
    rownd = MockRowndClient()
    rownd.user_id = "request-count-" + uuid4().hex
    assert rownd.user_info is not None
    rownd.user_info["data"] = {
        "user_id": rownd.user_id,
        **({"email": rownd.user_id + "@example.com"} if kind == "email" else {"google_id": rownd.user_id}),
    }
    fetches = []
    fetch = rownd.fetch_optional_user_info

    async def observe_source(user_id):
        fetches.append(user_id)
        return await fetch(user_id)

    monkeypatch.setattr(rownd, "fetch_optional_user_info", observe_source)
    client = make_client(core_url, rownd, enable_email_verification=True)
    for label, path, budget, source_count in [
        ("first", "/auth/plugin/rownd/migrate", first_budget, 9),
        ("stable", "/auth/plugin/rownd/migrate", stable_budget, 3),
        ("stable-session", "/auth/plugin/migrate-session", stable_budget, 3),
    ]:
        core_requests.clear()
        fetches.clear()
        phases, phase_requests = read_phases
        phases.clear()
        phase_requests.clear()
        with monkeypatch.context() as stable_patch:
            snapshots = AsyncMock(wraps=repo.read_fresh_migration_snapshot)
            stable_patch.setattr(repo, "read_fresh_migration_snapshot", snapshots)
            if label != "first":
                async def unexpected_repair(*args, **kwargs):
                    pytest.fail("completed migration entered the repair executor")
                stable_patch.setattr(repo, "repair_provider_lifecycle", unexpected_repair)
                stable_patch.setattr(repo, "apply_migration_repairs", unexpected_repair)
            response = client.post(path, headers=auth_headers("synthetic"))
        if label != "first":
            assert snapshots.await_count == 0
            assert len(phases) == 3
            plugin_gets = Counter(entry for entry in phase_requests if entry[0].startswith("plugin-") and entry[1] == "GET")
            assert max(plugin_gets.values()) == 1
            print(json.dumps({"label": kind + "-" + label, "read_phases": dict(Counter(entry[0] for entry in phase_requests))}))
        assert response.status_code == 200, response.text
        report(kind + "-" + label, core_requests, len(fetches))
        assert len(core_requests) <= budget
        assert len(fetches) == source_count

    if kind == "provider":
        rownd.user_info["data"]["google_id"] += "-replacement"
        core_requests.clear()
        fetches.clear()
        response = client.post("/auth/plugin/rownd/migrate", headers=auth_headers("synthetic"))
        assert response.status_code == 200, response.text
        report("provider-replacement", core_requests, len(fetches))
        assert len(core_requests) <= 237
        assert len(fetches) == 12


@pytest.mark.asyncio
async def test_retained_alias_request_budget(core_url, core_requests, monkeypatch):
    fixture = await merge_fixture(core_url)
    result = await reconcile_user(rownd_user_id=fixture.new)
    assert result["status"] == "OK", result
    fixture.rownd.user_id = fixture.old
    fetches = []
    fetch = fixture.rownd.fetch_optional_user_info

    async def observe_source(user_id):
        fetches.append(user_id)
        return await fetch(user_id)

    monkeypatch.setattr(fixture.rownd, "fetch_optional_user_info", observe_source)
    core_requests.clear()
    response = fixture.client.post("/auth/plugin/rownd/migrate", headers=auth_headers("synthetic"))
    assert response.status_code == 200, response.text
    report("retained-alias", core_requests, len(fetches))
    assert len(core_requests) <= 391
    assert len(fetches) == 9

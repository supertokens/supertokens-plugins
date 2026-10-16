import uuid

import pytest
from supertokens_python import Supertokens
from supertokens_python.recipe.session import asyncio as sessions
from supertokens_python.recipe.usermetadata import asyncio as metadata

from conftest import make_client
from test_admin_reconciliation import ProfilesClient, profile, existing_user
from supertokens_rownd import reconcile_user
from supertokens_rownd.admin_core import method_identity
from supertokens_rownd.supertokens_repository import get_raw_user_metadata, import_user


async def setup_replacement(core_url):
    source = "security-" + uuid.uuid4().hex
    client = ProfilesClient({source: profile(source, source + "@example.com")})
    make_client(core_url, client, enable_email_verification=True)
    initial = await reconcile_user(rownd_user_id=source)
    assert initial["status"] == "OK", initial
    client.profiles[source]["data"]["google_id"] = "old-" + source
    added = await reconcile_user(rownd_user_id=source)
    assert added["status"] == "OK", added
    client.profiles[source]["data"]["google_id"] = "new-" + source
    return source, client, initial["supertokens_user_id"]


async def test_unrelated_standalone_creation_receipt_cannot_be_substituted(core_url):
    source, client, target = await setup_replacement(core_url)
    def interrupt(event):
        if event["stage"] == "methods":
            raise ConnectionError("paused")
    result = await reconcile_user(rownd_user_id=source, on_progress=interrupt)
    assert result["status"] == "ERROR", result
    unrelated = await import_user({"loginMethods": [{"recipeId": "thirdparty", "thirdPartyId": "google",
        "thirdPartyUserId": "unrelated-" + source, "email": "unrelated-" + source + "@example.com",
        "isVerified": False, "isPrimary": False, "tenantIds": ["public"]}], "userMetadata": {}}, Supertokens.get_instance().supertokens_config, {})
    rid = unrelated["id"]
    assert isinstance(rid, str)
    user = await existing_user(rid)
    raw = await get_raw_user_metadata(target)
    checkpoint = raw["rownd_migration_admin_methods"]
    assert isinstance(checkpoint, dict) and isinstance(checkpoint["operations"], list)
    step = checkpoint["operations"][0]
    assert isinstance(step, dict)
    step["nonce"] = "forged"
    step["receipt"] = {"id": rid, "identity": method_identity(user.login_methods[0]), "verified": False}
    await metadata.update_user_metadata(target, {"rownd_migration_admin_methods": checkpoint})
    blocked = await reconcile_user(rownd_user_id=source)
    assert blocked["status"] == "BLOCKED", blocked
    assert (await existing_user(rid)).is_primary_user is False
    assert len((await existing_user(source)).login_methods) == 2


@pytest.mark.parametrize("same_invocation", [True, False])
async def test_advanced_cursor_cannot_skip_live_provider_retirement(core_url, same_invocation):
    source, client, target = await setup_replacement(core_url)
    user = await existing_user(source)
    old = next(m for m in user.login_methods if m.third_party)
    session = await sessions.create_new_session_without_request_response("public", old.recipe_user_id)
    async def corrupt():
        raw = await get_raw_user_metadata(target)
        checkpoint = raw["rownd_migration_admin_methods"]
        assert isinstance(checkpoint, dict) and isinstance(checkpoint["operations"], list)
        checkpoint["cursor"] = len(checkpoint["operations"])
        await metadata.update_user_metadata(target, {"rownd_migration_admin_methods": checkpoint})
    async def progress(event):
        if event["stage"] == "methods":
            if same_invocation:
                await corrupt()
            else:
                raise ConnectionError("paused")
    result = await reconcile_user(rownd_user_id=source, on_progress=progress)
    if not same_invocation:
        assert result["status"] == "ERROR", result
        await corrupt()
        result = await reconcile_user(rownd_user_id=source)
    assert result["status"] == "BLOCKED", result
    assert await sessions.get_session_information(session.get_handle()) is not None
    raw = await get_raw_user_metadata(target)
    checkpoint = raw["rownd_migration_admin_methods"]
    assert isinstance(checkpoint, dict) and checkpoint["status"] != "COMPLETE"

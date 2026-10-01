import logging
from types import SimpleNamespace
from typing import Any, Awaitable, Callable, cast
from unittest.mock import AsyncMock

import pytest
from supertokens_python.recipe.accountlinking.interfaces import LinkAccountsOkResult
from supertokens_python.types import LoginMethod, RecipeUserId

import supertokens_rownd.supertokens_repository as impl
from supertokens_rownd.errors import RowndEmailChangeError
from supertokens_rownd.types import JsonDict, RowndPluginConfig


@pytest.mark.parametrize("enable_debug_logs", [False, True])
@pytest.mark.parametrize("replacement_session", [False, True])
async def test_email_change_rollback_logs_safe_warning(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    enable_debug_logs: bool,
    replacement_session: bool,
) -> None:
    user_id = "private-rollback-user-id"
    secret = "synthetic-rollback-secret-sentinel"
    rollback_error = RuntimeError(secret)
    link_error = RuntimeError("synthetic-link-secret-sentinel")
    recipe_user_id = RecipeUserId("original-recipe-user")
    new_recipe_user_id = RecipeUserId("replacement-recipe-user")
    email = "new@example.com"
    user_context: dict[str, Any] = {}
    user = SimpleNamespace(
        id=user_id,
        is_primary_user=True,
        login_methods=[
            LoginMethod(
                recipe_id="passwordless",
                recipe_user_id=recipe_user_id.get_as_string(),
                tenant_ids=["public"],
                email="old@example.com",
                phone_number=None,
                third_party=None,
                webauthn=None,
                time_joined=0,
                verified=True,
            )
        ],
    )
    metadata: JsonDict = {
        "rownd_pending_verification": [
            {
                "id": "pending-id",
                "field": "email",
                "value": email,
                "created_at": "2026-01-01T00:00:00Z",
                "purpose": "UPDATE_PASSWORDLESS",
                "status": "PENDING",
                "tenantId": "public",
                "verificationRecipeUserId": recipe_user_id.get_as_string(),
                "initiatingSessionHandle": "session-handle",
            }
        ]
    }

    async def update_metadata(_user_id: str, update: JsonDict, _context: JsonDict) -> None:
        metadata.update(update)

    config = RowndPluginConfig(enable_debug_logs=enable_debug_logs)
    monkeypatch.setattr(impl, "get_active_rownd_config", lambda: config)
    monkeypatch.setattr(impl, "get_user", AsyncMock(return_value=user))
    monkeypatch.setattr(impl, "get_primary_user_mapping", AsyncMock(return_value=None))
    monkeypatch.setattr(impl, "get_raw_user_metadata", AsyncMock(return_value=metadata))
    monkeypatch.setattr(impl, "update_primary_user_metadata", update_metadata)
    monkeypatch.setattr(impl, "assert_email_available_for_user", AsyncMock())
    monkeypatch.setattr(
        impl.session_asyncio,
        "get_session_information",
        AsyncMock(
            return_value=SimpleNamespace(
                user_id=user_id, tenant_id="public", recipe_user_id=recipe_user_id
            )
        ),
    )
    monkeypatch.setattr(impl.session_asyncio, "revoke_session", AsyncMock(return_value=True))
    revoke_sessions = AsyncMock()
    monkeypatch.setattr(impl.session_asyncio, "revoke_all_sessions_for_user", revoke_sessions)
    monkeypatch.setattr(
        impl.passwordless_asyncio,
        "signinup",
        AsyncMock(
            return_value=SimpleNamespace(
                created_new_recipe_user=True,
                user=SimpleNamespace(id=new_recipe_user_id.get_as_string()),
                recipe_user_id=new_recipe_user_id,
            )
        ),
    )
    monkeypatch.setattr(
        impl.accountlinking_asyncio,
        "link_accounts",
        AsyncMock(
            return_value=LinkAccountsOkResult(False, cast(Any, user)),
            side_effect=None if replacement_session else link_error,
        ),
    )
    monkeypatch.setattr(
        impl,
        "inspect_linked_user_metadata",
        AsyncMock(return_value={"primary_metadata": dict(metadata), "combined_metadata": {}}),
    )
    delete_user = AsyncMock(side_effect=rollback_error)
    unverify = AsyncMock()
    restore_metadata = AsyncMock()
    monkeypatch.setattr(impl, "delete_user", delete_user)
    monkeypatch.setattr(impl.emailverification_asyncio, "unverify_email", unverify)
    monkeypatch.setattr(impl, "replace_primary_user_metadata", restore_metadata)

    with caplog.at_level(logging.DEBUG, logger="supertokens_rownd"):
        with pytest.raises(RowndEmailChangeError) as caught:
            completion = await impl.complete_pending_email_verification(
                recipe_user_id, email, user_context, session_handle="session-handle"
            )
            assert replacement_session
            assert completion is not None
            rollback = cast(
                Callable[[], Awaitable[None]], completion["rollback_on_session_replacement_failure"]
            )
            await rollback()

    assert caught.value.code == "CONFLICT"
    assert caught.value.http_status == 409
    assert str(caught.value) == "email change rollback failed; account reconciliation is required"
    assert caught.value.__cause__ is (None if replacement_session else rollback_error)
    if not replacement_session:
        assert rollback_error.__context__ is link_error
    delete_user.assert_awaited_once_with(
        new_recipe_user_id.get_as_string(),
        remove_all_linked_accounts=False,
        user_context=user_context,
    )
    assert revoke_sessions.await_count == (3 if replacement_session else 2)
    if replacement_session:
        unverify.assert_awaited_once_with(recipe_user_id, email, user_context)
        restore_metadata.assert_awaited_once()

    captured = caplog.text + str([record.__dict__ for record in caplog.records])
    for sensitive in (user_id, secret, str(link_error)):
        assert sensitive not in captured
    code = (
        "email_change_replacement_session_rollback_failed"
        if replacement_session
        else "email_change_rollback_failed"
    )
    assert caplog.record_tuples == [
        (
            "supertokens_rownd",
            logging.WARNING,
            f"RowndMigrationPlugin: {code} reconciliation_required=true",
        )
    ]
    assert all(record.exc_info is None and record.stack_info is None for record in caplog.records)

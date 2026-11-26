from __future__ import annotations

from supertokens_python.asyncio import get_user
from supertokens_python.framework.request import BaseRequest
from supertokens_python.framework.response import BaseResponse
from supertokens_python.recipe.session import SessionContainer
from supertokens_python.recipe.session import asyncio as session_asyncio
from supertokens_python.types.base import UserContext

from . import config as rownd_config
from . import supertokens_repository
from .errors import RowndEmailChangeSessionsRevokedError
from .logger import log_debug, log_warning
from .utils import clear_supertokens_core_call_cache


async def restore_session_after_failed_email_change(
    error: RowndEmailChangeSessionsRevokedError,
    session: SessionContainer,
    request: BaseRequest,
    response: BaseResponse,
    user_context: UserContext,
) -> bool:
    """Re-issue a session for the original identity after a failed email change.

    Completion revokes the initiating session as its single-use lock, so a failure
    afterwards would leave the client holding a dead session. Returns False when
    recovery cannot safely issue tokens; the caller must clear the client's tokens.
    """

    def log(outcome: str) -> None:
        log_debug(
            rownd_config.get_active_rownd_config(),
            f"email_change_session_recovery step={error.step} outcome={outcome}",
        )

    recoverable_recipe_user_id = error.recoverable_recipe_user_id
    if recoverable_recipe_user_id is None:
        log("not-recoverable")
        return False
    stage = "tenant-lookup"
    recovered_session = None
    try:
        tenant_id = session.get_tenant_id(user_context)
        stage = "identity-lookup"
        clear_supertokens_core_call_cache(user_context)
        owner = await get_user(recoverable_recipe_user_id, user_context)
        method = (
            next(
                (
                    candidate
                    for candidate in owner.login_methods
                    if candidate.recipe_user_id.get_as_string() == recoverable_recipe_user_id
                    and tenant_id in candidate.tenant_ids
                ),
                None,
            )
            if owner is not None
            else None
        )
        if owner is None or owner.id != error.user_id or method is None:
            log("identity-changed")
            return False
        stage = "authorize-recovery"
        if (
            method.recipe_id == "passwordless"
            and method.email
            and rownd_config.get_active_rownd_config().email_change.get(
                "retirement_mode", "enforce"
            )
            == "enforce"
        ):
            authorization = await supertokens_repository.authorize_passwordless_email(
                tenant_id,
                method.email,
                user_context,
                recoverable_recipe_user_id,
                owner.id,
            )
            if not authorization.allowed:
                log("credential-not-authorized")
                return False
        stage = "create-recovery-session"
        recovered_session = await session_asyncio.create_new_session(
            request, tenant_id, method.recipe_user_id, {}, {}, user_context
        )
        stage = "apply-recovery-tokens"
        # Drain the SDK queue here so the framework won't replay it unguarded.
        mutators = tuple(recovered_session.response_mutators)
        recovered_session.response_mutators.clear()
        for mutate in mutators:
            mutate(response, user_context)
    except Exception as failure:
        log_warning(
            rownd_config.get_active_rownd_config(),
            f"email_change_session_recovery step={error.step} stage={stage} "
            f"error_type={type(failure).__name__}",
        )
        if recovered_session is not None:
            try:
                await session_asyncio.revoke_session(
                    recovered_session.get_handle(user_context), user_context
                )
            except Exception as revoke_failure:
                log_warning(
                    rownd_config.get_active_rownd_config(),
                    f"email_change_session_recovery step={error.step} "
                    "stage=revoke-undelivered-recovery "
                    f"error_type={type(revoke_failure).__name__}",
                )
        return False
    log("restored")
    return True

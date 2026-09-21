from __future__ import annotations

import asyncio
import logging
import time
import uuid
from contextlib import suppress
from typing import Any, Awaitable, Callable, Optional, cast, get_args

from supertokens_python import SupertokensConfig, is_recipe_initialized
from supertokens_python.framework.request import BaseRequest
from supertokens_python.framework.response import BaseResponse
from supertokens_python.recipe.session import SessionContainer
from supertokens_python.recipe.session import asyncio as session_asyncio
from supertokens_python.types.base import UserContext

import supertokens_rownd.telemetry.create_telemetry_client as telemetry

from . import config as rownd_config
from . import rownd_compatibility as compatibility
from . import supertokens_repository as repository
from . import utils
from .admin_planning import AdministrativePolicyError
from .admin_validation import resolve_consolidated_token_owner
from .constants import GUEST_AUTH_METHOD_ID, INSTANT_AUTH_METHOD_ID
from .errors import MigrationError, MigrationErrorReason, RowndEmailChangeError, RowndPluginError
from .logger import log_debug, log_warning
from .migration import create_rownd_identity_snapshot
from .migration_authority import (
    _bind_authenticated_source,
    assert_source_authority,
    assert_source_not_superseded_in_phase,
    has_authenticated_source,
)
from .rownd_repository import (
    RowndAPIError,
    RowndAPIErrorReason,
    RowndTokenValidationError,
    RowndTokenValidationReason,
)
from .session_authentication import proven_session_authentication
from .types import JsonDict, MigrationStage, RowndClientProtocol, RowndPluginConfig, RowndTelemetryClient


_logger = logging.getLogger(__name__)


_TOKEN_REASON_MAP = {
    RowndTokenValidationReason.TOKEN_MALFORMED: MigrationErrorReason.TOKEN_MALFORMED,
    RowndTokenValidationReason.TOKEN_EXPIRED: MigrationErrorReason.TOKEN_EXPIRED,
    RowndTokenValidationReason.TOKEN_NOT_ACTIVE: MigrationErrorReason.TOKEN_NOT_ACTIVE,
    RowndTokenValidationReason.TOKEN_CLAIMS_INVALID: MigrationErrorReason.TOKEN_CLAIMS_INVALID,
    RowndTokenValidationReason.TOKEN_KID_UNKNOWN: MigrationErrorReason.TOKEN_KID_UNKNOWN,
    RowndTokenValidationReason.TOKEN_SIGNATURE_INVALID: MigrationErrorReason.TOKEN_SIGNATURE_INVALID,
    RowndTokenValidationReason.JWKS_FETCH_FAILED: MigrationErrorReason.ROWND_UNAVAILABLE,
    RowndTokenValidationReason.JWKS_INVALID_RESPONSE: MigrationErrorReason.ROWND_UNAVAILABLE,
    RowndTokenValidationReason.JWKS_REFRESH_SUPPRESSED: MigrationErrorReason.ROWND_UNAVAILABLE,
}

_ROWND_API_REASON_MAP = {
    RowndAPIErrorReason.USER_NOT_FOUND: MigrationErrorReason.ROWND_USER_NOT_FOUND,
    RowndAPIErrorReason.AUTHORIZATION_REJECTED: MigrationErrorReason.ROWND_UNAVAILABLE,
    RowndAPIErrorReason.CREDENTIALS_REJECTED: MigrationErrorReason.PLUGIN_CONFIGURATION_INVALID,
    RowndAPIErrorReason.APP_CONFIG_INVALID: MigrationErrorReason.PLUGIN_CONFIGURATION_INVALID,
    RowndAPIErrorReason.PROFILE_INVALID: MigrationErrorReason.SOURCE_IDENTITY_INVALID,
    RowndAPIErrorReason.UNAVAILABLE: MigrationErrorReason.ROWND_UNAVAILABLE,
    RowndAPIErrorReason.INVALID_RESPONSE: MigrationErrorReason.ROWND_UNAVAILABLE,
}


def migration_error_response(error: MigrationError, operation_id: str) -> JsonDict:
    return {
        "status": "ERROR",
        "code": error.http_status,
        "reason": error.reason.value,
        "message": error.public_message,
        "retryable": error.retryable,
        "stage": error.stage,
        "operationId": operation_id,
    }


def _rownd_api_migration_error(error: RowndAPIError, stage: MigrationStage) -> MigrationError:
    reason = _ROWND_API_REASON_MAP[error.reason]
    error_stage: MigrationStage = (
        "source_normalize" if error.reason is RowndAPIErrorReason.PROFILE_INVALID else stage
    )
    return MigrationError(reason, error_stage, error)


async def handle_validate_passwordless_confirmation_bypass(
    config: RowndPluginConfig, request: BaseRequest, response: BaseResponse
) -> BaseResponse:
    try:
        body = await utils.get_json_body(request)
        client_domain = utils.optional_string(body.get("clientDomain"))
        redirect_to_path = utils.optional_string(body.get("redirectToPath"))
        app_variant_id = utils.optional_string(body.get("appVariantId"))
        rownd_config.assert_app_variant_is_configured(config, app_variant_id)
        resolved_client_domain = utils.resolve_allowed_client_domain(
            config, config.website_domain or None, client_domain
        )
        normalized_redirect_to_path = utils.normalize_redirect_to_path_for_client_domain(
            redirect_to_path, resolved_client_domain
        )
        utils.assert_allowed_bypass_redirect_path(config, normalized_redirect_to_path)
        return utils.json_response(response, {"status": "OK", "bypass": True})
    except Exception:
        log_debug(config, "code=confirmation_bypass_failed")
        return utils.json_response(response, {"status": "ERROR", "bypass": False})


async def handle_app_config(
    config: RowndPluginConfig, request: BaseRequest, response: BaseResponse
) -> BaseResponse:
    app_variant_id = utils.get_requested_app_variant_id_from_request(request)
    app_config = rownd_config.build_app_config(config, app_variant_id)
    if app_config is None:
        message = "Unknown Rownd app variant: %s" % app_variant_id
        log_warning(config, "Unknown Rownd app variant")
        return utils.json_response(
            response,
            {"status": "ERROR", "reason": "UNKNOWN_APP_VARIANT", "message": message},
            400,
        )
    return utils.json_response(response, {"status": "OK", **app_config})


async def handle_guest_login(
    config: RowndPluginConfig,
    telemetry_client: RowndTelemetryClient,
    request: BaseRequest,
    response: BaseResponse,
    user_context: UserContext,
) -> BaseResponse:
    started_at = time.time()
    tenant_id = utils.resolve_tenant_id(request)
    try:
        config = await rownd_config.resolve_plugin_config_snapshot(config, tenant_id, request, user_context)
        body = await utils.get_json_body(request)
        app_variant_id = utils.get_requested_app_variant_id_from_request(request)
        rownd_config.assert_app_variant_is_configured(config, app_variant_id)
        third_party_id = (
            INSTANT_AUTH_METHOD_ID
            if body.get("auth_level") == INSTANT_AUTH_METHOD_ID
            else GUEST_AUTH_METHOD_ID
        )
        if not rownd_config.is_anonymous_sign_in_enabled(config, third_party_id, app_variant_id):
            return utils.json_response(response, {
                "status": "ERROR",
                "message": "%s sign-in is not enabled" % third_party_id.capitalize(),
            })
        third_party_user_id = "%s_%s" % (
            "anon" if third_party_id == INSTANT_AUTH_METHOD_ID else "guest",
            uuid.uuid4(),
        )
        with rownd_config.bind_request_config(config):
            result = await repository.create_guest_session(
                config,
                request,
                tenant_id,
                third_party_id,
                third_party_user_id,
                third_party_id,
                app_variant_id,
                user_context,
            )
        await telemetry.record_success(telemetry_client, started_at, tenant_id, None, result.user.id)
        return utils.json_response(
            response, {"status": "OK", "createdNewRecipeUser": result.created_new_recipe_user}
        )
    except Exception as err:
        log_debug(config, "code=guest_login_failed")
        await telemetry.record_error(telemetry_client, started_at, err, tenant_id)
        return utils.json_response(response, {"status": "ERROR", "message": "Guest login failed"})


async def _resolve_consolidated_owner(
    rownd_user_id: str,
    tenant_id: str,
    user_context: UserContext,
    fetch_fresh_profile: Callable[[str], Awaitable[Optional[JsonDict]]],
) -> Optional[dict[str, Any]]:
    try:
        return await resolve_consolidated_token_owner(
            rownd_user_id, tenant_id, user_context, fetch_fresh_profile,
        )
    except (MigrationError, AdministrativePolicyError):
        raise
    except Exception as error:
        reason = (MigrationErrorReason.CORE_UNAVAILABLE
                  if repository._is_recognizable_core_outage(error)
                  else MigrationErrorReason.INTERNAL_ERROR)
        raise MigrationError(reason, "state_inspect", error) from error


async def _create_consolidated_alias_session(
    config: RowndPluginConfig,
    source: repository.FreshMigrationSource,
    owner: dict[str, Any],
    request: BaseRequest,
    response: BaseResponse,
    tenant_id: str,
    app_variant_id: Optional[str],
    user_context: UserContext,
    migration_state: JsonDict,
    read_fresh_source: Callable[[], Awaitable[Optional[repository.FreshMigrationSource]]],
    fetch_fresh_profile: Callable[[str], Awaitable[Optional[JsonDict]]],
) -> None:
    async def validated_profile(rownd_id: str) -> Optional[JsonDict]:
        if rownd_id != source.snapshot.rownd_user_id:
            return await fetch_fresh_profile(rownd_id)
        fresh = await read_fresh_source()
        if fresh is None or not has_authenticated_source(fresh):
            raise MigrationError(MigrationErrorReason.SOURCE_IDENTITY_INVALID, "state_inspect")
        assert_source_authority(fresh)
        if fresh.snapshot != source.snapshot:
            raise MigrationError(MigrationErrorReason.SOURCE_IDENTITY_INVALID, "state_inspect")
        return fresh.rownd_user

    async def validate_binding() -> None:
        await validated_profile(source.snapshot.rownd_user_id)
        resolved = await _resolve_consolidated_owner(
            source.snapshot.rownd_user_id, tenant_id, user_context, validated_profile,
        )
        if resolved is None or any(resolved[key] != owner[key] for key in ("target", "canonical_rownd_id")):
            raise MigrationError(MigrationErrorReason.MAPPING_CONFLICT, "state_inspect")
        if resolved["recipe_user_id"].get_as_string() != owner["recipe_user_id"].get_as_string():
            raise MigrationError(MigrationErrorReason.MAPPING_CONFLICT, "state_inspect")

    if not has_authenticated_source(source):
        raise MigrationError(MigrationErrorReason.SOURCE_IDENTITY_INVALID, "state_inspect")
    assert_source_authority(source)
    canonical_id = owner["canonical_rownd_id"]
    await repository.record_rownd_app_variant_for_user(config, canonical_id, app_variant_id, user_context)
    claims = await repository.build_rownd_session_claims(config, canonical_id, {}, app_variant_id, user_context)
    await validate_binding()
    session = None
    try:
        # The credential proof remains bound to the JWT subject, never the canonical profile.
        with proven_session_authentication():
            session = await session_asyncio.create_new_session(
                request, tenant_id, owner["recipe_user_id"], claims, {},
                utils.create_derived_user_context(user_context, {"rowndAppVariantId": app_variant_id}),
            )
        await validate_binding()
        if (session.get_user_id(user_context) != canonical_id
                or session.get_recipe_user_id(user_context).get_as_string() != owner["recipe_user_id"].get_as_string()
                or session.get_tenant_id(user_context) != tenant_id):
            raise MigrationError(MigrationErrorReason.SESSION_CREATION_FAILED, "session_create")
    except Exception as error:
        if session is not None:
            with suppress(Exception):
                await session.revoke_session(user_context)
        repository.scrub_migration_session_response(response, request)
        if isinstance(error, (MigrationError, AdministrativePolicyError)):
            raise
        raise MigrationError(MigrationErrorReason.SESSION_CREATION_FAILED, "session_create", error) from error
    migration_state.update(path="consolidated_alias", supertokens_user_id=canonical_id)


async def handle_migrate(
    config: RowndPluginConfig,
    client: RowndClientProtocol,
    telemetry_client: RowndTelemetryClient,
    supertokens_config: SupertokensConfig,
    request: BaseRequest,
    response: BaseResponse,
    user_context: UserContext,
) -> BaseResponse:
    started_at = time.time()
    operation_id = str(uuid.uuid4())
    stage: MigrationStage = "request_parse"
    tenant_id: Optional[str] = None
    rownd_user_id = None
    migration_state: JsonDict = {}
    migration_error: Optional[MigrationError] = None
    terminal_outcome = "error"
    terminal_http_status = 500
    terminal_retryable = True
    terminal_reason: Optional[MigrationErrorReason] = MigrationErrorReason.INTERNAL_ERROR
    try:
        token = utils.parse_migration_authorization_header(request)
        stage = "configuration"
        tenant_id = utils.resolve_tenant_id(request)
        app_variant_id = utils.get_requested_app_variant_id_from_request(request)
        rownd_config.assert_app_variant_is_configured(config, app_variant_id)
        stage = "token_validate"
        try:
            rownd_user_id = await client.validate_token(token)
        except RowndTokenValidationError as err:
            reason = _TOKEN_REASON_MAP.get(err.reason)
            if reason is None:
                raise MigrationError(MigrationErrorReason.INTERNAL_ERROR, stage, err) from err
            raise MigrationError(reason, stage, err) from err
        except RowndAPIError as err:
            raise _rownd_api_migration_error(err, stage) from err
        if not isinstance(rownd_user_id, str) or not rownd_user_id.strip():
            raise MigrationError(MigrationErrorReason.TOKEN_CLAIMS_INVALID, stage)
        stage = "rownd_profile_fetch"

        async def fetch_fresh_profile(profile_id: str) -> Optional[JsonDict]:
            try:
                return await client.fetch_optional_user_info(profile_id)
            except RowndAPIError as err:
                raise _rownd_api_migration_error(err, "rownd_profile_fetch") from err
            except MigrationError:
                raise
            except Exception as err:
                raise MigrationError(
                    MigrationErrorReason.ROWND_UNAVAILABLE, "rownd_profile_fetch", err
                ) from err

        rownd_user = await fetch_fresh_profile(rownd_user_id)
        if rownd_user is None:
            raise MigrationError(
                MigrationErrorReason.ROWND_USER_NOT_FOUND, "rownd_profile_fetch"
            )
        stage = "source_normalize"
        snapshot = create_rownd_identity_snapshot(rownd_user, tenant_id, app_variant_id, config.schema)
        if snapshot.rownd_user_id != rownd_user_id:
            raise MigrationError(MigrationErrorReason.ROWND_USER_ID_MISMATCH, stage)
        source = _bind_authenticated_source(repository.FreshMigrationSource(
            rownd_user,
            snapshot,
        ))

        async def read_fresh_source() -> Optional[repository.FreshMigrationSource]:
            fresh_user = await fetch_fresh_profile(cast(str, rownd_user_id))
            if fresh_user is None:
                return None
            fresh_snapshot = create_rownd_identity_snapshot(
                fresh_user, tenant_id, app_variant_id, config.schema
            )
            if fresh_snapshot.rownd_user_id != rownd_user_id:
                raise MigrationError(
                    MigrationErrorReason.ROWND_USER_ID_MISMATCH, "source_normalize"
                )
            return _bind_authenticated_source(repository.FreshMigrationSource(
                fresh_user,
                fresh_snapshot,
            ))

        stage = "state_inspect"
        from .migration_plan import read_completed_migration, create_completed_session

        plan = await read_completed_migration(config, source, user_context)
        owner = None
        if plan is None:
            # The entry reader already opened this fresh, read-only SDK phase.
            # Keep its literal reads through conservative fallback discovery.
            await assert_source_not_superseded_in_phase(rownd_user_id, user_context)
            owner = await _resolve_consolidated_owner(
                rownd_user_id, tenant_id, user_context, fetch_fresh_profile,
            )
        if plan is not None:
            result = await create_completed_session(config, source, plan, request, response, user_context)
            migration_state.update(path="already_complete", target_source="mapping", supertokens_user_id=result)
        elif owner is not None:
            await _create_consolidated_alias_session(
                config, source, owner, request, response, tenant_id, app_variant_id,
                user_context, migration_state, read_fresh_source, fetch_fresh_profile,
            )
        else:
            await repository.migrate_rownd_user_and_create_session(
                config,
                rownd_user_id,
                source,
                supertokens_config,
                request,
                response,
                tenant_id,
                app_variant_id,
                user_context,
                migration_state,
                read_fresh_source,
            )
        stage = "session_create"
        result = utils.json_response(response, {"status": "OK"})
        terminal_outcome = "success"
        terminal_http_status = 200
        terminal_retryable = False
        terminal_reason = None
        return result
    except asyncio.CancelledError:
        terminal_outcome = "cancelled"
        terminal_http_status = 499
        terminal_retryable = True
        terminal_reason = None
        raise
    except Exception as err:
        migration_error = (
            err
            if isinstance(err, MigrationError)
            else MigrationError(
                MigrationErrorReason.MIGRATION_STATE_INVALID
                if isinstance(err, AdministrativePolicyError) else MigrationErrorReason.INTERNAL_ERROR,
                stage, err,
            )
        )
        terminal_http_status = migration_error.http_status
        terminal_retryable = migration_error.retryable
        terminal_reason = migration_error.reason
        try:
            return utils.json_response(
                response,
                migration_error_response(migration_error, operation_id),
                migration_error.http_status,
            )
        except asyncio.CancelledError:
            terminal_outcome = "cancelled"
            terminal_http_status = 499
            terminal_retryable = True
            terminal_reason = None
            raise
    finally:
        terminal_stage = migration_error.stage if migration_error is not None else stage
        # Reject custom string rendering as well as values outside the closed stage set.
        if type(terminal_stage) is not str or terminal_stage not in get_args(MigrationStage):
            terminal_stage = stage
        _logger.log(
            logging.WARNING if terminal_outcome == "error" else logging.INFO,
            "RowndMigrationPlugin: Migration terminal: "
            "operationId=%s outcome=%s stage=%s reason=%s retryable=%s",
            operation_id,
            terminal_outcome,
            terminal_stage,
            terminal_reason.value if terminal_reason is not None else "none",
            terminal_retryable,
        )
        await telemetry.record_migration_terminal(
            telemetry_client,
            started_at,
            operation_id,
            terminal_outcome,
            terminal_stage,
            terminal_http_status,
            terminal_retryable,
            migration_state,
            terminal_reason,
        )


def require_session(session: Optional[SessionContainer]) -> SessionContainer:
    if session is None:
        raise RowndPluginError("Session not found")
    return session


async def handle_signout(
    session: Optional[SessionContainer], response: BaseResponse, user_context: UserContext
) -> BaseResponse:
    session = require_session(session)
    await repository.revoke_all_user_sessions(session, user_context)
    return utils.json_response(response, {"status": "OK"})


async def handle_get_user(
    config: RowndPluginConfig,
    session: Optional[SessionContainer],
    response: BaseResponse,
    user_context: UserContext,
) -> BaseResponse:
    session = require_session(session)
    user = await repository.get_rownd_compat_user(
        session.get_user_id(user_context),
        config,
        session.get_tenant_id(user_context),
        user_context=user_context,
    )
    return utils.json_response(response, {"status": "OK", **user})


async def _get_current_email(
    config: RowndPluginConfig, session: SessionContainer, user_context: UserContext
) -> object:
    user = await repository.get_rownd_compat_user(
        session.get_user_id(user_context),
        config,
        session.get_tenant_id(user_context),
        user_context=user_context,
    )
    return rownd_config.as_json_dict(user.get("data")).get("email")


async def validate_email_change_session(
    config: RowndPluginConfig,
    session: SessionContainer,
    app_variant_id: Optional[str],
    user_context: UserContext,
) -> Optional[JsonDict]:
    if not rownd_config.is_email_sign_in_enabled(config, app_variant_id):
        return {"status": "ERROR", "code": 403, "message": "email sign-in is not enabled"}
    if not is_recipe_initialized("passwordless") or not is_recipe_initialized("emailverification"):
        return {"status": "ERROR", "code": 503, "message": "email sign-in is not available"}
    session_age_ms = time.time() * 1000 - await session.get_time_created(user_context)
    max_session_age = config.email_change.get("max_session_age_seconds", 600)
    if session_age_ms > cast(float, max_session_age) * 1000:
        return recent_authentication_required_response()
    return None


def recent_authentication_required_response() -> JsonDict:
    return {
        "status": "ERROR",
        "code": 403,
        "message": "recent authentication is required to change email",
    }


async def _validate_email_change(
    config: RowndPluginConfig,
    session: SessionContainer,
    email: str,
    app_variant_id: Optional[str],
    context: UserContext,
    lookup_user_context: UserContext,
) -> tuple[bool, Optional[JsonDict]]:
    current_email = await _get_current_email(config, session, lookup_user_context)
    changes_email = not isinstance(current_email, str) or repository.normalize_email(
        current_email
    ) != repository.normalize_email(email)
    if not changes_email:
        return False, None
    if utils.native_email_verification_upgrade_required(context):
        return True, utils.native_email_verification_upgrade_required_response()
    return True, await validate_email_change_session(config, session, app_variant_id, context)


async def handle_update_user(
    config: RowndPluginConfig,
    request: BaseRequest,
    response: BaseResponse,
    session: Optional[SessionContainer],
    user_context: UserContext,
) -> BaseResponse:
    session = require_session(session)
    app_variant_id = utils.get_requested_app_variant_id_from_request(request)
    rownd_config.assert_app_variant_is_configured(config, app_variant_id)
    body = await utils.get_json_body(request)
    data = rownd_config.as_json_dict(body.get("data"))
    email = data.get("email")
    if "email" in data and (not isinstance(email, str) or not email.strip()):
        return utils.json_response(
            response,
            {"status": "ERROR", "code": 400, "message": "email must be a non-empty string"},
            400,
        )
    data_without_email = {key: value for key, value in data.items() if key != "email"}
    permission_error = compatibility.validate_writable_fields(
        config, list(data_without_email.keys())
    )
    if permission_error:
        code = permission_error.get("code")
        return utils.json_response(
            response, permission_error, code if isinstance(code, int) else 400
        )
    if isinstance(email, str):
        context = utils.build_email_change_user_context(
            user_context, rownd_config.as_json_dict(body.get("context"))
        )
        if app_variant_id:
            context["rowndAppVariantId"] = app_variant_id
        changes_email, session_error = await _validate_email_change(
            config, session, email, app_variant_id, context, user_context
        )
        if session_error:
            code = cast(int, session_error["code"])
            return utils.json_response(response, session_error, code)
        try:
            pending_result = await repository.start_pending_email_verification(
                config, session, email, context
            )
            update_result = (
                await repository.update_user_data(
                    config,
                    session.get_user_id(user_context),
                    data_without_email,
                    session.get_tenant_id(user_context),
                    user_context,
                )
                if data_without_email
                else pending_result
            )
            return utils.json_response(
                response,
                {
                    "status": "OK",
                    **update_result,
                    "email_verification_pending": changes_email,
                },
            )
        except RowndEmailChangeError as error:
            return utils.json_response(
                response,
                {"status": "ERROR", "code": error.http_status, "message": str(error)},
                error.http_status,
            )
    if data_without_email:
        await repository.update_user_data(
            config,
            session.get_user_id(user_context),
            data_without_email,
            session.get_tenant_id(user_context),
            user_context,
        )
    user = await repository.get_rownd_compat_user(
        session.get_user_id(user_context),
        config,
        session.get_tenant_id(user_context),
        user_context=user_context,
    )
    return utils.json_response(response, {"status": "OK", **user})


async def handle_delete_user(
    session: Optional[SessionContainer], response: BaseResponse, user_context: UserContext
) -> BaseResponse:
    session = require_session(session)
    await repository.delete_user_and_linked_accounts(session.get_user_id(user_context), user_context)
    return utils.json_response(response, {"status": "OK"})


async def handle_get_user_meta(
    session: Optional[SessionContainer], response: BaseResponse, user_context: UserContext
) -> BaseResponse:
    session = require_session(session)
    user_id = session.get_user_id(user_context)
    metadata = await repository.get_user_metadata(user_id, user_context)
    return utils.json_response(
        response,
        {"status": "OK", "id": user_id, "meta": compatibility.public_metadata(metadata)},
    )


async def handle_update_user_meta(
    request: BaseRequest,
    response: BaseResponse,
    session: Optional[SessionContainer],
    user_context: UserContext,
) -> BaseResponse:
    session = require_session(session)
    meta = rownd_config.as_json_dict((await utils.get_json_body(request)).get("meta"))
    internal_field = next(
        (key for key in meta if compatibility.is_internal_metadata_field(key)), None
    )
    if internal_field:
        return utils.json_response(
            response,
            {
                "status": "ERROR",
                "code": 403,
                "message": "field is not writable: %s" % internal_field,
            },
            403,
        )
    updated = await repository.update_user_metadata(
        session.get_user_id(user_context), meta, user_context
    )
    return utils.json_response(response, {"status": "OK", **updated})


async def handle_get_user_field(
    config: RowndPluginConfig,
    request: BaseRequest,
    response: BaseResponse,
    session: Optional[SessionContainer],
    user_context: UserContext,
) -> BaseResponse:
    session = require_session(session)
    field_name = request.get_query_param("field")
    if not field_name:
        return utils.json_response(response, compatibility.missing_field_response(), 400)
    user = await repository.get_rownd_compat_user(
        session.get_user_id(user_context),
        config,
        session.get_tenant_id(user_context),
        user_context=user_context,
    )
    return utils.json_response(
        response,
        {"status": "OK", "value": rownd_config.as_json_dict(user.get("data")).get(field_name)},
    )


async def handle_update_user_field(
    config: RowndPluginConfig,
    request: BaseRequest,
    response: BaseResponse,
    session: Optional[SessionContainer],
    user_context: UserContext,
) -> BaseResponse:
    session = require_session(session)
    field_name = request.get_query_param("field")
    if not field_name:
        return utils.json_response(response, compatibility.missing_field_response(), 400)
    app_variant_id = utils.get_requested_app_variant_id_from_request(request)
    rownd_config.assert_app_variant_is_configured(config, app_variant_id)
    body = await utils.get_json_body(request)
    value = body.get("value")
    if field_name == "email":
        if not isinstance(value, str) or not value.strip():
            return utils.json_response(
                response,
                {"status": "ERROR", "code": 400, "message": "email must be a non-empty string"},
                400,
            )
        context = utils.build_email_change_user_context(
            user_context, rownd_config.as_json_dict(body.get("context"))
        )
        if app_variant_id:
            context["rowndAppVariantId"] = app_variant_id
        changes_email, session_error = await _validate_email_change(
            config, session, value, app_variant_id, context, user_context
        )
        if session_error:
            code = cast(int, session_error["code"])
            return utils.json_response(response, session_error, code)
        try:
            user = await repository.start_pending_email_verification(
                config, session, value, context
            )
            return utils.json_response(
                response,
                {"status": "OK", **user, "email_verification_pending": changes_email},
            )
        except RowndEmailChangeError as error:
            return utils.json_response(
                response,
                {"status": "ERROR", "code": error.http_status, "message": str(error)},
                error.http_status,
            )
    permission_error = compatibility.validate_writable_fields(config, [field_name])
    if permission_error:
        code = permission_error.get("code")
        return utils.json_response(
            response, permission_error, code if isinstance(code, int) else 400
        )
    user = await repository.update_user_data(
        config,
        session.get_user_id(user_context),
        {field_name: value},
        session.get_tenant_id(user_context),
        user_context,
    )
    return utils.json_response(response, {"status": "OK", **user})

from __future__ import annotations

import asyncio
import time
import uuid
from typing import Optional, cast

from supertokens_python import SupertokensConfig, is_recipe_initialized
from supertokens_python.framework.request import BaseRequest
from supertokens_python.framework.response import BaseResponse
from supertokens_python.recipe.session import SessionContainer
from supertokens_python.types.base import UserContext

import supertokens_rownd.telemetry.create_telemetry_client as telemetry

from . import config as rownd_config
from . import rownd_compatibility as compatibility
from . import supertokens_repository as repository
from . import utils
from .constants import GUEST_AUTH_METHOD_ID, INSTANT_AUTH_METHOD_ID
from .errors import MigrationError, MigrationErrorReason, RowndEmailChangeError, RowndPluginError
from .logger import log_debug
from .migration import create_rownd_identity_snapshot
from .rownd_repository import (
    RowndAPIError,
    RowndAPIErrorReason,
    RowndTokenValidationError,
    RowndTokenValidationReason,
)
from .types import JsonDict, MigrationStage, RowndClientProtocol, RowndPluginConfig, RowndTelemetryClient


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
    except Exception as err:
        log_debug(config, "Passwordless confirmation bypass validation failed: %s" % err)
        return utils.json_response(response, {"status": "ERROR", "bypass": False})


async def handle_app_config(
    config: RowndPluginConfig, request: BaseRequest, response: BaseResponse
) -> BaseResponse:
    app_variant_id = utils.get_requested_app_variant_id_from_request(request)
    app_config = rownd_config.build_app_config(config, app_variant_id)
    if app_config is None:
        return utils.json_response(
            response,
            {"status": "ERROR", "message": "Unknown Rownd app variant: %s" % app_variant_id},
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
        body = await utils.get_json_body(request)
        app_variant_id = utils.get_requested_app_variant_id_from_request(request)
        rownd_config.assert_app_variant_is_configured(config, app_variant_id)
        third_party_id = (
            INSTANT_AUTH_METHOD_ID
            if body.get("auth_level") == INSTANT_AUTH_METHOD_ID
            else GUEST_AUTH_METHOD_ID
        )
        third_party_user_id = "%s_%s" % (
            "anon" if third_party_id == INSTANT_AUTH_METHOD_ID else "guest",
            uuid.uuid4(),
        )
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
        log_debug(config, "Guest login failed: %s" % err)
        await telemetry.record_error(telemetry_client, started_at, err, tenant_id)
        return utils.json_response(response, {"status": "ERROR", "message": "Guest login failed"})


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
        try:
            rownd_user = await client.fetch_optional_user_info(rownd_user_id)
        except RowndAPIError as err:
            raise _rownd_api_migration_error(err, stage) from err
        except MigrationError:
            raise
        except Exception as err:
            raise MigrationError(MigrationErrorReason.ROWND_UNAVAILABLE, stage, err) from err
        if rownd_user is None:
            raise MigrationError(
                MigrationErrorReason.ROWND_USER_NOT_FOUND, "rownd_profile_fetch"
            )
        stage = "source_normalize"
        snapshot = create_rownd_identity_snapshot(rownd_user, tenant_id, app_variant_id, config.schema)
        if snapshot.rownd_user_id != rownd_user_id:
            raise MigrationError(MigrationErrorReason.ROWND_USER_ID_MISMATCH, stage)
        source = repository.FreshMigrationSource(
            rownd_user,
            snapshot,
        )

        async def read_fresh_source() -> Optional[repository.FreshMigrationSource]:
            try:
                fresh_user = await client.fetch_optional_user_info(cast(str, rownd_user_id))
            except RowndAPIError as err:
                raise _rownd_api_migration_error(err, "rownd_profile_fetch") from err
            except MigrationError:
                raise
            except Exception as err:
                raise MigrationError(
                    MigrationErrorReason.ROWND_UNAVAILABLE, "rownd_profile_fetch", err
                ) from err
            if fresh_user is None:
                return None
            fresh_snapshot = create_rownd_identity_snapshot(
                fresh_user, tenant_id, app_variant_id, config.schema
            )
            if fresh_snapshot.rownd_user_id != rownd_user_id:
                raise MigrationError(
                    MigrationErrorReason.ROWND_USER_ID_MISMATCH, "source_normalize"
                )
            return repository.FreshMigrationSource(
                fresh_user,
                fresh_snapshot,
            )

        stage = "state_inspect"
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
            else MigrationError(MigrationErrorReason.INTERNAL_ERROR, stage, err)
        )
        log_debug(
            config,
            "Migration failed. operationId: %s, stage: %s, reason: %s"
            % (operation_id, migration_error.stage, migration_error.reason.value),
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
        await telemetry.record_migration_terminal(
            telemetry_client,
            started_at,
            operation_id,
            terminal_outcome,
            migration_error.stage if migration_error is not None else stage,
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

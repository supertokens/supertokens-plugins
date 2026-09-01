from __future__ import annotations

import math
import re
import warnings
from collections.abc import Callable
from typing import Any, Generic, NamedTuple, Optional, TypeVar, cast
from typing_extensions import Unpack
from urllib.parse import parse_qsl, quote, urlencode, urlparse, urlunparse

from supertokens_python.framework.request import BaseRequest
from supertokens_python.framework.response import BaseResponse
from supertokens_python.ingredients.emaildelivery.types import (
    EmailDeliveryConfig,
    EmailDeliveryInterface,
)
from supertokens_python.ingredients.smsdelivery.types import SMSDeliveryConfig, SMSDeliveryInterface
from supertokens_python.plugins import (
    OverrideMap,
    PluginRouteHandler,
    PluginRouteHandlerFunctionOkResponse,
    RecipePluginOverride,
    SuperTokensPlugin,
    VerifySessionOptions,
)
from supertokens_python.recipe.accountlinking.types import (
    AccountInfoWithRecipeIdAndUserId,
    AccountLinkingOverrideableConfig,
    ShouldAutomaticallyLink,
    ShouldNotAutomaticallyLink,
)
from supertokens_python.recipe.emailverification import EmailVerificationClaim
from supertokens_python.recipe.emailverification.interfaces import (
    APIInterface as EmailVerificationAPIInterface,
    APIOptions as EmailVerificationAPIOptions,
)
from supertokens_python.recipe.emailverification.types import EmailTemplateVars
from supertokens_python.recipe.emailverification.utils import EmailVerificationOverrideableConfig
from supertokens_python.recipe.oauth2provider.interfaces import (
    APIInterface as OAuth2ProviderAPIInterface,
    RecipeInterface as OAuth2ProviderRecipeInterface,
)
from supertokens_python.recipe.passwordless.interfaces import (
    APIInterface as PasswordlessAPIInterface,
    APIOptions as PasswordlessAPIOptions,
    ConsumeCodeOkResult,
    ConsumeCodePostRestartFlowError,
    ConsumeCodeRestartFlowError,
    RecipeInterface as PasswordlessRecipeInterface,
    ResendCodePostRestartFlowError,
)
from supertokens_python.recipe.passwordless import asyncio as passwordless_asyncio
from supertokens_python.recipe.passwordless.types import (
    PasswordlessLoginEmailTemplateVars,
    PasswordlessLoginSMSTemplateVars,
)
from supertokens_python.recipe.passwordless.utils import PasswordlessOverrideableConfig
from supertokens_python.recipe.session import SessionContainer
from supertokens_python.recipe.session import asyncio as session_asyncio
from supertokens_python.recipe.session.claims import BooleanClaim
from supertokens_python.recipe.session.cookie_and_header import clear_session_response_mutator
from supertokens_python.recipe.session.interfaces import RecipeInterface as SessionRecipeInterface
from supertokens_python.recipe.thirdparty.interfaces import (
    APIInterface as ThirdPartyAPIInterface,
    APIOptions as ThirdPartyAPIOptions,
)
from supertokens_python.recipe.thirdparty.provider import Provider, RedirectUriInfo
from supertokens_python.types import RecipeUserId, User
from supertokens_python.types.base import AccountInfoInput, UserContext
from supertokens_python.types.recipe import BaseAPIInterface, BaseRecipeInterface
from supertokens_python.types.response import GeneralErrorResponse

from . import config as rownd_config
from . import supertokens_repository
from . import utils
from .constants import (
    GUEST_AUTH_METHOD_ID,
    HANDLE_BASE_PATH,
    INSTANT_AUTH_METHOD_ID,
    PASSWORDLESS_BYPASS_DEVICE_CONFIRMATION_PARAM,
    PENDING_EMAIL_VERIFICATION_QUERY_PARAM,
    PLUGIN_ID,
    PLUGIN_SDK_VERSION,
    PLUGIN_VERSION,
    PUBLIC_TENANT_ID,
    ROWND_JWT_CLAIMS,
    RESERVED_SESSION_CLAIMS,
)
from .config import (
    assert_app_variant_is_configured,
    set_active_rownd_config,
)
from .errors import RowndEmailChangeError, RowndPluginError
from .logger import log_warning
from .plugin_implementation import (
    handle_app_config,
    handle_delete_user,
    handle_get_user,
    handle_get_user_field,
    handle_get_user_meta,
    handle_guest_login,
    handle_migrate,
    handle_signout,
    handle_update_user,
    handle_update_user_field,
    handle_update_user_meta,
    handle_validate_passwordless_confirmation_bypass,
)
from .rownd_compatibility import (
    apply_rownd_oauth_resource_params,
    does_account_info_match_auth_method,
    get_effective_auth_level,
    has_only_guest_login_methods,
    has_verified_matching_email_login_method,
    is_guest_account_info,
    normalize_rownd_oauth_scopes,
    resolve_session_claim_name,
)
from .rownd_repository import RowndClient
from .supertokens_repository import (
    build_rownd_oauth_payload,
    build_rownd_oauth_user_info,
    build_rownd_session_and_anonymous_claims,
    complete_pending_email_verification,
    record_rownd_app_variant_for_user,
    resolve_pending_email_verification_token,
)
from .telemetry.create_telemetry_client import create_telemetry_client
from .types import RowndClientProtocol, RowndPluginConfig, RowndPluginKwargs
from .utils import (
    add_hub_bootstrap_params,
    add_pending_email_verification_marker,
    create_derived_user_context,
    get_pending_email_verification_id_from_user_context,
    get_requested_app_variant_id_from_request,
    get_requested_client_domain_from_request,
    get_requested_display_context_from_request,
    get_requested_oauth_login_challenge_from_request,
    get_requested_redirect_to_path_from_request,
)


TemplateVarsT = TypeVar("TemplateVarsT")


class _PasswordlessConsumePostcheck(NamedTuple):
    owner_user_id: str
    recipe_user_id: str


def _log_passwordless_authorization_diagnostic(
    config: RowndPluginConfig,
    operation: str,
    authorization: Optional[Any] = None,
    failure_code: Optional[str] = None,
) -> None:
    if config.email_change.get("retirement_mode", "observe") != "observe":
        return
    if failure_code is not None:
        log_warning(
            config,
            "Passwordless email authorization: operation=%s code=%s"
            % (operation, failure_code),
        )
    elif authorization is not None and not authorization.allowed:
        log_warning(
            config,
            "Passwordless email authorization: operation=%s code=classification_rejected "
            "state=%s reason=%s"
            % (operation, authorization.state.value, authorization.reason.value),
        )


async def create_magic_link_with_confirmation_bypass(
    email: Optional[str] = None,
    phone_number: Optional[str] = None,
    tenant_id: str = PUBLIC_TENANT_ID,
    session: Optional[SessionContainer] = None,
    user_context: Optional[UserContext] = None,
    redirect_to_path: Optional[str] = None,
    client_domain: Optional[str] = None,
    display_context: Optional[str] = None,
    app_variant_id: Optional[str] = None,
) -> str:
    has_email = isinstance(email, str) and len(email) > 0
    has_phone_number = isinstance(phone_number, str) and len(phone_number) > 0
    if has_email == has_phone_number:
        raise RowndPluginError("Exactly one of email or phone_number is required")

    config = rownd_config.get_active_rownd_config()
    rownd_config.assert_app_variant_is_configured(config, app_variant_id)
    resolved_client_domain = utils.resolve_allowed_client_domain(
        config, config.website_domain or None, client_domain
    )
    normalized_redirect_to_path = utils.normalize_redirect_to_path_for_client_domain(
        redirect_to_path, resolved_client_domain
    )
    utils.assert_allowed_bypass_redirect_path(config, normalized_redirect_to_path)
    context = utils.create_derived_user_context(
        user_context if user_context is not None else {},
        {
            "rowndDisplayContext": display_context,
            "rowndRedirectToPath": normalized_redirect_to_path,
            "rowndClientDomain": client_domain,
            "rowndAppVariantId": app_variant_id,
        },
    )
    if has_email:
        try:
            authorization = await supertokens_repository.authorize_passwordless_email(
                tenant_id,
                cast(str, email),
                context,
                expected_owner_user_id=(
                    session.get_user_id(context) if session is not None else None
                ),
            )
        except Exception:
            authorization = None
            _log_passwordless_authorization_diagnostic(
                config, "create", failure_code="classification_exception"
            )
        else:
            _log_passwordless_authorization_diagnostic(config, "create", authorization)
        if config.email_change.get("retirement_mode", "observe") == "guard" and (
            authorization is None or not authorization.allowed
        ):
            raise RowndPluginError("Passwordless request could not be completed")
    code_info = await passwordless_asyncio.create_code(
        tenant_id,
        email=email if has_email else None,
        phone_number=phone_number if has_phone_number else None,
        session=session,
        user_context=context,
    )
    website_domain = (config.website_domain or resolved_client_domain).rstrip("/")
    magic_link = "%s%s/verify?preAuthSessionId=%s&tenantId=%s#%s" % (
        website_domain,
        config.api_base_path,
        quote(code_info.pre_auth_session_id, safe=""),
        quote(tenant_id, safe=""),
        quote(code_info.link_code, safe=""),
    )
    rewritten_url = urlparse(
        utils.rewrite_magic_link(
            magic_link,
            resolved_client_domain,
            utils.get_magic_link_bootstrap_params(
                config,
                app_variant_id=app_variant_id,
                display_context=display_context,
                redirect_to_path=normalized_redirect_to_path,
                client_domain_key=client_domain,
                oauth_login_challenge=(
                    context["rowndOAuthLoginChallenge"]
                    if isinstance(context.get("rowndOAuthLoginChallenge"), str)
                    else None
                ),
            ),
        )
    )
    query = dict(parse_qsl(rewritten_url.query, keep_blank_values=True))
    query[PASSWORDLESS_BYPASS_DEVICE_CONFIRMATION_PARAM] = "true"
    return urlunparse(rewritten_url._replace(query=urlencode(query)))


async def _fetch_is_anonymous_claim(
    user_id: str,
    recipe_user_id: RecipeUserId,
    tenant_id: str,
    current_payload: dict[str, Any],
    user_context: UserContext,
) -> bool:
    from supertokens_python.asyncio import get_user

    _ = recipe_user_id, tenant_id, current_payload
    return get_effective_auth_level(await get_user(user_id, user_context)) in {
        GUEST_AUTH_METHOD_ID,
        INSTANT_AUTH_METHOD_ID,
    }


_rownd_is_anonymous_claim = BooleanClaim(key="is_anonymous", fetch_value=_fetch_is_anonymous_claim)


async def refresh_rownd_session_claims(
    config: RowndPluginConfig,
    session: SessionContainer,
    user_id: str,
    app_variant_id: Optional[str],
    user_context: UserContext,
) -> None:
    current_payload = session.get_access_token_payload(user_context)
    rownd_claims, is_anonymous_claim = await build_rownd_session_and_anonymous_claims(
        config, user_id, current_payload, app_variant_id, user_context
    )
    refreshed_claims = {**rownd_claims, **is_anonymous_claim}
    managed_claim_names = {
        "is_anonymous",
        ROWND_JWT_CLAIMS["is_anonymous"],
        "anonymous_id",
    }
    for field_name, field_config in config.schema.items():
        if field_config.get("include_in_session_claims") is True:
            claim_name = resolve_session_claim_name(field_name, field_config)
            if claim_name not in RESERVED_SESSION_CLAIMS:
                managed_claim_names.add(claim_name)
    for key in managed_claim_names:
        if key in current_payload and key not in refreshed_claims:
            refreshed_claims[key] = None
    await session.merge_into_access_token_payload(refreshed_claims, user_context)


async def _refresh_rownd_session_claims_or_revoke(
    config: RowndPluginConfig,
    session: SessionContainer,
    user_id: str,
    app_variant_id: Optional[str],
    user_context: UserContext,
) -> None:
    try:
        await refresh_rownd_session_claims(config, session, user_id, app_variant_id, user_context)
    except Exception:
        try:
            session_revoked = await session_asyncio.revoke_session(
                session.get_handle(user_context), user_context
            )
        except Exception:
            session_revoked = False
        if session_revoked is False:
            try:
                await session_asyncio.revoke_all_sessions_for_user(
                    user_id, True, None, user_context
                )
            except Exception:
                pass
        raise


def _append_clear_session_response_mutator(returned_session: Any) -> bool:
    req_res_info = getattr(returned_session, "req_res_info", None)
    response_mutators = getattr(returned_session, "response_mutators", None)
    config = getattr(returned_session, "config", None)
    if req_res_info is None or not isinstance(response_mutators, list) or config is None:
        return False
    try:
        response_mutators.append(
            clear_session_response_mutator(
                config,
                req_res_info.transfer_method,
                req_res_info.request,
            )
        )
    except Exception:
        return False
    return True


async def _revoke_and_clear_returned_session(
    returned_session: Any, user_context: UserContext
) -> bool:
    response_mutators = getattr(returned_session, "response_mutators", None)
    mutator_count = len(response_mutators) if isinstance(response_mutators, list) else None
    revoke_succeeded = False
    try:
        await returned_session.revoke_session(user_context)
        revoke_succeeded = True
    except Exception:
        pass
    clear_succeeded = (
        mutator_count is not None
        and isinstance(response_mutators, list)
        and len(response_mutators) > mutator_count
    )
    if not clear_succeeded:
        clear_succeeded = _append_clear_session_response_mutator(returned_session)
    return revoke_succeeded and clear_succeeded


class RowndEmailDeliveryOverride(Generic[TemplateVarsT], EmailDeliveryInterface[TemplateVarsT]):
    def __init__(
        self,
        original: EmailDeliveryInterface[TemplateVarsT],
        config: RowndPluginConfig,
        link_attr: str,
        target_path: str,
    ):
        self.original = original
        self.config = config
        self.link_attr = link_attr
        self.target_path = target_path

    async def send_email(self, template_vars: TemplateVarsT, user_context: UserContext) -> None:
        pending_verification_id = get_pending_email_verification_id_from_user_context(user_context)
        link = getattr(template_vars, self.link_attr, None)
        if pending_verification_id and self.link_attr == "email_verify_link":
            link = add_pending_email_verification_marker(link, pending_verification_id)
        setattr(
            template_vars,
            self.link_attr,
            add_hub_bootstrap_params(
                link,
                self.target_path,
                self.config,
                user_context,
                getattr(template_vars, "user_input_code", None),
                (
                    {PENDING_EMAIL_VERIFICATION_QUERY_PARAM: pending_verification_id}
                    if pending_verification_id
                    else None
                ),
            ),
        )
        await self.original.send_email(template_vars, user_context)


class RowndSMSDeliveryOverride(SMSDeliveryInterface[PasswordlessLoginSMSTemplateVars]):
    def __init__(
        self,
        original: SMSDeliveryInterface[PasswordlessLoginSMSTemplateVars],
        config: RowndPluginConfig,
    ):
        self.original = original
        self.config = config

    async def send_sms(
        self, template_vars: PasswordlessLoginSMSTemplateVars, user_context: UserContext
    ) -> None:
        template_vars.url_with_link_code = add_hub_bootstrap_params(
            getattr(template_vars, "url_with_link_code", None),
            "account/login",
            self.config,
            user_context,
            getattr(template_vars, "user_input_code", None),
        )
        await self.original.send_sms(template_vars, user_context)


def init(
    config: Optional[RowndPluginConfig] = None, **kwargs: Unpack[RowndPluginKwargs]
) -> SuperTokensPlugin:
    if config is None:
        config = RowndPluginConfig(**kwargs)
    elif kwargs:
        raise ValueError("Pass either RowndPluginConfig or keyword arguments, not both")
    if not isinstance(config.disable_rownd_user_migration, bool):
        raise ValueError("disable_rownd_user_migration must be a boolean in plugin config")
    if not config.disable_rownd_user_migration and (
        not config.rownd_app_key or not config.rownd_app_secret
    ):
        raise ValueError(
            "Missing rownd_app_key or rownd_app_secret in plugin config. "
            "Set disable_rownd_user_migration to true to disable migration."
        )
    if config.disable_rownd_user_migration and not config.rownd_app_key:
        config.rownd_app_key = "migration-disabled"

    config.api_base_path = _normalise_path(config.api_base_path)
    _validate_config(config)
    set_active_rownd_config(config)
    client = (
        None if config.disable_rownd_user_migration else config.rownd_client or RowndClient(config)
    )
    telemetry_client = create_telemetry_client(config)

    route_base = config.api_base_path + HANDLE_BASE_PATH
    plugin_config = config

    async def app_config_handler(
        request: BaseRequest,
        response: BaseResponse,
        session: Optional[SessionContainer],
        user_context: UserContext,
    ) -> BaseResponse:
        return await handle_app_config(config, request, response)

    async def guest_handler(
        request: BaseRequest,
        response: BaseResponse,
        session: Optional[SessionContainer],
        user_context: UserContext,
    ) -> BaseResponse:
        return await handle_guest_login(config, telemetry_client, request, response, user_context)

    async def migrate_handler(
        request: BaseRequest,
        response: BaseResponse,
        session: Optional[SessionContainer],
        user_context: UserContext,
    ) -> BaseResponse:
        from supertokens_python import Supertokens

        return await handle_migrate(
            config,
            cast(RowndClientProtocol, client),
            telemetry_client,
            Supertokens.get_instance().supertokens_config,
            request,
            response,
            user_context,
        )

    async def validate_passwordless_confirmation_bypass_handler(
        request: BaseRequest,
        response: BaseResponse,
        session: Optional[SessionContainer],
        user_context: UserContext,
    ) -> BaseResponse:
        return await handle_validate_passwordless_confirmation_bypass(config, request, response)

    async def signout_handler(
        request: BaseRequest,
        response: BaseResponse,
        session: Optional[SessionContainer],
        user_context: UserContext,
    ) -> BaseResponse:
        return await handle_signout(session, response, user_context)

    async def get_user_handler(
        request: BaseRequest,
        response: BaseResponse,
        session: Optional[SessionContainer],
        user_context: UserContext,
    ) -> BaseResponse:
        return await handle_get_user(config, session, response, user_context)

    async def update_user_handler(
        request: BaseRequest,
        response: BaseResponse,
        session: Optional[SessionContainer],
        user_context: UserContext,
    ) -> BaseResponse:
        return await handle_update_user(config, request, response, session, user_context)

    async def delete_user_handler(
        request: BaseRequest,
        response: BaseResponse,
        session: Optional[SessionContainer],
        user_context: UserContext,
    ) -> BaseResponse:
        return await handle_delete_user(session, response, user_context)

    async def get_user_meta_handler(
        request: BaseRequest,
        response: BaseResponse,
        session: Optional[SessionContainer],
        user_context: UserContext,
    ) -> BaseResponse:
        return await handle_get_user_meta(session, response, user_context)

    async def update_user_meta_handler(
        request: BaseRequest,
        response: BaseResponse,
        session: Optional[SessionContainer],
        user_context: UserContext,
    ) -> BaseResponse:
        return await handle_update_user_meta(request, response, session, user_context)

    async def get_user_field_handler(
        request: BaseRequest,
        response: BaseResponse,
        session: Optional[SessionContainer],
        user_context: UserContext,
    ) -> BaseResponse:
        return await handle_get_user_field(config, request, response, session, user_context)

    async def update_user_field_handler(
        request: BaseRequest,
        response: BaseResponse,
        session: Optional[SessionContainer],
        user_context: UserContext,
    ) -> BaseResponse:
        return await handle_update_user_field(config, request, response, session, user_context)

    rownd_user_session_required = VerifySessionOptions(
        session_required=True,
        check_database=True,
        override_global_claim_validators=_without_email_verification_claim_validator,
    )
    checked_session_required = VerifySessionOptions(session_required=True, check_database=True)

    passwordless_override = RecipePluginOverride()
    passwordless_override.config = _passwordless_config_override(config)
    passwordless_override.apis = cast(
        Callable[[BaseAPIInterface], BaseAPIInterface], _passwordless_api_override(config)
    )
    passwordless_override.functions = cast(
        Callable[[BaseRecipeInterface], BaseRecipeInterface],
        _passwordless_function_override(config),
    )

    thirdparty_override = RecipePluginOverride()
    thirdparty_override.apis = cast(
        Callable[[BaseAPIInterface], BaseAPIInterface], _thirdparty_api_override(config)
    )

    accountlinking_override = RecipePluginOverride()
    accountlinking_override.config = _accountlinking_config_override()
    accountlinking_override.recipe_init_required = True

    session_override = RecipePluginOverride()
    session_override.functions = cast(
        Callable[[BaseRecipeInterface], BaseRecipeInterface], _session_function_override(config)
    )
    session_override.recipe_init_required = True

    emailverification_override = RecipePluginOverride()
    emailverification_override.config = _emailverification_config_override(config)
    emailverification_override.apis = cast(
        Callable[[BaseAPIInterface], BaseAPIInterface], _emailverification_api_override()
    )
    emailverification_override.recipe_init_required = True

    oauth2provider_override = RecipePluginOverride()
    oauth2provider_override.functions = cast(
        Callable[[BaseRecipeInterface], BaseRecipeInterface],
        _oauth2provider_function_override(config),
    )
    oauth2provider_override.apis = cast(
        Callable[[BaseAPIInterface], BaseAPIInterface], _oauth2provider_api_override()
    )
    oauth2provider_override.recipe_init_required = False

    override_map: OverrideMap = {
        "oauth2provider": oauth2provider_override,
        "passwordless": passwordless_override,
        "thirdparty": thirdparty_override,
        "accountlinking": accountlinking_override,
        "session": session_override,
        "emailverification": emailverification_override,
    }

    if config.disable_rownd_user_migration:
        warnings.warn(
            "RowndMigrationPlugin: Rownd user and session migration is disabled.",
            stacklevel=2,
        )

    route_handlers = [
        PluginRouteHandler(
            method="get",
            path=route_base + "/app-config",
            handler=app_config_handler,
            verify_session_options=None,
        ),
        PluginRouteHandler(
            method="post",
            path=route_base + "/guest",
            handler=guest_handler,
            verify_session_options=None,
        ),
        PluginRouteHandler(
            method="post",
            path=plugin_config.api_base_path
            + "/plugin/passwordless-cross-device-confirmation/validate",
            handler=validate_passwordless_confirmation_bypass_handler,
            verify_session_options=None,
        ),
        PluginRouteHandler(
            method="post",
            path=route_base + "/signout",
            handler=signout_handler,
            verify_session_options=checked_session_required,
        ),
        PluginRouteHandler(
            method="get",
            path=route_base + "/user",
            handler=get_user_handler,
            verify_session_options=rownd_user_session_required,
        ),
        PluginRouteHandler(
            method="put",
            path=route_base + "/user",
            handler=update_user_handler,
            verify_session_options=rownd_user_session_required,
        ),
        PluginRouteHandler(
            method="delete",
            path=route_base + "/user",
            handler=delete_user_handler,
            verify_session_options=rownd_user_session_required,
        ),
        PluginRouteHandler(
            method="get",
            path=route_base + "/user/meta",
            handler=get_user_meta_handler,
            verify_session_options=rownd_user_session_required,
        ),
        PluginRouteHandler(
            method="put",
            path=route_base + "/user/meta",
            handler=update_user_meta_handler,
            verify_session_options=rownd_user_session_required,
        ),
        PluginRouteHandler(
            method="get",
            path=route_base + "/user/field",
            handler=get_user_field_handler,
            verify_session_options=rownd_user_session_required,
        ),
        PluginRouteHandler(
            method="put",
            path=route_base + "/user/field",
            handler=update_user_field_handler,
            verify_session_options=rownd_user_session_required,
        ),
    ]
    if not config.disable_rownd_user_migration:
        route_handlers.extend(
            [
                PluginRouteHandler(
                    method="post",
                    path=route_base + "/migrate",
                    handler=migrate_handler,
                    verify_session_options=None,
                ),
                PluginRouteHandler(
                    method="post",
                    path=plugin_config.api_base_path + "/plugin/migrate-session",
                    handler=migrate_handler,
                    verify_session_options=None,
                ),
            ]
        )

    return SuperTokensPlugin(
        id=PLUGIN_ID,
        version=PLUGIN_VERSION,
        compatible_sdk_versions=PLUGIN_SDK_VERSION,
        override_map=override_map,
        route_handlers=lambda config, all_plugins, sdk_version: (
            PluginRouteHandlerFunctionOkResponse(route_handlers=route_handlers)
        ),
    )


def _without_email_verification_claim_validator(
    global_claim_validators: list[Any], session: SessionContainer, user_context: UserContext
) -> list[Any]:
    return [
        validator
        for validator in global_claim_validators
        if getattr(getattr(validator, "claim", None), "key", None) != EmailVerificationClaim.key
    ]


def _oauth2provider_function_override(config: RowndPluginConfig):
    def override(original: OAuth2ProviderRecipeInterface) -> OAuth2ProviderRecipeInterface:
        original_get_requested_scopes = original.get_requested_scopes
        original_build_access_token_payload = original.build_access_token_payload
        original_build_id_token_payload = original.build_id_token_payload
        original_build_user_info = original.build_user_info

        async def get_requested_scopes(
            recipe_user_id: Optional[RecipeUserId],
            session_handle: Optional[str],
            scope_param: list[str],
            client_id: str,
            user_context: UserContext,
        ) -> list[str]:
            scopes = await original_get_requested_scopes(
                recipe_user_id,
                session_handle,
                scope_param,
                client_id,
                user_context,
            )
            return normalize_rownd_oauth_scopes(scopes)

        async def build_access_token_payload(
            user: Optional[User],
            client: Any,
            session_handle: Optional[str],
            scopes: list[str],
            user_context: UserContext,
        ) -> dict[str, Any]:
            payload = await original_build_access_token_payload(
                user,
                client,
                session_handle,
                scopes,
                user_context,
            )
            return await build_rownd_oauth_payload(config, user, scopes, payload, user_context)

        async def build_id_token_payload(
            user: Optional[User],
            client: Any,
            session_handle: Optional[str],
            scopes: list[str],
            user_context: UserContext,
        ) -> dict[str, Any]:
            payload = await original_build_id_token_payload(
                user,
                client,
                session_handle,
                scopes,
                user_context,
            )
            return await build_rownd_oauth_payload(config, user, scopes, payload, user_context)

        async def build_user_info(
            user: User,
            access_token_payload: dict[str, Any],
            scopes: list[str],
            tenant_id: str,
            user_context: UserContext,
        ) -> dict[str, Any]:
            payload = await original_build_user_info(
                user,
                access_token_payload,
                scopes,
                tenant_id,
                user_context,
            )
            return await build_rownd_oauth_user_info(
                user, access_token_payload, scopes, payload, user_context
            )

        original.get_requested_scopes = get_requested_scopes
        original.build_access_token_payload = build_access_token_payload
        original.build_id_token_payload = build_id_token_payload
        original.build_user_info = build_user_info
        return original

    return override


def _oauth2provider_api_override():
    def override(original: OAuth2ProviderAPIInterface) -> OAuth2ProviderAPIInterface:
        original_auth_get = original.auth_get
        original_token_post = original.token_post

        async def auth_get(
            params: Any,
            cookie: Optional[str],
            session: Optional[SessionContainer],
            should_try_refresh: bool,
            options: Any,
            user_context: UserContext,
        ):
            if isinstance(params, dict):
                audience = apply_rownd_oauth_resource_params(params)
            else:
                audience = None
            operation_context = create_derived_user_context(
                user_context, {"rowndOAuthAudience": audience}
            )
            return await original_auth_get(
                params,
                cookie,
                session,
                should_try_refresh,
                options,
                operation_context,
            )

        async def token_post(
            authorization_header: Optional[str],
            body: Any,
            options: Any,
            user_context: UserContext,
        ):
            if isinstance(body, dict):
                audience = apply_rownd_oauth_resource_params(body)
            else:
                audience = None
            operation_context = create_derived_user_context(
                user_context, {"rowndOAuthAudience": audience}
            )
            return await original_token_post(authorization_header, body, options, operation_context)

        original.auth_get = auth_get
        original.token_post = token_post
        return original

    return override


def _passwordless_config_override(config: RowndPluginConfig):
    def override(original_config: PasswordlessOverrideableConfig) -> PasswordlessOverrideableConfig:
        original_email_delivery = original_config.email_delivery
        original_sms_delivery = original_config.sms_delivery

        def email_override(
            original: EmailDeliveryInterface[PasswordlessLoginEmailTemplateVars],
        ) -> EmailDeliveryInterface[PasswordlessLoginEmailTemplateVars]:
            implementation = (
                original_email_delivery.override(original)
                if original_email_delivery and original_email_delivery.override
                else original
            )
            return RowndEmailDeliveryOverride(
                implementation, config, "url_with_link_code", "account/login"
            )

        def sms_override(
            original: SMSDeliveryInterface[PasswordlessLoginSMSTemplateVars],
        ) -> SMSDeliveryInterface[PasswordlessLoginSMSTemplateVars]:
            implementation = (
                original_sms_delivery.override(original)
                if original_sms_delivery and original_sms_delivery.override
                else original
            )
            return RowndSMSDeliveryOverride(implementation, config)

        original_config.email_delivery = EmailDeliveryConfig(
            service=original_email_delivery.service if original_email_delivery else None,
            override=email_override,
        )
        original_config.sms_delivery = SMSDeliveryConfig(
            service=original_sms_delivery.service if original_sms_delivery else None,
            override=sms_override,
        )
        return original_config

    return override


def _passwordless_api_override(config: RowndPluginConfig):
    def override(original: PasswordlessAPIInterface) -> PasswordlessAPIInterface:
        original_create_code_post = original.create_code_post
        original_consume_code_post = original.consume_code_post
        original_resend_code_post = getattr(original, "resend_code_post", None)

        def apply_rownd_passwordless_request_context(
            api_options: PasswordlessAPIOptions,
            user_context: UserContext,
        ) -> UserContext:
            app_variant_id = get_requested_app_variant_id_from_request(api_options.request)
            assert_app_variant_is_configured(config, app_variant_id)
            request_context = {
                "rowndAppVariantId": app_variant_id,
                "rowndDisplayContext": get_requested_display_context_from_request(
                    api_options.request
                ),
                "rowndRedirectToPath": get_requested_redirect_to_path_from_request(
                    api_options.request
                ),
                "rowndClientDomain": get_requested_client_domain_from_request(api_options.request),
                "rowndOAuthLoginChallenge": get_requested_oauth_login_challenge_from_request(
                    api_options.request
                ),
            }
            return create_derived_user_context(user_context, request_context)

        async def create_code_post(
            email: Optional[str],
            phone_number: Optional[str],
            session: Optional[SessionContainer],
            should_try_linking_with_session_user: Optional[bool],
            tenant_id: str,
            api_options: PasswordlessAPIOptions,
            user_context: UserContext,
        ):
            context = apply_rownd_passwordless_request_context(api_options, user_context)
            if email is not None:
                try:
                    authorization = await supertokens_repository.authorize_passwordless_email(
                        tenant_id,
                        email,
                        context,
                        expected_owner_user_id=(
                            session.get_user_id(context) if session is not None else None
                        ),
                    )
                except Exception:
                    authorization = None
                    _log_passwordless_authorization_diagnostic(
                        config, "create", failure_code="classification_exception"
                    )
                else:
                    _log_passwordless_authorization_diagnostic(config, "create", authorization)
                if config.email_change.get("retirement_mode", "observe") == "guard" and (
                    authorization is None or not authorization.allowed
                ):
                    return GeneralErrorResponse("Passwordless request could not be completed")
            return await original_create_code_post(
                email,
                phone_number,
                session,
                should_try_linking_with_session_user,
                tenant_id,
                api_options,
                context,
            )

        async def resend_code_post(
            device_id: str,
            pre_auth_session_id: str,
            session: Optional[SessionContainer],
            should_try_linking_with_session_user: Optional[bool],
            tenant_id: str,
            api_options: PasswordlessAPIOptions,
            user_context: UserContext,
        ):
            if original_resend_code_post is None:
                raise RuntimeError("Passwordless resend_code_post is unavailable")
            context = apply_rownd_passwordless_request_context(api_options, user_context)
            try:
                stored_email = await supertokens_repository.resolve_passwordless_device_email(
                    tenant_id, pre_auth_session_id, context, device_id
                )
            except Exception:
                stored_email = None
                _log_passwordless_authorization_diagnostic(
                    config, "resend", failure_code="email_resolution_exception"
                )
            else:
                if stored_email is None:
                    _log_passwordless_authorization_diagnostic(
                        config, "resend", failure_code="email_resolution_failed"
                    )
            guard_mode = config.email_change.get("retirement_mode", "observe") == "guard"
            if guard_mode and stored_email is None:
                return ResendCodePostRestartFlowError()
            if stored_email:
                try:
                    authorization = await supertokens_repository.authorize_passwordless_email(
                        tenant_id,
                        stored_email,
                        context,
                        expected_owner_user_id=(
                            session.get_user_id(context) if session is not None else None
                        ),
                    )
                except Exception:
                    authorization = None
                    _log_passwordless_authorization_diagnostic(
                        config, "resend", failure_code="classification_exception"
                    )
                else:
                    _log_passwordless_authorization_diagnostic(config, "resend", authorization)
                if guard_mode and (authorization is None or not authorization.allowed):
                    if authorization is not None and authorization.state.value == "RETIRED":
                        try:
                            await passwordless_asyncio.revoke_all_codes(
                                tenant_id, email=stored_email, user_context=context
                            )
                        except Exception:
                            pass
                    return ResendCodePostRestartFlowError()
            return await original_resend_code_post(
                device_id,
                pre_auth_session_id,
                session,
                should_try_linking_with_session_user,
                tenant_id,
                api_options,
                context,
            )

        async def consume_code_post(
            pre_auth_session_id: str,
            user_input_code: Optional[str],
            device_id: Optional[str],
            link_code: Optional[str],
            session: Optional[SessionContainer],
            should_try_linking_with_session_user: Optional[bool],
            tenant_id: str,
            api_options: PasswordlessAPIOptions,
            user_context: UserContext,
        ):
            app_variant_id = get_requested_app_variant_id_from_request(api_options.request)
            assert_app_variant_is_configured(config, app_variant_id)
            context = create_derived_user_context(
                user_context, {"rowndAppVariantId": app_variant_id}
            )
            context.pop("rowndPasswordlessConsumePostcheck", None)
            result = await original_consume_code_post(
                pre_auth_session_id,
                user_input_code,
                device_id,
                link_code,
                session,
                should_try_linking_with_session_user,
                tenant_id,
                api_options,
                context,
            )
            if getattr(result, "status", None) == "OK":
                user_id = getattr(getattr(result, "user", None), "id", None)
                returned_session = getattr(result, "session", None)
                if config.email_change.get("retirement_mode", "observe") == "guard":
                    marker = context.get("rowndPasswordlessConsumePostcheck")
                    marker_valid = (
                        isinstance(user_id, str)
                        and isinstance(returned_session, SessionContainer)
                        and isinstance(marker, _PasswordlessConsumePostcheck)
                        and bool(marker.owner_user_id)
                        and bool(marker.recipe_user_id)
                    )
                    if marker_valid:
                        checked_marker = cast(_PasswordlessConsumePostcheck, marker)
                        checked_session = cast(SessionContainer, returned_session)
                        checked_user_id = cast(str, user_id)
                        try:
                            marker_valid = (
                                checked_session.get_recipe_user_id(context).get_as_string()
                                == checked_marker.recipe_user_id
                                and await supertokens_repository.sdk_user_id_matches_internal_target(
                                    checked_user_id, checked_marker.owner_user_id, context
                                )
                            )
                        except Exception:
                            marker_valid = False
                    if not marker_valid:
                        response_mutators = getattr(returned_session, "response_mutators", None)
                        mutator_count = (
                            len(response_mutators) if isinstance(response_mutators, list) else 0
                        )
                        targeted_revoked = (
                            await _revoke_and_clear_returned_session(returned_session, context)
                            if returned_session is not None
                            else False
                        )
                        if not targeted_revoked:
                            if isinstance(user_id, str):
                                try:
                                    await session_asyncio.revoke_all_sessions_for_user(
                                        user_id, True, tenant_id, context
                                    )
                                except Exception:
                                    log_warning(
                                        config,
                                        "Passwordless consume session cleanup: "
                                        "code=account_revoke_failed",
                                    )
                            else:
                                log_warning(
                                    config,
                                    "Passwordless consume session cleanup: "
                                    "code=account_revoke_unavailable",
                                )
                        clear_queued = (
                            isinstance(response_mutators, list)
                            and len(response_mutators) > mutator_count
                        )
                        if mutator_count > 0 and not clear_queued:
                            raise RuntimeError(
                                "Passwordless consume session cleanup failed"
                            ) from None
                        return ConsumeCodePostRestartFlowError()
                if isinstance(user_id, str):
                    await record_rownd_app_variant_for_user(
                        config, user_id, app_variant_id, context
                    )
                    if returned_session is not None:
                        await _refresh_rownd_session_claims_or_revoke(
                            config, returned_session, user_id, app_variant_id, context
                        )
            return result

        original.create_code_post = create_code_post
        original.resend_code_post = resend_code_post
        original.consume_code_post = consume_code_post
        return original

    return override


def _passwordless_function_override(config: RowndPluginConfig):
    def override(original: PasswordlessRecipeInterface) -> PasswordlessRecipeInterface:
        original_consume_code = original.consume_code

        async def consume_code(
            pre_auth_session_id: str,
            user_input_code: Optional[str],
            device_id: Optional[str],
            link_code: Optional[str],
            session: Optional[SessionContainer],
            should_try_linking_with_session_user: Optional[bool],
            tenant_id: str,
            user_context: UserContext,
        ):
            guard_mode = config.email_change.get("retirement_mode", "observe") == "guard"
            user_context.pop("rowndPasswordlessConsumePostcheck", None)
            try:
                stored_email = await supertokens_repository.resolve_passwordless_device_email(
                    tenant_id, pre_auth_session_id, user_context, device_id
                )
            except Exception:
                _log_passwordless_authorization_diagnostic(
                    config, "consume", failure_code="email_resolution_exception"
                )
                if guard_mode:
                    return ConsumeCodeRestartFlowError()
                return await original_consume_code(
                    pre_auth_session_id,
                    user_input_code,
                    device_id,
                    link_code,
                    session,
                    should_try_linking_with_session_user,
                    tenant_id,
                    user_context,
                )
            if not guard_mode:
                if stored_email is None:
                    _log_passwordless_authorization_diagnostic(
                        config, "consume", failure_code="email_resolution_failed"
                    )
                if stored_email:
                    try:
                        authorization = await supertokens_repository.authorize_passwordless_email(
                            tenant_id, stored_email, user_context
                        )
                    except Exception:
                        _log_passwordless_authorization_diagnostic(
                            config, "consume", failure_code="classification_exception"
                        )
                    else:
                        _log_passwordless_authorization_diagnostic(
                            config, "consume", authorization
                        )
                return await original_consume_code(
                    pre_auth_session_id,
                    user_input_code,
                    device_id,
                    link_code,
                    session,
                    should_try_linking_with_session_user,
                    tenant_id,
                    user_context,
                )
            if stored_email is None:
                return ConsumeCodeRestartFlowError()
            if not stored_email:
                result = await original_consume_code(
                    pre_auth_session_id,
                    user_input_code,
                    device_id,
                    link_code,
                    session,
                    should_try_linking_with_session_user,
                    tenant_id,
                    user_context,
                )
                if isinstance(result, ConsumeCodeOkResult):
                    user_context["rowndPasswordlessConsumePostcheck"] = (
                        _PasswordlessConsumePostcheck(
                            result.user.id, result.recipe_user_id.get_as_string()
                        )
                    )
                return result
            try:
                before = await supertokens_repository.authorize_passwordless_email(
                    tenant_id, stored_email, user_context
                )
            except Exception:
                return ConsumeCodeRestartFlowError()
            if not before.allowed:
                return ConsumeCodeRestartFlowError()
            try:
                result = await original_consume_code(
                    pre_auth_session_id,
                    user_input_code,
                    device_id,
                    link_code,
                    session,
                    should_try_linking_with_session_user,
                    tenant_id,
                    user_context,
                )
            except Exception:
                raise
            if not isinstance(result, ConsumeCodeOkResult):
                return result
            try:
                after = await supertokens_repository.authorize_passwordless_email(
                    tenant_id,
                    stored_email,
                    user_context,
                    result.recipe_user_id.get_as_string(),
                    before.owner_user_id,
                )
            except Exception:
                return ConsumeCodeRestartFlowError()
            if not after.allowed:
                return ConsumeCodeRestartFlowError()
            user_context["rowndPasswordlessConsumePostcheck"] = _PasswordlessConsumePostcheck(
                cast(str, after.owner_user_id), result.recipe_user_id.get_as_string()
            )
            return result

        original.consume_code = consume_code
        return original

    return override


def _thirdparty_api_override(config: RowndPluginConfig):
    def override(original: ThirdPartyAPIInterface) -> ThirdPartyAPIInterface:
        original_sign_in_up_post = original.sign_in_up_post

        async def sign_in_up_post(
            provider: Provider,
            redirect_uri_info: Optional[RedirectUriInfo],
            oauth_tokens: Optional[UserContext],
            session: Optional[SessionContainer],
            should_try_linking_with_session_user: Optional[bool],
            tenant_id: str,
            api_options: ThirdPartyAPIOptions,
            user_context: UserContext,
        ):
            app_variant_id = get_requested_app_variant_id_from_request(api_options.request)
            assert_app_variant_is_configured(config, app_variant_id)
            context = create_derived_user_context(
                user_context, {"rowndAppVariantId": app_variant_id}
            )
            result = await original_sign_in_up_post(
                provider,
                redirect_uri_info,
                oauth_tokens,
                session,
                should_try_linking_with_session_user,
                tenant_id,
                api_options,
                context,
            )
            if getattr(result, "status", None) == "OK":
                user_id = getattr(getattr(result, "user", None), "id", None)
                if isinstance(user_id, str):
                    await record_rownd_app_variant_for_user(
                        config, user_id, app_variant_id, context
                    )
                    returned_session = getattr(result, "session", None)
                    if returned_session is not None:
                        await _refresh_rownd_session_claims_or_revoke(
                            config, returned_session, user_id, app_variant_id, context
                        )
            return result

        original.sign_in_up_post = sign_in_up_post
        return original

    return override


def _session_function_override(config: RowndPluginConfig):
    def override(original: SessionRecipeInterface) -> SessionRecipeInterface:
        original_create_new_session = original.create_new_session

        async def create_new_session_override(
            user_id: str,
            recipe_user_id: RecipeUserId,
            access_token_payload: Optional[UserContext],
            session_data_in_database: Optional[UserContext],
            disable_anti_csrf: Optional[bool],
            tenant_id: str,
            user_context: UserContext,
        ):
            payload = access_token_payload or {}
            app_variant_id = (
                user_context.get("rowndAppVariantId")
                if isinstance(user_context.get("rowndAppVariantId"), str)
                else None
            )
            rownd_claims, is_anonymous_claim = await build_rownd_session_and_anonymous_claims(
                config, user_id, payload, app_variant_id, user_context
            )
            payload = {**payload, **rownd_claims, **is_anonymous_claim}
            return await original_create_new_session(
                user_id,
                recipe_user_id,
                payload,
                session_data_in_database,
                disable_anti_csrf,
                tenant_id,
                user_context,
            )

        original.create_new_session = create_new_session_override
        return original

    return override


def _emailverification_config_override(config: RowndPluginConfig):
    def override(
        original_config: EmailVerificationOverrideableConfig,
    ) -> EmailVerificationOverrideableConfig:
        original_email_delivery = original_config.email_delivery

        def email_override(
            original: EmailDeliveryInterface[EmailTemplateVars],
        ) -> EmailDeliveryInterface[EmailTemplateVars]:
            implementation = (
                original_email_delivery.override(original)
                if original_email_delivery and original_email_delivery.override
                else original
            )
            return RowndEmailDeliveryOverride(
                implementation, config, "email_verify_link", "account/verify-email"
            )

        original_config.email_delivery = EmailDeliveryConfig(
            service=original_email_delivery.service if original_email_delivery else None,
            override=email_override,
        )
        return original_config

    return override


def _emailverification_api_override():
    def override(original: EmailVerificationAPIInterface) -> EmailVerificationAPIInterface:
        original_email_verify_post = original.email_verify_post

        async def email_verify_post(
            token: str,
            session: Optional[SessionContainer],
            tenant_id: str,
            api_options: EmailVerificationAPIOptions,
            user_context: UserContext,
        ):
            pending_token = await resolve_pending_email_verification_token(
                token,
                api_options.request.get_query_param(PENDING_EMAIL_VERIFICATION_QUERY_PARAM),
                tenant_id,
                session,
                user_context,
            )
            if pending_token["status"] == "INVALID_PENDING":
                return GeneralErrorResponse(
                    "email change verification requires the initiating session"
                )
            if (
                pending_token["status"] == "OK"
                and rownd_config.get_active_rownd_config().email_change.get(
                    "retirement_mode", "observe"
                )
                == "guard"
            ):
                return GeneralErrorResponse(
                    "email changes are disabled while email credential retirement guard mode is active"
                )
            result = await original_email_verify_post(
                cast(str, pending_token.get("core_token", token)),
                session,
                tenant_id,
                api_options,
                user_context,
            )
            if getattr(result, "status", None) == "OK" and pending_token["status"] == "OK":
                user = getattr(result, "user", None)
                recipe_user_id = getattr(user, "recipe_user_id", None)
                email = getattr(user, "email", None)
                if recipe_user_id is not None and isinstance(email, str):
                    try:
                        verification_result = await complete_pending_email_verification(
                            recipe_user_id,
                            email,
                            user_context,
                            tenant_id,
                            session.get_handle(user_context) if session is not None else None,
                            cast(str, pending_token["pending_verification_id"]),
                            cast(str, pending_token["user_id"]),
                        )
                    except RowndEmailChangeError as error:
                        return GeneralErrorResponse(str(error))
                    if session is not None and verification_result is not None:
                        should_replace_session = (
                            session.get_handle(user_context)
                            == verification_result["initiating_session_handle"]
                        )
                        if should_replace_session:
                            tenant_id = session.get_tenant_id(user_context)
                            verified_recipe_user_id = cast(
                                RecipeUserId, verification_result["recipe_user_id"]
                            )
                            try:
                                await supertokens_repository.authorize_passwordless_email(
                                    tenant_id,
                                    email,
                                    user_context,
                                    verified_recipe_user_id.get_as_string(),
                                    cast(str, verification_result["user_id"]),
                                )
                            except Exception:
                                pass
                            try:
                                cast(
                                    Any, result
                                ).new_session = await session_asyncio.create_new_session(
                                    api_options.request,
                                    tenant_id,
                                    verified_recipe_user_id,
                                    {},
                                    {},
                                    user_context,
                                )
                            except Exception:
                                rollback = cast(
                                    Callable[[], Any],
                                    verification_result["rollback_on_session_replacement_failure"],
                                )
                                await rollback()
                                raise
            return result

        original.email_verify_post = email_verify_post
        return original

    return override


def _accountlinking_config_override():
    def override(
        original_config: AccountLinkingOverrideableConfig,
    ) -> AccountLinkingOverrideableConfig:
        original_should_link = original_config.should_do_automatic_account_linking

        async def should_do_automatic_account_linking(
            new_account_info: AccountInfoWithRecipeIdAndUserId,
            user: Optional[User],
            session_: Optional[SessionContainer],
            tenant_id: str,
            user_context: UserContext,
        ):
            from supertokens_python.asyncio import get_user, list_users_by_account_info

            if user_context.get("rowndDisableAutomaticAccountLinking") is True:
                return ShouldNotAutomaticallyLink()
            if session_:
                current_user = await get_user(session_.get_user_id(user_context), user_context)
                if has_only_guest_login_methods(current_user):
                    return ShouldAutomaticallyLink(should_require_verification=False)
                if current_user is not None and not is_guest_account_info(new_account_info):
                    if does_account_info_match_auth_method(
                        current_user, new_account_info, tenant_id
                    ):
                        return ShouldAutomaticallyLink(should_require_verification=True)
            elif new_account_info.email and not is_guest_account_info(new_account_info):
                matching_users = (
                    [user]
                    if user is not None
                    else await list_users_by_account_info(
                        tenant_id,
                        AccountInfoInput(email=new_account_info.email),
                        True,
                        user_context,
                    )
                )
                if any(
                    has_verified_matching_email_login_method(
                        matching_user, new_account_info, tenant_id
                    )
                    for matching_user in matching_users
                ):
                    return ShouldAutomaticallyLink(should_require_verification=True)

            if original_should_link:
                return await original_should_link(
                    new_account_info, user, session_, tenant_id, user_context
                )
            return ShouldNotAutomaticallyLink()

        original_config.should_do_automatic_account_linking = should_do_automatic_account_linking
        return original_config

    return override


def _normalise_path(path: str) -> str:
    if not path.startswith("/"):
        path = "/" + path
    return path.rstrip("/") or "/"


def _validate_config(config: RowndPluginConfig) -> None:
    for field_name, field_config in config.schema.items():
        resolve_session_claim_name(field_name, field_config)

    telemetry = config.telemetry
    if isinstance(telemetry, dict):
        provider = telemetry.get("provider")
        if provider == "axiom" and (not telemetry.get("token") or not telemetry.get("dataset")):
            raise ValueError("Missing telemetry axiom token or dataset in plugin config")
        if provider == "custom" and not callable(telemetry.get("factory")):
            raise ValueError("Missing telemetry custom factory function in plugin config")
    elif telemetry is not None:
        if telemetry.provider == "axiom" and (not telemetry.token or not telemetry.dataset):
            raise ValueError("Missing telemetry axiom token or dataset in plugin config")
        if telemetry.provider == "custom" and telemetry.factory is None:
            raise ValueError("Missing telemetry custom factory function in plugin config")

    max_session_age = config.email_change.get("max_session_age_seconds", 600)
    if (
        not isinstance(max_session_age, (int, float))
        or isinstance(max_session_age, bool)
        or not math.isfinite(max_session_age)
        or max_session_age <= 0
    ):
        raise ValueError("email_change.max_session_age_seconds must be a positive number")
    config.email_change["max_session_age_seconds"] = max_session_age
    retirement_mode = config.email_change.get("retirement_mode", "observe")
    if retirement_mode not in {"observe", "guard"}:
        raise ValueError("email_change.retirement_mode must be 'observe' or 'guard'")
    config.email_change["retirement_mode"] = retirement_mode

    for key, value in config.client_domains.items():
        parsed = urlparse(value) if isinstance(value, str) else None
        if (
            parsed is None
            or re.match(r"^[A-Za-z][A-Za-z0-9+.-]*://", value) is None
            or (parsed.scheme in {"http", "https"} and not parsed.netloc)
        ):
            raise ValueError("Invalid client_domains.%s in plugin config" % key)

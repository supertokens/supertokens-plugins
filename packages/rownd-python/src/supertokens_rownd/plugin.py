from __future__ import annotations

import math
import re
import warnings
from collections.abc import Callable
from typing import Any, Generic, Optional, TypeVar, cast
from typing_extensions import Unpack
from urllib.parse import urlparse

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
)
from supertokens_python.recipe.passwordless.types import (
    PasswordlessLoginEmailTemplateVars,
    PasswordlessLoginSMSTemplateVars,
)
from supertokens_python.recipe.passwordless.utils import PasswordlessOverrideableConfig
from supertokens_python.recipe.session import SessionContainer
from supertokens_python.recipe.session import asyncio as session_asyncio
from supertokens_python.recipe.session.claims import BooleanClaim
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

from .constants import (
    GUEST_AUTH_METHOD_ID,
    HANDLE_BASE_PATH,
    INSTANT_AUTH_METHOD_ID,
    PENDING_EMAIL_VERIFICATION_QUERY_PARAM,
    PLUGIN_ID,
    PLUGIN_SDK_VERSION,
    PLUGIN_VERSION,
    ROWND_JWT_CLAIMS,
)
from .plugin_implementation import (
    add_hub_bootstrap_params,
    add_pending_email_verification_marker,
    apply_rownd_oauth_resource_params,
    assert_app_variant_is_configured,
    build_rownd_oauth_payload,
    build_rownd_oauth_user_info,
    build_rownd_session_and_anonymous_claims,
    complete_pending_email_verification,
    create_derived_user_context,
    does_account_info_match_auth_method,
    get_effective_auth_level,
    get_requested_app_variant_id_from_request,
    get_requested_client_domain_from_request,
    get_requested_display_context_from_request,
    get_requested_oauth_login_challenge_from_request,
    get_requested_redirect_to_path_from_request,
    get_pending_email_verification_id_from_user_context,
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
    has_verified_matching_email_login_method,
    has_only_guest_login_methods,
    is_guest_account_info,
    normalize_rownd_oauth_scopes,
    record_rownd_app_variant_for_user,
    resolve_pending_email_verification_token,
    set_active_rownd_config,
)
from .rownd_client import RowndClient
from .telemetry import create_telemetry_client
from .types import RowndClientProtocol, RowndEmailChangeError, RowndPluginConfig, RowndPluginKwargs


TemplateVarsT = TypeVar("TemplateVarsT")


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
            configured_name = field_config.get("session_claim_name")
            managed_claim_names.add(
                configured_name
                if isinstance(configured_name, str) and configured_name
                else field_name
            )
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
            return await original_create_code_post(
                email,
                phone_number,
                session,
                should_try_linking_with_session_user,
                tenant_id,
                api_options,
                apply_rownd_passwordless_request_context(api_options, user_context),
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
            return await original_resend_code_post(
                device_id,
                pre_auth_session_id,
                session,
                should_try_linking_with_session_user,
                tenant_id,
                api_options,
                apply_rownd_passwordless_request_context(api_options, user_context),
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

        original.create_code_post = create_code_post
        original.resend_code_post = resend_code_post
        original.consume_code_post = consume_code_post
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

    for key, value in config.client_domains.items():
        parsed = urlparse(value) if isinstance(value, str) else None
        if (
            parsed is None
            or re.match(r"^[A-Za-z][A-Za-z0-9+.-]*://", value) is None
            or (parsed.scheme in {"http", "https"} and not parsed.netloc)
        ):
            raise ValueError("Invalid client_domains.%s in plugin config" % key)

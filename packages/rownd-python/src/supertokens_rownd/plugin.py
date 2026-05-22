from __future__ import annotations

from collections.abc import Callable
from typing import Generic, Optional, TypeVar, cast
from typing_extensions import Unpack

from supertokens_python.framework.request import BaseRequest
from supertokens_python.framework.response import BaseResponse
from supertokens_python.ingredients.emaildelivery.types import EmailDeliveryConfig, EmailDeliveryInterface
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
from supertokens_python.recipe.emailverification.interfaces import APIInterface as EmailVerificationAPIInterface, APIOptions as EmailVerificationAPIOptions
from supertokens_python.recipe.emailverification.types import EmailTemplateVars
from supertokens_python.recipe.emailverification.utils import EmailVerificationOverrideableConfig
from supertokens_python.recipe.passwordless.interfaces import APIInterface as PasswordlessAPIInterface, APIOptions as PasswordlessAPIOptions
from supertokens_python.recipe.passwordless.types import PasswordlessLoginEmailTemplateVars, PasswordlessLoginSMSTemplateVars
from supertokens_python.recipe.passwordless.utils import PasswordlessOverrideableConfig
from supertokens_python.recipe.session import SessionContainer
from supertokens_python.recipe.session.interfaces import RecipeInterface as SessionRecipeInterface
from supertokens_python.recipe.thirdparty.interfaces import APIInterface as ThirdPartyAPIInterface, APIOptions as ThirdPartyAPIOptions
from supertokens_python.recipe.thirdparty.provider import Provider, RedirectUriInfo
from supertokens_python.types import RecipeUserId, User
from supertokens_python.types.base import UserContext
from supertokens_python.types.recipe import BaseAPIInterface, BaseRecipeInterface

from .constants import HANDLE_BASE_PATH, PLUGIN_ID, PLUGIN_SDK_VERSION
from .plugin_implementation import (
    add_hub_bootstrap_params,
    assert_app_variant_is_configured,
    build_rownd_session_claims,
    complete_pending_email_verification,
    does_account_info_match_auth_method,
    get_requested_app_variant_id_from_request,
    get_requested_display_context_from_request,
    get_requested_redirect_to_path_from_request,
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
    has_only_guest_login_methods,
    is_guest_account_info,
    record_rownd_app_variant_for_user,
)
from .rownd_client import RowndClient
from .telemetry import create_telemetry_client
from .types import RowndPluginConfig, RowndPluginKwargs


TemplateVarsT = TypeVar("TemplateVarsT")


class RowndEmailDeliveryOverride(Generic[TemplateVarsT], EmailDeliveryInterface[TemplateVarsT]):
    def __init__(self, original: EmailDeliveryInterface[TemplateVarsT], config: RowndPluginConfig, link_attr: str, target_path: str):
        self.original = original
        self.config = config
        self.link_attr = link_attr
        self.target_path = target_path

    async def send_email(self, template_vars: TemplateVarsT, user_context: UserContext) -> None:
        setattr(
            template_vars,
            self.link_attr,
            add_hub_bootstrap_params(
                getattr(template_vars, self.link_attr, None),
                self.target_path,
                self.config,
                user_context,
            ),
        )
        await self.original.send_email(template_vars, user_context)


class RowndSMSDeliveryOverride(SMSDeliveryInterface[PasswordlessLoginSMSTemplateVars]):
    def __init__(self, original: SMSDeliveryInterface[PasswordlessLoginSMSTemplateVars], config: RowndPluginConfig):
        self.original = original
        self.config = config

    async def send_sms(self, template_vars: PasswordlessLoginSMSTemplateVars, user_context: UserContext) -> None:
        template_vars.url_with_link_code = add_hub_bootstrap_params(
            getattr(template_vars, "url_with_link_code", None),
            "account/login",
            self.config,
            user_context,
        )
        await self.original.send_sms(template_vars, user_context)


def init(config: Optional[RowndPluginConfig] = None, **kwargs: Unpack[RowndPluginKwargs]) -> SuperTokensPlugin:
    if config is None:
        config = RowndPluginConfig(**kwargs)
    elif kwargs:
        raise ValueError("Pass either RowndPluginConfig or keyword arguments, not both")
    if not config.rownd_app_key or not config.rownd_app_secret:
        raise ValueError("Missing rownd_app_key or rownd_app_secret in plugin config")

    config.api_base_path = _normalise_path(config.api_base_path)
    client = config.rownd_client or RowndClient(config)
    telemetry_client = create_telemetry_client(config)

    route_base = config.api_base_path + HANDLE_BASE_PATH
    plugin_config = config

    async def app_config_handler(request: BaseRequest, response: BaseResponse, session: Optional[SessionContainer], user_context: UserContext) -> BaseResponse:
        return await handle_app_config(config, request, response)

    async def guest_handler(request: BaseRequest, response: BaseResponse, session: Optional[SessionContainer], user_context: UserContext) -> BaseResponse:
        return await handle_guest_login(config, telemetry_client, request, response, user_context)

    async def migrate_handler(request: BaseRequest, response: BaseResponse, session: Optional[SessionContainer], user_context: UserContext) -> BaseResponse:
        from supertokens_python import Supertokens

        return await handle_migrate(
            config,
            client,
            telemetry_client,
            Supertokens.get_instance().supertokens_config,
            request,
            response,
            user_context,
        )

    async def signout_handler(request: BaseRequest, response: BaseResponse, session: Optional[SessionContainer], user_context: UserContext) -> BaseResponse:
        return await handle_signout(session, response)

    async def get_user_handler(request: BaseRequest, response: BaseResponse, session: Optional[SessionContainer], user_context: UserContext) -> BaseResponse:
        return await handle_get_user(session, response)

    async def update_user_handler(request: BaseRequest, response: BaseResponse, session: Optional[SessionContainer], user_context: UserContext) -> BaseResponse:
        return await handle_update_user(config, request, response, session, user_context)

    async def delete_user_handler(request: BaseRequest, response: BaseResponse, session: Optional[SessionContainer], user_context: UserContext) -> BaseResponse:
        return await handle_delete_user(session, response)

    async def get_user_meta_handler(request: BaseRequest, response: BaseResponse, session: Optional[SessionContainer], user_context: UserContext) -> BaseResponse:
        return await handle_get_user_meta(session, response)

    async def update_user_meta_handler(request: BaseRequest, response: BaseResponse, session: Optional[SessionContainer], user_context: UserContext) -> BaseResponse:
        return await handle_update_user_meta(request, response, session)

    async def get_user_field_handler(request: BaseRequest, response: BaseResponse, session: Optional[SessionContainer], user_context: UserContext) -> BaseResponse:
        return await handle_get_user_field(request, response, session)

    async def update_user_field_handler(request: BaseRequest, response: BaseResponse, session: Optional[SessionContainer], user_context: UserContext) -> BaseResponse:
        return await handle_update_user_field(config, request, response, session, user_context)

    session_required = VerifySessionOptions(session_required=True, check_database=False)
    checked_session_required = VerifySessionOptions(session_required=True, check_database=True)

    passwordless_override = RecipePluginOverride()
    passwordless_override.config = _passwordless_config_override(config)
    passwordless_override.apis = cast(Callable[[BaseAPIInterface], BaseAPIInterface], _passwordless_api_override(config))

    thirdparty_override = RecipePluginOverride()
    thirdparty_override.apis = cast(Callable[[BaseAPIInterface], BaseAPIInterface], _thirdparty_api_override(config))

    accountlinking_override = RecipePluginOverride()
    accountlinking_override.config = _accountlinking_config_override()
    accountlinking_override.recipe_init_required = True

    session_override = RecipePluginOverride()
    session_override.functions = cast(Callable[[BaseRecipeInterface], BaseRecipeInterface], _session_function_override(config))
    session_override.recipe_init_required = True

    emailverification_override = RecipePluginOverride()
    emailverification_override.config = _emailverification_config_override(config)
    emailverification_override.apis = cast(Callable[[BaseAPIInterface], BaseAPIInterface], _emailverification_api_override())
    emailverification_override.recipe_init_required = True

    override_map: OverrideMap = {
        "passwordless": passwordless_override,
        "thirdparty": thirdparty_override,
        "accountlinking": accountlinking_override,
        "session": session_override,
        "emailverification": emailverification_override,
    }

    return SuperTokensPlugin(
        id=PLUGIN_ID,
        version="0.1.0",
        compatible_sdk_versions=PLUGIN_SDK_VERSION,
        override_map=override_map,
        route_handlers=lambda config, all_plugins, sdk_version: PluginRouteHandlerFunctionOkResponse(
            route_handlers=[
                PluginRouteHandler(method="get", path=route_base + "/app-config", handler=app_config_handler, verify_session_options=None),
                PluginRouteHandler(method="post", path=route_base + "/guest", handler=guest_handler, verify_session_options=None),
                PluginRouteHandler(method="post", path=route_base + "/migrate", handler=migrate_handler, verify_session_options=None),
                PluginRouteHandler(method="post", path=plugin_config.api_base_path + "/plugin/migrate-session", handler=migrate_handler, verify_session_options=None),
                PluginRouteHandler(method="post", path=route_base + "/signout", handler=signout_handler, verify_session_options=checked_session_required),
                PluginRouteHandler(method="get", path=route_base + "/user", handler=get_user_handler, verify_session_options=session_required),
                PluginRouteHandler(method="put", path=route_base + "/user", handler=update_user_handler, verify_session_options=session_required),
                PluginRouteHandler(method="delete", path=route_base + "/user", handler=delete_user_handler, verify_session_options=session_required),
                PluginRouteHandler(method="get", path=route_base + "/user/meta", handler=get_user_meta_handler, verify_session_options=session_required),
                PluginRouteHandler(method="put", path=route_base + "/user/meta", handler=update_user_meta_handler, verify_session_options=session_required),
                PluginRouteHandler(method="get", path=route_base + "/user/field", handler=get_user_field_handler, verify_session_options=session_required),
                PluginRouteHandler(method="put", path=route_base + "/user/field", handler=update_user_field_handler, verify_session_options=session_required),
            ]
        ),
    )


def _passwordless_config_override(config: RowndPluginConfig):
    def override(original_config: PasswordlessOverrideableConfig) -> PasswordlessOverrideableConfig:
        original_email_delivery = original_config.email_delivery
        original_sms_delivery = original_config.sms_delivery

        def email_override(
            original: EmailDeliveryInterface[PasswordlessLoginEmailTemplateVars],
        ) -> EmailDeliveryInterface[PasswordlessLoginEmailTemplateVars]:
            implementation = original_email_delivery.override(original) if original_email_delivery and original_email_delivery.override else original
            return RowndEmailDeliveryOverride(implementation, config, "url_with_link_code", "account/login")

        def sms_override(
            original: SMSDeliveryInterface[PasswordlessLoginSMSTemplateVars],
        ) -> SMSDeliveryInterface[PasswordlessLoginSMSTemplateVars]:
            implementation = original_sms_delivery.override(original) if original_sms_delivery and original_sms_delivery.override else original
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

        async def create_code_post(
            email: Optional[str],
            phone_number: Optional[str],
            session: Optional[SessionContainer],
            should_try_linking_with_session_user: Optional[bool],
            tenant_id: str,
            api_options: PasswordlessAPIOptions,
            user_context: UserContext,
        ):
            app_variant_id = get_requested_app_variant_id_from_request(api_options.request)
            assert_app_variant_is_configured(config, app_variant_id)
            extra_context = {}
            display_context = get_requested_display_context_from_request(api_options.request)
            redirect_to_path = get_requested_redirect_to_path_from_request(api_options.request)
            if app_variant_id:
                extra_context["rowndAppVariantId"] = app_variant_id
            if display_context:
                extra_context["rowndDisplayContext"] = display_context
            if redirect_to_path:
                extra_context["rowndRedirectToPath"] = redirect_to_path
            return await original_create_code_post(
                email,
                phone_number,
                session,
                should_try_linking_with_session_user,
                tenant_id,
                api_options,
                {**user_context, **extra_context},
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
            context = {**user_context, **({"rowndAppVariantId": app_variant_id} if app_variant_id else {})}
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
                    await record_rownd_app_variant_for_user(config, user_id, app_variant_id)
            return result

        original.create_code_post = create_code_post
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
            context = {**user_context, **({"rowndAppVariantId": app_variant_id} if app_variant_id else {})}
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
                    await record_rownd_app_variant_for_user(config, user_id, app_variant_id)
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
            app_variant_id = user_context.get("rowndAppVariantId") if isinstance(user_context.get("rowndAppVariantId"), str) else None
            payload = {
                **payload,
                **(await build_rownd_session_claims(config, user_id, payload, app_variant_id)),
            }
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
    def override(original_config: EmailVerificationOverrideableConfig) -> EmailVerificationOverrideableConfig:
        original_email_delivery = original_config.email_delivery

        def email_override(
            original: EmailDeliveryInterface[EmailTemplateVars],
        ) -> EmailDeliveryInterface[EmailTemplateVars]:
            implementation = original_email_delivery.override(original) if original_email_delivery and original_email_delivery.override else original
            return RowndEmailDeliveryOverride(implementation, config, "email_verify_link", "account/verify-email")

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
            result = await original_email_verify_post(token, session, tenant_id, api_options, user_context)
            if getattr(result, "status", None) == "OK":
                user = getattr(result, "user", None)
                recipe_user_id = getattr(user, "recipe_user_id", None)
                email = getattr(user, "email", None)
                if recipe_user_id is not None and isinstance(email, str):
                    await complete_pending_email_verification(recipe_user_id, email, user_context)
            return result

        original.email_verify_post = email_verify_post
        return original

    return override


def _accountlinking_config_override():
    def override(original_config: AccountLinkingOverrideableConfig) -> AccountLinkingOverrideableConfig:
        original_should_link = original_config.should_do_automatic_account_linking

        async def should_do_automatic_account_linking(
            new_account_info: AccountInfoWithRecipeIdAndUserId,
            user: Optional[User],
            session_: Optional[SessionContainer],
            tenant_id: str,
            user_context: UserContext,
        ):
            if session_:
                from supertokens_python.asyncio import get_user

                current_user = await get_user(session_.get_user_id(), user_context)
                if has_only_guest_login_methods(current_user):
                    return ShouldAutomaticallyLink(should_require_verification=False)
                if current_user is not None and not is_guest_account_info(new_account_info):
                    if does_account_info_match_auth_method(current_user, new_account_info):
                        return ShouldAutomaticallyLink(should_require_verification=True)

            if original_should_link:
                return await original_should_link(new_account_info, user, session_, tenant_id, user_context)
            return ShouldNotAutomaticallyLink()

        original_config.should_do_automatic_account_linking = should_do_automatic_account_linking
        return original_config

    return override



def _normalise_path(path: str) -> str:
    if not path.startswith("/"):
        path = "/" + path
    return path.rstrip("/") or "/"

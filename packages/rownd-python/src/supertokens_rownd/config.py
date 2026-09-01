from __future__ import annotations

from typing import List, Optional, cast

from .constants import BUILTIN_SIGN_IN_METHOD_KEYS, DEFAULT_ROWND_SCHEMA
from .errors import RowndPluginError
from .types import JsonDict, RowndPluginConfig


_active_config: Optional[RowndPluginConfig] = None


def set_active_rownd_config(config: RowndPluginConfig) -> None:
    global _active_config
    _active_config = config


def get_active_rownd_config() -> RowndPluginConfig:
    if _active_config is None:
        raise RowndPluginError("Rownd plugin config is not initialized")
    return _active_config


def assert_app_variant_is_configured(
    config: RowndPluginConfig, app_variant_id: Optional[str]
) -> None:
    if app_variant_id and config.sub_brands and app_variant_id not in config.sub_brands:
        raise RowndPluginError("Unknown Rownd app variant: %s" % app_variant_id)


def is_email_sign_in_enabled(
    config: RowndPluginConfig, app_variant_id: Optional[str] = None
) -> bool:
    variant = config.sub_brands.get(app_variant_id, {}) if app_variant_id else {}
    methods = (
        variant.get("signInMethods")
        if isinstance(variant.get("signInMethods"), list)
        else config.app_config.get("signInMethods")
    )
    return isinstance(methods, list) and any(
        isinstance(method, dict) and method.get("method") == "email" for method in methods
    )


def as_json_dict(value: object) -> JsonDict:
    return cast(JsonDict, value) if isinstance(value, dict) else {}


def as_json_list(value: object) -> List[JsonDict]:
    return (
        [cast(JsonDict, item) for item in value if isinstance(item, dict)]
        if isinstance(value, list)
        else []
    )


def deep_merge(base: JsonDict, overlay: JsonDict) -> JsonDict:
    result = dict(base)
    for key, value in overlay.items():
        if value is None:
            continue
        existing = result.get(key)
        if isinstance(existing, dict) and isinstance(value, dict):
            result[key] = deep_merge(existing, value)
        else:
            result[key] = value
    return result


def build_app_config(
    config: RowndPluginConfig, app_variant_id: Optional[str]
) -> Optional[JsonDict]:
    base_app = config.app_config or {}
    sub_brand = config.sub_brands.get(app_variant_id) if app_variant_id else None
    if app_variant_id and sub_brand is None:
        return None
    app = deep_merge(base_app, sub_brand or {})
    schema = dict(config.schema or DEFAULT_ROWND_SCHEMA)
    sign_in_method_items = as_json_list(app.get("signInMethods"))
    sign_in_methods = build_sign_in_methods_config(sign_in_method_items)

    email_sign_in = as_json_dict(sign_in_methods.get("email"))
    phone_sign_in = as_json_dict(sign_in_methods.get("phone"))
    google_sign_in = as_json_dict(sign_in_methods.get("google"))
    apple_sign_in = as_json_dict(sign_in_methods.get("apple"))

    if email_sign_in.get("enabled") and "email" not in schema:
        schema["email"] = {"display_name": "Email", "type": "string", "user_visible": True}
    if phone_sign_in.get("enabled") and "phone_number" not in schema:
        schema["phone_number"] = {
            "display_name": "Phone number",
            "type": "string",
            "user_visible": True,
        }
    if google_sign_in.get("enabled") and "google_id" not in schema:
        schema["google_id"] = {"display_name": "Google ID", "type": "string", "user_visible": False}
    if apple_sign_in.get("enabled") and "apple_id" not in schema:
        schema["apple_id"] = {"display_name": "Apple ID", "type": "string", "user_visible": False}

    branding = as_json_dict(app.get("branding"))
    auth = as_json_dict(app.get("auth"))
    hub_auth = {
        "email": build_auth_email_config(auth.get("email")),
        **({"mobile": build_auth_mobile_config(auth.get("mobile"))} if auth.get("mobile") else {}),
        "sign_in_methods": sign_in_methods,
        "additional_fields": auth.get("additionalFields", []),
        **(
            {"remember_sign_in_method": auth["rememberSignInMethod"]}
            if "rememberSignInMethod" in auth
            else {}
        ),
        **(
            {"use_explicit_sign_up_flow": auth["useExplicitSignUpFlow"]}
            if "useExplicitSignUpFlow" in auth
            else {}
        ),
        **(
            {"allow_unverified_users": auth["allowUnverifiedUsers"]}
            if "allowUnverifiedUsers" in auth
            else {}
        ),
        **(
            {
                "enforce_same_device_passwordless_sign_in": auth[
                    "enforceSameDevicePasswordlessSignIn"
                ]
            }
            if "enforceSameDevicePasswordlessSignIn" in auth
            else {}
        ),
        **(
            {"primary_sign_up_method": auth["primarySignUpMethod"]}
            if auth.get("primarySignUpMethod")
            else {}
        ),
        **({"preferred_method": auth["preferredMethod"]} if auth.get("preferredMethod") else {}),
        **({"order": auth["order"]} if auth.get("order") else {}),
        **(
            {"instant_user": {"enabled": True}}
            if is_instant_anonymous_method(sign_in_method_items)
            else {}
        ),
        "show_app_icon": branding.get("showAppIcon", False),
    }
    return {
        "config_type": "variant" if app_variant_id else "app",
        **({"variant": app.get("variant")} if isinstance(app.get("variant"), dict) else {}),
        "app": {
            "id": app.get("id", ""),
            "name": app.get("name", config.app_name),
            "icon": app.get("icon", ""),
            **(
                {"user_verification_fields": app["userVerificationFields"]}
                if app.get("userVerificationFields")
                else {}
            ),
            "schema": {key: normalize_schema_field(key, field) for key, field in schema.items()},
            "config": {
                **({"capabilities": app["capabilities"]} if app.get("capabilities") else {}),
                **({"web": app["web"]} if app.get("web") else {}),
                **({"bottom_sheet": app["bottomSheet"]} if app.get("bottomSheet") else {}),
                **(
                    {"profile_storage_version": app["profileStorageVersion"]}
                    if app.get("profileStorageVersion")
                    else {}
                ),
                "customizations": {
                    "primary_color": branding.get("primaryColor", "#5b5bd6"),
                    **({"logo": branding["logo"]} if branding.get("logo") else {}),
                    **(
                        {"logo_dark_mode": branding["logoDarkMode"]}
                        if branding.get("logoDarkMode")
                        else {}
                    ),
                    **(
                        {"animations": branding["animations"]} if branding.get("animations") else {}
                    ),
                },
                "hub": {
                    **(
                        {"allowed_web_origins": app["allowedWebOrigins"]}
                        if app.get("allowedWebOrigins")
                        else {}
                    ),
                    "customizations": {
                        "rounded_corners": branding.get("roundedCorners", True),
                        **(
                            {"container_border_radius": branding["containerBorderRadius"]}
                            if "containerBorderRadius" in branding
                            else {}
                        ),
                        **({"placement": branding["placement"]} if "placement" in branding else {}),
                        **(
                            {"primary_color": branding["hubPrimaryColor"]}
                            if "hubPrimaryColor" in branding
                            else {}
                        ),
                        **(
                            {"primary_color_dark_mode": branding["primaryColorDarkMode"]}
                            if "primaryColorDarkMode" in branding
                            else {}
                        ),
                        **(
                            {"background_color": branding["backgroundColor"]}
                            if "backgroundColor" in branding
                            else {}
                        ),
                        **(
                            {"font_family": branding["fontFamily"]}
                            if "fontFamily" in branding
                            else {}
                        ),
                        **(
                            {"hide_verification_icons": branding["hideVerificationIcons"]}
                            if "hideVerificationIcons" in branding
                            else {}
                        ),
                        "visual_swoops": branding.get("visualSwoops", True),
                        "blur_background": branding.get("blurBackground", True),
                        **(
                            {"blur_background_opacity": branding["blurBackgroundOpacity"]}
                            if "blurBackgroundOpacity" in branding
                            else {}
                        ),
                        **({"offset_x": branding["offsetX"]} if "offsetX" in branding else {}),
                        **({"offset_y": branding["offsetY"]} if "offsetY" in branding else {}),
                        **(
                            {"property_overrides": branding["propertyOverrides"]}
                            if branding.get("propertyOverrides")
                            else {}
                        ),
                        "dark_mode": branding.get("darkMode", "auto"),
                    },
                    **(
                        {"custom_scripts": branding["customScripts"]}
                        if branding.get("customScripts")
                        else {}
                    ),
                    **(
                        {"custom_styles": branding["customStyles"]}
                        if branding.get("customStyles")
                        else {}
                    ),
                    "auth": hub_auth,
                    "legal": build_legal_config(app.get("legal")),
                    "profile": build_profile_config(app.get("profile")),
                    "custom_content": build_custom_content_config(app.get("customContent")),
                },
            },
        },
    }


def normalize_schema_field(key: str, field: JsonDict) -> JsonDict:
    owned_by = "app" if key in {"google_id", "apple_id"} else field.get("owned_by", "user")
    return {
        "display_name": field.get("display_name", key),
        "type": field.get("type", "string"),
        "owned_by": owned_by,
        "user_visible": field.get("user_visible", True),
        "read_only": field.get("read_only", owned_by == "app"),
        "show_empty": field.get("show_empty", False),
    }


def build_sign_in_methods_config(methods_array: List[JsonDict]) -> JsonDict:
    methods = {}
    for item in methods_array:
        method = item.get("method")
        if isinstance(method, str):
            methods[method] = item
    custom_providers = {}
    for key, value in methods.items():
        if key and key not in BUILTIN_SIGN_IN_METHOD_KEYS:
            display_name = value.get("displayName")
            custom_provider: JsonDict = {
                "enabled": True,
                "display_name": display_name if isinstance(display_name, str) else key,
            }
            if isinstance(value.get("iconLightUrl"), str):
                custom_provider["icon_light_url"] = value["iconLightUrl"]
            if isinstance(value.get("iconDarkUrl"), str):
                custom_provider["icon_dark_url"] = value["iconDarkUrl"]
            custom_providers[key] = custom_provider
    google = methods.get("google") or {}
    apple = methods.get("apple") or {}
    anonymous = methods.get("anonymous") or {}
    sign_in_faster_with_google = google.get("signInFasterWithGoogle")
    anonymous_type = "instant" if anonymous.get("type") == "instant" else "guest"
    anonymous_config: JsonDict = {"enabled": "anonymous" in methods and anonymous_type != "instant"}
    apple_config: JsonDict = {"enabled": "apple" in methods, "client_id": apple.get("clientId", "")}
    if isinstance(apple.get("webClientType"), str):
        apple_config["web_client_type"] = apple["webClientType"]
    if isinstance(apple.get("iosClientType"), str):
        apple_config["ios_client_type"] = apple["iosClientType"]
    if isinstance(apple.get("androidClientType"), str):
        apple_config["android_client_type"] = apple["androidClientType"]
    if "anonymous" in methods and anonymous_type != "instant":
        anonymous_config["type"] = anonymous_type
        if isinstance(anonymous.get("displayName"), str):
            anonymous_config["display_name"] = anonymous["displayName"]
        if isinstance(anonymous.get("iconLightUrl"), str):
            anonymous_config["icon_light_url"] = anonymous["iconLightUrl"]
        if isinstance(anonymous.get("iconDarkUrl"), str):
            anonymous_config["icon_dark_url"] = anonymous["iconDarkUrl"]
    scopes = google.get("scopes")
    return {
        "email": {"enabled": "email" in methods},
        "phone": {"enabled": "phone" in methods},
        "google": {
            "enabled": "google" in methods,
            "client_id": google.get("clientId", ""),
            "ios_client_id": google.get("iosClientId", ""),
            "scopes": scopes
            if isinstance(scopes, list) and all(isinstance(item, str) for item in scopes)
            else [],
            **(
                {"sign_in_faster_with_google": sign_in_faster_with_google}
                if sign_in_faster_with_google in {"enabled", "disabled"}
                else {}
            ),
            "one_tap": build_google_one_tap_config(google.get("oneTap")),
        },
        "apple": apple_config,
        "anonymous": anonymous_config,
        **custom_providers,
    }


def build_auth_email_config(auth_email: object) -> JsonDict:
    auth_email = as_json_dict(auth_email)
    return {
        "from_address": auth_email.get("fromAddress", "no-reply@rownd.io"),
        "image": auth_email.get("image", ""),
        **({"subject": auth_email["subject"]} if auth_email.get("subject") else {}),
        **(
            {"call_to_action_text": auth_email["callToActionText"]}
            if auth_email.get("callToActionText")
            else {}
        ),
        **(
            {"verify_template": auth_email["verifyTemplate"]}
            if auth_email.get("verifyTemplate")
            else {}
        ),
        **(
            {"custom_content": auth_email["customContent"]}
            if auth_email.get("customContent")
            else {}
        ),
        **(
            {"custom_closing_content": auth_email["customClosingContent"]}
            if auth_email.get("customClosingContent")
            else {}
        ),
    }


def build_auth_mobile_config(auth_mobile: object) -> JsonDict:
    auth_mobile = as_json_dict(auth_mobile)
    return {
        **({"title": auth_mobile["title"]} if auth_mobile.get("title") else {}),
        **({"image": auth_mobile["image"]} if auth_mobile.get("image") else {}),
        **(
            {"call_to_action_text": auth_mobile["callToActionText"]}
            if auth_mobile.get("callToActionText")
            else {}
        ),
        **(
            {"hyperlink_text": auth_mobile["hyperlinkText"]}
            if auth_mobile.get("hyperlinkText")
            else {}
        ),
        **(
            {"hyperlink_redirect_url": auth_mobile["hyperlinkRedirectUrl"]}
            if auth_mobile.get("hyperlinkRedirectUrl")
            else {}
        ),
        **(
            {"custom_content": auth_mobile["customContent"]}
            if auth_mobile.get("customContent")
            else {}
        ),
    }


def build_legal_config(legal: object) -> JsonDict:
    legal = as_json_dict(legal)
    return {
        **({"company_name": legal["companyName"]} if legal.get("companyName") else {}),
        **(
            {"privacy_policy_url": legal["privacyPolicyUrl"]}
            if legal.get("privacyPolicyUrl")
            else {}
        ),
        **(
            {"terms_conditions_url": legal["termsConditionsUrl"]}
            if legal.get("termsConditionsUrl")
            else {}
        ),
        **({"support_email": legal["supportEmail"]} if legal.get("supportEmail") else {}),
    }


def build_profile_config(profile: object) -> JsonDict:
    profile = as_json_dict(profile)
    return {
        **(
            {"account_information": profile["accountInformation"]}
            if profile.get("accountInformation")
            else {}
        ),
        **(
            {"personal_information": profile["personalInformation"]}
            if profile.get("personalInformation")
            else {}
        ),
        **({"preferences": profile["preferences"]} if profile.get("preferences") else {}),
        **({"sign_out_button": profile["signOutButton"]} if profile.get("signOutButton") else {}),
        **(
            {"delete_account_button": profile["deleteAccountButton"]}
            if profile.get("deleteAccountButton")
            else {}
        ),
        **(
            {"add_sign_in_methods_button": profile["addSignInMethodsButton"]}
            if profile.get("addSignInMethodsButton")
            else {}
        ),
    }


def build_custom_content_config(custom_content: object) -> JsonDict:
    custom_content = as_json_dict(custom_content)
    return {
        **(
            {"sign_in_modal": build_sign_in_modal_config(custom_content.get("signInModal"))}
            if custom_content.get("signInModal")
            else {}
        ),
        **(
            {"profile_modal": custom_content["profileModal"]}
            if custom_content.get("profileModal")
            else {}
        ),
        **(
            {
                "verification_modal": build_verification_modal_config(
                    custom_content.get("verificationModal")
                )
            }
            if custom_content.get("verificationModal")
            else {}
        ),
        **(
            {
                "sign_in_failure_modal": {
                    "failure_message": as_json_dict(custom_content.get("signInFailureModal")).get(
                        "failureMessage"
                    )
                }
            }
            if custom_content.get("signInFailureModal")
            else {}
        ),
        **(
            {"no_account_message": custom_content["noAccountMessage"]}
            if custom_content.get("noAccountMessage")
            else {}
        ),
        **({"mobile": custom_content["mobile"]} if custom_content.get("mobile") else {}),
    }


def build_sign_in_modal_config(sign_in_modal: object) -> JsonDict:
    sign_in_modal = as_json_dict(sign_in_modal)
    return {
        **({"title": sign_in_modal["title"]} if sign_in_modal.get("title") else {}),
        **({"subtitle": sign_in_modal["subtitle"]} if sign_in_modal.get("subtitle") else {}),
        **(
            {"sign_in_title": sign_in_modal["signInTitle"]}
            if sign_in_modal.get("signInTitle")
            else {}
        ),
        **(
            {"sign_up_title": sign_in_modal["signUpTitle"]}
            if sign_in_modal.get("signUpTitle")
            else {}
        ),
        **(
            {"sign_in_subtitle": sign_in_modal["signInSubtitle"]}
            if sign_in_modal.get("signInSubtitle")
            else {}
        ),
        **(
            {"sign_up_subtitle": sign_in_modal["signUpSubtitle"]}
            if sign_in_modal.get("signUpSubtitle")
            else {}
        ),
        **(
            {"sign_in_button": sign_in_modal["signInButton"]}
            if sign_in_modal.get("signInButton")
            else {}
        ),
        **(
            {"sign_up_button": sign_in_modal["signUpButton"]}
            if sign_in_modal.get("signUpButton")
            else {}
        ),
    }


def build_verification_modal_config(verification_modal: object) -> JsonDict:
    verification_modal = as_json_dict(verification_modal)
    return {
        **({"title": verification_modal["title"]} if verification_modal.get("title") else {}),
        **(
            {"subtitle": verification_modal["subtitle"]}
            if verification_modal.get("subtitle")
            else {}
        ),
    }


def is_instant_anonymous_method(methods_array: List[JsonDict]) -> bool:
    return any(
        isinstance(item, dict)
        and item.get("method") == "anonymous"
        and item.get("type") == "instant"
        for item in methods_array
    )


def build_google_one_tap_config(value: object) -> JsonDict:
    one_tap = as_json_dict(value)
    return {
        "browser": build_one_tap_platform_config(one_tap.get("browser")),
        "mobile_app": build_one_tap_platform_config(one_tap.get("mobileApp")),
    }


def build_one_tap_platform_config(value: object) -> JsonDict:
    platform = as_json_dict(value)
    auto_prompt = platform.get("autoPrompt")
    delay = platform.get("delay")
    return {
        "auto_prompt": auto_prompt if isinstance(auto_prompt, bool) else False,
        "delay": delay if isinstance(delay, (int, float)) else 7000,
    }


def snake_case_auth_order(value: object) -> JsonDict:
    if not isinstance(value, dict):
        return {}
    result = {}
    for key, item in value.items():
        snake_key = "auto_prompt" if key == "autoPrompt" else key
        result[snake_key] = snake_case_auth_order(item) if isinstance(item, dict) else item
    return result

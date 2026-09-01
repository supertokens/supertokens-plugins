from __future__ import annotations

import asyncio
import json
import uuid
from contextlib import suppress
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Dict, List, NamedTuple, NoReturn, Optional, Tuple, Union, cast

import httpx
from supertokens_python import SupertokensConfig
from supertokens_python.asyncio import (
    create_user_id_mapping,
    delete_user,
    get_user,
    get_user_id_mapping,
    list_users_by_account_info,
)
from supertokens_python.framework.request import BaseRequest
from supertokens_python.recipe.accountlinking import asyncio as accountlinking_asyncio
from supertokens_python.recipe.accountlinking.interfaces import (
    CreatePrimaryUserOkResult,
    CreatePrimaryUserRecipeUserIdAlreadyLinkedError,
    LinkAccountsOkResult,
    LinkAccountsRecipeUserIdAlreadyLinkedError,
)
from supertokens_python.recipe.emailverification import asyncio as emailverification_asyncio
from supertokens_python.recipe.multitenancy import asyncio as multitenancy_asyncio
from supertokens_python.recipe.passwordless import asyncio as passwordless_asyncio
from supertokens_python.recipe.session import SessionContainer
from supertokens_python.recipe.session import asyncio as session_asyncio
from supertokens_python.recipe.thirdparty import asyncio as thirdparty_asyncio
from supertokens_python.recipe.thirdparty.interfaces import ManuallyCreateOrUpdateUserOkResult
from supertokens_python.recipe.thirdparty.types import ThirdPartyInfo
from supertokens_python.recipe.usermetadata import asyncio as usermetadata_asyncio
from supertokens_python.types import LoginMethod, RecipeUserId, User
from supertokens_python.types.base import AccountInfoInput, UserContext
from supertokens_python.interfaces import CreateUserIdMappingOkResult, GetUserIdMappingOkResult

from .constants import (
    GUEST_AUTH_METHOD_ID,
    INSTANT_AUTH_METHOD_ID,
    PUBLIC_TENANT_ID,
    RESERVED_OAUTH_CLAIMS,
)
from .config import (
    as_json_dict,
    as_json_list,
    assert_app_variant_is_configured,
    get_active_rownd_config,
)
from .errors import RowndEmailChangeError, RowndPluginError
from .logger import log_debug
from . import rownd_compatibility
from .types import JsonDict, RowndPluginConfig
from .utils import (
    clear_supertokens_core_call_cache,
    create_derived_user_context,
    create_pending_email_verification_user_context,
    optional_string,
)


_LINKED_OPERATIONAL_METADATA_FIELDS = {
    "rownd_email_recipe_user_id",
    "rownd_email_recipe_user_ids",
    "rownd_migration_complete",
    "rownd_pending_verification",
}


class _BulkImportError(RuntimeError):
    status: int
    response_text: str

    def __init__(self, status: int, response_text: str):
        self.status = status
        self.response_text = response_text
        super().__init__("Bulk import failed with status %s: %s" % (status, response_text))


def is_bulk_import_duplicate_identity_error(error: object) -> bool:
    if not isinstance(error, _BulkImportError) or error.status != 400:
        return False
    try:
        body = json.loads(error.response_text)
    except (TypeError, ValueError):
        return False
    if not isinstance(body, dict):
        return False
    errors = body.get("errors")
    return (
        isinstance(errors, list)
        and bool(errors)
        and all(isinstance(entry, str) and entry.startswith("E006:") for entry in errors)
    )


async def _import_user_with_e006_recovery(
    user_import: JsonDict,
    tenant_id: str,
    supertokens_config: SupertokensConfig,
    user_context: UserContext,
) -> None:
    try:
        await import_user(user_import, supertokens_config, user_context)
    except Exception as import_error:
        if not is_bulk_import_duplicate_identity_error(import_error):
            raise
        try:
            # Match Node by rerunning full reconciliation, including authoritative-passwordless checks.
            recovered = await reconcile_rownd_user_with_existing_login_methods(
                user_import,
                tenant_id,
                user_context,
            )
        except Exception as reconciliation_error:
            raise reconciliation_error from import_error
        if not recovered:
            raise


async def create_guest_session(
    config: RowndPluginConfig,
    request: BaseRequest,
    tenant_id: str,
    third_party_id: str,
    third_party_user_id: str,
    effective_auth_level: str,
    app_variant_id: Optional[str],
    user_context: UserContext,
) -> ManuallyCreateOrUpdateUserOkResult:
    result = await thirdparty_asyncio.manually_create_or_update_user(
        tenant_id=tenant_id,
        third_party_id=third_party_id,
        third_party_user_id=third_party_user_id,
        email="%s@anonymous.local" % third_party_user_id,
        is_verified=False,
        user_context=user_context,
    )
    if not isinstance(result, ManuallyCreateOrUpdateUserOkResult):
        raise RowndPluginError("Guest user creation failed")
    payload = {
        **rownd_compatibility.build_rownd_audience({}, config, app_variant_id),
        "auth_level": effective_auth_level,
        "is_anonymous": True,
        "app_user_id": result.user.id,
    }
    operation_context = create_derived_user_context(
        user_context, {"rowndAppVariantId": app_variant_id}
    )
    await record_rownd_app_variant_for_user(config, result.user.id, app_variant_id, operation_context)
    await session_asyncio.create_new_session(
        request,
        tenant_id,
        result.recipe_user_id,
        payload,
        {},
        operation_context,
    )
    return result


async def migrate_rownd_user_and_create_session(
    config: RowndPluginConfig,
    rownd_user_id: str,
    rownd_user: JsonDict,
    supertokens_config: SupertokensConfig,
    request: BaseRequest,
    tenant_id: str,
    app_variant_id: Optional[str],
    user_context: UserContext,
    migration_state: JsonDict,
) -> str:
    user = await get_user(rownd_user_id, user_context)
    existing_metadata = await get_user_metadata(user.id, user_context) if user else None
    recipe_user_id = None

    if user is None or (existing_metadata or {}).get("rownd_migration_complete") is not True:
        user_import = rownd_compatibility.map_rownd_user_to_supertokens(
            rownd_user,
            tenant_id if tenant_id != PUBLIC_TENANT_ID else None,
        )
        reconciled = await reconcile_rownd_user_with_existing_login_methods(
            user_import, tenant_id, user_context
        )
        if not reconciled:
            if user is not None:
                raise RuntimeError("Incomplete migrated user could not be reconciled")
            await _import_user_with_e006_recovery(
                user_import, tenant_id, supertokens_config, user_context
            )
        user = await get_user(rownd_user_id, user_context)
        if user is None:
            raise RowndPluginError("Imported user could not be resolved")

    supertokens_user_id = user.id
    migration_state["supertokens_user_id"] = supertokens_user_id
    recipe_user_id = user.login_methods[0].recipe_user_id if user.login_methods else None
    await record_rownd_app_variant_for_user(
        config, supertokens_user_id, app_variant_id, user_context
    )
    tenant_login_method = next(
        (
            method
            for method in user.login_methods
            if tenant_id in (getattr(method, "tenant_ids", None) or [])
        ),
        None,
    )
    if tenant_login_method is not None:
        recipe_user_id = tenant_login_method.recipe_user_id
    if recipe_user_id is None:
        raise RowndPluginError("User not found or has no login methods")

    await associate_user_login_methods_to_tenant(user, tenant_id, user_context)
    await sync_imported_email_verification_state(
        recipe_user_id, supertokens_user_id, tenant_id, user_context
    )
    await session_asyncio.create_new_session(
        request,
        tenant_id,
        recipe_user_id,
        await build_rownd_session_claims(
            config, supertokens_user_id, {}, app_variant_id, user_context
        ),
        {},
        create_derived_user_context(user_context, {"rowndAppVariantId": app_variant_id}),
    )
    return supertokens_user_id


async def associate_user_login_methods_to_tenant(
    user: User, tenant_id: str, user_context: UserContext
) -> None:
    for login_method in user.login_methods:
        if tenant_id in login_method.tenant_ids:
            continue
        association = await multitenancy_asyncio.associate_user_to_tenant(
            tenant_id, login_method.recipe_user_id, user_context
        )
        if getattr(association, "status", None) != "OK":
            raise RuntimeError(
                "Failed to associate migrated user with tenant: %s"
                % getattr(association, "status", "ERROR")
            )


async def revoke_all_user_sessions(session: SessionContainer, user_context: UserContext) -> None:
    await session_asyncio.revoke_all_sessions_for_user(
        session.get_user_id(user_context),
        revoke_sessions_for_linked_accounts=True,
        tenant_id=session.get_tenant_id(user_context),
        user_context=user_context,
    )


async def delete_user_and_linked_accounts(user_id: str, user_context: UserContext) -> None:
    await delete_user(user_id, remove_all_linked_accounts=True, user_context=user_context)


async def get_raw_user_metadata(
    user_id: str, user_context: Optional[UserContext] = None
) -> JsonDict:
    result = await usermetadata_asyncio.get_user_metadata(user_id, user_context)
    return result.metadata or {}


def get_original_rownd_user_id(metadata: JsonDict) -> Optional[str]:
    user_id = as_json_dict(as_json_dict(metadata.get("original_rownd_user")).get("data")).get(
        "user_id"
    )
    return user_id if isinstance(user_id, str) else None


def merge_missing_values(primary: JsonDict, secondary: JsonDict) -> JsonDict:
    merged = {**primary}
    for key, secondary_value in secondary.items():
        if key not in merged:
            merged[key] = secondary_value
        elif isinstance(merged[key], dict) and isinstance(secondary_value, dict):
            merged[key] = merge_missing_values(
                cast(JsonDict, merged[key]), cast(JsonDict, secondary_value)
            )
    return merged


def combine_linked_metadata(
    primary_user_id: str,
    primary_metadata: JsonDict,
    linked_metadata: List[Tuple[str, JsonDict]],
    mapped_rownd_user_id: Optional[str] = None,
) -> JsonDict:
    ordered = sorted(
        linked_metadata,
        key=lambda item: (
            not (
                mapped_rownd_user_id is not None
                and get_original_rownd_user_id(item[1]) == mapped_rownd_user_id
            ),
            item[0],
        ),
    )
    primary_rownd_user_id = get_original_rownd_user_id(primary_metadata)
    canonical_linked_metadata = (
        next(
            (
                item
                for item in ordered
                if get_original_rownd_user_id(item[1]) == mapped_rownd_user_id
            ),
            None,
        )
        if mapped_rownd_user_id is not None
        else None
    )
    canonical_replaces_primary = (
        canonical_linked_metadata is not None and primary_rownd_user_id != mapped_rownd_user_id
    )
    metadata_update: JsonDict = (
        {"original_rownd_user": canonical_linked_metadata[1]["original_rownd_user"]}
        if canonical_replaces_primary and canonical_linked_metadata is not None
        else {}
    )
    for _, metadata in ordered:
        for key, value in metadata.items():
            if key in _LINKED_OPERATIONAL_METADATA_FIELDS:
                continue
            if (
                key == "original_rownd_user"
                and mapped_rownd_user_id is not None
                and (
                    primary_rownd_user_id == mapped_rownd_user_id
                    or canonical_linked_metadata is not None
                )
                and get_original_rownd_user_id(metadata) != mapped_rownd_user_id
            ):
                continue
            current = metadata_update[key] if key in metadata_update else primary_metadata.get(key)
            if key not in metadata_update and key not in primary_metadata:
                metadata_update[key] = value
            elif isinstance(current, dict) and isinstance(value, dict):
                merged = merge_missing_values(cast(JsonDict, current), cast(JsonDict, value))
                if merged != current:
                    metadata_update[key] = merged

    primary_is_source = primary_rownd_user_id is not None and (
        mapped_rownd_user_id is None
        or primary_rownd_user_id == mapped_rownd_user_id
        or canonical_linked_metadata is None
    )
    source_user_id = (
        primary_user_id
        if primary_is_source
        else (
            canonical_linked_metadata[0]
            if canonical_linked_metadata is not None
            else next(
                (
                    linked_user_id
                    for linked_user_id, metadata in ordered
                    if get_original_rownd_user_id(metadata) is not None
                ),
                None,
            )
        )
    )
    return {
        "primary_user_id": primary_user_id,
        "linked_user_ids": [linked_user_id for linked_user_id, _ in ordered],
        "primary_metadata": primary_metadata,
        "combined_metadata": {**primary_metadata, **metadata_update},
        "metadata_update": metadata_update,
        "rownd_metadata_source_user_id": source_user_id,
    }


async def get_primary_user_mapping(
    user_id: str, user_context: Optional[UserContext] = None
) -> Optional[GetUserIdMappingOkResult]:
    context = user_context if user_context is not None else {}
    internal = await get_user_id_mapping(user_id, "SUPERTOKENS", context)
    if isinstance(internal, GetUserIdMappingOkResult):
        return internal
    external = await get_user_id_mapping(user_id, "EXTERNAL", context)
    return external if isinstance(external, GetUserIdMappingOkResult) else None


async def inspect_linked_user_metadata(
    user_id: str,
    user_context: Optional[UserContext] = None,
    user_override: Optional[User] = None,
) -> Dict[str, Any]:
    user = user_override if user_override is not None else await get_user(user_id, user_context)
    if user is None:
        metadata = await get_raw_user_metadata(user_id, user_context)
        return {**combine_linked_metadata(user_id, metadata, []), "user": None}

    mapping = await get_primary_user_mapping(user.id, user_context)
    primary_user_id = mapping.supertokens_user_id if mapping else user.id
    linked_user_ids = sorted(
        {
            method.recipe_user_id.get_as_string()
            for method in user.login_methods
            if method.recipe_user_id.get_as_string() != primary_user_id
        }
    )
    metadata_results = await asyncio.gather(
        get_raw_user_metadata(primary_user_id, user_context),
        *(
            get_raw_user_metadata(linked_user_id, user_context)
            for linked_user_id in linked_user_ids
        ),
    )
    return {
        **combine_linked_metadata(
            primary_user_id,
            metadata_results[0],
            list(zip(linked_user_ids, metadata_results[1:])),
            mapping.external_user_id if mapping else None,
        ),
        "user": user,
    }


async def get_user_metadata(user_id: str, user_context: Optional[UserContext] = None) -> JsonDict:
    inspection = await inspect_linked_user_metadata(user_id, user_context)
    return cast(JsonDict, inspection["combined_metadata"])


async def update_primary_user_metadata(
    user_id: str,
    metadata_update: JsonDict,
    user_context: Optional[UserContext] = None,
) -> Tuple[str, JsonDict]:
    user = await get_user(user_id, user_context)
    mapping = await get_primary_user_mapping(user.id, user_context) if user else None
    primary_user_id = mapping.supertokens_user_id if mapping else user.id if user else user_id
    result = await usermetadata_asyncio.update_user_metadata(
        primary_user_id, metadata_update, user_context
    )
    return primary_user_id, result.metadata or {}


async def replace_primary_user_metadata(
    user_id: str,
    metadata: JsonDict,
    user_context: Optional[UserContext] = None,
) -> None:
    mapping = await get_primary_user_mapping(user_id, user_context)
    primary_user_id = mapping.supertokens_user_id if mapping else user_id
    await usermetadata_asyncio.clear_user_metadata(primary_user_id, user_context)
    if metadata:
        await usermetadata_asyncio.update_user_metadata(primary_user_id, metadata, user_context)


async def update_user_metadata(
    user_id: str, input_meta: JsonDict, user_context: Optional[UserContext] = None
) -> JsonDict:
    primary_user_id, updated = await update_primary_user_metadata(user_id, input_meta, user_context)
    return {"id": primary_user_id, "meta": rownd_compatibility.public_metadata(updated)}


async def update_user_data(
    config: RowndPluginConfig,
    user_id: str,
    input_data: JsonDict,
    tenant_id: str = PUBLIC_TENANT_ID,
    user_context: Optional[UserContext] = None,
) -> JsonDict:
    primary_user_id, _ = await update_primary_user_metadata(user_id, input_data, user_context)
    return await get_rownd_compat_user(
        primary_user_id, config, tenant_id, user_context=user_context
    )


async def get_rownd_compat_user(
    user_id: str,
    config: Optional[RowndPluginConfig] = None,
    tenant_id: str = PUBLIC_TENANT_ID,
    metadata_override: Optional[JsonDict] = None,
    user_override: Optional[User] = None,
    user_context: Optional[UserContext] = None,
) -> JsonDict:
    inspection = (
        None
        if metadata_override is not None and user_override is not None
        else await inspect_linked_user_metadata(user_id, user_context, user_override)
    )
    metadata = (
        metadata_override
        if metadata_override is not None
        else cast(JsonDict, cast(JsonDict, inspection)["combined_metadata"])
    )
    st_user = (
        user_override
        if user_override is not None
        else cast(Optional[User], cast(JsonDict, inspection)["user"])
    )
    if st_user is None:
        raise RowndPluginError("User not found in Rownd")

    latest_session_info = await get_latest_session_info(st_user.id, tenant_id, user_context)
    return rownd_compatibility.project_rownd_compat_user(
        user_id, st_user, metadata, config, tenant_id, latest_session_info
    )


async def get_latest_session_info(
    user_id: str,
    tenant_id: str = PUBLIC_TENANT_ID,
    user_context: Optional[UserContext] = None,
):
    try:
        handles = await session_asyncio.get_all_session_handles_for_user(
            user_id,
            fetch_sessions_for_linked_accounts=True,
            tenant_id=tenant_id,
            user_context=user_context,
        )
    except Exception:
        return None
    latest = None
    for handle in handles:
        session_info = await session_asyncio.get_session_information(handle, user_context)
        if session_info is not None and (
            latest is None or session_info.time_created > latest.time_created
        ):
            latest = session_info
    return latest


async def build_rownd_session_claims(
    config: RowndPluginConfig,
    user_id: str,
    current_payload: JsonDict,
    app_variant_id: Optional[str],
    user_context: Optional[UserContext] = None,
) -> JsonDict:
    inspection = await inspect_linked_user_metadata(user_id, user_context)
    user = cast(Optional[User], inspection["user"])
    metadata = cast(JsonDict, inspection["combined_metadata"]) if user else {}
    return rownd_compatibility.build_rownd_session_claim_payload(
        config, user_id, user, metadata, current_payload, app_variant_id
    )


async def build_rownd_session_and_anonymous_claims(
    config: RowndPluginConfig,
    user_id: str,
    current_payload: JsonDict,
    app_variant_id: Optional[str],
    user_context: UserContext,
) -> Tuple[JsonDict, JsonDict]:
    inspection = await inspect_linked_user_metadata(user_id, user_context)
    user = cast(Optional[User], inspection["user"])
    metadata = cast(JsonDict, inspection["combined_metadata"]) if user else {}
    rownd_claims = rownd_compatibility.build_rownd_session_claim_payload(
        config, user_id, user, metadata, current_payload, app_variant_id
    )
    is_anonymous = rownd_compatibility.get_effective_auth_level(user) in {
        GUEST_AUTH_METHOD_ID,
        INSTANT_AUTH_METHOD_ID,
    }
    from supertokens_python.utils import get_timestamp_ms

    return rownd_claims, {"is_anonymous": {"v": is_anonymous, "t": get_timestamp_ms()}}


async def build_rownd_oauth_payload(
    config: RowndPluginConfig,
    user: Optional[User],
    scopes: List[str],
    current_payload: Optional[JsonDict],
    user_context: UserContext,
) -> JsonDict:
    payload = current_payload or {}
    metadata = (
        cast(
            JsonDict,
            (await inspect_linked_user_metadata(user.id, user_context, user))["combined_metadata"],
        )
        if user
        else {}
    )
    rownd_audience = rownd_compatibility.get_rownd_oauth_audience(
        requested_audience=rownd_compatibility.first_string(
            user_context.get("rowndOAuthAudience")
        )
    )
    return {
        **payload,
        **(
            rownd_compatibility.build_standard_oauth_claims(user, scopes, metadata)
            if user
            else {}
        ),
        **(
            rownd_compatibility.build_rownd_session_claim_payload(
                config, user.id, user, metadata, payload, None, RESERVED_OAUTH_CLAIMS
            )
            if user
            else {}
        ),
        **({"aud": rownd_audience} if rownd_audience else {}),
    }


async def build_rownd_oauth_user_info(
    user: User,
    access_token_payload: JsonDict,
    scopes: List[str],
    current_payload: Optional[JsonDict],
    user_context: Optional[UserContext] = None,
) -> JsonDict:
    metadata = cast(
        JsonDict,
        (await inspect_linked_user_metadata(user.id, user_context, user))["combined_metadata"],
    )
    return {
        **(current_payload or {}),
        **rownd_compatibility.build_standard_oauth_claims(user, scopes, metadata),
        **rownd_compatibility.pick_oauth_user_info_rownd_claims(access_token_payload),
    }


async def record_rownd_app_variant_for_user(
    config: RowndPluginConfig,
    user_id: str,
    app_variant_id: Optional[str],
    user_context: Optional[UserContext] = None,
) -> None:
    if not app_variant_id:
        return
    assert_app_variant_is_configured(config, app_variant_id)
    operation_context = user_context if user_context is not None else {}
    inspection = await inspect_linked_user_metadata(user_id, operation_context)
    metadata_user_id = cast(
        str,
        inspection.get("rownd_metadata_source_user_id") or inspection["primary_user_id"],
    )
    clear_supertokens_core_call_cache(operation_context)
    metadata = await get_raw_user_metadata(metadata_user_id, operation_context)
    original = as_json_dict(metadata.get("original_rownd_user"))
    attributes = as_json_dict(original.get("attributes"))
    app_variants = attributes.get("rownd:app_variants") or []
    if isinstance(app_variants, str):
        app_variants = [app_variants]
    if not isinstance(app_variants, list):
        app_variants = []
    if app_variant_id in app_variants:
        return
    await usermetadata_asyncio.update_user_metadata(
        metadata_user_id,
        {
            "original_rownd_user": {
                **original,
                "data": as_json_dict(original.get("data")) or {"user_id": metadata_user_id},
                "verified_data": as_json_dict(original.get("verified_data")),
                "attributes": {**attributes, "rownd:app_variants": [*app_variants, app_variant_id]},
            },
        },
        operation_context,
    )


async def import_user(
    user_import: JsonDict,
    supertokens_config: SupertokensConfig,
    user_context: UserContext,
) -> JsonDict:
    headers = {"Content-Type": "application/json"}
    if supertokens_config.api_key:
        headers["api-key"] = supertokens_config.api_key
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            res = await client.post(
                supertokens_config.connection_uri.rstrip("/") + "/bulk-import/import",
                headers=headers,
                json=user_import,
            )
    finally:
        clear_supertokens_core_call_cache(user_context)
    if res.status_code < 200 or res.status_code >= 300:
        raise _BulkImportError(res.status_code, res.text)
    data = res.json()
    if data.get("status") != "OK" or not data.get("user"):
        raise RuntimeError(
            "Bulk import failed: %s" % (data.get("message") or "Missing user in response")
        )
    return data["user"]


def login_method_matches_import(login_method: LoginMethod, method_import: JsonDict) -> bool:
    recipe_id = method_import.get("recipeId")
    if login_method.recipe_id != recipe_id:
        return False
    if recipe_id == "thirdparty":
        third_party_user_id = optional_string(method_import.get("thirdPartyUserId"))
        third_party_id = optional_string(method_import.get("thirdPartyId"))
        if not third_party_user_id or not third_party_id:
            return False
        return login_method.has_same_third_party_info_as(
            ThirdPartyInfo(
                third_party_user_id,
                third_party_id,
            )
        )
    if recipe_id == "passwordless":
        email = optional_string(method_import.get("email"))
        return (
            login_method.has_same_email_as(email)
            if email
            else login_method.has_same_phone_number_as(
                optional_string(method_import.get("phoneNumber"))
            )
        )
    return login_method.has_same_email_as(optional_string(method_import.get("email")))


def import_method_account_infos(method_import: JsonDict) -> List[AccountInfoInput]:
    if method_import.get("recipeId") == "thirdparty":
        third_party_user_id = optional_string(method_import.get("thirdPartyUserId"))
        third_party_id = optional_string(method_import.get("thirdPartyId"))
        email = optional_string(method_import.get("email"))
        if not third_party_user_id or not third_party_id or not email:
            raise RuntimeError("Migrated third-party login method is incomplete")
        return [
            AccountInfoInput(
                third_party=ThirdPartyInfo(
                    third_party_user_id,
                    third_party_id,
                )
            ),
            AccountInfoInput(email=email),
        ]
    email = optional_string(method_import.get("email"))
    if email:
        return [AccountInfoInput(email=email)]
    phone_number = optional_string(method_import.get("phoneNumber"))
    if phone_number:
        return [AccountInfoInput(phone_number=phone_number)]
    raise RuntimeError("Migrated login method has no account information")


def login_method_owns_import_account_info(
    user: User, login_method: LoginMethod, method_import: JsonDict
) -> bool:
    if login_method_matches_import(login_method, method_import):
        return True
    if not user.is_primary_user:
        return False

    email = optional_string(method_import.get("email"))
    if method_import.get("recipeId") == "thirdparty":
        return login_method.has_same_email_as(email)
    if method_import.get("recipeId") == "passwordless" and not email:
        return login_method.has_same_phone_number_as(
            optional_string(method_import.get("phoneNumber"))
        )
    return login_method.has_same_email_as(email)


class ImportMethodInspection(NamedTuple):
    method_import: JsonDict
    owners: List[Tuple[User, LoginMethod]]
    match: Optional[Tuple[User, LoginMethod]]
    reconciliation_match: Optional[Tuple[User, LoginMethod]]


async def inspect_import_method(
    method_import: JsonDict,
    tenant_id: str,
    user_context: UserContext,
) -> ImportMethodInspection:
    user_lists = await asyncio.gather(
        *(
            list_users_by_account_info(
                tenant_id,
                account_info,
                False,
                user_context,
            )
            for account_info in import_method_account_infos(method_import)
        )
    )
    users = {user.id: user for user_list in user_lists for user in user_list}.values()
    owners = [
        (user, login_method)
        for user in users
        for login_method in user.login_methods
        if tenant_id in login_method.tenant_ids
        and login_method_owns_import_account_info(user, login_method, method_import)
    ]
    match = next(
        (
            owner
            for owner in owners
            if login_method_matches_import(owner[1], method_import)
            and (
                method_import.get("recipeId") == "thirdparty"
                or method_import.get("recipeId") == "passwordless"
                or (method_import.get("isVerified") is True and owner[1].verified)
            )
        ),
        None,
    )
    reconciliation_match = match
    if (
        reconciliation_match is None
        and method_import.get("recipeId") == "passwordless"
        and isinstance(method_import.get("email"), str)
        and method_import.get("isVerified") is True
    ):
        reconciliation_match = next(
            (owner for owner in owners if owner[0].is_primary_user and owner[1].verified),
            None,
        )
    return ImportMethodInspection(method_import, owners, match, reconciliation_match)


async def create_missing_login_method(
    method_import: JsonDict,
    tenant_id: str,
    primary_user_id: str,
    user_context: UserContext,
) -> Tuple[RecipeUserId, bool]:
    reconciliation_context = create_derived_user_context(
        user_context, {"rowndDisableAutomaticAccountLinking": True}
    )
    if method_import.get("recipeId") == "thirdparty":
        third_party_id = optional_string(method_import.get("thirdPartyId"))
        third_party_user_id = optional_string(method_import.get("thirdPartyUserId"))
        email = optional_string(method_import.get("email"))
        if not third_party_id or not third_party_user_id or not email:
            raise RuntimeError("Migrated third-party login method is incomplete")
        result = await thirdparty_asyncio.manually_create_or_update_user(
            tenant_id=tenant_id,
            third_party_id=third_party_id,
            third_party_user_id=third_party_user_id,
            email=email,
            is_verified=bool(method_import.get("isVerified")),
            user_context=reconciliation_context,
        )
        if not isinstance(result, ManuallyCreateOrUpdateUserOkResult):
            raise RuntimeError(
                "Failed to create migrated third-party login method: %s"
                % getattr(result, "status", "ERROR")
            )
        if not result.created_new_recipe_user and not await sdk_user_id_matches_internal_target(
            result.user.id, primary_user_id, reconciliation_context
        ):
            raise RuntimeError(
                "Migrated third-party login method belongs to another SuperTokens user"
            )
        return result.recipe_user_id, result.created_new_recipe_user

    if method_import.get("recipeId") == "passwordless":
        email = optional_string(method_import.get("email"))
        phone_number = optional_string(method_import.get("phoneNumber"))
        result = await passwordless_asyncio.signinup(
            tenant_id,
            email,
            phone_number,
            None,
            reconciliation_context,
        )
        if not result.created_new_recipe_user and not await sdk_user_id_matches_internal_target(
            result.user.id, primary_user_id, reconciliation_context
        ):
            raise RuntimeError(
                "Migrated passwordless login method belongs to another SuperTokens user"
            )
        return result.recipe_user_id, result.created_new_recipe_user

    raise RuntimeError(
        "Cannot reconcile unsupported login method: %s" % method_import.get("recipeId")
    )


async def resolve_supertokens_user_id(user_id: str, user_context: UserContext) -> str:
    mapping = await get_user_id_mapping(user_id, "EXTERNAL", user_context)
    return mapping.supertokens_user_id if isinstance(mapping, GetUserIdMappingOkResult) else user_id


async def freshly_resolve_sdk_user_id_to_internal(
    sdk_user_id: str, user_context: UserContext
) -> str:
    clear_supertokens_core_call_cache(user_context)
    return await resolve_supertokens_user_id(sdk_user_id, user_context)


async def sdk_user_id_matches_internal_target(
    sdk_user_id: str, expected_internal_user_id: str, user_context: UserContext
) -> bool:
    if sdk_user_id == expected_internal_user_id:
        return True
    resolved_sdk_user_id = await freshly_resolve_sdk_user_id_to_internal(sdk_user_id, user_context)
    return resolved_sdk_user_id == expected_internal_user_id


async def assert_user_is_not_mapped_to_another_rownd_user(
    supertokens_user_id: str,
    rownd_user_id: str,
    user_context: UserContext,
) -> None:
    mapping = await get_user_id_mapping(supertokens_user_id, "SUPERTOKENS", user_context)
    if isinstance(mapping, GetUserIdMappingOkResult) and mapping.external_user_id != rownd_user_id:
        raise RuntimeError("A migrated login method is already mapped to another Rownd user")


async def assert_rownd_user_id_can_be_mapped(
    supertokens_user_id: str,
    rownd_user_id: str,
    user_context: UserContext,
) -> bool:
    external_mapping = await get_user_id_mapping(rownd_user_id, "EXTERNAL", user_context)
    if isinstance(external_mapping, GetUserIdMappingOkResult):
        if not await sdk_user_id_matches_internal_target(
            external_mapping.supertokens_user_id, supertokens_user_id, user_context
        ):
            raise RuntimeError("The Rownd user ID is already mapped to another SuperTokens user")
        return True

    internal_mapping = await get_user_id_mapping(supertokens_user_id, "SUPERTOKENS", user_context)
    if isinstance(internal_mapping, GetUserIdMappingOkResult):
        if internal_mapping.external_user_id != rownd_user_id:
            raise RuntimeError("The SuperTokens user is already mapped to another external user ID")
        return True
    return False


async def ensure_primary_user(
    user: User,
    login_method: LoginMethod,
    supertokens_user_id: str,
    user_context: UserContext,
) -> str:
    if user.is_primary_user:
        return supertokens_user_id
    result = await accountlinking_asyncio.create_primary_user(
        login_method.recipe_user_id,
        user_context,
    )
    if isinstance(result, CreatePrimaryUserOkResult):
        return supertokens_user_id
    if isinstance(result, CreatePrimaryUserRecipeUserIdAlreadyLinkedError):
        if await sdk_user_id_matches_internal_target(
            result.primary_user_id, supertokens_user_id, user_context
        ):
            return supertokens_user_id
        raise RuntimeError("A migrated login method belongs to a different primary user")
    raise RuntimeError("A migrated login method belongs to a different primary user")


async def create_rownd_user_id_mapping(
    supertokens_user_id: str,
    rownd_user_id: str,
    user_context: UserContext,
) -> bool:
    try:
        mapping_result = await create_user_id_mapping(
            supertokens_user_id,
            rownd_user_id,
            force=False,
            user_context=user_context,
        )
    except KeyError as error:
        if error.args != ("does_external_user_id_exist",):
            raise
        clear_supertokens_core_call_cache(user_context)
        existing = await get_user_id_mapping(rownd_user_id, "EXTERNAL", user_context)
        if isinstance(
            existing, GetUserIdMappingOkResult
        ) and await sdk_user_id_matches_internal_target(
            existing.supertokens_user_id, supertokens_user_id, user_context
        ):
            return False
        raise
    if isinstance(mapping_result, CreateUserIdMappingOkResult):
        return True
    clear_supertokens_core_call_cache(user_context)
    existing = await get_user_id_mapping(rownd_user_id, "EXTERNAL", user_context)
    if isinstance(existing, GetUserIdMappingOkResult) and await sdk_user_id_matches_internal_target(
        existing.supertokens_user_id, supertokens_user_id, user_context
    ):
        return False
    raise RuntimeError(
        "Failed to map migrated Rownd user ID: %s" % getattr(mapping_result, "status", "ERROR")
    )


async def reconcile_rownd_user_with_existing_login_methods(
    user_import: JsonDict,
    tenant_id: str,
    user_context: UserContext,
) -> bool:
    external_user_id = user_import.get("externalUserId")
    if not isinstance(external_user_id, str):
        raise RuntimeError("Migrated Rownd user has no external user ID")

    clear_supertokens_core_call_cache(user_context)
    method_imports = as_json_list(user_import.get("loginMethods"))
    inspections = await asyncio.gather(
        *(inspect_import_method(method, tenant_id, user_context) for method in method_imports)
    )
    matches = [
        inspection.reconciliation_match
        for inspection in inspections
        if inspection.reconciliation_match is not None
    ]
    if not matches:
        if any(inspection.owners for inspection in inspections):
            raise RuntimeError(
                "Migrated account information is reserved by an existing SuperTokens user "
                "and cannot be safely reconciled"
            )
        return False

    third_party_matches = [
        inspection.match
        for inspection in inspections
        if inspection.method_import.get("recipeId") == "thirdparty"
        and inspection.match is not None
    ]
    target_user, target_login_method = third_party_matches[0] if third_party_matches else matches[0]
    resolved_user_ids: Dict[str, "asyncio.Task[str]"] = {}

    def resolve_user_id(user_id: str) -> "asyncio.Task[str]":
        task = resolved_user_ids.get(user_id)
        if task is None:
            task = asyncio.create_task(resolve_supertokens_user_id(user_id, user_context))
            resolved_user_ids[user_id] = task
        return task

    target_supertokens_user_id = await resolve_user_id(target_user.id)
    owner_inputs = [
        (inspection.method_import, owner, login_method)
        for inspection in inspections
        for owner, login_method in inspection.owners
    ]
    owner_ids = await asyncio.gather(*(resolve_user_id(owner.id) for _, owner, _ in owner_inputs))
    inspected_owners = [
        (*owner_input, owner_id) for owner_input, owner_id in zip(owner_inputs, owner_ids)
    ]
    foreign_owners = [
        owner_info for owner_info in inspected_owners if owner_info[3] != target_supertokens_user_id
    ]
    can_link_verified_email_owners = (
        bool(third_party_matches)
        and all(
            owner_id == target_supertokens_user_id
            for method, _, _, owner_id in inspected_owners
            if method.get("recipeId") == "thirdparty"
        )
        and all(
            method.get("recipeId") == "passwordless"
            and isinstance(method.get("email"), str)
            and method.get("isVerified") is True
            and login_method.recipe_id == "passwordless"
            and login_method.has_same_email_as(cast(str, method["email"]))
            and not owner.is_primary_user
            for method, owner, login_method, _ in foreign_owners
        )
    )
    if foreign_owners and not can_link_verified_email_owners:
        raise RuntimeError("A migrated login method belongs to a different SuperTokens user")
    for _, _, _, owner_id in foreign_owners:
        await assert_user_is_not_mapped_to_another_rownd_user(
            owner_id,
            external_user_id,
            user_context,
        )
    unsupported = next(
        (
            inspection.method_import
            for inspection in inspections
            if inspection.match is None
            and inspection.method_import.get("recipeId") == "emailpassword"
        ),
        None,
    )
    if unsupported is not None:
        raise RuntimeError("Cannot reconcile unsupported login method: emailpassword")

    clear_supertokens_core_call_cache(user_context)
    existing_mapping_matches = await assert_rownd_user_id_can_be_mapped(
        target_supertokens_user_id, external_user_id, user_context
    )
    mapping_exists = target_supertokens_user_id == external_user_id or existing_mapping_matches
    primary_user_id = await ensure_primary_user(
        target_user,
        target_login_method,
        target_supertokens_user_id,
        user_context,
    )
    foreign_recipe_user_ids = {
        login_method.recipe_user_id.get_as_string(): login_method.recipe_user_id
        for _, _, login_method, _ in foreign_owners
    }
    for recipe_user_id in foreign_recipe_user_ids.values():
        link_result = await accountlinking_asyncio.link_accounts(
            recipe_user_id,
            primary_user_id,
            user_context,
        )
        if not isinstance(link_result, LinkAccountsOkResult):
            raise RuntimeError(
                "Failed to link migrated login method: %s" % getattr(link_result, "status", "ERROR")
            )
    for inspection in inspections:
        method_import = inspection.method_import
        if inspection.match is not None:
            continue
        verified_matching_email = None
        email = optional_string(method_import.get("email"))
        if method_import.get("recipeId") == "passwordless" and email:
            verified_matching_email = next(
                (
                    method
                    for method in target_user.login_methods
                    if tenant_id in method.tenant_ids
                    and method.verified
                    and method.has_same_email_as(email)
                ),
                None,
            )
        effective_import = (
            {**method_import, "isVerified": True}
            if verified_matching_email is not None
            else method_import
        )
        recipe_user_id, _ = await create_missing_login_method(
            effective_import, tenant_id, primary_user_id, user_context
        )
        created_user = await get_user(recipe_user_id.get_as_string(), user_context)
        if created_user is None:
            raise RuntimeError("Created migrated login method was not found")
        if not await sdk_user_id_matches_internal_target(
            created_user.id, primary_user_id, user_context
        ):
            link_result = await accountlinking_asyncio.link_accounts(
                recipe_user_id, primary_user_id, user_context
            )
            already_linked = isinstance(
                link_result, LinkAccountsRecipeUserIdAlreadyLinkedError
            ) and await sdk_user_id_matches_internal_target(
                link_result.primary_user_id, primary_user_id, user_context
            )
            if not isinstance(link_result, LinkAccountsOkResult) and not already_linked:
                raise RuntimeError(
                    "Failed to link migrated login method: %s"
                    % getattr(link_result, "status", "ERROR")
                )
        if (
            effective_import.get("recipeId") == "passwordless"
            and email
            and not effective_import.get("isVerified")
        ):
            await emailverification_asyncio.unverify_email(
                recipe_user_id,
                email,
                user_context,
            )

    if not mapping_exists:
        clear_supertokens_core_call_cache(user_context)
        mapping_exists = await assert_rownd_user_id_can_be_mapped(
            primary_user_id, external_user_id, user_context
        )
        if not mapping_exists:
            await create_rownd_user_id_mapping(primary_user_id, external_user_id, user_context)
    await usermetadata_asyncio.update_user_metadata(
        primary_user_id,
        as_json_dict(user_import.get("userMetadata")),
        user_context,
    )
    return True


async def sync_imported_email_verification_state(
    recipe_user_id: RecipeUserId,
    user_id: Optional[str],
    tenant_id: str,
    user_context: UserContext,
) -> None:
    metadata = await get_user_metadata(user_id or recipe_user_id.get_as_string(), user_context)
    original = as_json_dict(metadata.get("original_rownd_user"))
    data = as_json_dict(original.get("data"))
    verified_data = as_json_dict(original.get("verified_data"))
    email = data.get("email")
    if not isinstance(email, str) or not rownd_compatibility.is_rownd_email_verified(
        verified_data.get("email"), email
    ):
        return
    try:
        token_result = await emailverification_asyncio.create_email_verification_token(
            tenant_id, recipe_user_id, email, user_context
        )
        token = getattr(token_result, "token", None)
        if isinstance(token, str):
            await emailverification_asyncio.verify_email_using_token(
                tenant_id, token, False, user_context
            )
    except Exception:
        return


async def start_pending_email_verification(
    config: RowndPluginConfig,
    session: SessionContainer,
    email: str,
    user_context: UserContext,
) -> JsonDict:
    user_id = session.get_user_id(user_context)
    tenant_id = session.get_tenant_id(user_context)
    user = await get_user(user_id, user_context)
    if user is None:
        raise RowndPluginError("User not found in Rownd")
    metadata_inspection = await inspect_linked_user_metadata(user.id, user_context)
    metadata = cast(JsonDict, metadata_inspection["primary_metadata"])
    combined_metadata = cast(JsonDict, metadata_inspection["combined_metadata"])
    normalized_email = normalize_email(email)
    if not normalized_email:
        raise RowndEmailChangeError("INVALID_EMAIL", 400, "email must be a non-empty string")
    passwordless_method = find_canonical_passwordless_method(user, combined_metadata, tenant_id)
    tenant_login_methods = [
        method for method in user.login_methods if tenant_id in method.tenant_ids
    ]
    has_passwordless_method = any(
        method.recipe_id == "passwordless" for method in tenant_login_methods
    )
    initiating_login_method = next(
        (
            method
            for method in user.login_methods
            if method.recipe_user_id.get_as_string()
            == session.get_recipe_user_id(user_context).get_as_string()
            and tenant_id in method.tenant_ids
        ),
        None,
    )
    can_add_passwordless = (
        not has_passwordless_method
        and initiating_login_method is not None
        and rownd_compatibility.is_real_third_party_method(initiating_login_method)
        and all(
            rownd_compatibility.is_real_third_party_method(method)
            for method in tenant_login_methods
        )
    )
    if passwordless_method is None and not can_add_passwordless:
        raise RowndEmailChangeError(
            "CONFLICT", 409, "the account has no passwordless sign-in method"
        )
    current_email = as_json_dict(
        (
            await get_rownd_compat_user(
                user_id,
                config,
                tenant_id,
                metadata_override=combined_metadata,
                user_override=user,
                user_context=user_context,
            )
        ).get("data")
    ).get("email")
    pending = get_pending_verifications(metadata)
    pending_email_verifications = [item for item in pending if item.get("field") == "email"]
    if any(item.get("status") == "COMMITTING" for item in pending_email_verifications):
        raise RowndEmailChangeError("CONFLICT", 409, "an email change is already being committed")

    if isinstance(current_email, str) and normalize_email(current_email) == normalized_email:
        for verification in pending_email_verifications:
            await revoke_pending_email_verification_tokens(
                user,
                verification,
                session.get_recipe_user_id(user_context),
                user_context,
            )
        current_passwordless_method = next(
            (
                method
                for method in user.login_methods
                if method.recipe_id == "passwordless"
                and tenant_id in method.tenant_ids
                and method.verified
                and method.email
                and normalize_email(method.email) == normalized_email
            ),
            None,
        )
        updated_metadata = {
            **metadata,
            **(
                {
                    "rownd_email_recipe_user_id": (
                        current_passwordless_method.recipe_user_id.get_as_string()
                    ),
                    "rownd_email_recipe_user_ids": {
                        **as_json_dict(combined_metadata.get("rownd_email_recipe_user_ids")),
                        tenant_id: current_passwordless_method.recipe_user_id.get_as_string(),
                    },
                }
                if current_passwordless_method is not None
                else {}
            ),
            "rownd_pending_verification": [
                item for item in pending if item.get("field") != "email"
            ],
        }
        if pending_email_verifications or current_passwordless_method is not None:
            await update_primary_user_metadata(user_id, updated_metadata, user_context)
        return await get_rownd_compat_user(
            user_id,
            config,
            tenant_id,
            metadata_override={**combined_metadata, **updated_metadata},
            user_override=user,
            user_context=user_context,
        )

    await assert_email_available_for_user(normalized_email, user.id, user_context)
    purpose = "UPDATE_PASSWORDLESS" if passwordless_method else "ADD_PASSWORDLESS"
    verification_recipe_user_id = (
        passwordless_method.recipe_user_id
        if passwordless_method
        else session.get_recipe_user_id(user_context)
    )
    for verification in pending_email_verifications:
        await revoke_pending_email_verification_tokens(
            user,
            verification,
            session.get_recipe_user_id(user_context),
            user_context,
        )

    now = datetime.now(timezone.utc)
    pending_verification_id = str(uuid.uuid4())
    pending_verification: JsonDict = {
        "id": pending_verification_id,
        "field": "email",
        "value": email,
        "created_at": now.isoformat().replace("+00:00", "Z"),
        "tenantId": tenant_id,
        "purpose": purpose,
        "initiatingSessionHandle": session.get_handle(user_context),
        "verificationRecipeUserId": verification_recipe_user_id.get_as_string(),
        "status": "PENDING",
    }
    await update_primary_user_metadata(
        user_id,
        {
            **metadata,
            "rownd_pending_verification": [
                *[item for item in pending if item.get("field") != "email"],
                pending_verification,
            ],
        },
        user_context,
    )

    try:
        await emailverification_asyncio.revoke_email_verification_tokens(
            tenant_id, verification_recipe_user_id, normalized_email, user_context
        )
        await emailverification_asyncio.unverify_email(
            verification_recipe_user_id, normalized_email, user_context
        )
        result = await emailverification_asyncio.send_email_verification_email(
            tenant_id,
            user_id,
            verification_recipe_user_id,
            normalized_email,
            create_pending_email_verification_user_context(
                user_context, pending_verification_id
            ),
        )
        if getattr(result, "status", None) != "OK":
            raise RuntimeError("A fresh email verification could not be created")
    except Exception:
        with suppress(Exception):
            await emailverification_asyncio.revoke_email_verification_tokens(
                tenant_id, verification_recipe_user_id, normalized_email, user_context
            )
        await remove_pending_email_verification(user_id, pending_verification_id, user_context)
        raise
    return await get_rownd_compat_user(
        user_id,
        config,
        tenant_id,
        metadata_override=combined_metadata,
        user_override=user,
        user_context=user_context,
    )


async def resolve_pending_email_verification_token(
    token: str,
    query_pending_verification_id: Optional[str],
    tenant_id: str,
    session: Optional[SessionContainer],
    user_context: UserContext,
) -> Dict[str, str]:
    if query_pending_verification_id is None:
        return {"status": "NOT_PENDING"}
    if session is None:
        return {"status": "INVALID_PENDING"}

    session_handle = session.get_handle(user_context)
    session_user_id = session.get_user_id(user_context)
    session_tenant_id = session.get_tenant_id(user_context)
    if session_tenant_id != tenant_id:
        return {"status": "INVALID_PENDING"}
    session_information = await session_asyncio.get_session_information(
        session_handle, user_context
    )
    if (
        session_information is None
        or session_information.session_handle != session_handle
        or session_information.user_id != session_user_id
        or session_information.tenant_id != session_tenant_id
    ):
        return {"status": "INVALID_PENDING"}

    metadata = await get_raw_user_metadata(session_user_id, user_context)
    pending_verification = next(
        (
            verification
            for verification in get_pending_verifications(metadata)
            if verification.get("id") == query_pending_verification_id
            and verification.get("field") == "email"
            and verification.get("status") == "PENDING"
            and verification.get("initiatingSessionHandle") == session_handle
            and (verification.get("tenantId") or PUBLIC_TENANT_ID) == tenant_id
            and verification.get("purpose") in {"UPDATE_PASSWORDLESS", "ADD_PASSWORDLESS"}
        ),
        None,
    )
    if pending_verification is None:
        return {"status": "INVALID_PENDING"}
    return {
        "status": "OK",
        "core_token": token,
        "pending_verification_id": query_pending_verification_id,
        "user_id": session_user_id,
    }


async def complete_pending_email_verification(
    recipe_user_id: RecipeUserId,
    email: str,
    user_context: UserContext,
    tenant_id: str = PUBLIC_TENANT_ID,
    session_handle: Optional[str] = None,
    pending_verification_id: Optional[str] = None,
    pending_user_id: Optional[str] = None,
) -> Optional[Dict[str, object]]:
    user = await get_user(recipe_user_id.get_as_string(), user_context)
    user_id = user.id if user else recipe_user_id.get_as_string()
    if pending_user_id and user_id != pending_user_id:
        if pending_verification_id:
            await remove_pending_email_verification(
                pending_user_id, pending_verification_id, user_context
            )
        raise RowndEmailChangeError(
            "CONFLICT",
            409,
            "email change session is no longer active; start the email change again",
        )
    primary_mapping = await get_primary_user_mapping(user_id, user_context)
    primary_metadata_user_id = primary_mapping.supertokens_user_id if primary_mapping else user_id
    metadata = await get_raw_user_metadata(primary_metadata_user_id, user_context)
    pending = get_pending_verifications(metadata)
    normalized_email = normalize_email(email)
    pending_verification = next(
        (
            item
            for item in pending
            if (not pending_verification_id or item.get("id") == pending_verification_id)
            and item.get("field") == "email"
            and normalize_email(cast(str, item["value"])) == normalized_email
            and (item.get("tenantId") or PUBLIC_TENANT_ID) == tenant_id
            and (
                not item.get("verificationRecipeUserId")
                or item.get("verificationRecipeUserId") == recipe_user_id.get_as_string()
            )
        ),
        None,
    )
    if not pending_verification:
        if pending_verification_id:
            try:
                await emailverification_asyncio.unverify_email(
                    recipe_user_id, normalized_email, user_context
                )
            finally:
                await remove_pending_email_verification(
                    user_id, pending_verification_id, user_context
                )
            raise RowndEmailChangeError(
                "CONFLICT",
                409,
                "email change session is no longer active; start the email change again",
            )
        return None

    purpose = pending_verification.get("purpose")
    if purpose != "UPDATE_PASSWORDLESS" and purpose != "ADD_PASSWORDLESS":
        await reject_inactive_pending_email_verification(
            user_id, pending_verification, recipe_user_id, normalized_email, user_context
        )

    initiating_session_handle = optional_string(pending_verification.get("initiatingSessionHandle"))
    pending_status = pending_verification.get("status")
    if (
        (pending_status if pending_status is not None else "PENDING") != "PENDING"
        or not initiating_session_handle
        or initiating_session_handle != session_handle
    ):
        await reject_inactive_pending_email_verification(
            user_id, pending_verification, recipe_user_id, normalized_email, user_context
        )

    completion_phase = "PENDING"
    rollback_credential_change: Optional[Callable[[], Awaitable[None]]] = None
    try:
        await assert_email_available_for_user(normalized_email, user_id, user_context)
        initiating_session = await session_asyncio.get_session_information(
            cast(str, initiating_session_handle), user_context
        )
        if (
            initiating_session is None
            or initiating_session.user_id != user_id
            or initiating_session.tenant_id != tenant_id
        ):
            await reject_inactive_pending_email_verification(
                user_id, pending_verification, recipe_user_id, normalized_email, user_context
            )
        current_user = await get_user(user_id, user_context)
        initiating_login_method = (
            next(
                (
                    method
                    for method in current_user.login_methods
                    if method.recipe_user_id.get_as_string()
                    == initiating_session.recipe_user_id.get_as_string()
                    and tenant_id in method.tenant_ids
                ),
                None,
            )
            if current_user
            else None
        )
        if current_user is None or initiating_login_method is None:
            await reject_inactive_pending_email_verification(
                user_id, pending_verification, recipe_user_id, normalized_email, user_context
            )
        passwordless_method = find_pending_passwordless_method(
            current_user, pending_verification, tenant_id
        )
        can_add_passwordless = (
            purpose == "ADD_PASSWORDLESS"
            and all(
                rownd_compatibility.is_real_third_party_method(method)
                for method in current_user.login_methods
                if tenant_id in method.tenant_ids
            )
            and rownd_compatibility.is_real_third_party_method(initiating_login_method)
            and pending_verification.get("verificationRecipeUserId")
            == initiating_login_method.recipe_user_id.get_as_string()
        )
        if (purpose == "UPDATE_PASSWORDLESS" and passwordless_method is None) or (
            purpose == "ADD_PASSWORDLESS" and not can_add_passwordless
        ):
            await reject_inactive_pending_email_verification(
                user_id, pending_verification, recipe_user_id, normalized_email, user_context
            )

        completion_phase = "COMMITTING"
        await mark_pending_email_verification_status(
            user_id, cast(str, pending_verification["id"]), "COMMITTING", user_context
        )
        if not await session_asyncio.revoke_session(
            cast(str, initiating_session_handle), user_context
        ):
            await reject_inactive_pending_email_verification(
                user_id, pending_verification, recipe_user_id, normalized_email, user_context
            )
        initiating_recipe_user_id = initiating_login_method.recipe_user_id
        await session_asyncio.revoke_all_sessions_for_user(user_id, True, None, user_context)
        committing_metadata = await get_raw_user_metadata(user_id, user_context)
        committing_verification = next(
            (
                item
                for item in get_pending_verifications(committing_metadata)
                if item.get("field") == "email"
            ),
            None,
        )
        if (
            committing_verification is None
            or committing_verification.get("id") != pending_verification.get("id")
            or committing_verification.get("status") != "COMMITTING"
        ):
            await reject_inactive_pending_email_verification(
                user_id, pending_verification, recipe_user_id, normalized_email, user_context
            )

        passwordless_user = await passwordless_asyncio.signinup(
            tenant_id,
            normalized_email,
            None,
            None,
            create_derived_user_context(
                user_context, {"rowndDisableAutomaticAccountLinking": True}
            ),
        )
        reuses_linked_method = (
            not passwordless_user.created_new_recipe_user
            and passwordless_user.user.id == user_id
            and any(
                method.recipe_user_id.get_as_string()
                == passwordless_user.recipe_user_id.get_as_string()
                and tenant_id in method.tenant_ids
                for method in passwordless_user.user.login_methods
            )
        )
        if not passwordless_user.created_new_recipe_user and not reuses_linked_method:
            raise email_ownership_conflict()
        if passwordless_user.created_new_recipe_user:

            async def rollback_add() -> None:
                await delete_user(
                    passwordless_user.recipe_user_id.get_as_string(),
                    remove_all_linked_accounts=False,
                    user_context=user_context,
                )

            rollback_credential_change = rollback_add
            await assert_email_available_for_user(
                normalized_email,
                [user_id, passwordless_user.user.id],
                user_context,
            )
            primary_user_id = await ensure_stable_primary_user(
                current_user, initiating_recipe_user_id, user_context
            )
            if primary_user_id != user_id:
                raise RowndEmailChangeError(
                    "CONFLICT", 409, "the account changed before email verification completed"
                )
            link_result = await accountlinking_asyncio.link_accounts(
                passwordless_user.recipe_user_id, primary_user_id, user_context
            )
            if not isinstance(link_result, LinkAccountsOkResult):
                raise email_ownership_conflict()
        canonical_email_recipe_user_id = passwordless_user.recipe_user_id.get_as_string()

        await session_asyncio.revoke_all_sessions_for_user(user_id, True, None, user_context)
        final_metadata_inspection = await inspect_linked_user_metadata(user_id, user_context)
        target_metadata = cast(JsonDict, final_metadata_inspection["primary_metadata"])
        combined_metadata = cast(JsonDict, final_metadata_inspection["combined_metadata"])
        updated_metadata = build_verified_email_metadata(
            target_metadata,
            user_id,
            normalized_email,
            canonical_email_recipe_user_id,
            tenant_id,
            combined_metadata,
        )
        await update_primary_user_metadata(user_id, updated_metadata, user_context)
        completion_phase = "COMPLETED"

        async def rollback_on_session_replacement_failure() -> None:
            rollback_errors: List[Exception] = []
            operations: List[Callable[[], Awaitable[object]]] = []
            if rollback_credential_change:
                operations.append(rollback_credential_change)

            async def unverify() -> None:
                await emailverification_asyncio.unverify_email(
                    recipe_user_id, normalized_email, user_context
                )

            async def restore_metadata() -> None:
                await replace_primary_user_metadata(
                    user_id,
                    {
                        **target_metadata,
                        "rownd_pending_verification": [
                            item
                            for item in get_pending_verifications(target_metadata)
                            if item.get("id") != pending_verification.get("id")
                        ],
                    },
                    user_context,
                )

            async def revoke_sessions() -> None:
                await session_asyncio.revoke_all_sessions_for_user(
                    user_id, True, None, user_context
                )

            operations.extend([unverify, restore_metadata, revoke_sessions])
            for operation in operations:
                try:
                    await operation()
                except Exception as rollback_error:
                    rollback_errors.append(rollback_error)
            if rollback_errors:
                log_debug(
                    get_active_rownd_config(),
                    "Email change replacement-session rollback failed for user %s; "
                    "reconciliation required. Errors: %s"
                    % (user_id, "; ".join(str(error) for error in rollback_errors)),
                )
                raise RowndEmailChangeError(
                    "CONFLICT",
                    409,
                    "email change rollback failed; account reconciliation is required",
                )

        return {
            "user_id": user_id,
            "recipe_user_id": initiating_recipe_user_id,
            "initiating_session_handle": initiating_session_handle,
            "replace_session": True,
            "rollback_on_session_replacement_failure": (rollback_on_session_replacement_failure),
        }
    except Exception as error:
        if completion_phase != "COMPLETED":
            rollback_error: Optional[Exception] = None
            if rollback_credential_change:
                try:
                    await rollback_credential_change()
                except Exception as caught_rollback_error:
                    rollback_error = caught_rollback_error
            if completion_phase == "COMMITTING":
                await asyncio.gather(
                    session_asyncio.revoke_all_sessions_for_user(user_id, True, None, user_context),
                    return_exceptions=True,
                )
            if rollback_error is not None:
                log_debug(
                    get_active_rownd_config(),
                    "Email change rollback failed for user %s; reconciliation required. Error: %s"
                    % (user_id, rollback_error),
                )
                raise RowndEmailChangeError(
                    "CONFLICT",
                    409,
                    "email change rollback failed; account reconciliation is required",
                ) from rollback_error
            cleanup_failed = False
            try:
                await cleanup_pending_email_verification(
                    user_id,
                    pending_verification,
                    recipe_user_id,
                    normalized_email,
                    user_context,
                )
            except Exception:
                cleanup_failed = True
            if completion_phase == "COMMITTING" and cleanup_failed:
                with suppress(Exception):
                    await mark_pending_email_verification_status(
                        user_id,
                        cast(str, pending_verification["id"]),
                        "PENDING",
                        user_context,
                    )
        raise error


def get_pending_verifications(metadata: JsonDict) -> List[JsonDict]:
    return [
        item
        for item in as_json_list(metadata.get("rownd_pending_verification"))
        if all(isinstance(item.get(key), str) for key in ("id", "field", "value", "created_at"))
    ]


def normalize_email(email: str) -> str:
    return email.strip().lower()


def get_passwordless_email_login_methods(login_methods: List[LoginMethod]) -> List[LoginMethod]:
    return [
        method
        for method in login_methods
        if method.recipe_id == "passwordless" and bool(method.email)
    ]


def get_account_tenant_ids(user: User, current_tenant_id: str) -> List[str]:
    return list(
        dict.fromkeys(
            [current_tenant_id]
            + [tenant for method in user.login_methods for tenant in method.tenant_ids]
        )
    )


async def rollback_tenant_associations(
    tenant_ids: List[str], recipe_user_id: RecipeUserId, user_context: UserContext
) -> None:
    await asyncio.gather(
        *(
            multitenancy_asyncio.disassociate_user_from_tenant(
                tenant_id, recipe_user_id, user_context
            )
            for tenant_id in tenant_ids
        )
    )


async def associate_recipe_user_to_tenants(
    tenant_ids: List[str], recipe_user_id: RecipeUserId, user_context: UserContext
) -> List[str]:
    newly_associated: List[str] = []
    unknown_outcome: Optional[str] = None
    try:
        for tenant_id in tenant_ids:
            unknown_outcome = tenant_id
            result = await multitenancy_asyncio.associate_user_to_tenant(
                tenant_id, recipe_user_id, user_context
            )
            unknown_outcome = None
            if getattr(result, "status", None) != "OK":
                raise email_ownership_conflict()
            if not getattr(result, "was_already_associated", False):
                newly_associated.append(tenant_id)
        return newly_associated
    except Exception:
        await rollback_tenant_associations(
            list(dict.fromkeys(newly_associated + ([unknown_outcome] if unknown_outcome else []))),
            recipe_user_id,
            user_context,
        )
        raise


def get_verification_recipe_user_ids(
    user: User, verification: JsonDict, fallback: RecipeUserId
) -> List[RecipeUserId]:
    verification_recipe_user_id = verification.get("verificationRecipeUserId")
    method = next(
        (
            method
            for method in user.login_methods
            if method.recipe_user_id.get_as_string() == verification_recipe_user_id
        ),
        None,
    )
    if method:
        return [method.recipe_user_id]
    return list(
        {
            recipe_user_id.get_as_string(): recipe_user_id
            for recipe_user_id in [
                *(login_method.recipe_user_id for login_method in user.login_methods),
                fallback,
            ]
        }.values()
    )


async def revoke_pending_email_verification_tokens(
    user: User,
    verification: JsonDict,
    fallback: RecipeUserId,
    user_context: UserContext,
) -> None:
    await asyncio.gather(
        *(
            emailverification_asyncio.revoke_email_verification_tokens(
                cast(str, verification.get("tenantId") or PUBLIC_TENANT_ID),
                recipe_user_id,
                cast(str, verification["value"]),
                user_context,
            )
            for recipe_user_id in get_verification_recipe_user_ids(user, verification, fallback)
        )
    )


async def assert_email_available_for_user(
    email: str, allowed_user_ids: Union[str, List[str]], user_context: UserContext
) -> None:
    allowed_ids = {allowed_user_ids} if isinstance(allowed_user_ids, str) else set(allowed_user_ids)
    tenants = await multitenancy_asyncio.list_all_tenants(user_context)
    tenant_ids = list(
        dict.fromkeys([PUBLIC_TENANT_ID] + [tenant.tenant_id for tenant in tenants.tenants])
    )
    owners_by_tenant = await asyncio.gather(
        *(
            list_users_by_account_info(
                tenant_id, AccountInfoInput(email=email), False, user_context
            )
            for tenant_id in tenant_ids
        )
    )
    if any(owner.id not in allowed_ids for owners in owners_by_tenant for owner in owners):
        raise email_ownership_conflict()


def email_ownership_conflict() -> RowndEmailChangeError:
    return RowndEmailChangeError("CONFLICT", 409, "email cannot be used for this account")


def find_pending_passwordless_method(
    user: Optional[User], pending_verification: JsonDict, tenant_id: str
) -> Optional[LoginMethod]:
    if user is None:
        return None
    if pending_verification.get("purpose") != "UPDATE_PASSWORDLESS" or not pending_verification.get(
        "verificationRecipeUserId"
    ):
        return None
    pending_recipe_user_id = pending_verification.get("verificationRecipeUserId")
    method = next(
        (
            method
            for method in user.login_methods
            if method.recipe_id == "passwordless"
            and method.recipe_user_id.get_as_string() == pending_recipe_user_id
        ),
        None,
    )
    return (
        method
        if method is not None
        and tenant_id in method.tenant_ids
        and method.recipe_user_id.get_as_string() == pending_recipe_user_id
        else None
    )


def find_canonical_passwordless_method(
    user: User, metadata: JsonDict, tenant_id: str
) -> Optional[LoginMethod]:
    passwordless_methods = [
        method
        for method in user.login_methods
        if method.recipe_id == "passwordless" and tenant_id in method.tenant_ids
    ]
    canonical_recipe_user_id = rownd_compatibility.get_canonical_email_recipe_user_id(
        metadata, tenant_id
    )
    if canonical_recipe_user_id:
        canonical_method = next(
            (
                method
                for method in passwordless_methods
                if method.recipe_user_id.get_as_string() == canonical_recipe_user_id
            ),
            None,
        )
        if canonical_method is None:
            raise RowndEmailChangeError(
                "CONFLICT", 409, "the canonical email sign-in method is invalid"
            )
        return canonical_method
    if len(passwordless_methods) > 1:
        raise RowndEmailChangeError(
            "AMBIGUOUS",
            409,
            "the account has multiple email sign-in methods without a canonical method",
        )
    return passwordless_methods[0] if passwordless_methods else None


async def ensure_stable_primary_user(
    user: Optional[User], anchor: RecipeUserId, user_context: UserContext
) -> str:
    if user is None:
        raise RowndPluginError("User not found in Rownd")
    if user.is_primary_user:
        return user.id
    result = await accountlinking_asyncio.create_primary_user(anchor, user_context)
    if isinstance(result, CreatePrimaryUserOkResult):
        return result.user.id
    if isinstance(result, CreatePrimaryUserRecipeUserIdAlreadyLinkedError):
        return result.primary_user_id
    raise email_ownership_conflict()


async def remove_pending_email_verification(
    user_id: str, pending_id: str, user_context: UserContext
) -> None:
    metadata = await get_raw_user_metadata(user_id, user_context)
    await update_primary_user_metadata(
        user_id,
        {
            "rownd_pending_verification": [
                item for item in get_pending_verifications(metadata) if item.get("id") != pending_id
            ]
        },
        user_context,
    )


async def mark_pending_email_verification_status(
    user_id: str, pending_id: str, status: str, user_context: UserContext
) -> None:
    metadata = await get_raw_user_metadata(user_id, user_context)
    await update_primary_user_metadata(
        user_id,
        {
            "rownd_pending_verification": [
                {**item, "status": status} if item.get("id") == pending_id else item
                for item in get_pending_verifications(metadata)
            ]
        },
        user_context,
    )


async def cleanup_pending_email_verification(
    user_id: str,
    pending_verification: JsonDict,
    recipe_user_id: RecipeUserId,
    email: str,
    user_context: UserContext,
) -> None:
    await emailverification_asyncio.unverify_email(recipe_user_id, email, user_context)
    await remove_pending_email_verification(
        user_id, cast(str, pending_verification["id"]), user_context
    )


async def reject_inactive_pending_email_verification(
    user_id: str,
    pending_verification: JsonDict,
    recipe_user_id: RecipeUserId,
    email: str,
    user_context: UserContext,
) -> NoReturn:
    await cleanup_pending_email_verification(
        user_id, pending_verification, recipe_user_id, email, user_context
    )
    raise RowndEmailChangeError(
        "CONFLICT",
        409,
        "email change session is no longer active; start the email change again",
    )


def build_verified_email_metadata(
    metadata: JsonDict,
    user_id: str,
    email: str,
    canonical_email_recipe_user_id: str,
    tenant_id: str,
    fallback_metadata: Optional[JsonDict] = None,
) -> JsonDict:
    fallback_metadata = fallback_metadata or {}
    compatibility_user = (
        as_json_dict(metadata.get("original_rownd_user"))
        or as_json_dict(fallback_metadata.get("original_rownd_user"))
        or {
            "state": "enabled",
            "auth_level": "verified",
            "data": {"user_id": user_id},
            "verified_data": {},
            "groups": [],
            "meta": {},
        }
    )
    compatibility_data = as_json_dict(compatibility_user.get("data"))
    return {
        **metadata,
        "original_rownd_user": {
            **compatibility_user,
            "data": {
                **compatibility_data,
                "user_id": compatibility_data.get("user_id") or user_id,
                "email": email,
            },
            "verified_data": {
                **as_json_dict(compatibility_user.get("verified_data")),
                "email": email,
            },
        },
        "rownd_email_recipe_user_id": canonical_email_recipe_user_id,
        "rownd_email_recipe_user_ids": {
            **as_json_dict(fallback_metadata.get("rownd_email_recipe_user_ids")),
            **as_json_dict(metadata.get("rownd_email_recipe_user_ids")),
            tenant_id: canonical_email_recipe_user_id,
        },
        "rownd_pending_verification": [
            item for item in get_pending_verifications(metadata) if item.get("field") != "email"
        ],
    }

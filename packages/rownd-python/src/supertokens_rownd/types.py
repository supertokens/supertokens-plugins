from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Dict, List, Literal, Optional, Protocol, Union
from typing_extensions import NotRequired, TypedDict

from .constants import DEFAULT_ROWND_SCHEMA

JsonPrimitive = Union[str, int, float, bool, None]
JsonValue = Union[JsonPrimitive, "JsonDict", "JsonList"]
JsonDict = Dict[str, JsonValue]
JsonList = List[JsonValue]
RowndSchema = Dict[str, JsonDict]


class RowndTelemetryClient(Protocol):
    async def record_event(self, event: JsonDict) -> None: ...


class RowndClientProtocol(Protocol):
    async def validate_token(self, token: str) -> str: ...

    async def fetch_user_info(self, user_id: str) -> JsonDict: ...

    async def fetch_optional_user_info(self, user_id: str) -> Optional[JsonDict]: ...


@dataclass
class RowndTelemetryConfig:
    provider: str
    token: Optional[str] = None
    dataset: Optional[str] = None
    url: Optional[str] = None
    factory: Optional[Callable[[], RowndTelemetryClient]] = None


class RowndPluginKwargs(TypedDict, total=False):
    rownd_app_key: Optional[str]
    rownd_app_secret: Optional[str]
    disable_rownd_user_migration: bool
    api_base_path: str
    api_domain: str
    website_domain: str
    app_name: str
    rownd_api_base_url: str
    enable_debug_logs: bool
    telemetry: Union[RowndTelemetryConfig, JsonDict, None]
    client_domains: Dict[str, str]
    schema: RowndSchema
    app_config: JsonDict
    sub_brands: Dict[str, JsonDict]
    cross_device_confirmation_bypass: "RowndCrossDeviceConfirmationBypassConfig"
    rownd_client: Optional[RowndClientProtocol]
    email_change: "RowndEmailChangeConfig"


class RowndCrossDeviceConfirmationBypassConfig(TypedDict):
    allowed_redirect_paths: List[str]


class RowndEmailChangeConfig(TypedDict, total=False):
    max_session_age_seconds: float


class RowndEmailChangeRequestContext(TypedDict):
    rowndDisplayContext: NotRequired[Literal["browser", "mobile_app", "customer_web_view"]]
    rowndClientDomain: NotRequired[str]
    rowndNativeEmailVerification: NotRequired[bool]


class RowndPendingVerification(TypedDict, total=False):
    id: str
    field: str
    value: str
    created_at: str
    tenantId: str
    purpose: Literal["UPDATE_PASSWORDLESS", "ADD_PASSWORDLESS"]
    initiatingSessionHandle: str
    verificationRecipeUserId: str
    status: Literal["PENDING", "COMMITTING"]


@dataclass
class RowndPluginConfig:
    rownd_app_key: Optional[str] = None
    rownd_app_secret: Optional[str] = None
    disable_rownd_user_migration: bool = False
    # Must match InputAppInfo.api_base_path. The Python plugin API does not expose app_info.
    api_base_path: str = "/auth"
    # Should match InputAppInfo.api_domain so rewritten Rownd hub links can call the right API host.
    api_domain: str = ""
    # Should match InputAppInfo.website_domain when using passwordless confirmation bypass.
    website_domain: str = ""
    app_name: str = "Application"
    rownd_api_base_url: str = "https://api.rownd.io"
    enable_debug_logs: bool = False
    telemetry: Optional[Union[RowndTelemetryConfig, JsonDict]] = None
    client_domains: Dict[str, str] = field(default_factory=dict)
    schema: RowndSchema = field(default_factory=lambda: dict(DEFAULT_ROWND_SCHEMA))
    app_config: JsonDict = field(default_factory=dict)
    sub_brands: Dict[str, JsonDict] = field(default_factory=dict)
    cross_device_confirmation_bypass: Optional[RowndCrossDeviceConfirmationBypassConfig] = None
    rownd_client: Optional[RowndClientProtocol] = None
    email_change: RowndEmailChangeConfig = field(
        default_factory=lambda: {"max_session_age_seconds": 600}
    )

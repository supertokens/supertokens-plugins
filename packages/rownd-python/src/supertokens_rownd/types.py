from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Optional, Protocol, Union

from .constants import DEFAULT_ROWND_SCHEMA

JsonDict = Dict[str, Any]
RowndSchema = Dict[str, JsonDict]


class RowndTelemetryClient(Protocol):
    async def record_event(self, event: JsonDict) -> None: ...


@dataclass
class RowndTelemetryConfig:
    provider: str
    token: Optional[str] = None
    dataset: Optional[str] = None
    url: Optional[str] = None
    factory: Optional[Callable[[], RowndTelemetryClient]] = None


@dataclass
class RowndPluginConfig:
    rownd_app_key: str
    rownd_app_secret: str
    api_base_path: str = "/auth"
    api_domain: str = ""
    app_name: str = "Application"
    rownd_api_base_url: str = "https://api.rownd.io"
    enable_debug_logs: bool = False
    telemetry: Optional[Union[RowndTelemetryConfig, JsonDict]] = None
    schema: RowndSchema = field(default_factory=lambda: dict(DEFAULT_ROWND_SCHEMA))
    app_config: JsonDict = field(default_factory=dict)
    sub_brands: Dict[str, JsonDict] = field(default_factory=dict)
    rownd_client: Optional[Any] = None


class RowndPluginError(Exception):
    pass

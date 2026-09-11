import logging
from unittest.mock import AsyncMock, Mock

import pytest
from supertokens_python.framework.request import BaseRequest
from supertokens_python.framework.response import BaseResponse

import supertokens_rownd.plugin_implementation as implementation
from supertokens_rownd.logger import log_debug, log_warning
from supertokens_rownd.telemetry.create_telemetry_client import NoopTelemetryClient
from supertokens_rownd.types import RowndPluginConfig


@pytest.mark.parametrize("enabled", [False, True])
def test_debug_logging_is_opt_in_at_info_level_without_printing(
    caplog: pytest.LogCaptureFixture,
    capsys: pytest.CaptureFixture[str],
    enabled: bool,
) -> None:
    with caplog.at_level(logging.INFO, logger="supertokens_rownd"):
        log_debug(RowndPluginConfig(enable_debug_logs=enabled), "diagnostic %s")

    assert caplog.record_tuples == (
        [("supertokens_rownd", logging.INFO, "RowndMigrationPlugin: diagnostic %s")]
        if enabled
        else []
    )
    assert capsys.readouterr() == ("", "")


def test_disabled_debug_logging_stays_silent_even_at_debug_level(
    caplog: pytest.LogCaptureFixture,
    capsys: pytest.CaptureFixture[str],
) -> None:
    with caplog.at_level(logging.DEBUG, logger="supertokens_rownd"):
        log_debug(RowndPluginConfig(enable_debug_logs=False), "diagnostic")

    assert caplog.records == []
    assert capsys.readouterr() == ("", "")


@pytest.mark.parametrize("enabled", [False, True])
def test_warning_logging_does_not_depend_on_debug_flag(
    caplog: pytest.LogCaptureFixture, enabled: bool
) -> None:
    with caplog.at_level(logging.WARNING, logger="supertokens_rownd"):
        log_warning(RowndPluginConfig(enable_debug_logs=enabled), "safe warning")

    assert caplog.record_tuples == [
        ("supertokens_rownd", logging.WARNING, "RowndMigrationPlugin: safe warning")
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("enabled", [False, True])
@pytest.mark.parametrize("operation", ["guest_login", "confirmation_bypass"])
async def test_handler_failure_logs_and_responses_omit_exception_details(
    caplog: pytest.LogCaptureFixture,
    capsys: pytest.CaptureFixture[str],
    enabled: bool,
    operation: str,
) -> None:
    sentinel = "secret-token user@example.com private-user-id\r\nFORGED"
    error_type = type("SecretExceptionType", (Exception,), {})
    request = Mock(spec=BaseRequest)
    request.json = AsyncMock(side_effect=error_type(sentinel))
    request.get_query_param.return_value = None
    response = Mock(spec=BaseResponse)
    config = RowndPluginConfig(enable_debug_logs=enabled)

    with caplog.at_level(logging.INFO, logger="supertokens_rownd"):
        if operation == "guest_login":
            result = await implementation.handle_guest_login(
                config, NoopTelemetryClient(), request, response, {}
            )
            expected_body = {"status": "ERROR", "message": "Guest login failed"}
        else:
            result = await implementation.handle_validate_passwordless_confirmation_bypass(
                config, request, response
            )
            expected_body = {"status": "ERROR", "bypass": False}

    assert result is response
    response.set_status_code.assert_called_once_with(200)
    response.set_json_content.assert_called_once_with(expected_body)
    for secret in (sentinel, "SecretExceptionType", "private-user-id", "FORGED"):
        assert secret not in str([record.__dict__ for record in caplog.records])
        assert secret not in str(response.mock_calls)
    assert caplog.record_tuples == (
        [("supertokens_rownd", logging.INFO, f"RowndMigrationPlugin: code={operation}_failed")]
        if enabled
        else []
    )
    assert all(record.exc_info is None and record.stack_info is None for record in caplog.records)
    assert capsys.readouterr() == ("", "")

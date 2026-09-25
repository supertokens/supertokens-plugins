import logging

import pytest

from conftest import MockRowndClient, make_client, TestClientWithNoCookieJar


@pytest.fixture
def app_config_client(rownd_client: MockRowndClient) -> TestClientWithNoCookieJar:
    return make_client(
        "http://127.0.0.1:1",
        rownd_client,
        plugin_config={
            "enable_debug_logs": False,
            "app_config": {"id": "base_app", "name": "Base App"},
            "sub_brands": {
                "known": {
                    "id": "variant_app",
                    "name": "Variant App",
                    "variant": {"id": "known"},
                }
            },
        },
    )


@pytest.mark.parametrize(
    "variant",
    [
        pytest.param("unknown", id="benign"),
        pytest.param("unknown\r\nFORGED WARNING", id="crlf"),
        pytest.param("unknown\x00\x1b[31m", id="control-escape"),
        pytest.param("x" * 10000, id="long"),
        pytest.param("sensitive-sentinel-secret-token", id="sensitive"),
    ],
)
def test_unknown_app_variant_returns_bad_request_and_warning(
    app_config_client: TestClientWithNoCookieJar,
    caplog: pytest.LogCaptureFixture,
    variant: str,
) -> None:
    with caplog.at_level(logging.WARNING, logger="supertokens_rownd"):
        response = app_config_client.get(
            "/auth/plugin/rownd/app-config", params={"app_variant_id": variant}
        )

    assert response.status_code == 400
    assert response.json() == {
        "status": "ERROR",
        "reason": "UNKNOWN_APP_VARIANT",
        "message": "Unknown Rownd app variant: %s" % variant,
    }
    assert caplog.record_tuples == [
        (
            "supertokens_rownd",
            logging.WARNING,
            "RowndMigrationPlugin: Unknown Rownd app variant",
        )
    ]
    assert variant not in caplog.text


@pytest.mark.parametrize("query", ["", "?app_variant_id=", "?app_variant_id=known"])
def test_configured_and_omitted_app_variants_remain_successful(
    app_config_client: TestClientWithNoCookieJar,
    caplog: pytest.LogCaptureFixture,
    query: str,
) -> None:
    with caplog.at_level(logging.WARNING, logger="supertokens_rownd"):
        response = app_config_client.get("/auth/plugin/rownd/app-config" + query)

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "OK"
    if query == "?app_variant_id=known":
        assert body["config_type"] == "variant"
        assert body["variant"] == {"id": "known"}
        assert body["app"]["id"] == "variant_app"
        assert body["app"]["name"] == "Variant App"
    else:
        assert body["app"]["id"] == "base_app"
        assert body["app"]["name"] == "Base App"
    assert "reason" not in body
    assert caplog.record_tuples == []

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

import httpx
import pytest
from supertokens_python import SupertokensConfig

from supertokens_rownd import supertokens_repository as repository
from supertokens_rownd.errors import MigrationError, MigrationErrorReason


class ImportStream(httpx.AsyncByteStream):
    def __init__(self, chunks: list[bytes], delay: float = 0) -> None:
        self.chunks = chunks
        self.delay = delay
        self.reads = 0
        self.closed = False

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for chunk in self.chunks:
            await asyncio.sleep(self.delay)
            self.reads += 1
            yield chunk

    async def aclose(self) -> None:
        self.closed = True


@pytest.fixture
def import_transport(monkeypatch: pytest.MonkeyPatch):
    real_client = httpx.AsyncClient
    clients: list[httpx.AsyncClient] = []
    requests: list[httpx.Request] = []

    def install(response: httpx.Response | Exception, header_delay: float = 0) -> None:
        async def handle(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            await asyncio.sleep(header_delay)
            if isinstance(response, Exception):
                raise response
            return response

        def client(**kwargs):
            result = real_client(transport=httpx.MockTransport(handle), **kwargs)
            clients.append(result)
            return result

        monkeypatch.setattr(repository.httpx, "AsyncClient", client)

    return install, clients, requests


def cached_context():
    return {"_default": {"core_call_cache": {"user": "stale"}}}


@pytest.mark.asyncio
async def test_import_streams_success_with_bounded_request_and_cleans_cache(import_transport):
    install, clients, requests = import_transport
    stream = ImportStream([b'{"status":"OK",', b'"user":{"id":"user"}}'])
    install(httpx.Response(200, stream=stream))
    context = cached_context()

    assert await repository.import_user(
        {}, SupertokensConfig("http://core/", api_key="secret-key"), context,
    ) == {"id": "user"}

    assert stream.closed and clients[0].is_closed
    assert context["_default"]["core_call_cache"] == {}
    assert len(requests) == 1
    assert requests[0].url.path == "/bulk-import/import"
    assert requests[0].headers["api-key"] == "secret-key"
    assert requests[0].headers["accept-encoding"] == "identity"
    assert all(0 < value <= 5 for value in requests[0].extensions["timeout"].values())


@pytest.mark.asyncio
@pytest.mark.parametrize("header_delay", [0, 0.2], ids=["slow-body", "slow-headers"])
async def test_import_total_deadline_closes_stream_and_clears_cache(
    monkeypatch: pytest.MonkeyPatch, import_transport, header_delay: float,
):
    install, clients, requests = import_transport
    stream = ImportStream([b" "] * 30 + [b'{"status":"OK","user":{"id":"user"}}'], 0.01)
    install(httpx.Response(200, stream=stream), header_delay)
    monkeypatch.setattr(repository, "_BULK_IMPORT_TOTAL_TIMEOUT_SECONDS", 0.05, raising=False)
    context = cached_context()

    with pytest.raises(MigrationError) as raised:
        await repository.import_user({}, SupertokensConfig("http://core"), context)

    assert raised.value.reason is MigrationErrorReason.CORE_UNAVAILABLE
    assert raised.value.retryable
    assert raised.value.stage == "bulk_import"
    assert clients[0].is_closed
    assert stream.reads < len(stream.chunks)
    if not header_delay:
        assert stream.closed
    assert len(requests) == 1
    assert context["_default"]["core_call_cache"] == {}


@pytest.mark.asyncio
@pytest.mark.parametrize("advertised", [False, True])
async def test_import_response_size_is_bounded_without_reading_rest(
    monkeypatch: pytest.MonkeyPatch, import_transport, advertised: bool,
):
    install, clients, _ = import_transport
    stream = ImportStream([b"x" * 40] * 20)
    headers = {"content-length": "800"} if advertised else {}
    install(httpx.Response(200, stream=stream, headers=headers))
    monkeypatch.setattr(repository, "_BULK_IMPORT_MAX_RESPONSE_BYTES", 64, raising=False)
    context = cached_context()

    with pytest.raises(MigrationError) as raised:
        await repository.import_user({}, SupertokensConfig("http://core"), context)

    assert raised.value.reason is MigrationErrorReason.MIGRATION_INCOMPLETE
    assert stream.reads <= (0 if advertised else 2)
    assert stream.closed and clients[0].is_closed
    assert context["_default"]["core_call_cache"] == {}


@pytest.mark.asyncio
@pytest.mark.parametrize("body", [b"private-not-json", b"[]", b'{"status":"ERROR","message":"private"}',
                                  b'{"status":"OK","user":"private"}'])
async def test_import_invalid_response_is_redacted(import_transport, body: bytes):
    install, clients, _ = import_transport
    install(httpx.Response(200, stream=ImportStream([body])))
    with pytest.raises(MigrationError) as raised:
        await repository.import_user({}, SupertokensConfig("http://core"), cached_context())
    assert raised.value.reason is MigrationErrorReason.MIGRATION_INCOMPLETE
    assert "private" not in str(raised.value)
    assert clients[0].is_closed


@pytest.mark.asyncio
async def test_import_transport_failure_is_redacted(import_transport):
    install, clients, requests = import_transport
    install(httpx.ReadTimeout("private-url-and-key"))
    context = cached_context()
    with pytest.raises(MigrationError) as raised:
        await repository.import_user({}, SupertokensConfig("http://core"), context)
    assert raised.value.reason is MigrationErrorReason.CORE_UNAVAILABLE
    assert "private" not in str(raised.value)
    assert repository._is_recognizable_core_outage(raised.value)
    assert clients[0].is_closed and len(requests) == 1
    assert context["_default"]["core_call_cache"] == {}


@pytest.mark.asyncio
@pytest.mark.parametrize(("status", "code", "duplicate", "outage"), [
    (400, "E006", True, False), (400, "E027", False, False), (500, "E006", False, True),
])
async def test_import_http_error_redacts_body_without_broadening_e006(
    import_transport, status: int, code: str, duplicate: bool, outage: bool,
):
    install, _, _ = import_transport
    body = ('{"errors":["%s: private-user-email"]}' % code).encode()
    install(httpx.Response(status, stream=ImportStream([body])))
    with pytest.raises(repository._BulkImportError) as raised:
        await repository.import_user({}, SupertokensConfig("http://core"), cached_context())
    assert "private" not in str(raised.value)
    assert "private" not in repr(vars(raised.value))
    assert repository.is_bulk_import_duplicate_identity_error(raised.value) is duplicate
    assert repository._is_recognizable_core_outage(raised.value) is outage


@pytest.mark.asyncio
async def test_import_rejects_compression_before_decoding(import_transport):
    install, clients, _ = import_transport
    stream = ImportStream([b"not-even-valid-gzip"])
    install(httpx.Response(200, headers={"content-encoding": "gzip"}, stream=stream))
    with pytest.raises(MigrationError) as raised:
        await repository.import_user({}, SupertokensConfig("http://core"), cached_context())
    assert raised.value.reason is MigrationErrorReason.MIGRATION_INCOMPLETE
    assert stream.reads == 0
    assert stream.closed and clients[0].is_closed


@pytest.mark.asyncio
async def test_import_cancellation_propagates_and_cleans_up(
    import_transport,
):
    install, clients, _ = import_transport
    stream = ImportStream([b" "] * 100, 0.01)
    install(httpx.Response(200, stream=stream))
    context = cached_context()
    task = asyncio.create_task(repository.import_user({}, SupertokensConfig("http://core"), context))
    while not stream.reads:
        await asyncio.sleep(0.001)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert stream.closed and clients[0].is_closed
    assert context["_default"]["core_call_cache"] == {}


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [200, 400, 503])
async def test_import_oversize_preserves_http_outage_classification(
    monkeypatch: pytest.MonkeyPatch, import_transport, status: int,
):
    install, _, _ = import_transport
    stream = ImportStream([b"x" * 65])
    install(httpx.Response(status, stream=stream))
    monkeypatch.setattr(repository, "_BULK_IMPORT_MAX_RESPONSE_BYTES", 64, raising=False)
    with pytest.raises(MigrationError) as raised:
        await repository.import_user({}, SupertokensConfig("http://core"), cached_context())
    assert repository._is_recognizable_core_outage(raised.value) is (status == 503)
    assert stream.closed

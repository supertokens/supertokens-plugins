# OpenTelemetry Provider Plan

## Goal

Add optional, production-safe OpenTelemetry support to `rownd-python` without blocking authentication, leaking raw errors, mixing request trace contexts, or preventing process shutdown.

The host application remains responsible for configuring its OpenTelemetry SDK, sampler, processor, and exporter.

## Invariants

- Importing or using the plugin without OpenTelemetry installed still works.
- Selecting OpenTelemetry without the optional extra fails clearly during initialization.
- Telemetry never changes guest or migration responses.
- Built-in Axiom and OpenTelemetry request paths never wait for exporter I/O or queue capacity. Existing custom clients retain their current request-loop contract for compatibility.
- Memory is bounded and overload drops telemetry deterministically.
- Every queued event retains its own request trace context.
- A blocked exporter cannot block the event loop or interpreter shutdown.
- Spans represent operation timing, not delayed worker execution.
- Raw exception text, traceback, emails, phones, tokens, request bodies, and response bodies are never exported.

## Non-Goals

- Configuring an SDK or exporter for the application.
- Adding OTLP exporters as runtime dependencies.
- Durable telemetry across crashes or `SIGKILL`.
- Retrying indefinitely.
- Instrumenting routes beyond existing guest and migration telemetry.
- Redesigning the existing Axiom/custom event schema beyond additive operation fields and intentional error sanitization.
- Moving existing custom clients to a worker thread or different event loop.

## Architecture

### Optional Dependency

Add an extra:

```toml
[project.optional-dependencies]
opentelemetry = ["opentelemetry-api>=1.20,<2"]
```

Rules:

- No module-level OpenTelemetry imports.
- Lazy import only after `provider="opentelemetry"` is validated.
- Missing dependency raises an actionable initialization error.
- The extra installs only the API. Documentation must require the application to install/configure an SDK and exporter.

### Strict Provider Configuration

Supported providers:

- `None`: no-op.
- `axiom`: non-empty token and dataset; optional absolute URL.
- `custom`: callable factory.
- `opentelemetry`: no Axiom/custom fields.

Unknown providers and provider-inapplicable keys fail initialization. Dictionary and typed configurations normalize through one validator.

### Bounded Dispatcher

Use one process-global dispatcher for built-in Axiom and OpenTelemetry providers with:

- Bounded queue.
- Monotonic sequence numbers for flush barriers.
- Lock-protected lifecycle: `NEW`, `RUNNING`, `CLOSING`, `CLOSED`.
- One daemon worker thread.
- Provider adapter created before global installation. Existing custom clients remain outside the dispatcher and continue to run on the request event loop where their factory created them.

Request path:

1. Build sanitized event and operation timestamps.
2. Capture OpenTelemetry context when relevant.
3. `put_nowait` into the queue.
4. Return immediately.
5. Drop newest event when full or closing.

Worker:

- Processes FIFO.
- Reuses one synchronous Axiom HTTP client.
- Runs OpenTelemetry span operations on the daemon worker itself.
- Catches provider failures so one event cannot terminate the worker.
- Never logs event data, tokens, raw exceptions, or stable user IDs.

A daemon worker is required. Do not use `ThreadPoolExecutor`: Python joins executor threads during shutdown, so a permanently blocked exporter can hang process termination. The plugin does not call OpenTelemetry provider `force_flush` or `shutdown`; the host owns those operations and their shutdown behavior.

### Per-Event Trace Context

Capture the active OpenTelemetry context at enqueue and keep it only in the internal queue item. Pass it explicitly to `start_span(context=...)`.

Never read ambient worker context and never serialize the captured context to Axiom/custom payloads.

### Event and Span Semantics

Public events add:

- `operation`: `guest` or `migrate`.
- `outcome`: `success` or `error`.
- `durationMs`.
- Optional tenant and stable Rownd/SuperTokens user IDs.
- Optional migration state.
- Sanitized error name and generic operation-specific message.

Span names:

- `rownd.guest`
- `rownd.migrate`

Timing:

- Capture epoch nanoseconds and monotonic nanoseconds at operation start.
- Calculate duration from monotonic time.
- Pass explicit start and end timestamps so worker delay does not alter span duration.
- Use current `PLUGIN_VERSION` as instrumentation version.

Do not call `record_exception` with application exceptions. It may export raw messages and traceback data.

### Flush and Shutdown

Export:

```python
flush_telemetry(timeout: float = 5.0) -> bool
```

Contract:

- Waits only for events accepted before the flush barrier.
- Returns `True` when complete or telemetry is disabled.
- Returns `False` on timeout.
- Never propagates exporter failures.
- Is bounded and idempotent.
- Covers only events accepted by the built-in Axiom/OpenTelemetry dispatcher. Custom clients retain their existing completion semantics.

Register best-effort `atexit` shutdown, but rely on daemon-thread semantics so a blocked provider cannot hold process exit. Applications should call `flush_telemetry` before shutting down their tracer provider.

### Privacy

Centralize sanitization:

- Never serialize `str(error)`, `args`, traceback, HTTP body, URL, headers, JWTs, or credentials.
- Emit a bounded safe exception class name.
- Emit only `Guest operation failed` or `Migration operation failed` as error message.
- Omit unavailable identifiers rather than sending empty strings.

Existing stable tenant/Rownd/SuperTokens identifiers remain for parity. Documentation must state that enabling telemetry exports linkable identifiers and makes operators responsible for exporter access, retention, deletion, and regional processing.

## Implementation Sequence

### Commit 1: Configuration and Event Contract

Files:

- `src/supertokens_rownd/types.py`
- `src/supertokens_rownd/telemetry.py`
- `src/supertokens_rownd/plugin.py`
- `tests/test_telemetry.py`

Tasks:

1. Add provider-specific types and strict normalization.
2. Add operation and migration-state event fields.
3. Add centralized safe error construction.
4. Replace raw guest/migration exception interpolation in touched debug logs with sanitized exception class and operation reason codes.
5. Construct telemetry before publishing active plugin config.
6. Keep existing providers' delivery behavior temporarily; do not register or enable the OpenTelemetry provider in this commit.

Tests:

- Unknown/malformed/inapplicable providers.
- Typed and dictionary Axiom/custom parity.
- Custom factory failure leaves active config unchanged.
- Error sanitizer never emits realistic emails, phone numbers, bearer tokens, API keys, or Core response bodies.
- Guest/migration debug logs touched by this work do not interpolate raw exceptions.

Review gates:

- Security review for configuration and privacy.
- Packaging review for optional dependency metadata.
- Commit only after base installation works without OpenTelemetry.

### Commit 2: Bounded Daemon Dispatcher

Files:

- `src/supertokens_rownd/telemetry.py`
- `src/supertokens_rownd/__init__.py`
- `tests/test_telemetry.py`
- relevant integration telemetry tests

Tasks:

1. Add bounded queue, daemon worker, lifecycle state, and sequence barriers.
2. Move only Axiom delivery off the request event loop; preserve custom clients on their existing request loop.
3. Add `flush_telemetry` and bounded shutdown for built-in dispatchers.
4. Update Axiom integration tests to flush before asserting events.
5. Make runtime installation atomic and close failed/replaced built-in runtimes.

Tests:

- Slow provider does not delay endpoint response.
- Queue overflow drops without blocking.
- One provider exception does not stop later events.
- Flush drains accepted built-in events and respects its barrier.
- Timeout is bounded.
- Worker is daemon and repeated close/flush is safe.
- Permanently blocked provider does not prevent subprocess exit.
- Failed initialization does not leak a worker.

Review gates:

- Concurrency review for lifecycle and barrier correctness.
- Test review must use events/barriers, not sleeps.
- Commit only after process-exit subprocess test passes.

### Commit 3: OpenTelemetry Adapter

Files:

- `src/supertokens_rownd/telemetry.py`
- `src/supertokens_rownd/plugin_implementation.py`
- `tests/test_telemetry.py`

Tasks:

1. Capture per-event OpenTelemetry context at enqueue.
2. Add the `opentelemetry-api` optional extra and `opentelemetry-sdk` test-only dependency, then regenerate `uv.lock`.
3. Add lazy optional dependency loading and actionable missing-extra errors.
4. Add guest/migrate span names and accurate timestamps.
5. Add sanitized attributes and status.
6. Use `PLUGIN_VERSION` for tracer instrumentation.
7. Emit exactly one event per guest/migration result, including missing Rownd users.

Tests:

- Two concurrent request contexts produce correct independent parents.
- No active parent creates a valid root/non-recording span.
- Worker delay does not change operation timestamps.
- Guest and migration names differ.
- Success/error attributes and status are complete.
- Original exceptions and traceback never reach spans.
- Blocking fake processor affects only daemon worker, not event loop or process exit.
- Missing optional dependency is tested in a subprocess where OpenTelemetry is unavailable before package import.

Review gates:

- OpenTelemetry API review.
- Security review for context and attributes.
- Web/auth tests prove request behavior unchanged.

### Commit 4: Packaging, Documentation, and Release

Tasks:

1. Document SDK/exporter setup, flush ordering, queue drops, stable IDs, privacy, and unchanged custom-provider request-loop semantics.
2. Document that formerly silent no-op configurations such as `{}`, `provider="none"`, and unknown providers now fail validation, with explicit migration examples.
3. Add a minor changeset for the new provider and delivery contract without duplicating a manual release note.
4. Build wheel and sdist.
5. Inspect wheel metadata for conditional OpenTelemetry dependency.
6. Add Python 3.9 and 3.12 package/extras installation coverage where CI permits.

Review gates:

- DevOps/package review.
- `npm run check:python-versions` remains clean.
- Base wheel does not install OpenTelemetry transitively.

## Test Matrix

| Area                | Scenario                                 | Expected                                                                |
| ------------------- | ---------------------------------------- | ----------------------------------------------------------------------- |
| Optional dependency | Base package without OTel                | Import and non-OTel providers work                                      |
| Optional dependency | OTel selected without extra              | Clear atomic startup failure                                            |
| Provider validation | Unknown/missing/inapplicable fields      | Startup failure                                                         |
| Request latency     | Slow Axiom/OTel                          | Endpoint returns without waiting                                        |
| Queue bounds        | Full queue                               | Immediate deterministic drop                                            |
| Worker resilience   | Provider raises                          | Later event still delivered                                             |
| Shutdown            | Provider permanently blocks              | Process exits because worker is daemon                                  |
| Flush               | Events before/after barrier              | Only accepted pre-barrier events bound the call                         |
| Context             | Concurrent request parents               | Correct parent per span                                                 |
| Timing              | Worker delayed                           | Span timestamps still match operation                                   |
| Naming              | Guest and migration                      | `rownd.guest`, `rownd.migrate`                                          |
| Privacy             | Error contains PII/secrets               | None appears in event, span, or touched guest/migration debug log       |
| Axiom               | Default/custom URL, non-2xx              | Existing fields preserved except sanitized error text; failure isolated |
| Custom              | Existing async client                    | Runs on its original request event loop unchanged                       |
| Atomicity           | Factory/import/plugin construction fails | Prior runtime/config retained; no thread leak                           |
| Packaging           | Base wheel and OTel extra                | Conditional dependency metadata correct                                 |

## Verification

From `packages/rownd-python`:

```bash
uv lock --check
uv run ruff check .
uv run pyright
uv run pytest tests/test_telemetry.py
uv run pytest
uv run python -m build
```

From repository root:

```bash
npm run check:python-versions
npm run lint -- --filter=@supertokens-plugins/rownd-python
npm run test -- --filter=@supertokens-plugins/rownd-python
```

Inspect built wheel metadata to confirm the OpenTelemetry dependency is conditional and the base install remains unchanged.

## Rollout

1. Merge the reviewed implementation commits without releasing or enabling OpenTelemetry between Commit 1 and Commit 3.
2. Validate dispatcher/flush with Axiom while confirming custom clients remain on the request loop.
3. Enable the OpenTelemetry adapter only after daemon-worker behavior is proven.
4. Release with a minor changeset describing the new provider, asynchronous Axiom delivery, and sanitized error text.
5. Smoke test no-op, custom, mocked Axiom, OTel no-op provider, and short-lived process shutdown.

## Acceptance Criteria

- OpenTelemetry is optional and lazily imported.
- Unknown provider configuration fails before global state mutation.
- Guest/migration requests using built-in Axiom/OpenTelemetry never await telemetry I/O or queue capacity.
- Queue and shutdown behavior are bounded.
- A blocked exporter cannot block event loop or process exit.
- Every span uses its event's captured trace context.
- Span names and timestamps represent the actual operation.
- Public flush is deterministic and bounded.
- No raw error, PII, token, request body, or response body is exported.
- Existing payload fields and identifiers remain compatible; `error.message` is intentionally changed from raw exception text to a documented generic message.
- Existing custom clients retain their request-loop and event-loop affinity.
- Release documentation covers migration from formerly accepted silent no-op provider configurations.
- Base and extra wheel installation paths are tested.
- Each implementation commit is independently tested and reviewed before the next phase.

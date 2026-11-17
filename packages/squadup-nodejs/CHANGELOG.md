# @supertokens-plugins/squadup-nodejs

## 0.3.2

### Patch Changes

- 919aeac: Rebuild and verify CJS/ESM entrypoints before packing or publishing. Check bundled version and permissive ticket responses to prevent releases shipping stale compiled code.

## 0.3.1

### Patch Changes

- 6d6ff85: Add safe failure diagnostics identifying request stage, upstream HTTP status, duration, and response-validation field/type mismatches. Include allowlisted network error codes without exposing credentials, email addresses, response data, or raw exception messages.
- 6d6ff85: Pass through SquadUp event and ticket metadata without enforcing field schemas or converting IDs. Retain only structural checks required to traverse attendees and tickets, plus QR/PDF visibility filtering. This fixes successful SquadUp lookups incorrectly returning 502 for numeric IDs, missing metadata, or changing upstream field types. Response types now represent arbitrary JSON metadata.

## 0.3.0

### Minor Changes

- 79ead62: Support per-tenant SquadUp credential resolution using verified sessions while preserving static API keys. Bound and coalesce email lookups with a configurable cache, enforce pagination limits, and allow per-ticket availability callbacks with the existing two-hour default. Hide QR/PDF for unknown event dates, reject invalid upstream responses and non-success HTTP statuses, and sanitize failures. Log the plugin's package version.

  Scope linked-user email selection to login methods belonging to the verified session tenant. Strictly validate timestamp calendar components and explicit timezones before exposing QR/PDF, and document credential redaction for HTTP tracing.

  Treat SquadUp 404 responses as successful empty ticket lists. Extract email caching into a dedicated module.

## 0.2.0

### Minor Changes

- d80fbd2: Add plugin to list squadup tickets

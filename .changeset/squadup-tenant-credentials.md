---
"@supertokens-plugins/squadup-nodejs": minor
---

Support per-tenant SquadUp credential resolution using verified sessions while preserving static API keys. Bound and coalesce email lookups with a configurable cache, enforce pagination limits, and allow per-ticket availability callbacks with the existing two-hour default. Hide QR/PDF for unknown event dates, reject invalid upstream responses and non-success HTTP statuses, and sanitize failures. Log the plugin's package version.

Scope linked-user email selection to login methods belonging to the verified session tenant. Strictly validate timestamp calendar components and explicit timezones before exposing QR/PDF, and document credential redaction for HTTP tracing.

Treat SquadUp 404 responses as successful empty ticket lists. Extract email caching into a dedicated module.

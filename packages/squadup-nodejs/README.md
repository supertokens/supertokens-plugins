# SuperTokens SquadUp Plugin

Adds an authenticated endpoint for listing SquadUp tickets for the current SuperTokens user.

```ts
import SquadUpPlugin from "@supertokens-plugins/squadup-nodejs";

SuperTokens.init({
  experimental: {
    plugins: [
      SquadUpPlugin.init({
        apiKey: process.env.SQUADUP_API_KEY!,
      }),
    ],
  },
});
```

## Endpoint

`GET /auth/plugin/squadup/tickets`

The endpoint requires a SuperTokens session. It uses a passwordless email login method, or a verified third-party email login method, as the SquadUp lookup email. The method's `tenantIds` must include the verified session tenant. Linked-user login methods from other tenants are excluded; no eligible method returns HTTP 400 without calling SquadUp.

### Tenant credentials

Configure exactly one of `apiKey: string` or
`resolveApiKey: ({ tenantId, userContext }) => Promise<string | undefined>`.
Static credentials remain supported. The resolver runs on every valid request;
credentials are never cached or written into shared plugin configuration.
`tenantId` comes exclusively from the verified session's `getTenantId()`, never
from query parameters. `userContext` is the SDK request context.

```ts
SquadUpPlugin.init({
  resolveApiKey: async ({ tenantId, userContext }) => {
    return tenantCredentials.getSquadUpApiKey(tenantId, userContext);
  },
});
```

Return `undefined` when the tenant has no integration configured: the endpoint
returns HTTP 503. Resolver exceptions or invalid resolved keys return a sanitized
HTTP 500. Neither case calls SquadUp or looks up the user. Keys must be non-empty
strings. The plugin's own logs omit exception details, upstream URLs and tokens.

SquadUp requests carry the API key in the URL's `access_token` query parameter.
HTTP tracing and other request instrumentation can record that URL independently
of plugin logging. Consumers must omit these credential-bearing requests from
tracing or redact their credentials before recording/exporting them.

### Pagination and email cache

`?pageSize=25` controls the upstream `page_size`. `defaultPageSize` and
`maxPageSize` both default to 100 and must be positive integers, with
`defaultPageSize <= maxPageSize`. Invalid or oversized queries return HTTP 400
before credential resolution, user lookup or SquadUp calls.

Each plugin instance has a bounded, least-recently-used email cache keyed by
`[tenantId, userId]`. Defaults: `emailCache: { ttlMs: 30_000, maxEntries: 1000 }`.
Set `emailCache: false`, `ttlMs: 0`, or `maxEntries: 0` to disable it.
Concurrent misses for a resident entry share one user lookup; thrown failures are
not cached. TTL starts when the lookup completes. Eviction can remove pending
lookups too, so a subsequent request may start a new lookup under capacity pressure.

**Email, verification, and login-method tenant membership changes can remain stale for up to the cache
TTL (30 seconds by default).** Unsupported/missing emails are cached for the same
interval. Disable caching when every request must recheck current user state.
Tickets and tenant credentials are never cached.

### Per-ticket QR/PDF visibility

`ticketAvailabilityWindowMs` defaults to the numeric value `7_200_000` (two hours).
It accepts either a finite, non-negative number or a synchronous callback:

```ts
SquadUpPlugin.init({
  apiKey: process.env.SQUADUP_API_KEY!,
  ticketAvailabilityWindowMs: ({ event, ticket, tenantId, userContext }) => {
    return ticket.type === "VIP" ? 24 * 60 * 60 * 1000 : 2 * 60 * 60 * 1000;
  },
});
```

The callback receives the upstream event and ticket as SDK `JSONObject` values,
plus the verified tenant and request context. It runs once per ticket and must
return a finite, non-negative number; exceptions and invalid results produce a
sanitized HTTP 500.

Visibility affects **only each ticket's `qrcode_str` and `pdf_url`**. Events,
tickets and their other metadata remain in the response, including mixed events
with both available and unavailable tickets. QR/PDF are visible when
`eventStart - now <= window`, including the exact boundary and past events.
The ticket's `event.start_at` takes precedence; if absent/null, the enclosing
event's `start_at` is used. Unknown or invalid dates hide QR/PDF (`null`);
an explicitly invalid ticket date does not fall back to the enclosing event.
Supported timestamps use `YYYY-MM-DDTHH:mm:ss[.fraction]Z` or an explicit
`±HH:mm` offset, with valid calendar and clock components. Timezone-free dates,
normalized impossible dates, and the unknown offset `-00:00` are rejected.
Fractional seconds are supported beyond millisecond precision; visibility rounds
up to the next millisecond when necessary so truncation cannot reveal tickets early.

### Responses

| HTTP | Meaning                                                                         |
| ---- | ------------------------------------------------------------------------------- |
| 200  | `{ status: "OK", events: [...] }` (an empty attendees list yields `events: []`) |
| 400  | Invalid page size or no supported verified email (`BAD_INPUT_ERROR`)            |
| 401  | Missing session                                                                 |
| 500  | Credential resolver, user lookup, or visibility-policy failure                  |
| 502  | SquadUp transport, non-2xx except 404, invalid JSON, or invalid response fields |
| 503  | Tenant integration not configured                                               |

SquadUp HTTP 404 means no tickets exist for the email and returns HTTP 200 with
`{ status: "OK", events: [] }`, regardless of the upstream response body.

Error responses contain `status` and a sanitized `message`. Successful upstream responses
must contain an attendees array with event and guest/ticket objects. Fields used
by the plugin and required response metadata are validated before mapping.

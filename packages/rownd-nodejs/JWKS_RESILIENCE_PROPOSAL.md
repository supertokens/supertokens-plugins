# SDK-level resilience for remote JWKS verification

Status: proposal. The Rownd plugin currently includes a bounded Apple verification retry; the SDK changes below are not implemented.

## Summary

Some Apple `/auth/signinup` requests fail with HTTP 500 because the SDK cannot retrieve the public keys needed to verify an ID token. The reported exception is:

```text
JOSEError: Expected 200 OK from the JSON Web Key Set HTTP response
code: ERR_JOSE_GENERIC
```

Two SDK behaviors amplify a temporary upstream failure:

1. Remote JWKS resolvers are created inside provider instances that are recreated for sign-in requests, preventing useful cross-request key caching.
2. A failed key fetch is propagated without a bounded retry.

The recommended SDK solution is to reuse remote JWKS resolvers across requests and retry transient failures at the JWKS HTTP-fetch boundary. Apply this to all providers using remote JWKS verification, rather than only Apple or every provider operation.

## Evidence and limits

The investigation covered:

- The supplied production stack trace.
- The application's dependency declaration, which pins `supertokens-node` to `24.0.0` and the Rownd plugin to `0.7.12`.
- Published `supertokens-node@24.0.0` source.
- The matching `jose` Node HTTP-fetch implementation in this workspace.
- [The application's Apple retry override](https://github.com/Stardust-App/stardust-supertokens-node-sdk/commit/e6c391fc860f56dba147efa1280101efefc4bdc8).

The stack establishes that an HTTP response from the JWKS request had a status other than 200. It does **not** include the response status, body, URL, or headers. The customer reports intermittent 404 responses, which is consistent with the exception but cannot be independently confirmed from this log.

The exact deployed `jose` version was not established. Transport hooks and error shapes must be checked against the SDK's supported dependency versions before implementation.

## Failure path

```text
POST /auth/signinup
  -> Rownd third-party API wrapper
  -> SuperTokens signInUpPOST
  -> Apple getUserInfo
  -> generic OAuth provider getUserInfo
  -> verifyIdTokenFromJWKSEndpointAndGetPayload
  -> jose.jwtVerify
  -> RemoteJWKSet.getKey / reload
  -> HTTP GET of the provider's JWKS URL
  -> non-200 response throws JOSEError
  -> exception reaches application error handling
  -> HTTP 500
```

For the standard Apple configuration, the JWKS URL is discovered through Apple's OpenID configuration and is normally `https://appleid.apple.com/auth/keys`.

This happens before successful sign-in and before the Rownd wrapper's post-success metadata/session updates. The error is not evidence of a migration, account-linking, invalid-token, or SuperTokens Core failure.

### Why existing caching does not protect subsequent requests

In SDK 24.0.0:

- `recipe/thirdparty/recipeImplementation` calls `findAndCreateProviderInstance` from `getProvider`.
- `recipe/thirdparty/providers/configUtils` creates a new provider instance for that call.
- `recipe/thirdparty/providers/custom` keeps `let jwks` inside the provider constructor and lazily initializes it with `createRemoteJWKSet`.

The key cache belongs to that resolver instance. A later sign-in request normally receives a new provider and resolver, so it performs a new fetch instead of reusing keys obtained by a previous request.

The inspected `jose` implementation defaults to a ten-minute cache lifetime, a thirty-second cooldown for missing-key refreshes, and a five-second fetch timeout. Those settings do not create a shared cache: their benefit depends on reusing the resolver. Confirm defaults for the version selected for implementation.

## What might cause the failure?

### Causes consistent with this exact exception

- **Temporary provider/CDN failure:** an edge or origin returns 404, 502, 503, or another unexpected status while the key resource is unavailable.
- **Rate limiting:** repeated key fetches trigger a 429. Per-request resolver creation can increase request volume, but there is no evidence that this incident was rate limiting.
- **Intermediary response:** an egress proxy, service mesh, or filtering gateway returns its own error response.
- **Incorrect or changed configuration:** a custom JWKS URI or discovery document points at a missing resource. A persistent 404 must not automatically be classified as an outage.
- **Redirect:** the inspected transport requires a 200 response and does not follow redirects. A 3xx also produces this exception.

The source of the response cannot be identified from the exception alone. An intermittent symptom makes a transient upstream or infrastructure issue plausible, but does not prove it.

### Related failures with different errors

DNS failures, socket resets, and timeouts can also interrupt key retrieval, but normally produce different error codes. A 200 response containing malformed JSON produces a parsing error. These belong in the resilience design, but do not explain the exact supplied message.

Provider key rotation normally triggers a missing-key lookup and refresh. It is not itself a non-200 HTTP response, although it can expose an unavailable endpoint when new keys are needed.

### Why only some requests fail

Different requests can encounter different provider edges or brief failure windows. Concurrent requests can independently fetch the same keys in the current SDK path. Replicas also have independent process state. These are possible explanations, not observations established by the report.

## Should this cover every provider?

**Cover every provider that uses the SDK's remote JWKS verification path. Do not retry every kind of provider operation.**

The failure mechanism is shared infrastructure, not an Apple-specific token-validation rule. Google, other OIDC providers, and custom providers using a remote JWKS URI can encounter the same transport failures.

The boundary matters:

- Retry the HTTP GET used to retrieve public signing keys.
- Preserve all existing token signature, audience, issuer, expiry, and other claim checks.
- Do not retry token validation failures as though they were transport failures.
- Do not wrap the entire sign-in API: it can exchange a single-use authorization code, create users, link accounts, or create sessions.
- Do not automatically retry arbitrary `getUserInfo` overrides, OAuth token exchanges, SAML operations, or providers that do not use JWKS. They have different semantics and may have side effects.

The plugin's Apple `getUserInfo` wrapper is a practical short-term interception point. The SDK has a narrower and more appropriate shared boundary: the key fetch itself.

## Proposed SDK changes

### 1. Reuse remote JWKS resolvers across requests

Move resolver ownership out of individual provider instances into an SDK-instance-scoped registry.

- Key entries by the full normalized JWKS URL and any fetch policy that changes their behavior, such as custom headers or transport configuration. Do not merge differently authenticated endpoints.
- Reuse the resolver, not a token's decoded payload or a token-verification result. Client-specific verification options remain per call.
- Retain the library's expiry, key selection, and key-rotation behavior.
- Share in-flight refreshes for a resolver so concurrent requests do not independently fetch the same endpoint.
- Bound the registry and evict idle entries; multitenant/custom-provider configurations can introduce many URLs.
- Clear instance-owned state during SDK reset or teardown. A configuration change to the URI must select a different entry.

Prefer an in-process registry initially. Each replica will still need its own initial fetch; a distributed key cache introduces additional consistency and operational concerns and is not necessary for the first fix.

Sharing a resolver is compatible with different client IDs using the same public key endpoint, provided token validation still uses each request's own client configuration.

### 2. Add bounded retries to key retrieval

Implement retries inside the shared fetch/refresh operation so concurrent callers share one retry sequence.

Suggested starting policy:

- At most three total attempts.
- Exponential backoff with jitter, for example 200–250 ms and 600–750 ms between attempts.
- Per-attempt timeout plus a total retry deadline. Three five-second timeouts would otherwise consume roughly sixteen seconds, which may exceed the application's request budget.
- Respect `Retry-After` for applicable responses, within that deadline; if the requested wait exceeds the remaining budget, fail rather than retry early.
- Preserve cancellation when the request or verification operation is aborted.

Use structured transport errors and HTTP status codes rather than matching human-readable error messages in the long-term implementation.

Candidate classifications:

- Retry 408, 429, and selected transient 5xx responses such as 500, 502, 503, and 504.
- Retry selected transient network failures, such as connection resets, timeouts, and temporary DNS failures.
- Consider a small bounded retry for a 200 response containing unparseable JSON, which can occur during an upstream incident. Do not treat a structurally invalid key set as a token-verification success.
- Do not generally retry 400, 401, 403, redirects, certificate-validation failures, or invalid JWKS configuration.
- Treat **404 as an explicit policy decision**. This reported Apple incident motivates a narrowly scoped exception for Apple's known JWKS endpoint, or a configurable endpoint policy. A 404 is not transient for every custom provider.

The current `jose` error loses the HTTP status, so a catch around `jwtVerify` cannot implement this classification precisely. First evaluate a supported custom-fetch hook in the chosen `jose` version. If unavailable, assess a dependency upgrade or an SDK-owned retrieval adapter that retains JOSE key selection and verification. Avoid monkey-patching dependency internals or reimplementing cryptography.

### 3. Improve diagnostics and terminal error handling

Expose enough information to distinguish a provider outage from a bad configuration:

- HTTP status or network error code.
- Provider identifier and sanitized endpoint identity, without URL credentials or sensitive query parameters.
- Attempt number, elapsed time, and whether the request was an initial fetch or refresh.
- Cache hits/misses and refresh failures, using bounded-cardinality metric labels.

Do not log OAuth tokens, authorization codes, credentials, or complete response bodies. Emit retry diagnostics and a final failure signal without multiplying identical logs for every waiter on a shared fetch.

After exhaustion, continue to fail authentication. Consider a structured SDK error for upstream key unavailability so applications can choose an appropriate temporary-unavailability response. Changing the default HTTP status or API response shape requires a separate compatibility decision.

### 4. Keep stale-key fallback out of the initial change

Serving previously cached keys beyond their normal lifetime could improve availability, but extends trust in keys that the provider may have removed. Do not silently enable this as part of the caching fix. Any future stale-key policy needs explicit limits, rotation/revocation analysis, and separate tests. An unknown key must never bypass verification.

## Implementation options and trade-offs

**Retry only:** smallest mitigation for brief incidents. It retains unnecessary network traffic and can amplify load during a sustained outage.

**Shared resolver only:** reduces network dependence and coalesces refreshes. Cold-start and refresh failures can still reject sign-ins immediately.

**Shared resolver plus fetch-level retries — recommended:** reduces fetch volume and makes unavoidable fetches resilient. Requires a supported way to inspect HTTP responses and coordinate refreshes.

**Provider-level `getUserInfo` retry:** suitable for the current Apple plugin workaround, but too broad as a universal SDK policy because providers and overrides can perform additional work.

## Validation plan

Use a controlled local JWKS server and genuinely signed tokens to test the full verification path:

1. Two separate provider instances using the same endpoint verify tokens with one initial key fetch.
2. Concurrent sign-ins share one fetch and one retry sequence.
3. A transient failure followed by a valid JWKS succeeds within the configured deadline.
4. Persistent failures stop at the attempt/deadline limit and preserve useful diagnostic details.
5. Retryable and non-retryable HTTP statuses follow the policy, including the Apple 404 exception and `Retry-After`.
6. Timeouts, socket failures, malformed responses, and cancellation terminate or retry as intended.
7. Cache expiry and key rotation trigger refresh correctly; unknown key IDs respect cooldown behavior and do not cause uncontrolled fetches.
8. Invalid signatures, expired tokens, wrong audiences, and other invalid claims remain rejected.
9. Providers sharing keys but using different client IDs still enforce their own validation settings.
10. Different endpoints or transport policies are isolated; registry eviction and SDK teardown release entries.
11. An end-to-end sign-in that recovers from a key-fetch failure exchanges the authorization code only once and does not duplicate user/session operations.

## Rollout

1. Confirm the supported `jose` versions, fetch extension points, and current SDK provider lifecycle.
2. Implement the shared registry and bounded fetch retries with conservative defaults and documented configuration.
3. Verify compatibility across supported SDK runtimes and representative built-in/custom OIDC providers.
4. Observe fetch volume, retry recovery rate, terminal failures, and sign-in latency.
5. Once the SDK fix is adopted, remove or disable the Rownd plugin and application retry wrappers. Nested three-attempt wrappers can multiply attempts and request latency.

## Current plugin mitigation

The Rownd plugin wraps Apple verification in `src/apple-jwks-retry.ts`, called from its third-party `signInUpPOST` override in `src/plugin.ts`. It retries selected retrieval failures up to three times with jittered backoff, preserving the existing provider implementation and OAuth tokens.

This reduces exposure to short incidents but does not provide cross-request JWKS caching, HTTP-status-aware retry classification, or a total fetch deadline. Those are the principal reasons to move resilience into the SDK's shared key-retrieval layer.

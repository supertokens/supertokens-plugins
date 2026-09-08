# SuperTokens Rownd Python Plugin

Rownd migration plugin for `supertokens_python`.

> [!IMPORTANT]
> Verified Core user-ID mapping rejections for existing Session or UserMetadata references return `CORE_CAPABILITY_REQUIRED` (HTTP 503, `retryable: false`, `stage: "mapping"`). The plugin does not automatically repair these references, force mappings, or revoke existing sessions to unblock mapping. No optional narrow mapping capability is wired.

This rejection classification is compatibility-tested with Python SDK **0.31.3** and Core **12.0.10**: the SDK-wrapped HTTP 400 from `POST /recipe/userid/map` with message `UserId is already in use in Session recipe` or `UserId is already in use in UserMetadata recipe`. Other recipes and error formats are not assumed recognized; other errors retain existing handling. Exact bidirectional mapping postconditions still recover races, including when the mapping call reports an error.

This package is managed by Turborepo through `package.json`, but published as a Python package named `supertokens-rownd`.

## Installation

Install from PyPI:

```bash
pip install supertokens-rownd
```

With `uv`:

```bash
uv add supertokens-rownd
```

For local development, install from this repository checkout with `uv sync --dev`.

## Local Development

```bash
cd packages/rownd-python
uv sync --dev
uv run python -m build
uv run pytest
```

From the repository root, Turborepo can run the Python package tasks because this directory has a `package.json` workspace adapter:

```bash
npm run build -- --filter=@supertokens-plugins/rownd-python
npm run test -- --filter=@supertokens-plugins/rownd-python
```

## Usage

```python
from supertokens_python import (
    InputAppInfo,
    SupertokensConfig,
    SupertokensExperimentalConfig,
    init,
)
from supertokens_python.recipe import accountlinking, emailverification, passwordless, session, thirdparty, usermetadata
from supertokens_rownd import init as RowndMigrationPlugin

init(
    app_info=InputAppInfo(
        app_name="My App",
        api_domain="https://api.example.com",
        website_domain="https://example.com",
        api_base_path="/auth",
    ),
    framework="fastapi",
    supertokens_config=SupertokensConfig(
        connection_uri="https://try.supertokens.com",
    ),
    recipe_list=[
        accountlinking.init(),
        session.init(),
        usermetadata.init(),
        passwordless.init(
            contact_config=passwordless.ContactEmailOrPhoneConfig(),
            flow_type="MAGIC_LINK",
        ),
        emailverification.init(mode="OPTIONAL"),
        thirdparty.init(sign_in_and_up_feature=thirdparty.SignInAndUpFeature(providers=[])),
    ],
    experimental=SupertokensExperimentalConfig(
        plugins=[
            RowndMigrationPlugin(
                rownd_app_key="rownd_app_key",
                rownd_app_secret="rownd_app_secret",
                # Optional: trusted Rownd application ID, not a token or UI config value.
                rownd_app_id="your-rownd-app-id",
                # Must match InputAppInfo.api_base_path.
                api_base_path="/auth",
                # Should match InputAppInfo.api_domain.
                api_domain="https://api.example.com",
                # Should match InputAppInfo.website_domain when using passwordless confirmation bypass.
                website_domain="https://example.com",
                app_name="My App",
                email_change={
                    "max_session_age_seconds": 600,
                    "retirement_mode": "observe",
                },
                app_config={
                    "auth": {
                        "enforceSameDevicePasswordlessSignIn": True,
                    }
                },
            )
        ]
    ),
)
```

`app_config.auth.enforceSameDevicePasswordlessSignIn` controls the Hub UI policy for
passwordless flows originating from `mobile_app`. It does not enforce server-side device binding.

### Optional Rownd application ID

`rownd_app_id` defaults to `None`. When set, it supplies the expected token audience
(`app:<id>`) and profile URL application ID, skipping authenticated `/hub/app-config`
ID discovery. Omit it to retain cached discovery. A configured ID does not fall back
to discovery on profile failures. Credentials are still required for migration, and
OIDC discovery/JWKS, signature, temporal, audience, and discovery-issuer validation
remain in place. Neither `app_config` nor token claims choose the expected app ID.
The migration identity remains `https://auth.rownd.io/app_user_id`, not `sub`.

Plugin initialization rejects invalid IDs with `ValueError`: supply a nonempty ASCII
URL-path-segment string using letters, digits, or `._~!$&'()*+,;=:@-`, excluding `.`
and `..`. Whitespace, slashes, backslashes, percent escapes, query/fragment delimiters,
and non-string values are rejected rather than normalized.

## Routes

The plugin registers these routes below `api_base_path`:

- `GET /plugin/rownd/app-config`
- `POST /plugin/rownd/guest`
- `POST /plugin/rownd/migrate`
- `POST /plugin/migrate-session`
- `POST /plugin/passwordless-cross-device-confirmation/validate`
- `POST /plugin/rownd/signout`

`GET /plugin/rownd/app-config` returns HTTP 400 for an unknown `app_variant_id`, with
`{"status":"ERROR","reason":"UNKNOWN_APP_VARIANT","message":"Unknown Rownd app variant: <id>"}`.
The message is unchanged; valid or omitted variants retain their HTTP 200 behavior.

Migration and guest routes accept an optional `tenantId` query parameter and default to `public`. Compatibility user views, sessions, and pending email verification are scoped to that tenant; user metadata remains shared across tenant memberships.

Both migration routes return HTTP 200 with `{"status":"OK"}` on success. Failures use a
non-2xx status and a stable body containing `reason`, `retryable`, `stage`, and
`operationId`. Callers must branch on the HTTP status and `reason`, not the human-readable
`message`. Rownd profile 404s, rejected plugin credentials, malformed app configuration or
profile data, and transient Rownd failures have distinct stable classifications. Authenticated
app-config and profile 401/403 responses indicate invalid plugin credentials because the
repository has no structured Rownd error code proving another category. HTTP 408, 429, and
5xx responses are retryable Rownd unavailability. Authenticated app-config and profile
requests reject redirects; network and body-read operations use a total request deadline, and
response bodies are streamed under a 1 MiB limit. JSON parsing is synchronous and cannot be
preempted by the event-loop deadline, but its work is bounded by that response limit. The plugin
does not classify disabled Rownd profiles because the current profile response contract in
this repository does not establish an authoritative disabled-state field and value.

A missing Rownd user returns `ROWND_USER_NOT_FOUND` (HTTP 401, `retryable: false`),
not a successful no-op, on both migration routes.

Recognized Core transport failures and SDK 0.31.3-wrapped HTTP 5xx errors become
`CORE_UNAVAILABLE` (HTTP 503, `retryable: true`) when reconciliation cannot establish
completion. Recognition uses the verified SDK exception envelope, not arbitrary
error text or a recipe error code. Other unresolved failures can remain
`MIGRATION_INCOMPLETE` (HTTP 503, `retryable: true`); read the returned `stage` rather
than assuming it identifies the original failing write.

Core bulk import uses 5-second HTTPX operation/inactivity timeouts, a practical
15-second total request deadline, and a streamed 1 MiB response limit. It requests
`Accept-Encoding: identity` and refuses non-identity compression before decoding.
Invalid lengths, oversized bodies, malformed JSON, and invalid success envelopes
are rejected; rejected HTTP 5xx responses retain outage classification. Synchronous
JSON parsing and uncooperative cancellation are not independently preemptible.
These are per-import bounds, not an end-to-end migration deadline.

A timeout, lost acknowledgement, or rejected response does **not** prove an import
failed to commit. There are no blind transport write retries: the request-local Core
call cache is cleared even on failure/cancellation, and reconciliation reads fresh
state before deciding whether another write is needed. Success requires completed
postconditions; unavailable inspection is not success. Bulk-import error objects
retain no response body; duplicate recovery remains limited to HTTP 400 with a
nonempty error list containing only `E006:` entries. `E027` is not treated as E006.

Decoded token `kid` values containing lone Unicode surrogates are rejected as
`TOKEN_MALFORMED` (HTTP 401) before network requests, cache work, or JWKS diagnostics,
regardless of diagnostic sampling. Valid non-ASCII Unicode key IDs remain supported.

Migration conflicts return HTTP 422 with body `code: 422` and `retryable: false`.
HTTP 409 is avoided because existing native clients interpret it as an existing session.
These blocked outcomes create no session and return no session credentials. Email-change
conflicts retain their HTTP 409 status.

If a Passwordless identity is created but linking is interrupted, migration can recover
the standalone email/phone owner using an exact Rownd mapping or a non-raw target already
pinned in the invocation. Recovery still requires a verified, matching, same-tenant,
nonprimary foreign owner with valid metadata and no conflicting Rownd ownership/mapping.
Multiple owners of the same identity always block. Separate email/phone owners without
that authority remain ambiguous; raw-ID graph overlap alone does not bypass this check.

| Migration Reason | HTTP Status | Retryable |
| --- | --- | --- |
| `IDENTITY_AMBIGUOUS` | 422 | false |
| `IDENTITY_OWNED_BY_ANOTHER_USER` | 422 | false |
| `MAPPING_CONFLICT` | 422 | false |
| `RAW_USER_ID_COLLISION` | 422 | false |
| `PRIMARY_ACCOUNT_MERGE_REQUIRED` | 422 | false |
| `MIGRATION_STATE_INVALID` | 422 | false |

Rownd migration tokens must use `EdDSA`, include a non-empty `kid`, and contain valid `aud`
and `iat` claims, plus a non-empty string `https://auth.rownd.io/app_user_id`. Legacy Rownd tokens
issued with `meta.access_token_ttl: "never"` may omit `exp`; expiration is still verified when
`exp` is present. `nbf` is also validated when present. The expected audience is the configured
Rownd application (`app:<app-id>`). If trusted Rownd discovery metadata publishes an `issuer`,
the token must also contain the matching `iss`; no issuer is assumed when discovery omits it.

An unknown signing key triggers at most one generation-aware, single-flight JWKS refresh. If the
key is confirmed absent after a fetch (or a valid negative-cache lookup for the current
generation), migration returns HTTP 401 with `reason: "TOKEN_KID_UNKNOWN"` and
`retryable: false`. The caller must discard the token and reauthenticate; repeatedly submitting
the same token cannot help until Rownd publishes its key. Refreshes have a 5-second global
cooldown. If that cooldown suppresses a refresh for an unconfirmed miss, both migration routes
return HTTP 503 with `reason: "ROWND_UNAVAILABLE"` and `retryable: true`; retry after the cooldown
without discarding the token. Suppressed misses are not negative-cached, and known cached keys
remain usable. Confirmed misses enter a 256-entry per-`kid` negative cache for 5 seconds. Negative
entries never suppress the first generation-aware refresh permitted after the global cooldown,
so maximum policy-induced new-key recognition delay is 5 seconds, independent of the normal
5-minute JWKS TTL; network and refresh execution time is additional. Cold-cache and expired-cache
failures use the same backoff. Failed refreshes retain the last known-good keys and repeat their
typed JWKS failure during the cooldown. `asyncio.wait_for` applies a practical 10-second total
timeout to discovery plus JWKS. On Python 3.9 it cannot provide a strict cancellation-independent
deadline if lower-level code suppresses cancellation.

The migration `Authorization` header must be exactly `Bearer <token>`; the scheme remains
case-insensitive for compatibility. For known keys, signature and
issuer-independent temporal verification happen before the authenticated app-ID request; forged,
expired, and not-active tokens therefore cannot amplify authenticated requests. Discovered app
IDs use a single-flight, generation-counted 5-minute cache, bounding requests from valid-signature
cross-audience tokens while final audience and trusted issuer validation remain mandatory. Fast
app-config failures are single-flight and replay their typed error for 5 seconds. An expired app ID
is not served stale during failure because the plugin cannot safely distinguish an outage from an
application-ID change.

### Logging and migration telemetry

The plugin uses standard Python logging under `supertokens_rownd`, not direct
`print` calls. `enable_debug_logs=True` opts diagnostic messages in at **INFO**;
logger/handler levels still apply. Warnings do not require that flag. Configure
application handlers to collect this logger and its children.

Each migration handler emits one sanitized local terminal summary before telemetry
delivery, independently of the debug flag and telemetry client: errors at WARNING,
success/cancellation at INFO. Fields are `operationId`, `outcome`, allowlisted
`stage`, `reason`, and `retryable`; no raw identities, tokens, request URLs, response
bodies, exception text, or tracebacks are included. Guest-login and confirmation-
bypass failure logs use fixed codes; unknown app-variant warnings omit the supplied
variant. This does not sanitize application/SDK/transport logging or legacy guest
telemetry.

The plugin samples 10% of key-miss diagnostics, globally limits them to one submission per second,
and delivers them through a dedicated four-slot registry that requests cancellation after 250 ms.
Terminal migration telemetry has separate capacity. If custom telemetry suppresses cancellation,
its slot remains occupied until it actually exits; this keeps pending diagnostic deliveries hard
bounded at four rather than accumulating detached tasks. Diagnostic events contain only a
16-hex-character `kid` hash, bounded outcome and reason values, key count, and cache generation;
they never contain the token or raw `kid`, and the `kid` is not used as a metric label.

The plugin constructs exactly one terminal telemetry event and awaits best-effort delivery
for up to 250 ms per migration request, allowing cooperative clients to finish before a
request-scoped event loop (such as Django WSGI) closes. Migration events contain stable result and reconciliation
fields, but no raw Rownd or SuperTokens IDs, tokens, URLs, response bodies, stack traces, or
exception messages. Delivery uses application-event-loop tasks tracked in a process-wide
128-slot registry. Delivery is lossy: a new event is dropped when all slots are
occupied. Timeout requests cancellation without waiting for acknowledgement. A hung or
cancellation-resistant delivery retains its slot until it exits but does not prevent
other available slots from delivering independently. In-process custom async telemetry is
trusted extension code and runs on the application event loop where it was submitted; it must
not perform synchronous blocking work on that loop. The plugin cannot preempt arbitrary
blocking Python callback code, so the deadline requires a responsive event loop. A client
that suppresses cancellation can also delay framework-owned loop teardown; the plugin does
not wait for it after the deadline. Synchronous implementations are rejected. Client failures
(including client cancellation) do not change the migration result; external request cancellation
during delivery cancels the delivery task and propagates promptly. Early failures report `attemptCount: 0`; recovery paths
distinguish retry convergence from final postcondition recovery. Cancelled requests construct
a terminal `outcome: "cancelled"` event with telemetry-only `httpStatus: 499`, attempt delivery
subject to the same deadline and bounded-capacity drop policy, do not fabricate an HTTP response, and
re-raise cancellation. These privacy guarantees apply to migration events. Guest telemetry
retains its legacy payload and delivery path and is outside this migration contract.

### Migration and compatibility behavior

Rownd passwordless identifiers are authoritative during migration. When an exact
third-party identity and an existing Passwordless email belong to separate users, the
plugin links the Passwordless method only if Rownd verifies that email, its owner is not
already primary, and it is not mapped to another Rownd user. `verified_data.email` must
be `true` or match `data.email` case-insensitively. Other ownership conflicts still fail
migration.

After all Rownd users have migrated, retain the compatibility routes without Rownd credentials by configuring `disable_rownd_user_migration=True`. This removes both migration routes; when no app key is configured, it uses an internal app key for passwordless and verification-link rewriting.

Passwordless resend requests preserve Rownd display, redirect, client-domain, app-variant, and OAuth context. Combined OTP and magic-link deliveries add the Hub `passwordlessFlowType=USER_INPUT_CODE_AND_MAGIC_LINK` parameter; OTP-only deliveries are left unchanged.

- `GET /plugin/rownd/user`
- `PUT /plugin/rownd/user`
- `DELETE /plugin/rownd/user`
- `GET /plugin/rownd/user/meta`
- `PUT /plugin/rownd/user/meta`
- `GET /plugin/rownd/user/field`
- `PUT /plugin/rownd/user/field`

## Rownd Compatibility

The plugin exposes Rownd-compatible user/session behavior for migrated and new SuperTokens users:

- Guest sessions use the `guest` third-party provider.
- Instant sessions use the `instant` third-party provider and preserve `auth_level: "instant"`.
- Passwordless and third-party sign-in refresh Rownd session claims after account linking while preserving the linked guest's `anonymous_id`.
- Compatibility reads combine metadata from the primary and linked recipe users. Profile and metadata writes target the primary user without relocating linked Rownd metadata.
- Google and Apple third-party login methods are exposed as `google_id` and `apple_id` in Rownd-compatible user payloads.
- OAuth2 Provider tokens and userinfo responses include Rownd claims plus standard `email`, `phone`, and `profile` claims when those scopes are requested.
- OAuth2 `resource=app:*` requests are translated to SuperTokens `audience=app:*` for Rownd-compatible OAuth clients.
- Rownd compatibility user routes ignore the global email verification claim validator for profile access; secure email changes apply their own checks.

### Email Changes

Email credential retirement has two rollout modes:

- `observe` is the default. It classifies Passwordless email state but preserves legacy authentication and profile email-change behavior. Legacy completion creates or reuses a Passwordless target and retains previous Passwordless email methods as login aliases. This flow is not distributed-safe: metadata publication has no compare-and-swap or fencing support.
- `guard` rejects retired or malformed Passwordless email create, resend, helper, and consume attempts. Phone credentials are not classified for email retirement; consume session binding still applies as described below. Because safe completion requires metadata compare-and-swap, guard mode also disables starting and completing profile email changes.

Guard enforcement covers the plugin-owned Passwordless HTTP APIs and exported helpers. Calls made directly to the SuperTokens SDK outside those paths are not guarded.

In guard mode, Passwordless consume requires a fresh internal postcheck marker
binding the checked owner and recipe user to the request tenant. The returned
session's recipe user and tenant must match that marker. Both the consume result's
user ID and `returned_session.get_user_id()` must independently match the checked
owner through mapping-aware comparison; native/external aliases are not compared
as raw strings alone. Stale, missing, malformed, or mismatched evidence
denies success. This session-binding check also covers phone consumes; phone
credentials are not subject to email-retirement classification. Observe mode does
not enforce this post-session guard.

Defensive cleanup revokes the returned handle through the SDK boolean-returning
API and always attempts to queue credential clearing. Only literal `True` confirms
targeted revocation. An exact `False` triggers a fresh session-information read;
confirmed absence avoids unnecessary account-wide logout. Failed or unconfirmed targeted cleanup
falls back to linked-account revocation scoped to the **request tenant**, not all
tenants. Cleanup tracks revocation and explicit response-clear queueing separately;
growth of the response-mutator list does not prove clearing succeeded. If clearing
was not queued and response mutators existed before or remain after cleanup, the
handler raises rather than returning normally; otherwise it requests flow restart.
Cancellation propagates, so cleanup completion is not guaranteed.

The `supertokens_rownd` logger emits stable warning diagnostics without emails,
codes, tokens, session handles, or exception text. Observe-mode classification
rejections include `operation`, `code=classification_rejected`, `state`, and
`reason`; classification failures include `operation` and
`code=classification_exception`. Cleanup diagnostics distinguish
`targeted_revoke_failed`, `targeted_revoke_unconfirmed`, `response_clear_failed`,
`account_revoke_failed`, `account_revoke_unconfirmed` (including an empty fallback
result), and `account_revoke_unavailable`. These warnings are independent of
`enable_debug_logs`; none asserts that revocation completed.

When email sign-in is configured in observe mode, changing the profile email starts a
verified Passwordless email change for the initiating tenant. For accounts containing
only real third-party methods, the plugin creates and links the first Passwordless
method after verification. Guest/instant-only accounts and unsupported mixed-account
topologies are rejected. Configure the mode and maximum initiating-session age:

```python
RowndMigrationPlugin(
    rownd_app_key="rownd_app_key",
    rownd_app_secret="rownd_app_secret",
    app_config={"signInMethods": [{"method": "email"}]},
    email_change={
        "max_session_age_seconds": 600,
        "retirement_mode": "observe",
    },
)
```

Before enabling `guard`, stop new email changes and drain or manually resolve all
pending changes. Inventory malformed or ambiguous canonical metadata and repair only
state that an operator has reviewed; the plugin does not guess or automatically repair
security metadata. Inspect metadata on the primary user, specifically
`rownd_pending_verification`, `rownd_email_recipe_user_id`, and
`rownd_email_recipe_user_ids`, to locate pending operations and canonical security
state. Upgrade every worker before changing the mode; mixed observe/guard workers do
not provide a safe rollout boundary. Guard mode protects retirement state published by
prior completed changes, but new email changes must remain disabled until Core and the
Python SDK expose metadata compare-and-swap/revision fencing.

The flow requires Passwordless, EmailVerification, and AccountLinking. It rejects
stale sessions, checks target ownership across all tenants, and binds pending
verification metadata to the initiating user, session, tenant, purpose, and status
before consuming the Core token. In observe mode, completion revokes all account
sessions and returns a replacement session for the new canonical method, but concurrent
completion claims are local compatibility behavior rather than a distributed guarantee.
The tenant's canonical email method is tracked separately from its login aliases.
Existing metadata using `rownd_email_recipe_user_id` remains
supported; new updates also maintain the tenant-scoped `rownd_email_recipe_user_ids`
map. Guard mode permits the verified canonical Passwordless email and blocks every
retained noncanonical alias during create, resend, and consume, even when an old alias
is unverified. Synchronous migration retains old methods and publishes the tenant
canonical pointer with migration-completion metadata only after durable verification.

Successful profile or field updates that start verification return
`email_verification_pending: true`. Until verification completes, the returned profile
continues to expose the current canonical email.

Native clients using `rowndDisplayContext: "mobile_app"` must send
`rowndNativeEmailVerification: true` in the request `context`. Older clients receive
HTTP 426 before metadata or email-delivery side effects. Only validated display,
client-domain, and native-capability values are propagated; request-provided redirect
paths are ignored. This applies to both `PUT /plugin/rownd/user` and
`PUT /plugin/rownd/user/field`.

Pending email-change links retain the raw SuperTokens `token` and add
`rowndPendingVerificationId`. Custom email delivery must preserve both parameters.
The marker selects the profile-change flow and requires the initiating session.
Unmarked verification remains ordinary SuperTokens verification and is
session-optional; removing the marker can therefore consume the raw token without
completing the credential change. Concurrent duplicate consumption allows at most
one completion within the behavior covered by the current Core calls; without metadata
compare-and-swap this is not a cross-process guarantee. Failed completion and
replacement-session creation are compensated; rollback failures require account
reconciliation.

### Passwordless Confirmation Bypass

Use `create_magic_link_with_confirmation_bypass` when your backend needs to create a passwordless magic link that can be opened on a different device without showing the SuperTokens cross-device confirmation prompt.
This is intended for trusted server-side flows only.

First, configure the exact post-login paths that may use the bypass:

```python
from supertokens_rownd import RowndPluginConfig

rownd_plugin_config = RowndPluginConfig(
    rownd_app_key="rownd_app_key",
    rownd_app_secret="rownd_app_secret",
    api_base_path="/auth",
    api_domain="https://api.example.com",
    website_domain="https://example.com",
    client_domains={"browser": "https://app.example.com"},
    cross_device_confirmation_bypass={
        "allowed_redirect_paths": ["/profile", "/settings/security"],
    },
)
```

Then call the helper from your backend after SuperTokens has been initialized with the Rownd plugin:

```python
from supertokens_rownd import create_magic_link_with_confirmation_bypass

magic_link = await create_magic_link_with_confirmation_bypass(
    email="user@example.com",
    client_domain="browser",
    redirect_to_path="/profile",
    display_context="browser",
)
```

`redirect_to_path` is required and must match `cross_device_confirmation_bypass.allowed_redirect_paths` exactly after normalization. Absolute URLs are accepted only when their origin matches the resolved `client_domain`; they are normalized back to a relative path before being added to the magic link.

`client_domain` must be a configured `client_domains` key, not a raw domain. Omit it to use `website_domain`.

Pass exactly one of `email` or `phone_number`. The helper returns the rewritten magic link with `bypassDeviceConfirmation=true`. In retirement guard mode, email helper calls enforce canonical credential state; phone helper calls remain unchanged.

Before skipping the cross-device confirmation prompt, the frontend should validate the callback against the plugin:

- **POST** `/plugin/passwordless-cross-device-confirmation/validate`
- **Body**: `{ "clientDomain": "browser", "redirectToPath": "/profile", "appVariantId": "optional_variant" }`
- **Success response**: `{ "status": "OK", "bypass": true }`

If validation fails, the frontend should show the normal cross-device confirmation prompt.

Apple sign-in methods may include SuperTokens client type mapping fields:

```python
"signInMethods": [
    {
        "method": "apple",
        "clientId": "com.example.service",
        "webClientType": "web",
        "iosClientType": "ios",
        "androidClientType": "android",
    }
]
```

See [OAUTH_MIGRATION_TUTORIAL.md](./OAUTH_MIGRATION_TUTORIAL.md) for OAuth/OIDC client migration steps.

## Notes

The Python SDK plugin API does not currently pass `app_info` into plugin route construction. Configure `api_base_path`, `api_domain`, `website_domain`, and `app_name` on the Rownd plugin so it can register routes and rewrite Rownd hub links consistently.

`api_base_path` must match `InputAppInfo.api_base_path`. If these differ, Rownd plugin routes are mounted at the Rownd plugin value, not the SuperTokens app value.

`api_domain` should match `InputAppInfo.api_domain`. This value is added to rewritten Rownd hub links so browser and mobile flows can call back to the correct API domain.

`website_domain` should match `InputAppInfo.website_domain`. It is required when `create_magic_link_with_confirmation_bypass` is called without `client_domain`.

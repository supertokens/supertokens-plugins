# SuperTokens Rownd User Migration Plugin

This plugin facilitates the migration of users and sessions from Rownd to SuperTokens.

## Installation

```bash
npm install @supertokens-plugins/rownd-nodejs
```

## Quick Start

### Backend Configuration

Initialize the plugin in your SuperTokens backend configuration.

> [!IMPORTANT]
> This plugin always requires the `Session` and `UserMetadata` recipes. Enable `Passwordless` for email/phone, `ThirdParty` for Google/Apple/guest/anonymous users, and `EmailVerification` for verified email profile updates. `AccountLinking` is required for email changes and whenever migrated Rownd users may have multiple supported login methods.

```typescript
import SuperTokens from "supertokens-node";
import Session from "supertokens-node/recipe/session";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import RowndMigrationPlugin from "@supertokens-plugins/rownd-nodejs";

SuperTokens.init({
  appInfo: {
    // your app info
  },
  recipeList: [
    Session.init(),
    UserMetadata.init(),
    // your other recipes
  ],
  experimental: {
    plugins: [
      RowndMigrationPlugin.init({
        rowndAppKey: process.env.ROWND_APP_KEY,
        rowndAppSecret: process.env.ROWND_APP_SECRET,
        enableDebugLogs: process.env.ENABLE_DEBUG_LOGS === "true",
      }),
    ],
  },
});
```

### Disabling Rownd User Migration

After migration is complete, disable Rownd user and session migration to run
the compatibility endpoints without Rownd credentials:

```typescript
RowndMigrationPlugin.init({
  disableRowndUserMigration: true,
});
```

This prevents the Rownd API client and the `/plugin/rownd/migrate` and
`/plugin/migrate-session` routes from being initialized. Other compatibility
endpoints remain enabled. Passwordless and email-verification links continue to
use the Rownd Hub with an internal dummy app key when `rowndAppKey` is omitted.
The plugin logs a warning during initialization while migration is disabled.

Without `disableRowndUserMigration: true`, both `rowndAppKey` and
`rowndAppSecret` are required.

### Tenant-Specific Configuration

Use `resolveConfig` when Rownd app configuration differs by SuperTokens tenant.
The resolver runs once per logical operation. `tenantId` and `request` are
optional because SDK function calls do not always originate from an HTTP route;
`userContext` is always provided. It may return `clientDomains`,
`crossDeviceConfirmationBypass`, `schema`, `appConfig`, `subBrands`, or
`emailChange`.

```typescript
RowndMigrationPlugin.init({
  disableRowndUserMigration: true,
  resolveConfig: async ({ tenantId }) => {
    const config = await loadTenantConfiguration(tenantId);
    return {
      appConfig: config.appConfig,
      schema: config.schema,
      subBrands: config.subBrands,
    };
  },
});
```

`rowndAppKey`, `rowndAppSecret`, `disableRowndUserMigration`, debug logging,
and telemetry remain startup-static. Resolver failures and malformed results
fail the operation instead of falling back to another tenant. The plugin keeps
the resolved snapshot tenant-bound and does not place static credentials in the
downstream user context. An authoritative non-public tenant supplied by a
recipe or session takes precedence over the request query; a conflicting
non-public `tenantId` query is rejected. Public or tenantless plugin operations
may use the query as their explicit tenant.

Each returned top-level field replaces its static counterpart for that
operation. Omitted fields fall back to the corresponding top-level static
value; objects are not deep-merged with that static value. Setting
`disableRowndUserMigration` in resolver output is unsupported: when it is true
at startup, migration routes and credentials remain disabled for every tenant.

### Email Changes

When email sign-in is configured, changing the Rownd profile email starts a
verified passwordless email change for the initiating tenant. After
verification, the plugin creates a new passwordless method or reuses one already
linked to the same primary user in that tenant, then makes it the canonical
Rownd profile email. It removes replaced Passwordless email methods from the
initiating tenant. Methods also associated with another tenant remain available
there. Phone, third-party, and email-password methods are not modified. For
updates, the canonical Passwordless method acts as the EmailVerification
subject. For third-party-only accounts, the initiating third-party method acts
as the subject because the new Passwordless recipe user does not exist until
proof succeeds.

Email changes for established accounts require a database-checked native
SuperTokens session created within the last ten minutes by default. Normal
session refresh does not reset this window. Guest and instant accounts must use
a supported sign-up flow instead. The target email is rejected when it belongs
to another account; the plugin never merges accounts as a side effect of a
profile edit. Profile metadata is account-wide. A new passwordless method is
associated only with the tenant that initiated the change; an existing method
retains its current tenant associations.

```typescript
RowndMigrationPlugin.init({
  rowndAppKey: process.env.ROWND_APP_KEY,
  rowndAppSecret: process.env.ROWND_APP_SECRET,
  appConfig: {
    signInMethods: [{ method: "email" }],
  },
  emailChange: {
    maxSessionAgeSeconds: 600,
  },
});
```

If the active app or sub-brand `signInMethods` does not enable email, profile
email updates are rejected rather than creating a hidden authentication method.
`Passwordless`, `EmailVerification`, and `AccountLinking` must be initialized
when email changes are enabled, and Passwordless must use `EMAIL` or
`EMAIL_OR_PHONE` as its contact method.

Previous Passwordless emails stop being login aliases in the initiating tenant
after verification. The replacement session uses the surviving canonical
Passwordless method. A pending change remains usable only while its underlying
SuperTokens verification token, pending metadata, and initiating session remain
valid. Starting another change revokes the previous pending token. Email
ownership is checked across every SuperTokens tenant both when the change starts
and when verification completes. Accounts with multiple Passwordless methods
must have a valid tenant-scoped `rownd_email_recipe_user_ids` canonical marker.
The legacy `rownd_email_recipe_user_id` marker remains available for metadata
compatibility. Accounts with
only real third-party methods can add a Passwordless method; guest and instant
methods cannot. Phone-only Passwordless methods are supported, and adding an
email preserves the phone method. Verification must use the same active session
that started the change. Completion revokes every account session and returns a
replacement for that initiating session.

Completion creates and links the verified target method, then publishes it as
canonical together with a `COMMITTING` cleanup plan. Once replaced-email cleanup
starts, failures roll forward: the target method is retained, all sessions are
revoked, and `COMMITTING` metadata retains `retiredMethods` entries containing
`{ recipeUserId, email }` for reconciliation. A later authenticated profile-email
update retries that idempotent cleanup. Successful cleanup removes the
`COMMITTING` state; no permanent tombstone remains. Already removed or
disassociated methods are treated as complete. Invalid reconciliation state
fails closed without deleting methods. Replacement-session failure does not
restore removed login aliases.

When `auth.useExplicitSignUpFlow` is enabled, a valid `intent: "sign_in" |
"sign_up"` on Passwordless create-code, resend-code, and consume-code HTTP
requests opts into explicit behavior. The plugin carries validated intent through
`userContext` and adds it to generated magic links as `rowndAuthIntent`. Omitting
`intent` preserves legacy combined sign-in/up behavior; a supplied malformed
value returns `GENERAL_ERROR`. Explicit canonical email pointers restrict sign-in
to the selected method in that tenant. Without an explicit pointer or retirement
plan, a historical `original_rownd_user.data.email` preference does not prevent
sign-in through another verified Passwordless email already attached to the same
user in that tenant. Ambiguous contacts without a usable preference still fail
closed. A retired old email returns `SIGN_IN_UP_NOT_ALLOWED` with reason
`No existing account found` before a code is sent. Explicit `sign_up` may reuse
that email after cleanup succeeds. `rowndAuthIntent` is propagation metadata, not
cryptographic proof or authorization. This policy is implemented only by the
plugin's HTTP overrides; direct Passwordless SDK calls bypass it.
Canonical email metadata is considered during account lookup and automatic
linking, so a stale email retained by Apple or another provider cannot restore a
replaced Passwordless email.

Successful update responses that start verification include
`email_verification_pending: true`. The returned profile continues to contain
the current canonical email until verification completes.

Native clients using `rowndDisplayContext: "mobile_app"` must also send
`rowndNativeEmailVerification: true` in the validated `context` object for
`PUT /plugin/rownd/user` and `PUT /plugin/rownd/user/field` email changes. Older
clients receive HTTP 426 before pending metadata is created or verification
email is sent. Browser requests do not require this flag. It is capability and
routing metadata only; session, recent-authentication, email ownership, and
verification checks remain authoritative.

Pending email-change links preserve the raw SuperTokens verification token.
Custom email-delivery overrides must preserve all existing query parameters, including
`token`, `rowndPendingVerificationId`, `apiDomain`, `apiBasePath`, `tenantId`
when present, and Hub bootstrap parameters. The pending marker selects the
email-change flow; without it, verification remains an ordinary SuperTokens
verification and does not change the Passwordless login method. Removing the
marker can consume the raw token without completing the credential change. This
denial-of-service case is accepted: the plugin intentionally does not classify
or wrap Core tokens, and each pending link carries exactly one raw `token` value.
Native clients require the API parameters to match their trusted SuperTokens
configuration before providing a session token.

SuperTokens atomically consumes its verification token, but user-metadata
updates are read/modify/write operations without compare-and-swap. Concurrent
profile writes can still overwrite pending-operation metadata. A process crash
between Core token consumption and terminal cleanup can leave stale pending
metadata until it is repaired. Terminal operations attempt to remove their
pending record. Durable `COMMITTING` cleanup failures are retried by the next
authenticated profile-email update; malformed state still requires operator
reconciliation.

### Session Claim Fields

Schema fields can be copied into the SuperTokens access-token payload by setting `include_in_session_claims: true`. Use `session_claim_name` when the claim name should differ from the Rownd data field name.

```typescript
RowndMigrationPlugin.init({
  rowndAppKey: process.env.ROWND_APP_KEY,
  rowndAppSecret: process.env.ROWND_APP_SECRET,
  schema: {
    employee_id: {
      display_name: "Employee ID",
      type: "string",
      user_visible: false,
      include_in_session_claims: true,
      session_claim_name: "employee_id_claim",
    },
  },
});
```

### Client Link Domains

Set `clientDomains` to rewrite account links to different frontend URL bases. Values must be absolute URL bases, including custom schemes for native deep links. The plugin selects `mobile` for `mobile_app` display context and `browser` otherwise. Consumers can pass `rownd_client_domain` to select any custom key.

```typescript
RowndMigrationPlugin.init({
  rowndAppKey: process.env.ROWND_APP_KEY,
  rowndAppSecret: process.env.ROWND_APP_SECRET,
  clientDomains: {
    browser: "https://app.example.com",
    mobile: "customDomain://",
    browser_local: "http://localhost:3000",
  },
});
```

### Same-device Passwordless Hub Policy

```typescript
RowndMigrationPlugin.init({
  rowndAppKey: process.env.ROWND_APP_KEY,
  rowndAppSecret: process.env.ROWND_APP_SECRET,
  appConfig: {
    auth: {
      enforceSameDevicePasswordlessSignIn: true,
    },
  },
});
```

This is a supported Hub UI policy scoped by the Hub to passwordless flows originating from `mobile_app`. It is not server-side device binding.

### Passwordless Confirmation Bypass

Use `createMagicLinkWithConfirmationBypass` when your backend needs to create a passwordless magic link that can be opened on a different device without showing the SuperTokens cross-device confirmation prompt.
This is intended for trusted server-side flows only.

First, configure the exact post-login paths that may use the bypass:

```typescript
const rowndPluginConfig = {
  rowndAppKey: process.env.ROWND_APP_KEY,
  rowndAppSecret: process.env.ROWND_APP_SECRET,
  clientDomains: {
    browser: "https://app.example.com",
  },
  crossDeviceConfirmationBypass: {
    allowedRedirectPaths: ["/profile", "/settings/security"],
  },
};

const superTokensConfig = {
  // your app info and recipe list
  experimental: {
    plugins: [RowndMigrationPlugin.init(rowndPluginConfig)],
  },
};

SuperTokens.init(superTokensConfig);
```

Then call the helper from your backend:

```typescript
import { createMagicLinkWithConfirmationBypass } from "@supertokens-plugins/rownd-nodejs";

const magicLink = await createMagicLinkWithConfirmationBypass({
  email: "user@example.com",
  tenantId: "tenant-a",
  clientDomain: "browser",
  redirectToPath: "/profile",
  displayContext: "browser",
});
```

`redirectToPath` is required and must match `crossDeviceConfirmationBypass.allowedRedirectPaths` exactly after normalization. Absolute URLs are accepted only when their origin matches the resolved `clientDomain`; they are normalized back to a relative path before being added to the magic link.

`clientDomain` must be a configured `clientDomains` key, not a raw domain. Omit it to use the SuperTokens website domain.

Pass exactly one of `email` or `phoneNumber`. `tenantId` defaults to `public`. The helper returns the rewritten magic link with `bypassDeviceConfirmation=true`.

Before skipping the cross-device confirmation prompt, the frontend should validate the callback against the plugin. Routes are mounted under your SuperTokens `apiBasePath`, which defaults to `/auth`.

- **POST** `{apiBasePath}/plugin/passwordless-cross-device-confirmation/validate`
- **Default**: `POST /auth/plugin/passwordless-cross-device-confirmation/validate`
- **Body**: `{ "clientDomain": "browser", "redirectToPath": "/profile", "appVariantId": "optional_variant" }`
- **Success response**: `{ "status": "OK", "bypass": true }`

If validation fails, the frontend should show the normal cross-device confirmation prompt.

## API Endpoints

Routes are mounted under your SuperTokens `apiBasePath`, which defaults to `/auth`. The migration endpoint is the main Rownd-to-SuperTokens session handoff endpoint; the plugin also exposes Rownd-compatible app config, guest, user, metadata, field, and sign-out endpoints under `{apiBasePath}/plugin/rownd/...`.

Unauthenticated migration and guest routes accept an optional `tenantId` query parameter. It defaults to `public`. SuperTokens Core validates the tenant when the operation runs. Authenticated identity-field and sign-out operations use the tenant from the current session; custom Rownd metadata remains global to the SuperTokens user.

> [!IMPORTANT]
> Rownd users with multiple supported login methods are rejected unless SuperTokens account linking is enabled in the target environment.

### Migrate

- **POST** `{apiBasePath}/plugin/rownd/migrate`
- **Default**: `POST /auth/plugin/rownd/migrate`
- **Non-public tenant**: `POST /auth/plugin/rownd/migrate?tenantId=tenant-a`
- **Headers**: `Authorization: Bearer <Rownd_JWT>`. Header-token clients should also send `rid: session`, `fdi-version: 1.18`, and `st-auth-mode: header`.
- **Description**: Validates the Rownd JWT, imports new users with their Rownd profile data, ensures the selected login method is associated with the requested SuperTokens tenant, and then creates a new SuperTokens session in that tenant. Header-token clients must receive `st-access-token`, `st-refresh-token`, and `front-token` response headers.
- **Identity reconciliation**: Rownd passwordless identifiers are authoritative during migration. When an exact third-party identity and an existing Passwordless email belong to separate users, the plugin links the Passwordless method only if Rownd verifies that email, its owner is not already primary, and it is not mapped to another Rownd user. `verified_data.email` must be `true` or match `data.email` case-insensitively. Other ownership conflicts still fail migration.
- **Provider changes**: Google and Apple identities prefer a non-empty string in `verified_data.google_id` or `verified_data.apple_id`, falling back to the corresponding `data` field. Reconciliation links a changed identity to the same SuperTokens account before retiring obsolete methods proven by the migration snapshot. Retirement removes access only in the requested tenant, preserves the primary account and other tenants, and can resume after interruption. An identity owned by a conflicting primary account still fails migration.
- **Reconciliation recovery**: If the final account or login-method check fails, the plugin makes one fresh verification attempt against the same internal account, revalidating the Rownd source and external mapping. Unresolved ownership, tenant, method, or verification failures still fail migration. Reconciliation publishes its completion marker only after the required checks and email reconciliation succeed; that marker does not prove session creation succeeded.

### Guest

- **POST** `{apiBasePath}/plugin/rownd/guest`
- **Default**: `POST /auth/plugin/rownd/guest`
- **Non-public tenant**: `POST /auth/plugin/rownd/guest?tenantId=tenant-a`
- **Description**: Creates a guest or instant user and session in the requested tenant.

## Debug Logging

Set `enableDebugLogs: true` in the plugin config to enable debug logging.

## Telemetry

Telemetry is optional. If `telemetry` is omitted from the plugin config, no telemetry is emitted.

The plugin emits exactly one telemetry event per `/migrate` call result.

### Event shape

Each event includes endpoint outcome data only (not step-by-step events), including:

- `outcome`: `success` or `error`
- `durationMs`
- `tenantId` (when available)
- `rowndUserId` (when available)
- `superTokensUserId` (when available)
- for errors: `error.message` and `error.name`

> [!NOTE]
> Telemetry failures never fail migration endpoints. Errors in telemetry reporting are swallowed.

### Provider: OpenTelemetry

```typescript
RowndMigrationPlugin.init({
  rowndAppKey: process.env.ROWND_APP_KEY,
  rowndAppSecret: process.env.ROWND_APP_SECRET,
  telemetry: {
    provider: "opentelemetry",
  },
});
```

> [!IMPORTANT]
> This plugin uses `@opentelemetry/api` only. You still need to initialize OpenTelemetry SDK/exporters in your app for spans to be exported.

### Provider: Axiom

```typescript
RowndMigrationPlugin.init({
  rowndAppKey: process.env.ROWND_APP_KEY,
  rowndAppSecret: process.env.ROWND_APP_SECRET,
  telemetry: {
    provider: "axiom",
    token: process.env.AXIOM_TOKEN!,
    dataset: process.env.AXIOM_DATASET!,
    // optional, defaults to https://api.axiom.co/v1/datasets
    // url: "https://api.axiom.co/v1/datasets",
  },
});
```

### Provider: Custom

```typescript
RowndMigrationPlugin.init({
  rowndAppKey: process.env.ROWND_APP_KEY,
  rowndAppSecret: process.env.ROWND_APP_SECRET,
  telemetry: {
    provider: "custom",
    factory: () => ({
      recordEvent: async (event) => {
        // send to your telemetry backend
      },
    }),
  },
});
```

## Bulk Import Script

The package includes a bulk migration script for importing Rownd users into SuperTokens.

Set `supertokens.tenantId` in the generated configuration to associate every imported login method with a non-public tenant. It defaults to `public` when omitted. Resuming from a checkpoint with a different tenant is rejected.

The script runs from a YAML config file generated from the included template.

### Usage

1. Generate a local config file.
2. Edit the config with your Rownd and SuperTokens credentials.
3. Run the migration.

```bash
npx rownd-nodejs init-config --output ./rownd-bulk-migrate.yaml
npx rownd-nodejs bulk-migrate --config ./rownd-bulk-migrate.yaml
```

For repo-local development, use `npm run cli -- bulk-migrate --config ./rownd-bulk-migrate.yaml` from `packages/rownd-nodejs`.

The script:

- fetches users from Rownd page by page
- validates the Rownd payload shape with `zod`
- maps users with `mapRowndUserToSuperTokens`
- imports them into SuperTokens in bounded batches
- writes a checkpoint file so the run can resume later

### Config File

All runtime config is read from the YAML file passed with `--config`.
There is no environment variable parsing.

## Administrative user reconciliation

After initializing SuperTokens with the Rownd plugin, server code can reconcile a
single user without a Rownd JWT or a session:

```ts
import { reconcileUser } from "@supertokens-plugins/rownd-nodejs";

const result = await reconcileUser({
  rownd_user_id: "rownd-user-id",
  tenantId: "public",
  userContext: {},
});
// Alternatively: reconcileUser({ email: "user@example.com" })
// Or: reconcileUser({ supertokens_user_id: "internal-external-or-recipe-id" })
```

Exactly one selector is required, enforced by TypeScript and at runtime. Tenant
defaults to `public`; the operation resolves the initialized dynamic plugin
configuration for that tenant and user context. The API uses the initialized
Rownd client and Core connection; it never reads local CLI profiles.

`OK` includes `changed`, observed `actions`, `rownd_user_id`, the actual internal
`supertokens_user_id`, and `recipe_user_ids`. Other outcomes are `NOT_FOUND`,
`AMBIGUOUS` (with source/owner candidates), `BLOCKED`, or `ERROR`. Failures after
reconciliation starts include `partialProgress`: mutations may already have
completed, and retrying resumes the existing repair/retirement machinery.
`changed` and `actions` describe observed account, mapping and metadata changes;
they are not a transaction log of transient writes or session revocations.
`changed` is `null` when final observation fails, or when reconciliation selects
an existing owner without a before snapshot. The latter can occur with `OK` and
empty `actions`; it does not mean nothing changed. Observation failures include
`observationError`, preserving any original reconciliation error.

`rownd_user_id` identifies the canonical source selected for reconciliation.
`requested_rownd_user_id` retains an explicit original Rownd selector. When
activity-based election chooses among competing sources, `election` includes
the candidate IDs, normalized activity timestamps, and
`basis: "latest_valid_activity"`. An explicit SuperTokens selector is retained
as `requested_supertokens_user_id`; if election requires a different internal
owner, that request returns `BLOCKED` rather than switching its target.
When duplicate-owner consolidation cannot finish, `unresolved_owners` identifies
the owners requiring further reconciliation. A healthy canonical winner alone
does not satisfy consolidation postconditions.

### CLI profiles and reconciliation

```sh
rownd-nodejs profiles add --profile stardust
rownd-nodejs profiles list
rownd-nodejs profiles show --profile stardust
rownd-nodejs reconcile-user --profile stardust --rownd-user-id ROWND_USER_ID
rownd-nodejs reconcile-user --profile stardust --rownd-user-id ROWND_USER_ID --dry-run
rownd-nodejs reconcile-user --profile stardust --email user@example.com
rownd-nodejs reconcile-user --profile stardust --supertokens-user-id SUPERTOKENS_ID
rownd-nodejs profiles remove --profile stardust
```

`profiles add` prompts for Rownd app ID, app key, app secret, SuperTokens connection
URI, optional Core API key, and tenant ID (default `public`). App keys, secrets,
API keys, and the connection URI are masked during entry, keeping credentials out
of command arguments and shell history. Ctrl-C cancels without saving a profile.
For noninteractive use, explicitly supply `--app-id`, `--app-key`, `--app-secret`,
and `--connection-uri`, with optional `--api-key` and `--tenant-id`. The singular
`profile` command and positional profile names remain supported aliases.
Connection URIs must use HTTP(S) without embedded username/password credentials;
use the separate Core API key field for authentication.

Profiles live at `~/.config/rownd-nodejs/profiles.json`, independently of any other
package. The directory is owner-only (`0700`), the file is owner-only (`0600`),
and updates use an atomic rename. Profile output masks app keys, app secrets,
Core API keys and URI credentials. Reconciliation prints a structured JSON result
with credential redaction and sanitized diagnostics; non-allowlisted messages
become generic explanations. Execution exits zero for `OK`; dry run exits zero
for `PREVIEW` with `canReconcile: true`. Other results exit nonzero.
Argument, profile, or initialization failures instead print an error to stderr
and exit nonzero. Commands are bundled in the package;
from the package directory use `npm run cli -- reconcile-user ...`.

### Dry run

Pass `--dry-run` to the CLI or `dryRun: true` to the API with any selector:

```ts
const preview = await reconcileUser({
  rownd_user_id: "rownd-user-id",
  tenantId: "public",
  dryRun: true,
});
```

Dry run inspects live Rownd and SuperTokens state without importing, linking,
changing mappings or metadata, verifying emails, or revoking sessions. It is
disabled by default.

Dry-run results include `dryRun: true`, `changed: false`, `actions: []` and
`snapshotOnly: true`. Proposed changes are returned separately:

- `proposedActions`: candidate repairs based on the inspected state.
- `missingMethods`: expected identities absent from the selected owner.
- `matchesSource`: whether the inspected account satisfies the source checks.
- `canReconcile`: whether inspection can establish that reconciliation may
  proceed without unresolved blockers or execution-time proof requirements.
- `blockers` and `requiresExecutionProof`: conflicts or checks that inspection
  cannot resolve. Conditional retirement and checkpoint recovery can require
  execution-time proof, so `canReconcile: false` does not always mean execution
  will fail.

Successful inspection returns `PREVIEW`; known failures retain `BLOCKED`,
`AMBIGUOUS`, `NOT_FOUND` or `ERROR`. A preview is a snapshot, not authorization or
a guarantee of later execution. Run again without `dryRun` to apply repairs;
execution revalidates live state.

### Reconcile a CSV

Use `reconcile-csv` to reconcile every unique Rownd ID in a CSV using one profile:

```sh
bun packages/rownd-nodejs/scripts/adminCli.ts reconcile-csv \
  --profile stardust --file ./users.csv \
  --concurrency 5 --failed-file ./failed.csv --dry-run
```

From a global installation, use `rownd-nodejs reconcile-csv` with the same flags.
Remove `--dry-run` to apply repairs. The default ID column is `rownd_user_id`:

```csv
rownd_user_id,email
user_123,first@example.com
user_456,second@example.com
```

For a different header, pass `--id-column "Rownd ID"`. Only that column selects
users; other CSV fields do not supply identity or verification evidence. The
file must have a header. Quoted fields, embedded commas/newlines, UTF-8 BOM and
CRLF are supported. Blank lines are ignored, surrounding ID whitespace is
trimmed, and repeated IDs are processed once in first-seen order.

The whole CSV is validated before clients are initialized or repairs begin.
Missing IDs, inconsistent columns and malformed quoting reject the file.
Reconciliation continues after individual failures. `--concurrency N` bounds
the number of users processed at once (default `1`).
Output is JSON Lines: a `type: "result"` record for each unique ID (with its
sanitized reconciliation `result`), followed by a `type: "summary"` record with
`total`, `duplicatesSkipped`, `succeeded`, `failed`, and `statuses` counts.
Results arrive in completion order; `index` retains the original one-based
position among unique IDs. Results preserve the canonical `rownd_user_id` even
when election redirects an older input ID. `requested_rownd_user_id` identifies
that original input, and the failure file always records the original input ID.

Progress is logged to stderr at startup, every second, and when processing
finishes. It shows completed/total unique IDs, percentage, active reconciliation
calls, successes/failures, average users per second since startup, elapsed time
and estimated time remaining. Throughput counts all completed results, including
failures. ETA is unknown until the first user finishes and is only an estimate. A
`complete` progress line means processing finished; the summary and exit code
still indicate whether any users failed. JSON Lines remain on stdout, so results
can be redirected while progress stays visible:

```sh
bun packages/rownd-nodejs/scripts/adminCli.ts reconcile-csv \
  --profile stardust --file ./users.csv --concurrency 5 > results.jsonl
```

With `--failed-file`, unsuccessful IDs are saved as they finish to a CSV with a
`rownd_user_id` header. This includes blocked/ambiguous/not-found/error results
and previews with `canReconcile: false`. The output must be a new file in an
existing directory; existing files are never overwritten. It is owner-only
(`0600`) and contains only the header if every user succeeds. Dry run still
writes this requested local report while leaving authentication state unchanged.
If saving fails, new work stops and in-flight users finish before the command
exits nonzero. Without `--failed-file`, results are only printed.

Retry saved IDs with the same command, using a new output file:

```sh
bun packages/rownd-nodejs/scripts/adminCli.ts reconcile-csv \
  --profile stardust --file ./failed.csv \
  --concurrency 5 --failed-file ./failed-retry.csv
```

The command exits zero only if every unique ID returns `OK`, or every dry-run
preview returns `PREVIEW` with `canReconcile: true`. Batch execution is not
atomic: completed repairs remain if another user fails or the command is
interrupted. Results are emitted as each user finishes.

### Reconciliation boundaries

- **Live Rownd is the reference.** Stored migration snapshots identify a source
  and support retirement evidence; they do not override its current profile.
  Provider IDs use `verified_data` first, then `data`.
- Email selection searches SuperTokens in the selected tenant, then resolves
  Rownd IDs from mappings and migration metadata. There is no Rownd email search.
  Results are deduplicated by actual internal owner. Competing live Rownd sources
  sharing the relevant identity are compared using the most recent valid timestamp
  across `meta.last_sign_in` and `meta.last_active`. A unique most-recent source
  wins; an explicit Rownd selector does not make an older source win. Ties or
  insufficient activity evidence leave the sources ambiguous. Activity does not
  authorize merging unrelated identities or bypass ownership safeguards.
  Election alone is not a completed repair: eligible losing owners must join the
  canonical owner, and their existing IDs must resolve to the shared account.
  Unsupported consolidation returns `BLOCKED` even if the winner already has all
  its expected methods. Dry run includes the required account-linking work.
  Supported consolidation promotes the winner's existing account and links
  eligible standalone donor recipes. Existing recipe IDs and their Rownd aliases
  are retained so old and new IDs resolve to the shared primary account. A losing
  method is not deleted simply because it is absent from the winner's current
  profile. Checkpoints allow interrupted linking to resume, and incomplete
  consolidation blocks both migration and native sign-in sessions. Session
  creation checks consolidation before and after issuance; a failed post-check
  revokes the new session before returning credentials. A required Rownd source
  disappearing during recovery leaves the operation blocked rather than dropping
  that owner from the repair.
  No discoverable Rownd source for an email or
  SuperTokens selector returns `BLOCKED`; a resolved Rownd source absent from
  live lookup returns `NOT_FOUND`.
- An explicit Rownd ID can import an absent user, add missing methods, link
  eligible related standalone accounts, repair external mappings, and retire
  supported replaced providers through the existing reconciliation engine.
  Internal primary IDs remain stable: “updating user IDs” means changing the
  external Rownd mapping, not recreating the primary account.
- Server-fetched authorization is separate from JWT authorization. Administrative
  contact ownership uses the live Rownd `data.email`, including when
  `verified_data.email` is absent. This can authorize linking an eligible
  standalone email method, but does not make that email verified. Email
  verification still requires `verified_data.email === true` or a string matching
  the current email case-insensitively. Arbitrary mapped imports and caller flags
  cannot supply server-fetched proof. Evidence is revalidated before mutations.
  Independently anchored phone donors may also be eligible; a shared phone number
  alone is not authority to merge accounts.
- Foreign primaries, conflicting mappings, stale evidence, and unsupported
  canonical/pending email transitions are not force-merged or overwritten.
  Native canonical choices remain protected. If that policy leaves any current
  Rownd method missing, the result is `BLOCKED` with the mismatch, never `OK`.
  Success checks **all** source methods, including methods skipped by native
  canonical policy, and verification of matching email methods. Even with all
  methods present, a canonical email conflicting with the currently verified
  Rownd email or a pending email-verification transition in the selected tenant
  returns `BLOCKED`. Existing token-login behavior is unchanged.

### Interpreting saved audit findings

Audit findings describe an extracted snapshot. Reconciliation fetches current
Rownd and SuperTokens state before deciding which changes are supported. An
owner is a primary SuperTokens account together with its linked login methods.

- **Missing methods and provider drift:** recipe-level, contact-level and
  provider-specific findings can describe the same missing identity. Match the
  recipe, exact contact or provider subject, and tenant. The saved audit discussed
  here used `data`-first provider precedence; reconciliation uses `verified_data`
  first. When both contain different subjects, they describe different expected
  identities.
- **Verification:** `CONTACT_VERIFICATION_PENDING`, `SOURCE_VERIFICATION_DRIFT`
  and `VERIFICATION_ALIAS_RESIDUE` can describe one existing method. Pending
  verification alone does not authorize verification. Alias residue concerns
  the verification record under the recipe's effective ID, not a missing method.
  Source verification drift means Rownd verifies the current email while a
  matching SuperTokens method is unverified, regardless of its recipe. Rownd
  evidence is `verified_data.email === true` or a string matching the current
  email case-insensitively.
- **Split ownership and linking candidates:** `CURRENT_CONTACT_ON_OTHER_OWNER`,
  email/phone owner splits, and `ACCOUNT_LINKING_CANDIDATE` can overlap. A shared
  contact is not sufficient proof to merge accounts. Multiple external aliases
  on one owner can be legitimate after linking.
- **Placeholders:** a Passwordless address ending in
  `@stfakeemail.supertokens.com` is an informational cleanup candidate. That suffix
  alone does not authorize deletion. Provider placeholder emails and real Apple
  relay addresses are not this Passwordless finding.
- **Coverage:** invalid activity timestamps, partial exports and incomplete
  extraction are evidence-quality findings. Absence from an export does not
  establish live absence or authorize account creation. Live tenant membership
  must be checked even when the selected tenant defaults to `public`.

Do not add overlapping rule counts to calculate distinct affected users.

The complete saved-audit code inventory, grouped for reference:

- **Source identity and quality:** `SOURCE_USER_NOT_RESOLVED`,
  `SOURCE_PAYLOAD_INVALID`, `SOURCE_ID_MISMATCH`, `SOURCE_ID_CONFLICT`.
- **Audit coverage:** `SOURCE_ACTIVITY_INVALID`, `SOURCE_EXPORT_PARTIAL`,
  `TARGET_EVIDENCE_INCOMPLETE`, `TARGET_MEMBERSHIP_EVIDENCE_INCOMPLETE`.
- **Mappings and account structure:** `MAPPING_TARGET_MISSING`,
  `EXTERNAL_ID_MAPPING_MISSING`, `EXTERNAL_ALIAS_AMBIGUOUS`,
  `OWNER_MEMBERSHIP_INCONSISTENT`, `MULTIPLE_EXTERNAL_IDENTITIES_ON_OWNER`.
- **Verification and placeholders:** `SYNTHETIC_PASSWORDLESS_METHOD`,
  `VERIFICATION_ALIAS_RESIDUE`, `SOURCE_VERIFICATION_DRIFT`,
  `CONTACT_VERIFICATION_PENDING`.
- **Missing methods:** `PASSWORDLESS_AUTH_METHOD_MISSING`,
  `THIRDPARTY_AUTH_METHOD_MISSING`, `PASSWORDLESS_EMAIL_MISSING`,
  `PASSWORDLESS_PHONE_MISSING`, `PROVIDER_METHOD_MISSING`,
  `APPLE_METHOD_MISSING`, `GOOGLE_METHOD_MISSING`.
- **Provider subject drift:** `APPLE_ID_MISMATCH`, `GOOGLE_ID_MISMATCH`.
- **Split ownership and linking:** `CURRENT_CONTACT_ON_OTHER_OWNER`,
  `EMAIL_OWNER_SPLIT`, `PHONE_OWNER_SPLIT`, `PROVIDER_IDENTITY_SPLIT`,
  `ACCOUNT_LINKING_CANDIDATE`.

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

Completion marks the pending operation `COMMITTING` before changing login
methods. Once replaced-email cleanup starts, failures roll forward: the target
method is retained, all sessions are revoked, and `COMMITTING` metadata remains
with the target and cleanup recipe-user IDs required for reconciliation. A later
authenticated profile-email update first retries that idempotent cleanup and
canonical finalization. Already removed or disassociated methods are treated as
complete. Invalid reconciliation state fails closed without deleting methods.
Replacement-session failure does not restore removed login aliases.

When `auth.useExplicitSignUpFlow` is enabled, Rownd Hub sends `intent` as
`sign_in` or `sign_up` in Passwordless create-code requests. An explicit
`sign_in` for an identifier with no tenant account returns
`SIGN_IN_UP_NOT_ALLOWED` with reason `No existing account found`. `sign_up` and
requests without an intent retain standard Passwordless behavior. Canonical
email metadata is considered during account lookup and automatic linking, so a
stale email retained by Apple or another provider cannot restore a replaced
Passwordless email.

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

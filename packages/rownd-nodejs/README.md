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
> This plugin always requires the `Session` and `UserMetadata` recipes. Enable `Passwordless` for email/phone, `ThirdParty` for Google/Apple/guest/anonymous users, `EmailVerification` for verified email profile updates, and `AccountLinking` when migrated Rownd users may have multiple supported login methods.

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
  clientDomain: "browser",
  redirectToPath: "/profile",
  displayContext: "browser",
});
```

`redirectToPath` is required and must match `crossDeviceConfirmationBypass.allowedRedirectPaths` exactly after normalization. Absolute URLs are accepted only when their origin matches the resolved `clientDomain`; they are normalized back to a relative path before being added to the magic link.

`clientDomain` must be a configured `clientDomains` key, not a raw domain. Omit it to use the SuperTokens website domain.

Pass exactly one of `email` or `phoneNumber`. The helper returns the rewritten magic link with `bypassDeviceConfirmation=true`.

Before skipping the cross-device confirmation prompt, the frontend should validate the callback against the plugin. Routes are mounted under your SuperTokens `apiBasePath`, which defaults to `/auth`.

- **POST** `{apiBasePath}/plugin/passwordless-cross-device-confirmation/validate`
- **Default**: `POST /auth/plugin/passwordless-cross-device-confirmation/validate`
- **Body**: `{ "clientDomain": "browser", "redirectToPath": "/profile", "appVariantId": "optional_variant" }`
- **Success response**: `{ "status": "OK", "bypass": true }`

If validation fails, the frontend should show the normal cross-device confirmation prompt.

## API Endpoints

Routes are mounted under your SuperTokens `apiBasePath`, which defaults to `/auth`. The migration endpoint is the main Rownd-to-SuperTokens session handoff endpoint; the plugin also exposes Rownd-compatible app config, guest, user, metadata, field, and sign-out endpoints under `{apiBasePath}/plugin/rownd/...`.

> [!IMPORTANT]
> The plugin always migrates users and sessions into the `public` tenant.
> Rownd users with multiple supported login methods are rejected unless SuperTokens account linking is enabled in the target environment.

### Migrate

- **POST** `{apiBasePath}/plugin/rownd/migrate`
- **Default**: `POST /auth/plugin/rownd/migrate`
- **Headers**: `Authorization: Bearer <Rownd_JWT>`. Header-token clients should also send `rid: session`, `fdi-version: 1.18`, and `st-auth-mode: header`.
- **Description**: Validates the Rownd JWT, ensures the user is migrated to SuperTokens in the `public` tenant, syncs Rownd user data to SuperTokens UserMetadata, and then creates a new SuperTokens session for that user. Header-token clients must receive `st-access-token`, `st-refresh-token`, and `front-token` response headers.

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

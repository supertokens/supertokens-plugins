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
> This plugin requires the `Session` and `UserMetadata` recipes to be initialized in your SuperTokens configuration.

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

## API Endpoints

The plugin exposes the following endpoints:

### Migrate User

- **POST** `/plugin/rownd/migrate-user`
- **Headers**: `Authorization: Bearer <Rownd_JWT>`
- **Body**:
  ```json
  {
    "tenantId": "public", // optional, defaults to public
    "userMetadata": { "key": "value" }, // optional, additional metadata to sync
    "roles": ["admin"] // optional, roles to assign to the user
  }
  ```
- **Description**: Validates the Rownd JWT, fetches user info from Rownd, and imports the user into SuperTokens. It also syncs Rownd user data and provided `userMetadata` to SuperTokens UserMetadata, and assigns the provided `roles`.

### Migrate Session

- **POST** `/plugin/rownd/migrate-session`
- **Headers**: `Authorization: Bearer <Rownd_JWT>`
- **Body**:
  ```json
  {
    "tenantId": "public" // optional, defaults to public
  }
  ```
- **Description**: Validates the Rownd JWT, ensures the user is migrated to SuperTokens, and creates a new SuperTokens session, attaching the necessary cookies to the response.

## Debug Logging

Set `enableDebugLogs: true` in the plugin config to enable debug logging.

## Telemetry

Telemetry is optional. If `telemetry` is omitted from the plugin config, no telemetry is emitted.

The plugin emits exactly one telemetry event per endpoint call result:

- `migrate-user` -> success or error event
- `migrate-session` -> success or error event

### Event shape

Each event includes endpoint outcome data only (not step-by-step events), including:

- `operation`: `migrate-user` or `migrate-session`
- `outcome`: `success` or `error`
- `durationMs`
- `tenantId` (when available)
- `rowndUserId` (when available)
- `superTokensUserId` (when available)
- `migrationState`: `already-migrated` or `imported-during-request` (when available)
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

## Requirements

- SuperTokens Node.js SDK >= 23.0.0
- `@rownd/node` >= 3.0.0

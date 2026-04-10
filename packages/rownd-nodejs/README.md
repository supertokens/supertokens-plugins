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
        telemetry: {
          token: process.env.AXIOM_TOKEN,
          dataset: process.env.AXIOM_DATASET,
        },
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

## Telemetry

If the `telemetry` configuration is provided, the plugin will send logs and error traces to your Axiom dataset.

## Requirements

- SuperTokens Node.js SDK >= 23.0.0
- `@rownd/node` >= 3.0.0
- `@axiomhq/js` >= 1.6.0 (for telemetry)

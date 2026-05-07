# On-the-Fly User Migration: Rownd → SuperTokens

This tutorial walks you through setting up the on-the-fly user migration process.
It will create new users in SuperTokens when they sign up using the Rownd SDKs.

## Overview

The migration flow works as follows:

1. **Backend**: SuperTokens plugin validates Rownd tokens and imports users on-demand
2. **Client**: Rownd SDK detects new sign-ups and triggers migration to SuperTokens
3. **Result**: User is created inside the SuperTokens Core instance

```
User signs in (Rownd) → Rownd SDK gets access token
       ↓
Rownd SDK does and authenticated POST to {apiDomain}/{apiBasePath}/plugin/rownd/migrate
       ↓
SuperTokens plugin validates token, imports user, validates session migration
```

---

## Part 1: Backend Setup (SuperTokens + Rownd Plugin)

### 1.1 Install the Plugin

```bash
npm install @supertokens-plugins/rownd-nodejs
```

### 1.2 Configure SuperTokens with the Plugin

Initialize SuperTokens with the Rownd migration plugin in your backend:

```typescript
import SuperTokens from "supertokens-node";
import Session from "supertokens-node/recipe/session";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import AccountLinking from "supertokens-node/recipe/accountlinking";
import RowndMigrationPlugin from "@supertokens-plugins/rownd-nodejs";

SuperTokens.init({
  appInfo: {
    appName: "APP_NAME",
    apiDomain: "<API_DOMAIN>",
    websiteDomain: "<WEBSITE_DOMAIN>",
    apiBasePath: "/auth",
  },
  recipeList: [Session.init(), UserMetadata.init(), AccountLinking.init()],
  experimental: {
    plugins: [
      RowndMigrationPlugin.init({
        rowndAppKey: "ROWND_APP_KEY",
        rowndAppSecret: "ROWND_APP_SECRET",
      }),
    ],
  },
});
```

###### How It Works (Backend)

When `POST /plugin/rownd/migrate` is called:

1. **Token Validation**: Plugin validates the Rownd access token via Rownd's API
2. **User Lookup**: Checks if user already exists in SuperTokens
3. **User Import**: If new, fetches user data from Rownd and imports via SuperTokens bulk-import API
4. **Session Migration**: Creates a SuperTokens session to confirm the session migration process
5. **Metadata Storage**: Original Rownd data is preserved in UserMetadata

---

## Part 2: Client App Configuration

Update your Rownd SDK configuration in order to enable the migration calls.
SDK calls are self-contained and do not throw errors if the migration request fails.

### 2.1 React

```tsx
import { RowndProvider } from "@rownd/react";

function App() {
  return (
    <RowndProvider
      appKey="your_rownd_app_key"
      supertokens={{
        appInfo: {
          appName: "<APP_NAME>",
          apiDomain: "<API_DOMAIN>",
          apiBasePath: "/auth",
        },
      }}
    >
      <YourApp />
    </RowndProvider>
  );
}
```

### 2.2 Android

```kotlin
import io.rownd.android.Rownd

Rownd.configure(this, "your_rownd_app_key")
Rownd.config.supertokens = SuperTokensConfig(
    appInfo = SuperTokensAppInfo(
        appName = "<APP_NAME>",
        apiDomain = "<API_DOMAIN>",
        apiBasePath = "/auth"
    )
)
```

### 2.3 iOS

```swift
import Rownd

Task {
    await Rownd.configure(appKey: "your_rownd_app_key")
}

Rownd.config.supertokens = SuperTokensConfig(
    appInfo: SuperTokensAppInfo(
        appName: "<APP_NAME>",
        apiDomain: "<API_DOMAIN>",
        apiBasePath: "/auth"
    )
)
```

---

## Advanced Configuration

### Telemetry

Track migration events with Axiom or OpenTelemetry:

```typescript
RowndMigrationPlugin.init({
  rowndAppKey: process.env.ROWND_APP_KEY,
  rowndAppSecret: process.env.ROWND_APP_SECRET,
  telemetry: {
    provider: "axiom",
    token: process.env.AXIOM_TOKEN,
    dataset: "rownd-migration",
  },
});
```

## Troubleshooting

| Issue                          | Solution                                                        |
| ------------------------------ | --------------------------------------------------------------- |
| `MISSING_AUTHORIZATION_HEADER` | Ensure client is sending Bearer token in `Authorization` header |
| `INVALID_TOKEN`                | Check Rownd app key/secret; verify token hasn't expired         |
| `ROWND_USER_NOT_FOUND`         | User may have been deleted from Rownd                           |
| Migration not triggering       | Verify `user_type` is `"new_user"`; check client config         |
| Session not created            | Ensure `Session` recipe is initialized in SuperTokens config    |

## Bulk Migration

The bulk migration script migrates all existing Rownd users from an app to SuperTokens.
It should be run after you have setup the on-the-fly migration flow in order to prevent missing new sign-ups between migrating the data and completely switching to SuperTokens.

### Prerequisites

- SuperTokens core instance credentials
- Rownd app credentials (app ID, app key, app secret)

### How to Run

Edit the config and the run `npm run bulk-migrate` from the `rownd-nodejs` folder.

### Configuration

Edit the `scripts/config.yaml` in the `@supertokens-plugins/rownd-nodejs` package:

```yaml
# Max users to process (omit for all users)
limit: 100

# Checkpointing to resume interrupted migrations
checkpoint:
  file: ./rownd-migration-checkpoint.json
  resume: false # Set to true to resume from checkpoint

# Retry logic for failed requests
retry:
  maxAttempts: 5
  initialDelayMs: 500

# Rownd API credentials
rownd:
  appId: app_xxx
  appKey: key_xxx
  appSecret: ras_xxx
  pageSize: 100 # Rownd API pagination size

# SuperTokens core connection
supertokens:
  connectionURI: https://your-supertokens-core.com
  apiKey: your-supertokens-api-key
  batchSize: 500 # Users per bulk import batch
```

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
Rownd SDK does an authenticated POST to {apiDomain}{apiBasePath}/plugin/rownd/migrate
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
import Passwordless from "supertokens-node/recipe/passwordless";
import ThirdParty from "supertokens-node/recipe/thirdparty";
import EmailVerification from "supertokens-node/recipe/emailverification";
import RowndMigrationPlugin from "@supertokens-plugins/rownd-nodejs";

SuperTokens.init({
  supertokens: {
    connectionURI: "<SUPERTOKENS_CONNECTION_URI>",
    apiKey: "<SUPERTOKENS_API_KEY>", // Optional
  },
  appInfo: {
    appName: "APP_NAME",
    apiDomain: "<API_DOMAIN>",
    websiteDomain: "<WEBSITE_DOMAIN>",
    apiBasePath: "/auth",
  },
  recipeList: [
    AccountLinking.init({
      shouldDoAutomaticAccountLinking: async () => ({
        shouldAutomaticallyLink: true,
        shouldRequireVerification: true,
      }),
    }),
    Session.init(),
    UserMetadata.init(),
    Passwordless.init({
      contactMethod: "EMAIL_OR_PHONE",
      flowType: "MAGIC_LINK",
    }),
    EmailVerification.init({
      mode: "OPTIONAL",
    }),
    ThirdParty.init({
      signInAndUpFeature: {
        providers: [
          {
            config: {
              thirdPartyId: "google",
              clients: [
                {
                  clientId: "<GOOGLE_CLIENT_ID>",
                  clientSecret: "<GOOGLE_CLIENT_SECRET>",
                },
              ],
            },
          },
          {
            config: {
              thirdPartyId: "apple",
              clients: [
                {
                  clientId: "<APPLE_CLIENT_ID>",
                  clientSecret: "<APPLE_CLIENT_SECRET>",
                },
              ],
            },
          },
        ],
      },
    }),
  ],
  experimental: {
    plugins: [
      RowndMigrationPlugin.init({
        rowndAppKey: process.env.ROWND_APP_KEY!,
        rowndAppSecret: process.env.ROWND_APP_SECRET!,
      }),
    ],
  },
});
```

A complete backend-only example is available in `packages/rownd-nodejs/example`.

###### How It Works (Backend)

When `POST {apiDomain}{apiBasePath}/plugin/rownd/migrate` is called, for example `POST /auth/plugin/rownd/migrate` when `apiBasePath` is `/auth`:

1. **Token Validation**: Plugin validates the Rownd access token via Rownd's API
2. **User Lookup**: Checks if user already exists in SuperTokens
3. **User Import**: If new, fetches user data from Rownd and imports via SuperTokens bulk-import API
4. **Session Migration**: Creates a SuperTokens session to confirm the session migration process
5. **Metadata Storage**: Original Rownd data is preserved in UserMetadata

`Session` and `UserMetadata` are required for migration. `ThirdParty` is required for Google, Apple, guest, and anonymous login methods. `Passwordless` is required for email and phone login methods. `EmailVerification` is required for verified email profile updates. `AccountLinking` should be initialized so migrated identities can link according to your account-linking policy. This plugin setup enables automatic linking with verification required so migrated Rownd identities can attach to matching verified SuperTokens users. Review trusted providers, verified identifiers, and guest upgrade flows before using the same policy in production.

Do not expose SuperTokens Core directly to the public internet. Use a Core API key for any shared or deployed instance, and store Rownd, OAuth, and Core credentials in environment variables or a secret manager.

For production, add rate limits and abuse protection around migration and guest session endpoints.

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

Edit the config and then run `npm run bulk-import` from the `rownd-nodejs` folder.

Do not commit `scripts/config.yaml` with real Rownd or SuperTokens credentials. Prefer generating it from environment variables or secret-manager values in CI.

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

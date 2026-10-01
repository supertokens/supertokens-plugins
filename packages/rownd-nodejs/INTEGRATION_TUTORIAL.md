# SuperTokens Rownd Integration Tutorial

This guide explains how to use Rownd-compatible frontend APIs with SuperTokens-backed auth.

The hosted Hub is `https://rownd-hub.supertokens.com`. The SDKs load that Hub, pass it your SuperTokens backend config, and keep the public Rownd APIs such as `RowndProvider`, `useRownd()`, `requestSignIn()`, `SignedIn`, `SignedOut`, and `RequireSignIn`.

## Architecture

```text
React, Next, iOS, or Android app
  -> loads https://rownd-hub.supertokens.com
  -> passes appKey and supertokens.appInfo to the Hub
  -> Hub calls {apiDomain}{apiBasePath}/plugin/rownd/*
  -> rownd-nodejs plugin uses SuperTokens recipes for users and sessions
```

Web SDKs inject `https://rownd-hub.supertokens.com/static/scripts/rph.js`. Mobile SDKs open the same Hub inside native SDK-managed UI.

Default `apiBasePath` is `/auth`, so plugin endpoints usually live under `/auth/plugin/rownd/*`.

## Backend

### Step 1: Install packages

```bash
npm install supertokens-node @supertokens-plugins/rownd-nodejs@0.3.0-beta.0
```

### Step 2: Set environment variables

```bash
SUPERTOKENS_CONNECTION_URI=http://localhost:3567
SUPERTOKENS_API_KEY=...
ROWND_APP_KEY=...
ROWND_APP_SECRET=...
API_DOMAIN=http://localhost:3001
WEBSITE_DOMAIN=http://localhost:3000
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
APPLE_CLIENT_ID=...
APPLE_KEY_ID=...
APPLE_PRIVATE_KEY=...
APPLE_TEAM_ID=...
```

### Step 3: Initialize SuperTokens

Add this before your server starts listening:

```ts
import SuperTokens from "supertokens-node";
import AccountLinking from "supertokens-node/recipe/accountlinking";
import EmailVerification from "supertokens-node/recipe/emailverification";
import Passwordless from "supertokens-node/recipe/passwordless";
import Session from "supertokens-node/recipe/session";
import ThirdParty from "supertokens-node/recipe/thirdparty";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import RowndMigrationPlugin from "@supertokens-plugins/rownd-nodejs";

SuperTokens.init({
  supertokens: {
    connectionURI: process.env.SUPERTOKENS_CONNECTION_URI!,
    apiKey: process.env.SUPERTOKENS_API_KEY,
  },
  appInfo: {
    // Display name used by SuperTokens emails and provider config.
    appName: "My App",
    // Public backend origin. The client SDK calls this from the browser.
    apiDomain: process.env.API_DOMAIN!,
    // Public frontend origin. Required for CORS and generated redirects.
    websiteDomain: process.env.WEBSITE_DOMAIN!,
    // SuperTokens API prefix. Frontend config must use the same value.
    apiBasePath: "/auth",
  },
  recipeList: [
    // Required for guest upgrade and safe linking across Rownd-style auth methods.
    AccountLinking.init({}),
    // Required. Creates SuperTokens sessions and receives Rownd-compatible claims from the plugin.
    Session.init(),
    // Required. Stores Rownd-style profile data and metadata.
    UserMetadata.init(),
    // Handles email and phone magic-link sign-in.
    Passwordless.init({
      // Enables both email and phone methods in one recipe. Use "EMAIL" or "PHONE" for single-method login.
      contactMethod: "EMAIL_OR_PHONE",
      // Rownd-compatible email/phone sign-in uses magic links.
      flowType: "MAGIC_LINK",
    }),
    // Handles verification and verified email updates.
    EmailVerification.init({}),
    // Handles Google, Apple, and anonymous/guest users.
    ThirdParty.init({
      signInAndUpFeature: {
        providers: [
          {
            config: {
              // Built-in Google provider.
              thirdPartyId: "google",
              clients: [
                {
                  // OAuth client ID from Google Cloud Console.
                  clientId: process.env.GOOGLE_CLIENT_ID!,
                  // OAuth client secret from Google Cloud Console.
                  clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
                },
              ],
            },
          },
          {
            config: {
              // Built-in Apple provider.
              thirdPartyId: "apple",
              clients: [
                {
                  // Apple Services ID.
                  clientId: process.env.APPLE_CLIENT_ID!,
                  additionalConfig: {
                    // Apple Sign in with Apple key ID.
                    keyId: process.env.APPLE_KEY_ID!,
                    // Private key contents from the Apple .p8 key.
                    privateKey: process.env.APPLE_PRIVATE_KEY!,
                    // Apple Developer Team ID.
                    teamId: process.env.APPLE_TEAM_ID!,
                  },
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
        // Rownd app key. Still required because the Hub and compatibility APIs identify the app with it.
        rowndAppKey: process.env.ROWND_APP_KEY!,
        // Rownd app secret. Used to validate existing Rownd JWTs during migration.
        rowndAppSecret: process.env.ROWND_APP_SECRET!,
        // Optional plugin debug logs.
        enableDebugLogs: process.env.ROWND_ENABLE_DEBUG_LOGS === "true",
        // Rownd-compatible config returned by /plugin/rownd/app-config.
        // We will generate and provide the app config value based on your Rownd setup.
        // This example is used as a reference here.
        appConfig: {
          // Usually the same value as rowndAppKey.
          id: process.env.ROWND_APP_KEY!,
          // Displayed by the Hub.
          name: "My App",
          // Auth methods the Hub should show.
          signInMethods: [
            { method: "email" },
            { method: "phone" },
            { method: "google", clientId: process.env.GOOGLE_CLIENT_ID },
            { method: "apple", clientId: process.env.APPLE_CLIENT_ID },
            { method: "anonymous", displayName: "Continue as guest" },
          ],
          // Account-management sections shown by the Hub.
          profile: {
            accountInformation: {
              methods: {
                email: { enabled: true },
                phone: { enabled: true },
                google: { enabled: true },
                apple: { enabled: true },
              },
            },
            personalInformation: { enabled: true },
            preferences: { enabled: true },
            signOutButton: { enabled: true },
            deleteAccountButton: { enabled: true },
          },
        },
      }),
    ],
  },
});
```

### CORS

### Step 4: Add CORS and middleware

Install SuperTokens middleware after CORS handling:

```ts
import express from "express";
import SuperTokens from "supertokens-node";
import cors from "cors";
import { errorHandler, middleware } from "supertokens-node/framework/express";

const app = express();

app.use(
  cors({
    origin: "<YOUR_WEBSITE_DOMAIN>",
    allowedHeaders: ["content-type", ...supertokens.getAllCORSHeaders()],
    credentials: true,
  }),
);

app.use(middleware());
app.use(errorHandler());
```

### Callback URLs

Google and Apple must be configured as SuperTokens ThirdParty providers. Provider dashboards must use SuperTokens callback URLs, not Rownd callback URLs.

For Apple, update the callback URL in the Apple OAuth configuration to:

```text
{apiDomain}/{apiBasePath}/callback/apple
```

With default `apiBasePath: "/auth"`, that is:

```text
https://api.example.com/auth/callback/apple
```

If your `apiDomain` already includes a path because of a proxy, include that path in the final URL. The important part is that Apple redirects to the SuperTokens Apple callback endpoint exposed by your backend.

## React App

### Step 1: Install the React SDK

```bash
npm install @supertokens/rownd-react@0.1.0-beta.2
```

### Step 2: Wrap your app

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { RowndProvider } from "@supertokens/rownd-react";
import { App } from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <RowndProvider
    // Rownd app key. Same value used by RowndMigrationPlugin.
    appKey={import.meta.env.VITE_ROWND_APP_KEY}
    // Optional. Omit in production to use https://rownd-hub.supertokens.com.
    hubUrlOverride={import.meta.env.VITE_ROWND_HUB_URL}
    // Required. Replaces original Rownd apiUrl for SuperTokens-backed auth.
    supertokens={{
      appInfo: {
        // Optional display name for frontend SuperTokens init.
        appName: "My App",
        // Public backend origin that hosts SuperTokens and the Rownd plugin.
        apiDomain: import.meta.env.VITE_SUPERTOKENS_API_DOMAIN,
        // Must match backend appInfo.apiBasePath. Defaults to /auth if omitted.
        apiBasePath: "/auth",
      },
    }}
  >
    <App />
  </RowndProvider>,
);
```

Compared to original Rownd React:

```text
Package changes from @rownd/react to @supertokens/rownd-react
Default Hub changes from https://hub.rownd.io to https://rownd-hub.supertokens.com
New required config is supertokens.appInfo.apiDomain
apiBasePath must match your backend SuperTokens config
User-facing APIs stay Rownd-compatible
```

### Step 3: Use the Rownd APIs

Use the same Rownd-facing APIs as before:

```tsx
import {
  RequireSignIn,
  SignedIn,
  SignedOut,
  useRownd,
} from "@supertokens/rownd-react";

export function AuthControls() {
  const { requestSignIn, signOut, user } = useRownd();

  return (
    <div>
      <SignedOut>
        <button onClick={() => requestSignIn({ method: "email" })}>
          Email
        </button>
        <button onClick={() => requestSignIn({ method: "phone" })}>
          Phone
        </button>
        <button onClick={() => requestSignIn({ method: "google" })}>
          Google
        </button>
        <button onClick={() => requestSignIn({ method: "apple" })}>
          Apple
        </button>
        <button onClick={() => requestSignIn({ method: "anonymous" })}>
          Guest
        </button>
      </SignedOut>

      <SignedIn>
        <p>{user.data?.email || user.data?.phone_number || user.id}</p>
        <button onClick={() => signOut()}>Sign out</button>
      </SignedIn>

      <RequireSignIn>
        <p>Protected content</p>
      </RequireSignIn>
    </div>
  );
}
```

`requestSignIn()` still accepts Rownd-style options such as `identifier`, `auto_sign_in`, `init_data`, `post_login_redirect`, `include_user_data`, `redirect`, `intent`, `group_to_join`, `prevent_closing`, `method`, and `method_options`.

## Next.js App

### Step 1: Install the Next.js SDK

```bash
npm install @supertokens/rownd-nextjs@0.1.0-beta.2
```

### Step 2: Set app inputs

```bash
ROWND_APP_KEY=...
API_DOMAIN=https://api.example.com
```

### Step 3: Create shared config

Create a shared Rownd config file:

```ts
// rowndConfig.ts
import type { RowndServerConfig } from "@supertokens/rownd-nextjs/server";

export const rowndAppKey = process.env.ROWND_APP_KEY!;

export const rowndServerConfig: RowndServerConfig = {
  supertokens: {
    appInfo: {
      // Optional display name for frontend SuperTokens init.
      appName: "My App",
      // Public backend origin that hosts SuperTokens and the Rownd plugin.
      apiDomain: process.env.API_DOMAIN!,
      // Must match backend appInfo.apiBasePath. Defaults to /auth if omitted.
      apiBasePath: "/auth",
    },
  },
};
```

### Step 4: Add the provider

Add the provider in `app/layout.tsx`:

```tsx
import type { Metadata } from "next";
import { RowndProvider } from "@supertokens/rownd-nextjs";
import { rowndAppKey, rowndServerConfig } from "../rowndConfig";

export const metadata: Metadata = {
  title: "My App",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <RowndProvider
          // Rownd app key. Same value used by RowndMigrationPlugin.
          appKey={rowndAppKey}
          // Required. Gives the Hub your SuperTokens backend location.
          supertokens={rowndServerConfig.supertokens}
        >
          {children}
        </RowndProvider>
      </body>
    </html>
  );
}
```

### Step 5: Add middleware

Add `middleware.ts`:

```ts
import { NextResponse } from "next/server";
import { withRowndMiddleware } from "@supertokens/rownd-nextjs/server";
import { rowndServerConfig } from "./rowndConfig";

export const middleware = withRowndMiddleware(() => {
  return NextResponse.next();
}, rowndServerConfig);

export const config = {
  matcher: [
    // Required. Browser token changes are bridged into an HttpOnly rownd-session cookie here.
    "/api/rownd-token-callback",
    // Add server-rendered protected routes here.
    "/profile/:path*",
  ],
};
```

### Step 6: Use server helpers

```tsx
import { cookies } from "next/headers";
import {
  getRowndUser,
  isAuthenticated,
} from "@supertokens/rownd-nextjs/server";
import { rowndServerConfig } from "../../rowndConfig";

export default async function ProfilePage() {
  const authenticated = await isAuthenticated(cookies, rowndServerConfig);

  if (!authenticated) {
    return <p>Please sign in.</p>;
  }

  const user = await getRowndUser(cookies, rowndServerConfig);

  return <pre>{JSON.stringify(user, null, 2)}</pre>;
}
```

Server helpers validate SuperTokens JWTs through `{apiDomain}{apiBasePath}/jwt/jwks.json` and fetch Rownd-compatible user data from `{apiDomain}{apiBasePath}/plugin/rownd/user`.

Compared to original Rownd Next:

```text
Package changes from @rownd/next to @supertokens/rownd-nextjs
Server validation uses SuperTokens JWKS instead of Rownd OAuth discovery
Server user loading uses /plugin/rownd/user
Middleware must include /api/rownd-token-callback
```

## Mobile SDKs

The iOS and Android SDKs use the same hosted Hub and backend plugin endpoints as the web SDKs. Configure each mobile app with:

- `appKey`: same value as `RowndMigrationPlugin.init({ rowndAppKey })`
- `apiDomain`: public backend origin that hosts SuperTokens and the Rownd plugin
- `apiBasePath`: must match backend `appInfo.apiBasePath`, usually `/auth`

### iOS

#### Step 1: Add the package

Add the SuperTokens Rownd iOS SDK as a Swift Package dependency to your iOS app target:

```text
https://github.com/supertokens/supertokens-rownd-ios
```

Select version `0.0.1-beta.0`.

#### Step 2: Configure the SDK

Configure Rownd during app launch:

```swift
import UIKit
import Rownd

func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
) -> Bool {
    Task {
        await Rownd.configure(
            launchOptions: launchOptions,
            appKey: "<ROWND_APP_KEY>",
            supertokens: RowndSuperTokensConfig(
                appName: "My App",
                apiDomain: "https://api.example.com",
                apiBasePath: "/auth"
            )
        )
    }

    return true
}
```

For app extensions or widgets, configure an app group and set `Rownd.config.appGroupPrefix` before calling `Rownd.configure()`.

#### Step 3: Use the SDK APIs

Use the SDK APIs as before:

```swift
Rownd.requestSignIn()
Rownd.requestSignIn(with: .email)
Rownd.requestSignIn(with: .anonymous)
Rownd.manageAccount()
Rownd.signOut()

let accessToken = try await Rownd.getAccessToken(throwIfMissing: true)
```

### Android

#### Step 1: Add the SDK source

Until a Maven artifact is published, add the SuperTokens Rownd Android SDK from source:

```text
https://github.com/supertokens/supertokens-rownd-android
```

Check out tag `0.0.1-beta.0`.

Check out the SDK repository next to your app repository, include it as a composite build, and substitute the SDK module dependency:

```gradle
// settings.gradle
includeBuild("../supertokens-rownd-android") {
    dependencySubstitution {
        substitute module("io.rownd:android") using project(":android")
    }
}
```

```gradle
// app/build.gradle
dependencies {
    implementation "io.rownd:android:0.0.0-local"
}
```

The version in `app/build.gradle` is ignored while the composite build substitution is active. If the SDK repo is not checked out next to your app repo, adjust the relative path in `includeBuild(...)`.

#### Step 2: Configure the SDK

Configure Rownd in your `Application` class:

```kotlin
import android.app.Application
import io.rownd.android.Rownd
import io.rownd.android.RowndConfigureOptions

class MyApplication : Application() {
    override fun onCreate() {
        super.onCreate()

        Rownd.configure(
            this,
            RowndConfigureOptions(
                appKey = "<ROWND_APP_KEY>",
                apiDomain = "https://api.example.com",
                apiBasePath = "/auth",
            )
        )
    }
}
```

#### Step 3: Use the SDK APIs

Use the SDK APIs as before:

```kotlin
Rownd.requestSignIn()
Rownd.requestSignIn(RowndSignInHint.Guest)
Rownd.manageAccount()
Rownd.signOut()

val accessToken = Rownd.getAccessToken()
```

## Migration

Existing Rownd sessions can be migrated by calling:

```text
POST /auth/plugin/rownd/migrate
Authorization: Bearer <Rownd JWT>
```

The plugin validates the Rownd token, imports the user if needed, copies Rownd profile data to SuperTokens UserMetadata, and creates a SuperTokens session. Bulk import scripts are also available in this package.

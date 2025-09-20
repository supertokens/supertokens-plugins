# SuperTokens Plugin Captcha

Add OpenTelemetry logging to all SuperTokens APIs and function calls.

## Installation

```bash
npm install @supertokens-plugins/opentelemetry-nodejs
```

## Quick Start

Initialize the plugin in your SuperTokens backend configuration:

```typescript
import SuperTokens from "supertokens-node";
import OpenTelemetryPlugin from "@supertokens-plugins/opentelemetry-nodejs";

SuperTokens.init({
  supertokens: {
    connectionURI: "...",
  },
  appInfo: {
    // your app info
  },
  recipeList: [
    // your recipes
  ],
  experimental: {
    plugins: [OpenTelemetryPlugin.init()],
  },
});
```

> [!IMPORTANT]  
> You also have to install and configure the OpenTelemetry SDK. See here for more details: https://opentelemetry.io/docs/languages/js/getting-started/nodejs/#instrumentation

## Traces added

This plugin manually adds traces to all overrideable functions and APIs. By initializing the OpenTelemetry SDK, you automatically get API level. Debug logs are currently not part of the logged events.

## Customization

### Removing sensitive data

By default the plugin removes the following fields from traces: "password", "email", "phoneNumber", "email", "emails", "phoneNumbers", "accessToken", "refreshToken"
You can add (or remove) items from this list by overriding the `getSensitiveFields` function:

```typescript
import SuperTokens from "supertokens-node";
import OpenTelemetryPlugin from "@supertokens-plugins/opentelemetry-nodejs";

SuperTokens.init({
  supertokens: {
    connectionURI: "...",
  },
  appInfo: {
    // your app info
  },
  recipeList: [
    // your recipes
  ],
  experimental: {
    plugins: [
      OpenTelemetryPlugin.init({
        override: (oI) => ({
          ...oI,
          getSensitiveFields: (defaultSensitiveFields: string[]) => [...defaultSensitiveFields, "randomField"],
        }),
      }),
    ],
  },
});
```

### Other ways of protecting sensitive data

You can achieve this in two ways:

1. You can explicitly control how things are transformed into attributes by overriding `transformInputToAttributes` and `transformResultToAttributes`.
2. Opt-out of the built-in data removal by overriding `getSensitiveFields` to return an empty array and configure data protection as as described here: https://opentelemetry.io/docs/security/handling-sensitive-data/

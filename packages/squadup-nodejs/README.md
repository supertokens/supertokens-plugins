# SuperTokens SquadUp Plugin

Adds an authenticated endpoint for listing SquadUp tickets for the current SuperTokens user.

```ts
import SquadUpPlugin from "@supertokens-plugins/squadup-nodejs";

SuperTokens.init({
  experimental: {
    plugins: [
      SquadUpPlugin.init({
        apiKey: process.env.SQUADUP_API_KEY!,
      }),
    ],
  },
});
```

## Endpoint

`GET /auth/plugin/squadup/tickets`

The endpoint requires a SuperTokens session. It uses a passwordless email login method, or a verified third-party email login method, as the SquadUp lookup email.

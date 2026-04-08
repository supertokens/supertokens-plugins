# Rownd User Migration Plugin

## Overview

Your task is to implement a backend plugin that exposes two endpoints:

- `/plugin/rownd/migrate-user`
- `/plugin/rownd/migrate-session`

The two endpoints are meant to migrate authentication data from Rownd to SuperTokens.
More info on how the rownd-nodejs SDK works can be found [here](https://github.com/rownd/node).
For supertokens references check the node sdk: https://github.com/supertokens/supertokens-node
Also check this documentation page: https://supertokens.com/docs/references/cdi/import/get-bulk-import-users-count.md for information on how to call the SuperTokens import endpoint

## Plugin Structure

Look at other plugins in this repo to understand how to structure them and what needs to be exposed/exported.
Specifically, plugins that also expose api endpoints like the tenant-discovery-nodejs or tenants.

## Migrate User

This endpoint is meant to be integrated in the following workflow:

- User logs in through a client app that uses the rownd frontend SDK
- That app calls the endpoint exposed by the plugin with the rownd credentials
- We validate the credentials, fetch the user and run call the import endpoint (we also need to check if the user already exists in SuperTokens)

#### Validate and fetch user

Here's an example of how the validate the request and fetch the user:

```typescript
async function handleSync(req, res) {
  const authHeader = req.headers.authorization?.replace(/^Bearer /i, "");

  // 1. Validate the Rownd JWT
  const tokenInfo = await rownd.validateToken(authHeader);
  const rowndUserId = tokenInfo.user_id;

  // 2. Fetch the full user profile (required for social IDs)
  const rowndUser = await rownd.fetchUserInfo({ user_id: rowndUserId });

  // 3. Perform migration to SuperTokens
  await migrateToSupertokens(rowndUser);

  res.status(200).send({ status: "ok" });
}
```

### Mapping Social & Passwordless IDs

To support SuperTokens `bulk-import`, Rownd fields must be mapped to `loginMethods`.

#### Mapping Logic:

- **Google**: If `rowndUser.data.google_id` exists, create a `thirdparty` login method with `id: "google"`.
- **Apple**: If `rowndUser.data.apple_id` exists, create a `thirdparty` login method with `id: "apple"`.
- **Email/Phone**: Map to `passwordless` recipe if no social IDs are present.

#### SuperTokens Payload Example:

```typescript
const loginMethods = [];

if (rowndUser.data.google_id) {
  loginMethods.push({
    recipeId: "thirdparty",
    thirdParty: { id: "google", userId: rowndUser.data.google_id },
    email: rowndUser.data.email,
    verified: !!rowndUser.verified_data.google_id,
  });
}

// Fallback to email if no third-party ID is found
if (loginMethods.length === 0 && rowndUser.data.email) {
  loginMethods.push({
    recipeId: "passwordless",
    email: rowndUser.data.email,
    verified: !!rowndUser.verified_data.email,
  });
}
```

### Idempotency & Conflict Handling

- Use the Rownd `app_user_id` as the `externalUserId` in the SuperTokens import.
- SuperTokens will automatically link accounts if the `externalUserId` or `email` matches an existing record, preventing duplicates during the dual-write phase.

### Initialization

Figure out how to initialize the rownd client during plugin initialization by using config values included in the plugin config.

```typescript
import { createInstance } from "@rownd/node";
const rownd = createInstance({
  app_key: process.env.ROWND_APP_KEY,
  app_secret: process.env.ROWND_APP_SECRET,
});
```

## Migrate Session

You need to figure out how to migrate the session between the two SDKs by reading and understanding the code on both sides.

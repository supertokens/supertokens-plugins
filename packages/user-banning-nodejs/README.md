# SuperTokens Plugin User Banning

Add user banning functionality to your SuperTokens application.
This plugin provides endpoints to ban/unban users and automatically revoke sessions of banned users.

## Installation

```bash
npm install @supertokens-plugins/user-banning-nodejs
```

## Quick Start

### Backend Configuration

Initialize the plugin in your SuperTokens backend configuration:

```typescript
import SuperTokens from "supertokens-node";
import UserBanningPlugin from "@supertokens-plugins/user-banning-nodejs";
import UserRoles from "supertokens-node/recipe/userroles";

SuperTokens.init({
  appInfo: {
    // your app info
  },
  recipeList: [
    UserRoles.init(), // Required: UserRoles recipe must be initialized
    // your other recipes
  ],
  plugins: [
    UserBanningPlugin.init({
      userBanningPermission: "ban-user", // Optional: defaults to "ban-user"
      bannedUserRole: "banned", // Optional: defaults to "banned"
    }),
  ],
});
```

## API Endpoints

The plugin automatically creates these protected endpoints:

### Ban/Unban User

- **POST** `/plugin/supertokens-plugin-user-banning/ban`
- **Permissions Required**: `ban-user` (or custom permission)
- **Body**:
  ```json
  {
    "userId": "user123", // Required if email not provided
    "email": "user@example.com", // Required if userId not provided
    "isBanned": true // true to ban, false to unban
  }
  ```
- **Query Parameters**: `tenantId` (required)

### Get Ban Status

- **GET** `/plugin/supertokens-plugin-user-banning/ban`
- **Permissions Required**: `ban-user` (or custom permission)
- **Query Parameters**:
  - `tenantId` (required)
  - `userId` (required if email not provided)
  - `email` (required if userId not provided)

## Configuration Options

| Option                  | Type   | Default      | Description                            |
| ----------------------- | ------ | ------------ | -------------------------------------- |
| `userBanningPermission` | string | `"ban-user"` | Permission required to ban/unban users |
| `bannedUserRole`        | string | `"banned"`   | Role assigned to banned users          |

## How It Works

### Session Management

- **Banned Users**: All sessions are immediately revoked when a user is banned and no further session creation is allowed
- **Session Validation**: Every session access automatically checks if the user has the banned role \*\*this can be overridden if

### Role-Based Protection

- Banned users are assigned the configured `bannedUserRole`
- The plugin adds a global claim validator that rejects sessions with the banned role
- Attempts to access protected resources with a banned session will fail automatically

### Caching

- We are using an in-memory cache for the ban status of users to avoid making extra network calls during session verification
- We are re-loading the cache during the first session verification after a server start to avoid a "bypass" of banning verification after server crashes
- This implies the following compromises:
  - The in-memory is very simple and we avoid setting a TTL entries for now - however, this is unlikely to grow large as overall the number of banned users is usually very low.
  - The first few requests incoming after a server crash/startup can be slow, which could cause issues in serverless environments
  - If there are multiple backends running for a single application, the ban statuses may get de-synced
- The above can be resolved, by specifying your own cache (e.g.: a redis instance) by overriding these functions:
  - `addBanToCache`
  - `removeBanFromCache`
  - `getBanStatusFromCache`
  - `preLoadCacheIfNeeded`
- Please tell us more about your usecase if this is a blocker for you by opening an issue in https://github.com/supertokens/supertokens-plugins

## Ways to Ban Users

Besides using the API endpoints directly, you can also ban users through:

### SuperTokens Management Dashboard

Navigate to your SuperTokens dashboard and add the configured banned role (default: `"banned"`) to any user. This will have the same effect as using the plugin's API endpoints.

### Frontend UI (React Plugin)

Install the React companion plugin to get a user-friendly banning interface:

```bash
npm install @supertokens-plugins/user-banning-react
```

Then initialize it in your frontend:

```typescript
import SuperTokens from "supertokens-auth-react";
import UserBanningPlugin from "@supertokens-plugins/user-banning-react";

SuperTokens.init({
  // ... your configuration
  plugins: [
    UserBanningPlugin.init({
      userBanningPermission: "ban-user", // Should match backend config
      bannedUserRole: "banned", // Should match backend config
    }),
  ],
});
```

The React plugin provides a ban user page accessible at `/admin/ban-user` with a user-friendly interface for banning and unbanning users.

### API Calls

Below you can find a quick example of how to call the API endpoints.

```typescript
// Ban a user
const response = await fetch("/plugin/supertokens-plugin-user-banning/ban?tenantId=public", {
  method: "POST",
  credentials: "include", // Make sure to include the session
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    email: "user@example.com",
    isBanned: true,
  }),
});

// Check ban status
const statusResponse = await fetch(
  "/plugin/supertokens-plugin-user-banning/ban?tenantId=public&email=user@example.com",
  {
    credentials: "include", // Make sure to include the session
    headers: {
      // Include session tokens in headers
    },
  },
);
const status = await statusResponse.json();
console.log(status.banned); // true/false
```

## Error Handling

The plugin returns standardized error responses:

```typescript
// Bad input
{
  "status": "BAD_INPUT_ERROR",
  "message": "userId or email is required"
}

// User not found
{
  "status": "BAD_INPUT_ERROR",
  "message": "user not found"
}

// Server errors
{
  "status": "UNKNOWN_ERROR",
  "message": "Could not set ban status"
}
```

## Requirements

- SuperTokens Node.js SDK >= 23.0.0
- UserRoles recipe must be initialized
- Session recipe must be initialized (automatically handled by SuperTokens)

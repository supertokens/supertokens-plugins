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

- **Banned Users**: All sessions are immediately revoked when a user is banned
- **Unbanned Users**: Existing sessions are refreshed with updated role claims
- **Session Validation**: Every session access automatically checks if the user has the banned role

### Role-Based Protection

- Banned users are assigned the configured `bannedUserRole`
- The plugin adds a global claim validator that rejects sessions with the banned role
- Attempts to access protected resources with a banned session will fail automatically

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
  }
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

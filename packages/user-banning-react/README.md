# SuperTokens Plugin User Banning

Add user banning functionality to your SuperTokens React application.
This plugin provides a user-friendly interface for administrators to ban/unban users and integrates seamlessly with the backend user banning plugin.

## Installation

```bash
npm install @supertokens-plugins/user-banning-react
```

## Quick Start

### Frontend Configuration

Initialize the plugin in your SuperTokens frontend configuration:

```typescript
import SuperTokens from "supertokens-auth-react";
import UserBanningPlugin from "@supertokens-plugins/user-banning-react";

SuperTokens.init({
  appInfo: {
    // your app info
  },
  recipeList: [
    // your recipes
  ],
  plugins: [
    UserBanningPlugin.init({
      userBanningPermission: "ban-user", // Optional: defaults to "ban-user"
      bannedUserRole: "banned", // Optional: defaults to "banned"
      onPermissionFailureRedirectPath: "/", // Optional: defaults to "/"
    }),
  ],
});
```

> [!IMPORTANT]  
> You also have to install and configure the backend plugin. Make sure that the roles and permissions are the same.

## User Banning Interface

The plugin provides a complete administrative interface accessible at `/admin/ban-user`. This page includes:

- **Tenant Selection**: Input tenant ID for multi-tenant applications
- **Ban Status Check**: View current ban status for any user
- **Ban/Unban Actions**: One-click ban and unban functionality
- **Permission Protection**: Automatically protects the interface with required permissions

## Configuration Options

| Option                            | Type   | Default      | Description                                    |
| --------------------------------- | ------ | ------------ | ---------------------------------------------- |
| `userBanningPermission`           | string | `"ban-user"` | Permission required to access banning features |
| `bannedUserRole`                  | string | `"banned"`   | Role assigned to banned users                  |
| `onPermissionFailureRedirectPath` | string | `"/"`        | Redirect path when permission check fails      |

## Hooks and Utilities

### usePlugin Hook

Access exposed plugin functionality in your custom components:

```typescript
import { usePlugin } from "@supertokens-plugins/user-banning-react";

function MyAdminComponent() {
  const { api, pluginConfig, t } = usePlugin();

  const handleBanUser = async (email: string) => {
    try {
      await api.updateBanStatus("public", email, true);
      console.log("User banned successfully");
    } catch (error) {
      console.error("Failed to ban user:", error);
    }
  };

  return (
    <div>
      <h2>{t("PL_UB_BAN_PAGE_TITLE")}</h2>
      {/* Your custom UI */}
    </div>
  );
}
```

### API Methods

The plugin provides these API methods through the `usePlugin` hook:

#### getBanStatus

Check if a user is banned:

```typescript
const { api } = usePlugin();

// Check ban status
const result = await api.getBanStatus("public", "user@example.com");
if (result.status === "OK") {
  console.log("User is banned:", result.banned);
} else {
  console.error("Error:", result.message);
}
```

#### updateBanStatus

Ban or unban a user:

```typescript
const { api } = usePlugin();

// Ban a user
await api.updateBanStatus("public", "user@example.com", true);

// Unban a user
await api.updateBanStatus("public", "user@example.com", false);
```

## Translation Keys

The plugin provides these translations for customizing the interface. THey can be found in the `translations.ts` file.

## Requirements

- SuperTokens React SDK >= 0.50.0
- SuperTokens User Banning Backend Plugin
- UserRoles recipe must be initialized

## Related

- [User Banning Backend Plugin](../user-banning-nodejs/README.md) - Required backend companion
- [SuperTokens UserRoles Recipe](https://supertokens.com/docs/userroles/introduction) - Provides permission system

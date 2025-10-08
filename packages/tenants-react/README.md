# SuperTokens Plugin Tenants

Add multi-tenancy management UI to your SuperTokens React application.
This plugin provides comprehensive tenant management interfaces including tenant switching, user management, invitations, and join requests.

## Installation

```bash
npm install @supertokens-plugins/tenants-react
```

## Quick Start

### Frontend Configuration

Initialize the plugin in your SuperTokens frontend configuration:

```typescript
import SuperTokens from "supertokens-auth-react";
import ProfileBasePlugin from "@supertokens-plugins/profile-base-react";
import TenantsPlugin from "@supertokens-plugins/tenants-react";

SuperTokens.init({
  appInfo: {
    // your app info
  },
  recipeList: [
    // your recipes (Session recipe is required)
  ],
  experimental: {
    plugins: [
      // Profile base plugin is required
      ProfileBasePlugin.init(),
      TenantsPlugin.init({
        requireTenantCreation: false, // Optional: defaults to false
        redirectToUrlOnJoiningTenant: "/", // Optional: defaults to "/"
      }),
    ],
  },
});
```

> [!IMPORTANT]
> You also have to install and configure the backend plugin `@supertokens-plugins/tenants-nodejs` and the profile base plugin `@supertokens-plugins/profile-base-react`.

## Configuration Options

| Option                          | Type                      | Default | Description                                                       |
| ------------------------------- | ------------------------- | ------- | ----------------------------------------------------------------- |
| `requireTenantCreation`         | `boolean`                 | `false` | Whether users must create a tenant before accessing the app       |
| `redirectToUrlOnJoiningTenant`  | `string or (() => void)`  | `"/"`   | URL to redirect to or function that does the redirection after successfully joining tenants |

## Features

The plugin automatically integrates with the profile base plugin to provide:

### 1. Tenant Switching
- View and switch between available tenants
- Displays tenant name and user's role in each tenant
- Seamless tenant context switching

### 2. Tenant Management
- Create new tenants
- Manage tenant users
- Assign and change user roles
- Remove users from tenant

### 3. User Invitations
- Invite users to join tenant via email
- Manage pending invitations
- Accept invitations using invitation codes

### 4. Join Requests
- View and manage join requests
- Approve or reject user requests to join tenant
- Request to join other tenants

### 5. Tenant Creation Requests
- View pending tenant creation requests (admin)
- Approve or reject tenant creation requests (admin)
- Submit tenant creation requests (when approval required)

## Available Pages

The plugin provides the following pre-built pages:

### Tenant Management Page
Comprehensive tenant management interface including:
- User list with roles
- User role management
- User removal
- Invitation management
- Join request management

### Tenant Creation Requests Page
Admin interface for managing tenant creation requests.

## Hooks and Utilities

### usePluginContext Hook

Access plugin functionality and API methods:

```typescript
import { usePluginContext } from "@supertokens-plugins/tenants-react";

function MyTenantComponent() {
  const { api, pluginConfig, t } = usePluginContext();

  const handleFetchTenants = async () => {
    try {
      const response = await api.fetchTenants();
      if (response.status === "OK") {
        console.log("Tenants:", response.tenants);
      }
    } catch (error) {
      console.error("Failed to fetch tenants:", error);
    }
  };

  return (
    <div>
      <h2>{t("PL_TD_SELECT_TENANT_TITLE")}</h2>
      <button onClick={handleFetchTenants}>Load Tenants</button>
    </div>
  );
}
```

## API Methods

The plugin provides these API methods through the `usePluginContext` hook:

### fetchTenants

Retrieve all available tenants for the current user:

```typescript
const { api } = usePluginContext();

const result = await api.fetchTenants();
if (result.status === "OK") {
  console.log("Tenants:", result.tenants);
  // [{ id: "tenant1", name: "My Tenant", role: "admin" }]
}
```

### createTenant

Create a new tenant:

```typescript
const { api } = usePluginContext();

const result = await api.createTenant({
  name: "My New Tenant",
  firstFactors: ["emailpassword", "thirdparty"], // optional
});

if (result.status === "OK") {
  console.log("Tenant created:", result.pendingApproval);
}
```

### switchTenant

Switch to a different tenant:

```typescript
const { api } = usePluginContext();

const result = await api.switchTenant("tenant1");
if (result.status === "OK") {
  console.log("Switched to tenant successfully");
  // Session is now in the context of tenant1
}
```

### joinTenant

Join a tenant:

```typescript
const { api } = usePluginContext();

const result = await api.joinTenant({
  tenantId: "tenant1",
});

if (result.status === "OK") {
  console.log("Joined tenant successfully");
}
```

### getUsers

Get all users in the current tenant:

```typescript
const { api } = usePluginContext();

const result = await api.getUsers();
if (result.status === "OK") {
  console.log("Users:", result.users);
  // [{ id: "user1", emails: ["user@example.com"], roles: ["admin"] }]
}
```

### changeRole

Change a user's role in the current tenant:

```typescript
const { api } = usePluginContext();

const result = await api.changeRole("user123", "tenant-member");
if (result.status === "OK") {
  console.log("Role changed successfully");
}
```

### removeUserFromTenant

Remove a user from the current tenant:

```typescript
const { api } = usePluginContext();

const result = await api.removeUserFromTenant("user123");
if (result.status === "OK") {
  console.log("User removed successfully");
}
```

### Invitation Management

#### addInvitation

Invite a user to the tenant:

```typescript
const { api } = usePluginContext();

const result = await api.addInvitation("user@example.com", "tenant-member");
if (result.status === "OK") {
  console.log("Invitation code:", result.code);
}
```

#### getInvitations

Get all pending invitations:

```typescript
const { api } = usePluginContext();

const result = await api.getInvitations();
if (result.status === "OK") {
  console.log("Invitations:", result.invitees);
}
```

#### removeInvitation

Remove a pending invitation:

```typescript
const { api } = usePluginContext();

const result = await api.removeInvitation("user@example.com");
if (result.status === "OK") {
  console.log("Invitation removed");
}
```

#### acceptInvitation

Accept an invitation to join a tenant:

```typescript
const { api } = usePluginContext();

const result = await api.acceptInvitation("invitation-code", "tenant1");
if (result.status === "OK") {
  console.log("Invitation accepted");
}
```

### Join Request Management

#### getOnboardingRequests

Get all pending join requests for the current tenant:

```typescript
const { api } = usePluginContext();

const result = await api.getOnboardingRequests();
if (result.status === "OK") {
  console.log("Join requests:", result.users);
}
```

#### acceptOnboardingRequest

Approve a join request:

```typescript
const { api } = usePluginContext();

const result = await api.acceptOnboardingRequest("user123");
if (result.status === "OK") {
  console.log("Request approved");
}
```

#### declineOnboardingRequest

Reject a join request:

```typescript
const { api } = usePluginContext();

const result = await api.declineOnboardingRequest("user123");
if (result.status === "OK") {
  console.log("Request declined");
}
```

### Tenant Creation Request Management

#### getCreationRequests

Get all pending tenant creation requests (admin only):

```typescript
const { api } = usePluginContext();

const result = await api.getCreationRequests();
if (result.status === "OK") {
  console.log("Creation requests:", result.requests);
}
```

#### acceptCreationRequest

Approve a tenant creation request (admin only):

```typescript
const { api } = usePluginContext();

const result = await api.acceptCreationRequest("request123");
if (result.status === "OK") {
  console.log("Request approved");
}
```

#### declineCreationRequest

Reject a tenant creation request (admin only):

```typescript
const { api } = usePluginContext();

const result = await api.declineCreationRequest("request123");
if (result.status === "OK") {
  console.log("Request declined");
}
```

## Component Customization

### Custom Pages

You can customize the default pages by providing your own components:

```typescript
import TenantsPlugin from "@supertokens-plugins/tenants-react";
import { CustomSelectTenant, CustomTenantManagement } from "./your-custom-components";

SuperTokens.init({
  // ... other config
  experimental: {
    plugins: [
      TenantsPlugin.init({
        override: (oI) => ({
          ...oI,
          pages: (originalPages) => ({
            ...originalPages,
            selectTenant: CustomSelectTenant,
            tenantManagement: CustomTenantManagement,
          }),
        }),
      }),
    ],
  },
});
```

## Integration with Profile Base Plugin

This plugin automatically integrates with the profile base plugin by:

1. **Registering Tenant Section**: Adds a "Tenants" section in the profile interface
2. **Navigation**: Provides navigation to tenant-related pages
3. **Role-Based Access**: Shows appropriate options based on user permissions

## Internationalization

The plugin comes with built-in translations for English. Translation keys are available through the `t` function in `usePluginContext`:

```typescript
const { t } = usePluginContext();

console.log(t("PL_TD_SELECT_TENANT_TITLE")); // "Select Tenant"
console.log(t("PL_TD_CREATE_TENANT_BUTTON")); // "Create Tenant"
```

## Routing

The plugin automatically registers the following routes:

- `/user/tenants/create` - Tenant creation page
- `/user/invite/accept` - Invite accept page

## Required Permissions

Different features require different permissions:

| Feature                  | Permission Required          |
| ------------------------ | ---------------------------- |
| List tenants             | `tenant-access`              |
| Switch tenant            | `tenant-access`              |
| Create tenant            | None (configurable)          |
| List users               | `list-users`                 |
| Change user roles        | `change-user-roles`          |
| Remove users             | `remove-users`               |
| Manage invitations       | `manage-invitations`         |
| Manage join requests     | `manage-join-requests`       |
| Manage creation requests | `manage-create-requests`     |

## Session Management

The plugin automatically handles session context switching when users switch tenants. After switching tenants:
- The session is refreshed with the new tenant context
- User roles and permissions are updated
- The page redirects to `redirectToUrlOnJoiningTenant`

## Error Handling

All API methods return a standardized response format:

```typescript
// Success response
{ status: "OK", ...data }

// Error response
{ status: "ERROR", message: "Error description" }
```

Always check the `status` field before accessing response data:

```typescript
const result = await api.fetchTenants();
if (result.status === "OK") {
  // Handle success
  console.log(result.tenants);
} else {
  // Handle error
  console.error(result.message);
}
```

## License

See the main repository for license information.

# SuperTokens Plugin Tenants

Add multi-tenancy management to your SuperTokens Node.js backend.
This plugin provides comprehensive APIs for creating, managing, and switching between tenants, with support for role-based access control, tenant invitations, and join requests.

## Installation

```bash
npm install @supertokens-plugins/tenants-nodejs
```

## Quick Start

### Backend Configuration

Initialize the plugin in your SuperTokens backend configuration:

```typescript
import SuperTokens from "supertokens-node";
import Session from "supertokens-node/recipe/session";
import UserRoles from "supertokens-node/recipe/userroles";
import TenantsPlugin from "@supertokens-plugins/tenants-nodejs";

SuperTokens.init({
  appInfo: {
    // your app info
  },
  recipeList: [
    Session.init({}),
    UserRoles.init({}), // Required for role-based access control
    // your other recipes
  ],
  experimental: {
    plugins: [
      TenantsPlugin.init({
        requireNonPublicTenantAssociation: false, // Optional: defaults to false
        requireTenantCreationRequestApproval: true, // Optional: defaults to true
        enableTenantListAPI: true, // Optional: defaults to false
        createRolesOnInit: true, // Optional: defaults to true
      }),
    ],
  },
});
```

> [!IMPORTANT]
> You also have to install and configure the frontend plugin for the complete tenant management experience.

## Configuration Options

| Option                                | Type      | Default | Description                                                            |
| ------------------------------------- | --------- | ------- | ---------------------------------------------------------------------- |
| `requireNonPublicTenantAssociation`   | `boolean` | `false` | Require users to be associated with at least one non-public tenant    |
| `requireTenantCreationRequestApproval`| `boolean` | `true`  | Whether tenant creation requires approval from an admin                |
| `enableTenantListAPI`                 | `boolean` | `false` | Enable the API to list all available tenants                           |
| `createRolesOnInit`                   | `boolean` | `true`  | Automatically create required roles (TENANT_ADMIN, TENANT_MEMBER) on initialization |
| `allowPublicTenantAccess`                       | `boolean` | `false` | Whether public tenant access should be allowed without an assigned role |
| `emailDelivery`                       | `object`  | -       | Configure email delivery service and overrides                         |

## API Endpoints

The plugin automatically exposes these endpoints:

### Tenant Management

#### List Tenants
- **GET** `/plugin/supertokens-plugin-tenants/list`
- **Authentication**: Session required
- **Note**: Only available when `enableTenantListAPI: true`
- **Response**:
  ```json
  {
    "status": "OK",
    "tenants": [
      {
        "id": "tenant1",
        "name": "Tenant 1",
        "role": "admin"
      }
    ]
  }
  ```

#### Create Tenant
- **POST** `/plugin/supertokens-plugin-tenants/create-tenant`
- **Authentication**: Session required
- **Body**:
  ```json
  {
    "name": "My Tenant",
    "firstFactors": ["emailpassword", "thirdparty"] // optional
  }
  ```
- **Response**:
  ```json
  {
    "status": "OK",
    "createdNew": true,
    "isPendingApproval": false
  }
  ```

#### Switch Tenant
- **POST** `/plugin/supertokens-plugin-tenants/switch-tenant`
- **Authentication**: Session required
- **Body**:
  ```json
  {
    "tenantId": "tenant1"
  }
  ```
- **Response**:
  ```json
  {
    "status": "OK",
    "message": "Session switched"
  }
  ```

#### Join Tenant
- **POST** `/plugin/supertokens-plugin-tenants/join-tenant`
- **Authentication**: Session required
- **Body**:
  ```json
  {
    "tenantId": "tenant1"
  }
  ```
- **Response**:
  ```json
  {
    "status": "OK",
    "message": "User associated with tenant"
  }
  ```

#### Leave Tenant
- **POST** `/plugin/supertokens-plugin-tenants/leave-tenant`
- **Authentication**: Session required
- **Response**:
  ```json
  {
    "status": "OK",
    "message": "User disassociated from tenant"
  }
  ```

### User Management

#### List Users in Tenant
- **POST** `/plugin/supertokens-plugin-tenants/users`
- **Authentication**: Session required
- **Permissions**: `LIST_USERS`
- **Response**:
  ```json
  {
    "status": "OK",
    "users": [
      {
        "id": "user123",
        "emails": ["user@example.com"],
        "timeJoined": 1640995200000
      }
    ]
  }
  ```

#### Remove User from Tenant
- **POST** `/plugin/supertokens-plugin-tenants/remove`
- **Authentication**: Session required
- **Permissions**: `REMOVE_USERS`
- **Body**:
  ```json
  {
    "userId": "user123"
  }
  ```
- **Response**:
  ```json
  {
    "status": "OK"
  }
  ```

#### Change User Role
- **POST** `/plugin/supertokens-plugin-tenants/role/change`
- **Authentication**: Session required
- **Permissions**: `CHANGE_USER_ROLES`
- **Body**:
  ```json
  {
    "userId": "user123",
    "role": "tenant-admin"
  }
  ```
- **Response**:
  ```json
  {
    "status": "OK",
    "message": "Role changed"
  }
  ```

### Invitations

#### Add Invitation
- **POST** `/plugin/supertokens-plugin-tenants/invite/add`
- **Authentication**: Session required
- **Permissions**: `MANAGE_INVITATIONS`
- **Body**:
  ```json
  {
    "email": "user@example.com",
    "role": "tenant-member"
  }
  ```
- **Response**:
  ```json
  {
    "status": "OK",
    "code": "abc123"
  }
  ```

#### List Invitations
- **POST** `/plugin/supertokens-plugin-tenants/invite/list`
- **Authentication**: Session required
- **Permissions**: `MANAGE_INVITATIONS`
- **Response**:
  ```json
  {
    "status": "OK",
    "invitations": [
      {
        "email": "user@example.com",
        "role": "tenant-member",
        "code": "abc123"
      }
    ]
  }
  ```

#### Accept Invitation
- **POST** `/plugin/supertokens-plugin-tenants/invite/accept`
- **Authentication**: Session required
- **Body**:
  ```json
  {
    "tenantId": "tenant1",
    "code": "abc123"
  }
  ```
- **Response**:
  ```json
  {
    "status": "OK"
  }
  ```

#### Remove Invitation
- **POST** `/plugin/supertokens-plugin-tenants/invite/remove`
- **Authentication**: Session required
- **Permissions**: `MANAGE_INVITATIONS`
- **Body**:
  ```json
  {
    "email": "user@example.com"
  }
  ```
- **Response**:
  ```json
  {
    "status": "OK"
  }
  ```

### Join Requests

#### Request to Join Tenant
- **POST** `/plugin/supertokens-plugin-tenants/request/add`
- **Authentication**: Session required
- **Body**:
  ```json
  {
    "tenantId": "tenant1"
  }
  ```
- **Response**:
  ```json
  {
    "status": "OK",
    "message": "Request added"
  }
  ```

#### List Join Requests
- **POST** `/plugin/supertokens-plugin-tenants/request/list`
- **Authentication**: Session required
- **Permissions**: `MANAGE_JOIN_REQUESTS`
- **Response**:
  ```json
  {
    "status": "OK",
    "users": [
      {
        "id": "user123",
        "emails": ["user@example.com"]
      }
    ]
  }
  ```

#### Accept Join Request
- **POST** `/plugin/supertokens-plugin-tenants/request/accept`
- **Authentication**: Session required
- **Permissions**: `MANAGE_JOIN_REQUESTS`
- **Body**:
  ```json
  {
    "userId": "user123"
  }
  ```
- **Response**:
  ```json
  {
    "status": "OK",
    "message": "Request accepted"
  }
  ```

#### Reject Join Request
- **POST** `/plugin/supertokens-plugin-tenants/request/reject`
- **Authentication**: Session required
- **Permissions**: `MANAGE_JOIN_REQUESTS`
- **Body**:
  ```json
  {
    "userId": "user123"
  }
  ```
- **Response**:
  ```json
  {
    "status": "OK"
  }
  ```

### Tenant Creation Requests

#### List Tenant Creation Requests
- **POST** `/plugin/supertokens-plugin-tenants/tenant-requests/list`
- **Authentication**: Session required
- **Permissions**: `MANAGE_CREATE_REQUESTS`
- **Response**:
  ```json
  {
    "status": "OK",
    "requests": [
      {
        "id": "request123",
        "name": "New Tenant",
        "creatorId": "user123"
      }
    ]
  }
  ```

#### Accept Tenant Creation Request
- **POST** `/plugin/supertokens-plugin-tenants/tenant-requests/accept`
- **Authentication**: Session required
- **Permissions**: `MANAGE_CREATE_REQUESTS`
- **Body**:
  ```json
  {
    "requestId": "request123"
  }
  ```
- **Response**:
  ```json
  {
    "status": "OK"
  }
  ```

#### Reject Tenant Creation Request
- **POST** `/plugin/supertokens-plugin-tenants/tenant-requests/reject`
- **Authentication**: Session required
- **Permissions**: `MANAGE_CREATE_REQUESTS`
- **Body**:
  ```json
  {
    "requestId": "request123"
  }
  ```
- **Response**:
  ```json
  {
    "status": "OK"
  }
  ```

## Roles and Permissions

The plugin automatically creates the following roles:

### Tenant Roles

| Role            | Description                                    | Permissions                                                                                     |
| --------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `tenant-admin`  | Full administrative access within the tenant   | `tenant-access`, `list-users`, `manage-invitations`, `manage-join-requests`, `change-user-roles`, `remove-users` |
| `tenant-member` | Basic member access within the tenant          | `tenant-access`                                                                                 |
| `app-admin`     | Global application administrator               | All permissions across all tenants                                                              |

### Permissions

| Permission              | Description                                    |
| ----------------------- | ---------------------------------------------- |
| `tenant-access`         | Basic access to tenant                         |
| `list-users`            | View list of users in tenant                   |
| `manage-invitations`    | Create and manage tenant invitations           |
| `manage-join-requests`  | Approve or reject join requests                |
| `change-user-roles`     | Modify user roles within tenant                |
| `remove-users`          | Remove users from tenant                       |
| `manage-create-requests`| Approve or reject tenant creation requests     |

## Email Delivery Configuration

Configure custom email delivery for tenant-related notifications:

```typescript
import { PluginSMTPService } from "@supertokens-plugins/tenants-nodejs";

TenantsPlugin.init({
  emailDelivery: {
    service: new PluginSMTPService({
      smtpSettings: {
        host: "smtp.example.com",
        port: 587,
        from: {
          name: "Your App",
          email: "noreply@example.com",
        },
        secure: false,
        authUsername: "username",
        password: "password",
      },
    }),
  },
});
```

### Email Types

The plugin sends emails for the following events:

1. **TENANT_REQUEST_APPROVAL**: Sent to admins when a user requests to create a tenant
2. **TENANT_CREATE_APPROVAL**: Sent to the requester when their tenant creation request is approved

## Exported Functions

The plugin exports helper functions for direct backend usage:

```typescript
import { assignAdminToUserInTenant, assignRoleToUserInTenant } from "@supertokens-plugins/tenants-nodejs";

// Assign admin role to a user in a tenant
await assignAdminToUserInTenant("tenant1", "user123");

// Assign a specific role to a user in a tenant
await assignRoleToUserInTenant("tenant1", "user123", "tenant-member");
```

## Advanced Configuration

### Custom Implementation Override

You can override default behaviors by providing custom implementations:

```typescript
TenantsPlugin.init({
  override: {
    functions: (originalImplementation) => ({
      ...originalImplementation,
      isAllowedToCreateTenant: async (session) => {
        // Custom logic to determine if user can create tenant
        const userId = session.getUserId();
        // Check your custom logic here
        return true;
      },
      canApproveJoinRequest: async (targetUser, tenantId, session) => {
        // Custom logic for approving join requests
        return true;
      },
    }),
  },
});
```

## Session Management

The plugin automatically manages session switching when users join or switch tenants. The session is refreshed with the new tenant context, including updated roles and permissions.

## Multi-Tenancy Workflow

1. **User creates a tenant**: POST to `/create-tenant`
2. **Admin assigns roles**: Users are automatically assigned the `tenant-admin` role when they create a tenant
3. **Users join tenant**:
   - Via invitation: Accept invitation using invitation code
   - Via request: Request to join and wait for admin approval
4. **Switch tenant**: Use `/switch-tenant` to change active tenant context

## Testing

The plugin includes comprehensive test coverage. Run tests with:

```bash
npm test
```

Tests require a running SuperTokens core instance. Configure using environment variables:
- `CORE_BASE_URL`: SuperTokens core URL (default: `http://localhost:3567`)
- `CORE_API_KEY`: API key for core authentication

## License

See the main repository for license information.

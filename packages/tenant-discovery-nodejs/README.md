# SuperTokens Plugin Tenant Discovery

Automatically discover and route users to appropriate tenants based on their email domains.
This plugin provides endpoints to infer tenant IDs from email domains.

## Installation

```bash
npm install @supertokens-plugins/tenant-discovery-nodejs
```

## Quick Start

### Backend Configuration

Initialize the plugin in your SuperTokens backend configuration:

```typescript
import SuperTokens from "supertokens-node";
import TenantDiscoveryPlugin from "@supertokens-plugins/tenant-discovery-nodejs";

SuperTokens.init({
  appInfo: {
    // your app info
  },
  recipeList: [
    // your other recipes
  ],
  plugins: [
    TenantDiscoveryPlugin.init({
      enableTenantListAPI: false,
    }),
  ],
});
```

## API Endpoints

The plugin automatically creates these endpoints:

### Get Tenant from Email

- **POST** `/plugin/supertokens-plugin-tenant-discovery/from-email`
- **Body**:
  ```json
  {
    "email": "user@company1.com"
  }
  ```
- **Response**:
  ```json
  {
    "status": "OK",
    "tenant": "company1", // Final tenant (validated)
    "inferredTenantId": "company1", // Inferred from email domain
    "email": "user@company1.com"
  }
  ```

#### Block emails from tenant

The default fallback for getting the tenant ID from the email is "public". If this is not ideal, we provide a function that can be overridden to avoid this.

The `isTenantAllowedForEmail` function can be overridden in the following way

```ts
import SuperTokens from "supertokens-node";
import TenantDiscoveryPlugin from "@supertokens-plugins/tenant-discovery-nodejs";

SuperTokens.init({
  appInfo: {
    // your app info
  },
  recipeList: [
    // your other recipes
  ],
  plugins: [
    TenantDiscoveryPlugin.init({
      enableTenantListAPI: false,
      override: (originalImplementation) => ({
        ...originalImplementation,
        isTenantAllowedForEmail: (email: string, tenantId: string) => {
          // Check whether the email can access the tenant
          return true;
        },
      }),
    }),
  ],
});
```

### List All Tenants

> [!IMPORTANT]  
> This is disabled by default. The `enableTenantListAPI` field in config has to be set to `true` in order to enable it.

- **GET** `/plugin/supertokens-plugin-tenant-discovery/list`
- **Response**:
  ```json
  {
    "status": "OK",
    "tenants": [
      {
        "tenantId": "public"
        // ... tenant configuration
      },
      {
        "tenantId": "tenant1"
        // ... tenant configuration
      }
    ]
  }
  ```

## Configuration Options

| Option                | Type      | Default | Description                                           |
| --------------------- | --------- | ------- | ----------------------------------------------------- |
| `enableTenantListAPI` | `boolean` | `false` | Whether to show tenant selector (enable API's or not) |

## How It Works

### Email Domain to Tenant ID Inference

- The plugin extracts the domain from user email addresses (e.g., `user@company.com` → `company.com`)
- It then extracts the tenant ID from the domain by taking the second-to-last part (e.g., `company.com` → `company` or `test.company.com` -> `company`)
- For domains with only one part, it uses the entire domain as tenant ID
- If the inferred tenant doesn't exist in your SuperTokens setup, it falls back to the `public` tenant

### Domain Restrictions

- Popular email domains (Gmail, Yahoo, Outlook, etc.) are automatically blocked from tenant inference
- Restricted domains automatically return `public` as the tenant ID
- This prevents assignment of public email users to inferred tenant IDs

### Tenant Validation

- The plugin validates if the inferred tenant ID actually exists in your SuperTokens configuration
- If the inferred tenant exists, it's returned as the final tenant
- If the inferred tenant doesn't exist, `public` is returned as the fallback
- Both `tenant` (final) and `inferredTenantId` (raw inference) are provided in the API response

## Ways to Use Tenant Discovery

### Frontend Integration

Use the plugin's API endpoints from your frontend to determine which tenant a user belongs to:

```typescript
// Discover tenant from email during sign-up/sign-in
const discoverTenant = async (email: string) => {
  const response = await fetch("/plugin/supertokens-plugin-tenant-discovery/from-email", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email }),
  });

  const result = await response.json();
  if (result.status === "OK") {
    // Use the validated tenant ID
    console.log(`Final tenant: ${result.tenant}`);
    // Redirect user to tenant-specific sign-in page
    window.location.href = `/auth?tenantId=${result.tenant}`;
  }
};

// Get list of all available tenants
const getTenants = async () => {
  const response = await fetch("/plugin/supertokens-plugin-tenant-discovery/list");
  const result = await response.json();
  return result.tenants;
};
```

### Multi-Step Authentication Flow

1. User enters email on landing page
2. Call `/from-email` endpoint to infer and validate tenant
3. Use the returned `tenant` field for routing (validated tenant)
4. Redirect user to tenant-specific authentication flow
5. User completes sign-up/sign-in in correct tenant context

### API Integration

```typescript
// Example: Email-based tenant discovery during user onboarding
const handleEmailSubmit = async (email: string) => {
  try {
    const response = await fetch("/plugin/supertokens-plugin-tenant-discovery/from-email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email }),
    });

    const result = await response.json();

    if (result.status === "OK") {
      // Proceed with authentication in validated tenant
      console.log(`User ${email} belongs to tenant: ${result.tenant}`);
      console.log(`Inferred tenant ID: ${result.inferredTenantId}`);
      // Initialize SuperTokens with validated tenant
      initAuthWithTenant(result.tenant);
    }
  } catch (error) {
    console.error("Tenant discovery failed:", error);
    // Fallback to public tenant
    initAuthWithTenant("public");
  }
};
```

## Error Handling

The plugin returns standardized error responses:

```typescript
// Missing email
{
  "status": "ERROR",
  "message": "Email is required"
}

// Restricted domain (returns public)
{
  "status": "OK",
  "tenant": "public", // Restricted domain fallback
  "inferredTenantId": "public",
  "email": "user@gmail.com"
}

// Invalid tenant (inferred tenant doesn't exist)
{
  "status": "OK",
  "tenant": "public", // Fallback when inferred tenant doesn't exist
  "inferredTenantId": "nonexistent", // What was inferred from email
  "email": "user@nonexistent.com"
}
```

## Domain Restrictions

The plugin automatically blocks these popular email domains from tenant inference:

- gmail.com, yahoo.com, hotmail.com, outlook.com
- icloud.com, aol.com, live.com, msn.com
- And other popular domains

You can add custom restrictions:

```typescript
TenantDiscoveryPlugin.init({
  enableTenantListAPI: false,
});
```

**Examples of tenant inference:**

- `user@company.com` → infers `company` (if company tenant exists)
- `admin@enterprise.org` → infers `enterprise` (if enterprise tenant exists)
- `user@sub.company.com` → infers `company` (takes second-to-last part)
- `user@gmail.com` → returns `public` (restricted domain)
- `user@nonexistent.com` → infers `nonexistent` but returns `public` (tenant doesn't exist)

## Requirements

- SuperTokens Node.js SDK >= 23.0.0
- Multi-tenancy must be properly configured in your SuperTokens setup

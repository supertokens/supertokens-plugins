# SuperTokens Plugin Tenant Discovery

Automatically discover and route users to appropriate tenants based on their email domains.
This plugin provides endpoints to map email domains to specific tenants and automatically assign users to the correct tenant during authentication.

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
      emailDomainToTenantIdMap: {
        "company1.com": "tenant1",
        "company2.com": "tenant2",
        "enterprise.org": "enterprise-tenant",
      },
      restrictedEmailDomains: ["tempmail.com", "10minutemail.com"], // Optional: additional domains to block
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
    "tenant": "tenant1",
    "email": "user@company1.com"
  }
  ```

### List All Tenants

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

| Option                     | Type                     | Default | Description                                                   |
| -------------------------- | ------------------------ | ------- | ------------------------------------------------------------- |
| `emailDomainToTenantIdMap` | `Record<string, string>` | -       | Maps email domains to tenant IDs                              |
| `restrictedEmailDomains`   | `string[]`               | `[]`    | Additional email domains to restrict (beyond popular domains) |

## How It Works

### Email Domain Mapping

- The plugin extracts the domain from user email addresses (e.g., `user@company.com` → `company.com`)
- If the domain matches an entry in `emailDomainToTenantIdMap`, the user is assigned to that tenant
- If no match is found, the user is assigned to the `public` tenant

### Domain Restrictions

- Popular email domains (Gmail, Yahoo, Outlook, etc.) are automatically blocked from being used in the mapping
- You can specify additional domains to block using `restrictedEmailDomains`
- This prevents accidental assignment of public email users to specific tenants

### Automatic Tenant Assignment

- During authentication, users are automatically routed to their appropriate tenant based on email domain
- The plugin integrates seamlessly with SuperTokens' multi-tenancy system
- No additional session management or user intervention required

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
2. Call `/from-email` endpoint to discover tenant
3. Redirect user to tenant-specific authentication flow
4. User completes sign-up/sign-in in correct tenant context

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
      // Proceed with authentication in discovered tenant
      console.log(`User ${email} belongs to tenant: ${result.tenant}`);
      // Initialize SuperTokens with discovered tenant
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

// Invalid email format
{
  "status": "OK",
  "tenant": "public", // Falls back to public tenant
  "email": "invalid-email"
}

// Restricted domain error (during initialization)
// Error: Email domain "gmail.com" is not allowed
```

## Domain Restrictions

The plugin automatically blocks these popular email domains from being used in tenant mapping:

- gmail.com, yahoo.com, hotmail.com, outlook.com
- icloud.com, aol.com, live.com, msn.com
- And 30+ other popular domains

You can add custom restrictions:

```typescript
TenantDiscoveryPlugin.init({
  emailDomainToTenantIdMap: {
    "mycompany.com": "company-tenant",
  },
  restrictedEmailDomains: ["tempmail.com", "guerrillamail.com"], // Block temporary email services
});
```

## Requirements

- SuperTokens Node.js SDK >= 23.0.0
- Multi-tenancy must be properly configured in your SuperTokens setup

# SuperTokens Plugin Tenant Discovery

Add tenant discovery functionality to your SuperTokens React application.
This plugin provides a user-friendly interface for users to select tenants and integrates seamlessly with the backend tenant discovery plugin.

## Installation

```bash
npm install @supertokens-plugins/tenant-discovery-react
```

## Quick Start

### Frontend Configuration

Initialize the plugin in your SuperTokens frontend configuration:

```typescript
import SuperTokens from "supertokens-auth-react";
import TenantDiscoveryPlugin from "@supertokens-plugins/tenant-discovery-react";

SuperTokens.init({
  appInfo: {
    // your app info
  },
  recipeList: [
    // your recipes
  ],
  experimental: {
    plugins: [
      TenantDiscoveryPlugin.init({
        showTenantSelector: true, // Optional: defaults to true
        extractTenantIdFromDomain: true, // Optional: defaults to true
      }),
    ],
  }
});
```

> [!IMPORTANT]  
> You also have to install and configure the backend plugin for full tenant discovery functionality.

## Tenant Selection Interface

The plugin provides a complete tenant selection interface accessible at `/tenant-discovery/select`. This page includes:

- **Tenant List**: Displays all available tenants from your SuperTokens configuration
- **Tenant Selection**: Dropdown to choose from available tenants
- **Automatic Redirect**: Redirects to authentication with selected tenant ID
- **Loading States**: Proper loading and error handling

## Configuration Options

| Option                      | Type    | Default | Description                                    |
| --------------------------- | ------- | ------- | ---------------------------------------------- |
| `showTenantSelector`        | boolean | `true`  | Whether to show the tenant selector interface  |
| `extractTenantIdFromDomain` | boolean | `true`  | Whether to extract tenant ID from email domain |

## Hooks and Utilities

Besides the default UI, the plugin exposes some hooks and util functions that can be used directly (e.g. building a custom UI).

### usePluginContext Hook

Access exposed plugin functionality in your custom components:

```typescript
import { usePluginContext } from "@supertokens-plugins/tenant-discovery-react";

function MyTenantComponent() {
  const { api, functions } = usePluginContext();

  const handleFetchTenants = async () => {
    try {
      const response = await api.fetchTenants();
      if (response.status === "OK") {
        console.log("Available tenants:", response.tenants);
      }
    } catch (error) {
      console.error("Failed to fetch tenants:", error);
    }
  };

  const handleSetTenant = (tenantId: string, email?: string) => {
    functions.setTenantId(tenantId, email, true);
  };

  return (
    <div>
      {/* Your custom tenant selection UI */}
    </div>
  );
}
```

### API Methods

The plugin provides these API methods through the `usePluginContext` hook:

#### fetchTenants

Retrieve all available tenants:

```typescript
const { api } = usePluginContext();

// Fetch all tenants
const result = await api.fetchTenants();
if (result.status === "OK") {
  console.log("Tenants:", result.tenants);
  // result.tenants is an array of { tenantId: string }
} else {
  console.error("Error:", result.message);
}
```

### Plugin Methods

Access tenant management functionality:

#### setTenantId

Set the current tenant ID:

```typescript
const { functions } = usePluginContext();

// Save email for prefilling the email input after reload
functions.setEmailId("user@company.com");
// Set tenant ID and refresh
functions.setTenantId("company-tenant", true);
```

#### determineTenantFromURL

Extract tenant from URL parameters:

```typescript
const { functions } = usePluginContext();

// Get tenant from URL
const tenantFromURL = await functions.determineTenantFromURL();
console.log("URL Tenant:", tenantFromURL);
```

#### determineTenantFromSubdomain

Extract tenant from subdomain:

```typescript
const { functions } = usePluginContext();

// Get tenant from subdomain
const tenantFromSubdomain = await functions.determineTenantFromSubdomain();
console.log("Subdomain Tenant:", tenantFromSubdomain);
```

## Usage Patterns

> [!NOTE]  
> All the following functionalities are already part of the plugin. Following examples are shown for usage with custom UI's etc.

### Email-Based Tenant Discovery

Use the plugin with backend tenant discovery for seamless user routing:

```typescript
import { usePluginContext } from "@supertokens-plugins/tenant-discovery-react";

function EmailTenantDiscovery() {
  const { functions, api } = usePluginContext();
  const [email, setEmail] = useState("");

  const handleEmailSubmit = async () => {
    const result = await api.tenantIdFromEmail(email);
    if (result.status === "OK") {
      // Set discovered tenant
      functions.setTenantId(result.tenant, email, true);
    }
  };

  return (
    <div>
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="Enter your email"
      />
      <button onClick={handleEmailSubmit}>Continue</button>
    </div>
  );
}
```

### Custom Tenant Selector

Create your own tenant selection interface:

```typescript
import { usePluginContext } from "@supertokens-plugins/tenant-discovery-react";

function CustomTenantSelector() {
  const { api, functions } = usePluginContext();
  const [tenants, setTenants] = useState([]);

  useEffect(() => {
    const loadTenants = async () => {
      const response = await api.fetchTenants();
      if (response.status === "OK") {
        setTenants(response.tenants);
      }
    };
    loadTenants();
  }, [api]);

  const handleTenantSelect = (tenantId: string) => {
    functions.setTenantId(tenantId, undefined, true);
    // Redirect to auth
    redirectToAuth({ queryParams: { tenantId } });
  };

  return (
    <div>
      <h2>Choose Your Organization</h2>
      {tenants.map((tenant) => (
        <button
          key={tenant.tenantId}
          onClick={() => handleTenantSelect(tenant.tenantId)}
        >
          {tenant.tenantId === 'public' ? 'Personal Account' : tenant.tenantId}
        </button>
      ))}
    </div>
  );
}
```

## Requirements

- SuperTokens React SDK >= 0.50.0
- SuperTokens Tenant Discovery Backend Plugin (recommended)
- Multi-tenancy must be properly configured

## Related

- [Tenant Discovery Backend Plugin](../tenant-discovery-nodejs/README.md) - Recommended backend companion
- [SuperTokens Multi-tenancy](https://supertokens.com/docs/multitenancy/introduction) - Multi-tenant setup guide

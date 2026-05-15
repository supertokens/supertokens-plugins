# SuperTokens Plugin Tenant Enrollment

Add tenant enrollment restrictions and validation to your SuperTokens React application.
This plugin provides user-friendly error handling and UI adjustments for tenant signup restrictions, including invite-only tenants, email domain validation, and identity provider restrictions.

## Installation

```bash
npm install @supertokens-plugins/tenant-enrollment-react
```

## Prerequisites

This plugin requires the backend tenant-enrollment plugin to be installed and configured:

```bash
npm install @supertokens-plugins/tenant-enrollment-nodejs
```

> [!IMPORTANT]
> The backend plugin `@supertokens-plugins/tenant-enrollment-nodejs` must be initialized in your SuperTokens Node.js backend configuration for this plugin to function properly.

## Quick Start

### Frontend Configuration

Initialize the plugin in your SuperTokens frontend configuration:

```typescript
import SuperTokens from "supertokens-auth-react";
import Session from "supertokens-auth-react/recipe/session";
import WebAuthn from "supertokens-auth-react/recipe/webauthn";
import Multitenancy from "supertokens-auth-react/recipe/multitenancy";
import TenantEnrollmentPlugin from "@supertokens-plugins/tenant-enrollment-react";

SuperTokens.init({
  appInfo: {
    appName: "Your App",
    apiDomain: "http://localhost:3001",
    websiteDomain: "http://localhost:3000",
    apiBasePath: "/auth",
    websiteBasePath: "/auth",
  },
  recipeList: [
    Session.init(),
    WebAuthn.init(),
    Multitenancy.init(),
    // your other recipes
  ],
  experimental: {
    plugins: [TenantEnrollmentPlugin.init()],
  },
});
```

## How It Works

The plugin automatically integrates with your SuperTokens authentication flow to:

1. **Detect tenant enrollment restrictions** from the backend
2. **Display user-friendly error messages** when signup is blocked
3. **Adjust the UI** based on tenant configuration (e.g., hide signup option for invite-only tenants)
4. **Handle authentication errors gracefully** without breaking the user experience

### Integration Points

The plugin works seamlessly with:

- **WebAuthn (Passkey) Authentication** - Catches and displays enrollment errors during passkey registration
- **Multitenancy Recipe** - Detects invite-only tenants and adjusts the UI accordingly
- **All Authentication Methods** - Works with EmailPassword, ThirdParty, Passwordless, and WebAuthn

## Features

### 1. Invite-Only Tenant Detection

The plugin automatically detects when a tenant is invite-only and adjusts the UI:

- Hides the "Sign Up" option from the authentication page
- Shows only the "Sign In" option
- Displays appropriate error messages if a user attempts to sign up

**How it works:**

- When the multitenancy recipe fetches login methods, the plugin checks for the `isTenantInviteOnly` flag
- If the tenant is invite-only, the authentication page header hides the signup switcher
- Users see a clean, simplified sign-in interface

### 2. Enrollment Error Handling

When a user attempts to sign up to a tenant they're not allowed to access, the plugin:

- **Catches the error** from the backend
- **Displays a user-friendly message** explaining why signup was blocked
- **Provides guidance** on how to proceed (e.g., contact tenant administrators)

**Supported Error Types:**

- **Invite-Only Tenant** - "This tenant is invite only and you cannot sign up"
- **Email Domain Restriction** - "Your email domain is not allowed to sign up"
- **Identity Provider Restriction** - "This tenant is invite only and you need to use an approved identity provider"

### 3. WebAuthn Error Display

For WebAuthn (passkey) authentication, the plugin enhances the error experience:

- Intercepts WebAuthn registration errors
- Checks if the error is related to tenant enrollment restrictions
- Displays a custom error message component
- Maintains the standard WebAuthn flow for allowed users

### 4. Seamless UI Integration

The plugin uses SuperTokens' component override system to:

- Maintain consistent styling with your authentication UI
- Integrate error messages naturally into the auth flow
- Preserve all standard SuperTokens functionality
- Support custom themes and styles

## Configuration Options

Currently, the plugin works with zero configuration. All enrollment rules are defined in the backend plugin.

```typescript
TenantEnrollmentPlugin.init();
```

### Advanced: Custom Component Overrides

You can customize the plugin's behavior by overriding components:

```typescript
TenantEnrollmentPlugin.init({
  override: (originalImplementation) => ({
    ...originalImplementation,
    // Add custom overrides here if needed in the future
  }),
});
```

## Error Messages

The plugin displays these error messages based on backend enrollment restrictions:

| Scenario                      | Error Message                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------ |
| Invite-only tenant            | "This tenant is invite only and you cannot sign up"                            |
| Email domain not allowed      | "Your email domain is not allowed to sign up"                                  |
| Identity provider not allowed | "This tenant is invite only and you need to use an approved identity provider" |

### Default Error Display

When an enrollment error occurs, users see:

**Header:** "Signing up to the tenant is disabled"

**Message:** "Signing up to this tenant is currently blocked. If you think this is a mistake, please reach out to tenant administrators or request an invitation to join the tenant."

### Customizing Error Messages

Error messages can be customized by providing translation overrides during SuperTokens initialization:

```typescript
SuperTokens.init({
  languageTranslations: {
    translations: {
      en: {
        PL_TE_SIGN_UP_BLOCKED_HEADER: "Access Restricted",
        PL_TE_SIGN_UP_BLOCKED_MESSAGE_HIGHLIGHT: "You cannot create an account for this tenant.",
        PL_TE_SIGN_UP_BLOCKED_MESSAGE_SUFFIX: "Please contact your administrator or use an approved sign-up method.",
      },
    },
    defaultLanguage: "en",
  },
  // ... rest of config
});
```

## Hooks and Utilities

### usePluginContext Hook

Access plugin context and translation functions:

```typescript
import { usePluginContext } from '@supertokens-plugins/tenant-enrollment-react';

function MyCustomComponent() {
  const { t, pluginConfig } = usePluginContext();

  return (
    <div>
      <h2>{t('PL_TE_SIGN_UP_BLOCKED_HEADER')}</h2>
      <p>{t('PL_TE_SIGN_UP_BLOCKED_MESSAGE_HIGHLIGHT')}</p>
    </div>
  );
}
```

### Available Translation Keys

| Key                                       | Default Value                                                                     |
| ----------------------------------------- | --------------------------------------------------------------------------------- |
| `PL_TE_SIGN_UP_BLOCKED_HEADER`            | "Signing up to the tenant is disabled"                                            |
| `PL_TE_SIGN_UP_BLOCKED_MESSAGE_HIGHLIGHT` | "Signing up to this tenant is currently blocked."                                 |
| `PL_TE_SIGN_UP_BLOCKED_MESSAGE_SUFFIX`    | "If you think this is a mistake, please reach out to tenant administrators or..." |

## Components

### ErrorMessage Component

The plugin exports an `ErrorMessage` component for displaying enrollment-related errors:

```typescript
import { ErrorMessage } from '@supertokens-plugins/tenant-enrollment-react';

function MyAuthPage() {
  const [errorMessage, setErrorMessage] = React.useState<string>('');

  return (
    <div>
      {errorMessage && <ErrorMessage message={errorMessage} />}
      {/* Your auth UI */}
    </div>
  );
}
```

**Props:**

- `message: string` - The error message to display

**Styling:**

The component uses semantic error colors from the SuperTokens theme and includes a 12px bottom margin for proper spacing.

## Authentication Flow Examples

### Example 1: Email Domain Validation

**Backend Configuration:**

```typescript
// Node.js backend
TenantEnrollmentPlugin.init({
  emailDomainToTenantIdMap: {
    "company.com": "tenant-acme",
  },
});
```

**User Experience:**

1. User navigates to `/auth?tenantId=tenant-acme`
2. User attempts to sign up with `user@gmail.com`
3. Plugin catches the error and displays: "Your email domain is not allowed to sign up"
4. User sees guidance to contact administrators or use the correct email domain

### Example 2: Invite-Only Tenant

**Backend Configuration:**

```typescript
// Node.js backend
TenantEnrollmentPlugin.init({
  inviteOnlyTenants: ["tenant-enterprise"],
});
```

**User Experience:**

1. User navigates to `/auth?tenantId=tenant-enterprise`
2. Plugin detects tenant is invite-only via login methods API
3. "Sign Up" switcher is automatically hidden
4. User only sees "Sign In" option
5. If user attempts signup anyway (e.g., direct API call), they see: "This tenant is invite only and you cannot sign up"

### Example 3: WebAuthn with Restrictions

**Backend Configuration:**

```typescript
// Node.js backend
TenantEnrollmentPlugin.init({
  emailDomainToTenantIdMap: {
    "verified.com": "tenant-verified",
  },
  inviteOnlyTenants: ["tenant-verified"],
});
```

**User Experience:**

1. User navigates to WebAuthn registration page for `tenant-verified`
2. Plugin detects invite-only status and hides signup option
3. If user tries to create a passkey with `user@other.com`, the plugin displays appropriate error
4. Error message is shown in the WebAuthn error component context

## Integration with Backend Plugin

This plugin works in tandem with `@supertokens-plugins/tenant-enrollment-nodejs`. Here's how they communicate:

### Backend Validation

The backend plugin validates signup attempts and returns specific error codes:

```typescript
// Backend plugin checks
if (isTenantInviteOnly(tenantId)) {
  throw new Error(NOT_ALLOWED_TO_SIGNUP_REASON_MESSAGE.INVITE_ONLY);
}

if (!isMatchingEmailDomain(tenantId, email)) {
  throw new Error(NOT_ALLOWED_TO_SIGNUP_REASON_MESSAGE.EMAIL_DOMAIN_NOT_ALLOWED);
}
```

### Frontend Handling

The React plugin catches these errors and displays them:

```typescript
// Frontend plugin intercepts
try {
  await WebAuthn.registerOptions(email);
} catch (error) {
  if (isSuperTokensGeneralError(error)) {
    // Display error message to user
    showErrorMessage(error.message);
  }
}
```

### Login Methods API

The backend injects tenant metadata into the login methods response:

```json
{
  "status": "OK",
  "firstFactors": ["emailpassword", "webauthn"],
  "isTenantInviteOnly": true
}
```

The React plugin reads this flag and adjusts the UI accordingly.

## Debug Logging

Enable debug logging to troubleshoot enrollment issues:

```typescript
import { enableDebugLogs } from "@supertokens-plugins/tenant-enrollment-react";

// Enable before SuperTokens.init()
enableDebugLogs();

SuperTokens.init({
  // ... your config
});
```

Debug logs include:

- Tenant invite-only status detection
- Error message parsing
- UI state changes
- Component overrides

## Use Cases

### Enterprise Multi-Tenant SaaS

**Scenario:** Only allow employees with company email addresses to sign up

**Configuration:**

Backend:

```typescript
TenantEnrollmentPlugin.init({
  emailDomainToTenantIdMap: {
    "acmecorp.com": "tenant-acme",
  },
});
```

Frontend:

```typescript
TenantEnrollmentPlugin.init();
```

**Result:** Users with `@acmecorp.com` can sign up to `tenant-acme`. Others see: "Your email domain is not allowed to sign up"

### Invite-Only Private Tenant

**Scenario:** Restrict tenant access to explicitly invited users

**Configuration:**

Backend:

```typescript
TenantEnrollmentPlugin.init({
  inviteOnlyTenants: ["tenant-private"],
});
```

Frontend:

```typescript
TenantEnrollmentPlugin.init();
```

**Result:**

- Signup option is hidden for `tenant-private`
- Unauthorized signup attempts show: "This tenant is invite only and you cannot sign up"
- Only users with valid invitations can proceed

### SAML-Only Tenant

**Scenario:** Enterprise tenant that only allows SAML SSO authentication

**Configuration:**

Backend:

```typescript
TenantEnrollmentPlugin.init({
  inviteOnlyTenants: ["tenant-enterprise"],
  // Backend automatically allows "boxy-saml-*" providers
});
```

Frontend:

```typescript
TenantEnrollmentPlugin.init();
```

**Result:**

- Email/password signup is hidden
- Google/GitHub OAuth is blocked
- Only SAML providers are allowed
- Non-SAML attempts show: "This tenant is invite only and you need to use an approved identity provider"

## Troubleshooting

### Error Messages Not Showing

**Check:**

1. Backend plugin is initialized in your Node.js app
2. Backend enrollment rules are configured correctly
3. Frontend plugin is initialized before authentication recipes
4. Browser console for any JavaScript errors

**Debug:**

```typescript
import { enableDebugLogs } from "@supertokens-plugins/tenant-enrollment-react";
enableDebugLogs();
```

### Signup Option Still Visible for Invite-Only Tenant

**Check:**

1. Backend `inviteOnlyTenants` array includes the tenant ID
2. Multitenancy recipe is initialized in frontend
3. Tenant ID is correctly passed in the URL: `/auth?tenantId=tenant-id`
4. Login methods API response includes `isTenantInviteOnly: true`

**Debug:**

Check the network tab for the login methods API call (`/auth/tenant-id/loginmethods`) and verify the response includes the `isTenantInviteOnly` flag.

### Error Messages in Wrong Language

**Solution:**

Override translations in SuperTokens config:

```typescript
SuperTokens.init({
  languageTranslations: {
    translations: {
      es: {
        PL_TE_SIGN_UP_BLOCKED_HEADER: "Registro deshabilitado",
        // ... other translations
      },
    },
    defaultLanguage: "es",
  },
});
```

### WebAuthn Errors Not Caught

**Check:**

1. WebAuthn recipe is initialized in frontend config
2. Plugin is initialized after authentication recipes
3. Backend returns errors with `isSuperTokensGeneralError: true`
4. Error messages match `NOT_ALLOWED_TO_SIGNUP_REASON_MESSAGE` values

## Browser Support

The plugin supports all modern browsers that support:

- React 18+
- ES2020+
- CSS custom properties
- SuperTokens auth-react

## TypeScript Support

The plugin is written in TypeScript and includes full type definitions:

```typescript
import TenantEnrollmentPlugin, { usePluginContext } from "@supertokens-plugins/tenant-enrollment-react";

// Fully typed
const { t, pluginConfig } = usePluginContext();
```

## Migration Guide

If you're adding this plugin to an existing application:

1. **Install the frontend plugin** - `npm install @supertokens-plugins/tenant-enrollment-react`
2. **Install the backend plugin** - `npm install @supertokens-plugins/tenant-enrollment-nodejs`
3. **Configure backend rules** - Set up `emailDomainToTenantIdMap`, `inviteOnlyTenants`, etc.
4. **Initialize frontend plugin** - Add to `experimental.plugins` array
5. **Test enrollment flows** - Verify error messages and UI changes work correctly
6. **Update user documentation** - Inform users of enrollment restrictions

**Backward Compatibility:**

- Existing users are not affected
- Plugin only affects new signup attempts
- No breaking changes to authentication flow

## License

See the main repository for license information.

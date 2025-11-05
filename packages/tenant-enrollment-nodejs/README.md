# SuperTokens Plugin Tenant Enrollment

Control and manage tenant signup enrollment rules for your SuperTokens Node.js backend.
This plugin provides comprehensive enrollment validation based on email domains, invite-only tenants, and approval workflows. It works seamlessly with all SuperTokens authentication recipes including EmailPassword, ThirdParty, Passwordless, and WebAuthn.

## Installation

```bash
npm install @supertokens-plugins/tenant-enrollment-nodejs
```

## Prerequisites

This plugin requires the tenants plugin to be installed and initialized:

```bash
npm install @supertokens-plugins/tenants-nodejs
```

> [!IMPORTANT]
> The tenants plugin must be initialized **before** the tenant-enrollment plugin in your SuperTokens configuration.

## Quick Start

### Backend Configuration

Initialize the plugin in your SuperTokens backend configuration:

```typescript
import SuperTokens from 'supertokens-node';
import Session from 'supertokens-node/recipe/session';
import EmailPassword from 'supertokens-node/recipe/emailpassword';
import UserRoles from 'supertokens-node/recipe/userroles';
import TenantsPlugin from '@supertokens-plugins/tenants-nodejs';
import TenantEnrollmentPlugin from '@supertokens-plugins/tenant-enrollment-nodejs';

SuperTokens.init({
  appInfo: {
    // your app info
  },
  recipeList: [
    Session.init({}),
    EmailPassword.init({}),
    UserRoles.init({}), // Required for role-based access control
    // your other recipes
  ],
  experimental: {
    plugins: [
      TenantsPlugin.init({
        // tenants plugin configuration
      }),
      TenantEnrollmentPlugin.init({
        emailDomainToTenantIdMap: {
          'company.com': 'tenant-1',
          'subsidiary.com': 'tenant-2',
        },
        inviteOnlyTenants: ['tenant-1'], // Optional
        requiresApprovalTenants: ['tenant-2'], // Optional
        allowSignUpToPublicTenant: false, // Optional
      }),
    ],
  },
});
```

> [!IMPORTANT]
> You may also want to install and configure the frontend plugin for the complete tenant enrollment experience with proper error messages and UI flows.

## Configuration Options

| Option                      | Type                     | Required | Description                                                                  |
| --------------------------- | ------------------------ | -------- | ---------------------------------------------------------------------------- |
| `emailDomainToTenantIdMap`  | `Record<string, string>` | Yes      | Maps email domains to tenant IDs for domain-based enrollment                 |
| `inviteOnlyTenants`         | `string[]`               | No       | List of tenant IDs that only accept invited users or approved SAML providers |
| `requiresApprovalTenants`   | `string[]`               | No       | List of tenant IDs where new signups require admin approval                  |
| `allowSignUpToPublicTenant` | `boolean`                | No       | Whether sign-up to `public` tenant is allowed or not. Defaults to allowed.   |

### Configuration Examples

#### Email Domain Validation Only

```typescript
TenantEnrollmentPlugin.init({
  emailDomainToTenantIdMap: {
    'company.com': 'tenant-company',
    'partner.com': 'tenant-partner',
  },
});
```

Users with `@company.com` email addresses can only sign up to `tenant-company`, and users with `@partner.com` can only sign up to `tenant-partner`.

#### Invite-Only Tenant

```typescript
TenantEnrollmentPlugin.init({
  emailDomainToTenantIdMap: {
    'enterprise.com': 'tenant-enterprise',
  },
  inviteOnlyTenants: ['tenant-enterprise'],
});
```

Users cannot sign up to `tenant-enterprise` unless they are invited to the tenant.

#### Approval-Required Tenant

```typescript
TenantEnrollmentPlugin.init({
  emailDomainToTenantIdMap: {
    'startup.com': 'tenant-startup',
  },
  requiresApprovalTenants: ['tenant-startup'],
});
```

Users with `@startup.com` email can sign up, but they won't be automatically added to the tenant. Instead, tenant admins will receive an email notification to approve the request.

#### Combined Configuration

```typescript
TenantEnrollmentPlugin.init({
  emailDomainToTenantIdMap: {
    'secure.com': 'tenant-secure',
    'open.com': 'tenant-open',
  },
  inviteOnlyTenants: ['tenant-secure'],
  requiresApprovalTenants: ['tenant-open'],
});
```

## How It Works

The tenant enrollment plugin works by intercepting signup attempts across all authentication recipes and applying enrollment rules:

### 1. Email Domain Validation

When a user tries to sign up to a tenant, the plugin checks if their email domain is allowed for that tenant:

```typescript
// User with user@company.com trying to sign up to tenant-1
emailDomainToTenantIdMap: {
  "company.com": "tenant-1",
  "other.com": "tenant-2",
}

// ✅ Allowed: user@company.com → tenant-1
// ❌ Blocked: user@company.com → tenant-2
// ❌ Blocked: user@other.com → tenant-1
```

**Features:**

- Case-insensitive domain matching
- Subdomain support (`user@sub.company.com` matches `company.com` mapping)
- Public tenant always bypasses validation

### 2. Invite-Only Tenant Logic

Prevents unauthorized signups to sensitive tenants:

```typescript
inviteOnlyTenants: ['tenant-1'];
```

**Allowed:**

- Users signing in (already exist in tenant)

**Blocked:**

- New sign-ups

### 3. Approval Workflow

Requires admin approval before granting tenant access:

```typescript
requiresApprovalTenants: ['tenant-1'];
```

**Workflow:**

1. User successfully signs up (creates account)
2. User is associated with the tenant but without a role (unable to access anything)
3. Email sent to all tenant admins (users with `tenant-admin` role)
4. Admin manually approves/rejects the request via tenant management UI
5. Upon approval, user is added to tenant with `tenant-member` role

## Authentication Recipe Support

The plugin automatically integrates with all SuperTokens authentication recipes:

### EmailPassword Recipe

Validates email domain before allowing signup:

```typescript
// Blocks signup if email domain doesn't match
const response = await EmailPassword.signUp('tenant-1', 'user@wrong.com', 'password');
// response.status === "GENERAL_ERROR"
// response.message === "Your email domain is not allowed to sign up"
```

### ThirdParty Recipe

Validates IdP provider and email domain:

```typescript
// OAuth providers (Google, GitHub, etc.)
// - Blocked in invite-only tenants
// - Validates email domain in non-invite-only tenants

// SAML providers (boxy-saml-*)
// - Allowed in invite-only tenants
// - Validates email domain in non-invite-only tenants
```

### Passwordless Recipe

Validates email domain for email-based authentication:

```typescript
// Email-based passwordless
// - Validates email domain

// Phone-based passwordless
// - Always allowed (no domain to validate)
```

### WebAuthn Recipe

Validates email domain before generating registration options:

```typescript
// Blocks registration if email domain doesn't match
await WebAuthn.generateRegistrationOptions({
  tenantId: 'tenant-1',
  email: 'user@wrong.com',
});
// Throws error: "Your email domain is not allowed to sign up"
```

## API Behavior

The plugin modifies API responses to include enrollment status information:

### Multitenancy Recipe - Login Methods

The plugin injects an `inviteOnly` flag into the login methods response:

**Request:**

```
GET /auth/tenant-1/loginmethods
```

**Response:**

```json
{
  "status": "OK",
  "firstFactors": ["emailpassword", "thirdparty"],
  "isTenantInviteOnly": true
}
```

This allows frontend applications to display appropriate messaging to users before they attempt to sign up.

## Error Messages

The plugin returns user-friendly error messages for different rejection reasons:

| Scenario                  | Error Message                                                                  |
| ------------------------- | ------------------------------------------------------------------------------ |
| Email domain not allowed  | "Your email domain is not allowed to sign up"                                  |
| Invite-only tenant        | "This tenant is invite only and you cannot sign up"                            |
| Non-approved IdP provider | "This tenant is invite only and you need to use an approved identity provider" |

## Advanced Configuration

### Custom Implementation Override

You can override default behaviors by providing custom implementations:

```typescript
TenantEnrollmentPlugin.init({
  emailDomainToTenantIdMap: {
    'company.com': 'tenant-1',
  },
  override: {
    functions: (originalImplementation) => ({
      ...originalImplementation,

      // Custom logic to check if user can join tenant
      canUserJoinTenant: async (tenantId, userIdentificationDetail) => {
        // Add custom validation logic
        if (userIdentificationDetail.type === 'email') {
          // Check against custom database or API
          const isAllowed = await checkCustomRules(userIdentificationDetail.email);
          if (!isAllowed) {
            return {
              canJoin: false,
              reason: 'Custom rejection reason',
            };
          }
        }

        // Fall back to default implementation
        return originalImplementation.canUserJoinTenant(tenantId, userIdentificationDetail);
      },

      // Custom approval workflow logic
      handleTenantJoiningApproval: async (
        user,
        tenantId,
        associateLoginMethodDef,
        sendEmail,
        appUrl,
        userContext,
        assignRoleToUserInTenant,
      ) => {
        // Custom logic before approval
        await logTenantJoinAttempt(user, tenantId);

        // Call default implementation
        return originalImplementation.handleTenantJoiningApproval(
          user,
          tenantId,
          associateLoginMethodDef,
          sendEmail,
          appUrl,
          userContext,
          assignRoleToUserInTenant,
        );
      },

      // Custom email domain matching logic
      isMatchingEmailDomain: (tenantId, email) => {
        // Add custom domain matching logic (e.g., wildcard support)
        return customDomainMatcher(tenantId, email);
      },
    }),
  },
});
```

### Available Override Functions

| Function                        | Description                                                       | Returns                                                   |
| ------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------- |
| `canUserJoinTenant`             | Determine if user can join a tenant based on their identification | `Promise<{ canJoin: boolean, reason?: string }>`          |
| `handleTenantJoiningApproval`   | Handle post-signup approval workflow                              | `Promise<{ wasAddedToTenant: boolean, reason?: string }>` |
| `isTenantInviteOnly`            | Check if tenant is invite-only                                    | `boolean`                                                 |
| `doesTenantRequireApproval`     | Check if tenant requires approval                                 | `boolean`                                                 |
| `isApprovedIdPProvider`         | Validate if IdP provider is approved (SAML)                       | `boolean`                                                 |
| `isMatchingEmailDomain`         | Check if email domain matches tenant                              | `boolean`                                                 |
| `sendTenantJoiningRequestEmail` | Send approval request email to admins                             | `Promise<void>`                                           |
| `isUserSigningUpToTenant`       | Determine if user is signing up vs signing in                     | `Promise<boolean>`                                        |
| `getMessageForNoSignUpReason`   | Get user-friendly error message for rejection                     | `string`                                                  |

## Email Notifications

When a user signs up to a tenant that requires approval, the plugin sends an email notification to all tenant admins.

### Email Type: TENANT_REQUEST_APPROVAL

**Sent to:** All users with `tenant-admin` role in the target tenant

**Email Content:**

- User information (email, name)
- Tenant information
- Link to admin dashboard to approve/reject the request

**Customizing Email Delivery:**

Email delivery is handled by the base tenants plugin. Configure it in your `TenantsPlugin.init()`:

```typescript
import { PluginSMTPService } from '@supertokens-plugins/tenants-nodejs';

TenantsPlugin.init({
  emailDelivery: {
    service: new PluginSMTPService({
      smtpSettings: {
        host: 'smtp.example.com',
        port: 587,
        from: {
          name: 'Your App',
          email: 'noreply@example.com',
        },
        secure: false,
        authUsername: 'username',
        password: 'password',
      },
    }),
  },
});
```

## Use Cases

### Enterprise Multi-Tenant SaaS

```typescript
TenantEnrollmentPlugin.init({
  emailDomainToTenantIdMap: {
    'acme.com': 'tenant-acme',
    'globex.com': 'tenant-globex',
  },
  inviteOnlyTenants: ['tenant-acme'],
});
```

- Acme Corp employees can only use their work email
- Acme is invite-only to prevent unauthorized signups
- Globex employees can sign up freely with company email

### Managed Service Provider

```typescript
TenantEnrollmentPlugin.init({
  emailDomainToTenantIdMap: {
    'client1.com': 'tenant-client1',
    'client2.com': 'tenant-client2',
  },
  requiresApprovalTenants: ['tenant-client1', 'tenant-client2'],
});
```

- Each client has their own tenant
- All signups require MSP admin approval
- Domain validation ensures users sign up to correct tenant

### Freemium to Enterprise

```typescript
TenantEnrollmentPlugin.init({
  emailDomainToTenantIdMap: {
    'premium-corp.com': 'tenant-premium',
  },
  requiresApprovalTenants: ['tenant-premium'],
});
```

- Free tier: Public tenant (no restrictions)
- Premium tier: Domain-validated with approval workflow
- Ensures paid customers are verified before access

## Public Tenant Behavior

The `public` tenant always bypasses all enrollment rules:

- No email domain validation
- No invite-only restrictions
- No approval workflow

This ensures users can always sign up to your application's default tenant without restrictions.

## Testing

The plugin includes comprehensive test coverage with 43 test cases. Run tests with:

```bash
npm test
```

Tests require a running SuperTokens core instance. Configure using environment variables:

- `CORE_BASE_URL`: SuperTokens core URL (default: `http://localhost:3567`)
- `CORE_API_KEY`: API key for core authentication (if required)
- `PORT`: Test server port (default: `3000`)

### Running SuperTokens Core for Testing

```bash
# Using Docker
docker run -p 3567:3567 -d registry.supertokens.io/supertokens/supertokens-postgresql

# Then run tests
npm test
```

## Troubleshooting

### Users Can't Sign Up to Tenant

**Check:**

1. Email domain is correctly mapped in `emailDomainToTenantIdMap`
2. Tenant is not in `inviteOnlyTenants` (unless using SAML)
3. Tenant exists in SuperTokens Core

### Approval Emails Not Sending

**Check:**

1. Email delivery is configured in `TenantsPlugin.init()`
2. At least one user has `tenant-admin` role in target tenant
3. SMTP settings are correct

### Third-Party Login Blocked

**Check:**

1. If tenant is invite-only, only SAML providers (`boxy-saml-*`) are allowed
2. Email domain from OAuth provider matches `emailDomainToTenantIdMap`

## Migration Guide

If you're adding this plugin to an existing application:

1. **Existing users are not affected** - Enrollment rules only apply to new signups
2. **Plan your domain mapping** - Map all tenant-specific email domains
3. **Test approval workflow** - Ensure admin users exist before enabling `requiresApprovalTenants`
4. **Communicate changes** - Inform users of new signup restrictions

## License

See the main repository for license information.

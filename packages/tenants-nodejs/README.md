# @supertokens-plugin-profile/tenants-backend

Backend plugin for tenant management in SuperTokens Plugin Profile system.

## Features

- Tenant registration and management
- User-tenant membership handling
- Multi-tenant user data isolation
- Tenant switching functionality

## API Endpoints

- `GET /plugin/supertokens-plugin-profile-tenants/tenants` - List all available tenants
- `GET /plugin/supertokens-plugin-profile-tenants/user-tenants` - Get user's tenant memberships
- `POST /plugin/supertokens-plugin-profile-tenants/join-tenant` - Add user to a tenant
- `POST /plugin/supertokens-plugin-profile-tenants/leave-tenant` - Remove user from a tenant
- `POST /plugin/supertokens-plugin-profile-tenants/set-current-tenant` - Set user's current active tenant

## Usage

```typescript
import { init } from '@supertokens-plugin-profile/tenants-backend';

const tenantPlugin = init();
```
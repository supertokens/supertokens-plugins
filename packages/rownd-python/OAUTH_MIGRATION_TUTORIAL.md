# Rownd OAuth Migration Tutorial

This guide explains how to migrate OAuth/OIDC clients from Rownd to the SuperTokens OAuth2 Provider model when the application already uses:

- A frontend app using the SuperTokens Rownd Hub compatibility layer.
- A backend using `supertokens_python`.
- The `supertokens-rownd` plugin.

The migration has two owners:

- Application developers update OAuth client configuration to use SuperTokens endpoints.
- The SuperTokens team migrates Rownd OAuth clients into SuperTokens Core.

Application developers should not create or update OAuth clients directly unless instructed by the SuperTokens team.

## What Changes

Rownd exposes OAuth/OIDC provider endpoints under app-specific URLs:

```txt
https://api.rownd.io/oidc/{rowndAppId}/...
```

SuperTokens exposes OAuth/OIDC provider endpoints under your backend API domain and `api_base_path`.

For a backend configured with `api_domain=https://api.example.com` and `api_base_path=/auth`, the new discovery URL is:

```txt
https://api.example.com/auth/.well-known/openid-configuration
```

OAuth clients should use the endpoints returned by SuperTokens discovery instead of hardcoding endpoint paths.

## Application Developer Steps

### 1. Initialize OAuth2 Provider

Your Python backend must initialize the SuperTokens OAuth2 Provider recipe before enabling Rownd OAuth compatibility:

```python
from supertokens_python.recipe import oauth2provider

recipe_list=[
    session.init(),
    oauth2provider.init(),
    # other recipes...
]
```

The Rownd plugin overrides this recipe to add Rownd-compatible scopes, claims, and `resource=app:*` handling.

### 2. Replace The Discovery URL

Replace the Rownd discovery URL:

```txt
https://api.rownd.io/oidc/{rowndAppId}/.well-known/openid-configuration
```

with the SuperTokens discovery URL:

```txt
https://api.example.com/auth/.well-known/openid-configuration
```

Use your actual backend API domain and `api_base_path`.

### 3. Replace Hardcoded OAuth Endpoints

If your OAuth client does not support discovery and uses hardcoded endpoints, update them as follows.

| Rownd endpoint                                   | SuperTokens endpoint                     |
| ------------------------------------------------ | ---------------------------------------- |
| `/oidc/{appId}/.well-known/openid-configuration` | `/auth/.well-known/openid-configuration` |
| `/oidc/{appId}/auth`                             | `/auth/oauth/auth`                       |
| `/oidc/{appId}/token`                            | `/auth/oauth/token`                      |
| `/oidc/{appId}/me`                               | `/auth/oauth/userinfo`                   |
| `/oidc/{appId}/jwks`                             | `/auth/jwt/jwks.json`                    |
| `/oidc/{appId}/token/introspection`              | `/auth/oauth/introspect`                 |
| `/oidc/{appId}/token/revocation`                 | `/auth/oauth/revoke`                     |
| `/oidc/{appId}/session/end`                      | `/auth/oauth/end_session`                |

Replace `/auth` if your backend uses a different `api_base_path`.

### 4. Use The Migrated `client_id`

Continue using the OAuth credential `client_id` and `client_secret` provided by Rownd and migrated by the SuperTokens team.

Do not use the Rownd OIDC client configuration `id` as the OAuth `client_id`.

If your previous configuration used an identifier beginning with `oc_`, replace it with the migrated OAuth credential `client_id` supplied by the SuperTokens team.

### 5. Keep The Same Redirect URLs

The SuperTokens team will migrate the existing Rownd redirect URLs into SuperTokens.

For example, these Rownd redirect URLs remain valid after migration if they are migrated into the SuperTokens OAuth client:

```txt
https://cliend-domain.com/oauth2/callback
```

If you need to add or remove redirect URLs, coordinate with the SuperTokens team.

### 6. Expect New Tokens

Existing Rownd-issued OAuth tokens should not be treated as SuperTokens tokens.

After cutover, users should complete a new OAuth authorization flow against SuperTokens. This gives the OAuth client new SuperTokens-issued access tokens, ID tokens, and refresh tokens.

Existing short-lived Rownd access tokens can be allowed to expire naturally. Refresh-token migration requires separate SuperTokens Core/SDK support and should not be assumed unless explicitly enabled for the migration.

### 7. Validate The New Flow

Check discovery:

```bash
curl https://api.example.com/auth/.well-known/openid-configuration
```

Check JWKS:

```bash
curl https://api.example.com/auth/jwt/jwks.json
```

Start an authorization-code flow in a browser:

```txt
https://api.example.com/auth/oauth/auth?client_id=CLIENT_ID&redirect_uri=REDIRECT_URI&response_type=code&scope=openid%20profile%20email%20phone%20offline_access
```

Exchange the authorization code:

```bash
curl -X POST https://api.example.com/auth/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -u "CLIENT_ID:CLIENT_SECRET" \
  -d "grant_type=authorization_code" \
  -d "code=AUTH_CODE" \
  -d "redirect_uri=REDIRECT_URI"
```

Fetch userinfo:

```bash
curl https://api.example.com/auth/oauth/userinfo \
  -H "Authorization: Bearer ACCESS_TOKEN"
```

## Known Behavior Changes

### Issuer Changes

Rownd issuer:

```txt
https://api.rownd.io/oidc/{rowndAppId}
```

SuperTokens issuer:

```txt
https://api.example.com/auth
```

OAuth clients and resource servers must trust the new issuer.

### JWKS And Signing Algorithm Change

Rownd and SuperTokens use different signing keys and may advertise different signing algorithms.

OAuth clients should use SuperTokens discovery and JWKS instead of pinning Rownd keys or algorithms.

### Existing Tokens Are Not Equivalent

Rownd-issued access tokens and refresh tokens are not SuperTokens-issued OAuth tokens.

Plan for reauthorization unless the SuperTokens team explicitly enables token migration.

### Client IDs Use Rownd Credentials

The migrated OAuth `client_id` is the Rownd credential `client_id`, not the Rownd OIDC client configuration `id`.

## Cutover Checklist

Application developers:

- Initialize `oauth2provider.init()` in the Python backend.
- Update OAuth discovery URL to the SuperTokens backend.
- Update hardcoded OAuth endpoints if discovery is not supported.
- Confirm the configured `client_id` is the migrated credential `client_id`.
- Run an authorization-code flow against SuperTokens.
- Verify token exchange succeeds.
- Verify userinfo returns expected `email`, `phone_number`, and profile claims.

SuperTokens team:

- Migrate Rownd OAuth clients into SuperTokens Core.
- Preserve client ID, client secret, scopes, redirect URIs, and token auth method.
- Verify `client_secret_basic` clients can exchange codes.
- Verify `openid profile email phone offline_access` works.
- Verify `resource=app:{rowndAppId}` behavior if the OAuth client uses it.
- Confirm whether reauthorization is acceptable or a token migration path is required.

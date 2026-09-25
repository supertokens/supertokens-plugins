# Rownd OAuth Migration Tutorial

This guide explains how to migrate OAuth/OIDC clients from Rownd to the SuperTokens OAuth2 provider model when the application already uses:

- A frontend app using the SuperTokens Rownd Hub compatibility layer.
- A backend using `supertokens-node`.
- The `@supertokens-plugins/rownd-nodejs` plugin.

The migration has two owners:

- Application developers update OAuth client configuration to use SuperTokens endpoints.
- The SuperTokens team migrates Rownd OAuth clients into SuperTokens Core.

Application developers should not create or update OAuth clients directly unless instructed by the SuperTokens team.

## What Changes

Rownd exposes OAuth/OIDC provider endpoints under app-specific URLs:

```txt
https://api.rownd.io/oidc/{rowndAppId}/...
```

SuperTokens exposes OAuth/OIDC provider endpoints under your backend API domain and `apiBasePath`.

For a backend configured with `apiDomain=https://api.example.com` and `apiBasePath=/auth`, the new discovery URL is:

```txt
https://api.example.com/auth/.well-known/openid-configuration
```

OAuth clients should use the endpoints returned by SuperTokens discovery instead of hardcoding endpoint paths.

## Application Developer Steps

### 1. Replace The Discovery URL

Replace the Rownd discovery URL:

```txt
https://api.rownd.io/oidc/{rowndAppId}/.well-known/openid-configuration
```

with the SuperTokens discovery URL:

```txt
https://api.example.com/auth/.well-known/openid-configuration
```

Use your actual backend API domain and `apiBasePath`.

### 2. Replace Hardcoded OAuth Endpoints

If your OAuth client does not support discovery and uses hardcoded endpoints, update them as follows.

| Rownd endpoint | SuperTokens endpoint |
| --- | --- |
| `/oidc/{appId}/.well-known/openid-configuration` | `/auth/.well-known/openid-configuration` |
| `/oidc/{appId}/auth` | `/auth/oauth/auth` |
| `/oidc/{appId}/token` | `/auth/oauth/token` |
| `/oidc/{appId}/me` or Rownd userinfo endpoint | `/auth/oauth/userinfo` |
| `/oidc/{appId}/jwks` | `/auth/jwt/jwks.json` |
| `/oidc/{appId}/token/introspection` | `/auth/oauth/introspect` |
| `/oidc/{appId}/token/revocation` | `/auth/oauth/revoke` |
| `/oidc/{appId}/session/end` | `/auth/oauth/end_session` |

Replace `/auth` if your backend uses a different `apiBasePath`.

### 3. Use The Migrated `client_id`

Continue using the OAuth credential `client_id` and `client_secret` provided by Rownd and migrated by the SuperTokens team.

Do not use the Rownd OIDC client configuration `id` as the OAuth `client_id`.

If your previous configuration used an identifier beginning with `oc_`, replace it with the migrated OAuth credential `client_id` supplied by the SuperTokens team.

### 4. Keep The Same Redirect URLs

The SuperTokens team will migrate the existing Rownd redirect URLs into SuperTokens.

For example, these Rownd redirect URLs remain valid after migration if they are migrated into the SuperTokens OAuth client:

```txt
https://sandboxx.circle.so/oauth2/callback
https://community.sandboxx.us/oauth2/callback
https://community.waypointsapp.us/oauth2/callback
```

If you need to add or remove redirect URLs, coordinate with the SuperTokens team.

### 5. Expect New Tokens

Existing Rownd-issued OAuth tokens should not be treated as SuperTokens tokens.

After cutover, users should complete a new OAuth authorization flow against SuperTokens. This gives the OAuth client new SuperTokens-issued access tokens, ID tokens, and refresh tokens.

Existing short-lived Rownd access tokens can be allowed to expire naturally. Refresh-token migration requires separate SuperTokens Core/SDK support and should not be assumed unless explicitly enabled for the migration.

### 6. Validate The New Flow

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

## SuperTokens Team Steps

The SuperTokens team owns OAuth client migration.

### 1. Migrate Rownd OIDC Clients

Use the `rownd-nodejs setup-core` helper or equivalent internal tooling to fetch Rownd OIDC clients and create matching SuperTokens OAuth clients.

The migration should create one SuperTokens OAuth client per Rownd credential.

Use this mapping:

| Rownd field | SuperTokens field |
| --- | --- |
| `credentials[].client_id` | `clientId` |
| `credentials[].secret` | `clientSecret` |
| `name` | `clientName` |
| `config.redirect_uris` | `redirectUris` |
| `config.post_logout_uris` | `postLogoutRedirectUris` |
| `config.allowed_scopes.join(" ")` | `scope` |
| `config.token_endpoint_auth_method` | `tokenEndpointAuthMethod` |
| `id` | `metadata.rowndOidcClientId` |
| `credentials[].app_variant_id` | `metadata.rowndAppVariantId` |

Do not use the Rownd OIDC client configuration `id` as the SuperTokens OAuth `clientId`.

### 2. Preserve Rownd Defaults

If Rownd omits `token_endpoint_auth_method`, use Rownd's default:

```txt
client_secret_basic
```

This is important for clients that authenticate at the token endpoint with HTTP Basic auth.

For the known Sandboxx and Waypoints community clients, the expected migrated settings are:

```txt
tokenEndpointAuthMethod = client_secret_basic
scope = openid profile email phone offline_access
grantTypes = authorization_code, refresh_token, client_credentials, implicit
responseTypes = code, token, id_token
```

### 3. Preserve Rownd Metadata

Store Rownd metadata on the SuperTokens OAuth client for debugging and auditability:

```json
{
  "rowndOidcClientId": "<rownd_oidc_client_id>",
  "rowndAppVariantId": "<rownd_app_variant_id>",
  "rowndAllowedScopes": ["openid", "profile", "email", "phone", "offline_access"],
  "rowndApplicationType": "web",
  "rowndIsPkceRequired": false,
  "rowndIsPkceSupported": true,
  "rowndDeviceFlowEnabled": false
}
```

### 4. Preserve Audience Support

The setup helper configures the migrated OAuth client with:

```txt
audience = app:{rowndAppId}
```

The plugin also translates OAuth requests using:

```txt
resource=app:{rowndAppId}
```

into SuperTokens audience input and adds the Rownd-compatible audience claim when requested.

### 5. Rely On Plugin Claim Compatibility

The `rownd-nodejs` plugin adds compatibility for Rownd/OIDC scopes and claims through OAuth2Provider overrides.

Supported compatibility behavior includes:

- `email` scope emits `email` and `email_verified`.
- `phone` scope emits `phone_number` and `phone_number_verified`.
- `profile` scope emits `name`, `given_name`, `family_name`, and `updated_at` when available.
- Rownd session compatibility claims are added to OAuth token payloads.
- Rownd claims from access tokens are exposed through userinfo where relevant.

### 6. Token Migration Policy

Do not promise refresh-token migration unless a dedicated SuperTokens Core/SDK migration path is available.

Recommended policy:

- Let existing Rownd access tokens expire naturally.
- Require users to reauthorize after cutover.
- Issue new SuperTokens OAuth tokens through the normal authorization-code flow.

If zero-downtime refresh-token continuity is required, implement and validate a separate migration path before customer cutover.

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

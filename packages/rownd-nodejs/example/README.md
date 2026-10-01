# Rownd + SuperTokens Backend Example

This is a backend-only example for using `@supertokens-plugins/rownd-nodejs` in a SuperTokens Node.js app.

It is intentionally limited to the backend pieces from a typical `create-supertokens-app` setup. Add your own frontend separately, or point an existing Rownd-enabled frontend at this backend.

## Run

```bash
npm install
cp .env.example .env
npm run dev
```

Start a SuperTokens Core locally before running the backend:

```bash
docker run -p 127.0.0.1:3567:3567 supertokens/supertokens-postgresql
```

Do not expose SuperTokens Core directly to the public internet. Use `SUPERTOKENS_API_KEY` for any non-local Core instance.

## Required Environment

- `SUPERTOKENS_CONNECTION_URI`: SuperTokens Core URL.
- `SUPERTOKENS_API_KEY`: Optional for local-only demos. Required for any shared or deployed Core instance.
- `APP_NAME`: SuperTokens app name.
- `API_DOMAIN`: Backend origin, for example `http://localhost:3001`.
- `WEBSITE_DOMAIN`: Frontend origin, for example `http://localhost:3000`.
- `API_BASE_PATH`: SuperTokens API base path. Defaults to `/auth`.
- `ROWND_APP_KEY`: Rownd app key.
- `ROWND_APP_SECRET`: Rownd app secret.
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`: Google OAuth credentials.
- `APPLE_CLIENT_ID` and `APPLE_CLIENT_SECRET`: Apple OAuth credentials.

## Recipes Initialized

- `Session`
- `UserMetadata`
- `Passwordless` with email or phone magic links
- `ThirdParty` with Google and Apple providers
- `EmailVerification`
- `AccountLinking`
- Rownd migration plugin via `experimental.plugins`

## Useful Routes

- `POST /auth/plugin/rownd/migrate`: Migrates a Rownd-authenticated user into SuperTokens. Send `Authorization: Bearer <rownd-access-token>`.
- `POST /auth/plugin/rownd/guest`: Creates an anonymous or guest SuperTokens session.
- `GET /auth/plugin/rownd/app-config`: Returns Rownd-compatible app config derived from this backend setup.
- `GET /sessioninfo`: Local debugging route showing the current SuperTokens user ID.

For production, add rate limits and abuse protection around migration and guest session endpoints. Review `AccountLinking.init` before enabling automatic account linking for your app; only link trusted, verified identifiers.

# Rownd + SuperTokens Python React Example

This example runs a Vite React frontend against a SuperTokens Python FastAPI backend using `supertokens-rownd`.

The frontend uses `@supertokens/rownd-react`. The backend initializes `Passwordless`, `ThirdParty`, `EmailVerification`, `AccountLinking`, and the Rownd plugin.

## Run

Start a SuperTokens Core locally:

```bash
docker run -p 127.0.0.1:3567:3567 supertokens/supertokens-postgresql
```

Configure the backend:

```bash
uv sync
cp .env.example .env
```

Fill in `.env`, then start the backend:

```bash
uv run --env-file .env uvicorn src.main:app --reload --host 0.0.0.0 --port 3001
```

Start the frontend in another terminal:

```bash
cd frontend
npm install
npm run dev
```

Do not expose SuperTokens Core directly to the public internet. Use `SUPERTOKENS_API_KEY` for any non-local Core instance.

## URLs

- Frontend: `http://localhost:5173`
- Backend health: `http://localhost:3001/health`
- Backend bootstrap: `http://localhost:3001/example-bootstrap`
- Rownd app config: `http://localhost:3001/auth/plugin/rownd/app-config`

## Required Environment

- `SUPERTOKENS_CONNECTION_URI`: SuperTokens Core URL.
- `SUPERTOKENS_API_KEY`: Optional for local-only demos. Required for any shared or deployed Core instance.
- `APP_NAME`: SuperTokens app name.
- `API_DOMAIN`: Backend origin, for example `http://localhost:3001`.
- `WEBSITE_DOMAIN`: Primary frontend origin, for example `http://localhost:5173`.
- `CORS_ALLOWED_ORIGINS`: Comma-separated origins allowed by CORS, for example `http://localhost:5173,http://127.0.0.1:5173`.
- `API_BASE_PATH`: SuperTokens API base path. Defaults to `/auth`.
- `EXAMPLE_HUB_BASE_URL`: Hub base URL. Defaults to `https://rownd-hub.supertokens.com`.
- `ROWND_APP_KEY`: Rownd app key.
- `ROWND_APP_SECRET`: Rownd app secret.
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`: Google OAuth credentials.
- `APPLE_CLIENT_ID` and `APPLE_CLIENT_SECRET`: Apple OAuth credentials.

## OAuth Setup

For Google local testing, add `http://localhost:5173` to allowed JavaScript origins in Google Cloud. Configure redirect URIs for the Rownd/SuperTokens callback URLs used by your Rownd app and backend domain.

If you need multiple frontend domains, keep `WEBSITE_DOMAIN` as one primary domain and add all browser origins to `CORS_ALLOWED_ORIGINS`. For a production multi-domain setup, use SuperTokens `InputAppInfo.origin` instead of `website_domain`.

Apple is enabled in the backend config and requires real Apple service credentials. Remove the Apple provider and sign-in method from `src/main.py` if you only want to test email, phone, Google, and guest flows locally.

## Recipes Initialized

- `Session`
- `UserMetadata`
- `Passwordless` with email or phone magic links
- `ThirdParty` with Google and Apple providers
- `EmailVerification`
- `AccountLinking`
- Rownd migration plugin via `experimental.plugins`

## Useful Routes

- `GET /example-bootstrap`: Frontend bootstrap config for `@supertokens/rownd-react`.
- `GET /test/protected`: Protected debug route that returns the SuperTokens user ID and access-token payload.
- `POST /auth/plugin/rownd/migrate`: Migrates a Rownd-authenticated user into SuperTokens. Send `Authorization: Bearer <rownd-access-token>`.
- `POST /auth/plugin/rownd/guest`: Creates an anonymous or guest SuperTokens session.
- `GET /auth/plugin/rownd/app-config`: Returns Rownd-compatible app config derived from this backend setup.
- `GET /sessioninfo`: Local debugging route showing the current SuperTokens user ID.

For production, add rate limits and abuse protection around migration and guest session endpoints. Review `accountlinking.init` before enabling automatic account linking for your app; only link trusted, verified identifiers.

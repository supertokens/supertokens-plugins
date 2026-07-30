# SuperTokens Rownd Python Plugin

Rownd migration plugin for `supertokens_python`.

This package is managed by Turborepo through `package.json`, but published as a Python package named `supertokens-rownd`.

## Installation

Install from PyPI:

```bash
pip install supertokens-rownd
```

With `uv`:

```bash
uv add supertokens-rownd
```

For local development, install from this repository checkout with `uv sync --dev`.

## Local Development

```bash
cd packages/rownd-python
uv sync --dev
uv run python -m build
uv run pytest
```

From the repository root, Turborepo can run the Python package tasks because this directory has a `package.json` workspace adapter:

```bash
npm run build -- --filter=@supertokens-plugins/rownd-python
npm run test -- --filter=@supertokens-plugins/rownd-python
```

## Usage

```python
from supertokens_python import (
    InputAppInfo,
    SupertokensConfig,
    SupertokensExperimentalConfig,
    init,
)
from supertokens_python.recipe import accountlinking, emailverification, passwordless, session, thirdparty, usermetadata
from supertokens_rownd import init as RowndMigrationPlugin

init(
    app_info=InputAppInfo(
        app_name="My App",
        api_domain="https://api.example.com",
        website_domain="https://example.com",
        api_base_path="/auth",
    ),
    framework="fastapi",
    supertokens_config=SupertokensConfig(
        connection_uri="https://try.supertokens.com",
    ),
    recipe_list=[
        accountlinking.init(),
        session.init(),
        usermetadata.init(),
        passwordless.init(
            contact_config=passwordless.ContactEmailOrPhoneConfig(),
            flow_type="MAGIC_LINK",
        ),
        emailverification.init(mode="OPTIONAL"),
        thirdparty.init(sign_in_and_up_feature=thirdparty.SignInAndUpFeature(providers=[])),
    ],
    experimental=SupertokensExperimentalConfig(
        plugins=[
            RowndMigrationPlugin(
                rownd_app_key="rownd_app_key",
                rownd_app_secret="rownd_app_secret",
                # Must match InputAppInfo.api_base_path.
                api_base_path="/auth",
                # Should match InputAppInfo.api_domain.
                api_domain="https://api.example.com",
                # Should match InputAppInfo.website_domain when using passwordless confirmation bypass.
                website_domain="https://example.com",
                app_name="My App",
            )
        ]
    ),
)
```

## Routes

The plugin registers these routes below `api_base_path`:

- `GET /plugin/rownd/app-config`
- `POST /plugin/rownd/guest`
- `POST /plugin/rownd/migrate`
- `POST /plugin/migrate-session`
- `POST /plugin/passwordless-cross-device-confirmation/validate`
- `POST /plugin/rownd/signout`

Migration and guest routes accept an optional `tenantId` query parameter and default to `public`. Compatibility user views, sessions, and pending email verification are scoped to that tenant; user metadata remains shared across tenant memberships.

After all Rownd users have migrated, retain the compatibility routes without Rownd credentials by configuring `disable_rownd_user_migration=True`. This removes both migration routes; when no app key is configured, it uses an internal app key for passwordless and verification-link rewriting.

Passwordless resend requests preserve Rownd display, redirect, client-domain, app-variant, and OAuth context. Combined OTP and magic-link deliveries add the Hub `passwordlessFlowType=USER_INPUT_CODE_AND_MAGIC_LINK` parameter; OTP-only deliveries are left unchanged.
- `GET /plugin/rownd/user`
- `PUT /plugin/rownd/user`
- `DELETE /plugin/rownd/user`
- `GET /plugin/rownd/user/meta`
- `PUT /plugin/rownd/user/meta`
- `GET /plugin/rownd/user/field`
- `PUT /plugin/rownd/user/field`

## Rownd Compatibility

The plugin exposes Rownd-compatible user/session behavior for migrated and new SuperTokens users:

- Guest sessions use the `guest` third-party provider.
- Instant sessions use the `instant` third-party provider and preserve `auth_level: "instant"`.
- Google and Apple third-party login methods are exposed as `google_id` and `apple_id` in Rownd-compatible user payloads.
- OAuth2 Provider tokens and userinfo responses include Rownd claims plus standard `email`, `phone`, and `profile` claims when those scopes are requested.
- OAuth2 `resource=app:*` requests are translated to SuperTokens `audience=app:*` for Rownd-compatible OAuth clients.
- Rownd compatibility user routes ignore the global email verification claim validator so instant users can update email fields even when email verification is required.

### Passwordless Confirmation Bypass

Use `create_magic_link_with_confirmation_bypass` when your backend needs to create a passwordless magic link that can be opened on a different device without showing the SuperTokens cross-device confirmation prompt.
This is intended for trusted server-side flows only.

First, configure the exact post-login paths that may use the bypass:

```python
from supertokens_rownd import RowndPluginConfig

rownd_plugin_config = RowndPluginConfig(
    rownd_app_key="rownd_app_key",
    rownd_app_secret="rownd_app_secret",
    api_base_path="/auth",
    api_domain="https://api.example.com",
    website_domain="https://example.com",
    client_domains={"browser": "https://app.example.com"},
    cross_device_confirmation_bypass={
        "allowed_redirect_paths": ["/profile", "/settings/security"],
    },
)
```

Then call the helper from your backend after SuperTokens has been initialized with the Rownd plugin:

```python
from supertokens_rownd import create_magic_link_with_confirmation_bypass

magic_link = await create_magic_link_with_confirmation_bypass(
    email="user@example.com",
    client_domain="browser",
    redirect_to_path="/profile",
    display_context="browser",
)
```

`redirect_to_path` is required and must match `cross_device_confirmation_bypass.allowed_redirect_paths` exactly after normalization. Absolute URLs are accepted only when their origin matches the resolved `client_domain`; they are normalized back to a relative path before being added to the magic link.

`client_domain` must be a configured `client_domains` key, not a raw domain. Omit it to use `website_domain`.

Pass exactly one of `email` or `phone_number`. The helper returns the rewritten magic link with `bypassDeviceConfirmation=true`.

Before skipping the cross-device confirmation prompt, the frontend should validate the callback against the plugin:

- **POST** `/plugin/passwordless-cross-device-confirmation/validate`
- **Body**: `{ "clientDomain": "browser", "redirectToPath": "/profile", "appVariantId": "optional_variant" }`
- **Success response**: `{ "status": "OK", "bypass": true }`

If validation fails, the frontend should show the normal cross-device confirmation prompt.

Apple sign-in methods may include SuperTokens client type mapping fields:

```python
"signInMethods": [
    {
        "method": "apple",
        "clientId": "com.example.service",
        "webClientType": "web",
        "iosClientType": "ios",
        "androidClientType": "android",
    }
]
```

See [OAUTH_MIGRATION_TUTORIAL.md](./OAUTH_MIGRATION_TUTORIAL.md) for OAuth/OIDC client migration steps.

## Notes

The Python SDK plugin API does not currently pass `app_info` into plugin route construction. Configure `api_base_path`, `api_domain`, `website_domain`, and `app_name` on the Rownd plugin so it can register routes and rewrite Rownd hub links consistently.

`api_base_path` must match `InputAppInfo.api_base_path`. If these differ, Rownd plugin routes are mounted at the Rownd plugin value, not the SuperTokens app value.

`api_domain` should match `InputAppInfo.api_domain`. This value is added to rewritten Rownd hub links so browser and mobile flows can call back to the correct API domain.

`website_domain` should match `InputAppInfo.website_domain`. It is required when `create_magic_link_with_confirmation_bypass` is called without `client_domain`.

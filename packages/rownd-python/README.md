# SuperTokens Rownd Python Plugin

Rownd migration plugin for `supertokens_python`.

This package is managed by Turborepo through `package.json`, but published as a Python package named `supertokens-rownd`.

## Installation

Until this package is published to PyPI, install it from the `rownd-python` branch:

```bash
pip install "supertokens-rownd @ git+https://github.com/supertokens/supertokens-plugins.git@rownd-python#subdirectory=packages/rownd-python"
```

With `uv`:

```bash
uv add "supertokens-rownd @ git+https://github.com/supertokens/supertokens-plugins.git@rownd-python#subdirectory=packages/rownd-python"
```

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
- `POST /plugin/rownd/signout`
- `GET /plugin/rownd/user`
- `PUT /plugin/rownd/user`
- `DELETE /plugin/rownd/user`
- `GET /plugin/rownd/user/meta`
- `PUT /plugin/rownd/user/meta`
- `GET /plugin/rownd/user/field`
- `PUT /plugin/rownd/user/field`

## Notes

The Python SDK plugin API does not currently pass `app_info` into plugin route construction. Configure `api_base_path`, `api_domain`, and `app_name` on the Rownd plugin so it can register routes and rewrite Rownd hub links consistently.

`api_base_path` must match `InputAppInfo.api_base_path`. If these differ, Rownd plugin routes are mounted at the Rownd plugin value, not the SuperTokens app value.

`api_domain` should match `InputAppInfo.api_domain`. This value is added to rewritten Rownd hub links so browser and mobile flows can call back to the correct API domain.

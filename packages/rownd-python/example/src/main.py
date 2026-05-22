from __future__ import annotations

import os

import uvicorn
from dotenv import load_dotenv
from fastapi import Depends, FastAPI
from starlette.middleware.cors import CORSMiddleware
from supertokens_python import (
    InputAppInfo,
    SupertokensConfig,
    SupertokensExperimentalConfig,
    get_all_cors_headers,
    init,
)
from supertokens_python.framework.fastapi import get_middleware
from supertokens_python.recipe import (
    accountlinking,
    emailverification,
    passwordless,
    session,
    thirdparty,
    usermetadata,
)
from supertokens_python.recipe.session import SessionContainer
from supertokens_python.recipe.session.framework.fastapi import verify_session
from supertokens_python.recipe.thirdparty import ProviderClientConfig, ProviderConfig, ProviderInput
from supertokens_rownd import init as rownd_init
from supertokens_rownd.types import RowndPluginConfig

load_dotenv()

PORT = int(os.environ.get("PORT", "3001"))
EXAMPLE_FRONTEND_PORT = int(os.environ.get("EXAMPLE_FRONTEND_PORT", "5173"))
API_BASE_PATH = os.environ.get("API_BASE_PATH", "/auth")
API_DOMAIN = os.environ.get("API_DOMAIN", "http://localhost:%s" % PORT)
WEBSITE_DOMAIN = os.environ.get("WEBSITE_DOMAIN", "http://localhost:%s" % EXAMPLE_FRONTEND_PORT)
CORS_ALLOWED_ORIGINS = os.environ.get("CORS_ALLOWED_ORIGINS", WEBSITE_DOMAIN)
APP_NAME = os.environ.get("APP_NAME", "Rownd SuperTokens Python Example")
EXAMPLE_HUB_BASE_URL = os.environ.get(
    "EXAMPLE_HUB_BASE_URL", "https://rownd-hub.supertokens.com"
)


def require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError("Missing required environment variable: %s" % name)
    return value


def cors_origins() -> list[str]:
    configured_origins = [origin.strip() for origin in CORS_ALLOWED_ORIGINS.split(",") if origin.strip()]
    local_frontend_origins = [
        "http://localhost:%s" % EXAMPLE_FRONTEND_PORT,
        "http://127.0.0.1:%s" % EXAMPLE_FRONTEND_PORT,
    ]
    hub_origin = EXAMPLE_HUB_BASE_URL.rstrip("/")
    return list(dict.fromkeys([*configured_origins, *local_frontend_origins, hub_origin]))


init(
    app_info=InputAppInfo(
        app_name=APP_NAME,
        api_domain=API_DOMAIN,
        website_domain=WEBSITE_DOMAIN,
        api_base_path=API_BASE_PATH,
    ),
    framework="fastapi",
    mode="asgi",
    supertokens_config=SupertokensConfig(
        connection_uri=require_env("SUPERTOKENS_CONNECTION_URI"),
        api_key=os.environ.get("SUPERTOKENS_API_KEY"),
    ),
    recipe_list=[
        accountlinking.init(),
        session.init(),
        usermetadata.init(),
        passwordless.init(
            contact_config=passwordless.ContactEmailOrPhoneConfig(),
            flow_type="MAGIC_LINK",
        ),
        emailverification.init(
            mode="REQUIRED" if os.environ.get("EMAIL_VERIFICATION_MODE") == "REQUIRED" else "OPTIONAL"
        ),
        thirdparty.init(
            sign_in_and_up_feature=thirdparty.SignInAndUpFeature(
                providers=[
                    ProviderInput(
                        config=ProviderConfig(
                            third_party_id="google",
                            clients=[
                                ProviderClientConfig(
                                    client_id=require_env("GOOGLE_CLIENT_ID"),
                                    client_secret=require_env("GOOGLE_CLIENT_SECRET"),
                                )
                            ],
                        )
                    )
                ]
            )
        ),
    ],
    experimental=SupertokensExperimentalConfig(
        plugins=[
            rownd_init(
                    RowndPluginConfig(
                        rownd_app_key=require_env("ROWND_APP_KEY"),
                        rownd_app_secret=require_env("ROWND_APP_SECRET"),
                        # Keep these in sync with InputAppInfo. Python plugins cannot read app_info.
                        api_base_path=API_BASE_PATH,
                        api_domain=API_DOMAIN,
                    app_name=APP_NAME,
                    enable_debug_logs=os.environ.get("ROWND_ENABLE_DEBUG_LOGS") == "true",
                    app_config={
                        "id": os.environ.get("ROWND_APP_KEY", ""),
                        "name": APP_NAME,
                        "signInMethods": [
                            {"method": "email"},
                            {"method": "phone"},
                            {
                                "method": "google",
                                "clientId": os.environ.get("GOOGLE_CLIENT_ID"),
                                "signInFasterWithGoogle": "enabled",
                                "oneTap": {
                                    "browser": {"autoPrompt": False, "delay": 7000},
                                    "mobileApp": {"autoPrompt": False, "delay": 7000},
                                },
                            },
                            {"method": "anonymous", "displayName": "Continue as guest"},
                        ],
                        "profile": {
                            "accountInformation": {
                                "methods": {
                                    "email": {"enabled": True},
                                    "phone": {"enabled": True},
                                    "google": {"enabled": True},
                                    "apple": {"enabled": True},
                                }
                            },
                            "personalInformation": {"enabled": True},
                            "preferences": {"enabled": True},
                            "signOutButton": {"enabled": True},
                            "deleteAccountButton": {"enabled": True},
                        },
                    },
                )
            )
        ]
    ),
)

app = FastAPI()

app.add_middleware(get_middleware())
# Starlette runs the last-added middleware first, so CORS wraps the SuperTokens middleware.
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins(),
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["content-type", "x-rownd-app-key", *get_all_cors_headers()],
    expose_headers=["front-token", "st-access-token", "st-refresh-token", "anti-csrf"],
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "OK"}


@app.get("/example-bootstrap")
async def example_bootstrap() -> dict[str, object]:
    return {
        "supertokens": {
            "appInfo": {
                "appName": APP_NAME,
                "apiDomain": API_DOMAIN,
                "apiBasePath": API_BASE_PATH,
            }
        },
        "appKey": require_env("ROWND_APP_KEY"),
        "hubBaseUrl": EXAMPLE_HUB_BASE_URL,
        "exampleName": APP_NAME,
    }


@app.get("/applications/{_app_id}/automations/mobile/pages")
async def mobile_automation_pages(_app_id: str) -> dict[str, list[object]]:
    return {"results": []}


@app.get("/test/protected")
async def protected_resource(
    session_: SessionContainer = Depends(verify_session()),
) -> dict[str, object]:
    return {
        "userId": session_.get_user_id(),
        "accessTokenPayload": session_.get_access_token_payload(),
    }


@app.get("/sessioninfo")
async def session_info(session_: SessionContainer = Depends(verify_session())) -> dict[str, str]:
    return {"userId": session_.get_user_id()}


if __name__ == "__main__":
    print("Backend listening on %s" % API_DOMAIN)
    print("SuperTokens APIs mounted at %s%s" % (API_DOMAIN, API_BASE_PATH))
    print("React frontend expected at %s" % WEBSITE_DOMAIN)
    uvicorn.run("src.main:app", host="0.0.0.0", port=PORT, reload=True)

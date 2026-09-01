import "dotenv/config";

import express from "express";
import SuperTokens from "supertokens-node";
import AccountLinking from "supertokens-node/recipe/accountlinking";
import EmailVerification from "supertokens-node/recipe/emailverification";
import Passwordless from "supertokens-node/recipe/passwordless";
import Session from "supertokens-node/recipe/session";
import { verifySession } from "supertokens-node/recipe/session/framework/express";
import ThirdParty from "supertokens-node/recipe/thirdparty";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import {
  errorHandler,
  middleware,
  type SessionRequest,
} from "supertokens-node/framework/express";
import RowndMigrationPlugin from "@supertokens-plugins/rownd-nodejs";

const port = Number(process.env.PORT ?? 3001);
const apiBasePath = process.env.API_BASE_PATH ?? "/auth";
const apiDomain = process.env.API_DOMAIN ?? `http://localhost:${port}`;
const websiteDomain = process.env.WEBSITE_DOMAIN ?? "http://localhost:3000";

function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

SuperTokens.init({
  supertokens: {
    connectionURI: requireEnv("SUPERTOKENS_CONNECTION_URI"),
    ...(process.env.SUPERTOKENS_API_KEY
      ? { apiKey: process.env.SUPERTOKENS_API_KEY }
      : {}),
  },
  appInfo: {
    appName: process.env.APP_NAME ?? "Rownd SuperTokens Example",
    apiDomain,
    websiteDomain,
    apiBasePath,
  },
  recipeList: [
    AccountLinking.init({}),
    Session.init(),
    UserMetadata.init(),
    Passwordless.init({
      contactMethod: "EMAIL_OR_PHONE",
      flowType: "MAGIC_LINK",
    }),
    EmailVerification.init({
      mode: "REQUIRED",
    }),
    ThirdParty.init({
      signInAndUpFeature: {
        providers: [
          {
            config: {
              thirdPartyId: "google",
              clients: [
                {
                  clientId: requireEnv("GOOGLE_CLIENT_ID"),
                  clientSecret: requireEnv("GOOGLE_CLIENT_SECRET"),
                },
              ],
            },
          },
          {
            config: {
              thirdPartyId: "apple",
              clients: [
                {
                  clientId: requireEnv("APPLE_CLIENT_ID"),
                  additionalConfig: {
                    teamId: requireEnv("APPLE_TEAM_ID"),
                    keyId: requireEnv("APPLE_KEY_ID"),
                    privateKey: requireEnv("APPLE_PRIVATE_KEY"),
                  },
                },
              ],
            },
          },
        ],
      },
    }),
  ],
  experimental: {
    plugins: [
      RowndMigrationPlugin.init({
        rowndAppKey: requireEnv("ROWND_APP_KEY"),
        rowndAppSecret: requireEnv("ROWND_APP_SECRET"),
        enableDebugLogs: process.env.ROWND_ENABLE_DEBUG_LOGS === "true",
        ...(process.env.ROWND_MOBILE_DEEP_LINK_BASE_URL
          ? {
              clientDomains: {
                mobile: process.env.ROWND_MOBILE_DEEP_LINK_BASE_URL,
              },
            }
          : {}),
        appConfig: {
          id: process.env.ROWND_APP_KEY,
          name: process.env.APP_NAME ?? "Rownd SuperTokens Example",
          signInMethods: [
            { method: "email" },
            { method: "phone" },
            { method: "google", clientId: process.env.GOOGLE_CLIENT_ID },
            { method: "apple", clientId: process.env.APPLE_CLIENT_ID },
            { method: "anonymous", displayName: "Continue as guest" },
          ],
          profile: {
            accountInformation: {
              methods: {
                email: { enabled: true },
                phone: { enabled: true },
                google: { enabled: true },
                apple: { enabled: true },
              },
            },
            personalInformation: { enabled: true },
            preferences: { enabled: true },
            signOutButton: { enabled: true },
            deleteAccountButton: { enabled: true },
          },
        },
      }),
    ],
  },
});

const app = express();

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", websiteDomain);
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    ["content-type", ...SuperTokens.getAllCORSHeaders()].join(","),
  );

  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }

  next();
});

app.use(middleware());

app.get("/health", (_req, res) => {
  res.json({ status: "OK" });
});

app.get("/sessioninfo", verifySession(), (req: SessionRequest, res) => {
  res.json({
    userId: req.session!.getUserId(),
  });
});

app.use(errorHandler());

app.listen(port, () => {
  console.log(`Backend listening on ${apiDomain}`);
  console.log(`SuperTokens APIs mounted at ${apiDomain}${apiBasePath}`);
});

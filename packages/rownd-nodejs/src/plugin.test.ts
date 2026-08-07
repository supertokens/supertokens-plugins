import express from "express";
import { createHash, randomUUID } from "node:crypto";
import {
  describe,
  it,
  expect,
  afterEach,
  beforeEach,
  beforeAll,
  afterAll,
  vi,
} from "vitest";
import SuperTokens from "supertokens-node";
import Session from "supertokens-node/recipe/session";
import UserMetadata, {
  getUserMetadata,
} from "supertokens-node/recipe/usermetadata";
import Passwordless from "supertokens-node/recipe/passwordless";
import ThirdParty from "supertokens-node/recipe/thirdparty";
import EmailVerification from "supertokens-node/recipe/emailverification";
import AccountLinking from "supertokens-node/recipe/accountlinking";
import MultiTenancy from "supertokens-node/recipe/multitenancy";
import { middleware, errorHandler } from "supertokens-node/framework/express";
import { ProcessState } from "supertokens-node/lib/build/processState";
import SuperTokensRaw from "supertokens-node/lib/build/supertokens";
import SessionRaw from "supertokens-node/lib/build/recipe/session/recipe";
import UserMetadataRaw from "supertokens-node/lib/build/recipe/usermetadata/recipe";
import UserRolesRaw from "supertokens-node/lib/build/recipe/userroles/recipe";
import AccountLinkingRaw from "supertokens-node/lib/build/recipe/accountlinking/recipe";
import EmailPasswordRaw from "supertokens-node/lib/build/recipe/emailpassword/recipe";
import EmailVerificationRaw from "supertokens-node/lib/build/recipe/emailverification/recipe";
import ThirdPartyRaw from "supertokens-node/lib/build/recipe/thirdparty/recipe";
import PasswordlessRaw from "supertokens-node/lib/build/recipe/passwordless/recipe";
import MultitenancyRaw from "supertokens-node/lib/build/recipe/multitenancy/recipe";
import { NormalisedURLDomain } from "supertokens-node/lib/build/normalisedURLDomain";
import { Querier } from "supertokens-node/lib/build/querier";
import { Server } from "http";
import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";
import { Network, StartedNetwork } from "testcontainers";

import { init } from "./plugin";
import { RowndPluginConfig, RowndTelemetryClient } from "./types";
import { ROWND_PLUGIN_ERROR_MESSAGES } from "./errors";
import { DEFAULT_ROWND_SCHEMA, ROWND_JWT_CLAIMS } from "./constants";
import {
  buildRowndOAuthPayload,
  mapRowndUserToSuperTokens,
  shouldLinkRowndAccounts,
} from "./rownd-compatibility";
import { DEFAULT_PRIMARY_COLOR } from "./config";
import {
  RowndIsAnonymousClaim,
  buildRowndSessionClaims,
  completePendingEmailVerification,
  createMagicLinkWithConfirmationBypass,
  recordRowndAppVariantForUser,
} from "./supertokens-repository";
import { handleGuestLogin, handleMigrate } from "./pluginImplementation";
import { setRowndClient } from "./rownd-repository";
import { resolveTenantId } from "./utils";

let testPORT = 30001;

function buildExpectedFakeEmail(providerUserId: string, providerId: string) {
  const hash = createHash("sha256")
    .update(`${providerId}:${providerUserId}`)
    .digest("hex")
    .slice(0, 32);

  return `st-${providerId}-${hash}@stfakeemail.supertokens.com`;
}

const mockRowndClient = {
  validateToken: vi.fn(),
  fetchUserInfo: vi.fn(),
};

const ACCOUNT_LINKING_TEST_LICENSE =
  "N2uEOdEzd1XZZ5VBSTGYaM7Ia4s8wAqRWFAxLqTYrB6GQ=" +
  "vssOLo3c=PkFgcExkaXs=IA-d9UWccoNKsyUgNhOhcKtM1bjC5OLrYRpTAgN-2EbKYsQGGQRQHuUN4EO1V";

vi.mock("@rownd/node", () => ({
  createInstance: () => mockRowndClient,
}));

describe("rownd-nodejs plugin", () => {
  let server: Server | undefined;
  let container: StartedTestContainer;
  let importContainer: StartedTestContainer;
  let postgresContainer: StartedTestContainer;
  let network: StartedNetwork;
  let coreConnectionURI: string;
  let importCoreConnectionURI: string;

  beforeAll(async () => {
    network = await new Network().start();
    postgresContainer = await new GenericContainer("postgres:14")
      .withNetwork(network)
      .withNetworkAliases("postgres")
      .withEnvironment({
        POSTGRES_USER: "supertokens",
        POSTGRES_PASSWORD: "somepassword",
        POSTGRES_DB: "supertokens",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage("database system is ready to accept connections"),
      )
      .start();

    importContainer = await new GenericContainer(
      "supertokens/supertokens-postgresql",
    )
      .withNetwork(network)
      .withEnvironment({
        POSTGRESQL_CONNECTION_URI:
          "postgresql://supertokens:somepassword@postgres:5432/supertokens",
      })
      .withExposedPorts(3567)
      .withWaitStrategy(Wait.forHttp("/hello", 3567))
      .start();

    const importMappedPort = importContainer.getMappedPort(3567);
    importCoreConnectionURI = `http://${importContainer.getHost()}:${importMappedPort}`;
    const licenseResponse = await fetch(`${importCoreConnectionURI}/ee/license`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ licenseKey: ACCOUNT_LINKING_TEST_LICENSE }),
    });
    if (!licenseResponse.ok) {
      throw new Error(
        `Failed to enable account linking for import tests: ${licenseResponse.status} ${await licenseResponse.text()}`,
      );
    }

    container = await new GenericContainer("supertokens/supertokens-postgresql")
      .withExposedPorts(3567)
      .withWaitStrategy(Wait.forHttp("/hello", 3567))
      .start();

    const mappedPort = container.getMappedPort(3567);
    coreConnectionURI = `http://${container.getHost()}:${mappedPort}`;
  }, 120000);

  afterAll(async () => {
    if (container) {
      await container.stop();
    }
    if (importContainer) {
      await importContainer.stop();
    }
    if (postgresContainer) {
      await postgresContainer.stop();
    }
    if (network) {
      await network.stop();
    }
  });

  afterEach(async () => {
    if (server) {
      await new Promise((resolve) => server!.close(resolve));
    }
    resetST();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    resetST();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  describe("resolveTenantId", () => {
    it("defaults to public", () => {
      expect(
        resolveTenantId({
          getKeyValueFromQuery: () => undefined,
        } as any),
      ).toBe("public");
    });

    it("returns the requested tenant without pre-validating it", () => {
      expect(
        resolveTenantId({
          getKeyValueFromQuery: () => "tenant-a",
        } as any),
      ).toBe("tenant-a");
    });
  });

  describe("shouldLinkRowndAccounts", () => {
    it("does not enable account linking without account information", async () => {
      await expect(
        shouldLinkRowndAccounts([undefined, undefined, undefined] as any),
      ).resolves.toBeUndefined();
    });

    it("links verified matching email methods without a session", async () => {
      const { server: s, port } = await setup(importCoreConnectionURI);
      server = s;
      testPORT = port;
      const email = `default-linking-${randomUUID()}@example.com`;
      await Passwordless.signInUp({ tenantId: "public", email });

      await expect(
        shouldLinkRowndAccounts([
          {
            recipeId: "thirdparty",
            email,
            thirdParty: { id: "google", userId: "default-linking-google" },
          },
          undefined,
          undefined,
          "public",
          {},
        ] as any),
      ).resolves.toEqual({
        shouldAutomaticallyLink: true,
        shouldRequireVerification: true,
      });
    });

    it("does not link an unverified matching email method", async () => {
      await expect(
        shouldLinkRowndAccounts([
          {
            recipeId: "thirdparty",
            email: "unverified-link-target@example.com",
            thirdParty: { id: "google", userId: "unverified-google" },
          },
          {
            loginMethods: [
              {
                recipeId: "passwordless",
                email: "unverified-link-target@example.com",
                verified: false,
                tenantIds: ["public"],
              },
            ],
          },
          undefined,
          "public",
          {},
        ] as any),
      ).resolves.toBeUndefined();
    });

    it("does not link using a verified method from another tenant", async () => {
      const email = "cross-tenant-link-target@example.com";

      await expect(
        shouldLinkRowndAccounts([
          {
            recipeId: "thirdparty",
            email,
            thirdParty: { id: "google", userId: "cross-tenant-google" },
          },
          {
            loginMethods: [
              {
                recipeId: "passwordless",
                email,
                verified: true,
                tenantIds: ["tenant-b"],
              },
            ],
          },
          undefined,
          "tenant-a",
          {},
        ] as any),
      ).resolves.toBeUndefined();
    });

    it("does not link a different identity from the same provider", async () => {
      const email = "same-provider-link-target@example.com";

      await expect(
        shouldLinkRowndAccounts([
          {
            recipeId: "thirdparty",
            email,
            thirdParty: { id: "google", userId: "second-google-user" },
          },
          {
            loginMethods: [
              {
                recipeId: "passwordless",
                email,
                verified: true,
                tenantIds: ["public"],
              },
              {
                recipeId: "thirdparty",
                email,
                verified: true,
                tenantIds: ["public"],
                thirdParty: { id: "google", userId: "first-google-user" },
              },
            ],
          },
          undefined,
          "public",
          {},
        ] as any),
      ).resolves.toBeUndefined();
    });

    it("links guest users without requiring verification", async () => {
      const { server: s, port } = await setup(coreConnectionURI);
      server = s;
      testPORT = port;
      const guestUser = await ThirdParty.manuallyCreateOrUpdateUser(
        "public",
        "guest",
        "guest-link-user",
        "guest-link-user@anonymous.local",
        false,
      );
      expect(guestUser.status).toBe("OK");
      if (guestUser.status !== "OK") {
        throw new Error("failed to create guest user");
      }
      const session = await Session.createNewSessionWithoutRequestResponse(
        "public",
        guestUser.recipeUserId,
        {},
        {},
        true,
      );

      await expect(
        shouldLinkRowndAccounts([
          { recipeId: "passwordless", email: "guest-upgrade@example.com" },
          undefined,
          session,
        ] as any),
      ).resolves.toEqual({
        shouldAutomaticallyLink: true,
        shouldRequireVerification: false,
      });
    });

    it("links real auth methods only when authentication identity matches", async () => {
      const { server: s, port } = await setup(coreConnectionURI);
      server = s;
      testPORT = port;
      const passwordlessUser = await Passwordless.signInUp({
        tenantId: "public",
        email: "link-target@example.com",
      });
      const session = await Session.createNewSessionWithoutRequestResponse(
        "public",
        passwordlessUser.recipeUserId,
        {},
        {},
        true,
      );

      await expect(
        shouldLinkRowndAccounts([
          {
            recipeId: "thirdparty",
            email: "link-target@example.com",
            thirdParty: { id: "google", userId: "google-link-target" },
          },
          undefined,
          session,
          "public",
          {},
        ] as any),
      ).resolves.toEqual({
        shouldAutomaticallyLink: true,
        shouldRequireVerification: true,
      });

      await expect(
        shouldLinkRowndAccounts([
          {
            recipeId: "thirdparty",
            email: "attacker@example.com",
            thirdParty: { id: "google", userId: "google-attacker" },
          },
          undefined,
          session,
          "public",
          {},
        ] as any),
      ).resolves.toBeUndefined();
    });
  });

  describe("mapRowndUserToSuperTokens", () => {
    it("associates every mapped login method with the requested tenant", () => {
      const user = mapRowndUserToSuperTokens(
        {
          state: "enabled",
          auth_level: "verified",
          data: {
            user_id: "tenant-mapped-user",
            email: "tenant-mapped@example.com",
            phone_number: "+15555550100",
          },
          verified_data: {
            email: true,
            phone_number: true,
          },
        },
        "tenant-a",
      );

      expect(user.loginMethods).toHaveLength(2);
      expect(
        user.loginMethods.every(
          (method) => method.tenantIds?.[0] === "tenant-a",
        ),
      ).toBe(true);
      expect(user.loginMethods.filter((method) => method.isPrimary)).toEqual([
        user.loginMethods[0],
      ]);
    });

    it("throws when the Rownd payload has no data object", () => {
      expect(() =>
        mapRowndUserToSuperTokens({ app_user_id: "rownd-no-data" } as any),
      ).toThrowError(new Error("Rownd user has no user_id"));
    });

    it("throws when data.user_id is missing", () => {
      expect(() =>
        mapRowndUserToSuperTokens({
          app_user_id: "rownd-missing-user-id",
          data: { email: "missing-user-id@example.com" },
          verified_data: { email: true },
        } as any),
      ).toThrowError(new Error("Rownd user has no user_id"));
    });

    it.each([
      { providerId: "google", field: "google_id" },
      { providerId: "apple", field: "apple_id" },
    ])(
      "maps a $providerId user missing email with a fake SuperTokens email",
      ({ providerId, field }) => {
        const rowndUserId = `rownd-${providerId}-missing-email`;
        const providerUserId = `${providerId}-user-id`;

        expect(
          mapRowndUserToSuperTokens({
            data: {
              user_id: rowndUserId,
              [field]: providerUserId,
            },
            verified_data: { [field]: true },
          } as any),
        ).toEqual({
          externalUserId: rowndUserId,
          loginMethods: [
            {
              recipeId: "thirdparty",
              thirdPartyId: providerId,
              thirdPartyUserId: providerUserId,
              email: buildExpectedFakeEmail(providerUserId, providerId),
              isVerified: false,
            },
          ],
          userMetadata: {
            rownd_migration_complete: true,
            original_rownd_user: {
              data: {
                user_id: rowndUserId,
                [field]: providerUserId,
              },
              verified_data: { [field]: true },
            },
          },
        });
      },
    );

    it("maps a user with no login methods as a guest", () => {
      const user = mapRowndUserToSuperTokens({
        data: {
          user_id: "test-user-id",
        },
        verified_data: {},
        auth_level: "guest",
      } as any);

      expect(user.loginMethods).toHaveLength(1);
      expect(user.loginMethods[0]).toEqual({
        recipeId: "thirdparty",
        thirdPartyId: "guest",
        thirdPartyUserId: "test-user-id",
        email: "test-user-id@anonymous.local",
        isVerified: false,
      });
      expect(user.userMetadata.original_rownd_user).toEqual(
        expect.objectContaining({ auth_level: "guest" }),
      );
    });

    it("throws a type error when verified_data is missing for an otherwise valid email user", () => {
      expect(
        mapRowndUserToSuperTokens({
          data: {
            user_id: "rownd-missing-verified-data",
            email: "missing-verified-data@example.com",
          },
        } as any),
      ).toEqual({
        externalUserId: "rownd-missing-verified-data",
        loginMethods: [
          {
            recipeId: "passwordless",
            email: "missing-verified-data@example.com",
            isVerified: false,
          },
        ],
        userMetadata: {
          rownd_migration_complete: true,
          original_rownd_user: {
            data: {
              user_id: "rownd-missing-verified-data",
              email: "missing-verified-data@example.com",
            },
          },
        },
      });
    });

    it("falls back missing metadata containers to empty objects", () => {
      expect(
        mapRowndUserToSuperTokens({
          data: {
            user_id: "rownd-metadata-fallback",
            email: "metadata-fallback@example.com",
          },
          verified_data: {},
        } as any),
      ).toEqual({
        externalUserId: "rownd-metadata-fallback",
        loginMethods: [
          {
            recipeId: "passwordless",
            email: "metadata-fallback@example.com",
            isVerified: false,
          },
        ],
        userMetadata: {
          rownd_migration_complete: true,
          original_rownd_user: {
            data: {
              user_id: "rownd-metadata-fallback",
              email: "metadata-fallback@example.com",
            },
            verified_data: {},
          },
        },
      });
    });

    it("preserves Rownd app variants in imported user metadata", () => {
      expect(
        mapRowndUserToSuperTokens({
          data: {
            user_id: "rownd-variant-user",
            email: "variant-user@example.com",
          },
          verified_data: {},
          attributes: {
            "rownd:app_variants": ["variant_123"],
          },
        } as any),
      ).toEqual({
        externalUserId: "rownd-variant-user",
        loginMethods: [
          {
            recipeId: "passwordless",
            email: "variant-user@example.com",
            isVerified: false,
          },
        ],
        userMetadata: {
          rownd_migration_complete: true,
          original_rownd_user: {
            data: {
              user_id: "rownd-variant-user",
              email: "variant-user@example.com",
            },
            verified_data: {},
            attributes: {
              "rownd:app_variants": ["variant_123"],
            },
          },
        },
      });
    });

    it("handles a Rownd user with both email and phone", () => {
      const rowndUser = {
        data: {
          user_id: "rownd-dual",
          email: "dual@example.com",
          phone_number: "+1234567890",
        },
        verified_data: {
          email: true,
          phone_number: true,
        },
      };

      const result = mapRowndUserToSuperTokens(rowndUser as any);
      expect(result.loginMethods).toHaveLength(2);
      expect(result.loginMethods).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            recipeId: "passwordless",
            email: "dual@example.com",
            isVerified: true,
          }),
          expect.objectContaining({
            recipeId: "passwordless",
            phoneNumber: "+1234567890",
            isVerified: true,
          }),
        ]),
      );
    });
  });

  describe("disabled Rownd user migration", () => {
    it("requires credentials unless migration is explicitly disabled", () => {
      expect(() => init({})).toThrow(
        "Missing rowndAppKey or rowndAppSecret in plugin config",
      );
      expect(() => init({ disableRowndUserMigration: true })).not.toThrow();
      expect(() => init({ disableRowndUserMigration: "false" } as any)).toThrow(
        "disableRowndUserMigration must be a boolean",
      );
    });

    it("warns during plugin initialization", async () => {
      vi.spyOn(SuperTokens, "isRecipeInitialized").mockReturnValue(true);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const plugin = init({ disableRowndUserMigration: true }) as any;

      await plugin.init();

      expect(warn).toHaveBeenCalledWith(
        "RowndMigrationPlugin: Rownd user and session migration is disabled.",
      );
    });

    it("does not register migration routes", () => {
      const plugin = init({ disableRowndUserMigration: true }) as any;
      const result = plugin.routeHandlers(
        makePublicConfig("https://api.example.com", "/auth"),
      );
      const paths = result.routeHandlers.map(
        (routeHandler: { path: string }) => routeHandler.path,
      );

      expect(paths).not.toContain("/auth/plugin/rownd/migrate");
      expect(paths).not.toContain("/auth/plugin/migrate-session");
      expect(paths).toContain("/auth/plugin/rownd/app-config");
    });

    it("rewrites hub links with a dummy app key", async () => {
      const plugin = init({ disableRowndUserMigration: true }) as any;
      plugin.routeHandlers(
        makePublicConfig("https://api.example.com", "/auth"),
      );

      const sendEmail = vi.fn();
      const passwordlessConfig = plugin.overrideMap.passwordless.config({});
      const emailDelivery = passwordlessConfig.emailDelivery.override({
        sendEmail,
      });

      await emailDelivery.sendEmail({
        urlWithLinkCode:
          "https://hub.example.com/auth/verify?preAuthSessionId=pid&linkCode=abc",
        userContext: {},
      });

      const rewrittenUrl = new URL(sendEmail.mock.calls[0][0].urlWithLinkCode);
      expect(rewrittenUrl.pathname).toBe("/account/login");
      expect(rewrittenUrl.searchParams.get("appKey")).toBe(
        "migration-disabled",
      );
    });
  });

  describe("recipe API overrides", () => {
    it("adds hub bootstrap params to passwordless magic links", async () => {
      const pluginConfig: RowndPluginConfig = {
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
      };
      const plugin = init(pluginConfig) as any;
      plugin.routeHandlers(
        makePublicConfig("https://api.example.com", "/auth"),
      );

      const sendEmail = vi.fn();
      const passwordlessConfig = plugin.overrideMap.passwordless.config({});
      const emailDelivery = passwordlessConfig.emailDelivery.override({
        sendEmail,
      });

      await emailDelivery.sendEmail({
        urlWithLinkCode:
          "https://hub.example.com/auth/verify?preAuthSessionId=pid&linkCode=abc",
        userContext: {
          rowndAppVariantId: "variant_123",
          rowndDisplayContext: "mobile_app",
          rowndRedirectToPath: "/profile.html",
        },
      });

      const rewrittenUrl = new URL(sendEmail.mock.calls[0][0].urlWithLinkCode);
      expect(rewrittenUrl.origin).toBe("https://hub.example.com");
      expect(rewrittenUrl.pathname).toBe("/account/login");
      expect(rewrittenUrl.searchParams.get("preAuthSessionId")).toBe("pid");
      expect(rewrittenUrl.searchParams.get("linkCode")).toBe("abc");
      expect(rewrittenUrl.searchParams.get("appKey")).toBe("test-key");
      expect(rewrittenUrl.searchParams.get("apiDomain")).toBe(
        "https://api.example.com",
      );
      expect(rewrittenUrl.searchParams.get("apiBasePath")).toBe("/auth");
      expect(rewrittenUrl.searchParams.get("appVariantId")).toBe("variant_123");
      expect(rewrittenUrl.searchParams.get("displayContext")).toBe(
        "mobile_app",
      );
      expect(rewrittenUrl.searchParams.get("redirectToPath")).toBe(
        "/profile.html",
      );
    });

    it("preserves passwordless user input codes while rewriting combined delivery links", async () => {
      const plugin = init({
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
      }) as any;
      plugin.routeHandlers(
        makePublicConfig("https://api.example.com", "/auth"),
      );
      const sendEmail = vi.fn();
      const passwordlessConfig = plugin.overrideMap.passwordless.config({});
      const emailDelivery = passwordlessConfig.emailDelivery.override({
        sendEmail,
      });

      await emailDelivery.sendEmail({
        urlWithLinkCode:
          "https://hub.example.com/auth/verify?preAuthSessionId=pid&linkCode=abc",
        userInputCode: "123456",
        userContext: {},
      });

      expect(sendEmail.mock.calls[0][0].userInputCode).toBe("123456");
      const rewrittenUrl = new URL(sendEmail.mock.calls[0][0].urlWithLinkCode);
      expect(rewrittenUrl.pathname).toBe("/account/login");
      expect(rewrittenUrl.searchParams.get("linkCode")).toBe("abc");
      expect(rewrittenUrl.searchParams.get("passwordlessFlowType")).toBe(
        "USER_INPUT_CODE_AND_MAGIC_LINK",
      );
    });

    it("passes passwordless OTP-only delivery through without a link", async () => {
      const plugin = init({
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
      }) as any;
      const sendEmail = vi.fn();
      const passwordlessConfig = plugin.overrideMap.passwordless.config({});
      const emailDelivery = passwordlessConfig.emailDelivery.override({
        sendEmail,
      });
      const input = { userInputCode: "123456", userContext: {} };

      await emailDelivery.sendEmail(input);

      expect(sendEmail).toHaveBeenCalledWith(input);
      expect(sendEmail.mock.calls[0][0]).not.toHaveProperty("urlWithLinkCode");
    });

    it("adds OAuth login challenge bootstrap param to passwordless magic links", async () => {
      const pluginConfig: RowndPluginConfig = {
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
      };
      const plugin = init(pluginConfig) as any;
      plugin.routeHandlers(
        makePublicConfig("https://api.example.com", "/auth"),
      );

      const sendEmail = vi.fn();
      const passwordlessConfig = plugin.overrideMap.passwordless.config({});
      const emailDelivery = passwordlessConfig.emailDelivery.override({
        sendEmail,
      });

      await emailDelivery.sendEmail({
        urlWithLinkCode:
          "https://hub.example.com/auth/verify?preAuthSessionId=pid&linkCode=abc",
        userContext: {
          rowndOAuthLoginChallenge: "login_challenge_123",
        },
      });

      const rewrittenUrl = new URL(sendEmail.mock.calls[0][0].urlWithLinkCode);
      expect(rewrittenUrl.pathname).toBe("/account/login");
      expect(rewrittenUrl.searchParams.get("oauthLoginChallenge")).toBe(
        "login_challenge_123",
      );
    });

    it("uses mobile client domain with custom scheme for passwordless magic links", async () => {
      const pluginConfig: RowndPluginConfig = {
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
        clientDomains: { mobile: "rowndsupertokens://" },
      };
      const plugin = init(pluginConfig) as any;
      plugin.routeHandlers(
        makePublicConfig("https://api.example.com", "/auth"),
      );

      const sendEmail = vi.fn();
      const passwordlessConfig = plugin.overrideMap.passwordless.config({});
      const emailDelivery = passwordlessConfig.emailDelivery.override({
        sendEmail,
      });

      await emailDelivery.sendEmail({
        urlWithLinkCode:
          "https://hub.example.com/auth/verify?preAuthSessionId=pid&tenantId=public#abc",
        userContext: {
          rowndDisplayContext: "mobile_app",
        },
      });

      const rewrittenUrl = new URL(sendEmail.mock.calls[0][0].urlWithLinkCode);
      expect(rewrittenUrl.protocol).toBe("rowndsupertokens:");
      expect(rewrittenUrl.host).toBe("account");
      expect(rewrittenUrl.pathname).toBe("/login");
      expect(rewrittenUrl.searchParams.get("preAuthSessionId")).toBe("pid");
      expect(rewrittenUrl.searchParams.get("tenantId")).toBe("public");
      expect(rewrittenUrl.searchParams.get("appKey")).toBe("test-key");
      expect(rewrittenUrl.searchParams.get("apiDomain")).toBe(
        "https://api.example.com",
      );
      expect(rewrittenUrl.searchParams.get("apiBasePath")).toBe("/auth");
      expect(rewrittenUrl.searchParams.get("displayContext")).toBe(
        "mobile_app",
      );
      expect(rewrittenUrl.hash).toBe("#abc");
    });

    it("uses mobile client domain with HTTPS URL for passwordless magic links", async () => {
      const pluginConfig: RowndPluginConfig = {
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
        clientDomains: { mobile: "https://links.example.com" },
      };
      const plugin = init(pluginConfig) as any;
      plugin.routeHandlers(
        makePublicConfig("https://api.example.com", "/auth"),
      );

      const sendEmail = vi.fn();
      const passwordlessConfig = plugin.overrideMap.passwordless.config({});
      const emailDelivery = passwordlessConfig.emailDelivery.override({
        sendEmail,
      });

      await emailDelivery.sendEmail({
        urlWithLinkCode:
          "https://hub.example.com/auth/verify?preAuthSessionId=pid&tenantId=public#abc",
        userContext: {
          rowndDisplayContext: "mobile_app",
        },
      });

      const rewrittenUrl = new URL(sendEmail.mock.calls[0][0].urlWithLinkCode);
      expect(rewrittenUrl.origin).toBe("https://links.example.com");
      expect(rewrittenUrl.pathname).toBe("/account/login");
      expect(rewrittenUrl.searchParams.get("preAuthSessionId")).toBe("pid");
      expect(rewrittenUrl.searchParams.get("tenantId")).toBe("public");
      expect(rewrittenUrl.searchParams.get("appKey")).toBe("test-key");
      expect(rewrittenUrl.searchParams.get("displayContext")).toBe(
        "mobile_app",
      );
      expect(rewrittenUrl.hash).toBe("#abc");
    });

    it("rejects invalid client domain URLs", () => {
      expect(() =>
        init({
          rowndAppKey: "test-key",
          rowndAppSecret: "test-secret",
          clientDomains: { mobile: "rowndsupertokens" },
        }),
      ).toThrow("Invalid clientDomains.mobile in plugin config");
    });

    it("keeps hub links when the requested client domain is not configured", async () => {
      const pluginConfig: RowndPluginConfig = {
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
        clientDomains: { mobile: "rowndsupertokens://" },
      };
      const plugin = init(pluginConfig) as any;
      plugin.routeHandlers(
        makePublicConfig("https://api.example.com", "/auth"),
      );

      const sendEmail = vi.fn();
      const passwordlessConfig = plugin.overrideMap.passwordless.config({});
      const emailDelivery = passwordlessConfig.emailDelivery.override({
        sendEmail,
      });

      await emailDelivery.sendEmail({
        urlWithLinkCode:
          "https://hub.example.com/auth/verify?preAuthSessionId=pid#abc",
        userContext: {
          rowndDisplayContext: "browser",
        },
      });

      const rewrittenUrl = new URL(sendEmail.mock.calls[0][0].urlWithLinkCode);
      expect(rewrittenUrl.origin).toBe("https://hub.example.com");
      expect(rewrittenUrl.pathname).toBe("/account/login");
    });

    it("uses a requested custom client domain for browser passwordless magic links", async () => {
      const pluginConfig: RowndPluginConfig = {
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
        clientDomains: { browser_local: "http://localhost:3000" },
      };
      const plugin = init(pluginConfig) as any;
      plugin.routeHandlers(
        makePublicConfig("https://api.example.com", "/auth"),
      );

      const sendEmail = vi.fn();
      const passwordlessConfig = plugin.overrideMap.passwordless.config({});
      const emailDelivery = passwordlessConfig.emailDelivery.override({
        sendEmail,
      });

      await emailDelivery.sendEmail({
        urlWithLinkCode:
          "https://hub.example.com/auth/verify?preAuthSessionId=pid#abc",
        userContext: {
          rowndDisplayContext: "browser",
          rowndClientDomain: "browser_local",
        },
      });

      const rewrittenUrl = new URL(sendEmail.mock.calls[0][0].urlWithLinkCode);
      expect(rewrittenUrl.origin).toBe("http://localhost:3000");
      expect(rewrittenUrl.pathname).toBe("/account/login");
      expect(rewrittenUrl.searchParams.get("displayContext")).toBe("browser");
      expect(rewrittenUrl.hash).toBe("#abc");
    });

    it("creates a confirmation-bypass passwordless magic link for allowlisted redirect paths", async () => {
      const pluginConfig: RowndPluginConfig = {
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
        clientDomains: { browser_local: "http://localhost:3000" },
        crossDeviceConfirmationBypass: {
          allowedRedirectPaths: ["/profile?tab=security"],
        },
      };
      const { server: s, port } = await setup(coreConnectionURI, pluginConfig);
      server = s;
      testPORT = port;
      const link = await createMagicLinkWithConfirmationBypass({
        email: "bypass@example.com",
        clientDomain: "browser_local",
        redirectToPath: "http://localhost:3000/profile?tab=security",
        displayContext: "browser",
      });
      const url = new URL(link);

      expect(url.origin).toBe("http://localhost:3000");
      expect(url.pathname).toBe("/account/login");
      expect(url.searchParams.get("bypassDeviceConfirmation")).toBe("true");
      expect(url.searchParams.get("redirectToPath")).toBe(
        "/profile?tab=security",
      );
      expect(url.searchParams.get("clientDomain")).toBe("browser_local");
    });

    it("rejects confirmation-bypass magic links without configured allowlisted redirect paths", async () => {
      const pluginConfig: RowndPluginConfig = {
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
      };
      const { server: s, port } = await setup(coreConnectionURI, pluginConfig);
      server = s;
      testPORT = port;

      await expect(
        createMagicLinkWithConfirmationBypass({
          email: "bypass@example.com",
          redirectToPath: "/profile",
        }),
      ).rejects.toThrow(
        "crossDeviceConfirmationBypass.allowedRedirectPaths must be configured",
      );
    });

    it("rejects confirmation-bypass magic links for non-allowlisted redirect paths", async () => {
      const pluginConfig: RowndPluginConfig = {
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
        clientDomains: { browser_local: "http://localhost:3000" },
        crossDeviceConfirmationBypass: {
          allowedRedirectPaths: ["/profile"],
        },
      };
      const { server: s, port } = await setup(coreConnectionURI, pluginConfig);
      server = s;
      testPORT = port;

      await expect(
        createMagicLinkWithConfirmationBypass({
          email: "bypass@example.com",
          clientDomain: "browser_local",
          redirectToPath: "/settings",
        }),
      ).rejects.toThrow("redirectToPath is not allowed");
    });

    it("rejects confirmation-bypass magic links for cross-domain redirects", async () => {
      const pluginConfig: RowndPluginConfig = {
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
        clientDomains: { browser_local: "http://localhost:3000" },
        crossDeviceConfirmationBypass: {
          allowedRedirectPaths: ["/profile"],
        },
      };
      const { server: s, port } = await setup(coreConnectionURI, pluginConfig);
      server = s;
      testPORT = port;

      await expect(
        createMagicLinkWithConfirmationBypass({
          email: "bypass@example.com",
          clientDomain: "browser_local",
          redirectToPath: "https://evil.example.com/profile",
        }),
      ).rejects.toThrow("redirectToPath must match clientDomain");
    });

    it("validates confirmation-bypass redirect policy through the plugin endpoint", async () => {
      const pluginConfig: RowndPluginConfig = {
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
        clientDomains: { browser_local: "http://localhost:3000" },
        crossDeviceConfirmationBypass: {
          allowedRedirectPaths: ["/profile"],
        },
      };
      const { server: s, port } = await setup(coreConnectionURI, pluginConfig);
      server = s;
      testPORT = port;

      const response = await fetch(
        `http://localhost:${testPORT}/auth/plugin/passwordless-cross-device-confirmation/validate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            clientDomain: "browser_local",
            redirectToPath: "http://localhost:3000/profile",
          }),
        },
      );

      await expect(response.json()).resolves.toEqual({
        status: "OK",
        bypass: true,
      });
    });

    it("rejects confirmation-bypass validation endpoint requests for disallowed redirects", async () => {
      const pluginConfig: RowndPluginConfig = {
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
        clientDomains: { browser_local: "http://localhost:3000" },
        crossDeviceConfirmationBypass: {
          allowedRedirectPaths: ["/profile"],
        },
      };
      const { server: s, port } = await setup(coreConnectionURI, pluginConfig);
      server = s;
      testPORT = port;

      const response = await fetch(
        `http://localhost:${testPORT}/auth/plugin/passwordless-cross-device-confirmation/validate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            clientDomain: "browser_local",
            redirectToPath: "https://evil.example.com/profile",
          }),
        },
      );

      await expect(response.json()).resolves.toEqual({
        status: "ERROR",
        bypass: false,
      });
    });

    it("adds hub bootstrap params to passwordless SMS magic links", async () => {
      const pluginConfig: RowndPluginConfig = {
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
      };
      const plugin = init(pluginConfig) as any;
      plugin.routeHandlers(
        makePublicConfig("https://api.example.com", "/auth"),
      );

      const sendSms = vi.fn();
      const passwordlessConfig = plugin.overrideMap.passwordless.config({});
      const smsDelivery = passwordlessConfig.smsDelivery.override({
        sendSms,
      });

      await smsDelivery.sendSms({
        urlWithLinkCode:
          "https://hub.example.com/auth/verify?preAuthSessionId=pid&linkCode=abc",
        userContext: {
          rowndDisplayContext: "mobile_app",
        },
      });

      const rewrittenUrl = new URL(sendSms.mock.calls[0][0].urlWithLinkCode);
      expect(rewrittenUrl.origin).toBe("https://hub.example.com");
      expect(rewrittenUrl.pathname).toBe("/account/login");
      expect(rewrittenUrl.searchParams.get("preAuthSessionId")).toBe("pid");
      expect(rewrittenUrl.searchParams.get("linkCode")).toBe("abc");
      expect(rewrittenUrl.searchParams.get("appKey")).toBe("test-key");
      expect(rewrittenUrl.searchParams.get("apiDomain")).toBe(
        "https://api.example.com",
      );
      expect(rewrittenUrl.searchParams.get("apiBasePath")).toBe("/auth");
      expect(rewrittenUrl.searchParams.get("displayContext")).toBe(
        "mobile_app",
      );
    });

    it("adds hub bootstrap params to email verification links", async () => {
      const pluginConfig: RowndPluginConfig = {
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
      };
      const plugin = init(pluginConfig) as any;
      plugin.routeHandlers(
        makePublicConfig("https://api.example.com", "/auth"),
      );

      const sendEmail = vi.fn();
      const emailVerificationConfig =
        plugin.overrideMap.emailverification.config({});
      const emailDelivery = emailVerificationConfig.emailDelivery.override({
        sendEmail,
      });

      await emailDelivery.sendEmail({
        emailVerifyLink: "https://hub.example.com/auth/verify?token=token_123",
        userContext: { rowndDisplayContext: "mobile_app" },
      });

      const rewrittenUrl = new URL(sendEmail.mock.calls[0][0].emailVerifyLink);
      expect(rewrittenUrl.origin).toBe("https://hub.example.com");
      expect(rewrittenUrl.pathname).toBe("/account/verify-email");
      expect(rewrittenUrl.searchParams.get("token")).toBe("token_123");
      expect(rewrittenUrl.searchParams.get("appKey")).toBe("test-key");
      expect(rewrittenUrl.searchParams.get("apiDomain")).toBe(
        "https://api.example.com",
      );
      expect(rewrittenUrl.searchParams.get("apiBasePath")).toBe("/auth");
      expect(rewrittenUrl.searchParams.get("displayContext")).toBe(
        "mobile_app",
      );
    });

    it("uses mobile client domain for mobile email verification links", async () => {
      const pluginConfig: RowndPluginConfig = {
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
        clientDomains: { mobile: "rowndsupertokens://" },
      };
      const plugin = init(pluginConfig) as any;
      plugin.routeHandlers(
        makePublicConfig("https://api.example.com", "/auth"),
      );

      const sendEmail = vi.fn();
      const emailVerificationConfig =
        plugin.overrideMap.emailverification.config({});
      const emailDelivery = emailVerificationConfig.emailDelivery.override({
        sendEmail,
      });

      await emailDelivery.sendEmail({
        emailVerifyLink:
          "https://hub.example.com/auth/verify-email?token=token_123&tenantId=public",
        userContext: { rowndDisplayContext: "mobile_app" },
      });

      const rewrittenUrl = new URL(sendEmail.mock.calls[0][0].emailVerifyLink);
      expect(rewrittenUrl.protocol).toBe("rowndsupertokens:");
      expect(rewrittenUrl.host).toBe("account");
      expect(rewrittenUrl.pathname).toBe("/verify-email");
      expect(rewrittenUrl.searchParams.get("token")).toBe("token_123");
      expect(rewrittenUrl.searchParams.get("tenantId")).toBe("public");
      expect(rewrittenUrl.searchParams.get("appKey")).toBe("test-key");
      expect(rewrittenUrl.searchParams.get("apiDomain")).toBe(
        "https://api.example.com",
      );
      expect(rewrittenUrl.searchParams.get("apiBasePath")).toBe("/auth");
      expect(rewrittenUrl.searchParams.get("displayContext")).toBe(
        "mobile_app",
      );
    });

    it("uses a requested custom client domain for email verification links", async () => {
      const pluginConfig: RowndPluginConfig = {
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
        clientDomains: { browser_local: "http://localhost:3000" },
      };
      const plugin = init(pluginConfig) as any;
      plugin.routeHandlers(
        makePublicConfig("https://api.example.com", "/auth"),
      );

      const sendEmail = vi.fn();
      const emailVerificationConfig =
        plugin.overrideMap.emailverification.config({});
      const emailDelivery = emailVerificationConfig.emailDelivery.override({
        sendEmail,
      });

      await emailDelivery.sendEmail({
        emailVerifyLink: "https://hub.example.com/auth/verify?token=token_123",
        userContext: {
          rowndDisplayContext: "browser",
          rowndClientDomain: "browser_local",
        },
      });

      const rewrittenUrl = new URL(sendEmail.mock.calls[0][0].emailVerifyLink);
      expect(rewrittenUrl.origin).toBe("http://localhost:3000");
      expect(rewrittenUrl.pathname).toBe("/account/verify-email");
      expect(rewrittenUrl.searchParams.get("token")).toBe("token_123");
      expect(rewrittenUrl.searchParams.get("displayContext")).toBe("browser");
    });

    it("records app variant membership after passwordless code consumption", async () => {
      const pluginConfig: RowndPluginConfig = {
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
        subBrands: {
          variant_123: {
            id: "app_xyz",
            name: "Variant App",
            variant: { id: "variant_123", name: "Variant App" },
          },
        },
      };
      const { server: s, port } = await setup(coreConnectionURI, pluginConfig);
      server = s;
      testPORT = port;

      const signInUpResult = await Passwordless.signInUp({
        email: "passwordless-variant@example.com",
        tenantId: "public",
      });
      const originalConsumeCodePOST = vi.fn().mockResolvedValue({
        status: "OK",
        user: signInUpResult.user,
      });
      const passwordlessApis = (
        init(pluginConfig) as any
      ).overrideMap.passwordless.apis({
        consumeCodePOST: originalConsumeCodePOST,
      });

      await passwordlessApis.consumeCodePOST({
        options: { req: makeVariantRequest("variant_123") },
        userContext: {},
      });

      expect(originalConsumeCodePOST).toHaveBeenCalledWith(
        expect.objectContaining({
          userContext: { rowndAppVariantId: "variant_123" },
        }),
      );
      const metadata = await getUserMetadata(signInUpResult.user.id);
      expect(
        (metadata.metadata as any).original_rownd_user.attributes[
          "rownd:app_variants"
        ],
      ).toEqual(["variant_123"]);
    });

    it("adds app variant context before passwordless email creation", async () => {
      const pluginConfig: RowndPluginConfig = {
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
        subBrands: {
          variant_123: {
            id: "app_xyz",
            name: "Variant App",
            variant: { id: "variant_123", name: "Variant App" },
          },
        },
      };
      const { server: s, port } = await setup(coreConnectionURI, pluginConfig);
      server = s;
      testPORT = port;

      const originalCreateCodePOST = vi
        .fn()
        .mockResolvedValue({ status: "OK" });
      const passwordlessApis = (
        init(pluginConfig) as any
      ).overrideMap.passwordless.apis({
        createCodePOST: originalCreateCodePOST,
      });

      await passwordlessApis.createCodePOST({
        options: { req: makeVariantRequest("variant_123") },
        userContext: {},
      });

      expect(originalCreateCodePOST).toHaveBeenCalledWith(
        expect.objectContaining({
          userContext: { rowndAppVariantId: "variant_123" },
        }),
      );
    });

    it("adds client domain context before passwordless code creation", async () => {
      const pluginConfig: RowndPluginConfig = {
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
      };
      const originalCreateCodePOST = vi
        .fn()
        .mockResolvedValue({ status: "OK" });
      const passwordlessApis = (
        init(pluginConfig) as any
      ).overrideMap.passwordless.apis({
        createCodePOST: originalCreateCodePOST,
      });

      await passwordlessApis.createCodePOST({
        options: {
          req: makeRequest({
            rownd_display_context: "browser",
            rownd_client_domain: "browser_local",
          }),
        },
        userContext: {},
      });

      expect(originalCreateCodePOST).toHaveBeenCalledWith(
        expect.objectContaining({
          userContext: {
            rowndDisplayContext: "browser",
            rowndClientDomain: "browser_local",
          },
        }),
      );
    });

    it("adds OAuth login challenge context before passwordless code creation", async () => {
      const pluginConfig: RowndPluginConfig = {
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
      };
      const originalCreateCodePOST = vi
        .fn()
        .mockResolvedValue({ status: "OK" });
      const passwordlessApis = (
        init(pluginConfig) as any
      ).overrideMap.passwordless.apis({
        createCodePOST: originalCreateCodePOST,
      });

      await passwordlessApis.createCodePOST({
        options: {
          req: makeRequest({
            rownd_oauth_login_challenge: "login_challenge_123",
          }),
        },
        userContext: {},
      });

      expect(originalCreateCodePOST).toHaveBeenCalledWith(
        expect.objectContaining({
          userContext: {
            rowndOAuthLoginChallenge: "login_challenge_123",
          },
        }),
      );
    });

    it("adds Rownd request context before resending a passwordless code", async () => {
      const pluginConfig: RowndPluginConfig = {
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
        subBrands: {
          variant_123: {
            id: "app_xyz",
            name: "Variant App",
            variant: { id: "variant_123", name: "Variant App" },
          },
        },
      };
      const originalResendCodePOST = vi
        .fn()
        .mockResolvedValue({ status: "OK" });
      const passwordlessApis = (
        init(pluginConfig) as any
      ).overrideMap.passwordless.apis({
        resendCodePOST: originalResendCodePOST,
      });

      await passwordlessApis.resendCodePOST({
        options: {
          req: makeRequest({
            rownd_display_context: "mobile_app",
            rownd_redirect_to_path: "/profile",
            rownd_client_domain: "mobile",
            app_variant_id: "variant_123",
            rownd_oauth_login_challenge: "login_challenge_123",
          }),
        },
        userContext: {},
      });

      expect(originalResendCodePOST).toHaveBeenCalledWith(
        expect.objectContaining({
          userContext: {
            rowndDisplayContext: "mobile_app",
            rowndRedirectToPath: "/profile",
            rowndClientDomain: "mobile",
            rowndAppVariantId: "variant_123",
            rowndOAuthLoginChallenge: "login_challenge_123",
          },
        }),
      );
    });

    it("rejects passwordless code resend for unknown app variants", async () => {
      const pluginConfig: RowndPluginConfig = {
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
        subBrands: {
          variant_123: {
            id: "app_xyz",
            name: "Variant App",
            variant: { id: "variant_123", name: "Variant App" },
          },
        },
      };
      const originalResendCodePOST = vi.fn();
      const passwordlessApis = (
        init(pluginConfig) as any
      ).overrideMap.passwordless.apis({
        resendCodePOST: originalResendCodePOST,
      });

      await expect(
        passwordlessApis.resendCodePOST({
          options: { req: makeVariantRequest("missing_variant") },
          userContext: {},
        }),
      ).rejects.toThrow("Unknown Rownd app variant: missing_variant");
      expect(originalResendCodePOST).not.toHaveBeenCalled();
    });

    it("falls back when requested client domain is not configured", async () => {
      const pluginConfig: RowndPluginConfig = {
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
        clientDomains: { browser: "https://app.example.com" },
      };
      const plugin = init(pluginConfig) as any;
      plugin.routeHandlers(
        makePublicConfig("https://api.example.com", "/auth"),
      );

      const sendEmail = vi.fn();
      const passwordlessConfig = plugin.overrideMap.passwordless.config({});
      const emailDelivery = passwordlessConfig.emailDelivery.override({
        sendEmail,
      });

      await emailDelivery.sendEmail({
        urlWithLinkCode:
          "https://hub.example.com/auth/verify?preAuthSessionId=pid#abc",
        userContext: {
          rowndDisplayContext: "browser",
          rowndClientDomain: "missing_domain",
        },
      });

      const rewrittenUrl = new URL(sendEmail.mock.calls[0][0].urlWithLinkCode);
      expect(rewrittenUrl.origin).toBe("https://hub.example.com");
      expect(rewrittenUrl.pathname).toBe("/account/login");
    });

    it("rejects passwordless code consumption for unknown app variants", async () => {
      const pluginConfig: RowndPluginConfig = {
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
        subBrands: {
          variant_123: {
            id: "app_xyz",
            name: "Variant App",
            variant: { id: "variant_123", name: "Variant App" },
          },
        },
      };
      const { server: s, port } = await setup(coreConnectionURI, pluginConfig);
      server = s;
      testPORT = port;

      const originalConsumeCodePOST = vi.fn();
      const passwordlessApis = (
        init(pluginConfig) as any
      ).overrideMap.passwordless.apis({
        consumeCodePOST: originalConsumeCodePOST,
      });

      await expect(
        passwordlessApis.consumeCodePOST({
          options: { req: makeVariantRequest("missing_variant") },
          userContext: {},
        }),
      ).rejects.toThrow("Unknown Rownd app variant: missing_variant");
      expect(originalConsumeCodePOST).not.toHaveBeenCalled();
    });

    it("records app variant membership after third-party sign in", async () => {
      const pluginConfig: RowndPluginConfig = {
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
        subBrands: {
          variant_123: {
            id: "app_xyz",
            name: "Variant App",
            variant: { id: "variant_123", name: "Variant App" },
          },
        },
      };
      const { server: s, port } = await setup(coreConnectionURI, pluginConfig);
      server = s;
      testPORT = port;

      const signInUpResult = await ThirdParty.manuallyCreateOrUpdateUser(
        "public",
        "google",
        `google-${randomUUID()}`,
        "thirdparty-variant@example.com",
        true,
      );
      expect(signInUpResult.status).toBe("OK");
      if (signInUpResult.status !== "OK") {
        throw new Error("failed to create thirdparty user");
      }
      const originalSignInUpPOST = vi.fn().mockResolvedValue({
        status: "OK",
        user: signInUpResult.user,
      });

      const thirdPartyApis = (
        init(pluginConfig) as any
      ).overrideMap.thirdparty.apis({
        signInUpPOST: originalSignInUpPOST,
      });

      await thirdPartyApis.signInUpPOST({
        options: { req: makeVariantRequest("variant_123") },
        userContext: {},
      });

      expect(originalSignInUpPOST).toHaveBeenCalledWith(
        expect.objectContaining({
          userContext: { rowndAppVariantId: "variant_123" },
        }),
      );
      const metadata = await getUserMetadata(signInUpResult.user.id);
      expect(
        (metadata.metadata as any).original_rownd_user.attributes[
          "rownd:app_variants"
        ],
      ).toEqual(["variant_123"]);
    });

    it("adds the current app variant to new session claims", async () => {
      const pluginConfig: RowndPluginConfig = {
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
        appConfig: { id: "app_xyz" },
        subBrands: {
          variant_123: {
            id: "app_xyz",
            variant: { id: "variant_123" },
          },
        },
      };
      const { server: s, port } = await setup(coreConnectionURI, pluginConfig);
      server = s;
      testPORT = port;

      const signInUpResult = await Passwordless.signInUp({
        email: "session-variant@example.com",
        tenantId: "public",
      });
      const sessionFunctions = (init(pluginConfig) as any).overrideMap.session.functions({
        createNewSession: vi.fn().mockImplementation(async (input) => input),
      });

      const session = await sessionFunctions.createNewSession({
        userId: signInUpResult.user.id,
        recipeUserId: signInUpResult.user.loginMethods[0].recipeUserId,
        tenantId: "public",
        accessTokenPayload: {},
        userContext: { rowndAppVariantId: "variant_123" },
      });

      expect(session.accessTokenPayload.aud).toEqual([
        "app:app_xyz",
        "app_variant:variant_123",
      ]);
    });

    it("rejects third-party sign in for unknown app variants", async () => {
      const pluginConfig: RowndPluginConfig = {
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
        subBrands: {
          variant_123: {
            id: "app_xyz",
            name: "Variant App",
            variant: { id: "variant_123", name: "Variant App" },
          },
        },
      };
      const { server: s, port } = await setup(coreConnectionURI, pluginConfig);
      server = s;
      testPORT = port;

      const originalSignInUpPOST = vi.fn();
      const thirdPartyApis = (
        init(pluginConfig) as any
      ).overrideMap.thirdparty.apis({
        signInUpPOST: originalSignInUpPOST,
      });

      await expect(
        thirdPartyApis.signInUpPOST({
          options: { req: makeVariantRequest("missing_variant") },
          userContext: {},
        }),
      ).rejects.toThrow("Unknown Rownd app variant: missing_variant");
      expect(originalSignInUpPOST).not.toHaveBeenCalled();
    });

    it("passes Rownd OAuth scopes through unchanged and de-duplicated", async () => {
      const oauthFunctions = (
        init({
          rowndAppKey: "test-key",
          rowndAppSecret: "test-secret",
        }) as any
      ).overrideMap.oauth2provider.functions({
        getRequestedScopes: vi
          .fn()
          .mockResolvedValue(["openid", "profile", "email", "phone", "phone"]),
      });

      await expect(
        oauthFunctions.getRequestedScopes({ scopeParam: [], userContext: {} }),
      ).resolves.toEqual(["openid", "profile", "email", "phone"]);
    });

    it("translates Rownd OAuth resource params into audience params", async () => {
      const originalAuthGET = vi.fn().mockResolvedValue({ redirectTo: "ok" });
      const oauthApis = (
        init({
          rowndAppKey: "test-key",
          rowndAppSecret: "test-secret",
        }) as any
      ).overrideMap.oauth2provider.apis({
        authGET: originalAuthGET,
      });
      const input = {
        params: { resource: "app:app_123", client_id: "client_123" },
        userContext: {},
      };

      await oauthApis.authGET(input);

      expect(originalAuthGET).toHaveBeenCalledWith(
        expect.objectContaining({
          params: { client_id: "client_123", audience: "app:app_123" },
          userContext: { rowndOAuthAudience: "app:app_123" },
        }),
      );
    });

    it("translates Rownd OAuth token resource params into audience params", async () => {
      const originalTokenPOST = vi
        .fn()
        .mockResolvedValue({ access_token: "token" });
      const oauthApis = (
        init({
          rowndAppKey: "test-key",
          rowndAppSecret: "test-secret",
        }) as any
      ).overrideMap.oauth2provider.apis({
        tokenPOST: originalTokenPOST,
      });
      const input = {
        body: { resource: "app:app_123", grant_type: "client_credentials" },
        userContext: {},
      };

      await oauthApis.tokenPOST(input);

      expect(originalTokenPOST).toHaveBeenCalledWith(
        expect.objectContaining({
          body: { grant_type: "client_credentials", audience: "app:app_123" },
          userContext: { rowndOAuthAudience: "app:app_123" },
        }),
      );
    });
  });

  describe("endpoints", () => {
    describe("POST /migrate", () => {
      it("uses the requested tenant for association and session creation", async () => {
        const tenantId = "migration-tenant";
        const rowndUserId = `rownd-${randomUUID()}`;
        const recipeUserId = {
          getAsString: () => "migration-recipe-user",
        } as any;
        const secondRecipeUserId = {
          getAsString: () => "migration-second-recipe-user",
        } as any;
        const associateUserToTenant = vi
          .spyOn(MultiTenancy, "associateUserToTenant")
          .mockResolvedValue({ status: "OK", wasAlreadyAssociated: false });
        const createNewSession = vi
          .spyOn(Session, "createNewSession")
          .mockResolvedValue({} as any);
        vi.spyOn(UserMetadata, "getUserMetadata").mockResolvedValue({
          status: "OK",
          metadata: { rownd_migration_complete: true },
        });
        vi.spyOn(SuperTokens, "getUser").mockResolvedValue({
          id: rowndUserId,
          tenantIds: [],
          loginMethods: [
            { recipeUserId, tenantIds: [] },
            { recipeUserId: secondRecipeUserId, tenantIds: [] },
          ],
        } as any);
        setRowndClient(mockRowndClient);
        mockRowndClient.validateToken.mockResolvedValue({
          user_id: rowndUserId,
        });
        mockRowndClient.fetchUserInfo.mockResolvedValue({
          state: "enabled",
          auth_level: "verified",
          data: {
            user_id: rowndUserId,
            email: `${rowndUserId}@example.com`,
          },
          verified_data: { email: true },
        });
        const req = {
          getHeaderValue: (key: string) =>
            key === "authorization" ? "Bearer some-token" : undefined,
          getKeyValueFromQuery: (key: string) =>
            key === "tenantId" ? tenantId : undefined,
        } as any;
        const res = {} as any;
        const userContext = { requestId: "migration-request" };

        const result = await handleMigrate({
          pluginConfig: {
            rowndAppKey: "test-key",
            rowndAppSecret: "test-secret",
          },
          stConfig: {
            supertokens: { connectionURI: "http://core.example.com" },
          } as any,
          telemetryClient: {
            recordSuccess: vi.fn(),
            recordError: vi.fn(),
          },
        })(req, res, undefined, userContext);

        expect(result).toEqual({ status: "OK" });
        expect(associateUserToTenant).toHaveBeenCalledWith(
          tenantId,
          recipeUserId,
          userContext,
        );
        expect(associateUserToTenant).toHaveBeenCalledWith(
          tenantId,
          secondRecipeUserId,
          userContext,
        );
        expect(associateUserToTenant).toHaveBeenCalledTimes(2);
        expect(createNewSession).toHaveBeenCalledWith(
          req,
          res,
          tenantId,
          recipeUserId,
          {},
          {},
          userContext,
        );
      });

      it("migrate user successfully", async () => {
        const telemetryEvents: unknown[] = [];
        const telemetryClient: RowndTelemetryClient = {
          recordEvent: async (event) => {
            telemetryEvents.push(event);
          },
        };
        const { server: s, port } = await setup(importCoreConnectionURI, {
          telemetry: {
            provider: "custom",
            factory: () => telemetryClient,
          },
        });
        server = s;
        testPORT = port;
        const rowndUser = {
          app_user_id: "rownd-user-1",
          data: {
            user_id: "rownd-user-1",
            email: "test@example.com",
          },
          verified_data: {
            email: true,
          },
        };
        mockRowndClient.validateToken.mockResolvedValue({
          user_id: "rownd-user-1",
        });
        mockRowndClient.fetchUserInfo.mockResolvedValue(rowndUser);

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/migrate`,
          {
            method: "POST",
            headers: {
              Authorization: "Bearer some-token",
            },
          },
        );
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body).toEqual({ status: "OK" });

        const migratedUser = await getMigratedUserByRowndUserId(
          rowndUser.app_user_id,
        );
        expect(migratedUser).toBeDefined();
        const user = migratedUser!.user;
        expect(user).toBeDefined();
        expect(user?.loginMethods.length).toBe(1);
        expect(user?.loginMethods[0].recipeId).toBe("passwordless");
        expect(user?.loginMethods[0].email).toBe(rowndUser.data.email);

        const metadata = migratedUser!.metadata;
        expect(metadata.metadata).toEqual(
          expect.objectContaining({
            original_rownd_user: expect.objectContaining({
              data: expect.objectContaining({
                email: rowndUser.data.email,
              }),
            }),
          }),
        );
        expect(telemetryEvents).toContainEqual(
          expect.objectContaining({
            outcome: "success",
            rowndUserId: rowndUser.app_user_id,
            superTokensUserId: expect.any(String),
          }),
        );
      });

      it("migrate user with custom metadata successfully", async () => {
        const { server: s, port } = await setup(importCoreConnectionURI);
        server = s;
        testPORT = port;
        mockRowndClient.validateToken.mockResolvedValue({
          user_id: "rownd-user-2",
        });
        mockRowndClient.fetchUserInfo.mockResolvedValue({
          app_user_id: "rownd-user-2",
          data: {
            user_id: "rownd-user-2",
            email: "test2@example.com",
            first_name: "John",
            last_name: "Doe",
          },
          verified_data: { email: true },
        });

        await fetch(`http://localhost:${testPORT}/auth/plugin/rownd/migrate`, {
          method: "POST",
          headers: { Authorization: "Bearer some-token" },
        });

        const migratedUser = await getMigratedUserByRowndUserId("rownd-user-2");
        expect(migratedUser).toBeDefined();
        const metadata = migratedUser!.metadata;
        expect(metadata.metadata).toEqual(
          expect.objectContaining({
            first_name: "John",
            last_name: "Doe",
            original_rownd_user: expect.objectContaining({
              data: expect.objectContaining({
                first_name: "John",
                last_name: "Doe",
              }),
            }),
          }),
        );
      });

      it("migrate a passwordles auth user", async () => {
        const { server: s, port } = await setup(importCoreConnectionURI);
        server = s;
        testPORT = port;
        mockRowndClient.validateToken.mockResolvedValue({
          user_id: "rownd-user-phone",
        });
        mockRowndClient.fetchUserInfo.mockResolvedValue({
          app_user_id: "rownd-user-phone",
          data: { user_id: "rownd-user-phone", phone_number: "+1234567890" },
          verified_data: { phone_number: true },
        });

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/migrate`,
          {
            method: "POST",
            headers: { Authorization: "Bearer some-token" },
          },
        );
        expect(await res.json()).toEqual({ status: "OK" });

        const migratedUser =
          await getMigratedUserByRowndUserId("rownd-user-phone");
        expect(migratedUser).toBeDefined();
        const user = migratedUser!.user;
        expect(user?.loginMethods[0].phoneNumber).toBe("+1234567890");
      });

      it("migrates a user with no login methods as guest", async () => {
        const { server: s, port } = await setup(importCoreConnectionURI);
        server = s;
        testPORT = port;

        mockRowndClient.validateToken.mockResolvedValue({
          user_id: "rownd-user-guest",
        });
        mockRowndClient.fetchUserInfo.mockResolvedValue({
          app_user_id: "rownd-user-guest",
          data: {
            user_id: "rownd-user-guest",
          },
          verified_data: {},
          auth_level: "guest",
        });

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/migrate`,
          {
            method: "POST",
            headers: {
              Authorization: "Bearer valid-token",
              rid: "session",
              "fdi-version": "1.18",
            },
          },
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.status).toBe("OK");

        const accessToken = res.headers.get("st-access-token");
        expect(accessToken).toBeTruthy();

        const stUser = await SuperTokens.getUser("rownd-user-guest");
        expect(stUser).toBeDefined();
        const guestLogin = stUser?.loginMethods.find(
          (m) => m.recipeId === "thirdparty" && m.thirdParty?.id === "guest",
        );
        expect(guestLogin).toBeDefined();
        expect(guestLogin?.thirdParty?.userId).toBe("rownd-user-guest");
        expect(guestLogin?.email).toBe("rownd-user-guest@anonymous.local");

        const userRes = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user`,
          {
            headers: getAuthedHeaders(accessToken!),
          },
        );
        expect(userRes.status).toBe(200);
        const userData = await userRes.json();
        expect(userData.status).toBe("OK");
        expect(userData.auth_level).toBe("guest");
      });

      it("migrate a google auth user", async () => {
        const { server: s, port } = await setup(importCoreConnectionURI);
        server = s;
        testPORT = port;
        mockRowndClient.validateToken.mockResolvedValue({
          user_id: "rownd-user-google",
        });
        mockRowndClient.fetchUserInfo.mockResolvedValue({
          app_user_id: "rownd-user-google",
          data: {
            user_id: "rownd-user-google",
            google_id: "g-123",
            email: "g@example.com",
          },
          verified_data: { google_id: true },
        });

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/migrate`,
          {
            method: "POST",
            headers: { Authorization: "Bearer some-token" },
          },
        );
        expect(await res.json()).toEqual({ status: "OK" });
        const migratedUser =
          await getMigratedUserByRowndUserId("rownd-user-google");
        expect(migratedUser).toBeDefined();
        const user = migratedUser!.user;
        expect(user?.loginMethods).toHaveLength(2);
        const googleMethod = user?.loginMethods.find(
          (method) => method.recipeId === "thirdparty",
        );
        const passwordlessMethod = user?.loginMethods.find(
          (method) => method.recipeId === "passwordless",
        );
        expect(googleMethod?.thirdParty?.id).toBe("google");
        expect(googleMethod?.email).toBe(
          buildExpectedFakeEmail("g-123", "google"),
        );
        expect(googleMethod?.verified).toBe(false);
        expect(passwordlessMethod?.email).toBe("g@example.com");
        expect(passwordlessMethod?.verified).toBe(false);
      });

      it("does not reconcile an unverified Rownd email with an existing account", async () => {
        const { server: s, port } = await setup(importCoreConnectionURI);
        server = s;
        testPORT = port;
        const email = "unverified-migration-collision@example.com";
        const existingUser = await Passwordless.signInUp({
          tenantId: "public",
          email,
        });

        mockRowndClient.validateToken.mockResolvedValue({
          user_id: "rownd-unverified-email-collision",
        });
        mockRowndClient.fetchUserInfo.mockResolvedValue({
          app_user_id: "rownd-unverified-email-collision",
          data: {
            user_id: "rownd-unverified-email-collision",
            google_id: "google-unverified-email-collision",
            email,
          },
          verified_data: { google_id: true },
        });

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/migrate`,
          {
            method: "POST",
            headers: { Authorization: "Bearer some-token" },
          },
        );

        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toEqual({
          status: "ERROR",
          message: "Migration failed",
        });
        expect(
          await SuperTokens.getUser(existingUser.user.id),
        ).toMatchObject({
          id: existingUser.user.id,
          loginMethods: [
            expect.objectContaining({ recipeId: "passwordless", email }),
          ],
        });
        expect(
          await SuperTokens.getUser("rownd-unverified-email-collision"),
        ).toBeUndefined();
        await expect(
          SuperTokens.listUsersByAccountInfo(
            "public",
            {
              thirdParty: {
                id: "google",
                userId: "google-unverified-email-collision",
              },
            },
            false,
          ),
        ).resolves.toHaveLength(0);
      });

      it("preflights a later unverified email collision before linking an earlier phone method", async () => {
        const { server: s, port } = await setup(importCoreConnectionURI);
        server = s;
        testPORT = port;
        const rowndUserId = "rownd-late-email-collision";
        const googleId = "google-late-email-collision";
        const phoneNumber = "+15555550129";
        const collisionEmail = "late-email-collision@example.com";
        const providerUser = await ThirdParty.manuallyCreateOrUpdateUser(
          "public",
          "google",
          googleId,
          "provider-before-collision@example.com",
          true,
        );
        expect(providerUser.status).toBe("OK");
        if (providerUser.status !== "OK") {
          throw new Error("failed to create provider user");
        }
        const emailOwner = await Passwordless.signInUp({
          tenantId: "public",
          email: collisionEmail,
        });

        mockRowndClient.validateToken.mockResolvedValue({
          user_id: rowndUserId,
        });
        mockRowndClient.fetchUserInfo.mockResolvedValue({
          app_user_id: rowndUserId,
          data: {
            user_id: rowndUserId,
            google_id: googleId,
            phone_number: phoneNumber,
            email: collisionEmail,
          },
          verified_data: {
            google_id: true,
            phone_number: true,
          },
        });

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/migrate`,
          {
            method: "POST",
            headers: { Authorization: "Bearer some-token" },
          },
        );

        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toEqual({
          status: "ERROR",
          message: "Migration failed",
        });
        const unchangedProvider = await SuperTokens.getUser(
          providerUser.user.id,
        );
        expect(unchangedProvider?.isPrimaryUser).toBe(false);
        expect(unchangedProvider?.loginMethods).toEqual([
          expect.objectContaining({
            recipeId: "thirdparty",
            thirdParty: { id: "google", userId: googleId },
          }),
        ]);
        await expect(
          SuperTokens.listUsersByAccountInfo(
            "public",
            { phoneNumber },
            false,
          ),
        ).resolves.toHaveLength(0);
        expect(
          (await SuperTokens.getUser(emailOwner.user.id))?.loginMethods,
        ).toEqual([
          expect.objectContaining({
            recipeId: "passwordless",
            email: collisionEmail,
          }),
        ]);
        await expect(
          SuperTokens.getUserIdMapping({
            userId: rowndUserId,
            userIdType: "EXTERNAL",
          }),
        ).resolves.toEqual({ status: "UNKNOWN_MAPPING_ERROR" });
      });

      it("does not link another account's unverified contact to a matched provider", async () => {
        const { server: s, port } = await setup(importCoreConnectionURI);
        server = s;
        testPORT = port;
        const rowndUserId = "rownd-provider-contact-collision";
        const googleId = "google-provider-contact-collision";
        const collisionEmail = "provider-contact-collision@example.com";
        const providerUser = await ThirdParty.manuallyCreateOrUpdateUser(
          "public",
          "google",
          googleId,
          "provider-authoritative@example.com",
          true,
        );
        expect(providerUser.status).toBe("OK");
        if (providerUser.status !== "OK") {
          throw new Error("failed to create provider user");
        }
        const contactOwner = await Passwordless.signInUp({
          tenantId: "public",
          email: collisionEmail,
        });

        mockRowndClient.validateToken.mockResolvedValue({
          user_id: rowndUserId,
        });
        mockRowndClient.fetchUserInfo.mockResolvedValue({
          app_user_id: rowndUserId,
          data: {
            user_id: rowndUserId,
            google_id: googleId,
            email: collisionEmail,
          },
          verified_data: { google_id: true },
        });

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/migrate`,
          {
            method: "POST",
            headers: { Authorization: "Bearer some-token" },
          },
        );

        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toEqual({
          status: "ERROR",
          message: "Migration failed",
        });
        expect(
          (await SuperTokens.getUser(providerUser.user.id))?.loginMethods,
        ).toEqual([
          expect.objectContaining({
            recipeId: "thirdparty",
            thirdParty: { id: "google", userId: googleId },
            email: "provider-authoritative@example.com",
          }),
        ]);
        expect(
          (await SuperTokens.getUser(contactOwner.user.id))?.loginMethods,
        ).toEqual([
          expect.objectContaining({
            recipeId: "passwordless",
            email: collisionEmail,
          }),
        ]);
        expect(await SuperTokens.getUser(rowndUserId)).toBeUndefined();
      });

      it("migrates and links a Rownd user when one of multiple login methods already exists", async () => {
        const { server: s, port } = await setup(
          importCoreConnectionURI,
          undefined,
          { enableEmailVerification: true },
        );
        server = s;
        testPORT = port;
        const rowndUserId = "rownd-existing-google-plus-phone";
        const email = "existing-google-plus-phone@example.com";
        const googleId = "google-existing-plus-phone";
        const phoneNumber = "+15555550123";

        const existingGoogleUser = await ThirdParty.manuallyCreateOrUpdateUser(
          "public",
          "google",
          googleId,
          email,
          true,
        );
        expect(existingGoogleUser.status).toBe("OK");
        if (existingGoogleUser.status !== "OK") {
          throw new Error("failed to create existing google user");
        }

        mockRowndClient.validateToken.mockResolvedValue({
          user_id: rowndUserId,
        });
        mockRowndClient.fetchUserInfo.mockResolvedValue({
          app_user_id: rowndUserId,
          auth_level: "verified",
          data: {
            user_id: rowndUserId,
            google_id: googleId,
            phone_number: phoneNumber,
            email,
          },
          verified_data: {
            google_id: true,
            phone_number: true,
          },
        });

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/migrate`,
          {
            method: "POST",
            headers: {
              Authorization: "Bearer some-token",
              rid: "session",
              "fdi-version": "1.18",
              "st-auth-mode": "header",
            },
          },
        );

        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({ status: "OK" });

        const accessToken = res.headers.get("st-access-token");
        expect(accessToken).toBeTruthy();

        const session = await Session.getSessionWithoutRequestResponse(
          accessToken!,
        );
        expect(session).toBeDefined();

        const linkedUser = await SuperTokens.getUser(session!.getUserId());
        expect(linkedUser?.isPrimaryUser).toBe(true);
        expect(linkedUser?.loginMethods).toHaveLength(3);
        expect(linkedUser?.loginMethods).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              recipeId: "thirdparty",
              thirdParty: { id: "google", userId: googleId },
              email,
            }),
            expect.objectContaining({
              recipeId: "passwordless",
              phoneNumber,
              verified: true,
            }),
            expect.objectContaining({
              recipeId: "passwordless",
              email,
              verified: true,
            }),
          ]),
        );

        const userRes = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user`,
          {
            headers: getAuthedHeaders(accessToken!),
          },
        );

        expect(userRes.status).toBe(200);
        const userBody = await userRes.json();
        expect(userBody.status).toBe("OK");
        expect(userBody.rownd_user).toBe(rowndUserId);
        expect(userBody.data.google_id).toBe(googleId);
        expect(userBody.data.phone_number).toBe(phoneNumber);
        expect(userBody.verified_data.google_id).toBe(googleId);
        expect(userBody.verified_data.phone_number).toBe(phoneNumber);
      });

      it("does not modify an existing user mapped to another external ID", async () => {
        const { server: s, port } = await setup(importCoreConnectionURI);
        server = s;
        testPORT = port;
        const rowndUserId = "rownd-conflicting-mapping";
        const email = "conflicting-mapping@example.com";
        const googleId = "google-conflicting-mapping";
        const phoneNumber = "+15555550124";

        const existingGoogleUser = await ThirdParty.manuallyCreateOrUpdateUser(
          "public",
          "google",
          googleId,
          email,
          true,
        );
        expect(existingGoogleUser.status).toBe("OK");
        if (existingGoogleUser.status !== "OK") {
          throw new Error("failed to create existing google user");
        }
        await expect(
          SuperTokens.createUserIdMapping({
            superTokensUserId: existingGoogleUser.user.id,
            externalUserId: "another-rownd-user",
          }),
        ).resolves.toEqual({ status: "OK" });

        mockRowndClient.validateToken.mockResolvedValue({
          user_id: rowndUserId,
        });
        mockRowndClient.fetchUserInfo.mockResolvedValue({
          app_user_id: rowndUserId,
          auth_level: "verified",
          data: {
            user_id: rowndUserId,
            google_id: googleId,
            phone_number: phoneNumber,
            email,
          },
          verified_data: {
            google_id: true,
            phone_number: true,
          },
        });

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/migrate`,
          {
            method: "POST",
            headers: { Authorization: "Bearer some-token" },
          },
        );

        await expect(res.json()).resolves.toEqual({
          status: "ERROR",
          message: "Migration failed",
        });
        const unchangedUser = await SuperTokens.getUser(
          existingGoogleUser.user.id,
        );
        expect(unchangedUser?.isPrimaryUser).toBe(false);
        expect(unchangedUser?.loginMethods).toHaveLength(1);
        expect(
          unchangedUser?.loginMethods.some(
            (method) => method.phoneNumber === phoneNumber,
          ),
        ).toBe(false);
      });

      it.each([
        { providerId: "google", field: "google_id" },
        { providerId: "apple", field: "apple_id" },
      ])(
        "migrates a $providerId auth user without email and hides the fake email from Rownd compatibility data",
        async ({ providerId, field }) => {
          const { server: s, port } = await setup(importCoreConnectionURI);
          server = s;
          testPORT = port;
          const rowndUserId = `rownd-user-${providerId}-no-email`;
          const providerUserId = `${providerId}-no-email-id-with-a-long-enough-value-to-match-e2e-provider-ids`;

          mockRowndClient.validateToken.mockResolvedValue({
            user_id: rowndUserId,
          });
          mockRowndClient.fetchUserInfo.mockResolvedValue({
            app_user_id: rowndUserId,
            auth_level: "verified",
            data: {
              user_id: rowndUserId,
              [field]: providerUserId,
            },
            verified_data: { [field]: true },
          });

          const res = await fetch(
            `http://localhost:${testPORT}/auth/plugin/rownd/migrate`,
            {
              method: "POST",
              headers: {
                Authorization: "Bearer some-token",
                rid: "session",
                "fdi-version": "1.18",
                "st-auth-mode": "header",
              },
            },
          );

          expect(res.status).toBe(200);
          expect(await res.json()).toEqual({ status: "OK" });

          const migratedUser = await getMigratedUserByRowndUserId(rowndUserId);
          expect(migratedUser).toBeDefined();
          const loginMethod = migratedUser?.user.loginMethods[0];
          expect(loginMethod?.recipeId).toBe("thirdparty");
          expect(loginMethod?.thirdParty?.id).toBe(providerId);
          expect(loginMethod?.thirdParty?.userId).toBe(providerUserId);
          expect(loginMethod?.email).toBe(
            buildExpectedFakeEmail(providerUserId, providerId),
          );
          expect(loginMethod?.verified).toBe(false);

          const accessToken = res.headers.get("st-access-token");
          expect(accessToken).toBeTruthy();

          const userRes = await fetch(
            `http://localhost:${testPORT}/auth/plugin/rownd/user`,
            {
              headers: getAuthedHeaders(accessToken!),
            },
          );
          expect(userRes.status).toBe(200);
          const userBody = await userRes.json();
          expect(userBody.status).toBe("OK");
          expect(userBody.data[field]).toBe(providerUserId);
          expect(userBody.verified_data[field]).toBe(providerUserId);
          expect(userBody.data.email).toBeUndefined();
          expect(userBody.verified_data.email).toBeUndefined();

          const oauthPayload = await buildRowndOAuthPayload({
            user: migratedUser!.user,
            scopes: ["email"],
          });
          expect(oauthPayload.email).toBeUndefined();
          expect(oauthPayload.email_verified).toBeUndefined();
        },
      );

      it("migrates a newly imported mapped user when email verification is enabled", async () => {
        const { server: s, port } = await setup(
          importCoreConnectionURI,
          undefined,
          { enableEmailVerification: true },
        );
        server = s;
        testPORT = port;
        mockRowndClient.validateToken.mockResolvedValue({
          user_id: "rownd-ev-google",
        });
        mockRowndClient.fetchUserInfo.mockResolvedValue({
          app_user_id: "rownd-ev-google",
          data: {
            user_id: "rownd-ev-google",
            google_id: "google-ev-id",
            email: "rownd-ev-google@example.com",
          },
          verified_data: { google_id: true },
        });

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/migrate`,
          {
            method: "POST",
            headers: {
              Authorization: "Bearer some-token",
              rid: "session",
              "fdi-version": "1.18",
              "st-auth-mode": "header",
            },
          },
        );

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ status: "OK" });

        const accessToken = res.headers.get("st-access-token");
        expect(accessToken).toBeTruthy();

        const session = await Session.getSessionWithoutRequestResponse(
          accessToken!,
        );
        expect(session?.getUserId()).toBe("rownd-ev-google");

        const migratedUser =
          await getMigratedUserByRowndUserId("rownd-ev-google");
        expect(migratedUser?.user.loginMethods).toHaveLength(2);
        expect(migratedUser?.user.loginMethods).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              recipeId: "thirdparty",
              thirdParty: expect.objectContaining({
                id: "google",
                userId: "google-ev-id",
              }),
              email: buildExpectedFakeEmail("google-ev-id", "google"),
              verified: false,
            }),
            expect.objectContaining({
              recipeId: "passwordless",
              email: "rownd-ev-google@example.com",
              verified: false,
            }),
          ]),
        );
      });

      it("error if the auth header is missing", async () => {
        const { server: s, port } = await setup(importCoreConnectionURI);
        server = s;
        testPORT = port;
        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/migrate`,
          {
            method: "POST",
          },
        );
        const body = await res.json();
        expect(body.status).toBe("ERROR");
        expect(body.message).toBe(
          ROWND_PLUGIN_ERROR_MESSAGES.MISSING_AUTHORIZATION_HEADER,
        );
      });

      it("error if rownd token validation fails", async () => {
        const { server: s, port } = await setup(importCoreConnectionURI);
        server = s;
        testPORT = port;
        mockRowndClient.validateToken.mockRejectedValue(
          new Error("Invalid token API"),
        );

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/migrate`,
          {
            method: "POST",
            headers: { Authorization: "Bearer some-token" },
          },
        );
        const body = await res.json();
        expect(body.status).toBe("ERROR");
        expect(body.message).toBe("Migration failed");
      });

      it("error if rownd user info fetch fails", async () => {
        const telemetryEvents: unknown[] = [];
        const telemetryClient: RowndTelemetryClient = {
          recordEvent: async (event) => {
            telemetryEvents.push(event);
          },
        };
        const { server: s, port } = await setup(importCoreConnectionURI, {
          telemetry: {
            provider: "custom",
            factory: () => telemetryClient,
          },
        });
        server = s;
        testPORT = port;
        mockRowndClient.validateToken.mockResolvedValue({
          user_id: "rownd-user-fetch-fail",
        });
        mockRowndClient.fetchUserInfo.mockRejectedValue(
          new Error("Fetch failed"),
        );

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/migrate`,
          {
            method: "POST",
            headers: { Authorization: "Bearer some-token" },
          },
        );
        const body = await res.json();
        expect(body.status).toBe("ERROR");
        expect(body.message).toBe("Migration failed");
        expect(telemetryEvents).toContainEqual(
          expect.objectContaining({
            outcome: "error",
            rowndUserId: "rownd-user-fetch-fail",
            error: expect.objectContaining({
              message: "Fetch failed",
            }),
          }),
        );
      });

      it("telemetry failure does not affect response", async () => {
        let telemetryAttempts = 0;
        const telemetryClient: RowndTelemetryClient = {
          recordEvent: async () => {
            telemetryAttempts += 1;
            throw new Error("Telemetry down");
          },
        };
        const { server: s, port } = await setup(importCoreConnectionURI, {
          telemetry: {
            provider: "custom",
            factory: () => telemetryClient,
          },
        });
        server = s;
        testPORT = port;

        mockRowndClient.validateToken.mockResolvedValue({
          user_id: "rownd-user-telemetry-throw",
        });
        mockRowndClient.fetchUserInfo.mockResolvedValue({
          app_user_id: "rownd-user-telemetry-throw",
          data: {
            user_id: "rownd-user-telemetry-throw",
            email: "telemetry@example.com",
          },
          verified_data: { email: true },
        });

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/migrate`,
          {
            method: "POST",
            headers: { Authorization: "Bearer some-token" },
          },
        );
        expect(await res.json()).toEqual({ status: "OK" });
        expect(telemetryAttempts).toBe(1);
      });

      it("prevent creation of duplicate users", async () => {
        const { server: s, port } = await setup(importCoreConnectionURI);
        server = s;
        testPORT = port;
        mockRowndClient.validateToken.mockResolvedValue({
          user_id: "rownd-dup",
        });
        mockRowndClient.fetchUserInfo.mockResolvedValue({
          app_user_id: "rownd-dup",
          data: { user_id: "rownd-dup", email: "dup@example.com" },
          verified_data: { email: true },
        });

        await fetch(`http://localhost:${testPORT}/auth/plugin/rownd/migrate`, {
          method: "POST",
          headers: { Authorization: "Bearer some-token" },
        });

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/migrate`,
          {
            method: "POST",
            headers: { Authorization: "Bearer some-token" },
          },
        );
        expect(await res.json()).toEqual({ status: "OK" });

        const migratedUser = await getMigratedUserByRowndUserId("rownd-dup");
        expect(migratedUser).toBeDefined();
        const user = migratedUser!.user;
        expect(user).toBeDefined();
      });

      it("skips migration if user not found in rownd", async () => {
        const { server: s, port } = await setup(importCoreConnectionURI);
        server = s;
        testPORT = port;
        mockRowndClient.validateToken.mockResolvedValue({
          user_id: "rownd-missing",
        });
        mockRowndClient.fetchUserInfo.mockResolvedValue(undefined);

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/migrate`,
          {
            method: "POST",
            headers: { Authorization: "Bearer some-token" },
          },
        );
        const body = await res.json();
        expect(body).toEqual({ status: "OK" });
        expect(res.headers.get("st-access-token")).toBeNull();
        await expect(
          getMigratedUserByRowndUserId("rownd-missing"),
        ).resolves.toBeUndefined();
      });

      it("error if Bulk Import API fails (500)", async () => {
        const { server: s, port } = await setup(importCoreConnectionURI);
        server = s;
        testPORT = port;
        mockRowndClient.validateToken.mockResolvedValue({
          user_id: "rownd-import-fail",
        });
        mockRowndClient.fetchUserInfo.mockResolvedValue({
          app_user_id: "rownd-import-fail",
          data: { user_id: "rownd-import-fail", email: "fail@example.com" },
          verified_data: { email: true },
        });

        // Mock global fetch to return 500 for bulk import
        const originalFetch = global.fetch;
        vi.stubGlobal("fetch", async (url: string, init: any) => {
          if (url.includes("/bulk-import/import")) {
            return {
              ok: false,
              status: 500,
              text: async () => "Internal Server Error",
            };
          }
          return originalFetch(url, init);
        });

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/migrate`,
          {
            method: "POST",
            headers: { Authorization: "Bearer some-token" },
          },
        );
        const body = await res.json();
        expect(body.status).toBe("ERROR");
        expect(body.message).toBe("Migration failed");
      });

      it("error if Bulk Import API returns malformed JSON", async () => {
        const { server: s, port } = await setup(importCoreConnectionURI);
        server = s;
        testPORT = port;
        mockRowndClient.validateToken.mockResolvedValue({
          user_id: "rownd-import-malformed",
        });
        mockRowndClient.fetchUserInfo.mockResolvedValue({
          app_user_id: "rownd-import-malformed",
          data: {
            user_id: "rownd-import-malformed",
            email: "malformed@example.com",
          },
          verified_data: { email: true },
        });

        const originalFetch = global.fetch;
        vi.stubGlobal("fetch", async (url: string, init: any) => {
          if (url.includes("/bulk-import/import")) {
            return {
              ok: true,
              status: 200,
              json: async () => {
                throw new Error("Unexpected token");
              },
            };
          }
          return originalFetch(url, init);
        });

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/migrate`,
          {
            method: "POST",
            headers: { Authorization: "Bearer some-token" },
          },
        );
        const body = await res.json();
        expect(body.status).toBe("ERROR");
        expect(body.message).toBe("Migration failed");
      });
    });

    describe("session migration", () => {
      it("migrate session successfully", async () => {
        const { server: s, port } = await setup(importCoreConnectionURI, {
          appConfig: { id: "app_session_test" },
        });
        server = s;
        testPORT = port;
        mockRowndClient.validateToken.mockResolvedValue({
          user_id: "rownd-session-1",
        });
        mockRowndClient.fetchUserInfo.mockResolvedValue({
          app_user_id: "rownd-session-1",
          data: { user_id: "rownd-session-1", email: "session@example.com" },
          verified_data: { email: true },
        });

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/migrate?app_variant_id=variant_session_test`,
          {
            method: "POST",
            headers: {
              Authorization: "Bearer some-token",
              rid: "session",
              "fdi-version": "1.18",
              "st-auth-mode": "header",
            },
          },
        );
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body).toEqual({ status: "OK" });
        expect(res.headers.get("front-token")).toBeTruthy();
        expect(res.headers.get("st-refresh-token")).toBeTruthy();
        expect(
          res.headers.get("st-access-token") || res.headers.get("set-cookie"),
        ).toBeTruthy();

        const accessToken = res.headers.get("st-access-token");
        expect(accessToken).toBeTruthy();
        const session = await Session.getSessionWithoutRequestResponse(
          accessToken!,
        );
        await expect(
          session?.getClaimValue(RowndIsAnonymousClaim),
        ).resolves.toBe(false);
        const accessTokenPayload = session!.getAccessTokenPayload();
        expect(accessTokenPayload["app_user_id"]).toBe("rownd-session-1");
        expect(accessTokenPayload["auth_level"]).toBe("verified");
        expect(accessTokenPayload["is_verified_user"]).toBe(true);
        expect(accessTokenPayload[ROWND_JWT_CLAIMS.AppUserId]).toBe(
          "rownd-session-1",
        );
        expect(accessTokenPayload[ROWND_JWT_CLAIMS.AuthLevel]).toBe("verified");
        expect(accessTokenPayload[ROWND_JWT_CLAIMS.IsVerifiedUser]).toBe(true);
        expect(accessTokenPayload).not.toHaveProperty(
          ROWND_JWT_CLAIMS.IsAnonymous,
        );
        expect(accessTokenPayload["aud"]).toEqual([
          "app:app_session_test",
          "app_variant:variant_session_test",
        ]);
      });

      it("adds configured Rownd data fields to migrated session claims", async () => {
        const { server: s, port } = await setup(importCoreConnectionURI, {
          schema: {
            employee_id: {
              display_name: "Employee ID",
              type: "string",
              user_visible: false,
              include_in_session_claims: true,
              session_claim_name: "employee_id_claim",
            },
            plan: {
              display_name: "Plan",
              type: "string",
              user_visible: false,
            },
          },
        });
        server = s;
        testPORT = port;
        mockRowndClient.validateToken.mockResolvedValue({
          user_id: "rownd-session-claims",
        });
        mockRowndClient.fetchUserInfo.mockResolvedValue({
          app_user_id: "rownd-session-claims",
          data: {
            user_id: "rownd-session-claims",
            email: "session-claims@example.com",
            employee_id: "emp_123",
            plan: "enterprise",
          },
          verified_data: { email: true },
        });

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/migrate`,
          {
            method: "POST",
            headers: {
              Authorization: "Bearer some-token",
              rid: "session",
              "fdi-version": "1.18",
            },
          },
        );

        expect(await res.json()).toEqual({ status: "OK" });
        const accessToken = res.headers.get("st-access-token");
        expect(accessToken).toBeTruthy();
        const session = await Session.getSessionWithoutRequestResponse(
          accessToken!,
        );
        const accessTokenPayload = session!.getAccessTokenPayload();
        expect(accessTokenPayload.employee_id_claim).toBe("emp_123");
        expect(accessTokenPayload.employee_id).toBeUndefined();
        expect(accessTokenPayload.plan).toBeUndefined();
      });

      it("uses metadata fallback for configured session claim fields", async () => {
        const { server: s, port } = await setup(coreConnectionURI, {
          schema: {
            account_tier: {
              display_name: "Account tier",
              type: "string",
              user_visible: false,
              include_in_session_claims: true,
            },
            missing_field: {
              display_name: "Missing field",
              type: "string",
              user_visible: false,
              include_in_session_claims: true,
            },
          },
        });
        server = s;
        testPORT = port;
        const signInUpResponse = await Passwordless.signInUp({
          email: "metadata-claims@example.com",
          tenantId: "public",
        });

        await UserMetadata.updateUserMetadata(signInUpResponse.user.id, {
          account_tier: "gold",
          original_rownd_user: {
            data: {
              user_id: signInUpResponse.user.id,
              email: "metadata-claims@example.com",
            },
            verified_data: { email: true },
          },
        });

        const claims = await buildRowndSessionClaims(signInUpResponse.user.id);
        expect(claims).toMatchObject({ account_tier: "gold" });
        expect(claims).not.toHaveProperty("missing_field");
      });

      it("adds anonymous claims for instant Rownd sessions", async () => {
        const { server: s, port } = await setup(importCoreConnectionURI);
        server = s;
        testPORT = port;
        mockRowndClient.validateToken.mockResolvedValue({
          user_id: "rownd-session-instant",
        });
        mockRowndClient.fetchUserInfo.mockResolvedValue({
          app_user_id: "rownd-session-instant",
          auth_level: "instant",
          data: { user_id: "rownd-session-instant" },
          verified_data: {},
        });

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/migrate`,
          {
            method: "POST",
            headers: {
              Authorization: "Bearer some-token",
              rid: "session",
              "fdi-version": "1.18",
            },
          },
        );

        expect(await res.json()).toEqual({ status: "OK" });
        const accessToken = res.headers.get("st-access-token");
        expect(accessToken).toBeTruthy();
        const session = await Session.getSessionWithoutRequestResponse(
          accessToken!,
        );
        await expect(
          session?.getClaimValue(RowndIsAnonymousClaim),
        ).resolves.toBe(true);
        const accessTokenPayload = session!.getAccessTokenPayload();
        expect(accessTokenPayload[ROWND_JWT_CLAIMS.AuthLevel]).toBe("instant");
        expect(accessTokenPayload[ROWND_JWT_CLAIMS.IsVerifiedUser]).toBe(true);
        expect(accessTokenPayload).not.toHaveProperty("anonymous_id");
        expect(accessTokenPayload[ROWND_JWT_CLAIMS.IsAnonymous]).toBe(true);
      });

      it("create user and then migrate their session", async () => {
        const { server: s, port } = await setup(importCoreConnectionURI);
        server = s;
        testPORT = port;
        mockRowndClient.validateToken.mockResolvedValue({
          user_id: "rownd-session-2",
        });
        mockRowndClient.fetchUserInfo.mockResolvedValue({
          app_user_id: "rownd-session-2",
          data: { user_id: "rownd-session-2", email: "session2@example.com" },
          verified_data: { email: true },
        });

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/migrate`,
          {
            method: "POST",
            headers: {
              Authorization: "Bearer some-token",
              rid: "session",
              "fdi-version": "1.18",
            },
          },
        );
        expect(await res.json()).toEqual({ status: "OK" });
      });

      it("error if the auth header is missing", async () => {
        const { server: s, port } = await setup(importCoreConnectionURI);
        server = s;
        testPORT = port;
        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/migrate`,
          {
            method: "POST",
          },
        );
        const body = await res.json();
        expect(body.status).toBe("ERROR");
      });

      it("error if rownd token validation fails", async () => {
        const { server: s, port } = await setup(importCoreConnectionURI);
        server = s;
        testPORT = port;
        mockRowndClient.validateToken.mockRejectedValue(
          new Error("Invalid token"),
        );
        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/migrate`,
          {
            method: "POST",
            headers: { Authorization: "Bearer some-token" },
          },
        );
        expect((await res.json()).status).toBe("ERROR");
      });

      it("error if rownd user info fetch fails", async () => {
        const { server: s, port } = await setup(importCoreConnectionURI);
        server = s;
        testPORT = port;
        mockRowndClient.validateToken.mockResolvedValue({
          user_id: "rownd-session-3",
        });
        mockRowndClient.fetchUserInfo.mockRejectedValue(new Error("Failed"));
        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/migrate`,
          {
            method: "POST",
            headers: { Authorization: "Bearer some-token" },
          },
        );
        expect((await res.json()).status).toBe("ERROR");
      });
    });

    describe("GET /app-config", () => {
      it("returns 200 with defaults when no appConfig is provided", async () => {
        const { server: s, port } = await setup(coreConnectionURI);
        server = s;
        testPORT = port;

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/app-config`,
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        const app = body.app;
        expect(body.status).toBe("OK");
        expect(body.config_type).toBe("app");
        expect(app.id).toBe("");
        expect(app.name).toBe("Test App");

        expect(app.config.hub.auth.sign_in_methods.email.enabled).toBe(false);
        expect(app.config.hub.auth.sign_in_methods.google.enabled).toBe(false);
        expect(app.config.customizations.primary_color).toBe(
          DEFAULT_PRIMARY_COLOR,
        );
        expect(app.config.hub.customizations.rounded_corners).toBe(true);
        expect(app.config.hub.customizations.dark_mode).toBe("auto");

        // Auth fields should NOT be in schema if methods are disabled
        expect(app.schema.email).toBeUndefined();
        expect(app.schema.google_id).toBeUndefined();
      });

      it("does not require authentication", async () => {
        const { server: s, port } = await setup(coreConnectionURI);
        server = s;
        testPORT = port;

        // No Authorization header, no session cookie
        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/app-config`,
        );
        expect(res.status).toBe(200);
      });

      it("returns sign_in_methods from recipes and plugin config", async () => {
        const { server: s, port } = await setup(coreConnectionURI, {
          appConfig: {
            signInMethods: [
              { method: "email" },
              { method: "phone" },
              {
                method: "google",
                clientId: "test-client-id.apps.googleusercontent.com",
                oneTap: { browser: { autoPrompt: true, delay: 3000 } },
              },
              {
                method: "apple",
                clientId: "com.example.app",
                webClientType: "web",
                iosClientType: "ios",
                androidClientType: "android",
              },
            ],
          },
        });
        server = s;
        testPORT = port;

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/app-config`,
        );
        const body = await res.json();
        const methods = body.app.config.hub.auth.sign_in_methods;

        expect(methods.email.enabled).toBe(true);
        expect(methods.phone.enabled).toBe(true);
        expect(methods.google.enabled).toBe(true);
        expect(methods.google.client_id).toBe(
          "test-client-id.apps.googleusercontent.com",
        );
        expect(methods.google.one_tap.browser.auto_prompt).toBe(true);
        expect(methods.google.one_tap.browser.delay).toBe(3000);
        expect(methods.apple.enabled).toBe(true);
        expect(methods.apple.client_id).toBe("com.example.app");
        expect(methods.apple.web_client_type).toBe("web");
        expect(methods.apple.ios_client_type).toBe("ios");
        expect(methods.apple.android_client_type).toBe("android");
      });

      it("returns platform-specific auth order from plugin config", async () => {
        const authOrder = {
          default: [
            { name: "email", type: "input" as const },
            { name: "google", type: "button" as const },
          ],
          ios: [
            { name: "apple", type: "button" as const },
            { name: "google", type: "button" as const, hidden: true },
            { name: "email", type: "input" as const },
          ],
          android: [
            { name: "google", type: "button" as const },
            { name: "apple", type: "button" as const, hidden: true },
            { name: "email", type: "input" as const },
          ],
        };
        const { server: s, port } = await setup(coreConnectionURI, {
          appConfig: {
            signInMethods: [
              { method: "email" },
              { method: "google" },
              { method: "apple" },
            ],
            auth: {
              order: authOrder,
            },
          },
        });
        server = s;
        testPORT = port;

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/app-config`,
        );
        const body = await res.json();

        expect(body.app.config.hub.auth.order).toEqual(authOrder);
      });

      it.each([
        {
          description: "true",
          auth: { enforceSameDevicePasswordlessSignIn: true },
          expectedValue: true,
        },
        {
          description: "false",
          auth: { enforceSameDevicePasswordlessSignIn: false },
          expectedValue: false,
        },
        { description: "omitted", auth: {}, expectedValue: undefined },
      ])(
        "maps enforceSameDevicePasswordlessSignIn when $description",
        async ({ auth, expectedValue }) => {
          const { server: s, port } = await setup(coreConnectionURI, {
            appConfig: {
              auth,
            },
          });
          server = s;
          testPORT = port;

          const res = await fetch(
            `http://localhost:${testPORT}/auth/plugin/rownd/app-config`,
          );
          const body = await res.json();

          expect(
            body.app.config.hub.auth.enforce_same_device_passwordless_sign_in,
          ).toBe(expectedValue);
        },
      );

      it("returns branding fields from plugin config", async () => {
        const { server: s, port } = await setup(coreConnectionURI, {
          appConfig: {
            id: "app_xyz",
            name: "Acme App",
            icon: "https://cdn.acme.com/icon.png",
            branding: {
              primaryColor: "#ff0000",
              roundedCorners: false,
              darkMode: "dark",
              showAppIcon: true,
            },
          },
        });
        server = s;
        testPORT = port;

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/app-config`,
        );
        const body = await res.json();
        const app = body.app;

        expect(app.id).toBe("app_xyz");
        expect(app.name).toBe("Acme App");
        expect(app.icon).toBe("https://cdn.acme.com/icon.png");
        expect(app.config.customizations.primary_color).toBe("#ff0000");
        expect(app.config.hub.customizations.rounded_corners).toBe(false);
        expect(app.config.hub.customizations.dark_mode).toBe("dark");
        expect(app.config.hub.auth.show_app_icon).toBe(true);
      });

      it("returns sub-brand app config when app_variant_id is provided", async () => {
        const { server: s, port } = await setup(coreConnectionURI, {
          appConfig: {
            id: "app_xyz",
            name: "Base App",
            branding: { primaryColor: "#111111" },
            signInMethods: [{ method: "email" }],
          },
          subBrands: {
            variant_123: {
              id: "app_xyz",
              name: "Variant App",
              branding: { primaryColor: "#222222" },
              variant: {
                id: "variant_123",
                name: "Variant App",
                config: { customizations: { primary_color: "#222222" } },
              },
            },
          },
        });
        server = s;
        testPORT = port;

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/app-config?app_variant_id=variant_123`,
        );
        const body = await res.json();
        const app = body.app;

        expect(body.status).toBe("OK");
        expect(body.config_type).toBe("variant");
        expect(app.id).toBe("app_xyz");
        expect(app.name).toBe("Variant App");
        expect(body.variant.id).toBe("variant_123");
        expect(body.variant.config).toEqual({
          customizations: { primary_color: "#222222" },
        });
        expect(app.config.customizations.primary_color).toBe("#222222");
        expect(app.config.hub.auth.sign_in_methods.email.enabled).toBe(true);
        expect(app.config.hub.auth.sign_in_methods.phone.enabled).toBe(false);
      });

      it("returns base app config when no sub-brand query param is provided", async () => {
        const { server: s, port } = await setup(coreConnectionURI, {
          appConfig: {
            id: "app_xyz",
            name: "Base App",
            branding: { primaryColor: "#111111" },
          },
          subBrands: {
            variant_123: {
              id: "app_xyz",
              name: "Variant App",
              branding: { primaryColor: "#222222" },
              variant: { id: "variant_123", name: "Variant App" },
            },
          },
        });
        server = s;
        testPORT = port;

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/app-config`,
        );
        const body = await res.json();
        const app = body.app;

        expect(body.status).toBe("OK");
        expect(body.config_type).toBe("app");
        expect(app.name).toBe("Base App");
        expect(body.variant).toBeUndefined();
        expect(app.config.customizations.primary_color).toBe("#111111");
      });

      it("returns an error for unknown sub-brand app variant", async () => {
        const { server: s, port } = await setup(coreConnectionURI, {
          subBrands: {
            variant_123: {
              id: "app_xyz",
              name: "Variant App",
              variant: { id: "variant_123", name: "Variant App" },
            },
          },
        });
        server = s;
        testPORT = port;

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/app-config?app_variant_id=missing_variant`,
        );
        const body = await res.json();

        expect(res.status).toBe(400);
        expect(body.status).toBe("ERROR");
        expect(body.message).toContain("missing_variant");
      });

      it("records app variant membership in user metadata", async () => {
        const { server: s, port } = await setup(coreConnectionURI, {
          subBrands: {
            variant_123: {
              id: "app_xyz",
              name: "Variant App",
              variant: { id: "variant_123", name: "Variant App" },
            },
            variant_456: {
              id: "app_xyz",
              name: "Other Variant App",
              variant: { id: "variant_456", name: "Other Variant App" },
            },
          },
        });
        server = s;
        testPORT = port;

        const signInUpResult = await Passwordless.signInUp({
          email: "variant-member@example.com",
          tenantId: "public",
        });

        await recordRowndAppVariantForUser(
          signInUpResult.user.id,
          "variant_123",
        );
        await recordRowndAppVariantForUser(
          signInUpResult.user.id,
          "variant_456",
        );
        await recordRowndAppVariantForUser(
          signInUpResult.user.id,
          "variant_123",
        );

        const metadata = await getUserMetadata(signInUpResult.user.id);
        expect(
          (metadata.metadata as any).original_rownd_user.attributes[
            "rownd:app_variants"
          ],
        ).toEqual(["variant_123", "variant_456"]);
      });

      it("rejects unknown app variants", async () => {
        const { server: s, port } = await setup(coreConnectionURI, {
          subBrands: {
            variant_123: {
              id: "app_xyz",
              name: "Variant App",
              variant: { id: "variant_123", name: "Variant App" },
            },
          },
        });
        server = s;
        testPORT = port;

        const signInUpResult = await Passwordless.signInUp({
          email: "unknown-variant-member@example.com",
          tenantId: "public",
        });

        await expect(
          recordRowndAppVariantForUser(
            signInUpResult.user.id,
            "missing_variant",
          ),
        ).rejects.toThrow("Unknown Rownd app variant: missing_variant");
      });

      it("returns legal fields from plugin config", async () => {
        const { server: s, port } = await setup(coreConnectionURI, {
          appConfig: {
            legal: {
              companyName: "Acme Corp",
              privacyPolicyUrl: "https://acme.com/privacy",
              termsConditionsUrl: "https://acme.com/terms",
              supportEmail: "support@acme.com",
            },
          },
        });
        server = s;
        testPORT = port;

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/app-config`,
        );
        const body = await res.json();
        const legal = body.app.config.hub.legal;

        expect(legal.company_name).toBe("Acme Corp");
        expect(legal.privacy_policy_url).toBe("https://acme.com/privacy");
        expect(legal.terms_conditions_url).toBe("https://acme.com/terms");
        expect(legal.support_email).toBe("support@acme.com");
      });

      it("returns verification modal custom content from plugin config", async () => {
        const { server: s, port } = await setup(coreConnectionURI, {
          appConfig: {
            customContent: {
              verificationModal: {
                title: "Verify your account",
                subtitle: "Enter the code we sent you",
              },
            },
          },
        });
        server = s;
        testPORT = port;

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/app-config`,
        );
        const body = await res.json();

        expect(body.app.config.hub.custom_content.verification_modal).toEqual({
          title: "Verify your account",
          subtitle: "Enter the code we sent you",
        });
      });

      it("returns auth email, mobile, and verification fields from plugin config", async () => {
        const { server: s, port } = await setup(coreConnectionURI, {
          appConfig: {
            userVerificationFields: ["email", "employee_id"],
            capabilities: {
              ios_app: {
                enabled: true,
                app_store_url: "https://apps.apple.com/app/acme",
                team_id: "TEAM123",
                bundle_ids: ["com.acme.app"],
              },
              android_app: {
                enabled: true,
                play_store_url:
                  "https://play.google.com/store/apps/details?id=com.acme.app",
                package_names: ["com.acme.app"],
                sha256_cert_fingerprints: [
                  "00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF",
                ],
              },
              web_app: { enabled: true },
            },
            auth: {
              allowUnverifiedUsers: true,
              email: {
                fromAddress: "Acme <login@acme.com>",
                image: "https://cdn.acme.com/email.png",
                subject: "Sign in to Acme",
                callToActionText: "Continue",
                verifyTemplate: "postmark-template",
                customContent: "Use this link to continue.",
                customClosingContent: "Thanks, Acme",
              },
              mobile: {
                title: "Get Acme",
                image: "https://cdn.acme.com/mobile.png",
                callToActionText: "Download",
                hyperlinkText: "Continue on web",
                hyperlinkRedirectUrl: "https://acme.com/web",
                customContent: "Install the app for the best experience.",
              },
            },
          },
        });
        server = s;
        testPORT = port;

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/app-config`,
        );
        const body = await res.json();
        const auth = body.app.config.hub.auth;

        expect(body.app.user_verification_fields).toEqual([
          "email",
          "employee_id",
        ]);
        expect(body.app.config.capabilities).toEqual({
          ios_app: {
            enabled: true,
            app_store_url: "https://apps.apple.com/app/acme",
            team_id: "TEAM123",
            bundle_ids: ["com.acme.app"],
          },
          android_app: {
            enabled: true,
            play_store_url:
              "https://play.google.com/store/apps/details?id=com.acme.app",
            package_names: ["com.acme.app"],
            sha256_cert_fingerprints: [
              "00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF",
            ],
          },
          web_app: { enabled: true },
        });
        expect(auth.allow_unverified_users).toBe(true);
        expect(auth.email).toEqual({
          from_address: "Acme <login@acme.com>",
          image: "https://cdn.acme.com/email.png",
          subject: "Sign in to Acme",
          call_to_action_text: "Continue",
          verify_template: "postmark-template",
          custom_content: "Use this link to continue.",
          custom_closing_content: "Thanks, Acme",
        });
        expect(auth.mobile).toEqual({
          title: "Get Acme",
          image: "https://cdn.acme.com/mobile.png",
          call_to_action_text: "Download",
          hyperlink_text: "Continue on web",
          hyperlink_redirect_url: "https://acme.com/web",
          custom_content: "Install the app for the best experience.",
        });
      });

      it("returns selected Rownd app and hub UI config fields", async () => {
        const { server: s, port } = await setup(coreConnectionURI, {
          appConfig: {
            web: { enabled: true },
            bottomSheet: { enabled: true },
            profileStorageVersion: "v2",
            allowedWebOrigins: ["https://app.acme.com"],
            branding: {
              animations: { loading: "https://cdn.acme.com/loading.json" },
              hubPrimaryColor: "#111111",
              backgroundColor: "#222222",
              fontFamily: "Inter",
              hideVerificationIcons: true,
              blurBackgroundOpacity: 0.5,
              offsetX: 12,
              offsetY: 24,
              propertyOverrides: { "--rph-button-radius": "20px" },
              customScripts: [
                {
                  type: "application/javascript",
                  content: "window.acme = true;",
                },
              ],
            },
            customContent: {
              signInModal: {
                signInButton: "Log in",
                signUpButton: "Create account",
              },
              noAccountMessage: { title: "No account found" },
              mobile: {
                origins_to_show_in_bottom_sheet: ["https://app.acme.com"],
              },
            },
            profile: {
              addSignInMethodsButton: { enabled: false },
            },
          },
        });
        server = s;
        testPORT = port;

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/app-config`,
        );
        const body = await res.json();

        expect(body.app.config.web).toEqual({ enabled: true });
        expect(body.app.config.bottom_sheet).toEqual({ enabled: true });
        expect(body.app.config.profile_storage_version).toBe("v2");
        expect(body.app.config.customizations.animations).toEqual({
          loading: "https://cdn.acme.com/loading.json",
        });
        expect(body.app.config.hub.allowed_web_origins).toEqual([
          "https://app.acme.com",
        ]);
        expect(body.app.config.hub.customizations).toMatchObject({
          primary_color: "#111111",
          background_color: "#222222",
          font_family: "Inter",
          hide_verification_icons: true,
          blur_background_opacity: 0.5,
          offset_x: 12,
          offset_y: 24,
          property_overrides: { "--rph-button-radius": "20px" },
        });
        expect(body.app.config.hub.custom_scripts).toEqual([
          { type: "application/javascript", content: "window.acme = true;" },
        ]);
        expect(body.app.config.hub.custom_content.sign_in_modal).toMatchObject({
          sign_in_button: "Log in",
          sign_up_button: "Create account",
        });
        expect(body.app.config.hub.custom_content.no_account_message).toEqual({
          title: "No account found",
        });
        expect(body.app.config.hub.custom_content.mobile).toEqual({
          origins_to_show_in_bottom_sheet: ["https://app.acme.com"],
        });
        expect(body.app.config.hub.profile.add_sign_in_methods_button).toEqual({
          enabled: false,
        });
      });

      it("returns anonymous instant user config", async () => {
        const { server: s, port } = await setup(coreConnectionURI, {
          appConfig: {
            signInMethods: [{ method: "anonymous", type: "instant" }],
          },
        });
        server = s;
        testPORT = port;

        const instantRes = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/app-config`,
        );
        const instantBody = await instantRes.json();

        expect(instantBody.app.config.hub.auth.instant_user).toEqual({
          enabled: true,
        });
        expect(
          instantBody.app.config.hub.auth.sign_in_methods.anonymous.enabled,
        ).toBe(false);
      });

      it("returns anonymous guest config", async () => {
        const { server: s, port } = await setup(coreConnectionURI, {
          appConfig: {
            signInMethods: [
              {
                method: "anonymous",
                type: "guest",
                displayName: "Continue as guest",
              },
            ],
          },
        });
        server = s;
        testPORT = port;

        const guestRes = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/app-config`,
        );
        const guestBody = await guestRes.json();

        expect(guestBody.app.config.hub.auth.instant_user).toBeUndefined();
        expect(
          guestBody.app.config.hub.auth.sign_in_methods.anonymous,
        ).toMatchObject({
          enabled: true,
          type: "guest",
          display_name: "Continue as guest",
        });
      });

      it("returns operator-provided schema in response", async () => {
        const { server: s, port } = await setup(coreConnectionURI, {
          schema: {
            employee_id: {
              display_name: "Employee ID",
              type: "string",
              owned_by: "app",
              user_visible: false,
              read_only: true,
            },
          },
        });
        server = s;
        testPORT = port;

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/app-config`,
        );
        const body = await res.json();

        expect(body.app.schema.employee_id).toBeDefined();
        expect(body.app.schema.employee_id.display_name).toBe("Employee ID");
        expect(body.app.schema.employee_id.read_only).toBe(true);
        expect(body.app.schema.employee_id.owned_by).toBe("app");
        // Fields not in userSchema and not injected via auth should not appear
        expect(body.app.schema.email).toBeUndefined();
      });

      it("fills in defaults for optional schema fields", async () => {
        const { server: s, port } = await setup(coreConnectionURI, {
          schema: {
            nickname: {
              display_name: "Nickname",
              type: "string",
              user_visible: true,
            },
          },
        });
        server = s;
        testPORT = port;

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/app-config`,
        );
        const body = await res.json();
        const field = body.app.schema.nickname;

        expect(field.owned_by).toBe("user");
        expect(field.read_only).toBe(false);
        expect(field.show_empty).toBe(false);
      });

      it("schema from RowndPluginConfig appears in response (regression for schema drop bug)", async () => {
        const { server: s, port } = await setup(coreConnectionURI, {
          schema: DEFAULT_ROWND_SCHEMA,
        });
        server = s;
        testPORT = port;

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/app-config`,
        );
        const body = await res.json();

        expect(body.app.schema.first_name).toBeDefined();
        expect(body.app.schema.last_name).toBeDefined();
      });

      it("custom OAuth2 provider appears in sign_in_methods", async () => {
        const { server: s, port } = await setup(coreConnectionURI, {
          appConfig: {
            signInMethods: [
              {
                method: "github",
                displayName: "GitHub",
                iconLightUrl: "https://cdn.example.com/github.png",
              },
            ],
          },
        });
        server = s;
        testPORT = port;

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/app-config`,
        );
        const body = await res.json();
        const methods = body.app.config.hub.auth.sign_in_methods;

        expect(methods.github).toBeDefined();
        expect(methods.github.enabled).toBe(true);
        expect(methods.github.display_name).toBe("GitHub");
        expect(methods.github.icon_light_url).toBe(
          "https://cdn.example.com/github.png",
        );
      });
    });

    describe("POST /guest", () => {
      it("uses the requested tenant for guest creation and session creation", async () => {
        const tenantId = "guest-tenant";
        const recipeUserId = { getAsString: () => "guest-recipe-user" } as any;
        const createGuest = vi
          .spyOn(ThirdParty, "manuallyCreateOrUpdateUser")
          .mockResolvedValue({
            status: "OK",
            createdNewRecipeUser: true,
            recipeUserId,
            user: { id: "guest-user" },
          } as any);
        const createNewSession = vi
          .spyOn(Session, "createNewSession")
          .mockResolvedValue({} as any);
        const req = {
          getKeyValueFromQuery: (key: string) =>
            key === "tenantId" ? tenantId : undefined,
          getJSONBody: async () => ({}),
        } as any;
        const res = {} as any;
        const userContext = { requestId: "guest-request" };

        const result = await handleGuestLogin({
          pluginConfig: {
            rowndAppKey: "test-key",
            rowndAppSecret: "test-secret",
          },
          stConfig: {} as any,
          telemetryClient: {
            recordSuccess: vi.fn(),
            recordError: vi.fn(),
          },
        })(req, res, undefined, userContext);

        expect(result).toEqual({
          status: "OK",
          createdNewRecipeUser: true,
        });
        expect(createGuest).toHaveBeenCalledWith(
          tenantId,
          "guest",
          expect.stringMatching(/^guest_/),
          expect.stringMatching(/^guest_.*@anonymous\.local$/),
          false,
          undefined,
          userContext,
        );
        expect(createNewSession).toHaveBeenCalledWith(
          req,
          res,
          tenantId,
          recipeUserId,
          expect.objectContaining({ auth_level: "guest" }),
          {},
          userContext,
        );
      });

      it("should create a guest user and a session with correct claims (default auth_level)", async () => {
        const { server: s, port } = await setup(coreConnectionURI, {
          appConfig: { id: "app_xyz" },
          subBrands: {
            variant_123: {
              id: "app_xyz",
              variant: { id: "variant_123" },
            },
          },
        });
        server = s;
        testPORT = port;

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/guest?app_variant_id=variant_123`,
          {
            method: "POST",
            headers: {
              rid: "session",
              "fdi-version": "1.18",
            },
          },
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.status).toBe("OK");
        expect(body.createdNewRecipeUser).toBe(true);

        const accessToken = res.headers.get("st-access-token");
        expect(accessToken).toBeTruthy();

        const userRes = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user`,
          {
            headers: getAuthedHeaders(accessToken!),
          },
        );
        expect(userRes.status).toBe(200);
        const userData = await userRes.json();
        expect(userData.status).toBe("OK");
        expect(userData.auth_level).toBe("guest");

        const stUser = await SuperTokens.getUser(userData.data.user_id);
        expect(stUser).toBeDefined();

        const session = await Session.getSessionWithoutRequestResponse(
          accessToken!,
        );
        const accessTokenPayload = session!.getAccessTokenPayload();
        expect(accessTokenPayload["auth_level"]).toBe("guest");
        expect(accessTokenPayload["is_verified_user"]).toBe(true);
        expect(accessTokenPayload[ROWND_JWT_CLAIMS.AppUserId]).toBe(stUser?.id);
        expect(accessTokenPayload[ROWND_JWT_CLAIMS.AuthLevel]).toBe("guest");
        expect(accessTokenPayload[ROWND_JWT_CLAIMS.IsVerifiedUser]).toBe(true);
        expect(accessTokenPayload[ROWND_JWT_CLAIMS.IsAnonymous]).toBe(true);
        expect(accessTokenPayload["anonymous_id"]).toMatch(/^anon_/);
        expect(accessTokenPayload.aud).toEqual([
          "app:app_xyz",
          "app_variant:variant_123",
        ]);
        await expect(
          session?.getClaimValue(RowndIsAnonymousClaim),
        ).resolves.toBe(true);
        expect(accessTokenPayload["app_user_id"]).toBe(stUser?.id);

        const metadata = await getUserMetadata(stUser!.id);
        expect(
          (metadata.metadata as any).original_rownd_user.attributes[
            "rownd:app_variants"
          ],
        ).toEqual(["variant_123"]);

        const guestLogin = stUser?.loginMethods.find(
          (m) => m.recipeId === "thirdparty" && m.thirdParty?.id === "guest",
        );
        expect(guestLogin).toBeDefined();
        expect(guestLogin?.thirdParty?.userId).toMatch(/^guest_[a-f0-9-]{36}$/);
      });

      it("should use the instant provider while exposing instant auth_level", async () => {
        const { server: s, port } = await setup(coreConnectionURI);
        server = s;
        testPORT = port;

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/guest`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              rid: "session",
              "fdi-version": "1.18",
            },
            body: JSON.stringify({ auth_level: "instant" }),
          },
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.status).toBe("OK");

        const accessToken = res.headers.get("st-access-token");
        expect(accessToken).toBeTruthy();

        const session = await Session.getSessionWithoutRequestResponse(
          accessToken!,
        );
        const accessTokenPayload = session!.getAccessTokenPayload();
        expect(accessTokenPayload["auth_level"]).toBe("instant");
        expect(accessTokenPayload).not.toHaveProperty("anonymous_id");
        expect(accessTokenPayload[ROWND_JWT_CLAIMS.AuthLevel]).toBe("instant");
        expect(accessTokenPayload[ROWND_JWT_CLAIMS.IsAnonymous]).toBe(true);
        await expect(
          session?.getClaimValue(RowndIsAnonymousClaim),
        ).resolves.toBe(true);

        const stUser = await SuperTokens.getUser(session!.getUserId());
        const instantLogin = stUser?.loginMethods.find(
          (m) => m.recipeId === "thirdparty" && m.thirdParty?.id === "instant",
        );
        expect(instantLogin).toBeDefined();
        expect(instantLogin?.thirdParty?.userId).toMatch(/^anon_/);

        const userRes = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user`,
          {
            headers: getAuthedHeaders(accessToken!),
          },
        );
        expect(userRes.status).toBe(200);
        const userData = await userRes.json();
        expect(userData.auth_level).toBe("instant");
        expect(userData.data.user_id).toBe(session!.getUserId());
        expect(userData.data).not.toHaveProperty("anonymous_id");
      });
    });

    describe("GET /user", () => {
      it("gets compatibility user payload", async () => {
        const { server: s, port } = await setup(importCoreConnectionURI);
        server = s;
        testPORT = port;
        const accessToken = await createSessionForUser("compat-user-1");

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user`,
          {
            headers: getAuthedHeaders(accessToken),
          },
        );

        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({
          status: "OK",
          rownd_user: "compat-user-1",
          data: {
            user_id: "compat-user-1",
            email: "compat-user-1@example.com",
            first_name: "",
            last_name: "",
            nick_name: "",
            zip_code: "",
          },
          meta: {
            created: expect.any(String),
            first_sign_in: expect.any(String),
            last_sign_in: expect.any(String),
            last_active: expect.any(String),
            first_sign_in_method: "email",
            last_sign_in_method: "email",
          },
          verified_data: {
            email: "compat-user-1@example.com",
          },
          state: "enabled",
          auth_level: "verified",
          redacted: [],
          groups: [],
          attributes: {},
        });
      });

      it.each([
        { providerId: "google", field: "google_id" },
        { providerId: "apple", field: "apple_id" },
      ])(
        "includes $field from a $providerId-only third-party user",
        async ({ providerId, field }) => {
          const { server: s, port } = await setup(coreConnectionURI);
          server = s;
          testPORT = port;
          const email = `${providerId}-thirdparty-only@example.com`;
          const providerUserId = `${providerId}-thirdparty-only-id`;

          const thirdPartyResult = await signInUpWithTestProvider({
            providerId,
            providerUserId,
            email,
          });
          expect(thirdPartyResult.status).toBe("OK");
          expect(thirdPartyResult.accessToken).toBeDefined();

          const res = await fetch(
            `http://localhost:${testPORT}/auth/plugin/rownd/user`,
            {
              headers: getAuthedHeaders(thirdPartyResult.accessToken!),
            },
          );

          expect(res.status).toBe(200);
          const body = await res.json();
          expect(body.status).toBe("OK");
          expect(body.rownd_user).toBe(thirdPartyResult.user.id);
          expect(body.data).toEqual(
            expect.objectContaining({
              user_id: thirdPartyResult.user.id,
              email,
              [field]: providerUserId,
            }),
          );
          expect(body.verified_data).toEqual(
            expect.objectContaining({
              email,
              [field]: providerUserId,
            }),
          );
          expect(body.auth_level).toBe("verified");
        },
      );

      it("links third-party login to an existing passwordless account with the same email", async () => {
        const { server: s, port } = await setup(importCoreConnectionURI);
        server = s;
        testPORT = port;
        const email = `linked-auth-methods-${randomUUID()}@example.com`;
        const providerUserId = `google-${randomUUID()}`;
        const passwordless = await createPasswordlessSessionForUser(email);

        const linkingResult = await signInUpWithTestProvider({
          providerId: "google",
          providerUserId,
          email,
        });

        expect(linkingResult.status).toBe("OK");
        expect(linkingResult.user.id).toBe(passwordless.userId);

        const linkedUser = await SuperTokens.getUser(passwordless.userId);
        expect(linkedUser?.loginMethods).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              recipeId: "passwordless",
              email,
            }),
            expect.objectContaining({
              recipeId: "thirdparty",
              email,
              thirdParty: {
                id: "google",
                userId: providerUserId,
              },
            }),
          ]),
        );

        const subsequentThirdPartyLogin = await signInUpWithTestProvider({
          providerId: "google",
          providerUserId,
          email,
        });

        expect(subsequentThirdPartyLogin.status).toBe("OK");
        expect(subsequentThirdPartyLogin.user.id).toBe(passwordless.userId);
      });

      it.each([
        { providerId: "google", field: "google_id" },
        { providerId: "apple", field: "apple_id" },
      ])(
        "includes $field from a $providerId login method linked after migration",
        async ({ providerId, field }) => {
          const { server: s, port } = await setup(importCoreConnectionURI);
          server = s;
          testPORT = port;
          const email = `${providerId}-linked-after-migration@example.com`;
          const providerUserId = `${providerId}-linked-after-migration-id`;
          const passwordlessResult = await Passwordless.signInUp({
            email,
            tenantId: "public",
          });
          await UserMetadata.updateUserMetadata(passwordlessResult.user.id, {
            original_rownd_user: {
              state: "enabled",
              auth_level: "verified",
              data: {
                user_id: passwordlessResult.user.id,
                email,
              },
              verified_data: {
                email,
              },
              attributes: {},
            },
          });

          const thirdPartyResult = await signInUpWithTestProvider({
            providerId,
            providerUserId,
            email,
          });
          expect(thirdPartyResult.status).toBe("OK");
          expect(thirdPartyResult.user.loginMethods).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ recipeId: "passwordless", email }),
              expect.objectContaining({
                recipeId: "thirdparty",
                thirdParty: { id: providerId, userId: providerUserId },
              }),
            ]),
          );
          const accessToken = thirdPartyResult.accessToken;
          expect(accessToken).toBeDefined();

          const res = await fetch(
            `http://localhost:${testPORT}/auth/plugin/rownd/user`,
            {
              headers: getAuthedHeaders(accessToken!),
            },
          );

          expect(res.status).toBe(200);
          const body = await res.json();
          console.log(body);

          expect(body.status).toBe("OK");
          expect(body.rownd_user).toBe(thirdPartyResult.user.id);
          expect(body.data[field]).toBe(providerUserId);
          expect(body.verified_data.email).toBe(email);
          expect(body.verified_data[field]).toBe(providerUserId);
        },
      );

      it.each([
        { providerId: "google", field: "google_id" },
        { providerId: "apple", field: "apple_id" },
      ])(
        "includes linked $providerId id in verified_data for an imported Rownd user",
        async ({ providerId, field }) => {
          const { server: s, port } = await setup(importCoreConnectionURI);
          server = s;
          testPORT = port;
          const rowndUserId = `${providerId}-imported-linked-user`;
          const email = `${providerId}-imported-linked@example.com`;
          const providerUserId = `${providerId}-imported-linked-id`;

          const passwordlessResult = await Passwordless.signInUp({
            email,
            tenantId: "public",
          });
          const importedUser = passwordlessResult.user;
          await UserMetadata.updateUserMetadata(importedUser.id, {
            original_rownd_user: {
              state: "enabled",
              auth_level: "verified",
              data: {
                user_id: rowndUserId,
                email,
              },
              verified_data: { email: true },
              attributes: {},
            },
          });

          const passwordlessMethod = importedUser?.loginMethods.find(
            (method) =>
              method.recipeId === "passwordless" && method.email === email,
          );
          expect(passwordlessMethod).toBeDefined();

          const importedMetadata = await UserMetadata.getUserMetadata(
            importedUser.id,
          );
          expect(
            (importedMetadata.metadata as any).original_rownd_user
              .verified_data,
          ).toEqual({ email: true });

          const thirdPartyResult = await signInUpWithTestProvider({
            providerId,
            providerUserId,
            email,
          });
          expect(thirdPartyResult.status).toBe("OK");
          expect(thirdPartyResult.user.loginMethods).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ recipeId: "passwordless", email }),
              expect.objectContaining({
                recipeId: "thirdparty",
                thirdParty: { id: providerId, userId: providerUserId },
              }),
            ]),
          );

          const staleMetadata = await UserMetadata.getUserMetadata(
            thirdPartyResult.user.id,
          );
          expect(
            (staleMetadata.metadata as any).original_rownd_user.verified_data,
          ).toEqual({ email: true });
          const accessToken = thirdPartyResult.accessToken;
          expect(accessToken).toBeDefined();

          const res = await fetch(
            `http://localhost:${testPORT}/auth/plugin/rownd/user`,
            {
              headers: getAuthedHeaders(accessToken!),
            },
          );

          expect(res.status).toBe(200);
          const body = await res.json();
          expect(body.status).toBe("OK");
          expect(body.data[field]).toBe(providerUserId);
          expect(body.verified_data.email).toBe(email);
          expect(body.verified_data[field]).toBe(providerUserId);
        },
      );

      it("returns empty strings for missing schema fields", async () => {
        const { server: s, port } = await setup(importCoreConnectionURI);
        server = s;
        testPORT = port;
        const accessToken = await createSessionForUser("empty-schema-user");

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user`,
          {
            headers: getAuthedHeaders(accessToken),
          },
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.status).toBe("OK");
        expect(body.data.first_name).toBe("");
        expect(body.data.last_name).toBe("");
        expect(body.data.zip_code).toBe("");
      });

      it("rejects without session", async () => {
        const { server: s, port } = await setup(coreConnectionURI);
        server = s;
        testPORT = port;

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user`,
        );
        // SuperTokens middleware handles sessionRequired by sending a 401 or status: TRY_REFRESH_TOKEN or similar
        // depending on the client. For fetch without cookies/headers, it often returns TRY_REFRESH_TOKEN if sessionRequired is true
        const body = await res.json();
        expect(body.status).not.toBe("OK");
      });

      it("gets compatibility user payload for a non-migrated user", async () => {
        const { server: s, port } = await setup(importCoreConnectionURI);
        server = s;
        testPORT = port;

        const signInRes = await Passwordless.signInUp({
          email: "non-migrated@example.com",
          tenantId: "public",
        });
        const userId = signInRes.user.id;

        mockRowndClient.validateToken.mockResolvedValue({ user_id: userId });
        mockRowndClient.fetchUserInfo.mockResolvedValue({
          app_user_id: userId,
          data: { user_id: userId, email: "non-migrated@example.com" },
          verified_data: { email: true },
        });

        const migrateRes = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/migrate`,
          {
            method: "POST",
            headers: {
              Authorization: "Bearer some-token",
              rid: "session",
              "fdi-version": "1.18",
            },
          },
        );
        const accessToken = migrateRes.headers.get("st-access-token");
        expect(accessToken).toBeTruthy();

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user`,
          {
            headers: getAuthedHeaders(accessToken!),
          },
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({
          status: "OK",
          rownd_user: userId,
          data: {
            user_id: userId,
            email: "non-migrated@example.com",
            first_name: "",
            last_name: "",
            nick_name: "",
            zip_code: "",
          },
          meta: {
            created: expect.any(String),
            first_sign_in: expect.any(String),
            last_sign_in: expect.any(String),
            last_active: expect.any(String),
            first_sign_in_method: "email",
            last_sign_in_method: "email",
          },
          verified_data: {
            email: "non-migrated@example.com",
          },
          state: "enabled",
          auth_level: "verified",
          redacted: [],
          groups: [],
          attributes: {},
        });
      });

      it("uses latest session creation time for last sign-in timestamps", async () => {
        const { server: s, port } = await setup(importCoreConnectionURI);
        server = s;
        testPORT = port;
        const firstAccessToken = await createSessionForUser(
          "latest-session-time-user",
        );
        const firstSession =
          await Session.getSessionWithoutRequestResponse(firstAccessToken);
        const stUser = await SuperTokens.getUser(firstSession.getUserId());
        const recipeUserId = stUser?.loginMethods[0]?.recipeUserId;
        expect(recipeUserId).toBeDefined();

        await new Promise((resolve) => setTimeout(resolve, 20));

        const latestSession =
          await Session.createNewSessionWithoutRequestResponse(
            "public",
            recipeUserId!,
            {},
            {},
            true,
          );
        const latestSessionInfo = await Session.getSessionInformation(
          latestSession.getHandle(),
        );
        expect(latestSessionInfo).toBeDefined();

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user`,
          {
            headers: getAuthedHeaders(latestSession.getAccessToken()),
          },
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        const latestSessionCreatedAt = new Date(
          latestSessionInfo!.timeCreated,
        ).toISOString();
        expect(body.status).toBe("OK");
        expect(body.meta.last_sign_in).toBe(latestSessionCreatedAt);
        expect(body.meta.last_active).toBe(latestSessionCreatedAt);
      });

      it("uses latest session recipe user id for last sign-in method", async () => {
        const { server: s, port } = await setup(coreConnectionURI);
        server = s;
        testPORT = port;
        const passwordlessResult = await Passwordless.signInUp({
          email: "latest-session-method@example.com",
          tenantId: "public",
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        const thirdPartyResult = await ThirdParty.manuallyCreateOrUpdateUser(
          "public",
          "google",
          "latest-session-method-google-id",
          "latest-session-method@example.com",
          true,
        );
        expect(thirdPartyResult.status).toBe("OK");
        if (thirdPartyResult.status !== "OK") {
          throw new Error("failed to create thirdparty user");
        }

        const primaryResult = await AccountLinking.createPrimaryUser(
          passwordlessResult.recipeUserId,
        );
        const primaryUserId =
          primaryResult.status === "OK"
            ? primaryResult.user.id
            : passwordlessResult.user.id;
        const linkResult = await AccountLinking.linkAccounts(
          thirdPartyResult.recipeUserId,
          primaryUserId,
        );
        expect(linkResult.status).toBe("OK");

        await UserMetadata.updateUserMetadata(primaryUserId, {
          original_rownd_user: {
            state: "enabled",
            auth_level: "verified",
            data: {
              user_id: primaryUserId,
              email: "latest-session-method@example.com",
              google_id: "latest-session-method-google-id",
            },
            verified_data: {
              email: "latest-session-method@example.com",
              google_id: "latest-session-method-google-id",
            },
            attributes: {},
          },
        });

        const latestSession =
          await Session.createNewSessionWithoutRequestResponse(
            "public",
            passwordlessResult.recipeUserId,
            {},
            {},
            true,
          );

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user`,
          {
            headers: getAuthedHeaders(latestSession.getAccessToken()),
          },
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.status).toBe("OK");
        expect(body.meta.last_sign_in_method).toBe("email");
      });
    });

    describe("PUT /user", () => {
      it("updates compatibility user data", async () => {
        const { server: s, port } = await setup(importCoreConnectionURI);
        server = s;
        testPORT = port;
        const accessToken = await createSessionForUser("compat-user-2");

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user`,
          {
            method: "PUT",
            headers: {
              ...getAuthedHeaders(accessToken),
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ data: { first_name: "Ada" } }),
          },
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.status).toBe("OK");
        expect(body.rownd_user).toBe("compat-user-2");
        expect(body.data).toEqual({
          user_id: "compat-user-2",
          email: "compat-user-2@example.com",
          first_name: "Ada",
          last_name: "",
          nick_name: "",
          zip_code: "",
        });
        expect(body.meta.created).toEqual(expect.any(String));
        expect(body.meta.first_sign_in).toEqual(expect.any(String));
        expect(body.verified_data.email).toBe("compat-user-2@example.com");
        expect(body.state).toBe("enabled");
        expect(body.auth_level).toBe("verified");
      });

      it("rejects updates to app-owned user data fields", async () => {
        const { server: s, port } = await setup(importCoreConnectionURI, {
          schema: {
            employee_id: {
              display_name: "Employee ID",
              type: "string",
              owned_by: "app",
              user_visible: false,
            },
          },
        });
        server = s;
        testPORT = port;
        const accessToken = await createSessionForUser("app-owned-field-user");

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user`,
          {
            method: "PUT",
            headers: {
              ...getAuthedHeaders(accessToken),
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ data: { employee_id: "E-123" } }),
          },
        );

        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body.status).toBe("ERROR");
        expect(body.message).toBe("field is not writable: employee_id");
      });

      it("rejects email changes when email sign-in is disabled", async () => {
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
          enableEmailSignIn: false,
        });
        server = s;
        testPORT = port;
        const { accessToken, userId } = await createPasswordlessSessionForUser(
          "email-disabled-user@example.com",
        );

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user`,
          {
            method: "PUT",
            headers: {
              ...getAuthedHeaders(accessToken),
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              data: {
                email: "email-disabled-new@example.com",
                first_name: "Not saved",
              },
            }),
          },
        );

        expect(res.status).toBe(403);
        const metadata = await UserMetadata.getUserMetadata(userId);
        expect((metadata.metadata as any).first_name).toBeUndefined();
        expect((metadata.metadata as any).rownd_pending_verification).toBeUndefined();
      });

      it("updates other fields when a disabled email method is unchanged", async () => {
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
          enableEmailSignIn: false,
        });
        server = s;
        testPORT = port;
        const { accessToken } = await createPasswordlessSessionForUser(
          "unchanged-disabled-email@example.com",
        );

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user`,
          {
            method: "PUT",
            headers: {
              ...getAuthedHeaders(accessToken),
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              data: {
                email: " UNCHANGED-DISABLED-EMAIL@example.com ",
                first_name: "Saved",
              },
            }),
          },
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.email).toBe("unchanged-disabled-email@example.com");
        expect(body.data.first_name).toBe("Saved");
      });

      it("allows a fresh native SuperTokens session to change email", async () => {
        const { server: s, port } = await setup(
          coreConnectionURI,
          { emailChange: { maxSessionAgeSeconds: 600 } },
          { enableEmailVerification: true },
        );
        server = s;
        testPORT = port;
        const { accessToken } = await createPasswordlessSessionForUser(
          "fresh-native-email-user@example.com",
        );

        const res = await requestEmailChange(
          accessToken,
          "fresh-native-email-user-new@example.com",
        );

        expect(res.status).toBe(200);
        expect((await res.json()).status).toBe("OK");
      });

      it("rejects an aged native SuperTokens session", async () => {
        const { server: s, port } = await setup(
          coreConnectionURI,
          { emailChange: { maxSessionAgeSeconds: 0.001 } },
          { enableEmailVerification: true },
        );
        server = s;
        testPORT = port;
        const { accessToken, userId } = await createPasswordlessSessionForUser(
          "stale-email-user@example.com",
        );
        await new Promise((resolve) => setTimeout(resolve, 10));

        const res = await requestEmailChange(
          accessToken,
          "stale-email-new@example.com",
        );

        expect(res.status).toBe(403);
        await expect(res.json()).resolves.toEqual({
          status: "ERROR",
          code: 403,
          message: "recent authentication is required to change email",
        });
        const metadata = await UserMetadata.getUserMetadata(userId);
        expect((metadata.metadata as any).rownd_pending_verification).toBeUndefined();
      });

      it("allows a freshly migrated session to change email", async () => {
        const { server: s, port } = await setup(
          importCoreConnectionURI,
          { emailChange: { maxSessionAgeSeconds: 600 } },
          { enableEmailVerification: true },
        );
        server = s;
        testPORT = port;
        const accessToken = await createSessionForUser(
          "freshly-migrated-user",
          "freshly-migrated-user@example.com",
        );

        const res = await requestEmailChange(
          accessToken,
          "freshly-migrated-user-new@example.com",
        );

        expect(res.status).toBe(200);
        expect((await res.json()).status).toBe("OK");
      });

      it("keeps the original native authentication age after session refresh", async () => {
        const { server: s, port } = await setup(
          coreConnectionURI,
          { emailChange: { maxSessionAgeSeconds: 0.001 } },
          { enableEmailVerification: true },
        );
        server = s;
        testPORT = port;
        const { refreshToken, sessionHandle } =
          await createPasswordlessSessionForUser(
            "refreshed-stale-native-user@example.com",
          );
        const originalSessionInfo = await Session.getSessionInformation(
          sessionHandle,
        );
        expect(originalSessionInfo).toBeDefined();
        await new Promise((resolve) => setTimeout(resolve, 10));

        const refreshedSession =
          await Session.refreshSessionWithoutRequestResponse(refreshToken, true);
        const refreshedSessionInfo = await Session.getSessionInformation(
          refreshedSession.getHandle(),
        );
        expect(refreshedSession.getHandle()).toBe(sessionHandle);
        expect(refreshedSessionInfo?.timeCreated).toBe(
          originalSessionInfo?.timeCreated,
        );

        const res = await requestEmailChange(
          refreshedSession.getAccessToken(),
          "refreshed-stale-native-user-new@example.com",
        );

        expect(res.status).toBe(403);
        await expect(res.json()).resolves.toEqual({
          status: "ERROR",
          code: 403,
          message: "recent authentication is required to change email",
        });
      });

      it("updates other fields from a stale session when email is unchanged", async () => {
        const { server: s, port } = await setup(
          coreConnectionURI,
          { emailChange: { maxSessionAgeSeconds: 0.001 } },
          { enableEmailVerification: true },
        );
        server = s;
        testPORT = port;
        const { accessToken } = await createPasswordlessSessionForUser(
          "unchanged-stale-email@example.com",
        );
        await new Promise((resolve) => setTimeout(resolve, 10));

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user`,
          {
            method: "PUT",
            headers: {
              ...getAuthedHeaders(accessToken),
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              data: {
                email: "unchanged-stale-email@example.com",
                first_name: "Saved",
              },
            }),
          },
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.email).toBe("unchanged-stale-email@example.com");
        expect(body.data.first_name).toBe("Saved");
      });

      it("defers email updates until verification completes", async () => {
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
        });
        server = s;
        testPORT = port;
        const { accessToken, userId, recipeUserId, sessionHandle } =
          await createPasswordlessSessionForUser(
            "email-update-user@example.com",
          );

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user`,
          {
            method: "PUT",
            headers: {
              ...getAuthedHeaders(accessToken),
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              data: {
                email: " New-Email-Update@Example.com ",
                first_name: "Grace",
              },
            }),
          },
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.status).toBe("OK");
        expect(body.data.email).toBe("email-update-user@example.com");
        expect(body.data.first_name).toBe("Grace");
        expect(body.verified_data.email).toBe("email-update-user@example.com");

        let metadata = await UserMetadata.getUserMetadata(userId);
        expect((metadata.metadata as any).rownd_pending_verification).toEqual([
          {
            id: expect.any(String),
            field: "email",
            value: " New-Email-Update@Example.com ",
            created_at: expect.any(String),
            tenantId: "public",
            purpose: "UPDATE_PASSWORDLESS",
            initiatingSessionHandle: sessionHandle,
            verificationRecipeUserId: recipeUserId.getAsString(),
            status: "PENDING",
          },
        ]);
        expect((metadata.metadata as any).email).toBeUndefined();

        const tokenResponse =
          await EmailVerification.createEmailVerificationToken(
            "public",
            recipeUserId,
            "new-email-update@example.com",
          );
        expect(tokenResponse.status).toBe("OK");

        const verifyRes = await verifyEmailToken(
          tokenResponse.status === "OK" ? tokenResponse.token : "unused",
          accessToken,
        );
        expect(verifyRes.status).toBe(200);
        await expect(verifyRes.json()).resolves.toEqual({ status: "OK" });
        const replacementAccessToken = verifyRes.headers.get("st-access-token");
        expect(replacementAccessToken).toBeTruthy();

        metadata = await UserMetadata.getUserMetadata(userId);
        expect((metadata.metadata as any).original_rownd_user.data.email).toBe(
          "new-email-update@example.com",
        );
        expect(
          (metadata.metadata as any).original_rownd_user.verified_data.email,
        ).toBe("new-email-update@example.com");
        expect((metadata.metadata as any).rownd_pending_verification).toEqual(
          [],
        );

        const updatedUser = await SuperTokens.getUser(userId);
        const passwordlessMethods = updatedUser?.loginMethods.filter(
          (method) => method.recipeId === "passwordless" && method.email,
        );
        expect(passwordlessMethods).toHaveLength(1);
        const passwordlessMethod = passwordlessMethods?.[0];
        expect(passwordlessMethod?.email).toBe("new-email-update@example.com");
        expect(passwordlessMethod?.recipeUserId.getAsString()).toBe(
          recipeUserId.getAsString(),
        );
      });

      it("rejects unsupported pending email-change purposes", async () => {
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
        });
        server = s;
        testPORT = port;
        const currentEmail = "unsupported-purpose-current@example.com";
        const targetEmail = "unsupported-purpose-target@example.com";
        const initiatingUser =
          await createPasswordlessSessionForUser(currentEmail);

        const updateRes = await requestEmailChange(
          initiatingUser.accessToken,
          targetEmail,
        );
        expect(updateRes.status).toBe(200);

        const metadata = await UserMetadata.getUserMetadata(
          initiatingUser.userId,
        );
        const pendingVerification = (metadata.metadata as any)
          .rownd_pending_verification[0];
        await UserMetadata.updateUserMetadata(initiatingUser.userId, {
          rownd_pending_verification: [
            { ...pendingVerification, purpose: "UPGRADE_GUEST" },
          ],
        });

        await expect(
          completePendingEmailVerification({
            recipeUserId: initiatingUser.recipeUserId,
            email: targetEmail,
            sessionHandle: initiatingUser.sessionHandle,
          }),
        ).rejects.toThrow(
          "email change session is no longer active; start the email change again",
        );

        const user = await SuperTokens.getUser(initiatingUser.userId);
        expect(user?.loginMethods[0]?.email).toBe(currentEmail);
        const finalMetadata = await UserMetadata.getUserMetadata(
          initiatingUser.userId,
        );
        expect(
          (finalMetadata.metadata as any).rownd_pending_verification,
        ).toEqual([]);
      });

      it("rejects completion when the initiating recipe user is detached", async () => {
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
        });
        server = s;
        testPORT = port;
        const currentEmail = "detached-session-current@example.com";
        const targetEmail = "detached-session-target@example.com";
        const initiatingUser =
          await createPasswordlessSessionForUser(currentEmail);

        const updateRes = await requestEmailChange(
          initiatingUser.accessToken,
          targetEmail,
        );
        expect(updateRes.status).toBe(200);

        const originalGetUser = SuperTokens.getUser;
        let getUserCallCount = 0;
        const getUser = vi
          .spyOn(SuperTokens, "getUser")
          .mockImplementation(async (...input) => {
            const user = await originalGetUser(...input);
            getUserCallCount += 1;
            return getUserCallCount === 2 && user
              ? { ...user, loginMethods: [] }
              : user;
          });

        await expect(
          completePendingEmailVerification({
            recipeUserId: initiatingUser.recipeUserId,
            email: targetEmail,
            sessionHandle: initiatingUser.sessionHandle,
          }),
        ).rejects.toThrow(
          "email change session is no longer active; start the email change again",
        );
        getUser.mockRestore();

        const user = await SuperTokens.getUser(initiatingUser.userId);
        expect(user?.loginMethods[0]?.email).toBe(currentEmail);
      });

      it("clears COMMITTING and fails closed after a generic Core failure immediately after the transition", async () => {
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
        });
        server = s;
        testPORT = port;
        const currentEmail = "committing-failure-current@example.com";
        const targetEmail = "committing-failure-target@example.com";
        const initiatingUser =
          await createPasswordlessSessionForUser(currentEmail);

        const updateRes = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user`,
          {
            method: "PUT",
            headers: {
              ...getAuthedHeaders(initiatingUser.accessToken),
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ data: { email: targetEmail } }),
          },
        );
        expect(updateRes.status).toBe(200);
        const tokenResponse =
          await EmailVerification.createEmailVerificationToken(
            "public",
            initiatingUser.recipeUserId,
            targetEmail,
          );
        expect(tokenResponse.status).toBe("OK");
        if (tokenResponse.status !== "OK") {
          throw new Error("failed to create email verification token");
        }
        await expect(
          EmailVerification.verifyEmailUsingToken(
            "public",
            tokenResponse.token,
            false,
          ),
        ).resolves.toMatchObject({ status: "OK" });

        let statusAtFailure: string | undefined;
        vi.spyOn(Session, "getSessionInformation").mockImplementationOnce(
          async () => {
            const metadata = await UserMetadata.getUserMetadata(
              initiatingUser.userId,
            );
            statusAtFailure = (metadata.metadata as any)
              .rownd_pending_verification[0]?.status;
            throw new Error("session Core request failed after COMMITTING");
          },
        );

        await expect(
          completePendingEmailVerification({
            recipeUserId: initiatingUser.recipeUserId,
            email: targetEmail,
            sessionHandle: initiatingUser.sessionHandle,
          }),
        ).rejects.toThrow("session Core request failed after COMMITTING");
        expect(statusAtFailure).toBe("COMMITTING");

        const user = await SuperTokens.getUser(initiatingUser.userId);
        expect(
          user?.loginMethods.find(
            (method) =>
              method.recipeUserId.getAsString() ===
              initiatingUser.recipeUserId.getAsString(),
          )?.email,
        ).toBe(currentEmail);
        const metadata = await UserMetadata.getUserMetadata(
          initiatingUser.userId,
        );
        expect((metadata.metadata as any).rownd_pending_verification).toEqual(
          [],
        );
        await expect(
          EmailVerification.isEmailVerified(
            initiatingUser.recipeUserId,
            targetEmail,
          ),
        ).resolves.toBe(false);
        await expect(
          Session.getAllSessionHandlesForUser(
            initiatingUser.userId,
            true,
            "public",
          ),
        ).resolves.toEqual([]);
        await expect(
          EmailVerification.verifyEmailUsingToken(
            "public",
            tokenResponse.token,
            false,
          ),
        ).resolves.toEqual({
          status: "EMAIL_VERIFICATION_INVALID_TOKEN_ERROR",
        });
      });

      it("rejects the revoked pre-change token on every account-management route", async () => {
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
        });
        server = s;
        testPORT = port;
        const currentEmail = "revoked-route-current@example.com";
        const targetEmail = "revoked-route-target@example.com";
        const { accessToken, userId, recipeUserId } =
          await createPasswordlessSessionForUser(currentEmail);

        const updateRes = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user`,
          {
            method: "PUT",
            headers: {
              ...getAuthedHeaders(accessToken),
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ data: { email: targetEmail } }),
          },
        );
        expect(updateRes.status).toBe(200);

        const tokenResponse =
          await EmailVerification.createEmailVerificationToken(
            "public",
            recipeUserId,
            targetEmail,
          );
        expect(tokenResponse.status).toBe("OK");
        const verifyRes = await verifyEmailToken(
          tokenResponse.status === "OK" ? tokenResponse.token : "unused",
          accessToken,
        );
        expect(verifyRes.status).toBe(200);
        await expect(verifyRes.json()).resolves.toEqual({ status: "OK" });
        const replacementAccessToken = verifyRes.headers.get("st-access-token");
        expect(replacementAccessToken).toBeTruthy();

        const revokedProfileRes = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user`,
          { headers: getAuthedHeaders(accessToken) },
        );
        const revokedMetaGetRes = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user/meta`,
          { headers: getAuthedHeaders(accessToken) },
        );
        const revokedMetaPutRes = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user/meta`,
          {
            method: "PUT",
            headers: {
              ...getAuthedHeaders(accessToken),
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ meta: { revoked_token_write: true } }),
          },
        );
        const revokedDeleteRes = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user`,
          {
            method: "DELETE",
            headers: getAuthedHeaders(accessToken),
          },
        );

        expect([
          revokedProfileRes.status,
          revokedMetaGetRes.status,
          revokedMetaPutRes.status,
          revokedDeleteRes.status,
        ]).toEqual([401, 401, 401, 401]);
        expect(await SuperTokens.getUser(userId)).toBeDefined();
        const metadata = await UserMetadata.getUserMetadata(userId);
        expect((metadata.metadata as any).revoked_token_write).toBeUndefined();

        const replacementProfileRes = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user`,
          { headers: getAuthedHeaders(replacementAccessToken!) },
        );
        expect(replacementProfileRes.status).toBe(200);
        expect((await replacementProfileRes.json()).data.email).toBe(
          targetEmail,
        );
      });

      it("revokes an old-email session raced after the first account revocation", async () => {
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
        });
        server = s;
        testPORT = port;
        const currentEmail = "revocation-race-current@example.com";
        const targetEmail = "revocation-race-target@example.com";
        const initiatingUser =
          await createPasswordlessSessionForUser(currentEmail);

        const updateRes = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user`,
          {
            method: "PUT",
            headers: {
              ...getAuthedHeaders(initiatingUser.accessToken),
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ data: { email: targetEmail } }),
          },
        );
        expect(updateRes.status).toBe(200);

        const tokenResponse =
          await EmailVerification.createEmailVerificationToken(
            "public",
            initiatingUser.recipeUserId,
            targetEmail,
          );
        expect(tokenResponse.status).toBe("OK");

        const originalRevokeAllSessionsForUser =
          Session.revokeAllSessionsForUser;
        let accountRevocationCount = 0;
        let racedSessionHandle: string | undefined;
        vi.spyOn(Session, "revokeAllSessionsForUser").mockImplementation(
          async (...input) => {
            const result = await originalRevokeAllSessionsForUser(...input);
            accountRevocationCount += 1;
            if (accountRevocationCount === 1) {
              const racedSignIn = await Passwordless.signInUp({
                tenantId: "public",
                email: currentEmail,
              });
              const racedSession =
                await Session.createNewSessionWithoutRequestResponse(
                  "public",
                  racedSignIn.recipeUserId,
                  {},
                  {},
                  true,
                );
              racedSessionHandle = racedSession.getHandle();
            }
            return result;
          },
        );

        const verifyRes = await verifyEmailToken(
          tokenResponse.status === "OK" ? tokenResponse.token : "unused",
          initiatingUser.accessToken,
        );
        expect(verifyRes.status).toBe(200);
        await expect(verifyRes.json()).resolves.toEqual({ status: "OK" });
        expect(accountRevocationCount).toBe(2);
        expect(racedSessionHandle).toBeDefined();
        await expect(
          Session.getSessionInformation(racedSessionHandle!),
        ).resolves.toBeUndefined();

        const replacementAccessToken = verifyRes.headers.get("st-access-token");
        expect(replacementAccessToken).toBeTruthy();
        const replacementSession =
          await Session.getSessionWithoutRequestResponse(
            replacementAccessToken!,
          );
        expect(replacementSession?.getUserId()).toBe(initiatingUser.userId);
        const replacementProfileRes = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user`,
          { headers: getAuthedHeaders(replacementAccessToken!) },
        );
        expect(replacementProfileRes.status).toBe(200);
      });

      it("compensates credential state after a later generic Core failure", async () => {
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
        });
        server = s;
        testPORT = port;
        const currentEmail = "revocation-failure-current@example.com";
        const targetEmail = "revocation-failure-target@example.com";
        const initiatingUser =
          await createPasswordlessSessionForUser(currentEmail);

        const updateRes = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user`,
          {
            method: "PUT",
            headers: {
              ...getAuthedHeaders(initiatingUser.accessToken),
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ data: { email: targetEmail } }),
          },
        );
        expect(updateRes.status).toBe(200);
        const tokenResponse =
          await EmailVerification.createEmailVerificationToken(
            "public",
            initiatingUser.recipeUserId,
            targetEmail,
          );
        expect(tokenResponse.status).toBe("OK");
        if (tokenResponse.status !== "OK") {
          throw new Error("failed to create email verification token");
        }
        await expect(
          EmailVerification.verifyEmailUsingToken(
            "public",
            tokenResponse.token,
            false,
          ),
        ).resolves.toMatchObject({ status: "OK" });

        const originalRevokeAllSessionsForUser =
          Session.revokeAllSessionsForUser;
        let accountRevocationCount = 0;
        let emailAtSecondRevocation: string | undefined;
        vi.spyOn(Session, "revokeAllSessionsForUser").mockImplementation(
          async (...input) => {
            accountRevocationCount += 1;
            if (accountRevocationCount === 2) {
              emailAtSecondRevocation = (
                await SuperTokens.getUser(initiatingUser.userId)
              )?.loginMethods.find(
                (method) =>
                  method.recipeUserId.getAsString() ===
                  initiatingUser.recipeUserId.getAsString(),
              )?.email;
              throw new Error("second account revocation failed");
            }
            return originalRevokeAllSessionsForUser(...input);
          },
        );

        await expect(
          completePendingEmailVerification({
            recipeUserId: initiatingUser.recipeUserId,
            email: targetEmail,
            sessionHandle: initiatingUser.sessionHandle,
          }),
        ).rejects.toThrow("second account revocation failed");
        expect(accountRevocationCount).toBe(3);
        expect(emailAtSecondRevocation).toBe(targetEmail);

        const user = await SuperTokens.getUser(initiatingUser.userId);
        expect(
          user?.loginMethods.find(
            (method) =>
              method.recipeUserId.getAsString() ===
              initiatingUser.recipeUserId.getAsString(),
          )?.email,
        ).toBe(currentEmail);
        const metadata = await UserMetadata.getUserMetadata(
          initiatingUser.userId,
        );
        expect((metadata.metadata as any).rownd_pending_verification).toEqual(
          [],
        );
        await expect(
          EmailVerification.isEmailVerified(
            initiatingUser.recipeUserId,
            targetEmail,
          ),
        ).resolves.toBe(false);
        await expect(
          Session.getAllSessionHandlesForUser(
            initiatingUser.userId,
            true,
            "public",
          ),
        ).resolves.toEqual([]);
      });

      it("rejects completion after the initiating session is revoked", async () => {
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
        });
        server = s;
        testPORT = port;
        const { accessToken, sessionHandle, userId, recipeUserId } =
          await createPasswordlessSessionForUser(
            "revoked-session-current@example.com",
          );

        const updateRes = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user`,
          {
            method: "PUT",
            headers: {
              ...getAuthedHeaders(accessToken),
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              data: { email: "revoked-session-target@example.com" },
            }),
          },
        );
        expect(updateRes.status).toBe(200);
        await expect(Session.revokeSession(sessionHandle)).resolves.toBe(true);

        await expect(
          completePendingEmailVerification({
            recipeUserId,
            email: "revoked-session-target@example.com",
            sessionHandle,
          }),
        ).rejects.toThrow(
          "email change session is no longer active; start the email change again",
        );

        const user = await SuperTokens.getUser(userId);
        expect(
          user?.loginMethods.find(
            (method) => method.recipeId === "passwordless" && method.email,
          )?.email,
        ).toBe("revoked-session-current@example.com");
        const metadata = await UserMetadata.getUserMetadata(userId);
        expect((metadata.metadata as any).rownd_pending_verification).toEqual(
          [],
        );
      });

      it("does not replace an unrelated callback session", async () => {
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
        });
        server = s;
        testPORT = port;
        const initiatingUser = await createPasswordlessSessionForUser(
          "unrelated-session-current@example.com",
        );
        const unrelatedUser = await createPasswordlessSessionForUser(
          "unrelated-session-other@example.com",
        );

        const updateRes = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user`,
          {
            method: "PUT",
            headers: {
              ...getAuthedHeaders(initiatingUser.accessToken),
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              data: { email: "unrelated-session-target@example.com" },
            }),
          },
        );
        expect(updateRes.status).toBe(200);

        const tokenResponse =
          await EmailVerification.createEmailVerificationToken(
            "public",
            initiatingUser.recipeUserId,
            "unrelated-session-target@example.com",
          );
        expect(tokenResponse.status).toBe("OK");

        const verifyRes = await verifyEmailToken(
          tokenResponse.status === "OK" ? tokenResponse.token : "unused",
          unrelatedUser.accessToken,
        );
        expect(verifyRes.status).toBe(200);
        await expect(verifyRes.json()).resolves.toEqual({
          status: "GENERAL_ERROR",
          message:
            "email change session is no longer active; start the email change again",
        });
        expect(verifyRes.headers.get("st-access-token")).toBeNull();
        await expect(
          Session.getSessionInformation(unrelatedUser.sessionHandle),
        ).resolves.toBeDefined();
      });

      it("cleans up verification when email ownership changes before completion", async () => {
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
        });
        server = s;
        testPORT = port;
        const changingUser = await createPasswordlessSessionForUser(
          "ownership-race-current@example.com",
        );
        const targetEmail = "ownership-race-target@example.com";

        const updateRes = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user`,
          {
            method: "PUT",
            headers: {
              ...getAuthedHeaders(changingUser.accessToken),
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ data: { email: targetEmail } }),
          },
        );
        expect(updateRes.status).toBe(200);
        await Passwordless.signInUp({ tenantId: "public", email: targetEmail });

        const tokenResponse =
          await EmailVerification.createEmailVerificationToken(
            "public",
            changingUser.recipeUserId,
            targetEmail,
          );
        expect(tokenResponse.status).toBe("OK");

        const verifyRes = await verifyEmailToken(
          tokenResponse.status === "OK" ? tokenResponse.token : "unused",
          changingUser.accessToken,
        );
        expect(verifyRes.status).toBe(200);
        await expect(verifyRes.json()).resolves.toEqual({
          status: "GENERAL_ERROR",
          message: "email cannot be used for this account",
        });
        await expect(
          EmailVerification.isEmailVerified(
            changingUser.recipeUserId,
            targetEmail,
          ),
        ).resolves.toBe(false);
        const metadata = await UserMetadata.getUserMetadata(
          changingUser.userId,
        );
        expect((metadata.metadata as any).rownd_pending_verification).toEqual(
          [],
        );
      });

      it("clears pending email verification when updating back to the current email", async () => {
        const emailVerificationLinks: string[] = [];
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
          emailVerificationLinks,
        });
        server = s;
        testPORT = port;
        const { accessToken, userId, recipeUserId } =
          await createPasswordlessSessionForUser(
            "email-reset-current@example.com",
          );

        const pendingRes = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user`,
          {
            method: "PUT",
            headers: {
              ...getAuthedHeaders(accessToken),
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              data: { email: "email-reset-pending@example.com" },
            }),
          },
        );
        expect(pendingRes.status).toBe(200);
        expect(emailVerificationLinks).toHaveLength(1);
        const staleToken = new URL(emailVerificationLinks[0]).searchParams.get(
          "token",
        );
        expect(staleToken).toBeTruthy();

        const resetRes = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user`,
          {
            method: "PUT",
            headers: {
              ...getAuthedHeaders(accessToken),
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              data: { email: "email-reset-current@example.com" },
            }),
          },
        );
        expect(resetRes.status).toBe(200);

        const staleVerifyRes = await verifyEmailToken(
          staleToken || "unused",
          accessToken,
        );
        const staleVerifyBody = await staleVerifyRes.json();
        expect(staleVerifyBody.status).not.toBe("OK");

        const metadata = await UserMetadata.getUserMetadata(userId);
        expect((metadata.metadata as any).rownd_pending_verification).toEqual(
          [],
        );

        const updatedUser = await SuperTokens.getUser(userId);
        const passwordlessMethod = updatedUser?.loginMethods.find(
          (method) =>
            method.recipeId === "passwordless" &&
            method.recipeUserId.getAsString() === recipeUserId.getAsString(),
        );
        expect(passwordlessMethod?.email).toBe(
          "email-reset-current@example.com",
        );
      });

      it.each(["guest", "instant"] as const)(
        "rejects profile email changes for %s accounts",
        async (authLevel) => {
          const { server: s, port } = await setup(coreConnectionURI, undefined, {
            enableEmailVerification: true,
          });
          server = s;
          testPORT = port;
          const guestSession = await createGuestSession(authLevel);

          const res = await fetch(
            `http://localhost:${testPORT}/auth/plugin/rownd/user`,
            {
              method: "PUT",
              headers: {
                ...getAuthedHeaders(guestSession.accessToken),
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                data: { email: `${authLevel}-profile-email@example.com` },
              }),
            },
          );

          expect(res.status).toBe(403);
          const metadata = await UserMetadata.getUserMetadata(
            guestSession.recipeUserId.getAsString(),
          );
          expect(
            (metadata.metadata as any).rownd_pending_verification,
          ).toBeUndefined();
        },
      );

      it("rejects a guest email change owned by another account", async () => {
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
        });
        server = s;
        testPORT = port;
        const existingPasswordless = await Passwordless.signInUp({
          email: "existing-primary@example.com",
          tenantId: "public",
        });
        const guestSession = await createGuestSession();

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user`,
          {
            method: "PUT",
            headers: {
              ...getAuthedHeaders(guestSession.accessToken),
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              data: { email: "existing-primary@example.com" },
            }),
          },
        );
        expect(res.status).toBe(403);
        await expect(res.json()).resolves.toEqual({
          status: "ERROR",
          code: 403,
          message: "guest accounts cannot change sign-in email",
        });

        const existingUser = await SuperTokens.getUser(
          existingPasswordless.user.id,
        );
        expect(existingUser?.loginMethods).toHaveLength(1);
        const guestUser = await SuperTokens.getUser(
          guestSession.recipeUserId.getAsString(),
        );
        expect(guestUser?.loginMethods).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              recipeId: "thirdparty",
              thirdParty: expect.objectContaining({ id: "guest" }),
            }),
          ]),
        );
        const guestMetadata = await UserMetadata.getUserMetadata(guestUser!.id);
        expect(
          (guestMetadata.metadata as any).rownd_pending_verification,
        ).toBeUndefined();
      });

      it("preserves account metadata when rejecting an email ownership conflict", async () => {
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
        });
        server = s;
        testPORT = port;
        const existingPasswordless = await Passwordless.signInUp({
          email: "existing-primary-metadata@example.com",
          tenantId: "public",
        });
        await UserMetadata.updateUserMetadata(existingPasswordless.user.id, {
          plan: "pro",
          original_rownd_user: {
            state: "enabled",
            auth_level: "verified",
            data: {
              user_id: existingPasswordless.user.id,
              email: "existing-primary-metadata@example.com",
              first_name: "Existing",
            },
            verified_data: {
              email: "existing-primary-metadata@example.com",
            },
            attributes: {
              source: "primary",
            },
          },
        });
        const guestSession = await createGuestSession();

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user`,
          {
            method: "PUT",
            headers: {
              ...getAuthedHeaders(guestSession.accessToken),
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              data: { email: "existing-primary-metadata@example.com" },
            }),
          },
        );
        expect(res.status).toBe(403);

        const metadata = await UserMetadata.getUserMetadata(
          existingPasswordless.user.id,
        );
        expect(metadata.metadata).toEqual(
          expect.objectContaining({
            plan: "pro",
            original_rownd_user: expect.objectContaining({
              data: expect.objectContaining({
                user_id: existingPasswordless.user.id,
                email: "existing-primary-metadata@example.com",
                first_name: "Existing",
              }),
              verified_data: expect.objectContaining({
                email: "existing-primary-metadata@example.com",
              }),
              attributes: expect.objectContaining({
                source: "primary",
              }),
            }),
          }),
        );
        expect(
          (metadata.metadata as any).rownd_pending_verification,
        ).toBeUndefined();
      });

      it("adds a passwordless email method without changing third-party identity", async () => {
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
        });
        server = s;
        testPORT = port;
        const thirdPartyUser = await createThirdPartySessionForUser(
          "thirdparty-email-user@example.com",
        );
        const secondTenantId = `email-change-${randomUUID()}`;
        await MultiTenancy.createOrUpdateTenant(secondTenantId);
        const associationResult = await MultiTenancy.associateUserToTenant(
          secondTenantId,
          thirdPartyUser.recipeUserId,
        );
        expect(associationResult.status).toBe("OK");
        const originalUser = await SuperTokens.getUser(thirdPartyUser.userId);
        const originalThirdPartyMethod = originalUser?.loginMethods.find(
          (method) => method.recipeId === "thirdparty",
        );

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user`,
          {
            method: "PUT",
            headers: {
              ...getAuthedHeaders(thirdPartyUser.accessToken),
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              data: {
                email: "thirdparty-updated@example.com",
              },
            }),
          },
        );

        expect(res.status).toBe(200);

        const tokenResponse =
          await EmailVerification.createEmailVerificationToken(
            "public",
            thirdPartyUser.recipeUserId,
            "thirdparty-updated@example.com",
          );
        expect(tokenResponse.status).toBe("OK");

        const verifyRes = await verifyEmailToken(
          tokenResponse.status === "OK" ? tokenResponse.token : "unused",
          thirdPartyUser.accessToken,
        );
        expect(verifyRes.status).toBe(200);
        await expect(verifyRes.json()).resolves.toEqual({ status: "OK" });
        const replacementAccessToken = verifyRes.headers.get("st-access-token");
        expect(replacementAccessToken).toBeTruthy();

        const updatedUser = await SuperTokens.getUser(thirdPartyUser.userId);
        const updatedThirdPartyMethod = updatedUser?.loginMethods.find(
          (method) => method.recipeId === "thirdparty",
        );
        const passwordlessMethod = updatedUser?.loginMethods.find(
          (method) => method.recipeId === "passwordless" && method.email,
        );
        expect(updatedUser?.id).toBe(thirdPartyUser.userId);
        expect(updatedUser?.isPrimaryUser).toBe(true);
        expect(updatedUser?.loginMethods).toHaveLength(2);
        expect(updatedThirdPartyMethod?.recipeUserId.getAsString()).toBe(
          originalThirdPartyMethod?.recipeUserId.getAsString(),
        );
        expect(updatedThirdPartyMethod?.thirdParty).toEqual(
          originalThirdPartyMethod?.thirdParty,
        );
        expect(updatedThirdPartyMethod?.email).toBe(
          "thirdparty-email-user@example.com",
        );
        expect(passwordlessMethod?.email).toBe(
          "thirdparty-updated@example.com",
        );
        expect(passwordlessMethod?.verified).toBe(true);
        expect(passwordlessMethod?.tenantIds).toEqual(
          expect.arrayContaining(["public", secondTenantId]),
        );

        const metadata = await UserMetadata.getUserMetadata(
          thirdPartyUser.userId,
        );
        expect((metadata.metadata as any).original_rownd_user.data.email).toBe(
          "thirdparty-updated@example.com",
        );
        expect(
          (metadata.metadata as any).original_rownd_user.verified_data.email,
        ).toBe("thirdparty-updated@example.com");
        expect((metadata.metadata as any).rownd_pending_verification).toEqual(
          [],
        );

        const profileRes = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user`,
          { headers: getAuthedHeaders(replacementAccessToken!) },
        );
        const profile = await profileRes.json();
        expect(profile.data.email).toBe("thirdparty-updated@example.com");
        expect(profile.verified_data.email).toBe(
          "thirdparty-updated@example.com",
        );
      });

      it("removes a new passwordless method when metadata finalization fails", async () => {
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
        });
        server = s;
        testPORT = port;
        const thirdPartyUser = await createThirdPartySessionForUser(
          "metadata-failure-provider@example.com",
        );
        const targetEmail = "metadata-failure-target@example.com";

        const updateRes = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user`,
          {
            method: "PUT",
            headers: {
              ...getAuthedHeaders(thirdPartyUser.accessToken),
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ data: { email: targetEmail } }),
          },
        );
        expect(updateRes.status).toBe(200);

        const originalUpdateUserMetadata = UserMetadata.updateUserMetadata;
        const metadataUpdate = vi
          .spyOn(UserMetadata, "updateUserMetadata")
          .mockImplementation((userId, update, userContext) => {
            if (
              (update as any).original_rownd_user?.data?.email === targetEmail
            ) {
              return Promise.reject(new Error("metadata finalization failed"));
            }
            return originalUpdateUserMetadata(userId, update, userContext);
          });

        await expect(
          completePendingEmailVerification({
            recipeUserId: thirdPartyUser.recipeUserId,
            email: targetEmail,
            sessionHandle: thirdPartyUser.sessionHandle,
          }),
        ).rejects.toThrow("metadata finalization failed");
        metadataUpdate.mockRestore();

        const user = await SuperTokens.getUser(thirdPartyUser.userId);
        expect(user?.loginMethods).toEqual([
          expect.objectContaining({
            recipeId: "thirdparty",
            email: "metadata-failure-provider@example.com",
          }),
        ]);
        const metadata = await UserMetadata.getUserMetadata(
          thirdPartyUser.userId,
        );
        expect((metadata.metadata as any).original_rownd_user.data.email).toBe(
          "metadata-failure-provider@example.com",
        );
        expect((metadata.metadata as any).rownd_pending_verification).toEqual(
          [],
        );
      });

      it("removes duplicate matching pending email verifications on completion", async () => {
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
        });
        server = s;
        testPORT = port;
        const { accessToken, sessionHandle, userId, recipeUserId } =
          await createPasswordlessSessionForUser(
            "duplicate-pending-current@example.com",
          );

        const updateRes = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user`,
          {
            method: "PUT",
            headers: {
              ...getAuthedHeaders(accessToken),
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              data: { email: "duplicate-pending-target@example.com" },
            }),
          },
        );
        expect(updateRes.status).toBe(200);

        const pendingMetadata = await UserMetadata.getUserMetadata(userId);
        const pendingVerification = (pendingMetadata.metadata as any)
          .rownd_pending_verification[0];

        await UserMetadata.updateUserMetadata(userId, {
          rownd_pending_verification: [
            pendingVerification,
            { ...pendingVerification, id: "duplicate-email-2" },
            {
              id: "future-phone-verification",
              field: "phone_number",
              value: "+15555550123",
              created_at: "2026-01-01T00:00:00.000Z",
            },
          ],
        });

        await completePendingEmailVerification({
          recipeUserId,
          email: "duplicate-pending-target@example.com",
          sessionHandle,
        });

        const metadata = await UserMetadata.getUserMetadata(userId);
        expect((metadata.metadata as any).rownd_pending_verification).toEqual([
          expect.objectContaining({
            id: "future-phone-verification",
            field: "phone_number",
            value: "+15555550123",
          }),
        ]);
      });

      it("keeps anonymous_id while marking linked passwordless users verified", async () => {
        const { server: s, port } = await setup(coreConnectionURI);
        server = s;
        testPORT = port;
        const guestSession = await createGuestSession();
        const passwordlessResult = await Passwordless.signInUp({
          email: "linked@example.com",
          tenantId: "public",
        });

        const primaryResult = await AccountLinking.createPrimaryUser(
          passwordlessResult.recipeUserId,
        );
        expect(primaryResult.status).toBe("OK");
        const linkResult = await AccountLinking.linkAccounts(
          guestSession.recipeUserId,
          passwordlessResult.user.id,
          undefined,
        );
        expect(linkResult.status).toBe("OK");

        const claims = await buildRowndSessionClaims(
          passwordlessResult.user.id,
        );
        expect(claims).toMatchObject({
          app_user_id: passwordlessResult.user.id,
          auth_level: "verified",
          is_verified_user: true,
          anonymous_id: expect.stringMatching(/^anon_/),
          [ROWND_JWT_CLAIMS.AppUserId]: passwordlessResult.user.id,
          [ROWND_JWT_CLAIMS.AuthLevel]: "verified",
          [ROWND_JWT_CLAIMS.IsVerifiedUser]: true,
        });
        expect(claims).not.toHaveProperty(ROWND_JWT_CLAIMS.IsAnonymous);
      });

      it("stores pending verification for a new email even if the current email is verified", async () => {
        const emailVerificationLinks: string[] = [];
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
          emailVerificationLinks,
        });
        server = s;
        testPORT = port;

        const { accessToken, userId, recipeUserId } =
          await createPasswordlessSessionForUser(
            "email-verified-current@example.com",
          );

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user`,
          {
            method: "PUT",
            headers: {
              ...getAuthedHeaders(accessToken),
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              data: {
                email: "email-new-target@example.com",
              },
              context: {
                rowndDisplayContext: "mobile_app",
              },
            }),
          },
        );

        expect(res.status).toBe(200);
        expect(emailVerificationLinks).toHaveLength(1);
        const verificationUrl = new URL(emailVerificationLinks[0]);
        expect(verificationUrl.pathname).toBe("/account/verify-email");
        expect(verificationUrl.searchParams.get("token")).toBeTruthy();
        expect(verificationUrl.searchParams.get("tenantId")).toBe("public");
        expect(verificationUrl.searchParams.get("displayContext")).toBe(
          "mobile_app",
        );

        const body = await res.json();
        expect(body.data.email).toBe("email-verified-current@example.com");
        expect(body.verified_data.email).toBe(
          "email-verified-current@example.com",
        );

        const metadata = await UserMetadata.getUserMetadata(userId);
        expect((metadata.metadata as any).rownd_pending_verification).toEqual([
          expect.objectContaining({
            field: "email",
            value: "email-new-target@example.com",
          }),
        ]);

        const updatedUser = await SuperTokens.getUser(userId);
        const passwordlessMethod = updatedUser?.loginMethods.find(
          (method) =>
            method.recipeId === "passwordless" &&
            method.recipeUserId.getAsString() === recipeUserId.getAsString(),
        );
        expect(passwordlessMethod?.email).toBe(
          "email-verified-current@example.com",
        );
      });

      it("replaces only the pending email verification entry", async () => {
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
        });
        server = s;
        testPORT = port;
        const { accessToken, userId, recipeUserId } =
          await createPasswordlessSessionForUser(
            "email-replace-pending@example.com",
          );

        const oldUpdateRes = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user`,
          {
            method: "PUT",
            headers: {
              ...getAuthedHeaders(accessToken),
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              data: {
                email: "old-pending-email@example.com",
              },
            }),
          },
        );
        expect(oldUpdateRes.status).toBe(200);

        const oldTokenResponse =
          await EmailVerification.createEmailVerificationToken(
            "public",
            recipeUserId,
            "old-pending-email@example.com",
          );
        expect(oldTokenResponse.status).toBe("OK");

        const initialMetadata = await UserMetadata.getUserMetadata(userId);
        const [oldEmailVerification] = (initialMetadata.metadata as any)
          .rownd_pending_verification;

        await UserMetadata.updateUserMetadata(userId, {
          rownd_pending_verification: [
            oldEmailVerification,
            {
              id: "future-phone-verification",
              field: "phone_number",
              value: "+15555550123",
              created_at: "2026-01-01T00:00:00.000Z",
            },
          ],
        });

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user`,
          {
            method: "PUT",
            headers: {
              ...getAuthedHeaders(accessToken),
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              data: {
                email: "new-pending-email@example.com",
              },
            }),
          },
        );

        expect(res.status).toBe(200);

        const oldVerifyRes = await verifyEmailToken(
          oldTokenResponse.status === "OK" ? oldTokenResponse.token : "unused",
        );
        const oldVerifyBody = await oldVerifyRes.json();
        expect(oldVerifyBody.status).not.toBe("OK");

        const metadata = await UserMetadata.getUserMetadata(userId);
        expect((metadata.metadata as any).rownd_pending_verification).toEqual([
          expect.objectContaining({
            id: "future-phone-verification",
            field: "phone_number",
            value: "+15555550123",
          }),
          expect.objectContaining({
            field: "email",
            value: "new-pending-email@example.com",
          }),
        ]);
      });

      it("preserves metadata structure after update", async () => {
        const { server: s, port } = await setup(importCoreConnectionURI);
        server = s;
        testPORT = port;
        const accessToken = await createSessionForUser(
          "metadata-structure-user",
        );

        await fetch(`http://localhost:${testPORT}/auth/plugin/rownd/user`, {
          method: "PUT",
          headers: {
            ...getAuthedHeaders(accessToken),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ data: { first_name: "John" } }),
        });

        await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user/meta`,
          {
            method: "PUT",
            headers: {
              ...getAuthedHeaders(accessToken),
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ meta: { custom_field: "custom_value" } }),
          },
        );

        const metadata = await UserMetadata.getUserMetadata(
          "metadata-structure-user",
        );
        expect(metadata.metadata).toEqual(
          expect.objectContaining({
            first_name: "John",
            custom_field: "custom_value",
            original_rownd_user: expect.objectContaining({
              data: expect.objectContaining({
                user_id: "metadata-structure-user",
              }),
            }),
          }),
        );
        expect((metadata.metadata as any).data).toBeUndefined();
        expect((metadata.metadata as any).meta).toBeUndefined();
        expect((metadata.metadata as any).verified_data).toBeUndefined();
        expect((metadata.metadata as any).attributes).toBeUndefined();
      });
    });

    describe("DELETE /user", () => {
      it("deletes the compatibility user", async () => {
        const { server: s, port } = await setup(importCoreConnectionURI);
        server = s;
        testPORT = port;
        const accessToken = await createSessionForUser("compat-user-5");

        const deleteRes = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user`,
          {
            method: "DELETE",
            headers: getAuthedHeaders(accessToken),
          },
        );

        expect(deleteRes.status).toBe(200);
        const deletedUser = await SuperTokens.getUser("compat-user-5");
        expect(deletedUser).toBeUndefined();
      });
    });

    describe("POST /signout", () => {
      it("revokes all sessions for the current user", async () => {
        const { server: s, port } = await setup(importCoreConnectionURI);
        server = s;
        testPORT = port;
        const firstAccessToken = await createSessionForUser("signout-user");
        const secondAccessToken = await createSessionForUser("signout-user");
        const firstSession =
          await Session.getSessionWithoutRequestResponse(firstAccessToken);
        const secondSession =
          await Session.getSessionWithoutRequestResponse(secondAccessToken);
        const firstSessionHandle = firstSession.getHandle();
        const secondSessionHandle = secondSession.getHandle();

        await expect(
          Session.getAllSessionHandlesForUser("signout-user", true, "public"),
        ).resolves.toEqual(
          expect.arrayContaining([firstSessionHandle, secondSessionHandle]),
        );

        const signOutRes = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/signout`,
          {
            method: "POST",
            headers: getAuthedHeaders(firstAccessToken),
          },
        );

        expect(signOutRes.status).toBe(200);
        await expect(signOutRes.json()).resolves.toEqual({ status: "OK" });
        await expect(
          Session.getSessionInformation(firstSessionHandle),
        ).resolves.toBeUndefined();
        await expect(
          Session.getSessionInformation(secondSessionHandle),
        ).resolves.toBeUndefined();
        await expect(
          Session.getAllSessionHandlesForUser("signout-user", true, "public"),
        ).resolves.toEqual([]);
      });

      it("rejects without session", async () => {
        const { server: s, port } = await setup(coreConnectionURI);
        server = s;
        testPORT = port;

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/signout`,
          {
            method: "POST",
          },
        );
        const body = await res.json();
        expect(body.status).not.toBe("OK");
      });
    });

    describe("GET /user/meta", () => {
      it("gets compatibility user meta", async () => {
        const { server: s, port } = await setup(importCoreConnectionURI);
        server = s;
        testPORT = port;
        const accessToken = await createSessionForUser("compat-user-3");

        const initialRes = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user/meta`,
          {
            headers: getAuthedHeaders(accessToken),
          },
        );
        await expect(initialRes.json()).resolves.toEqual({
          status: "OK",
          id: "compat-user-3",
          meta: { created: "2026-01-01T00:00:00.000Z" },
        });
      });
    });

    describe("PUT /user/meta", () => {
      it("updates compatibility user meta", async () => {
        const { server: s, port } = await setup(importCoreConnectionURI);
        server = s;
        testPORT = port;
        const accessToken = await createSessionForUser("compat-user-3-put");

        const updateRes = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user/meta`,
          {
            method: "PUT",
            headers: {
              ...getAuthedHeaders(accessToken),
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              meta: {
                last_passkey_registration_prompt: "2026-04-23T00:00:00.000Z",
              },
            }),
          },
        );

        expect(updateRes.status).toBe(200);
        await expect(updateRes.json()).resolves.toEqual({
          status: "OK",
          id: "compat-user-3-put",
          meta: {
            created: "2026-01-01T00:00:00.000Z",
            last_passkey_registration_prompt: "2026-04-23T00:00:00.000Z",
          },
        });
      });

      it("rejects updates to internal metadata fields", async () => {
        const { server: s, port } = await setup(importCoreConnectionURI);
        server = s;
        testPORT = port;
        const accessToken = await createSessionForUser("compat-user-meta-safe");

        const updateRes = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user/meta`,
          {
            method: "PUT",
            headers: {
              ...getAuthedHeaders(accessToken),
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              meta: {
                original_rownd_user: { data: { user_id: "attacker" } },
              },
            }),
          },
        );

        expect(updateRes.status).toBe(403);
        await expect(updateRes.json()).resolves.toEqual({
          status: "ERROR",
          code: 403,
          message: "field is not writable: original_rownd_user",
        });

        const metadata = await UserMetadata.getUserMetadata(
          "compat-user-meta-safe",
        );
        expect(
          (metadata.metadata as any).original_rownd_user.data.user_id,
        ).toBe("compat-user-meta-safe");
      });

      it("rejects without session", async () => {
        const { server: s, port } = await setup(coreConnectionURI);
        server = s;
        testPORT = port;

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user/meta`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ meta: {} }),
          },
        );
        const body = await res.json();
        expect(body.status).not.toBe("OK");
      });
    });

    describe("GET /user/field", () => {
      it("gets compatibility user fields", async () => {
        const { server: s, port } = await setup(importCoreConnectionURI);
        server = s;
        testPORT = port;
        const accessToken = await createSessionForUser("compat-user-4-get");

        await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user/field?field=last_name`,
          {
            method: "PUT",
            headers: {
              ...getAuthedHeaders(accessToken),
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ value: "Lovelace" }),
          },
        );

        const getRes = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user/field?field=last_name`,
          {
            headers: getAuthedHeaders(accessToken),
          },
        );
        expect(getRes.status).toBe(200);
        await expect(getRes.json()).resolves.toEqual({
          status: "OK",
          value: "Lovelace",
        });
      });

      it("returns auth-derived identity fields instead of metadata values", async () => {
        const { server: s, port } = await setup(coreConnectionURI, {
          schema: {
            ...DEFAULT_ROWND_SCHEMA,
            email: {
              display_name: "Email",
              type: "string",
              user_visible: true,
            },
          },
        });
        server = s;
        testPORT = port;
        const { accessToken, userId } = await createPasswordlessSessionForUser(
          "auth-email@example.com",
        );

        await UserMetadata.updateUserMetadata(userId, {
          email: "metadata-email@example.com",
          original_rownd_user: {
            state: "enabled",
            auth_level: "verified",
            data: {
              user_id: userId,
              email: "original-rownd-email@example.com",
            },
            verified_data: {},
            attributes: {},
            meta: {},
          },
        });

        const getRes = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user/field?field=email`,
          {
            headers: getAuthedHeaders(accessToken),
          },
        );
        expect(getRes.status).toBe(200);
        await expect(getRes.json()).resolves.toEqual({
          status: "OK",
          value: "auth-email@example.com",
        });
      });

      it("returns 400 when field is missing", async () => {
        const { server: s, port } = await setup(importCoreConnectionURI);
        server = s;
        testPORT = port;
        const accessToken = await createSessionForUser(
          "compat-user-4-missing-field",
        );

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user/field`,
          {
            headers: getAuthedHeaders(accessToken),
          },
        );
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.status).toBe("ERROR");
        expect(body.code).toBe(400);
        expect(body.message).toBe("field is required");
      });
    });

    describe("PUT /user/field", () => {
      it("updates compatibility user fields", async () => {
        const { server: s, port } = await setup(importCoreConnectionURI);
        server = s;
        testPORT = port;
        const accessToken = await createSessionForUser("compat-user-4");

        const updateRes = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user/field?field=last_name`,
          {
            method: "PUT",
            headers: {
              ...getAuthedHeaders(accessToken),
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ value: "Lovelace" }),
          },
        );
        expect(updateRes.status).toBe(200);
        const body = await updateRes.json();
        expect(body.status).toBe("OK");
        expect(body.rownd_user).toBe("compat-user-4");
        expect(body.data.last_name).toBe("Lovelace");
        expect(body.state).toBe("enabled");
        expect(body.auth_level).toBe("verified");
      });

      it("rejects updates to unknown or app-owned fields", async () => {
        const { server: s, port } = await setup(importCoreConnectionURI);
        server = s;
        testPORT = port;
        const accessToken = await createSessionForUser(
          "app-owned-field-user-2",
        );

        const updateRes = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user/field?field=google_id`,
          {
            method: "PUT",
            headers: {
              ...getAuthedHeaders(accessToken),
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ value: "google-123" }),
          },
        );

        expect(updateRes.status).toBe(403);
        const body = await updateRes.json();
        expect(body.status).toBe("ERROR");
        expect(body.message).toBe("field is not writable: google_id");
      });

      it("defers email field updates until verification completes", async () => {
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
        });
        server = s;
        testPORT = port;
        const { accessToken, userId } = await createPasswordlessSessionForUser(
          "email-field-user@example.com",
        );

        const updateRes = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user/field?field=email`,
          {
            method: "PUT",
            headers: {
              ...getAuthedHeaders(accessToken),
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ value: "new-email-field@example.com" }),
          },
        );
        expect(updateRes.status).toBe(200);
        const body = await updateRes.json();
        expect(body.status).toBe("OK");
        expect(body.data.email).toBe("email-field-user@example.com");
        expect(body.verified_data.email).toBe("email-field-user@example.com");

        const metadata = await UserMetadata.getUserMetadata(userId);
        expect(metadata.metadata).toEqual(
          expect.objectContaining({
            rownd_pending_verification: [
              expect.objectContaining({
                field: "email",
                value: "new-email-field@example.com",
              }),
            ],
          }),
        );
      });

      it("returns 400 when field is missing", async () => {
        const { server: s, port } = await setup(importCoreConnectionURI);
        server = s;
        testPORT = port;
        const accessToken = await createSessionForUser(
          "compat-user-4-put-missing",
        );

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user/field`,
          {
            method: "PUT",
            headers: {
              ...getAuthedHeaders(accessToken),
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ value: "Lovelace" }),
          },
        );
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.status).toBe("ERROR");
        expect(body.code).toBe(400);
        expect(body.message).toBe("field is required");
      });
    });

    async function createSessionForUser(
      userId: string,
      email = `${userId}@example.com`,
      options?: {
        validatedToken?: Record<string, unknown>;
        rowndUserData?: Record<string, unknown>;
      },
    ) {
      mockRowndClient.validateToken.mockResolvedValue({
        user_id: userId,
        ...options?.validatedToken,
      });
      mockRowndClient.fetchUserInfo.mockResolvedValue({
        app_user_id: userId,
        data: { ...options?.rowndUserData, user_id: userId, email },
        verified_data: { email: true },
        meta: { created: "2026-01-01T00:00:00.000Z" },
      });

      const res = await fetch(
        `http://localhost:${testPORT}/auth/plugin/rownd/migrate`,
        {
          method: "POST",
          headers: {
            Authorization: "Bearer some-token",
            rid: "session",
            "fdi-version": "1.18",
          },
        },
      );

      const accessToken = res.headers.get("st-access-token");
      expect(accessToken).toBeTruthy();
      return accessToken!;
    }

    async function createPasswordlessSessionForUser(email: string) {
      const signInUpResponse = await Passwordless.signInUp({
        email,
        tenantId: "public",
      });
      const user = signInUpResponse.user;
      const recipeUserId = user.loginMethods[0]?.recipeUserId;
      expect(recipeUserId).toBeDefined();

      await UserMetadata.updateUserMetadata(user.id, {
        created: "2026-01-01T00:00:00.000Z",
        original_rownd_user: {
          state: "enabled",
          auth_level: "verified",
          data: {
            user_id: user.id,
            email,
          },
          verified_data: {
            email,
          },
          attributes: {},
          meta: {
            created: "2026-01-01T00:00:00.000Z",
          },
        },
      });

      const session = await Session.createNewSessionWithoutRequestResponse(
        "public",
        recipeUserId!,
        {},
        {},
        true,
      );
      const sessionTokens = session.getAllSessionTokensDangerously();
      expect(sessionTokens.refreshToken).toBeTruthy();

      return {
        accessToken: session.getAccessToken(),
        refreshToken: sessionTokens.refreshToken!,
        sessionHandle: session.getHandle(),
        userId: user.id,
        recipeUserId: recipeUserId!,
      };
    }

    async function createGuestSession(
      authLevel: "guest" | "instant" = "guest",
    ) {
      const res = await fetch(
        `http://localhost:${testPORT}/auth/plugin/rownd/guest`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            rid: "session",
            "fdi-version": "1.18",
          },
          body: JSON.stringify({ auth_level: authLevel }),
        },
      );

      expect(res.status).toBe(200);
      const accessToken = res.headers.get("st-access-token");
      expect(accessToken).toBeTruthy();

      const session = await Session.getSessionWithoutRequestResponse(
        accessToken!,
        undefined,
        { overrideGlobalClaimValidators: () => [] },
      );
      expect(session).toBeDefined();

      const accessTokenPayload = session!.getAccessTokenPayload();
      return {
        accessToken: accessToken!,
        userId: accessTokenPayload["app_user_id"] as string,
        recipeUserId: session!.getRecipeUserId(),
      };
    }

    async function verifyEmailToken(token: string, accessToken?: string) {
      return fetch(`http://localhost:${testPORT}/auth/user/email/verify`, {
        method: "POST",
        headers: {
          ...(accessToken ? getAuthedHeaders(accessToken) : {}),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          method: "token",
          token,
        }),
      });
    }

    async function createThirdPartySessionForUser(email: string) {
      const signInUpResponse = await ThirdParty.manuallyCreateOrUpdateUser(
        "public",
        "google",
        `google-${randomUUID()}`,
        email,
        true,
      );
      expect(signInUpResponse.status).toBe("OK");
      if (signInUpResponse.status !== "OK") {
        throw new Error("failed to create thirdparty user");
      }

      const user = signInUpResponse.user;
      await UserMetadata.updateUserMetadata(user.id, {
        created: "2026-01-01T00:00:00.000Z",
        original_rownd_user: {
          state: "enabled",
          auth_level: "verified",
          data: {
            user_id: user.id,
            email,
          },
          verified_data: {
            email,
          },
          attributes: {},
          meta: {
            created: "2026-01-01T00:00:00.000Z",
          },
        },
      });

      const session = await Session.createNewSessionWithoutRequestResponse(
        "public",
        signInUpResponse.recipeUserId,
        {},
        {},
        true,
      );

      return {
        accessToken: session.getAccessToken(),
        sessionHandle: session.getHandle(),
        userId: user.id,
        recipeUserId: signInUpResponse.recipeUserId,
      };
    }

    function getAuthedHeaders(accessToken: string) {
      return {
        Authorization: `Bearer ${accessToken}`,
        rid: "session",
        "fdi-version": "1.18",
        "st-auth-mode": "header",
      };
    }

    async function requestEmailChange(accessToken: string, email: string) {
      return fetch(`http://localhost:${testPORT}/auth/plugin/rownd/user`, {
        method: "PUT",
        headers: {
          ...getAuthedHeaders(accessToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ data: { email } }),
      });
    }

    async function signInUpWithTestProvider(input: {
      providerId: string;
      providerUserId: string;
      email: string;
    }) {
      const res = await fetch(`http://localhost:${testPORT}/auth/signinup`, {
        method: "POST",
        headers: {
          rid: "thirdparty",
          "content-type": "application/json",
          "fdi-version": "3.1",
          "st-auth-mode": "header",
        },
        body: JSON.stringify({
          thirdPartyId: input.providerId,
          oAuthTokens: {
            thirdPartyUserId: input.providerUserId,
            email: input.email,
            emailVerified: true,
          },
        }),
      });
      const body = await res.json();

      return {
        ...body,
        accessToken: res.headers.get("st-access-token"),
      };
    }
  });
});

function resetST() {
  ProcessState.getInstance().reset();
  SessionRaw.reset();
  UserMetadataRaw.reset();
  UserRolesRaw.reset();
  AccountLinkingRaw.reset();
  EmailPasswordRaw.reset();
  PasswordlessRaw.reset();
  ThirdPartyRaw.reset();
  EmailVerificationRaw.reset();
  MultitenancyRaw.reset();
  SuperTokensRaw.reset();
  Querier.reset();
}

function makeVariantRequest(appVariantId: string) {
  return makeRequest({ app_variant_id: appVariantId });
}

function makeRequest(query: Record<string, string>) {
  return {
    getKeyValueFromQuery: (key: string) => query[key],
  };
}

function makePublicConfig(
  apiDomain: string,
  apiBasePath: string,
  websiteDomain = "https://hub.example.com",
) {
  return {
    appInfo: {
      apiDomain: {
        getAsStringDangerous: () => apiDomain,
      },
      apiBasePath: {
        getAsStringDangerous: () => apiBasePath,
      },
      websiteBasePath: {
        getAsStringDangerous: () => "/auth",
      },
      getOrigin: () => ({
        getAsStringDangerous: () => websiteDomain,
      }),
      appName: "Test App",
    },
  };
}

async function getMigratedUserByRowndUserId(rowndUserId: string) {
  const user = await SuperTokens.getUser(rowndUserId);
  if (!user) {
    return undefined;
  }

  const metadata = await getUserMetadata(rowndUserId);

  return {
    user,
    metadata,
  };
}

async function setup(
  coreConnectionURI: string,
  config?: Partial<RowndPluginConfig>,
  options?: {
    enableEmailVerification?: boolean;
    enableEmailSignIn?: boolean;
    emailVerificationMode?: "OPTIONAL" | "REQUIRED";
    emailVerificationLinks?: string[];
  },
): Promise<{ server: Server; port: number }> {
  const app = express();

  return new Promise((resolve) => {
    const s = app.listen(0, () => {
      const address = s.address() as any;
      const port = address.port;

      SuperTokens.init({
        supertokens: {
          connectionURI: coreConnectionURI,
        },
        appInfo: {
          appName: "Test App",
          apiDomain: `http://localhost:${port}`,
          websiteDomain: `http://localhost:${port + 1}`,
        },
        recipeList: [
          AccountLinking.init({
            shouldDoAutomaticAccountLinking: async () => ({
              shouldAutomaticallyLink: false,
            }),
          }),
          Session.init(),
          UserMetadata.init(),
          Passwordless.init({
            contactMethod: "EMAIL",
            flowType: "MAGIC_LINK",
          }),
          ...(options?.enableEmailVerification
            ? [
                EmailVerification.init({
                  mode: options.emailVerificationMode ?? "OPTIONAL",
                  emailDelivery: {
                    override: (originalImplementation) => ({
                      ...originalImplementation,
                      sendEmail: async (input) => {
                        options?.emailVerificationLinks?.push(
                          input.emailVerifyLink,
                        );
                      },
                    }),
                  },
                }),
              ]
            : []),
          ThirdParty.init({
            signInAndUpFeature: {
              providers: [
                {
                  config: {
                    thirdPartyId: "google",
                    clients: [{ clientId: "test", clientSecret: "test" }],
                  },
                  override: overrideTestProviderUserInfo,
                },
                {
                  config: {
                    thirdPartyId: "apple",
                    clients: [{ clientId: "test", clientSecret: "test" }],
                  },
                  override: overrideTestProviderUserInfo,
                },
              ],
            },
          }),
        ],
        experimental: {
          plugins: [
            init({
              rowndAppKey: "test-key",
              rowndAppSecret: "test-secret",
              enableDebugLogs: true,
              ...(options?.enableEmailVerification &&
              options.enableEmailSignIn !== false
                ? { appConfig: { signInMethods: [{ method: "email" }] } }
                : {}),
              ...config,
            } as RowndPluginConfig),
          ],
        },
      });

      app.use(middleware());
      app.use(errorHandler());

      resolve({ server: s, port });
    });
  });
}

function overrideTestProviderUserInfo(originalImplementation: any) {
  return {
    ...originalImplementation,
    getUserInfo: async ({ oAuthTokens }: { oAuthTokens: any }) => ({
      thirdPartyUserId: oAuthTokens.thirdPartyUserId,
      email: {
        id: oAuthTokens.email,
        isVerified: oAuthTokens.emailVerified,
      },
      rawUserInfoFromProvider: {
        fromUserInfoAPI: oAuthTokens,
      },
    }),
  };
}

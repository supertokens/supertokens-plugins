import express from "express";
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
import { ROWND_PLUGIN_ERROR_MESSAGES, DEFAULT_ROWND_SCHEMA } from "./errors";
import {
  mapRowndUserToSuperTokens,
  DEFAULT_PRIMARY_COLOR,
  RowndIsAnonymousClaim,
} from "./pluginImplementation";

let testPORT = 30001;

const mockRowndClient = {
  validateToken: vi.fn(),
  fetchUserInfo: vi.fn(),
};

vi.mock("@rownd/node", () => ({
  createInstance: () => mockRowndClient,
}));

describe("rownd-nodejs plugin", () => {
  let server: Server | undefined;
  let container: StartedTestContainer;
  let postgresContainer: StartedTestContainer;
  let network: StartedNetwork;
  let coreConnectionURI: string;

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

    container = await new GenericContainer("supertokens/supertokens-postgresql")
      .withNetwork(network)
      .withEnvironment({
        POSTGRESQL_CONNECTION_URI:
          "postgresql://supertokens:somepassword@postgres:5432/supertokens",
      })
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
  });

  beforeEach(() => {
    resetST();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  describe("mapRowndUserToSuperTokens", () => {
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

    it("throws when a google user is missing email", () => {
      expect(() =>
        mapRowndUserToSuperTokens({
          data: {
            user_id: "rownd-google-missing-email",
            google_id: "google-user-id",
          },
          verified_data: { google_id: true },
        } as any),
      ).toThrowError(new Error("Rownd Google user is missing email"));
    });

    it("throws when an apple user is missing email", () => {
      expect(() =>
        mapRowndUserToSuperTokens({
          data: {
            user_id: "rownd-apple-missing-email",
            apple_id: "apple-user-id",
          },
          verified_data: { apple_id: true },
        } as any),
      ).toThrowError(new Error("Rownd Apple user is missing email"));
    });

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
      expect(user.userMetadata.auth_level).toBe("guest");
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
          data: {
            user_id: "rownd-missing-verified-data",
            email: "missing-verified-data@example.com",
          },
          meta: {},
          verified_data: {},
          attributes: {},
          rownd_migrated: true,
          rownd_user_id: "rownd-missing-verified-data",
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
          data: {
            user_id: "rownd-metadata-fallback",
            email: "metadata-fallback@example.com",
          },
          meta: {},
          verified_data: {},
          attributes: {},
          rownd_migrated: true,
          rownd_user_id: "rownd-metadata-fallback",
        },
      });
    });

    it("adds tenant ids to imported login methods when provided", () => {
      expect(
        mapRowndUserToSuperTokens(
          {
            data: {
              user_id: "rownd-tenant-aware",
              email: "tenant-aware@example.com",
            },
            verified_data: {},
          } as any,
          ["public", "variant_123"],
        ),
      ).toEqual({
        externalUserId: "rownd-tenant-aware",
        loginMethods: [
          {
            recipeId: "passwordless",
            email: "tenant-aware@example.com",
            isVerified: false,
            tenantIds: ["public", "variant_123"],
          },
        ],
        userMetadata: {
          data: {
            user_id: "rownd-tenant-aware",
            email: "tenant-aware@example.com",
          },
          meta: {},
          verified_data: {},
          attributes: {},
          rownd_migrated: true,
          rownd_user_id: "rownd-tenant-aware",
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

  describe("endpoints", () => {
    describe("POST /migrate", () => {
      it("migrate user successfully", async () => {
        const telemetryClient: RowndTelemetryClient = {
          recordEvent: vi.fn(),
        };
        const { server: s, port } = await setup(coreConnectionURI, {
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
            data: expect.objectContaining({
              email: rowndUser.data.email,
            }),
            rownd_migrated: true,
            rownd_user_id: rowndUser.app_user_id,
          }),
        );
        expect(telemetryClient.recordEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            outcome: "success",
            rowndUserId: rowndUser.app_user_id,
            superTokensUserId: expect.any(String),
          }),
        );
      });

      it("migrate user with custom metadata successfully", async () => {
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
        });
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
            data: expect.objectContaining({
              first_name: "John",
              last_name: "Doe",
            }),
            rownd_migrated: true,
          }),
        );
      });

      it("migrate a passwordles auth user", async () => {
        const { server: s, port } = await setup(coreConnectionURI);
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
        const { server: s, port } = await setup(coreConnectionURI);
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
        const { server: s, port } = await setup(coreConnectionURI);
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
        expect(user?.loginMethods.length).toBe(1);
        expect(user?.loginMethods[0].recipeId).toBe("thirdparty");
        expect(user?.loginMethods[0].thirdParty?.id).toBe("google");
      });

      it("error if the auth header is missing", async () => {
        const { server: s, port } = await setup(coreConnectionURI);
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
        const { server: s, port } = await setup(coreConnectionURI);
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
        const telemetryClient: RowndTelemetryClient = {
          recordEvent: vi.fn(),
        };
        const { server: s, port } = await setup(coreConnectionURI, {
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
        expect(telemetryClient.recordEvent).toHaveBeenCalledWith(
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
        const telemetryClient: RowndTelemetryClient = {
          recordEvent: vi.fn(async () => {
            throw new Error("Telemetry down");
          }),
        };
        const { server: s, port } = await setup(coreConnectionURI, {
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
        expect(telemetryClient.recordEvent).toHaveBeenCalled();
      });

      it("prevent creation of duplicate users", async () => {
        const { server: s, port } = await setup(coreConnectionURI);
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

      it("error if user not found in rownd", async () => {
        const { server: s, port } = await setup(coreConnectionURI);
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
        expect(body.status).toBe("ERROR");
        expect(body.message).toBe(
          ROWND_PLUGIN_ERROR_MESSAGES.ROWND_USER_NOT_FOUND,
        );
      });

      it("error if Bulk Import API fails (500)", async () => {
        const { server: s, port } = await setup(coreConnectionURI);
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
        const { server: s, port } = await setup(coreConnectionURI);
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
        const { server: s, port } = await setup(coreConnectionURI);
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
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body).toEqual({ status: "OK" });
        expect(res.headers.get("front-token")).toBeTruthy();
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
      });

      it("adds is_anonymous claim for anonymous Rownd sessions", async () => {
        const { server: s, port } = await setup(coreConnectionURI);
        server = s;
        testPORT = port;
        mockRowndClient.validateToken.mockResolvedValue({
          user_id: "rownd-session-anonymous",
        });
        mockRowndClient.fetchUserInfo.mockResolvedValue({
          app_user_id: "rownd-session-anonymous",
          auth_level: "anonymous",
          data: { user_id: "rownd-session-anonymous" },
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
      });

      it("create user and then migrate their session", async () => {
        const { server: s, port } = await setup(coreConnectionURI);
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
        const { server: s, port } = await setup(coreConnectionURI);
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
        const { server: s, port } = await setup(coreConnectionURI);
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
        const { server: s, port } = await setup(coreConnectionURI);
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
        expect(body.status).toBe("OK");
        expect(body.id).toBe("");
        expect(body.name).toBe("Test App");

        expect(body.config.hub.auth.sign_in_methods.email.enabled).toBe(false);
        expect(body.config.hub.auth.sign_in_methods.google.enabled).toBe(false);
        expect(body.config.customizations.primary_color).toBe(
          DEFAULT_PRIMARY_COLOR,
        );
        expect(body.config.hub.customizations.rounded_corners).toBe(true);
        expect(body.config.hub.customizations.dark_mode).toBe("auto");

        // Auth fields should NOT be in schema if methods are disabled
        expect(body.schema.email).toBeUndefined();
        expect(body.schema.google_id).toBeUndefined();
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
              { method: "apple", clientId: "com.example.app" },
            ],
          },
        });
        server = s;
        testPORT = port;

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/app-config`,
        );
        const body = await res.json();
        const methods = body.config.hub.auth.sign_in_methods;

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
      });

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

        expect(body.id).toBe("app_xyz");
        expect(body.name).toBe("Acme App");
        expect(body.icon).toBe("https://cdn.acme.com/icon.png");
        expect(body.config.customizations.primary_color).toBe("#ff0000");
        expect(body.config.hub.customizations.rounded_corners).toBe(false);
        expect(body.config.hub.customizations.dark_mode).toBe("dark");
        expect(body.config.hub.auth.show_app_icon).toBe(true);
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
        const legal = body.config.hub.legal;

        expect(legal.company_name).toBe("Acme Corp");
        expect(legal.privacy_policy_url).toBe("https://acme.com/privacy");
        expect(legal.terms_conditions_url).toBe("https://acme.com/terms");
        expect(legal.support_email).toBe("support@acme.com");
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

        expect(body.schema.employee_id).toBeDefined();
        expect(body.schema.employee_id.display_name).toBe("Employee ID");
        expect(body.schema.employee_id.read_only).toBe(true);
        expect(body.schema.employee_id.owned_by).toBe("app");
        // Fields not in userSchema and not injected via auth should not appear
        expect(body.schema.email).toBeUndefined();
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
        const field = body.schema.nickname;

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

        expect(body.schema.first_name).toBeDefined();
        expect(body.schema.last_name).toBeDefined();
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
        const methods = body.config.hub.auth.sign_in_methods;

        expect(methods.github).toBeDefined();
        expect(methods.github.enabled).toBe(true);
        expect(methods.github.display_name).toBe("GitHub");
        expect(methods.github.icon_light_url).toBe(
          "https://cdn.example.com/github.png",
        );
      });
    });

    describe("POST /guest", () => {
      it("should create a guest user and a session with correct claims (default auth_level)", async () => {
        const { server: s, port } = await setup(coreConnectionURI);
        server = s;
        testPORT = port;

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/guest`,
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
        await expect(
          session?.getClaimValue(RowndIsAnonymousClaim),
        ).resolves.toBe(true);
        expect(accessTokenPayload["app_user_id"]).toBe(stUser?.id);

        const guestLogin = stUser?.loginMethods.find(
          (m) => m.recipeId === "thirdparty" && m.thirdParty?.id === "guest",
        );
        expect(guestLogin).toBeDefined();
        expect(guestLogin?.thirdParty?.userId).toMatch(/^guest_[a-f0-9-]{36}$/);
      });

      it("should create a guest user and a session with anonymous auth_level", async () => {
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
            body: JSON.stringify({ auth_level: "anonymous" }),
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
        expect(accessTokenPayload["auth_level"]).toBe("anonymous");
      });
    });

    describe("GET /user", () => {
      it("gets compatibility user payload", async () => {
        const { server: s, port } = await setup(coreConnectionURI);
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

      it("returns empty strings for missing schema fields", async () => {
        const { server: s, port } = await setup(coreConnectionURI);
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
        const { server: s, port } = await setup(coreConnectionURI);
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
    });

    describe("PUT /user", () => {
      it("updates compatibility user data", async () => {
        const { server: s, port } = await setup(coreConnectionURI);
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
        const { server: s, port } = await setup(coreConnectionURI, {
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

      it("defers email updates until verification completes", async () => {
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
        });
        server = s;
        testPORT = port;
        const { accessToken, userId, recipeUserId } =
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
                email: "new-email-update@example.com",
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
        expect(metadata.metadata).toEqual(
          expect.objectContaining({
            rownd_pending_verification: expect.objectContaining({
              field: "email",
              value: "new-email-update@example.com",
            }),
          }),
        );
        expect((metadata.metadata as any).data.email).toBe(
          "email-update-user@example.com",
        );

        const tokenResponse =
          await EmailVerification.createEmailVerificationToken(
            "public",
            recipeUserId,
            "new-email-update@example.com",
          );
        expect(tokenResponse.status).toBe("OK");

        const verifyRes = await fetch(
          `http://localhost:${testPORT}/auth/user/email/verify`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              method: "token",
              token:
                tokenResponse.status === "OK" ? tokenResponse.token : "unused",
            }),
          },
        );
        expect(verifyRes.status).toBe(200);
        await expect(verifyRes.json()).resolves.toEqual({ status: "OK" });

        metadata = await UserMetadata.getUserMetadata(userId);
        expect((metadata.metadata as any).data.email).toBe(
          "new-email-update@example.com",
        );
        expect((metadata.metadata as any).verified_data.email).toBe(
          "new-email-update@example.com",
        );
        expect(
          (metadata.metadata as any).rownd_pending_verification,
        ).toBeUndefined();
      });

      it("sends verification for the new email even if the current email is verified", async () => {
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
        });
        server = s;
        testPORT = port;

        const { accessToken, userId, recipeUserId } =
          await createPasswordlessSessionForUser(
            "email-verified-current@example.com",
          );
        const sendEmailSpy = vi.spyOn(
          EmailVerification,
          "sendEmailVerificationEmail",
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
            }),
          },
        );

        expect(res.status).toBe(200);
        expect(sendEmailSpy).toHaveBeenCalledTimes(1);
        const [tenantIdArg, userIdArg, recipeUserIdArg, emailArg, userContext] =
          sendEmailSpy.mock.calls[0]!;
        expect(tenantIdArg).toBe("public");
        expect(userIdArg).toBe(userId);
        expect(recipeUserIdArg.getAsString()).toBe(recipeUserId.getAsString());
        expect(emailArg).toBe("email-new-target@example.com");
        expect(userContext).toEqual(
          expect.objectContaining({
            rowndPendingVerificationId: expect.any(String),
          }),
        );
      });

      it("preserves metadata structure after update", async () => {
        const { server: s, port } = await setup(coreConnectionURI);
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
            data: expect.objectContaining({
              first_name: "John",
              user_id: "metadata-structure-user",
            }),
            meta: expect.objectContaining({
              custom_field: "custom_value",
            }),
            verified_data: expect.any(Object),
            attributes: expect.any(Object),
          }),
        );
      });
    });

    describe("DELETE /user", () => {
      it("deletes the compatibility user", async () => {
        const { server: s, port } = await setup(coreConnectionURI);
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

    describe("GET /user/meta", () => {
      it("gets compatibility user meta", async () => {
        const { server: s, port } = await setup(coreConnectionURI);
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
        const { server: s, port } = await setup(coreConnectionURI);
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
        const { server: s, port } = await setup(coreConnectionURI);
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

      it("returns 400 when field is missing", async () => {
        const { server: s, port } = await setup(coreConnectionURI);
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
        const { server: s, port } = await setup(coreConnectionURI);
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
        const { server: s, port } = await setup(coreConnectionURI);
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
            rownd_pending_verification: expect.objectContaining({
              field: "email",
              value: "new-email-field@example.com",
            }),
          }),
        );
      });

      it("returns 400 when field is missing", async () => {
        const { server: s, port } = await setup(coreConnectionURI);
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
    ) {
      mockRowndClient.validateToken.mockResolvedValue({ user_id: userId });
      mockRowndClient.fetchUserInfo.mockResolvedValue({
        app_user_id: userId,
        data: { user_id: userId, email },
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
        data: {
          user_id: user.id,
          email,
        },
        meta: {
          created: "2026-01-01T00:00:00.000Z",
        },
        verified_data: {
          email,
        },
        attributes: {},
        rownd_migrated: true,
        rownd_user_id: user.id,
        state: "enabled",
        auth_level: "verified",
      });

      const session = await Session.createNewSessionWithoutRequestResponse(
        "public",
        recipeUserId!,
        {},
        {},
        true,
      );

      return {
        accessToken: session.getAccessToken(),
        userId: user.id,
        recipeUserId: recipeUserId!,
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
              shouldRequireVerification: false,
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
                  mode: "OPTIONAL",
                  emailDelivery: {
                    override: (originalImplementation) => ({
                      ...originalImplementation,
                      sendEmail: async () => {},
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
                },
                {
                  config: {
                    thirdPartyId: "apple",
                    clients: [{ clientId: "test", clientSecret: "test" }],
                  },
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

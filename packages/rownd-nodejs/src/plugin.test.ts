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
import EmailPassword from "supertokens-node/recipe/emailpassword";
import ThirdParty from "supertokens-node/recipe/thirdparty";
import AccountLinking from "supertokens-node/recipe/accountlinking";
import { middleware, errorHandler } from "supertokens-node/framework/express";
import { ProcessState } from "supertokens-node/lib/build/processState";
import SuperTokensRaw from "supertokens-node/lib/build/supertokens";
import SessionRaw from "supertokens-node/lib/build/recipe/session/recipe";
import UserMetadataRaw from "supertokens-node/lib/build/recipe/usermetadata/recipe";
import UserRolesRaw from "supertokens-node/lib/build/recipe/userroles/recipe";
import AccountLinkingRaw from "supertokens-node/lib/build/recipe/accountlinking/recipe";
import EmailPasswordRaw from "supertokens-node/lib/build/recipe/emailpassword/recipe";
import ThirdPartyRaw from "supertokens-node/lib/build/recipe/thirdparty/recipe";
import PasswordlessRaw from "supertokens-node/lib/build/recipe/passwordless/recipe";
import MultitenancyRaw from "supertokens-node/lib/build/recipe/multitenancy/recipe";
import { NormalisedURLDomain } from "supertokens-node/lib/build/normalisedURLDomain";
import { Querier } from "supertokens-node/lib/build/querier";
import { Server } from "http";
import crypto from "crypto";
import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";
import { Network, StartedNetwork } from "testcontainers";

import { init } from "./plugin";
import { HANDLE_BASE_PATH } from "./constants";
import { RowndPluginConfig, RowndTelemetryClient } from "./types";
import { ROWND_PLUGIN_ERROR_MESSAGES } from "./errors";
import { mapRowndUserToSuperTokens } from "./pluginImplementation";

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
        // LOG_LEVEL: "DEBUG",
        // INFO_LOG_PATH: "null",
        // ERROR_LOG_PATH: "null",
      })
      .withExposedPorts(3567)
      .withWaitStrategy(Wait.forHttp("/hello", 3567))
      .start();

    // const stream = await container.logs();
    // stream.on("data", (line) => console.log(line));

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
      ).toThrowError(new Error("Rownd user has no app_user_id"));
    });

    it("throws when data.user_id is missing", () => {
      expect(() =>
        mapRowndUserToSuperTokens({
          app_user_id: "rownd-missing-user-id",
          data: { email: "missing-user-id@example.com" },
          verified_data: { email: true },
        } as any),
      ).toThrowError(new Error("Rownd user has no app_user_id"));
    });

    it("throws when no supported login method can be derived", () => {
      expect(() =>
        mapRowndUserToSuperTokens({
          data: { user_id: "rownd-no-login-method" },
          verified_data: {},
        } as any),
      ).toThrowError(
        new Error("No valid login methods found in Rownd user data"),
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
  });

  describe("user migration", () => {
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
          operation: "migrate",
          rowndUserId: rowndUser.app_user_id,
          superTokensUserId: expect.any(String),
        }),
      );
    });

    it("migrate user with custom metadata successfully", async () => {
      const { server: s, port } = await setup(coreConnectionURI);
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
      expect(body.message).toBe("Invalid token API");
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
      expect(body.message).toBe("Fetch failed");
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
        recordEvent: vi.fn(() => {
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
      mockRowndClient.validateToken.mockResolvedValue({ user_id: "rownd-dup" });
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
  MultitenancyRaw.reset();
  SuperTokensRaw.reset();
  Querier.reset();
}

async function getMigratedUserByRowndUserId(rowndUserId: string) {
  const mapping = await SuperTokens.getUserIdMapping({
    userId: rowndUserId,
    userIdType: "EXTERNAL",
  });

  if (mapping.status !== "OK") {
    return undefined;
  }

  const user = await SuperTokens.getUser(mapping.externalUserId);
  const metadata = await getUserMetadata(mapping.externalUserId);

  return {
    user,
    metadata,
  };
}

async function setup(
  coreConnectionURI: string,
  config?: Partial<RowndPluginConfig>,
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
          Session.init(),
          AccountLinking.init({
            shouldDoAutomaticAccountLinking: async () => ({
              shouldAutomaticallyLink: true,
              shouldRequireVerification: false,
            }),
          }),
          UserMetadata.init(),
          Passwordless.init({
            contactMethod: "EMAIL",
            flowType: "MAGIC_LINK",
          }),
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

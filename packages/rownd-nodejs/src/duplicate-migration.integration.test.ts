import express from "express";
import { randomInt, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import SuperTokens from "supertokens-node";
import AccountLinking from "supertokens-node/recipe/accountlinking";
import Multitenancy from "supertokens-node/recipe/multitenancy";
import Passwordless from "supertokens-node/recipe/passwordless";
import Session from "supertokens-node/recipe/session";
import ThirdParty from "supertokens-node/recipe/thirdparty";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import { errorHandler, middleware } from "supertokens-node/framework/express";
import { ProcessState } from "supertokens-node/lib/build/processState";
import { Querier } from "supertokens-node/lib/build/querier";
import SuperTokensRaw from "supertokens-node/lib/build/supertokens";
import AccountLinkingRaw from "supertokens-node/lib/build/recipe/accountlinking/recipe";
import EmailPasswordRaw from "supertokens-node/lib/build/recipe/emailpassword/recipe";
import EmailVerificationRaw from "supertokens-node/lib/build/recipe/emailverification/recipe";
import MultitenancyRaw from "supertokens-node/lib/build/recipe/multitenancy/recipe";
import PasswordlessRaw from "supertokens-node/lib/build/recipe/passwordless/recipe";
import SessionRaw from "supertokens-node/lib/build/recipe/session/recipe";
import ThirdPartyRaw from "supertokens-node/lib/build/recipe/thirdparty/recipe";
import UserMetadataRaw from "supertokens-node/lib/build/recipe/usermetadata/recipe";
import UserRolesRaw from "supertokens-node/lib/build/recipe/userroles/recipe";
import { GenericContainer, Network, Wait } from "testcontainers";
import type { StartedNetwork, StartedTestContainer } from "testcontainers";
import { init } from "./plugin";
import { createMissingLoginMethod } from "./supertokens-repository";
import type { RowndTelemetryEvent, RowndUser } from "./types";

const mockRowndClient = {
  validateToken: vi.fn(),
  fetchUserInfo: vi.fn(),
};

vi.mock("@rownd/node", () => ({
  createInstance: () => mockRowndClient,
}));

const ACCOUNT_LINKING_TEST_LICENSE =
  "N2uEOdEzd1XZZ5VBSTGYaM7Ia4s8wAqRWFAxLqTYrB6GQ=" +
  "vssOLo3c=PkFgcExkaXs=IA-d9UWccoNKsyUgNhOhcKtM1bjC5OLrYRpTAgN-2EbKYsQGGQRQHuUN4EO1V";

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

function duplicateProfiles(appleId?: string) {
  const canonicalId = `rownd-a-${randomUUID()}`;
  const duplicateId = `rownd-b-${randomUUID()}`;
  const googleId = `google-${randomUUID()}`;
  const profiles = new Map<string, RowndUser>(
    [canonicalId, duplicateId].map((userId) => [
      userId,
      {
        state: "enabled",
        auth_level: "verified",
        data: { user_id: userId, google_id: googleId },
        verified_data: appleId ? { apple_id: appleId } : {},
      },
    ]),
  );
  const tokenA = `token-${canonicalId}`;
  const tokenB = `token-${duplicateId}`;
  const tokenUsers = new Map([
    [tokenA, canonicalId],
    [tokenB, duplicateId],
  ]);
  mockRowndClient.validateToken.mockImplementation(async (token: string) => {
    const userId = tokenUsers.get(token);
    if (!userId) throw new Error("Invalid fixture Rownd token");
    return { user_id: userId };
  });
  mockRowndClient.fetchUserInfo.mockImplementation(
    async ({ user_id }: { user_id: string }) => profiles.get(user_id),
  );
  return { canonicalId, duplicateId, googleId, tokenA, tokenB, profiles };
}

function rowndHTTPError(statusCode: number) {
  const error = Object.assign(new Error(`Response code ${statusCode}`), {
    name: "HTTPError",
    code: "ERR_NON_2XX_3XX_RESPONSE",
  });
  // Got 11 (used by @rownd/node) exposes response as a non-enumerable property.
  return Object.defineProperty(error, "response", { value: { statusCode } });
}

async function createMappedProvider(
  providerId: string,
  providerUserId: string,
  rowndId: string,
  email = `${randomUUID()}@example.com`,
) {
  const result = await ThirdParty.manuallyCreateOrUpdateUser(
    "public",
    providerId,
    providerUserId,
    email,
    true,
    undefined,
    { rowndDisableAutomaticAccountLinking: true },
  );
  expect(result.status).toBe("OK");
  if (result.status !== "OK") {
    throw new Error("Could not seed provider account");
  }
  const internalId = result.recipeUserId.getAsString();
  await expect(
    SuperTokens.createUserIdMapping({
      superTokensUserId: internalId,
      externalUserId: rowndId,
    }),
  ).resolves.toMatchObject({ status: "OK" });
  return internalId;
}

describe("duplicate Rownd profiles through legacy POST /migrate", () => {
  let telemetryEvents: RowndTelemetryEvent[] = [];
  let network: StartedNetwork | undefined;
  let postgres: StartedTestContainer | undefined;
  let core: StartedTestContainer | undefined;
  let coreConnectionURI: string;
  let server: Server | undefined;
  let baseUrl: string;
  let rejectMetadataWrites = () => false;
  let onLinkCommitted = () => {};

  beforeAll(async () => {
    network = await new Network().start();
    postgres = await new GenericContainer("postgres:14")
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
    core = await new GenericContainer("supertokens/supertokens-postgresql")
      .withNetwork(network)
      .withEnvironment({
        POSTGRESQL_CONNECTION_URI:
          "postgresql://supertokens:somepassword@postgres:5432/supertokens",
      })
      .withExposedPorts(3567)
      .withWaitStrategy(Wait.forHttp("/hello", 3567))
      .start();
    coreConnectionURI = `http://${core.getHost()}:${core.getMappedPort(3567)}`;
    const response = await fetch(`${coreConnectionURI}/ee/license`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ licenseKey: ACCOUNT_LINKING_TEST_LICENSE }),
    });
    if (!response.ok) {
      throw new Error(
        `Failed to enable account linking: ${response.status} ${await response.text()}`,
      );
    }
  }, 120000);

  afterAll(async () => {
    await core?.stop();
    await postgres?.stop();
    await network?.stop();
  });

  async function stopServer() {
    if (server) {
      const closingServer = server;
      server = undefined;
      await new Promise<void>((resolve, reject) => {
        closingServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }

  async function startServer() {
    const app = express();
    const listeningServer = app.listen(0);
    server = listeningServer;
    await new Promise<void>((resolve, reject) => {
      listeningServer.once("listening", resolve);
      listeningServer.once("error", reject);
    });
    const address = listeningServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Missing test server port");
    }
    baseUrl = `http://localhost:${address.port}`;
    SuperTokens.init({
      supertokens: { connectionURI: coreConnectionURI },
      appInfo: {
        appName: "Duplicate migration tests",
        apiDomain: baseUrl,
        websiteDomain: "http://localhost:3000",
      },
      recipeList: [
        AccountLinking.init({
          shouldDoAutomaticAccountLinking: async () => ({
            shouldAutomaticallyLink: false,
          }),
          override: {
            functions: (original) => ({
              ...original,
              linkAccounts: async (input) => {
                const result = await original.linkAccounts(input);
                if (result.status === "OK") onLinkCommitted();
                return result;
              },
            }),
          },
        }),
        Session.init(),
        UserMetadata.init({
          override: {
            functions: (original) => ({
              ...original,
              updateUserMetadata: async (input) => {
                if (rejectMetadataWrites()) {
                  throw new Error(
                    "Simulated metadata storage failure after Core committed linking",
                  );
                }
                return original.updateUserMetadata(input);
              },
            }),
          },
        }),
        Passwordless.init({ contactMethod: "EMAIL", flowType: "MAGIC_LINK" }),
        ThirdParty.init(),
      ],
      experimental: {
        plugins: [
          init({
            rowndAppKey: "test-key",
            rowndAppSecret: "test-secret",
            enableDebugLogs: true,
            telemetry: {
              provider: "custom",
              factory: () => ({ recordEvent: (event) => { telemetryEvents.push(event); } }),
            },
          }),
        ],
      },
    });
    app.use(middleware());
    app.use(errorHandler());
  }

  beforeEach(async () => {
    resetST();
    vi.resetAllMocks();
    telemetryEvents = [];
    rejectMetadataWrites = () => false;
    onLinkCommitted = () => {};
    await startServer();
  });

  afterEach(async () => {
    await stopServer();
    resetST();
    vi.restoreAllMocks();
  });

  function requestMigration(token: string, signal?: AbortSignal) {
    return fetch(`${baseUrl}/auth/plugin/rownd/migrate`, {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "st-auth-mode": "header",
        rid: "session",
        "fdi-version": "1.18",
      },
    });
  }

  async function expectSuccessfulMigration(
    response: Response,
    tokenUserId: string,
  ) {
    const body = await response.json();
    expect({ httpStatus: response.status, body }).toEqual({
      httpStatus: 200,
      body: { status: "OK" },
    });
    const accessToken = response.headers.get("st-access-token");
    expect(
      accessToken,
      "Successful reconciliation must create a real session",
    ).toBeTruthy();
    const session = await Session.getSessionWithoutRequestResponse(
      accessToken!,
    );
    expect(
      session.getUserId(),
      "Session identity must equal the validated token identity",
    ).toBe(tokenUserId);
    return session;
  }

  async function migrate(token: string, tokenUserId: string) {
    return expectSuccessfulMigration(
      await requestMigration(token),
      tokenUserId,
    );
  }

  async function expectRejectedMigration(response: Response) {
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      status: "ERROR",
      message: "Migration failed",
    });
    expect(response.headers.get("st-access-token")).toBeNull();
    expect(response.headers.get("st-refresh-token")).toBeNull();
    expect(response.headers.get("set-cookie") ?? "").not.toMatch(
      /sAccessToken=|sRefreshToken=/,
    );
  }

  async function expectCanonicalMapping(rowndId: string, internalId: string) {
    await expect(
      SuperTokens.getUserIdMapping({ userId: rowndId, userIdType: "EXTERNAL" }),
    ).resolves.toMatchObject({
      status: "OK",
      superTokensUserId: internalId,
      externalUserId: rowndId,
    });
  }

  describe("existing passwordless response ownership boundary", () => {
    it("allows overlapping migrations of the same profile when the creator links before the existing response is checked", async () => {
      const fixture = duplicateProfiles();
      const email = `${randomUUID()}@example.com`;
      const profile = fixture.profiles.get(fixture.canonicalId)!;
      profile.data.email = email;
      profile.verified_data = { google_id: fixture.googleId, email };
      const primaryId = await createMappedProvider("google", fixture.googleId, fixture.canonicalId);
      await expect(
        AccountLinking.createPrimaryUser(SuperTokens.convertToRecipeUserId(primaryId)),
      ).resolves.toMatchObject({ status: "OK" });

      function gate() {
        let release!: () => void;
        const promise = new Promise<void>((resolve) => { release = resolve; });
        return { promise, release };
      }
      const secondEntered = gate();
      const created = gate();
      const existingCaptured = gate();
      const linked = gate();
      onLinkCommitted = linked.release;
      const realSignInUp = Passwordless.signInUp;
      let calls = 0;
      let recipeUserId: string | undefined;
      vi.spyOn(Passwordless, "signInUp").mockImplementation(async (input) => {
        expect(input.email).toBe(email);
        const call = ++calls;
        if (call === 1) {
          // Both real migrations must inspect the missing method before either creates it.
          await secondEntered.promise;
          const result = await realSignInUp(input);
          expect(result.createdNewRecipeUser).toBe(true);
          recipeUserId = result.recipeUserId.getAsString();
          expect(result.user.id).toBe(recipeUserId);
          created.release();
          await existingCaptured.promise;
          return result;
        }
        expect(call).toBe(2);
        secondEntered.release();
        await created.promise;
        const snapshot = await realSignInUp(input);
        expect(snapshot.createdNewRecipeUser).toBe(false);
        expect(snapshot.user.id).toBe(recipeUserId);
        expect(snapshot.user.isPrimaryUser).toBe(false);
        existingCaptured.release();
        // The first migration, not a simulated external actor, commits the link.
        await linked.promise;
        await expect(SuperTokens.getUser(recipeUserId!)).resolves.toMatchObject({
          id: fixture.canonicalId,
          isPrimaryUser: true,
        });
        return snapshot;
      });

      const signal = AbortSignal.timeout(10000);
      const requests = [
        requestMigration(fixture.tokenA, signal),
        requestMigration(fixture.tokenA, signal),
      ];
      try {
        const responses = await Promise.all(requests);
        expect(calls).toBe(2);
        await expectCanonicalMapping(fixture.canonicalId, primaryId);
        expect((await SuperTokens.getUser(fixture.canonicalId))?.loginMethods).toHaveLength(2);
        for (const response of responses) {
          await expectSuccessfulMigration(response, fixture.canonicalId);
        }
      } finally {
        secondEntered.release();
        created.release();
        existingCaptured.release();
        linked.release();
        await Promise.allSettled(requests);
      }
    }, 15000);

    it.each(["intended", "foreign"] as const)(
      "accepts only the intended current owner after a standalone response is linked (%s owner)",
      async (owner) => {
        const rowndId = `rownd-${randomUUID()}`;
        const email = `${randomUUID()}@example.com`;
        const primaryId = await createMappedProvider("google", randomUUID(), rowndId);
        await expect(
          AccountLinking.createPrimaryUser(SuperTokens.convertToRecipeUserId(primaryId)),
        ).resolves.toMatchObject({ status: "OK" });
        const ownerRowndId = owner === "intended" ? rowndId : `foreign-${randomUUID()}`;
        const ownerPrimaryId = owner === "intended"
          ? primaryId
          : await createMappedProvider("google", randomUUID(), ownerRowndId);
        if (owner === "foreign") {
          await expect(
            AccountLinking.createPrimaryUser(SuperTokens.convertToRecipeUserId(ownerPrimaryId)),
          ).resolves.toMatchObject({ status: "OK" });
        }
        const standalone = await Passwordless.signInUp({
          tenantId: "public",
          email,
          userContext: { rowndDisableAutomaticAccountLinking: true },
        });
        expect(standalone.createdNewRecipeUser).toBe(true);
        const recipeUserId = standalone.recipeUserId.getAsString();
        expect(standalone.user.id).toBe(recipeUserId);
        const realSignInUp = Passwordless.signInUp;
        vi.spyOn(Passwordless, "signInUp").mockImplementationOnce(async (input) => {
          const snapshot = await realSignInUp(input);
          expect(snapshot.createdNewRecipeUser).toBe(false);
          expect(snapshot.user.id).toBe(recipeUserId);
          expect(snapshot.user.isPrimaryUser).toBe(false);
          // Force an external link between the real Core response and the ownership guard.
          // This boundary test alone does not establish a same-plugin concurrency schedule.
          await expect(
            AccountLinking.linkAccounts(snapshot.recipeUserId, ownerPrimaryId),
          ).resolves.toMatchObject({ status: "OK" });
          await expect(SuperTokens.getUser(recipeUserId)).resolves.toMatchObject({
            id: ownerRowndId,
            isPrimaryUser: true,
          });
          return snapshot;
        });

        const creation = createMissingLoginMethod(
          { recipeId: "passwordless", email, isVerified: true },
          "public",
          primaryId,
          {},
        );

        if (owner === "intended") {
          const result = await creation;
          expect(result.createdNewRecipeUser).toBe(false);
          expect(result.recipeUserId.getAsString()).toBe(recipeUserId);
        } else {
          await expect(creation).rejects.toThrow(
            "Migrated passwordless login method belongs to another SuperTokens user",
          );
        }
        await expectCanonicalMapping(rowndId, primaryId);
        await expectCanonicalMapping(ownerRowndId, ownerPrimaryId);
        const actualOwner = await SuperTokens.getUser(recipeUserId);
        expect(actualOwner?.id).toBe(ownerRowndId);
        expect(actualOwner?.loginMethods).toHaveLength(2);
        if (owner === "foreign") {
          expect((await SuperTokens.getUser(rowndId))?.loginMethods).toHaveLength(1);
        }
      },
    );
  });

  describe("existing passwordless response ownership boundary fresh identity controls", () => {
    it.each(
      (["email", "phoneNumber"] as const).flatMap((contact) =>
        (["unchanged", "identity changed", "tenant removed", "recipe deleted"] as const)
          .map((change) => ({ contact, change })),
      ),
    )("checks the current $contact method when $change", async ({ contact, change }) => {
      const rowndId = `rownd-${randomUUID()}`;
      const primaryId = await createMappedProvider("google", randomUUID(), rowndId);
      await expect(
        AccountLinking.createPrimaryUser(SuperTokens.convertToRecipeUserId(primaryId)),
      ).resolves.toMatchObject({ status: "OK" });
      const identity = contact === "email"
        ? { email: `${randomUUID()}@example.com` }
        : { phoneNumber: `+1415${randomInt(1000000, 9999999)}` };
      const standalone = await Passwordless.signInUp({
        tenantId: "public",
        ...identity,
        userContext: { rowndDisableAutomaticAccountLinking: true },
      });
      await expect(
        AccountLinking.linkAccounts(standalone.recipeUserId, primaryId),
      ).resolves.toMatchObject({ status: "OK" });
      const recipeUserId = standalone.recipeUserId.getAsString();
      const realSignInUp = Passwordless.signInUp;
      vi.spyOn(Passwordless, "signInUp").mockImplementationOnce(async (input) => {
        const snapshot = await realSignInUp(input);
        expect(snapshot.createdNewRecipeUser).toBe(false);
        expect(snapshot.user.id).toBe(rowndId);
        // Prime the same request cache before mutating Core through a separate context.
        await expect(SuperTokens.getUser(recipeUserId, input.userContext))
          .resolves.toMatchObject({ id: rowndId });
        if (change === "identity changed") {
          await expect(Passwordless.updateUser({
            recipeUserId: standalone.recipeUserId,
            ...(contact === "email"
              ? { email: `${randomUUID()}@example.com` }
              : { phoneNumber: `+1416${randomInt(1000000, 9999999)}` }),
          })).resolves.toMatchObject({ status: "OK" });
        } else if (change === "tenant removed") {
          await expect(Multitenancy.disassociateUserFromTenant("public", standalone.recipeUserId))
            .resolves.toMatchObject({ status: "OK" });
          const current = await SuperTokens.getUser(recipeUserId);
          expect(current?.id).toBe(rowndId);
          const currentMethod = current?.loginMethods.find((method) =>
            method.recipeUserId.getAsString() === recipeUserId);
          expect(currentMethod).toBeDefined();
          expect(currentMethod?.tenantIds).not.toContain("public");
        } else if (change === "recipe deleted") {
          await expect(SuperTokens.deleteUser(recipeUserId, false))
            .resolves.toMatchObject({ status: "OK" });
          await expect(SuperTokens.getUser(recipeUserId)).resolves.toBeUndefined();
        }
        return snapshot;
      });

      const creation = createMissingLoginMethod(
        {
          recipeId: "passwordless",
          ...identity,
          ...(identity.email ? { email: ` ${identity.email.toUpperCase()} ` } : {}),
          isVerified: true,
        },
        "public",
        primaryId,
        {},
      );
      if (change === "unchanged") {
        const result = await creation;
        expect(result.createdNewRecipeUser).toBe(false);
        expect(result.recipeUserId.getAsString()).toBe(recipeUserId);
      } else {
        await expect(creation).rejects.toThrow(
          "Migrated passwordless login method belongs to another SuperTokens user",
        );
      }
      await expectCanonicalMapping(rowndId, primaryId);
    });
  });

  it("rejects a profile whose user ID differs from the validated token before changing mappings", async () => {
    const fixture = duplicateProfiles();
    const internalId = await createMappedProvider("google", fixture.googleId, fixture.duplicateId);
    mockRowndClient.fetchUserInfo.mockResolvedValue(fixture.profiles.get(fixture.duplicateId));
    const deleteMapping = vi.spyOn(SuperTokens, "deleteUserIdMapping");
    await expectRejectedMigration(await requestMigration(fixture.tokenA));
    expect(deleteMapping).not.toHaveBeenCalled();
    await expectCanonicalMapping(fixture.duplicateId, internalId);
  });

  it("withholds mismatched session credentials and revokes only the newly created session", async () => {
    const fixture = duplicateProfiles();
    const internalId = await createMappedProvider("google", fixture.googleId, fixture.duplicateId);
    const foreign = await ThirdParty.manuallyCreateOrUpdateUser("public", "google", randomUUID(), `${randomUUID()}@example.com`, true);
    if (foreign.status !== "OK") throw new Error("Could not seed foreign session owner");
    const existingSession = await Session.createNewSessionWithoutRequestResponse("public", foreign.recipeUserId);
    const createSession = Session.createNewSession;
    let newSessionHandle: string | undefined;
    const sessionSpy = vi.spyOn(Session, "createNewSession").mockImplementation(async (req, res, tenant, _recipeUserId, ...rest) => {
      const session = await createSession(req, res, tenant, foreign.recipeUserId, ...rest);
      newSessionHandle = session.getHandle();
      return session;
    });

    await expectRejectedMigration(await requestMigration(fixture.tokenA));
    expect(newSessionHandle).toBeDefined();
    expect(await Session.getSessionInformation(newSessionHandle!)).toBeUndefined();
    expect(await Session.getSessionInformation(existingSession.getHandle())).toBeDefined();
    await expectCanonicalMapping(fixture.canonicalId, internalId);
    sessionSpy.mockRestore();
    await migrate(fixture.tokenA, fixture.canonicalId);
    await expectRejectedMigration(await requestMigration(fixture.tokenB));
  });

  it("leaves completed Apple A and duplicate Google B separate while preserving a native canonical email", async () => {
    const appleId = `apple-${randomUUID()}`;
    const fixture = duplicateProfiles(appleId);
    const appleInternalId = await createMappedProvider("apple", appleId, fixture.canonicalId);
    const googleInternalId = await createMappedProvider("google", fixture.googleId, fixture.duplicateId);
    await AccountLinking.createPrimaryUser(SuperTokens.convertToRecipeUserId(appleInternalId));
    const currentEmail = `${randomUUID()}@current.example`;
    const oldEmail = `${randomUUID()}@retired.example`;
    const passwordless = await Passwordless.signInUp({ tenantId: "public", email: currentEmail });
    await AccountLinking.linkAccounts(passwordless.recipeUserId, appleInternalId);
    const metadata = {
      rownd_migration_complete: true,
      rownd_email_recipe_user_ids: { public: passwordless.recipeUserId.getAsString() },
      preference: "keep-current",
      original_rownd_user: { data: { user_id: fixture.canonicalId, email: currentEmail } },
    };
    await UserMetadata.updateUserMetadata(appleInternalId, metadata);
    fixture.profiles.get(fixture.canonicalId)!.data.email = oldEmail;

    await migrate(fixture.tokenA, fixture.canonicalId);
    await expectCanonicalMapping(fixture.canonicalId, appleInternalId);
    const user = await SuperTokens.getUser(fixture.canonicalId);
    expect(user?.loginMethods).toHaveLength(2);
    expect(user?.loginMethods.some((method) => method.email === oldEmail)).toBe(false);
    await expect(UserMetadata.getUserMetadata(appleInternalId)).resolves.toMatchObject({ metadata });
    await expectCanonicalMapping(fixture.duplicateId, googleInternalId);
    expect((await SuperTokens.getUser(fixture.duplicateId))?.loginMethods).toHaveLength(1);
  });

  async function seedMissingDuplicate() {
    const appleId = `002006.${randomUUID()}`;
    const fixture = duplicateProfiles(appleId);
    const profile = fixture.profiles.get(fixture.canonicalId)!;
    profile.verified_data = { google_id: fixture.googleId, apple_id: appleId };
    const relayEmail = `${randomUUID()}@privaterelay.appleid.com`;
    const appleInternalId = await createMappedProvider("apple", appleId, fixture.canonicalId, relayEmail);
    await AccountLinking.createPrimaryUser(SuperTokens.convertToRecipeUserId(appleInternalId));
    const googleInternalId = await createMappedProvider("google", fixture.googleId, fixture.duplicateId);
    fixture.profiles.delete(fixture.duplicateId);
    mockRowndClient.fetchUserInfo.mockImplementation(async ({ user_id }: { user_id: string }) => {
      if (user_id === fixture.duplicateId) throw rowndHTTPError(404);
      return fixture.profiles.get(user_id);
    });
    return { ...fixture, appleId, appleInternalId, googleInternalId, relayEmail };
  }

  it("repairs Apple A with verified Google proof when duplicate Rownd B returns HTTPError 404", async () => {
    const fixture = await seedMissingDuplicate();
    expect((await SuperTokens.getUser(fixture.googleInternalId))?.isPrimaryUser).toBe(false);
    expect((await SuperTokens.getUser(fixture.canonicalId))?.loginMethods).toHaveLength(1);

    const response = await requestMigration(fixture.tokenA);
    const session = await expectSuccessfulMigration(response, fixture.canonicalId);

    expect(session.getUserId()).toBe(fixture.canonicalId);
    const claims = JSON.parse(Buffer.from(response.headers.get("st-access-token")!.split(".")[1]!, "base64url").toString());
    expect(claims.sub).toBe(fixture.canonicalId);
    await expectCanonicalMapping(fixture.canonicalId, fixture.appleInternalId);
    await expect(SuperTokens.getUserIdMapping({ userId: fixture.duplicateId, userIdType: "EXTERNAL" }))
      .resolves.toEqual({ status: "UNKNOWN_MAPPING_ERROR" });
    const user = await SuperTokens.getUser(fixture.canonicalId);
    expect(user?.isPrimaryUser).toBe(true);
    expect(user?.loginMethods).toHaveLength(2);
    expect(user?.loginMethods).toEqual(expect.arrayContaining([
      expect.objectContaining({ thirdParty: { id: "apple", userId: fixture.appleId }, email: fixture.relayEmail }),
      expect.objectContaining({ thirdParty: { id: "google", userId: fixture.googleId }, tenantIds: ["public"] }),
    ]));
    await expect(SuperTokens.getUser(fixture.googleInternalId)).resolves.toMatchObject({ id: fixture.canonicalId });
    expect(user?.loginMethods.find((method) => method.thirdParty?.id === "google")?.recipeUserId.getAsString())
      .toBe(fixture.googleInternalId);
    expect(telemetryEvents).toContainEqual(expect.objectContaining({ reason: "duplicate_mapping_retired" }));
    await expect(UserMetadata.getUserMetadata(fixture.duplicateId)).resolves.toMatchObject({
      metadata: { rownd_migration_superseded: { rowndUserId: fixture.canonicalId, targetUserId: fixture.appleInternalId } },
    });
    await migrate(fixture.tokenA, fixture.canonicalId);
    await expectRejectedMigration(await requestMigration(fixture.tokenB));
  });

  it.each([
    "duplicate 403", "duplicate 500", "duplicate timeout", "duplicate ambiguous 404",
    "requested 404", "fresh requested 404", "fresh requested 403", "fresh requested 500",
    "fresh requested timeout", "fresh requested absent", "fresh requested wrong ID",
    "fresh requested wrong provider", "fresh requested unverified provider", "fresh requested contradictory proof",
  ])("rejects missing-duplicate repair without mutation on %s", async (failure) => {
    const fixture = await seedMissingDuplicate();
    let sourceReads = 0;
    mockRowndClient.fetchUserInfo.mockImplementation(async ({ user_id }: { user_id: string }) => {
      const isDuplicate = user_id === fixture.duplicateId;
      if (!isDuplicate) sourceReads++;
      const shouldFail = isDuplicate ? failure.startsWith("duplicate") :
        failure === "requested 404" || (failure.startsWith("fresh requested") && sourceReads > 1);
      if (shouldFail) {
        if (failure.endsWith("ambiguous 404")) throw new Error("Rownd request failed: 404");
        if (failure.endsWith("timeout")) throw Object.assign(new Error("Request timed out"), { name: "TimeoutError", code: "ETIMEDOUT" });
        if (failure.endsWith("404")) throw rowndHTTPError(404);
        if (failure.endsWith("403")) throw rowndHTTPError(403);
        if (failure.endsWith("500")) throw rowndHTTPError(500);
        if (failure.endsWith("absent")) return undefined;
        const profile = structuredClone(fixture.profiles.get(fixture.canonicalId)!);
        if (failure.endsWith("wrong ID")) profile.data.user_id = fixture.duplicateId;
        if (failure.endsWith("wrong provider")) {
          profile.data.google_id = "another-google-subject";
          profile.verified_data!.google_id = "another-google-subject";
        }
        if (failure.endsWith("unverified provider")) delete profile.verified_data!.google_id;
        if (failure.endsWith("contradictory proof")) profile.verified_data!.google_id = "another-google-subject";
        return profile;
      }
      if (isDuplicate) throw rowndHTTPError(404);
      return fixture.profiles.get(user_id);
    });
    const ids = [fixture.appleInternalId, fixture.googleInternalId, fixture.canonicalId, fixture.duplicateId];
    const snapshot = () => Promise.all(ids.map(async (id) => ({
      user: (await SuperTokens.getUser(id))?.toJson(),
      metadata: await UserMetadata.getUserMetadata(id),
      mapping: await SuperTokens.getUserIdMapping({ userId: id }),
    })));
    const before = await snapshot();
    const mutations = [
      vi.spyOn(SuperTokens, "createUserIdMapping"),
      vi.spyOn(SuperTokens, "deleteUserIdMapping"),
      vi.spyOn(AccountLinking, "createPrimaryUser"),
      vi.spyOn(AccountLinking, "linkAccounts"),
      vi.spyOn(UserMetadata, "updateUserMetadata"),
      vi.spyOn(ThirdParty, "manuallyCreateOrUpdateUser"),
      vi.spyOn(Passwordless, "signInUp"),
    ];

    await expectRejectedMigration(await requestMigration(fixture.tokenA));

    for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
    await expectCanonicalMapping(fixture.canonicalId, fixture.appleInternalId);
    await expectCanonicalMapping(fixture.duplicateId, fixture.googleInternalId);
  });

  it("repairs duplicate Google B to token A and rejects token B after SDK reinitialization without changing A", async () => {
    const fixture = duplicateProfiles();
    const internalId = await createMappedProvider(
      "google",
      fixture.googleId,
      fixture.duplicateId,
    );
    await UserMetadata.updateUserMetadata(internalId, {
      internalPreference: "keep",
      sharedPreference: "internal",
      settings: { native: true, shared: "internal" },
    });
    await UserMetadata.updateUserMetadata(fixture.duplicateId, {
      externalPreference: "keep",
      sharedPreference: "external",
      settings: { imported: true, shared: "external" },
    });
    expect((await UserMetadata.getUserMetadata(internalId)).metadata.externalPreference).toBeUndefined();

    const firstSession = await migrate(fixture.tokenA, fixture.canonicalId);

    expect(firstSession.getUserId()).toBe(fixture.canonicalId);
    await expectCanonicalMapping(fixture.canonicalId, internalId);
    await expect(UserMetadata.getUserMetadata(internalId)).resolves.toMatchObject({
      metadata: {
        internalPreference: "keep", externalPreference: "keep", sharedPreference: "internal",
        settings: { native: true, imported: true, shared: "internal" },
      },
    });
    await expect(UserMetadata.getUserMetadata(fixture.duplicateId)).resolves.toMatchObject({
      metadata: { externalPreference: "keep", rownd_migration_superseded: { rowndUserId: fixture.canonicalId } },
    });
    const user = await SuperTokens.getUser(fixture.canonicalId);
    expect(user?.loginMethods).toEqual([
      expect.objectContaining({
        thirdParty: { id: "google", userId: fixture.googleId },
      }),
    ]);

    // The rejection decision must survive SDK reinitialization, not rely on request context.
    await stopServer();
    resetST();
    await startServer();
    for (let attempt = 0; attempt < 2; attempt++) {
      await expectRejectedMigration(await requestMigration(fixture.tokenB));
      await migrate(fixture.tokenA, fixture.canonicalId);
      await expectCanonicalMapping(fixture.canonicalId, internalId);
      await expect(SuperTokens.getUser(internalId)).resolves.toMatchObject({
        id: fixture.canonicalId,
      });
    }
    await expect(
      SuperTokens.listUsersByAccountInfo(
        "public",
        { thirdParty: { id: "google", userId: fixture.googleId } },
        false,
      ),
    ).resolves.toEqual([expect.objectContaining({ id: fixture.canonicalId })]);
  });

  it("links duplicate Google B to existing Apple A using current and verified provider fields", async () => {
    const appleId = `apple-${randomUUID()}`;
    const fixture = duplicateProfiles(appleId);
    const appleInternalId = await createMappedProvider(
      "apple",
      appleId,
      fixture.canonicalId,
    );
    const googleInternalId = await createMappedProvider(
      "google",
      fixture.googleId,
      fixture.duplicateId,
    );
    expect((await SuperTokens.getUser(googleInternalId))?.id).toBe(
      fixture.duplicateId,
    );
    expect(
      (await SuperTokens.getUser(appleInternalId))?.loginMethods,
    ).toHaveLength(1);

    const session = await migrate(fixture.tokenA, fixture.canonicalId);

    expect(telemetryEvents).toContainEqual(expect.objectContaining({
      reason: "account_link_completed",
      recipeId: "thirdparty",
      recipeUserId: googleInternalId,
    }));

    expect(session.getUserId()).toBe(fixture.canonicalId);
    await expectCanonicalMapping(fixture.canonicalId, appleInternalId);
    const user = await SuperTokens.getUser(fixture.canonicalId);
    expect(user?.isPrimaryUser).toBe(true);
    expect(user?.loginMethods).toHaveLength(2);
    expect(user?.loginMethods).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          thirdParty: { id: "apple", userId: appleId },
        }),
        expect.objectContaining({
          thirdParty: { id: "google", userId: fixture.googleId },
        }),
      ]),
    );
    // Looking up the original recipe ID detects deletion and recreation during repair.
    await expect(SuperTokens.getUser(googleInternalId)).resolves.toMatchObject({
      id: fixture.canonicalId,
    });
    await expectRejectedMigration(await requestMigration(fixture.tokenB));
    await migrate(fixture.tokenA, fixture.canonicalId);
    await expectCanonicalMapping(fixture.canonicalId, appleInternalId);
  });

  it("elects one token identity during concurrent A and B migrations and rejects the other without ping-pong", async () => {
    const fixture = duplicateProfiles();
    const internalId = await createMappedProvider(
      "google",
      fixture.googleId,
      fixture.duplicateId,
    );

    const responses = await Promise.all([
      requestMigration(fixture.tokenA),
      requestMigration(fixture.tokenB),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 400,
    ]);
    const winnerIndex = responses.findIndex(
      (response) => response.status === 200,
    );
    const loserIndex = 1 - winnerIndex;
    const identities = [fixture.canonicalId, fixture.duplicateId];
    const tokens = [fixture.tokenA, fixture.tokenB];
    const canonicalId = identities[winnerIndex];
    await expectSuccessfulMigration(responses[winnerIndex], canonicalId);
    await expectRejectedMigration(responses[loserIndex]);
    await expectCanonicalMapping(canonicalId, internalId);
    for (let attempt = 0; attempt < 2; attempt++) {
      await expectRejectedMigration(await requestMigration(tokens[loserIndex]));
      await migrate(tokens[winnerIndex], canonicalId);
      await expectCanonicalMapping(canonicalId, internalId);
    }
    await expect(
      SuperTokens.listUsersByAccountInfo(
        "public",
        { thirdParty: { id: "google", userId: fixture.googleId } },
        false,
      ),
    ).resolves.toEqual([expect.objectContaining({ id: canonicalId })]);
  });

  it.each(["A", "B"] as const)(
    "rejects an in-flight token %s after the other token completes reconciliation",
    async (pausedToken) => {
      const fixture = duplicateProfiles();
      const internalId = await createMappedProvider(
        "google",
        fixture.googleId,
        fixture.duplicateId,
      );
      const pausedId =
        pausedToken === "A" ? fixture.canonicalId : fixture.duplicateId;
      const winnerId =
        pausedToken === "A" ? fixture.duplicateId : fixture.canonicalId;
      const loserToken = pausedToken === "A" ? fixture.tokenA : fixture.tokenB;
      const winnerToken = pausedToken === "A" ? fixture.tokenB : fixture.tokenA;
      let releaseProfile!: () => void;
      const profileGate = new Promise<void>((resolve) => {
        releaseProfile = resolve;
      });
      let profilePaused = false;
      mockRowndClient.fetchUserInfo.mockImplementation(
        async ({ user_id }: { user_id: string }) => {
          const profile = fixture.profiles.get(user_id);
          if (user_id === pausedId && !profilePaused) {
            profilePaused = true;
            await profileGate;
          }
          return profile;
        },
      );

      // Pause one already-validated request at external I/O while its competitor commits.
      const pendingLoser = requestMigration(loserToken);
      try {
        await vi.waitFor(() => expect(profilePaused).toBe(true));
        await migrate(winnerToken, winnerId);
      } finally {
        releaseProfile();
      }
      await expectRejectedMigration(await pendingLoser);

      await expectCanonicalMapping(winnerId, internalId);
      await expect(SuperTokens.getUser(internalId)).resolves.toMatchObject({
        id: winnerId,
      });
      await expectRejectedMigration(await requestMigration(loserToken));
      await migrate(winnerToken, winnerId);
      await expectCanonicalMapping(winnerId, internalId);
    },
  );

  it.each([
    ["normal", "duplicate proof"],
    ["normal", "reservation write"],
    ["normal", "retirement write"],
    ["duplicate", "duplicate proof"],
    ["duplicate", "reservation write"],
    ["duplicate", "retirement write"],
  ] as const)(
    "preserves canonical B after stale A resumes at %s migration / %s",
    async (winnerPath, pausePoint) => {
      const fixture = duplicateProfiles();
      const retiredId = winnerPath === "normal" ? fixture.duplicateId : `rownd-c-${randomUUID()}`;
      if (winnerPath === "duplicate") {
        fixture.profiles.set(retiredId, {
          data: { user_id: retiredId, google_id: fixture.googleId },
        });
      }
      const internalId = await createMappedProvider("google", fixture.googleId, retiredId);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let paused = false;
      let sourceReads = 0;
      mockRowndClient.fetchUserInfo.mockImplementation(async ({ user_id }: { user_id: string }) => {
        if (user_id === fixture.canonicalId) sourceReads++;
        if (pausePoint === "duplicate proof" && user_id === fixture.canonicalId && sourceReads === 2) {
          paused = true;
          await gate;
        }
        return fixture.profiles.get(user_id);
      });
      const updateMetadata = UserMetadata.updateUserMetadata.bind(UserMetadata);
      const metadataWrites = vi.spyOn(UserMetadata, "updateUserMetadata").mockImplementation(async (id, update, context) => {
        const retirement = update.rownd_migration_superseded as { rowndUserId?: string } | undefined;
        const isReservation = pausePoint === "reservation write" && id === fixture.canonicalId &&
          update.rownd_migration_target === internalId;
        const isRetirement = pausePoint === "retirement write" && id === retiredId &&
          retirement?.rowndUserId === fixture.canonicalId;
        if (!paused && (isReservation || isRetirement)) {
          paused = true;
          await gate;
        }
        return updateMetadata(id, update, context);
      });
      const deleteMapping = vi.spyOn(SuperTokens, "deleteUserIdMapping");
      const pendingA = requestMigration(fixture.tokenA);
      try {
        await vi.waitFor(() => expect(paused).toBe(true));
        await migrate(fixture.tokenB, fixture.duplicateId);
        await expectCanonicalMapping(fixture.duplicateId, internalId);
      } finally {
        release();
      }
      await expectRejectedMigration(await pendingA);
      await expectCanonicalMapping(fixture.duplicateId, internalId);
      expect(deleteMapping).toHaveBeenCalledTimes(winnerPath === "normal" ? 0 : 1);
      metadataWrites.mockRestore();
      deleteMapping.mockRestore();
      if (winnerPath === "normal" && pausePoint === "retirement write") {
        await expect(UserMetadata.getUserMetadata(fixture.duplicateId)).resolves.toMatchObject({
          metadata: { rownd_migration_superseded: { rowndUserId: fixture.canonicalId } },
        });
      }

      await stopServer();
      resetST();
      await startServer();
      for (let attempt = 0; attempt < 2; attempt++) {
        await migrate(fixture.tokenB, fixture.duplicateId);
        await expectRejectedMigration(await requestMigration(fixture.tokenA));
        await expectCanonicalMapping(fixture.duplicateId, internalId);
      }
      if (winnerPath === "duplicate") {
        mockRowndClient.validateToken.mockResolvedValueOnce({ user_id: retiredId });
        await expectRejectedMigration(await requestMigration("retired-token"));
      }
    },
  );

  it("allows the accepted login race after A passes retirement checks, with A's session bound to its final mapping", async () => {
    const fixture = duplicateProfiles();
    const internalId = await createMappedProvider(
      "google",
      fixture.googleId,
      fixture.duplicateId,
    );
    const initialMetadata = await UserMetadata.getUserMetadata(fixture.duplicateId);
    expect(initialMetadata.metadata).not.toHaveProperty("rownd_migration_canonical_target");
    await expectCanonicalMapping(fixture.duplicateId, internalId);

    let releasePublication!: () => void;
    const publicationGate = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    let releaseDeletion!: () => void;
    const deletionGate = new Promise<void>((resolve) => {
      releaseDeletion = resolve;
    });
    let publicationPaused = false;
    let deletionPaused = false;
    const updateMetadata = UserMetadata.updateUserMetadata.bind(UserMetadata);
    const metadataWrites = vi.spyOn(UserMetadata, "updateUserMetadata")
      .mockImplementation(async (id, update, context) => {
        if (!publicationPaused && id === fixture.duplicateId &&
            update.rownd_migration_canonical_target === internalId) {
          publicationPaused = true;
          await publicationGate;
        }
        return updateMetadata(id, update, context);
      });
    const deleteMapping = SuperTokens.deleteUserIdMapping.bind(SuperTokens);
    const mappingDeletions = vi.spyOn(SuperTokens, "deleteUserIdMapping")
      .mockImplementation(async (input) => {
        if (!deletionPaused && input.userId === fixture.duplicateId &&
            input.userIdType === "EXTERNAL") {
          deletionPaused = true;
          await deletionGate;
        }
        return deleteMapping(input);
      });

    const pendingB = requestMigration(fixture.tokenB);
    let pendingA: Promise<Response> | undefined;
    try {
      await vi.waitFor(() => expect(publicationPaused).toBe(true), { timeout: 5000 });
      pendingA = requestMigration(fixture.tokenA);
      await vi.waitFor(() => expect(deletionPaused).toBe(true), { timeout: 5000 });

      // B publishes real credentials after A's last checks, but before A's real deletion.
      releasePublication();
      await expectSuccessfulMigration(await pendingB, fixture.duplicateId);
      await expectCanonicalMapping(fixture.duplicateId, internalId);
      releaseDeletion();
      const responseA = await pendingA;

      await expectSuccessfulMigration(responseA, fixture.canonicalId);
      await expect(SuperTokens.getUserIdMapping({
        userId: fixture.duplicateId,
        userIdType: "EXTERNAL",
      })).resolves.toEqual({ status: "UNKNOWN_MAPPING_ERROR" });
      await expectCanonicalMapping(fixture.canonicalId, internalId);
      await expect(SuperTokens.getUser(internalId)).resolves.toMatchObject({
        id: fixture.canonicalId,
      });
      await expectRejectedMigration(await requestMigration(fixture.tokenB));
    } finally {
      releasePublication();
      releaseDeletion();
      await Promise.allSettled(pendingA ? [pendingA, pendingB] : [pendingB]);
      metadataWrites.mockRestore();
      mappingDeletions.mockRestore();
    }
  }, 20000);

  it("rejects an unrelated external owner without replacing its mapping or provider account", async () => {
    const fixture = duplicateProfiles();
    const unrelatedProfile = fixture.profiles.get(fixture.duplicateId)!;
    unrelatedProfile.data.google_id = `unrelated-google-${randomUUID()}`;
    const internalId = await createMappedProvider(
      "google",
      fixture.googleId,
      fixture.duplicateId,
    );
    const ownerBefore = (
      await SuperTokens.getUser(fixture.duplicateId)
    )?.toJson();
    expect(ownerBefore).toBeDefined();

    await expectRejectedMigration(await requestMigration(fixture.tokenA));

    await expectCanonicalMapping(fixture.duplicateId, internalId);
    const ownerAfter = await SuperTokens.getUser(fixture.duplicateId);
    expect(ownerAfter?.toJson()).toEqual(ownerBefore);
    await expect(
      SuperTokens.getUserIdMapping({
        userId: fixture.canonicalId,
        userIdType: "EXTERNAL",
      }),
    ).resolves.toEqual({ status: "UNKNOWN_MAPPING_ERROR" });
  });

  it("resumes token A after metadata storage fails following a committed link without recreating either provider", async () => {
    const appleId = `apple-${randomUUID()}`;
    const fixture = duplicateProfiles(appleId);
    const appleInternalId = await createMappedProvider(
      "apple",
      appleId,
      fixture.canonicalId,
    );
    const googleInternalId = await createMappedProvider(
      "google",
      fixture.googleId,
      fixture.duplicateId,
    );
    expect((await SuperTokens.getUser(googleInternalId))?.id).toBe(
      fixture.duplicateId,
    );
    expect(
      (await SuperTokens.getUser(appleInternalId))?.loginMethods,
    ).toHaveLength(1);
    let linkCommitted = false;
    onLinkCommitted = () => {
      linkCommitted = true;
    };
    let metadataFailed = false;
    rejectMetadataWrites = () => {
      metadataFailed ||= linkCommitted;
      return linkCommitted;
    };

    const interruptedResponse = await requestMigration(fixture.tokenA);
    expect({ linkCommitted, metadataFailed }).toEqual({
      linkCommitted: true,
      metadataFailed: true,
    });
    await expectRejectedMigration(interruptedResponse);
    onLinkCommitted = () => {};
    rejectMetadataWrites = () => false;
    await stopServer();
    resetST();
    await startServer();
    await migrate(fixture.tokenA, fixture.canonicalId);

    await expectCanonicalMapping(fixture.canonicalId, appleInternalId);
    const user = await SuperTokens.getUser(fixture.canonicalId);
    expect(user?.loginMethods).toHaveLength(2);
    await expect(SuperTokens.getUser(googleInternalId)).resolves.toMatchObject({
      id: fixture.canonicalId,
    });
    await expectRejectedMigration(await requestMigration(fixture.tokenB));
    await migrate(fixture.tokenA, fixture.canonicalId);
    await expectCanonicalMapping(fixture.canonicalId, appleInternalId);
  });

  it("resumes token A after a lost mapping-deletion response while keeping duplicate token B rejected", async () => {
    const fixture = duplicateProfiles();
    const internalId = await createMappedProvider(
      "google",
      fixture.googleId,
      fixture.duplicateId,
    );
    const deleteMapping = SuperTokens.deleteUserIdMapping.bind(SuperTokens);
    const createMapping = SuperTokens.createUserIdMapping.bind(SuperTokens);
    let deletionCommitted = false;
    const unavailableMappingCreation = vi
      .spyOn(SuperTokens, "createUserIdMapping")
      .mockImplementation(async (...args) => {
        if (deletionCommitted) {
          throw new Error("Simulated mapping service outage after deletion");
        }
        return createMapping(...args);
      });
    const interruptedDeletion = vi
      .spyOn(SuperTokens, "deleteUserIdMapping")
      .mockImplementationOnce(async (...args) => {
        const result = await deleteMapping(...args);
        if (result.status !== "OK") {
          throw new Error("Fixture could not delete the duplicate mapping");
        }
        deletionCommitted = true;
        throw new Error(
          "Simulated lost response after Core deleted the duplicate mapping",
        );
      });

    await expectRejectedMigration(await requestMigration(fixture.tokenA));
    expect(
      deletionCommitted,
      "The fault must follow real Core mapping deletion",
    ).toBe(true);
    interruptedDeletion.mockRestore();
    unavailableMappingCreation.mockRestore();
    await expect(
      SuperTokens.getUserIdMapping({
        userId: fixture.duplicateId,
        userIdType: "EXTERNAL",
      }),
    ).resolves.toEqual({ status: "UNKNOWN_MAPPING_ERROR" });
    await stopServer();
    resetST();
    await startServer();

    await expectRejectedMigration(await requestMigration(fixture.tokenB));
    await migrate(fixture.tokenA, fixture.canonicalId);
    await expectCanonicalMapping(fixture.canonicalId, internalId);
    await expect(SuperTokens.getUser(internalId)).resolves.toMatchObject({
      id: fixture.canonicalId,
    });
    await expectRejectedMigration(await requestMigration(fixture.tokenB));
    await migrate(fixture.tokenA, fixture.canonicalId);
    await expectCanonicalMapping(fixture.canonicalId, internalId);
  });

  async function seedPhoneOwner(completed = false, phoneTenantId = "public") {
    const fixture = duplicateProfiles();
    const phoneNumber = `+1806${randomInt(1000000, 10000000)}`;
    const oldPhoneNumber = `+1986${randomInt(1000000, 10000000)}`;
    const profile = fixture.profiles.get(fixture.canonicalId)!;
    profile.data.phone_number = phoneNumber;
    profile.verified_data = { phone_number: oldPhoneNumber };
    const googleInternalId = await createMappedProvider("google", fixture.googleId, fixture.canonicalId);
    await AccountLinking.createPrimaryUser(SuperTokens.convertToRecipeUserId(googleInternalId));
    if (completed) {
      await UserMetadata.updateUserMetadata(googleInternalId, {
        rownd_migration_complete: true,
        original_rownd_user: { data: { user_id: fixture.canonicalId, google_id: fixture.googleId } },
      });
    }
    const phone = await Passwordless.signInUp({
      tenantId: phoneTenantId, phoneNumber,
      userContext: { rowndDisableAutomaticAccountLinking: true },
    });
    const phoneInternalId = phone.recipeUserId.getAsString();
    await UserMetadata.updateUserMetadata(phoneInternalId, { phonePreference: "keep" });
    return { ...fixture, phoneNumber, oldPhoneNumber, googleInternalId, phoneInternalId };
  }

  it.each([
    { verification: "stale", completed: true },
    { verification: "missing", completed: true },
    { verification: "stale", completed: false },
  ])("reconciles current-profile phone only while migration is incomplete ($verification verified_data, completed=$completed)", async ({ verification, completed }) => {
    const fixture = await seedPhoneOwner(completed);
    if (verification === "missing") delete fixture.profiles.get(fixture.canonicalId)!.verified_data!.phone_number;
    const googleBefore = (await SuperTokens.getUser(fixture.googleInternalId))!.loginMethods[0]!.toJson();
    const phoneBefore = (await SuperTokens.getUser(fixture.phoneInternalId))!.loginMethods[0]!.toJson();
    expect(phoneBefore.verified).toBe(true);
    const deleteMapping = vi.spyOn(SuperTokens, "deleteUserIdMapping");

    await migrate(fixture.tokenA, fixture.canonicalId);

    await expectCanonicalMapping(fixture.canonicalId, fixture.googleInternalId);
    const user = await SuperTokens.getUser(fixture.canonicalId);
    expect(user?.isPrimaryUser).toBe(true);
    expect(user?.loginMethods.map((method) => method.toJson())).toEqual(expect.arrayContaining(completed ? [googleBefore] : [googleBefore, phoneBefore]));
    expect(user?.loginMethods).toHaveLength(completed ? 1 : 2);
    await expect(SuperTokens.getUser(fixture.phoneInternalId)).resolves.toMatchObject({ id: completed ? fixture.phoneInternalId : fixture.canonicalId });
    await expect(UserMetadata.getUserMetadata(fixture.phoneInternalId)).resolves.toMatchObject({ metadata: { phonePreference: "keep" } });
    expect(deleteMapping).not.toHaveBeenCalled();
    await migrate(fixture.tokenA, fixture.canonicalId);
    expect((await SuperTokens.getUser(fixture.canonicalId))?.loginMethods).toHaveLength(completed ? 1 : 2);
  });

  it.each([
    "foreign primary", "mapped phone", "fresh changed phone", "fresh wrong ID",
    "fresh absent", "fresh 404", "fresh 500", "fresh timeout",
  ])("rejects current-profile phone reconciliation before mutation for %s", async (failure) => {
    const fixture = await seedPhoneOwner();
    if (failure === "foreign primary") {
      await AccountLinking.createPrimaryUser(SuperTokens.convertToRecipeUserId(fixture.phoneInternalId));
    } else if (failure === "mapped phone") {
      await SuperTokens.createUserIdMapping({
        superTokensUserId: fixture.phoneInternalId, externalUserId: fixture.duplicateId, force: true,
      });
      fixture.profiles.get(fixture.duplicateId)!.data.phone_number = fixture.phoneNumber;
    } else {
      let sourceReads = 0;
      mockRowndClient.fetchUserInfo.mockImplementation(async ({ user_id }: { user_id: string }) => {
        if (user_id !== fixture.canonicalId || ++sourceReads === 1) return fixture.profiles.get(user_id);
        if (failure === "fresh absent") return undefined;
        if (failure === "fresh 404") throw rowndHTTPError(404);
        if (failure === "fresh 500") throw rowndHTTPError(500);
        if (failure === "fresh timeout") throw new Error("Request timed out");
        const profile = structuredClone(fixture.profiles.get(user_id)!);
        if (failure === "fresh wrong ID") profile.data.user_id = fixture.duplicateId;
        if (failure === "fresh changed phone") profile.data.phone_number = fixture.oldPhoneNumber;
        return profile;
      });
    }
    const snapshot = () => Promise.all([
      fixture.googleInternalId, fixture.phoneInternalId, fixture.canonicalId, fixture.duplicateId,
    ].map(async (id) => ({
      user: (await SuperTokens.getUser(id))?.toJson(),
      metadata: await UserMetadata.getUserMetadata(id),
      mapping: await SuperTokens.getUserIdMapping({ userId: id }),
    })));
    const before = await snapshot();
    const mutations = [
      vi.spyOn(SuperTokens, "createUserIdMapping"),
      vi.spyOn(SuperTokens, "deleteUserIdMapping"),
      vi.spyOn(AccountLinking, "createPrimaryUser"),
      vi.spyOn(AccountLinking, "linkAccounts"),
      vi.spyOn(UserMetadata, "updateUserMetadata"),
      vi.spyOn(Passwordless, "signInUp"),
    ];

    await expectRejectedMigration(await requestMigration(fixture.tokenA));

    for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });

  it.each(["old verified phone", "other tenant"])("excludes %s owner from current-profile phone linking", async (excludedOwner) => {
    const tenantId = excludedOwner === "other tenant" ? `tenant-${randomUUID()}` : "public";
    if (tenantId !== "public") {
      await expect(Multitenancy.createOrUpdateTenant(tenantId, { firstFactors: ["otp-phone"] }))
        .resolves.toMatchObject({ status: "OK" });
    }
    const fixture = await seedPhoneOwner(false, tenantId);
    if (excludedOwner === "old verified phone") {
      const profile = fixture.profiles.get(fixture.canonicalId)!;
      profile.data.phone_number = fixture.oldPhoneNumber;
      profile.verified_data!.phone_number = fixture.phoneNumber;
    }
    const ownerBefore = (await SuperTokens.getUser(fixture.phoneInternalId))?.toJson();
    const linking = vi.spyOn(AccountLinking, "linkAccounts");

    await migrate(fixture.tokenA, fixture.canonicalId);

    expect((await SuperTokens.getUser(fixture.phoneInternalId))?.toJson()).toEqual(ownerBefore);
    expect(linking.mock.calls.some(([id]) => id.getAsString() === fixture.phoneInternalId)).toBe(false);
    const user = await SuperTokens.getUser(fixture.canonicalId);
    expect(user?.loginMethods).toHaveLength(2);
    expect(user?.loginMethods.find((method) => method.recipeId === "passwordless"))
      .toMatchObject({ phoneNumber: fixture.profiles.get(fixture.canonicalId)!.data.phone_number, tenantIds: ["public"] });
  });

  it("reconciles an exact standalone Google provider into canonical phone-only A", async () => {
    const fixture = duplicateProfiles();
    const phoneNumber = `+1806${randomInt(1000000, 10000000)}`;
    fixture.profiles.get(fixture.canonicalId)!.data.phone_number = phoneNumber;
    const phone = await Passwordless.signInUp({ tenantId: "public", phoneNumber });
    const phoneInternalId = phone.recipeUserId.getAsString();
    await SuperTokens.createUserIdMapping({ superTokensUserId: phoneInternalId, externalUserId: fixture.canonicalId });
    await AccountLinking.createPrimaryUser(phone.recipeUserId);
    await UserMetadata.updateUserMetadata(phoneInternalId, {
      rownd_migration_complete: false,
      original_rownd_user: { data: { user_id: fixture.canonicalId, phone_number: phoneNumber } },
    });
    const google = await ThirdParty.manuallyCreateOrUpdateUser(
      "public", "google", fixture.googleId, `${randomUUID()}@example.com`, true,
      undefined, { rowndDisableAutomaticAccountLinking: true },
    );
    if (google.status !== "OK") throw new Error("Could not seed standalone Google owner");
    const phoneBefore = (await SuperTokens.getUser(phoneInternalId))!.loginMethods[0]!.toJson();
    const googleBefore = google.user.loginMethods[0]!.toJson();

    await migrate(fixture.tokenA, fixture.canonicalId);

    await expectCanonicalMapping(fixture.canonicalId, phoneInternalId);
    const user = await SuperTokens.getUser(fixture.canonicalId);
    expect(user?.loginMethods.map((method) => method.toJson())).toEqual(expect.arrayContaining([phoneBefore, googleBefore]));
    expect(user?.loginMethods).toHaveLength(2);
    await expect(SuperTokens.getUser(google.recipeUserId.getAsString())).resolves.toMatchObject({ id: fixture.canonicalId });
  });

  async function seedCanonicalPhone(completed = false) {
    const fixture = duplicateProfiles();
    const phoneNumber = `+1639${randomInt(1000000, 10000000)}`;
    const email = `${randomUUID()}@example.com`;
    const profile = fixture.profiles.get(fixture.canonicalId)!;
    profile.data = { user_id: fixture.canonicalId, email, phone_number: phoneNumber };
    profile.verified_data = { email, phone_number: phoneNumber };
    const phone = await Passwordless.signInUp({ tenantId: "public", phoneNumber });
    const phoneInternalId = phone.recipeUserId.getAsString();
    await SuperTokens.createUserIdMapping({ superTokensUserId: phoneInternalId, externalUserId: fixture.canonicalId });
    if (completed) {
      await UserMetadata.updateUserMetadata(phoneInternalId, {
        rownd_migration_complete: true,
        original_rownd_user: { data: { user_id: fixture.canonicalId, phone_number: phoneNumber } },
      });
    }
    return { ...fixture, phoneInternalId, phoneNumber, email, profile };
  }

  it.each([true, false])("links verified email into phone-only A only before completion (completed=%s)", async (completed) => {
    const fixture = await seedCanonicalPhone(completed);
    const email = await Passwordless.signInUp({ tenantId: "public", email: fixture.email });
    const emailInternalId = email.recipeUserId.getAsString();
    const phoneBefore = (await SuperTokens.getUser(fixture.phoneInternalId))!.loginMethods[0]!.toJson();
    const emailBefore = email.user.loginMethods[0]!.toJson();
    expect((await SuperTokens.getUser(fixture.canonicalId))?.isPrimaryUser).toBe(false);
    const deleteMapping = vi.spyOn(SuperTokens, "deleteUserIdMapping");

    await migrate(fixture.tokenA, fixture.canonicalId);

    await expectCanonicalMapping(fixture.canonicalId, fixture.phoneInternalId);
    const user = await SuperTokens.getUser(fixture.canonicalId);
    expect(user?.isPrimaryUser).toBe(!completed);
    expect(user?.loginMethods).toHaveLength(completed ? 1 : 2);
    expect(user?.loginMethods.map((method) => method.toJson())).toEqual(expect.arrayContaining(completed ? [phoneBefore] : [phoneBefore, emailBefore]));
    await expect(SuperTokens.getUser(emailInternalId)).resolves.toMatchObject({ id: completed ? emailInternalId : fixture.canonicalId });
    expect(deleteMapping).not.toHaveBeenCalled();
    await migrate(fixture.tokenA, fixture.canonicalId);
    expect((await SuperTokens.getUser(fixture.canonicalId))?.loginMethods).toHaveLength(completed ? 1 : 2);
  });

  it("creates an absent verified email method under canonical phone-only A", async () => {
    const fixture = await seedCanonicalPhone();
    const phoneBefore = (await SuperTokens.getUser(fixture.phoneInternalId))!.loginMethods[0]!.toJson();

    await migrate(fixture.tokenA, fixture.canonicalId);

    await expectCanonicalMapping(fixture.canonicalId, fixture.phoneInternalId);
    const user = await SuperTokens.getUser(fixture.canonicalId);
    expect(user?.loginMethods).toHaveLength(2);
    expect(user?.loginMethods.map((method) => method.toJson())).toContainEqual(phoneBefore);
    expect(user?.loginMethods.find((method) => method.email === fixture.email))
      .toMatchObject({ recipeId: "passwordless", verified: true, tenantIds: ["public"] });
  });

  it.each(["unverified email", "mismatched phone anchor", "fresh unverified email"])(
    "links an authenticated email into mapped phone A despite %s, preserving its existing phone",
    async (scenario) => {
      const fixture = await seedCanonicalPhone();
      const email = await Passwordless.signInUp({ tenantId: "public", email: fixture.email });
      const oldPhone = (await SuperTokens.getUser(fixture.phoneInternalId))!.loginMethods[0]!.toJson();
      if (scenario === "unverified email") delete fixture.profile.verified_data.email;
      if (scenario === "mismatched phone anchor") fixture.profile.data.phone_number = `+1986${randomInt(1000000, 10000000)}`;
      if (scenario === "fresh unverified email") {
        let reads = 0;
        mockRowndClient.fetchUserInfo.mockImplementation(async ({ user_id }: { user_id: string }) => {
          const profile = fixture.profiles.get(user_id);
          if (!profile || user_id !== fixture.canonicalId || ++reads === 1) return profile;
          const fresh = structuredClone(profile);
          delete fresh.verified_data.email;
          return fresh;
        });
      }
      // The existing Rownd mapping anchors A; email ownership no longer depends
      // on using the old phone as proof. Neither old phone nor target ID is replaced.
      await migrate(fixture.tokenA, fixture.canonicalId);
      await expectCanonicalMapping(fixture.canonicalId, fixture.phoneInternalId);
      const user = (await SuperTokens.getUser(fixture.canonicalId))!;
      expect(user.loginMethods.map((method) => method.toJson())).toContainEqual(oldPhone);
      expect(user.loginMethods.find((method) => method.email === fixture.email)).toMatchObject({ recipeId: "passwordless", verified: true });
      expect(user.loginMethods.find((method) => method.email === fixture.email)!.recipeUserId.getAsString()).toBe(email.recipeUserId.getAsString());
      expect(user.loginMethods).toHaveLength(scenario === "mismatched phone anchor" ? 3 : 2);
      await migrate(fixture.tokenA, fixture.canonicalId);
      expect((await SuperTokens.getUser(fixture.canonicalId))!.toJson()).toEqual(user.toJson());
    },
  );

  it.each([
    "foreign primary", "mapped email",
    "fresh wrong ID", "fresh changed phone", "fresh changed email", "fresh absent",
  ])("rejects phone-anchored email linking before mutation for %s", async (failure) => {
    const fixture = await seedCanonicalPhone();
    const email = await Passwordless.signInUp({ tenantId: "public", email: fixture.email });
    const emailInternalId = email.recipeUserId.getAsString();
    if (failure === "foreign primary") await AccountLinking.createPrimaryUser(email.recipeUserId);
    if (failure === "mapped email") {
      await SuperTokens.createUserIdMapping({ superTokensUserId: emailInternalId, externalUserId: fixture.duplicateId });
    }
    if (failure.startsWith("fresh")) {
      let sourceReads = 0;
      mockRowndClient.fetchUserInfo.mockImplementation(async ({ user_id }: { user_id: string }) => {
        if (user_id !== fixture.canonicalId || ++sourceReads === 1) return fixture.profiles.get(user_id);
        if (failure === "fresh absent") return undefined;
        const profile = structuredClone(fixture.profile);
        if (failure === "fresh wrong ID") profile.data.user_id = fixture.duplicateId;
        if (failure === "fresh changed phone") profile.data.phone_number = "+19862058624";
        if (failure === "fresh changed email") profile.data.email = "other@example.com";
        return profile;
      });
    }
    const snapshot = () => Promise.all([
      fixture.phoneInternalId, emailInternalId, fixture.canonicalId, fixture.duplicateId,
    ].map(async (id) => ({
      user: (await SuperTokens.getUser(id))?.toJson(),
      metadata: await UserMetadata.getUserMetadata(id),
      mapping: await SuperTokens.getUserIdMapping({ userId: id }),
    })));
    const before = await snapshot();
    const mutations = [
      vi.spyOn(SuperTokens, "createUserIdMapping"),
      vi.spyOn(SuperTokens, "deleteUserIdMapping"),
      vi.spyOn(AccountLinking, "createPrimaryUser"),
      vi.spyOn(AccountLinking, "linkAccounts"),
      vi.spyOn(UserMetadata, "updateUserMetadata"),
      vi.spyOn(Passwordless, "signInUp"),
    ];

    await expectRejectedMigration(await requestMigration(fixture.tokenA));

    for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });

  it("excludes another tenant's email owner from phone-anchored email linking", async () => {
    const fixture = await seedCanonicalPhone();
    const tenantId = `tenant-${randomUUID()}`;
    await Multitenancy.createOrUpdateTenant(tenantId, { firstFactors: ["link-email"] });
    const email = await Passwordless.signInUp({ tenantId, email: fixture.email });
    const ownerBefore = email.user.toJson();

    await migrate(fixture.tokenA, fixture.canonicalId);

    expect((await SuperTokens.getUser(email.recipeUserId.getAsString()))?.toJson()).toEqual(ownerBefore);
    const user = await SuperTokens.getUser(fixture.canonicalId);
    expect(user?.loginMethods).toHaveLength(2);
    expect(user?.loginMethods.find((method) => method.email === fixture.email)).toMatchObject({ tenantIds: ["public"] });
  });

  async function seedMixedOwners() {
    const appleId = `apple-${randomUUID()}`;
    const fixture = duplicateProfiles(appleId);
    const appleInternalId = await createMappedProvider("apple", appleId, fixture.canonicalId);
    const google = await ThirdParty.manuallyCreateOrUpdateUser(
      "public", "google", fixture.googleId, `${randomUUID()}@example.com`, true,
      undefined, { rowndDisableAutomaticAccountLinking: true },
    );
    if (google.status !== "OK") throw new Error("Could not seed standalone Google owner");
    const email = `${randomUUID()}@example.com`;
    const passwordless = await Passwordless.signInUp({
      tenantId: "public", email,
      userContext: { rowndDisableAutomaticAccountLinking: true },
    });
    const profile = fixture.profiles.get(fixture.canonicalId)!;
    profile.data.email = email;
    profile.verified_data = { ...profile.verified_data, email };
    const recipeIds = [appleInternalId, google.recipeUserId.getAsString(), passwordless.recipeUserId.getAsString()];
    for (const [index, id] of recipeIds.entries()) {
      await UserMetadata.updateUserMetadata(id, { [`ownerPreference${index}`]: "keep" });
    }
    return { ...fixture, appleInternalId, google, passwordless, email, recipeIds };
  }

  it("reconciles mixed standalone Google and verified Passwordless owners under mapped Apple A", async () => {
    const fixture = await seedMixedOwners();
    for (const id of fixture.recipeIds.slice(1)) {
      await expect(SuperTokens.getUserIdMapping({ userId: id, userIdType: "SUPERTOKENS" }))
        .resolves.toEqual({ status: "UNKNOWN_MAPPING_ERROR" });
      expect((await SuperTokens.getUser(id))?.isPrimaryUser).toBe(false);
    }

    await migrate(fixture.tokenA, fixture.canonicalId);

    await expectCanonicalMapping(fixture.canonicalId, fixture.appleInternalId);
    const user = await SuperTokens.getUser(fixture.canonicalId);
    expect(user?.isPrimaryUser).toBe(true);
    expect(user?.loginMethods).toHaveLength(3);
    expect(user?.loginMethods.every((method) => method.tenantIds.includes("public"))).toBe(true);
    expect(user?.loginMethods.map((method) => method.recipeUserId.getAsString()).sort())
      .toEqual([fixture.canonicalId, ...fixture.recipeIds.slice(1)].sort());
    for (const [index, id] of fixture.recipeIds.entries()) {
      await expect(SuperTokens.getUser(id)).resolves.toMatchObject({ id: fixture.canonicalId });
      await expect(UserMetadata.getUserMetadata(id)).resolves.toMatchObject({
        metadata: { [`ownerPreference${index}`]: "keep" },
      });
    }
    await expect(UserMetadata.getUserMetadata(fixture.appleInternalId)).resolves.toMatchObject({
      metadata: {
        rownd_migration_complete: true,
        original_rownd_user: { data: { user_id: fixture.canonicalId, email: fixture.email } },
      },
    });
    await migrate(fixture.tokenA, fixture.canonicalId);
    expect((await SuperTokens.getUser(fixture.canonicalId))?.loginMethods).toHaveLength(3);
  });

  it("reconciles mixed exact provider and standalone contact owners with no Rownd email verification marker", async () => {
    const fixture = await seedMixedOwners();
    delete fixture.profiles.get(fixture.canonicalId)!.verified_data.email;
    await migrate(fixture.tokenA, fixture.canonicalId);
    await expectCanonicalMapping(fixture.canonicalId, fixture.appleInternalId);
    const user = (await SuperTokens.getUser(fixture.canonicalId))!;
    expect(user.loginMethods).toHaveLength(3);
    expect(user.loginMethods.map((method) => method.recipeUserId.getAsString()).sort()).toEqual([fixture.canonicalId, ...fixture.recipeIds.slice(1)].sort());
    expect(user.loginMethods.find((method) => method.recipeId === "passwordless")).toMatchObject({ email: fixture.email, verified: true });
    for (const [index, id] of fixture.recipeIds.entries()) {
      expect((await SuperTokens.getUser(id))!.id).toBe(fixture.canonicalId);
      expect((await UserMetadata.getUserMetadata(id)).metadata).toMatchObject({ [`ownerPreference${index}`]: "keep" });
    }
    await migrate(fixture.tokenA, fixture.canonicalId);
    expect((await SuperTokens.getUser(fixture.canonicalId))!.toJson()).toEqual(user.toJson());
  });

  it.each(["foreign primary", "unrelated provider"] as const)(
    "rejects mixed owners before any mutation when one owner has %s",
    async (ineligibleOwner) => {
      const fixture = await seedMixedOwners();
      if (ineligibleOwner === "foreign primary") {
        await AccountLinking.createPrimaryUser(fixture.google.recipeUserId);
        await SuperTokens.createUserIdMapping({
          superTokensUserId: fixture.google.recipeUserId.getAsString(),
          externalUserId: fixture.duplicateId,
          force: true,
        });
      } else {
        const unrelated = await ThirdParty.manuallyCreateOrUpdateUser(
          "public", "google", randomUUID(), fixture.email, true,
          undefined, { rowndDisableAutomaticAccountLinking: true },
        );
        if (unrelated.status !== "OK") throw new Error("Could not seed unrelated provider");
        await AccountLinking.createPrimaryUser(unrelated.recipeUserId);
        fixture.recipeIds.push(unrelated.recipeUserId.getAsString());
      }
      const snapshot = async () => Promise.all(fixture.recipeIds.map(async (id) => ({
        user: (await SuperTokens.getUser(id))?.toJson(),
        metadata: await UserMetadata.getUserMetadata(id),
        mapping: await SuperTokens.getUserIdMapping({ userId: id, userIdType: "SUPERTOKENS" }),
      })));
      const before = await snapshot();
      const mutations = [
        vi.spyOn(SuperTokens, "createUserIdMapping"),
        vi.spyOn(SuperTokens, "deleteUserIdMapping"),
        vi.spyOn(AccountLinking, "createPrimaryUser"),
        vi.spyOn(AccountLinking, "linkAccounts"),
        vi.spyOn(UserMetadata, "updateUserMetadata"),
        vi.spyOn(ThirdParty, "manuallyCreateOrUpdateUser"),
        vi.spyOn(Passwordless, "signInUp"),
      ];

      await expectRejectedMigration(await requestMigration(fixture.tokenA));

      for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
      expect(await snapshot()).toEqual(before);
      await expectCanonicalMapping(fixture.canonicalId, fixture.appleInternalId);
    },
  );

  it.each(["target", "foreign"] as const)(
    "uses fresh %s ownership after an already-linked response during mixed reconciliation",
    async (freshOwner) => {
      const fixture = await seedMixedOwners();
      const foreignRowndId = `foreign-${randomUUID()}`;
      const foreignInternalId = await createMappedProvider("apple", randomUUID(), foreignRowndId);
      await AccountLinking.createPrimaryUser(SuperTokens.convertToRecipeUserId(foreignInternalId));
      const linkAccounts = AccountLinking.linkAccounts.bind(AccountLinking);
      const linking = vi.spyOn(AccountLinking, "linkAccounts").mockImplementationOnce(
        async (recipeUserId, primaryUserId, context) => {
          expect(recipeUserId.getAsString()).toBe(fixture.google.recipeUserId.getAsString());
          const result = await linkAccounts(
            recipeUserId, freshOwner === "target" ? primaryUserId : foreignInternalId, context,
          );
          expect(result.status).toBe("OK");
          // A sibling committed the link; the response's owner hint may now be stale.
          return {
            status: "RECIPE_USER_ID_ALREADY_LINKED_WITH_ANOTHER_PRIMARY_USER_ID_ERROR",
            primaryUserId: fixture.canonicalId,
          };
        },
      );

      const response = await requestMigration(fixture.tokenA);

      if (freshOwner === "target") {
        await expectSuccessfulMigration(response, fixture.canonicalId);
        expect((await SuperTokens.getUser(fixture.canonicalId))?.loginMethods).toHaveLength(3);
        await expect(SuperTokens.getUser(fixture.google.recipeUserId.getAsString()))
          .resolves.toMatchObject({ id: fixture.canonicalId });
      } else {
        await expectRejectedMigration(response);
        expect(linking).toHaveBeenCalledTimes(1);
        await expect(SuperTokens.getUser(fixture.google.recipeUserId.getAsString()))
          .resolves.toMatchObject({ id: foreignRowndId });
        await expect(SuperTokens.getUser(fixture.passwordless.recipeUserId.getAsString()))
          .resolves.toMatchObject({ id: fixture.passwordless.recipeUserId.getAsString(), isPrimaryUser: false });
        expect((await UserMetadata.getUserMetadata(fixture.appleInternalId)).metadata.rownd_migration_complete)
          .not.toBe(true);
        expect(telemetryEvents.some((event) => event.reason === "account_link_completed")).toBe(false);
      }
      await expectCanonicalMapping(fixture.canonicalId, fixture.appleInternalId);
      await expectCanonicalMapping(foreignRowndId, foreignInternalId);
    },
  );
});

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
import type { APIInterface as PasswordlessAPIInterface } from "supertokens-node/recipe/passwordless";
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
import {
  RowndPluginConfig,
  RowndPluginDynamicConfig,
  RowndTelemetryClient,
} from "./types";
import {
  ROWND_PLUGIN_ERROR_MESSAGES,
  RowndConfigResolutionError,
} from "./errors";
import {
  DEFAULT_ROWND_SCHEMA,
  NATIVE_EMAIL_VERIFICATION_UPGRADE_REQUIRED_MESSAGE,
  ROWND_JWT_CLAIMS,
} from "./constants";
import {
  buildRowndOAuthPayload,
  combineLinkedMetadata,
  doesRowndAccountInfoExist,
  mapRowndUserToSuperTokens,
  shouldLinkRowndAccounts,
} from "./rownd-compatibility";
import {
  DEFAULT_PRIMARY_COLOR,
  getPluginConfig,
  resolvePluginConfigSnapshot,
} from "./config";
import {
  RowndIsAnonymousClaim,
  buildRowndSessionAndAnonymousClaims,
  buildRowndSessionClaims,
  completePendingEmailVerification,
  createMissingLoginMethod,
  createRowndUserIdMapping,
  ensurePrimaryUser,
  reconcileRowndUserWithExistingLoginMethods,
  createMagicLinkWithConfirmationBypass,
  getUserById,
  prepareEmailForPasswordlessAuth,
  recordRowndAppVariantForUser,
  startPendingEmailVerification,
} from "./supertokens-repository";
import {
  associateUserLoginMethodsToTenant,
  handleGuestLogin,
  handleMigrate,
} from "./pluginImplementation";
import { setRowndClient } from "./rownd-repository";
import { createDerivedUserContext, resolveTenantId } from "./utils";

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

  async function createLinkedGuestSession(
    authenticatedRecipeUserId: Parameters<
      typeof AccountLinking.createPrimaryUser
    >[0],
  ) {
    const guestResult = await ThirdParty.manuallyCreateOrUpdateUser(
      "public",
      "guest",
      `guest-${randomUUID()}`,
      `guest-${randomUUID()}@anonymous.local`,
      false,
    );
    if (guestResult.status !== "OK") {
      throw new Error("failed to create guest user");
    }
    const session = await Session.createNewSessionWithoutRequestResponse(
      "public",
      guestResult.recipeUserId,
      {},
      {},
      true,
    );
    const anonymousId = session.getAccessTokenPayload().anonymous_id;
    if (typeof anonymousId !== "string") {
      throw new Error("guest session has no anonymous_id");
    }

    const primaryResult = await AccountLinking.createPrimaryUser(
      guestResult.recipeUserId,
    );
    if (primaryResult.status !== "OK") {
      throw new Error("failed to create primary user");
    }
    const linkResult = await AccountLinking.linkAccounts(
      authenticatedRecipeUserId,
      primaryResult.user.id,
      undefined,
    );
    if (linkResult.status !== "OK") {
      throw new Error("failed to link guest user");
    }

    return { session, anonymousId, linkedUser: linkResult.user };
  }

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
    const licenseResponse = await fetch(
      `${importCoreConnectionURI}/ee/license`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ licenseKey: ACCOUNT_LINKING_TEST_LICENSE }),
      },
    );
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

  describe("concurrent migration ID normalization", () => {
    it("isolates overlapping derived contexts and forwards cache replacement", async () => {
      const userContext = {
        requestId: "request-id",
        _default: { coreCallCache: { initial: true } },
      };
      const first = createDerivedUserContext(userContext, {
        rowndFlag: "first",
      });
      const second = createDerivedUserContext(userContext, {
        rowndFlag: "second",
      });

      await Promise.all([
        Promise.resolve().then(() => {
          expect(first.rowndFlag).toBe("first");
          expect(first.requestId).toBe("request-id");
        }),
        Promise.resolve().then(() => {
          expect(second.rowndFlag).toBe("second");
          expect(second.requestId).toBe("request-id");
        }),
      ]);

      first._default = { coreCallCache: { first: true } };
      expect(userContext._default).toBe(first._default);
      second._default = { coreCallCache: { second: true } };
      expect(userContext._default).toBe(second._default);
      expect(first._default).toBe(second._default);
      expect(userContext).not.toHaveProperty("rowndFlag");
    });

    it("adds own flags when the parent context is frozen", () => {
      const userContext = Object.freeze({ requestId: "frozen" });
      const derived = createDerivedUserContext(userContext, {
        rowndDisableAutomaticAccountLinking: true,
      });

      expect(Object.isExtensible(derived)).toBe(true);
      expect(derived).toHaveProperty(
        "rowndDisableAutomaticAccountLinking",
        true,
      );
      expect(derived.requestId).toBe("frozen");
      expect(() => {
        derived._default = { coreCallCache: {} };
      }).toThrow("Unable to update parent userContext._default");
    });

    it("defines security flags without invoking inherited setters", () => {
      const prototype = Object.create(null, {
        rowndDisableAutomaticAccountLinking: {
          configurable: true,
          set: vi.fn(),
        },
      });
      const userContext = Object.assign(Object.create(prototype), {
        requestId: "request-id",
      });

      const derived = createDerivedUserContext(userContext, {
        rowndDisableAutomaticAccountLinking: true,
      });

      expect(
        Object.prototype.hasOwnProperty.call(
          derived,
          "rowndDisableAutomaticAccountLinking",
        ),
      ).toBe(true);
      expect(derived.rowndDisableAutomaticAccountLinking).toBe(true);
      expect(
        Object.getOwnPropertyDescriptor(
          prototype,
          "rowndDisableAutomaticAccountLinking",
        )?.set,
      ).not.toHaveBeenCalled();
    });

    it("rejects deceptive parent cache assignment", () => {
      const initialDefault = { coreCallCache: { initial: true } };
      const userContext = new Proxy(
        { _default: initialDefault },
        {
          set: (_target, key) => key === "_default",
        },
      );
      const derived = createDerivedUserContext(userContext, {});

      expect(() => {
        derived._default = { coreCallCache: { replacement: true } };
      }).toThrow("Unable to update parent userContext._default");
      expect(userContext._default).toBe(initialDefault);
    });

    it("uses one user snapshot for session and anonymous claims", async () => {
      const userContext = { requestId: "claims" } as any;
      const getUser = vi.spyOn(SuperTokens, "getUser").mockResolvedValue({
        id: "user-id",
        loginMethods: [],
      } as any);
      vi.spyOn(SuperTokens, "getUserIdMapping").mockResolvedValue({
        status: "UNKNOWN_MAPPING_ERROR",
      });
      vi.spyOn(UserMetadata, "getUserMetadata").mockResolvedValue({
        status: "OK",
        metadata: {},
      });

      await buildRowndSessionAndAnonymousClaims(
        "user-id",
        {},
        undefined,
        userContext,
      );

      expect(getUser).toHaveBeenCalledTimes(1);
      expect(getUser).toHaveBeenCalledWith("user-id", userContext);
    });

    it("uses one metadata inspection for standard and Rownd OAuth claims", async () => {
      const userContext = { requestId: "oauth" };
      const user = {
        id: "oauth-user",
        emails: ["oauth@example.com"],
        phoneNumbers: [],
        loginMethods: [],
      } as any;
      const getUser = vi.spyOn(SuperTokens, "getUser");
      vi.spyOn(SuperTokens, "getUserIdMapping").mockResolvedValue({
        status: "UNKNOWN_MAPPING_ERROR",
      });
      const getMetadata = vi
        .spyOn(UserMetadata, "getUserMetadata")
        .mockImplementation(async (_userId, context) => {
          expect(context).toBe(userContext);
          return {
            status: "OK",
            metadata: {
              original_rownd_user: {
                data: { user_id: "rownd-oauth-user" },
                verified_data: {},
              },
            },
          } as any;
        });

      await buildRowndOAuthPayload({
        user,
        scopes: ["openid", "email"],
        userContext,
      });

      expect(getUser).not.toHaveBeenCalled();
      expect(getMetadata).toHaveBeenCalledTimes(1);
    });

    it("refreshes source metadata before recording an app variant", async () => {
      init({
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
        subBrands: {
          variant_123: {
            id: "app-id",
            variant: { id: "variant_123" },
          },
        },
      });
      const userContext = {
        _default: { coreCallCache: { metadata: "stale" } },
      };
      vi.spyOn(SuperTokens, "getUser").mockResolvedValue({
        id: "user-id",
        loginMethods: [],
      } as any);
      vi.spyOn(SuperTokens, "getUserIdMapping").mockResolvedValue({
        status: "UNKNOWN_MAPPING_ERROR",
      });
      const getMetadata = vi
        .spyOn(UserMetadata, "getUserMetadata")
        .mockResolvedValueOnce({
          status: "OK",
          metadata: {
            original_rownd_user: {
              data: { user_id: "user-id" },
              attributes: {},
            },
          },
        } as any)
        .mockImplementationOnce(async (_userId, context) => {
          expect(context).toBe(userContext);
          expect((context as any)._default.coreCallCache).toEqual({});
          return {
            status: "OK",
            metadata: {
              original_rownd_user: {
                data: { user_id: "user-id" },
                attributes: { concurrent_update: "retained" },
              },
            },
          } as any;
        });
      const updateMetadata = vi
        .spyOn(UserMetadata, "updateUserMetadata")
        .mockResolvedValue({ status: "OK", metadata: {} } as any);

      await recordRowndAppVariantForUser(
        "user-id",
        "variant_123",
        userContext as any,
      );

      expect(getMetadata).toHaveBeenCalledTimes(2);
      expect(updateMetadata.mock.calls[0]?.[1]).toMatchObject({
        original_rownd_user: {
          attributes: {
            concurrent_update: "retained",
            "rownd:app_variants": ["variant_123"],
          },
        },
      });
    });

    it("compares an existing third-party owner in internal ID space", async () => {
      const recipeUserId = { getAsString: () => "thirdparty-recipe-user" };
      const userContext = {
        _default: { coreCallCache: { mapping: "UNKNOWN_MAPPING_ERROR" } },
      };
      vi.spyOn(ThirdParty, "manuallyCreateOrUpdateUser").mockResolvedValue({
        status: "OK",
        user: { id: "rownd-external-id" },
        recipeUserId,
        createdNewRecipeUser: false,
      } as any);
      const create = vi.spyOn(ThirdParty, "manuallyCreateOrUpdateUser");
      vi.spyOn(SuperTokens, "getUserIdMapping").mockImplementation(
        async ({ userId, userIdType, userContext: context }) => {
          expect(userIdType).toBe("EXTERNAL");
          expect((context as any)._default.coreCallCache).toEqual({});
          return userId === "rownd-external-id"
            ? {
                status: "OK",
                superTokensUserId: "internal-primary-id",
                externalUserId: userId,
              }
            : { status: "UNKNOWN_MAPPING_ERROR" };
        },
      );

      await expect(
        createMissingLoginMethod(
          {
            recipeId: "thirdparty",
            thirdPartyId: "google",
            thirdPartyUserId: "google-user-id",
            email: "google-user@example.com",
            isVerified: true,
          },
          "public",
          "internal-primary-id",
          userContext as any,
        ),
      ).resolves.toEqual({ recipeUserId, createdNewRecipeUser: false });
      expect(create.mock.calls[0]?.[6]).not.toBe(userContext);
      expect(userContext).not.toHaveProperty(
        "rowndDisableAutomaticAccountLinking",
      );
    });

    it("rejects a method concurrently linked to a foreign primary", async () => {
      const recipeUserId = { getAsString: () => "target-recipe-user" };
      const userContext = {
        _default: { coreCallCache: { mapping: "stale" } },
      };
      vi.spyOn(AccountLinking, "createPrimaryUser").mockResolvedValue({
        status: "RECIPE_USER_ID_ALREADY_LINKED_WITH_PRIMARY_USER_ID_ERROR",
        primaryUserId: "foreign-external-id",
      } as any);
      vi.spyOn(SuperTokens, "getUserIdMapping").mockImplementation(
        async ({ userId, userIdType, userContext: context }) => {
          expect(userIdType).toBe("EXTERNAL");
          expect((context as any)._default.coreCallCache).toEqual({});
          expect(userId).toBe("foreign-external-id");
          return {
            status: "OK",
            superTokensUserId: "foreign-internal-id",
            externalUserId: userId,
          };
        },
      );

      await expect(
        ensurePrimaryUser(
          { isPrimaryUser: false } as any,
          recipeUserId as any,
          "expected-internal-id",
          userContext as any,
        ),
      ).rejects.toThrow("different primary user");
    });

    it("freshly accepts a mapping creation conflict for the internal target", async () => {
      const userContext = {
        _default: { coreCallCache: { mapping: "stale" } },
      };
      const mappingLookups: string[] = [];
      vi.spyOn(SuperTokens, "createUserIdMapping").mockResolvedValue({
        status: "USER_ID_MAPPING_ALREADY_EXISTS_ERROR",
        doesSuperTokensUserIdExist: false,
        doesExternalUserIdExist: true,
      });
      vi.spyOn(SuperTokens, "getUserIdMapping").mockImplementation(
        async ({ userId, userIdType, userContext: context }) => {
          expect(userIdType).toBe("EXTERNAL");
          expect((context as any)._default.coreCallCache).toEqual({});
          mappingLookups.push(userId);
          return {
            status: "OK",
            superTokensUserId: "expected-internal-id",
            externalUserId: userId,
          };
        },
      );

      await expect(
        createRowndUserIdMapping(
          "expected-internal-id",
          "rownd-user-id",
          userContext as any,
        ),
      ).resolves.toBe(false);
      expect(mappingLookups).toEqual(["rownd-user-id"]);
    });

    it("does not disassociate tenant state after a later association fails", async () => {
      const firstRecipeUserId = { getAsString: () => "first-recipe-user" };
      const secondRecipeUserId = { getAsString: () => "second-recipe-user" };
      const associate = vi
        .spyOn(MultiTenancy, "associateUserToTenant")
        .mockResolvedValueOnce({ status: "OK", wasAlreadyAssociated: false })
        .mockResolvedValueOnce({ status: "UNKNOWN_USER_ID_ERROR" } as any);
      const disassociate = vi.spyOn(MultiTenancy, "disassociateUserFromTenant");

      await expect(
        associateUserLoginMethodsToTenant(
          {
            loginMethods: [
              { recipeUserId: firstRecipeUserId, tenantIds: ["public"] },
              { recipeUserId: secondRecipeUserId, tenantIds: ["public"] },
            ],
          } as any,
          "tenant-a",
          {},
        ),
      ).rejects.toThrow("UNKNOWN_USER_ID_ERROR");
      expect(associate).toHaveBeenCalledTimes(2);
      expect(disassociate).not.toHaveBeenCalled();
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

    it("uses the Rownd profile email instead of a stale Apple email without a canonical marker", async () => {
      const appleRecipeUserId = {
        getAsString: () => "stale-apple-recipe-user",
      };
      const canonicalRecipeUserId = {
        getAsString: () => "canonical-email-recipe-user",
      };
      const existingUser = {
        id: "canonical-user",
        loginMethods: [
          {
            recipeId: "thirdparty",
            recipeUserId: appleRecipeUserId,
            email: "doejohn@gmail.com",
            verified: true,
            tenantIds: ["public"],
            thirdParty: { id: "apple", userId: "apple-user" },
          },
          {
            recipeId: "passwordless",
            recipeUserId: canonicalRecipeUserId,
            email: "johndoe@email.com",
            verified: true,
            tenantIds: ["public"],
          },
        ],
      } as any;
      vi.spyOn(SuperTokens, "getUserIdMapping").mockResolvedValue({
        status: "UNKNOWN_MAPPING_ERROR",
      });
      vi.spyOn(UserMetadata, "getUserMetadata").mockImplementation(
        async (userId) => ({
          status: "OK",
          metadata:
            userId === "canonical-user"
              ? {
                  original_rownd_user: {
                    data: {
                      email: "johndoe@email.com",
                    },
                  },
                }
              : {},
        }),
      );
      vi.spyOn(SuperTokens, "listUsersByAccountInfo").mockResolvedValue([
        existingUser,
      ]);

      await expect(
        doesRowndAccountInfoExist({
          tenantId: "public",
          email: "johndoe@email.com",
          userContext: {},
        }),
      ).resolves.toBe(true);
      await expect(
        doesRowndAccountInfoExist({
          tenantId: "public",
          email: "doejohn@gmail.com",
          userContext: {},
        }),
      ).resolves.toBe(false);

      await expect(
        shouldLinkRowndAccounts([
          {
            recipeId: "thirdparty",
            email: "johndoe@email.com",
            thirdParty: { id: "google", userId: "google-user" },
          },
          existingUser,
          undefined,
          "public",
          {},
        ] as any),
      ).resolves.toEqual({
        shouldAutomaticallyLink: true,
        shouldRequireVerification: true,
      });

      await expect(
        shouldLinkRowndAccounts([
          { recipeId: "passwordless", email: "doejohn@gmail.com" },
          existingUser,
          undefined,
          "public",
          {},
        ] as any),
      ).resolves.toEqual({
        shouldAutomaticallyLink: false,
        shouldRequireVerification: false,
      });
    });

    it.each(["multiple", "mixed"] as const)(
      "denies automatic linking for %s canonical candidates",
      async (scenario) => {
        const email = "ambiguous-canonical@example.com";
        const recipeUserId = (id: string) => ({ getAsString: () => id });
        const validUser = {
          id: "valid-canonical-user",
          loginMethods: [
            {
              recipeId: "passwordless",
              recipeUserId: recipeUserId("valid-canonical-method"),
              email,
              verified: true,
              tenantIds: ["public"],
            },
          ],
        } as any;
        const otherUser = {
          id: "other-canonical-user",
          loginMethods: [
            {
              recipeId: "passwordless",
              recipeUserId: recipeUserId("other-matching-method"),
              email,
              verified: true,
              tenantIds: ["public"],
            },
            ...(scenario === "mixed"
              ? [
                  {
                    recipeId: "passwordless",
                    recipeUserId: recipeUserId("other-canonical-method"),
                    email: "other-canonical@example.com",
                    verified: true,
                    tenantIds: ["public"],
                  },
                ]
              : []),
          ],
        } as any;
        vi.spyOn(SuperTokens, "getUserIdMapping").mockResolvedValue({
          status: "UNKNOWN_MAPPING_ERROR",
        });
        vi.spyOn(UserMetadata, "getUserMetadata").mockImplementation(
          async (userId) => ({
            status: "OK",
            metadata:
              scenario === "mixed" && userId === otherUser.id
                ? {
                    rownd_email_recipe_user_ids: {
                      public: "other-canonical-method",
                    },
                  }
                : {},
          }),
        );
        vi.spyOn(SuperTokens, "listUsersByAccountInfo").mockResolvedValue([
          validUser,
          otherUser,
        ]);

        await expect(
          shouldLinkRowndAccounts([
            {
              recipeId: "thirdparty",
              email,
              thirdParty: { id: "google", userId: "ambiguous-google" },
            },
            undefined,
            undefined,
            "public",
            {},
          ] as any),
        ).resolves.toEqual({
          shouldAutomaticallyLink: false,
          shouldRequireVerification: false,
        });
      },
    );

    it("ignores a legacy canonical marker that points only to another tenant", async () => {
      const localRecipeUserId = { getAsString: () => "local-email-method" };
      const otherRecipeUserId = { getAsString: () => "other-tenant-method" };
      const user = {
        id: "legacy-cross-tenant-user",
        loginMethods: [
          {
            recipeId: "passwordless",
            recipeUserId: localRecipeUserId,
            email: "local@example.com",
            verified: true,
            tenantIds: ["tenant-a"],
          },
          {
            recipeId: "passwordless",
            recipeUserId: otherRecipeUserId,
            email: "other@example.com",
            verified: true,
            tenantIds: ["tenant-b"],
          },
        ],
      } as any;
      vi.spyOn(SuperTokens, "getUserIdMapping").mockResolvedValue({
        status: "UNKNOWN_MAPPING_ERROR",
      });
      vi.spyOn(UserMetadata, "getUserMetadata").mockImplementation(
        async (userId) => ({
          status: "OK",
          metadata:
            userId === user.id
              ? { rownd_email_recipe_user_id: otherRecipeUserId.getAsString() }
              : {},
        }),
      );
      vi.spyOn(SuperTokens, "listUsersByAccountInfo").mockResolvedValue([user]);

      await expect(
        doesRowndAccountInfoExist({
          tenantId: "tenant-a",
          email: "local@example.com",
        }),
      ).resolves.toBe(true);
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

    it.each([
      { verifiedEmail: true, expected: true },
      { verifiedEmail: "VERIFIED@example.com", expected: true },
      { verifiedEmail: "another@example.com", expected: false },
      { verifiedEmail: "not-a-verification", expected: false },
    ])(
      "maps Rownd email verification value $verifiedEmail as $expected",
      ({ verifiedEmail, expected }) => {
        const user = mapRowndUserToSuperTokens({
          state: "enabled",
          auth_level: "verified",
          data: {
            user_id: "verified-email-value",
            email: "verified@example.com",
          },
          verified_data: { email: verifiedEmail },
        });

        expect(user.loginMethods[0]?.isVerified).toBe(expected);
      },
    );

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

    it("rejects unknown telemetry providers", () => {
      expect(() =>
        init({
          disableRowndUserMigration: true,
          telemetry: { provider: "unknown" },
        } as unknown as RowndPluginConfig),
      ).toThrow("Unknown telemetry provider");
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
        appConfig: { auth: { useExplicitSignUpFlow: true } },
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
          rowndAuthIntent: "sign_up",
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
      expect(rewrittenUrl.searchParams.get("rowndAuthIntent")).toBe("sign_up");
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
      const resolveConfig = vi.fn(
        async ({ tenantId }: { tenantId?: string }) => ({
          clientDomains: { browser_local: "http://localhost:3000" },
          crossDeviceConfirmationBypass: {
            allowedRedirectPaths: ["/profile?tab=security"],
          },
          appConfig: { id: `app-${tenantId}` },
        }),
      );
      const pluginConfig: RowndPluginConfig = {
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
        resolveConfig,
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
      expect(resolveConfig).toHaveBeenCalledOnce();
      expect(resolveConfig.mock.calls[0]?.[0]).toMatchObject({
        tenantId: "public",
      });
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

    it("requires a session when a pending verification marker is present", async () => {
      const originalVerifyEmailPOST = vi.fn();
      const emailVerificationApis = init({
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
      }).overrideMap.emailverification.apis({
        verifyEmailPOST: originalVerifyEmailPOST,
      });

      const response = await emailVerificationApis.verifyEmailPOST({
        token: "raw-core-token",
        tenantId: "public",
        session: undefined,
        options: {
          req: makeRequest({ rowndPendingVerificationId: "pending-id" }),
        },
        userContext: {},
      });

      expect(response).toEqual({
        status: "GENERAL_ERROR",
        message: "email change verification requires the initiating session",
      });
      expect(originalVerifyEmailPOST).not.toHaveBeenCalled();
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

    it("records app variant membership and refreshes a linked guest session after passwordless code consumption", async () => {
      const pluginConfig: RowndPluginConfig = {
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
        appConfig: { id: "app_xyz" },
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
      const rowndMetadataUserId = signInUpResult.recipeUserId.getAsString();
      await UserMetadata.updateUserMetadata(rowndMetadataUserId, {
        original_rownd_user: {
          state: "enabled",
          auth_level: "verified",
          data: { user_id: rowndMetadataUserId },
          verified_data: {},
          attributes: {},
        },
      });
      const { session, anonymousId, linkedUser } =
        await createLinkedGuestSession(signInUpResult.recipeUserId);
      const mergeIntoAccessTokenPayload = vi.spyOn(
        session,
        "mergeIntoAccessTokenPayload",
      );
      const userContext = {};
      const originalConsumeCodePOST = vi.fn().mockImplementation((input) => {
        expect(input.userContext).not.toBe(userContext);
        expect(input.userContext.rowndAppVariantId).toBe("variant_123");
        return { status: "OK", user: linkedUser, session };
      });
      const passwordlessApis = (
        init(pluginConfig) as any
      ).overrideMap.passwordless.apis({
        consumeCodePOST: originalConsumeCodePOST,
      });

      await passwordlessApis.consumeCodePOST({
        preAuthSessionId: "passwordless-variant-pre-auth",
        tenantId: "public",
        options: {
          req: makeVariantRequest("variant_123"),
          recipeImplementation: {
            listCodesByPreAuthSessionId: vi.fn().mockResolvedValue(undefined),
          },
        },
        userContext,
      });

      expect(originalConsumeCodePOST).toHaveBeenCalledTimes(1);
      expect(userContext).not.toHaveProperty("rowndAppVariantId");
      await expect(
        UserMetadata.getUserMetadata(linkedUser.id),
      ).resolves.toEqual({
        status: "OK",
        metadata: {},
      });
      const metadata = await UserMetadata.getUserMetadata(rowndMetadataUserId);
      expect(
        (metadata.metadata as any).original_rownd_user.attributes[
          "rownd:app_variants"
        ],
      ).toEqual(["variant_123"]);
      expect(mergeIntoAccessTokenPayload).toHaveBeenCalledTimes(1);
      const refreshedPayload = session.getAccessTokenPayload();
      expect(refreshedPayload).toMatchObject({
        auth_level: "verified",
        is_anonymous: expect.objectContaining({ v: false }),
        is_verified_user: true,
        [ROWND_JWT_CLAIMS.AuthLevel]: "verified",
        [ROWND_JWT_CLAIMS.IsVerifiedUser]: true,
        anonymous_id: anonymousId,
        aud: "app:app_xyz",
      });
      expect(refreshedPayload).not.toHaveProperty(ROWND_JWT_CLAIMS.IsAnonymous);
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

      const userContext = {};
      const originalCreateCodePOST = vi.fn().mockImplementation((input) => {
        expect(input.userContext).not.toBe(userContext);
        expect(input.userContext.rowndAppVariantId).toBe("variant_123");
        return { status: "OK" };
      });
      const passwordlessApis = (
        init(pluginConfig) as any
      ).overrideMap.passwordless.apis({
        createCodePOST: originalCreateCodePOST,
      });

      await passwordlessApis.createCodePOST({
        options: { req: makeVariantRequest("variant_123") },
        userContext,
      });

      expect(userContext).not.toHaveProperty("rowndAppVariantId");
    });

    it("rejects unknown explicit sign-in before creating a passwordless code", async () => {
      const pluginConfig: RowndPluginConfig = {
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
        appConfig: { auth: { useExplicitSignUpFlow: true } },
      };
      const originalCreateCodePOST = vi.fn();
      vi.spyOn(SuperTokens, "listUsersByAccountInfo").mockResolvedValue([]);
      const passwordlessApis = (
        init(pluginConfig) as any
      ).overrideMap.passwordless.apis({
        createCodePOST: originalCreateCodePOST,
      });

      await expect(
        passwordlessApis.createCodePOST({
          email: "missing@example.com",
          tenantId: "tenant-a",
          options: { req: makeRequest({}, { intent: "sign_in" }) },
          userContext: {},
        }),
      ).resolves.toEqual({
        status: "SIGN_IN_UP_NOT_ALLOWED",
        reason: "No existing account found",
      });
      expect(SuperTokens.listUsersByAccountInfo).toHaveBeenCalledWith(
        "tenant-a",
        { email: "missing@example.com" },
        true,
        {},
      );
      expect(originalCreateCodePOST).not.toHaveBeenCalled();
    });

    it("delegates explicit sign-in for an existing email account", async () => {
      const email = "existing@example.com";
      const originalCreateCodePOST = vi
        .fn()
        .mockResolvedValue({ status: "OK" });
      vi.spyOn(SuperTokens, "listUsersByAccountInfo").mockResolvedValue([
        {
          id: "existing-user",
          loginMethods: [
            {
              recipeId: "passwordless",
              recipeUserId: { getAsString: () => "existing-user" },
              email,
              verified: true,
              tenantIds: ["public"],
            },
          ],
        } as any,
      ]);
      vi.spyOn(SuperTokens, "getUserIdMapping").mockResolvedValue({
        status: "UNKNOWN_MAPPING_ERROR",
      });
      vi.spyOn(UserMetadata, "getUserMetadata").mockResolvedValue({
        status: "OK",
        metadata: {},
      });
      const passwordlessApis = init({
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
        appConfig: { auth: { useExplicitSignUpFlow: true } },
      }).overrideMap.passwordless.apis({
        createCodePOST: originalCreateCodePOST,
      });

      await expect(
        passwordlessApis.createCodePOST({
          email,
          tenantId: "public",
          options: { req: makeRequest({}, { intent: "sign_in" }) },
          userContext: {},
        }),
      ).resolves.toEqual({ status: "OK" });
      expect(originalCreateCodePOST).toHaveBeenCalledOnce();
      expect(originalCreateCodePOST).toHaveBeenCalledWith(
        expect.objectContaining({ email, tenantId: "public" }),
      );
    });

    it("fails closed when cleanup-code revocation fails and retries idempotently", async () => {
      const config: RowndPluginConfig = {
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
        appConfig: { auth: { useExplicitSignUpFlow: true } },
      };
      const { server: s, port } = await setup(coreConnectionURI, config);
      server = s;
      testPORT = port;
      const oldEmail = "johndoe+reconciliation@email.com";
      const targetEmail = "doejohn+reconciliation@gmail.com";
      const oldMethod = await Passwordless.signInUp({
        tenantId: "public",
        email: oldEmail,
      });
      const primary = await AccountLinking.createPrimaryUser(
        oldMethod.recipeUserId,
      );
      expect(primary.status).toBe("OK");
      if (primary.status !== "OK") throw new Error("failed to create primary");
      const targetMethod = await Passwordless.signInUp({
        tenantId: "public",
        email: targetEmail,
        userContext: { rowndDisableAutomaticAccountLinking: true },
      });
      await AccountLinking.linkAccounts(
        targetMethod.recipeUserId,
        primary.user.id,
      );
      await UserMetadata.updateUserMetadata(primary.user.id, {
        rownd_pending_verification: [
          {
            id: "explicit-sign-in-retry",
            field: "email",
            value: targetEmail,
            created_at: new Date().toISOString(),
            tenantId: "public",
            purpose: "UPDATE_PASSWORDLESS",
            initiatingSessionHandle: "revoked-session",
            verificationRecipeUserId: oldMethod.recipeUserId.getAsString(),
            status: "COMMITTING",
            targetCanonicalRecipeUserId:
              targetMethod.recipeUserId.getAsString(),
            retiredMethods: [
              {
                recipeUserId: oldMethod.recipeUserId.getAsString(),
                email: oldEmail,
              },
            ],
          },
        ],
      });
      const createCodePOST = vi.fn().mockResolvedValue({ status: "OK" });
      const passwordlessApis = init(config).overrideMap.passwordless.apis({
        createCodePOST,
      });
      const originalRevokeAllCodes = Passwordless.revokeAllCodes;
      vi.spyOn(Passwordless, "revokeAllCodes").mockRejectedValueOnce(
        new Error("code revocation failed"),
      );

      await expect(
        passwordlessApis.createCodePOST!({
          email: targetEmail,
          tenantId: "public",
          options: { req: makeRequest({}, { intent: "sign_in" }) },
          userContext: {},
        }),
      ).resolves.toEqual({
        status: "GENERAL_ERROR",
        message: "Account email reconciliation failed; please retry.",
      });
      expect(createCodePOST).not.toHaveBeenCalled();
      const failedMetadata = await UserMetadata.getUserMetadata(
        primary.user.id,
      );
      expect(
        (failedMetadata.metadata as any).rownd_pending_verification,
      ).toEqual([
        expect.objectContaining({
          id: "explicit-sign-in-retry",
          status: "COMMITTING",
        }),
      ]);

      vi.mocked(Passwordless.revokeAllCodes).mockImplementation(
        originalRevokeAllCodes,
      );
      await expect(
        passwordlessApis.createCodePOST!({
          email: targetEmail,
          tenantId: "public",
          options: { req: makeRequest({}, { intent: "sign_in" }) },
          userContext: {},
        }),
      ).resolves.toEqual({ status: "OK" });
      expect(createCodePOST).toHaveBeenCalledOnce();
      const recoveredMetadata = await UserMetadata.getUserMetadata(
        primary.user.id,
      );
      expect(
        (recoveredMetadata.metadata as any).rownd_pending_verification,
      ).toEqual([]);
      const recoveredUser = await SuperTokens.getUser(primary.user.id);
      expect(
        recoveredUser?.loginMethods.some(
          (method) =>
            method.recipeUserId.getAsString() ===
              oldMethod.recipeUserId.getAsString() &&
            method.tenantIds.includes("public"),
        ),
      ).toBe(false);
    });

    it("rejects duplicate matching committing plans without changing metadata", async () => {
      const email = "doejohn+duplicate-plan@gmail.com";
      const plans = ["first-plan", "second-plan"].map((id) => ({
        id,
        field: "email",
        value: email,
        created_at: new Date().toISOString(),
        tenantId: "public",
        purpose: "UPDATE_PASSWORDLESS" as const,
        status: "COMMITTING" as const,
        targetCanonicalRecipeUserId: "target-method",
        retiredMethods: [
          { recipeUserId: "old-method", email: "old@example.com" },
        ],
      }));
      vi.spyOn(SuperTokens, "listUsersByAccountInfo").mockResolvedValue([
        {
          id: "primary-user",
          loginMethods: [
            {
              recipeId: "passwordless",
              recipeUserId: { getAsString: () => "target-method" },
              email,
              verified: true,
              tenantIds: ["public"],
            },
          ],
        } as any,
      ]);
      vi.spyOn(UserMetadata, "getUserMetadata").mockResolvedValue({
        status: "OK",
        metadata: { rownd_pending_verification: plans },
      });
      const updateMetadata = vi.spyOn(UserMetadata, "updateUserMetadata");
      const createCodePOST = vi.fn();
      const passwordlessApis = init({
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
        appConfig: { auth: { useExplicitSignUpFlow: true } },
      }).overrideMap.passwordless.apis({ createCodePOST });

      await expect(
        passwordlessApis.createCodePOST!({
          email,
          tenantId: "public",
          options: { req: makeRequest({}, { intent: "sign_up" }) },
          userContext: {},
        }),
      ).resolves.toEqual({
        status: "GENERAL_ERROR",
        message: "Account email reconciliation failed; please retry.",
      });
      expect(createCodePOST).not.toHaveBeenCalled();
      expect(updateMetadata).not.toHaveBeenCalled();
      expect(plans).toHaveLength(2);
    });

    it("fails closed on malformed committing state before code delivery", async () => {
      const email = "malformed-plan@example.com";
      vi.spyOn(SuperTokens, "listUsersByAccountInfo").mockResolvedValue([
        {
          id: "primary-user",
          loginMethods: [
            {
              recipeId: "passwordless",
              recipeUserId: { getAsString: () => "target-method" },
              email,
              verified: true,
              tenantIds: ["public"],
            },
          ],
        } as any,
      ]);
      vi.spyOn(UserMetadata, "getUserMetadata").mockResolvedValue({
        status: "OK",
        metadata: {
          rownd_pending_verification: [
            {
              id: "malformed-plan",
              field: "email",
              value: email,
              created_at: new Date().toISOString(),
              tenantId: "public",
              status: "COMMITTING",
              targetCanonicalRecipeUserId: "target-method",
              retiredMethods: [
                { recipeUserId: "target-method", email: "old@example.com" },
              ],
            },
          ],
        },
      });
      const createCodePOST = vi.fn();
      const passwordlessApis = init({
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
        appConfig: { auth: { useExplicitSignUpFlow: true } },
      }).overrideMap.passwordless.apis({ createCodePOST });

      await expect(
        passwordlessApis.createCodePOST!({
          email,
          tenantId: "public",
          options: { req: makeRequest({}, { intent: "sign_in" }) },
          userContext: {},
        }),
      ).resolves.toEqual({
        status: "GENERAL_ERROR",
        message: "Account email reconciliation failed; please retry.",
      });
      expect(createCodePOST).not.toHaveBeenCalled();
    });

    it("delegates explicit sign-up for an ordinary existing account", async () => {
      const email = "ordinary-existing-sign-up@example.com";
      vi.spyOn(SuperTokens, "listUsersByAccountInfo").mockResolvedValue([
        {
          id: "existing-user",
          loginMethods: [
            {
              recipeId: "passwordless",
              recipeUserId: { getAsString: () => "existing-user" },
              email,
              verified: true,
              tenantIds: ["public"],
            },
          ],
        } as any,
      ]);
      vi.spyOn(UserMetadata, "getUserMetadata").mockResolvedValue({
        status: "OK",
        metadata: {},
      });
      const createCodePOST = vi.fn().mockResolvedValue({ status: "OK" });
      const passwordlessApis = init({
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
        appConfig: { auth: { useExplicitSignUpFlow: true } },
      }).overrideMap.passwordless.apis({ createCodePOST });

      await expect(
        passwordlessApis.createCodePOST!({
          email,
          tenantId: "public",
          options: { req: makeRequest({}, { intent: "sign_up" }) },
          userContext: {},
        }),
      ).resolves.toEqual({ status: "OK" });
      expect(createCodePOST).toHaveBeenCalledOnce();
    });

    it("rejects a stale cleanup-method link before API session creation", async () => {
      const config: RowndPluginConfig = {
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
      };
      const { server: s, port } = await setup(coreConnectionURI, config);
      server = s;
      testPORT = port;
      const oldMethod = await Passwordless.signInUp({
        tenantId: "public",
        email: "stale-link-old@example.com",
      });
      const staleCode = await Passwordless.createCode({
        tenantId: "public",
        email: "stale-link-old@example.com",
      });
      const primary = await AccountLinking.createPrimaryUser(
        oldMethod.recipeUserId,
      );
      expect(primary.status).toBe("OK");
      if (primary.status !== "OK") throw new Error("failed to create primary");
      const targetMethod = await Passwordless.signInUp({
        tenantId: "public",
        email: "stale-link-target@example.com",
        userContext: { rowndDisableAutomaticAccountLinking: true },
      });
      await expect(
        AccountLinking.linkAccounts(targetMethod.recipeUserId, primary.user.id),
      ).resolves.toMatchObject({ status: "OK" });
      const plan = {
        id: "stale-link-plan",
        field: "email",
        value: "stale-link-target@example.com",
        created_at: new Date().toISOString(),
        tenantId: "public",
        purpose: "UPDATE_PASSWORDLESS",
        status: "COMMITTING",
        targetCanonicalRecipeUserId: targetMethod.recipeUserId.getAsString(),
        retiredMethods: [
          {
            recipeUserId: oldMethod.recipeUserId.getAsString(),
            email: "stale-link-old@example.com",
          },
        ],
      };
      await UserMetadata.updateUserMetadata(primary.user.id, {
        rownd_pending_verification: [plan],
      });
      let staleSession:
        | Awaited<
            ReturnType<typeof Session.createNewSessionWithoutRequestResponse>
          >
        | undefined;
      const consumeCodePOST = vi.fn().mockImplementation(async () => {
        const consumedCode = await Passwordless.consumeCode({
          tenantId: "public",
          preAuthSessionId: staleCode.preAuthSessionId,
          linkCode: staleCode.linkCode,
        });
        if (consumedCode.status !== "OK") {
          throw new Error("failed to consume stale code");
        }
        staleSession = await Session.createNewSessionWithoutRequestResponse(
          "public",
          consumedCode.recipeUserId,
        );
        return {
          status: "OK",
          createdNewRecipeUser: consumedCode.createdNewRecipeUser,
          user: consumedCode.user,
          session: staleSession,
        };
      });
      const passwordlessApis = init(config).overrideMap.passwordless.apis({
        consumeCodePOST,
      } as unknown as PasswordlessAPIInterface);

      await expect(
        passwordlessApis.consumeCodePOST!({
          tenantId: "public",
          preAuthSessionId: staleCode.preAuthSessionId,
          options: {
            req: makeRequest({}),
            recipeImplementation: {
              listCodesByPreAuthSessionId:
                Passwordless.listCodesByPreAuthSessionId,
            },
          },
          userContext: {},
        } as any),
      ).resolves.toEqual({
        status: "SIGN_IN_UP_NOT_ALLOWED",
        reason: "No existing account found",
      });
      expect(consumeCodePOST).not.toHaveBeenCalled();
      expect(staleSession!).toBeUndefined();
      const metadata = await UserMetadata.getUserMetadata(primary.user.id);
      expect((metadata.metadata as any).rownd_pending_verification).toEqual([
        plan,
      ]);
    });

    it("allows target-method consumption while the replacement is COMMITTING", async () => {
      const config: RowndPluginConfig = {
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
      };
      const { server: s, port } = await setup(coreConnectionURI, config);
      server = s;
      testPORT = port;
      const oldMethod = await Passwordless.signInUp({
        tenantId: "public",
        email: "target-consume-old@example.com",
      });
      const primary = await AccountLinking.createPrimaryUser(
        oldMethod.recipeUserId,
      );
      expect(primary.status).toBe("OK");
      if (primary.status !== "OK") throw new Error("failed to create primary");
      const targetMethod = await Passwordless.signInUp({
        tenantId: "public",
        email: "target-consume-new@example.com",
        userContext: { rowndDisableAutomaticAccountLinking: true },
      });
      const targetCode = await Passwordless.createCode({
        tenantId: "public",
        email: "target-consume-new@example.com",
      });
      await AccountLinking.linkAccounts(
        targetMethod.recipeUserId,
        primary.user.id,
      );
      const plan = {
        id: "target-consume-plan",
        field: "email",
        value: "target-consume-new@example.com",
        created_at: new Date().toISOString(),
        tenantId: "public",
        purpose: "UPDATE_PASSWORDLESS",
        status: "COMMITTING",
        targetCanonicalRecipeUserId: targetMethod.recipeUserId.getAsString(),
        retiredMethods: [
          {
            recipeUserId: oldMethod.recipeUserId.getAsString(),
            email: "target-consume-old@example.com",
          },
        ],
      };
      await UserMetadata.updateUserMetadata(primary.user.id, {
        rownd_pending_verification: [plan],
      });
      let targetSession: Awaited<
        ReturnType<typeof Session.createNewSessionWithoutRequestResponse>
      >;
      const consumeCodePOST = vi.fn().mockImplementation(async () => {
        targetSession = await Session.createNewSessionWithoutRequestResponse(
          "public",
          targetMethod.recipeUserId,
        );
        const user = await SuperTokens.getUser(primary.user.id);
        if (!user) throw new Error("failed to reload user");
        return {
          status: "OK",
          createdNewRecipeUser: false,
          user,
          session: targetSession,
        };
      });
      const passwordlessApis = init(config).overrideMap.passwordless.apis({
        consumeCodePOST,
      } as unknown as PasswordlessAPIInterface);

      await expect(
        passwordlessApis.consumeCodePOST!({
          tenantId: "public",
          preAuthSessionId: targetCode.preAuthSessionId,
          options: {
            req: makeRequest({}),
            recipeImplementation: {
              listCodesByPreAuthSessionId:
                Passwordless.listCodesByPreAuthSessionId,
            },
          },
          userContext: {},
        } as any),
      ).resolves.toMatchObject({ status: "OK" });
      await expect(
        Session.getSessionInformation(targetSession!.getHandle()),
      ).resolves.toBeDefined();
      const metadata = await UserMetadata.getUserMetadata(primary.user.id);
      expect((metadata.metadata as any).rownd_pending_verification).toEqual([
        plan,
      ]);
    });

    it.each(["sign_up"])(
      "delegates passwordless code creation for intent %s",
      async (intent) => {
        const pluginConfig: RowndPluginConfig = {
          rowndAppKey: "test-key",
          rowndAppSecret: "test-secret",
          appConfig: { auth: { useExplicitSignUpFlow: true } },
        };
        const originalCreateCodePOST = vi
          .fn()
          .mockResolvedValue({ status: "OK" });
        vi.spyOn(SuperTokens, "listUsersByAccountInfo").mockResolvedValue([]);
        const passwordlessApis = (
          init(pluginConfig) as any
        ).overrideMap.passwordless.apis({
          createCodePOST: originalCreateCodePOST,
        });

        await expect(
          passwordlessApis.createCodePOST({
            email: "new@example.com",
            tenantId: "public",
            options: { req: makeRequest({}, intent ? { intent } : {}) },
            userContext: {},
          }),
        ).resolves.toEqual({ status: "OK" });
        expect(originalCreateCodePOST).toHaveBeenCalledWith(
          expect.objectContaining({ email: "new@example.com" }),
        );
      },
    );

    it("delegates missing passwordless intent as a legacy combined flow", async () => {
      const createCodePOST = vi.fn().mockResolvedValue({ status: "OK" });
      vi.spyOn(SuperTokens, "listUsersByAccountInfo").mockResolvedValue([]);
      const passwordlessApis = init({
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
        appConfig: { auth: { useExplicitSignUpFlow: true } },
      }).overrideMap.passwordless.apis({ createCodePOST });

      await expect(
        passwordlessApis.createCodePOST!({
          email: "missing-intent@example.com",
          tenantId: "public",
          options: { req: makeRequest({}) },
          userContext: {},
        } as any),
      ).resolves.toEqual({ status: "OK" });
      expect(createCodePOST).toHaveBeenCalledOnce();
    });

    it("delegates missing consume intent as a legacy combined flow", async () => {
      const consumeCodePOST = vi
        .fn()
        .mockResolvedValue({ status: "RESTART_FLOW_ERROR" });
      const passwordlessApis = init({
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
        appConfig: { auth: { useExplicitSignUpFlow: true } },
      }).overrideMap.passwordless.apis({ consumeCodePOST });

      await expect(
        passwordlessApis.consumeCodePOST!({
          tenantId: "public",
          preAuthSessionId: "missing-intent",
          options: {
            req: makeRequest({}),
            recipeImplementation: {
              listCodesByPreAuthSessionId: vi.fn().mockResolvedValue(undefined),
            },
          },
          userContext: {},
        } as any),
      ).resolves.toEqual({ status: "RESTART_FLOW_ERROR" });
      expect(consumeCodePOST).toHaveBeenCalledOnce();
    });

    it.each([null, "login", 1])(
      "rejects supplied invalid consume intent %s",
      async (intent) => {
        const consumeCodePOST = vi.fn();
        const passwordlessApis = init({
          rowndAppKey: "test-key",
          rowndAppSecret: "test-secret",
          appConfig: { auth: { useExplicitSignUpFlow: true } },
        }).overrideMap.passwordless.apis({ consumeCodePOST });

        await expect(
          passwordlessApis.consumeCodePOST!({
            tenantId: "public",
            preAuthSessionId: "invalid-intent",
            options: {
              req: makeRequest({}, { intent }),
              recipeImplementation: {},
            },
            userContext: {},
          } as any),
        ).resolves.toEqual({
          status: "GENERAL_ERROR",
          message: "intent must be sign_in or sign_up",
        });
        expect(consumeCodePOST).not.toHaveBeenCalled();
      },
    );

    it.each([null, "login", 1])(
      "rejects invalid passwordless intent %s",
      async (intent) => {
        const originalCreateCodePOST = vi.fn();
        const listUsers = vi.spyOn(SuperTokens, "listUsersByAccountInfo");
        const passwordlessApis = init({
          rowndAppKey: "test-key",
          rowndAppSecret: "test-secret",
        }).overrideMap.passwordless.apis({
          createCodePOST: originalCreateCodePOST,
        });

        await expect(
          passwordlessApis.createCodePOST({
            email: "invalid-intent@example.com",
            tenantId: "public",
            options: { req: makeRequest({}, { intent }) },
            userContext: {},
          }),
        ).resolves.toEqual({
          status: "GENERAL_ERROR",
          message: "intent must be sign_in or sign_up",
        });
        expect(originalCreateCodePOST).not.toHaveBeenCalled();
        expect(listUsers).not.toHaveBeenCalled();
      },
    );

    it("applies explicit sign-in policy to phone identifiers", async () => {
      const originalCreateCodePOST = vi.fn();
      vi.spyOn(SuperTokens, "listUsersByAccountInfo").mockResolvedValue([]);
      const passwordlessApis = (
        init({
          rowndAppKey: "test-key",
          rowndAppSecret: "test-secret",
          appConfig: { auth: { useExplicitSignUpFlow: true } },
        }) as any
      ).overrideMap.passwordless.apis({
        createCodePOST: originalCreateCodePOST,
      });

      await expect(
        passwordlessApis.createCodePOST({
          phoneNumber: "+15555550123",
          tenantId: "tenant-a",
          options: { req: makeRequest({}, { intent: "sign_in" }) },
          userContext: {},
        }),
      ).resolves.toEqual({
        status: "SIGN_IN_UP_NOT_ALLOWED",
        reason: "No existing account found",
      });
      expect(SuperTokens.listUsersByAccountInfo).toHaveBeenCalledWith(
        "tenant-a",
        { phoneNumber: "+15555550123" },
        true,
        {},
      );
    });

    it("validates the app variant before explicit sign-in lookup", async () => {
      const originalCreateCodePOST = vi.fn();
      const listUsers = vi.spyOn(SuperTokens, "listUsersByAccountInfo");
      const passwordlessApis = (
        init({
          rowndAppKey: "test-key",
          rowndAppSecret: "test-secret",
          subBrands: {},
        }) as any
      ).overrideMap.passwordless.apis({
        createCodePOST: originalCreateCodePOST,
      });

      await expect(
        passwordlessApis.createCodePOST({
          email: "variant@example.com",
          tenantId: "public",
          options: {
            req: makeRequest(
              { app_variant_id: "unknown-variant" },
              { intent: "sign_in" },
            ),
          },
          userContext: {},
        }),
      ).rejects.toThrow("Unknown Rownd app variant: unknown-variant");
      expect(listUsers).not.toHaveBeenCalled();
      expect(originalCreateCodePOST).not.toHaveBeenCalled();
    });

    it("uses the app variant explicit sign-in policy", async () => {
      vi.spyOn(SuperTokens, "listUsersByAccountInfo").mockResolvedValue([]);
      const passwordlessApis = (
        init({
          rowndAppKey: "test-key",
          rowndAppSecret: "test-secret",
          appConfig: { auth: { useExplicitSignUpFlow: false } },
          subBrands: {
            "variant-123": {
              id: "app-123",
              name: "Variant",
              variant: { id: "variant-123", name: "Variant" },
              auth: { useExplicitSignUpFlow: true },
            },
          },
        }) as any
      ).overrideMap.passwordless.apis({ createCodePOST: vi.fn() });

      await expect(
        passwordlessApis.createCodePOST({
          email: "variant@example.com",
          tenantId: "public",
          options: {
            req: makeRequest(
              { app_variant_id: "variant-123" },
              { intent: "sign_in" },
            ),
          },
          userContext: {},
        }),
      ).resolves.toEqual({
        status: "SIGN_IN_UP_NOT_ALLOWED",
        reason: "No existing account found",
      });
    });

    it("shadows stale passwordless request flags when omitted", async () => {
      const userContext = {
        rowndAppVariantId: "stale-variant",
        rowndOAuthLoginChallenge: "stale-challenge",
      };
      const originalCreateCodePOST = vi.fn().mockImplementation((input) => {
        expect(input.userContext).not.toBe(userContext);
        expect(input.userContext).toHaveProperty(
          "rowndAppVariantId",
          undefined,
        );
        expect(input.userContext).toHaveProperty(
          "rowndOAuthLoginChallenge",
          undefined,
        );
        return { status: "OK" };
      });
      const passwordlessApis = (
        init({
          rowndAppKey: "test-key",
          rowndAppSecret: "test-secret",
        }) as any
      ).overrideMap.passwordless.apis({
        createCodePOST: originalCreateCodePOST,
      });

      await passwordlessApis.createCodePOST({
        options: { req: makeRequest({}) },
        userContext,
      });

      expect(userContext).toMatchObject({
        rowndAppVariantId: "stale-variant",
        rowndOAuthLoginChallenge: "stale-challenge",
      });
    });

    it("adds client domain context before passwordless code creation", async () => {
      const pluginConfig: RowndPluginConfig = {
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
        appConfig: { auth: { useExplicitSignUpFlow: true } },
      };
      const userContext = {};
      const originalCreateCodePOST = vi.fn().mockImplementation((input) => {
        expect(input.userContext).not.toBe(userContext);
        expect(input.userContext).toMatchObject({
          rowndDisplayContext: "browser",
          rowndClientDomain: "browser_local",
          rowndAuthIntent: "sign_up",
        });
        return { status: "OK" };
      });
      const passwordlessApis = (
        init(pluginConfig) as any
      ).overrideMap.passwordless.apis({
        createCodePOST: originalCreateCodePOST,
      });

      await passwordlessApis.createCodePOST({
        options: {
          req: makeRequest(
            {
              rownd_display_context: "browser",
              rownd_client_domain: "browser_local",
            },
            { intent: "sign_up" },
          ),
        },
        userContext,
      });

      expect(userContext).toEqual({});
    });

    it("adds OAuth login challenge context before passwordless code creation", async () => {
      const pluginConfig: RowndPluginConfig = {
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
      };
      const userContext = {};
      const originalCreateCodePOST = vi.fn().mockImplementation((input) => {
        expect(input.userContext).not.toBe(userContext);
        expect(input.userContext.rowndOAuthLoginChallenge).toBe(
          "login_challenge_123",
        );
        return { status: "OK" };
      });
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
        userContext,
      });

      expect(userContext).toEqual({});
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
            auth: { useExplicitSignUpFlow: true },
          },
        },
      };
      const userContext = {};
      const originalResendCodePOST = vi.fn().mockImplementation((input) => {
        expect(input.userContext).not.toBe(userContext);
        expect(input.userContext).toMatchObject({
          rowndDisplayContext: "mobile_app",
          rowndRedirectToPath: "/profile",
          rowndClientDomain: "mobile",
          rowndAppVariantId: "variant_123",
          rowndOAuthLoginChallenge: "login_challenge_123",
          rowndAuthIntent: "sign_in",
        });
        return { status: "OK" };
      });
      const device = {
        preAuthSessionId: "pre-auth-session",
        failedCodeInputAttemptCount: 0,
        phoneNumber: "+15555550199",
        codes: [],
      };
      const recipeImplementation = {
        listCodesByDeviceId: vi.fn().mockResolvedValue(device),
        listCodesByPreAuthSessionId: vi.fn().mockResolvedValue(device),
      };
      const passwordlessApis = (
        init(pluginConfig) as any
      ).overrideMap.passwordless.apis({
        resendCodePOST: originalResendCodePOST,
      });

      await passwordlessApis.resendCodePOST({
        deviceId: "device-id",
        preAuthSessionId: "pre-auth-session",
        options: {
          req: makeRequest(
            {
              rownd_display_context: "mobile_app",
              rownd_redirect_to_path: "/profile",
              rownd_client_domain: "mobile",
              app_variant_id: "variant_123",
              rownd_oauth_login_challenge: "login_challenge_123",
            },
            { intent: "sign_in" },
          ),
          recipeImplementation,
        },
        userContext,
      });

      expect(userContext).toEqual({});
    });

    it("revokes a cleanup device and restarts passwordless resend", async () => {
      const config: RowndPluginConfig = {
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
      };
      const { server: s, port } = await setup(coreConnectionURI, config);
      server = s;
      testPORT = port;
      const oldMethod = await Passwordless.signInUp({
        tenantId: "public",
        email: "resend-cleanup-old@example.com",
      });
      const code = await Passwordless.createCode({
        tenantId: "public",
        email: "resend-cleanup-old@example.com",
      });
      const primary = await AccountLinking.createPrimaryUser(
        oldMethod.recipeUserId,
      );
      expect(primary.status).toBe("OK");
      if (primary.status !== "OK") throw new Error("failed to create primary");
      const targetMethod = await Passwordless.signInUp({
        tenantId: "public",
        email: "resend-cleanup-target@example.com",
        userContext: { rowndDisableAutomaticAccountLinking: true },
      });
      await AccountLinking.linkAccounts(
        targetMethod.recipeUserId,
        primary.user.id,
      );
      await UserMetadata.updateUserMetadata(primary.user.id, {
        rownd_pending_verification: [
          {
            id: "resend-cleanup-plan",
            field: "email",
            value: "resend-cleanup-target@example.com",
            created_at: new Date().toISOString(),
            tenantId: "public",
            purpose: "UPDATE_PASSWORDLESS",
            status: "COMMITTING",
            targetCanonicalRecipeUserId:
              targetMethod.recipeUserId.getAsString(),
            retiredMethods: [
              {
                recipeUserId: oldMethod.recipeUserId.getAsString(),
                email: "resend-cleanup-old@example.com",
              },
            ],
          },
        ],
      });
      const recipeImplementation = {
        listCodesByDeviceId: Passwordless.listCodesByDeviceId,
        listCodesByPreAuthSessionId: Passwordless.listCodesByPreAuthSessionId,
        revokeCode: Passwordless.revokeCode,
      };
      const originalResendCodePOST = vi.fn();
      const apis = init(config).overrideMap.passwordless.apis({
        resendCodePOST: originalResendCodePOST,
      });

      await expect(
        apis.resendCodePOST!({
          deviceId: code.deviceId,
          preAuthSessionId: code.preAuthSessionId,
          tenantId: "public",
          session: undefined,
          shouldTryLinkingWithSessionUser: false,
          options: {
            req: makeRequest({}),
            recipeImplementation,
          },
          userContext: {},
        } as any),
      ).resolves.toEqual({ status: "RESTART_FLOW_ERROR" });
      expect(originalResendCodePOST).not.toHaveBeenCalled();
      await expect(
        Passwordless.consumeCode({
          tenantId: "public",
          preAuthSessionId: code.preAuthSessionId,
          linkCode: code.linkCode,
        }),
      ).resolves.toEqual({ status: "RESTART_FLOW_ERROR" });
    });

    it("fails closed when passwordless resend device lookups disagree", async () => {
      const resendCodePOST = vi.fn();
      const apis = init({
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
      }).overrideMap.passwordless.apis({ resendCodePOST });

      await expect(
        apis.resendCodePOST!({
          deviceId: "device-id",
          preAuthSessionId: "expected-pre-auth",
          tenantId: "public",
          options: {
            req: makeRequest({}),
            recipeImplementation: {
              listCodesByDeviceId: vi.fn().mockResolvedValue({
                preAuthSessionId: "different-pre-auth",
                failedCodeInputAttemptCount: 0,
                email: "malformed-resend@example.com",
                codes: [],
              }),
              listCodesByPreAuthSessionId: vi.fn().mockResolvedValue(undefined),
            },
          },
          userContext: {},
        } as any),
      ).resolves.toEqual({
        status: "GENERAL_ERROR",
        message: "Unable to resend passwordless code.",
      });
      expect(resendCodePOST).not.toHaveBeenCalled();
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

    it("records app variant membership and refreshes a linked guest session after third-party sign in", async () => {
      const pluginConfig: RowndPluginConfig = {
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
        appConfig: { id: "app_xyz" },
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
      const { session, anonymousId, linkedUser } =
        await createLinkedGuestSession(signInUpResult.recipeUserId);
      const mergeIntoAccessTokenPayload = vi.spyOn(
        session,
        "mergeIntoAccessTokenPayload",
      );
      const userContext = {};
      const originalSignInUpPOST = vi.fn().mockImplementation((input) => {
        expect(input.userContext).not.toBe(userContext);
        expect(input.userContext.rowndAppVariantId).toBe("variant_123");
        return { status: "OK", user: linkedUser, session };
      });

      const thirdPartyApis = (
        init(pluginConfig) as any
      ).overrideMap.thirdparty.apis({
        signInUpPOST: originalSignInUpPOST,
      });

      await thirdPartyApis.signInUpPOST({
        options: { req: makeVariantRequest("variant_123") },
        userContext,
      });

      expect(originalSignInUpPOST).toHaveBeenCalledTimes(1);
      expect(userContext).not.toHaveProperty("rowndAppVariantId");
      const metadata = await getUserMetadata(linkedUser.id);
      expect(
        (metadata.metadata as any).original_rownd_user.attributes[
          "rownd:app_variants"
        ],
      ).toEqual(["variant_123"]);
      expect(mergeIntoAccessTokenPayload).toHaveBeenCalledTimes(1);
      const refreshedPayload = session.getAccessTokenPayload();
      expect(refreshedPayload).toMatchObject({
        auth_level: "verified",
        is_anonymous: expect.objectContaining({ v: false }),
        is_verified_user: true,
        [ROWND_JWT_CLAIMS.AuthLevel]: "verified",
        [ROWND_JWT_CLAIMS.IsVerifiedUser]: true,
        anonymous_id: anonymousId,
        aud: "app:app_xyz",
      });
      expect(refreshedPayload).not.toHaveProperty(ROWND_JWT_CLAIMS.IsAnonymous);
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
      const sessionFunctions = (
        init(pluginConfig) as any
      ).overrideMap.session.functions({
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

    it("rejects a query tenant that conflicts with the authenticated recipe tenant", async () => {
      const resolveConfig = vi.fn(async () => ({}));
      const originalConsumeCodePOST = vi.fn();
      const plugin = init({
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
        resolveConfig,
      }) as unknown as {
        overrideMap: {
          passwordless: {
            apis: (
              implementation: PasswordlessAPIInterface,
            ) => PasswordlessAPIInterface;
          };
        };
      };
      const apis = plugin.overrideMap.passwordless.apis({
        consumeCodePOST: originalConsumeCodePOST,
      } as unknown as PasswordlessAPIInterface);
      type ConsumeCodeInput = Parameters<
        NonNullable<PasswordlessAPIInterface["consumeCodePOST"]>
      >[0];

      await expect(
        apis.consumeCodePOST?.({
          tenantId: "tenant-a",
          options: { req: makeRequest({ tenantId: "tenant-b" }) },
          userContext: { authenticatedSession: true },
        } as unknown as ConsumeCodeInput),
      ).rejects.toBeInstanceOf(RowndConfigResolutionError);
      expect(resolveConfig).not.toHaveBeenCalled();
      expect(originalConsumeCodePOST).not.toHaveBeenCalled();
    });

    it("rejects a query tenant that conflicts with an explicit public recipe tenant", async () => {
      const resolveConfig = vi.fn(async () => ({}));
      const originalConsumeCodePOST = vi.fn();
      const plugin = init({
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
        resolveConfig,
      });
      const apis = plugin.overrideMap.passwordless.apis({
        consumeCodePOST: originalConsumeCodePOST,
      } as unknown as PasswordlessAPIInterface);
      type ConsumeCodeInput = Parameters<
        NonNullable<PasswordlessAPIInterface["consumeCodePOST"]>
      >[0];

      await expect(
        apis.consumeCodePOST?.({
          tenantId: "public",
          options: { req: makeRequest({ tenantId: "tenant-b" }) },
          userContext: {},
        } as unknown as ConsumeCodeInput),
      ).rejects.toBeInstanceOf(RowndConfigResolutionError);
      expect(resolveConfig).not.toHaveBeenCalled();
      expect(originalConsumeCodePOST).not.toHaveBeenCalled();
    });

    it("resolves config once across passwordless consumption and session creation", async () => {
      const { server: s, port } = await setup(coreConnectionURI);
      server = s;
      testPORT = port;
      const user = await Passwordless.signInUp({
        tenantId: "public",
        email: "single-snapshot-chain@example.com",
      });
      const resolveConfig = vi.fn(async () => ({ appConfig: { id: "app" } }));
      type SessionInput = {
        userId: string;
        recipeUserId: typeof user.recipeUserId;
        tenantId: string;
        accessTokenPayload: Record<string, unknown>;
        userContext: Record<string, unknown>;
      };
      type SessionImplementation = {
        createNewSession: (input: SessionInput) => Promise<SessionInput>;
      };
      const plugin = init({
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
        resolveConfig,
      }) as unknown as {
        overrideMap: {
          passwordless: {
            apis: (
              implementation: PasswordlessAPIInterface,
            ) => PasswordlessAPIInterface;
          };
          session: {
            functions: (
              implementation: SessionImplementation,
            ) => SessionImplementation;
          };
        };
      };
      const sessionFunctions = plugin.overrideMap.session.functions({
        createNewSession: async (input) => input,
      });
      const passwordlessApis = plugin.overrideMap.passwordless.apis({
        consumeCodePOST: async (input) => {
          await sessionFunctions.createNewSession({
            userId: user.user.id,
            recipeUserId: user.recipeUserId,
            tenantId: input.tenantId,
            accessTokenPayload: {},
            userContext: input.userContext,
          });
          return { status: "RESTART_FLOW_ERROR" };
        },
      } as unknown as PasswordlessAPIInterface);
      type ConsumeCodeInput = Parameters<
        NonNullable<PasswordlessAPIInterface["consumeCodePOST"]>
      >[0];

      await passwordlessApis.consumeCodePOST?.({
        tenantId: "public",
        options: { req: makeRequest({ tenantId: "public" }) },
        userContext: {},
      } as unknown as ConsumeCodeInput);

      expect(resolveConfig).toHaveBeenCalledTimes(1);
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
      const userContext = {};
      const originalAuthGET = vi.fn().mockImplementation((input) => {
        expect(input.userContext).not.toBe(userContext);
        expect(input.userContext.rowndOAuthAudience).toBe("app:app_123");
        return { redirectTo: "ok" };
      });
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
        options: { req: makeRequest({}) },
        userContext,
      };

      await oauthApis.authGET(input);

      expect(originalAuthGET).toHaveBeenCalledWith(
        expect.objectContaining({
          params: { client_id: "client_123", audience: "app:app_123" },
          userContext: expect.objectContaining({
            rowndOAuthAudience: "app:app_123",
          }),
        }),
      );
      expect(userContext).toEqual({});
    });

    it("translates Rownd OAuth token resource params into audience params", async () => {
      const userContext = {};
      const originalTokenPOST = vi.fn().mockImplementation((input) => {
        expect(input.userContext).not.toBe(userContext);
        expect(input.userContext.rowndOAuthAudience).toBe("app:app_123");
        return { access_token: "token" };
      });
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
        options: { req: makeRequest({}) },
        userContext,
      };

      await oauthApis.tokenPOST(input);

      expect(originalTokenPOST).toHaveBeenCalledWith(
        expect.objectContaining({
          body: { grant_type: "client_credentials", audience: "app:app_123" },
          userContext: expect.objectContaining({
            rowndOAuthAudience: "app:app_123",
          }),
        }),
      );
      expect(userContext).toEqual({});
    });

    it("shadows a stale OAuth audience when the request omits it", async () => {
      const userContext = { rowndOAuthAudience: "app:stale" };
      const originalAuthGET = vi.fn().mockImplementation((input) => {
        expect(input.userContext).not.toBe(userContext);
        expect(input.userContext).toHaveProperty(
          "rowndOAuthAudience",
          undefined,
        );
        return { redirectTo: "ok" };
      });
      const oauthApis = (
        init({
          rowndAppKey: "test-key",
          rowndAppSecret: "test-secret",
        }) as any
      ).overrideMap.oauth2provider.apis({ authGET: originalAuthGET });

      await oauthApis.authGET({
        params: { client_id: "client_123" },
        options: { req: makeRequest({}) },
        userContext,
      });

      expect(userContext.rowndOAuthAudience).toBe("app:stale");
    });

    it("resolves once per OAuth operation and re-resolves a reused context for another tenant", async () => {
      const resolveConfig = vi.fn(async ({ tenantId }) => ({
        appConfig: { id: `app-${tenantId}` },
      }));
      const operationContexts: Array<Record<PropertyKey, unknown>> = [];
      const plugin = init({
        rowndAppKey: "test-key",
        rowndAppSecret: "test-secret",
        resolveConfig,
      });
      const oauthFunctions = plugin.overrideMap.oauth2provider.functions({
        buildAccessTokenPayload: vi.fn().mockResolvedValue({}),
      });
      const originalAuthGET = vi.fn().mockImplementation(async (input) => {
        operationContexts.push(input.userContext);
        await oauthFunctions.buildAccessTokenPayload({
          user: undefined,
          client: {},
          sessionHandle: undefined,
          scopes: [],
          userContext: input.userContext,
        });
        return { redirectTo: "ok" };
      });
      const oauthApis = plugin.overrideMap.oauth2provider.apis({
        authGET: originalAuthGET,
      });

      await oauthApis.authGET({
        params: { client_id: "client_123" },
        options: { req: makeRequest({ tenantId: "tenant-a" }) },
        userContext: {},
      });
      await oauthApis.authGET({
        params: { client_id: "client_123" },
        options: { req: makeRequest({ tenantId: "tenant-b" }) },
        userContext: operationContexts[0],
      });

      expect(
        resolveConfig.mock.calls.map(([context]) => context.tenantId),
      ).toEqual(["tenant-a", "tenant-b"]);
      expect(JSON.stringify(operationContexts)).not.toContain("test-key");
      expect(JSON.stringify(operationContexts)).not.toContain("test-secret");
      for (const context of operationContexts) {
        const symbols = Object.getOwnPropertySymbols(context);
        expect(
          JSON.stringify(symbols.map((symbol) => context[symbol])),
        ).not.toContain("test-secret");
      }
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
        vi.spyOn(SuperTokens, "getUserIdMapping").mockResolvedValue({
          status: "UNKNOWN_MAPPING_ERROR",
        });
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

      it("reconciles a fresh Google identity and Rownd passwordless email to its existing primary ThirdParty owner", async () => {
        const { server: s, port } = await setup(
          importCoreConnectionURI,
          undefined,
          { enableEmailVerification: true },
        );
        server = s;
        testPORT = port;
        const rowndUserId = "rownd-thirdparty-email-owner-collision";
        const appleId = "apple-email-owner-collision";
        const googleId = "google-thirdparty-email-owner-collision";
        const email = "thirdparty-email-owner-collision@example.com";
        const thirdPartyUser = await ThirdParty.manuallyCreateOrUpdateUser(
          "public",
          "apple",
          appleId,
          email,
          true,
        );
        expect(thirdPartyUser.status).toBe("OK");
        if (thirdPartyUser.status !== "OK") {
          throw new Error("failed to create ThirdParty user");
        }
        await expect(
          AccountLinking.createPrimaryUser(thirdPartyUser.recipeUserId),
        ).resolves.toMatchObject({ status: "OK" });
        const existingOwner = await SuperTokens.getUser(thirdPartyUser.user.id);
        expect(existingOwner?.isPrimaryUser).toBe(true);
        expect(existingOwner?.loginMethods).toEqual([
          expect.objectContaining({
            recipeId: "thirdparty",
            email,
            verified: true,
            thirdParty: { id: "apple", userId: appleId },
          }),
        ]);

        mockRowndClient.validateToken.mockResolvedValue({
          user_id: rowndUserId,
        });
        mockRowndClient.fetchUserInfo.mockResolvedValue({
          app_user_id: rowndUserId,
          auth_level: "verified",
          data: {
            user_id: rowndUserId,
            google_id: googleId,
            email,
          },
          verified_data: { google_id: true, email: true },
        });
        const fetchSpy = vi.spyOn(global, "fetch");

        const response = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/migrate`,
          {
            method: "POST",
            headers: { Authorization: "Bearer some-token" },
          },
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ status: "OK" });
        await expect(
          SuperTokens.getUserIdMapping({
            userId: rowndUserId,
            userIdType: "EXTERNAL",
          }),
        ).resolves.toMatchObject({
          status: "OK",
          superTokensUserId: thirdPartyUser.user.id,
        });
        const migratedUser = await SuperTokens.getUser(rowndUserId);
        expect(migratedUser?.isPrimaryUser).toBe(true);
        expect(migratedUser?.loginMethods).toHaveLength(3);
        expect(migratedUser?.loginMethods).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              recipeId: "thirdparty",
              email,
              verified: true,
              thirdParty: { id: "apple", userId: appleId },
            }),
            expect.objectContaining({
              recipeId: "passwordless",
              email,
              verified: true,
            }),
            expect.objectContaining({
              recipeId: "thirdparty",
              thirdParty: { id: "google", userId: googleId },
            }),
          ]),
        );
        await expect(
          SuperTokens.listUsersByAccountInfo("public", { email }, false),
        ).resolves.toHaveLength(1);
        await expect(
          SuperTokens.listUsersByAccountInfo(
            "public",
            { thirdParty: { id: "google", userId: googleId } },
            false,
          ),
        ).resolves.toHaveLength(1);
        expect(
          fetchSpy.mock.calls.some(([input]) =>
            String(input).includes("/bulk-import/import"),
          ),
        ).toBe(false);

        const repeatedResponse = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/migrate`,
          {
            method: "POST",
            headers: { Authorization: "Bearer some-token" },
          },
        );
        expect(repeatedResponse.status).toBe(200);
        await expect(repeatedResponse.json()).resolves.toEqual({ status: "OK" });
        const repeatedUser = await SuperTokens.getUser(rowndUserId);
        expect(repeatedUser?.loginMethods).toHaveLength(3);
        expect(repeatedUser).toMatchObject({
          isPrimaryUser: true,
          loginMethods: expect.arrayContaining([
            expect.objectContaining({ recipeId: "passwordless" }),
            expect.objectContaining({
              recipeId: "thirdparty",
              thirdParty: { id: "apple", userId: appleId },
            }),
            expect.objectContaining({
              recipeId: "thirdparty",
              thirdParty: { id: "google", userId: googleId },
            }),
          ]),
        });
      });

      it("reconciles an unverified Rownd email with its existing passwordless account", async () => {
        const { server: s, port } = await setup(
          importCoreConnectionURI,
          undefined,
          { enableEmailVerification: true },
        );
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
        expect(session.getUserId()).toBe("rownd-unverified-email-collision");

        await expect(
          SuperTokens.getUserIdMapping({
            userId: "rownd-unverified-email-collision",
            userIdType: "EXTERNAL",
          }),
        ).resolves.toMatchObject({
          status: "OK",
          superTokensUserId: existingUser.user.id,
        });
        const migratedUser = await SuperTokens.getUser(
          "rownd-unverified-email-collision",
        );
        expect(migratedUser?.loginMethods).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ recipeId: "passwordless", email }),
            expect.objectContaining({
              recipeId: "thirdparty",
              thirdParty: {
                id: "google",
                userId: "google-unverified-email-collision",
              },
            }),
          ]),
        );
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
        ).resolves.toHaveLength(1);
      });

      it("retains a linked method when email unverification fails", async () => {
        const { server: s, port } = await setup(
          importCoreConnectionURI,
          undefined,
          { enableEmailVerification: true },
        );
        server = s;
        testPORT = port;
        const suffix = randomUUID();
        const rowndUserId = `rownd-unverify-failure-${suffix}`;
        const googleId = `google-unverify-failure-${suffix}`;
        const email = `unverify-failure-${suffix}@example.com`;
        const provider = await ThirdParty.manuallyCreateOrUpdateUser(
          "public",
          "google",
          googleId,
          `provider-unverify-failure-${suffix}@example.com`,
          true,
        );
        expect(provider.status).toBe("OK");
        if (provider.status !== "OK") {
          throw new Error("failed to create provider user");
        }
        mockRowndClient.validateToken.mockResolvedValue({
          user_id: rowndUserId,
        });
        mockRowndClient.fetchUserInfo.mockResolvedValue({
          app_user_id: rowndUserId,
          data: { user_id: rowndUserId, google_id: googleId, email },
          verified_data: { google_id: true },
        });
        const originalUnverifyEmail = EmailVerification.unverifyEmail;
        const unverifyEmail = vi
          .spyOn(EmailVerification, "unverifyEmail")
          .mockRejectedValueOnce(new Error("unverification failed"))
          .mockImplementation((...args) => originalUnverifyEmail(...args));

        const response = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/migrate`,
          {
            method: "POST",
            headers: { Authorization: "Bearer some-token" },
          },
        );

        await expect(response.json()).resolves.toEqual({
          status: "ERROR",
          message: "Migration failed",
        });
        const retainedUser = await SuperTokens.getUser(provider.user.id);
        expect(retainedUser?.loginMethods).toHaveLength(2);
        expect(retainedUser?.loginMethods).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              recipeId: "thirdparty",
              thirdParty: { id: "google", userId: googleId },
            }),
            expect.objectContaining({ recipeId: "passwordless", email }),
          ]),
        );
        await expect(
          SuperTokens.getUserIdMapping({
            userId: rowndUserId,
            userIdType: "EXTERNAL",
          }),
        ).resolves.toMatchObject({
          status: "OK",
          superTokensUserId: provider.user.id,
        });

        const retryResponse = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/migrate`,
          {
            method: "POST",
            headers: { Authorization: "Bearer some-token" },
          },
        );
        expect(retryResponse.status).toBe(200);
        await expect(retryResponse.json()).resolves.toEqual({ status: "OK" });
        expect(unverifyEmail).toHaveBeenCalledTimes(2);

        const mapping = await SuperTokens.getUserIdMapping({
          userId: rowndUserId,
          userIdType: "EXTERNAL",
        });
        expect(mapping.status).toBe("OK");
        if (mapping.status !== "OK") {
          throw new Error("missing Rownd user ID mapping");
        }
        const migratedUser = await SuperTokens.getUser(rowndUserId);
        expect(
          migratedUser?.loginMethods.find(
            (method) =>
              method.recipeId === "passwordless" && method.email === email,
          )?.verified,
        ).toBe(false);
        await expect(
          UserMetadata.getUserMetadata(mapping.superTokensUserId),
        ).resolves.toMatchObject({
          metadata: { rownd_migration_complete: true },
        });
      });

      it("upgrades a retained unverified method when the Rownd snapshot becomes verified", async () => {
        const { server: s, port } = await setup(
          importCoreConnectionURI,
          undefined,
          { enableEmailVerification: true },
        );
        server = s;
        testPORT = port;
        const suffix = randomUUID();
        const rowndUserId = `rownd-verification-upgrade-${suffix}`;
        const googleId = `google-verification-upgrade-${suffix}`;
        const email = `verification-upgrade-${suffix}@example.com`;
        const provider = await ThirdParty.manuallyCreateOrUpdateUser(
          "public",
          "google",
          googleId,
          `provider-verification-upgrade-${suffix}@example.com`,
          true,
        );
        expect(provider.status).toBe("OK");
        if (provider.status !== "OK") {
          throw new Error("failed to create provider user");
        }
        mockRowndClient.validateToken.mockResolvedValue({
          user_id: rowndUserId,
        });
        const unverifiedRowndUser = {
          app_user_id: rowndUserId,
          data: { user_id: rowndUserId, google_id: googleId, email },
          verified_data: { google_id: true },
        };
        mockRowndClient.fetchUserInfo.mockResolvedValue(unverifiedRowndUser);
        const originalUpdateUserMetadata = UserMetadata.updateUserMetadata;
        vi.spyOn(UserMetadata, "updateUserMetadata")
          .mockRejectedValueOnce(new Error("metadata finalization failed"))
          .mockImplementation((...args) => originalUpdateUserMetadata(...args));

        const firstResponse = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/migrate`,
          {
            method: "POST",
            headers: { Authorization: "Bearer some-token" },
          },
        );
        await expect(firstResponse.json()).resolves.toEqual({
          status: "ERROR",
          message: "Migration failed",
        });
        expect(
          (await SuperTokens.getUser(rowndUserId))?.loginMethods.find(
            (method) =>
              method.recipeId === "passwordless" && method.email === email,
          )?.verified,
        ).toBe(false);

        mockRowndClient.fetchUserInfo.mockResolvedValue({
          ...unverifiedRowndUser,
          verified_data: { google_id: true, email: true },
        });
        const retryResponse = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/migrate`,
          {
            method: "POST",
            headers: { Authorization: "Bearer some-token" },
          },
        );
        expect(retryResponse.status).toBe(200);
        await expect(retryResponse.json()).resolves.toEqual({ status: "OK" });

        const mapping = await SuperTokens.getUserIdMapping({
          userId: rowndUserId,
          userIdType: "EXTERNAL",
        });
        expect(mapping.status).toBe("OK");
        if (mapping.status !== "OK") {
          throw new Error("missing Rownd user ID mapping");
        }
        expect(
          (await SuperTokens.getUser(rowndUserId))?.loginMethods.find(
            (method) =>
              method.recipeId === "passwordless" && method.email === email,
          )?.verified,
        ).toBe(true);
        await expect(
          UserMetadata.getUserMetadata(mapping.superTokensUserId),
        ).resolves.toMatchObject({
          metadata: { rownd_migration_complete: true },
        });
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
          SuperTokens.listUsersByAccountInfo("public", { phoneNumber }, false),
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

      it("links existing provider and passwordless users for a Rownd-verified email", async () => {
        const { server: s, port } = await setup(
          importCoreConnectionURI,
          undefined,
          { enableEmailVerification: true },
        );
        server = s;
        testPORT = port;
        const rowndUserId = "rownd-verified-email-owners";
        const googleId = "google-verified-email-owners";
        const email = "verified-email-owners@example.com";
        const providerUser = await ThirdParty.manuallyCreateOrUpdateUser(
          "public",
          "google",
          googleId,
          "provider-verified-email-owners@example.com",
          true,
        );
        expect(providerUser.status).toBe("OK");
        if (providerUser.status !== "OK") {
          throw new Error("failed to create provider user");
        }
        const passwordlessUser = await Passwordless.signInUp({
          tenantId: "public",
          email,
        });
        expect(providerUser.user.id).not.toBe(passwordlessUser.user.id);

        mockRowndClient.validateToken.mockResolvedValue({
          user_id: rowndUserId,
        });
        mockRowndClient.fetchUserInfo.mockResolvedValue({
          app_user_id: rowndUserId,
          auth_level: "verified",
          data: {
            user_id: rowndUserId,
            google_id: googleId,
            email,
          },
          verified_data: {
            google_id: true,
            email: true,
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
        expect(session.getUserId()).toBe(rowndUserId);
        await expect(
          SuperTokens.getUserIdMapping({
            userId: rowndUserId,
            userIdType: "EXTERNAL",
          }),
        ).resolves.toMatchObject({
          status: "OK",
          superTokensUserId: providerUser.user.id,
        });

        const migratedUser = await SuperTokens.getUser(rowndUserId);
        expect(migratedUser?.isPrimaryUser).toBe(true);
        expect(migratedUser?.loginMethods).toHaveLength(2);
        expect(
          migratedUser?.loginMethods
            .find((method) => method.recipeId === "thirdparty")
            ?.recipeUserId.getAsString(),
        ).toBe(rowndUserId);
        expect(
          migratedUser?.loginMethods
            .find((method) => method.recipeId === "passwordless")
            ?.recipeUserId.getAsString(),
        ).toBe(passwordlessUser.recipeUserId.getAsString());
        expect(migratedUser?.loginMethods).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              recipeId: "thirdparty",
              thirdParty: { id: "google", userId: googleId },
            }),
            expect.objectContaining({
              recipeId: "passwordless",
              email,
              verified: true,
            }),
          ]),
        );
        await expect(
          SuperTokens.listUsersByAccountInfo(
            "public",
            { thirdParty: { id: "google", userId: googleId } },
            false,
          ),
        ).resolves.toHaveLength(1);
        await expect(
          SuperTokens.listUsersByAccountInfo("public", { email }, false),
        ).resolves.toHaveLength(1);
      });

      it("normalizes an externalized passwordless owner created by a sibling reconciliation", async () => {
        const { server: s, port } = await setup(importCoreConnectionURI);
        server = s;
        testPORT = port;
        const suffix = randomUUID();
        const rowndUserId = `rownd-concurrent-passwordless-${suffix}`;
        const googleId = `google-concurrent-passwordless-${suffix}`;
        const email = `concurrent-passwordless-${suffix}@example.com`;
        const rowndUser = {
          app_user_id: rowndUserId,
          data: { user_id: rowndUserId, google_id: googleId, email },
          verified_data: { google_id: true, email: true },
        };
        const provider = await ThirdParty.manuallyCreateOrUpdateUser(
          "public",
          "google",
          googleId,
          `provider-${suffix}@example.com`,
          true,
        );
        expect(provider.status).toBe("OK");
        if (provider.status !== "OK") {
          throw new Error("failed to create provider user");
        }
        mockRowndClient.validateToken.mockResolvedValue({
          user_id: rowndUserId,
        });
        mockRowndClient.fetchUserInfo.mockResolvedValue(rowndUser);

        let notifyParentPaused!: () => void;
        const parentPaused = new Promise<void>((resolve) => {
          notifyParentPaused = resolve;
        });
        let resumeParent!: () => void;
        const parentResume = new Promise<void>((resolve) => {
          resumeParent = resolve;
        });
        const originalSignInUp = Passwordless.signInUp;
        let invocationCount = 0;
        let parentSignInUpResult:
          Awaited<ReturnType<typeof Passwordless.signInUp>> | undefined;
        vi.spyOn(Passwordless, "signInUp").mockImplementation(async (input) => {
          invocationCount += 1;
          const isParent = invocationCount === 1;
          if (isParent) {
            notifyParentPaused();
            await parentResume;
          }
          const result = await originalSignInUp(input);
          if (isParent) {
            parentSignInUpResult = result;
          }
          return result;
        });

        const parentRequest = fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/migrate`,
          {
            method: "POST",
            headers: { Authorization: "Bearer some-token" },
          },
        );
        await parentPaused;
        try {
          await expect(
            reconcileRowndUserWithExistingLoginMethods(
              mapRowndUserToSuperTokens(rowndUser as any),
              "public",
              {},
            ),
          ).resolves.toBe(true);
        } finally {
          resumeParent();
        }

        const parentResponse = await parentRequest;
        expect(parentResponse.status).toBe(200);
        await expect(parentResponse.json()).resolves.toEqual({ status: "OK" });
        expect(parentSignInUpResult?.createdNewRecipeUser).toBe(false);
        expect(parentSignInUpResult?.user.id).toBe(rowndUserId);

        const mapping = await SuperTokens.getUserIdMapping({
          userId: rowndUserId,
          userIdType: "EXTERNAL",
        });
        expect(mapping.status).toBe("OK");
        if (mapping.status !== "OK") {
          throw new Error("missing Rownd user ID mapping");
        }
        expect(mapping.superTokensUserId).toBe(provider.user.id);
        const migratedUser = await SuperTokens.getUser(rowndUserId);
        expect(migratedUser?.loginMethods).toHaveLength(2);
        expect(
          new Set(migratedUser?.loginMethods.map((method) => method.recipeId)),
        ).toEqual(new Set(["thirdparty", "passwordless"]));
        const methodIds = migratedUser?.loginMethods
          .map((method) => method.recipeUserId.getAsString())
          .sort();
        await expect(
          SuperTokens.listUsersByAccountInfo(
            "public",
            { thirdParty: { id: "google", userId: googleId } },
            false,
          ),
        ).resolves.toHaveLength(1);
        await expect(
          SuperTokens.listUsersByAccountInfo("public", { email }, false),
        ).resolves.toHaveLength(1);
        await expect(
          UserMetadata.getUserMetadata(mapping.superTokensUserId),
        ).resolves.toMatchObject({
          metadata: { rownd_migration_complete: true },
        });

        const repeatedResponse = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/migrate`,
          {
            method: "POST",
            headers: { Authorization: "Bearer some-token" },
          },
        );
        await expect(repeatedResponse.json()).resolves.toEqual({
          status: "OK",
        });
        const repeatedUser = await SuperTokens.getUser(rowndUserId);
        expect(
          repeatedUser?.loginMethods
            .map((method) => method.recipeUserId.getAsString())
            .sort(),
        ).toEqual(methodIds);
      });

      it("rejects a foreign mapping winner before creating missing identities", async () => {
        const { server: s, port } = await setup(importCoreConnectionURI);
        server = s;
        testPORT = port;
        const suffix = randomUUID();
        const rowndUserId = `rownd-mapping-lock-${suffix}`;
        const parentGoogleId = `google-mapping-lock-parent-${suffix}`;
        const siblingGoogleId = `google-mapping-lock-sibling-${suffix}`;
        const phoneNumber = "+15555550132";
        const parentProvider = await ThirdParty.manuallyCreateOrUpdateUser(
          "public",
          "google",
          parentGoogleId,
          `mapping-lock-parent-${suffix}@example.com`,
          true,
        );
        const siblingProvider = await ThirdParty.manuallyCreateOrUpdateUser(
          "public",
          "google",
          siblingGoogleId,
          `mapping-lock-sibling-${suffix}@example.com`,
          true,
        );
        expect(parentProvider.status).toBe("OK");
        expect(siblingProvider.status).toBe("OK");
        if (parentProvider.status !== "OK" || siblingProvider.status !== "OK") {
          throw new Error("failed to create mapping lock providers");
        }

        let notifyParentAtMapping!: () => void;
        const parentAtMapping = new Promise<void>((resolve) => {
          notifyParentAtMapping = resolve;
        });
        let resumeParent!: () => void;
        const parentResume = new Promise<void>((resolve) => {
          resumeParent = resolve;
        });
        const originalCreateUserIdMapping = SuperTokens.createUserIdMapping;
        let mappingCreateCount = 0;
        vi.spyOn(SuperTokens, "createUserIdMapping").mockImplementation(
          async (input) => {
            mappingCreateCount += 1;
            if (mappingCreateCount === 1) {
              notifyParentAtMapping();
              await parentResume;
            }
            return originalCreateUserIdMapping(input);
          },
        );
        const parentReconciliation = reconcileRowndUserWithExistingLoginMethods(
          {
            externalUserId: rowndUserId,
            loginMethods: [
              {
                recipeId: "thirdparty",
                thirdPartyId: "google",
                thirdPartyUserId: parentGoogleId,
                email: `mapping-lock-parent-${suffix}@example.com`,
                isVerified: true,
              },
              {
                recipeId: "passwordless",
                phoneNumber,
                isVerified: true,
              },
            ],
            userMetadata: { rownd_migration_complete: true },
          },
          "public",
          {},
        );
        await parentAtMapping;
        try {
          await expect(
            reconcileRowndUserWithExistingLoginMethods(
              {
                externalUserId: rowndUserId,
                loginMethods: [
                  {
                    recipeId: "thirdparty",
                    thirdPartyId: "google",
                    thirdPartyUserId: siblingGoogleId,
                    email: `mapping-lock-sibling-${suffix}@example.com`,
                    isVerified: true,
                  },
                ],
                userMetadata: { rownd_migration_complete: true },
              },
              "public",
              {},
            ),
          ).resolves.toBe(true);
        } finally {
          resumeParent();
        }

        await expect(parentReconciliation).rejects.toThrow(
          "Failed to map migrated Rownd user ID",
        );
        const losingProvider = await SuperTokens.getUser(
          parentProvider.user.id,
        );
        expect(losingProvider?.isPrimaryUser).toBe(false);
        expect(losingProvider?.loginMethods).toEqual([
          expect.objectContaining({
            recipeId: "thirdparty",
            thirdParty: { id: "google", userId: parentGoogleId },
          }),
        ]);
        await expect(
          SuperTokens.listUsersByAccountInfo("public", { phoneNumber }, false),
        ).resolves.toHaveLength(0);
        await expect(
          SuperTokens.getUserIdMapping({
            userId: rowndUserId,
            userIdType: "EXTERNAL",
          }),
        ).resolves.toMatchObject({
          status: "OK",
          superTokensUserId: siblingProvider.user.id,
        });
      });

      it("does not roll back sibling state when parent finalization fails", async () => {
        const { server: s, port } = await setup(importCoreConnectionURI);
        server = s;
        testPORT = port;
        const suffix = randomUUID();
        const rowndUserId = `rownd-concurrent-finalization-${suffix}`;
        const googleId = `google-concurrent-finalization-${suffix}`;
        const phoneNumber = "+15555550131";
        const rowndUser = {
          app_user_id: rowndUserId,
          data: {
            user_id: rowndUserId,
            google_id: googleId,
            phone_number: phoneNumber,
          },
          verified_data: { google_id: true, phone_number: true },
        };
        await ThirdParty.manuallyCreateOrUpdateUser(
          "public",
          "google",
          googleId,
          `finalization-provider-${suffix}@example.com`,
          true,
        );
        mockRowndClient.validateToken.mockResolvedValue({
          user_id: rowndUserId,
        });
        mockRowndClient.fetchUserInfo.mockResolvedValue(rowndUser);

        let notifyParentFinalizing!: () => void;
        const parentFinalizing = new Promise<void>((resolve) => {
          notifyParentFinalizing = resolve;
        });
        let releaseParent!: () => void;
        const parentRelease = new Promise<void>((resolve) => {
          releaseParent = resolve;
        });
        const originalUpdateUserMetadata = UserMetadata.updateUserMetadata;
        let updateCount = 0;
        vi.spyOn(UserMetadata, "updateUserMetadata").mockImplementation(
          async (...args) => {
            updateCount += 1;
            if (updateCount === 1) {
              notifyParentFinalizing();
              await parentRelease;
              throw new Error("parent metadata finalization failed");
            }
            return originalUpdateUserMetadata(...args);
          },
        );

        const parentRequest = fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/migrate`,
          {
            method: "POST",
            headers: { Authorization: "Bearer some-token" },
          },
        );
        await parentFinalizing;
        try {
          await expect(
            reconcileRowndUserWithExistingLoginMethods(
              mapRowndUserToSuperTokens(rowndUser as any),
              "public",
              {},
            ),
          ).resolves.toBe(true);
        } finally {
          releaseParent();
        }

        const parentResponse = await parentRequest;
        await expect(parentResponse.json()).resolves.toEqual({
          status: "ERROR",
          message: "Migration failed",
        });
        const mapping = await SuperTokens.getUserIdMapping({
          userId: rowndUserId,
          userIdType: "EXTERNAL",
        });
        expect(mapping.status).toBe("OK");
        const migratedUser = await SuperTokens.getUser(rowndUserId);
        expect(migratedUser?.loginMethods).toHaveLength(2);
        expect(
          migratedUser?.loginMethods.some(
            (method) => method.phoneNumber === phoneNumber,
          ),
        ).toBe(true);
        if (mapping.status !== "OK") {
          throw new Error("missing Rownd user ID mapping");
        }
        await expect(
          UserMetadata.getUserMetadata(mapping.superTokensUserId),
        ).resolves.toMatchObject({
          metadata: { rownd_migration_complete: true },
        });
      });

      it("does not link a verified email owner mapped to another Rownd user", async () => {
        const { server: s, port } = await setup(importCoreConnectionURI);
        server = s;
        testPORT = port;
        const rowndUserId = "rownd-conflicting-email-owner";
        const existingRowndUserId = "rownd-existing-email-owner";
        const googleId = "google-conflicting-email-owner";
        const email = "conflicting-email-owner@example.com";
        const providerUser = await ThirdParty.manuallyCreateOrUpdateUser(
          "public",
          "google",
          googleId,
          "provider-conflicting-email-owner@example.com",
          true,
        );
        expect(providerUser.status).toBe("OK");
        if (providerUser.status !== "OK") {
          throw new Error("failed to create provider user");
        }
        const passwordlessUser = await Passwordless.signInUp({
          tenantId: "public",
          email,
        });
        await expect(
          SuperTokens.createUserIdMapping({
            superTokensUserId: passwordlessUser.user.id,
            externalUserId: existingRowndUserId,
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
            email,
          },
          verified_data: {
            google_id: true,
            email: true,
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

        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toEqual({
          status: "ERROR",
          message: "Migration failed",
        });
        expect(res.headers.get("st-access-token")).toBeNull();
        expect(
          (await SuperTokens.getUser(providerUser.user.id))?.loginMethods,
        ).toHaveLength(1);
        expect(
          (await SuperTokens.getUser(existingRowndUserId))?.loginMethods,
        ).toHaveLength(1);
        await expect(
          SuperTokens.getUserIdMapping({
            userId: rowndUserId,
            userIdType: "EXTERNAL",
          }),
        ).resolves.toEqual({ status: "UNKNOWN_MAPPING_ERROR" });
        await expect(
          SuperTokens.getUserIdMapping({
            userId: existingRowndUserId,
            userIdType: "EXTERNAL",
          }),
        ).resolves.toMatchObject({
          status: "OK",
          superTokensUserId: passwordlessUser.user.id,
        });
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
      it("resolves isolated tenant app config and schema snapshots", async () => {
        const resolverContexts: Array<{
          tenantId?: string;
          userContext: Record<string, unknown>;
        }> = [];
        const { server: s, port } = await setup(coreConnectionURI, {
          appConfig: { id: "static", name: "Static fallback" },
          resolveConfig: async (context) => {
            resolverContexts.push(context);
            if (context.tenantId === "tenant-slow") {
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
            return {
              appConfig: {
                id: context.tenantId,
                name: `App ${context.tenantId}`,
              },
              schema: {
                [context.tenantId ?? "unknown"]: {
                  display_name: context.tenantId ?? "unknown",
                  type: "string",
                },
              },
            };
          },
        });
        server = s;
        testPORT = port;

        const [slowResponse, fastResponse] = await Promise.all([
          fetch(
            `http://localhost:${testPORT}/auth/plugin/rownd/app-config?tenantId=tenant-slow`,
          ),
          fetch(
            `http://localhost:${testPORT}/auth/plugin/rownd/app-config?tenantId=tenant-fast`,
          ),
        ]);
        const [slow, fast] = await Promise.all([
          slowResponse.json(),
          fastResponse.json(),
        ]);

        expect(slow.app).toMatchObject({
          id: "tenant-slow",
          name: "App tenant-slow",
        });
        expect(slow.app.schema).toHaveProperty("tenant-slow");
        expect(slow.app.schema).not.toHaveProperty("tenant-fast");
        expect(fast.app).toMatchObject({
          id: "tenant-fast",
          name: "App tenant-fast",
        });
        expect(fast.app.schema).toHaveProperty("tenant-fast");
        expect(fast.app.schema).not.toHaveProperty("tenant-slow");
        expect(resolverContexts).toHaveLength(2);
        expect(resolverContexts.every(({ userContext }) => userContext)).toBe(
          true,
        );
      });

      it("surfaces resolver failures without falling back to another tenant", async () => {
        const { server: s, port } = await setup(coreConnectionURI, {
          appConfig: { id: "static" },
          resolveConfig: async () => {
            throw new Error("config unavailable");
          },
        });
        server = s;
        testPORT = port;

        const response = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/app-config?tenantId=tenant-error`,
        );

        expect(response.status).toBe(500);
        const body = await response.text();
        expect(body).not.toContain("config unavailable");
      });

      it("rejects malformed dynamic app config with a controlled error", async () => {
        const { server: s, port } = await setup(coreConnectionURI, {
          resolveConfig: async () =>
            ({ appConfig: "invalid" }) as unknown as RowndPluginDynamicConfig,
        });
        server = s;
        testPORT = port;

        const response = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/app-config?tenantId=tenant-invalid`,
        );
        const body = await response.text();

        expect(response.status).toBe(500);
        expect(body).not.toContain("appConfig must be an object");
      });

      it("rejects reserved dynamic session claim names", async () => {
        const { server: s, port } = await setup(coreConnectionURI, {
          resolveConfig: async () => ({
            schema: {
              attacker: {
                display_name: "Attacker",
                type: "string",
                user_visible: false,
                include_in_session_claims: true,
                session_claim_name: "sub",
              },
            },
          }),
        });
        server = s;
        testPORT = port;

        const response = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/app-config?tenantId=tenant-invalid`,
        );
        const body = await response.text();

        expect(response.status).toBe(500);
        expect(body).not.toContain("session_claim_name is reserved");
      });

      it.each([
        [
          "unsupported method IDs",
          { appConfig: { signInMethods: [{ method: "bad method" }] } },
        ],
        [
          "malformed Google One Tap config",
          {
            appConfig: {
              signInMethods: [
                { method: "google", oneTap: { browser: "invalid" } },
              ],
            },
          },
        ],
        [
          "duplicate method IDs",
          {
            appConfig: {
              signInMethods: [{ method: "email" }, { method: "email" }],
            },
          },
        ],
        [
          "invalid signInFasterWithGoogle",
          {
            appConfig: {
              signInMethods: [
                { method: "google", signInFasterWithGoogle: "sometimes" },
              ],
            },
          },
        ],
        [
          "malformed Apple client ID",
          {
            appConfig: {
              signInMethods: [{ method: "apple", clientId: 123 }],
            },
          },
        ],
        [
          "malformed Apple client type",
          {
            appConfig: {
              signInMethods: [{ method: "apple", webClientType: false }],
            },
          },
        ],
        [
          "malformed provider display name",
          {
            appConfig: {
              signInMethods: [{ method: "github", displayName: 123 }],
            },
          },
        ],
        [
          "malformed anonymous icon",
          {
            appConfig: {
              signInMethods: [{ method: "anonymous", iconLightUrl: false }],
            },
          },
        ],
      ])("rejects %s from the dynamic provider", async (_name, config) => {
        const { server: s, port } = await setup(coreConnectionURI, {
          resolveConfig: async () =>
            config as unknown as RowndPluginDynamicConfig,
        });
        server = s;
        testPORT = port;

        const response = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/app-config?tenantId=tenant-invalid`,
        );

        expect(response.status).toBe(500);
      });

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

      it("uses legacy app variants for a static non-public tenant without scoped data", async () => {
        const { server: s, port } = await setup(coreConnectionURI, {
          subBrands: {
            variant_legacy: {
              id: "app_xyz",
              variant: { id: "variant_legacy" },
            },
            variant_new: {
              id: "app_xyz",
              variant: { id: "variant_new" },
            },
          },
        });
        server = s;
        testPORT = port;
        const result = await Passwordless.signInUp({
          email: "static-legacy-variant@example.com",
          tenantId: "public",
        });
        await MultiTenancy.createOrUpdateTenant("tenant-static");
        await MultiTenancy.associateUserToTenant(
          "tenant-static",
          result.recipeUserId,
        );
        await UserMetadata.updateUserMetadata(result.user.id, {
          original_rownd_user: {
            data: { user_id: result.user.id },
            verified_data: {},
            attributes: { "rownd:app_variants": ["variant_legacy"] },
          },
        });
        await recordRowndAppVariantForUser(
          result.user.id,
          "variant_new",
          {},
          "tenant-static",
        );

        const user = await getUserById(result.user.id, "tenant-static", {});

        expect(user.attributes["rownd:app_variants"]).toEqual([
          "variant_legacy",
          "variant_new",
        ]);
      });

      it.each([
        {
          description: "subBrands is absent",
          suffix: "absent",
          config: {},
        },
        {
          description: "subBrands excludes the legacy variant",
          suffix: "excluded",
          config: {
            subBrands: {
              variant_other: {
                id: "app_xyz",
                variant: { id: "variant_other" },
              },
            },
          },
        },
      ])(
        "preserves legacy app variants for a static non-public tenant when $description",
        async ({ config, suffix }) => {
          const { server: s, port } = await setup(coreConnectionURI, config);
          server = s;
          testPORT = port;
          const result = await Passwordless.signInUp({
            email: `static-legacy-variant-${suffix}@example.com`,
            tenantId: "public",
          });
          const tenantId = `tenant-static-${suffix}`;
          await MultiTenancy.createOrUpdateTenant(tenantId);
          await MultiTenancy.associateUserToTenant(
            tenantId,
            result.recipeUserId,
          );
          await UserMetadata.updateUserMetadata(result.user.id, {
            original_rownd_user: {
              data: { user_id: result.user.id },
              verified_data: {},
              attributes: { "rownd:app_variants": ["variant_legacy"] },
            },
          });

          const user = await getUserById(result.user.id, tenantId, {});

          expect(user.attributes["rownd:app_variants"]).toEqual([
            "variant_legacy",
          ]);
        },
      );

      it("does not use legacy app variants for a dynamic non-public tenant", async () => {
        const { server: s, port } = await setup(coreConnectionURI, {
          resolveConfig: async () => ({
            subBrands: {
              variant_legacy: {
                id: "app_xyz",
                variant: { id: "variant_legacy" },
              },
            },
          }),
        });
        server = s;
        testPORT = port;
        const result = await Passwordless.signInUp({
          email: "dynamic-legacy-variant@example.com",
          tenantId: "public",
        });
        await MultiTenancy.createOrUpdateTenant("tenant-dynamic");
        await MultiTenancy.associateUserToTenant(
          "tenant-dynamic",
          result.recipeUserId,
        );
        await UserMetadata.updateUserMetadata(result.user.id, {
          original_rownd_user: {
            data: { user_id: result.user.id },
            verified_data: {},
            attributes: { "rownd:app_variants": ["variant_legacy"] },
          },
        });
        const config = getPluginConfig();
        if (!config) {
          throw new Error("Rownd plugin config was not initialized");
        }
        const resolved = await resolvePluginConfigSnapshot(config, {
          tenantId: "tenant-dynamic",
          userContext: {},
        });

        const user = await getUserById(
          result.user.id,
          "tenant-dynamic",
          resolved.userContext,
        );

        expect(user.attributes["rownd:app_variants"]).toEqual([]);
      });

      it("stores the same app variant ID independently for two tenants", async () => {
        const { server: s, port } = await setup(coreConnectionURI, {
          resolveConfig: async ({ tenantId }) => ({
            subBrands: {
              variant_shared: {
                id: `app_${tenantId}`,
                variant: { id: "variant_shared" },
              },
              ...(tenantId === "tenant-a"
                ? {
                    variant_a_only: {
                      id: "app_tenant-a",
                      variant: { id: "variant_a_only" },
                    },
                  }
                : {}),
            },
          }),
        });
        server = s;
        testPORT = port;
        const result = await Passwordless.signInUp({
          email: "tenant-variant-member@example.com",
          tenantId: "public",
        });
        await MultiTenancy.createOrUpdateTenant("tenant-a");
        await MultiTenancy.createOrUpdateTenant("tenant-b");
        await MultiTenancy.associateUserToTenant(
          "tenant-a",
          result.recipeUserId,
        );
        await MultiTenancy.associateUserToTenant(
          "tenant-b",
          result.recipeUserId,
        );
        const config = getPluginConfig();
        if (!config) {
          throw new Error("Rownd plugin config was not initialized");
        }
        const tenantA = await resolvePluginConfigSnapshot(config, {
          tenantId: "tenant-a",
          userContext: {},
        });
        const tenantB = await resolvePluginConfigSnapshot(config, {
          tenantId: "tenant-b",
          userContext: {},
        });
        await recordRowndAppVariantForUser(
          result.user.id,
          "variant_shared",
          tenantA.userContext,
          "tenant-a",
        );
        await recordRowndAppVariantForUser(
          result.user.id,
          "variant_a_only",
          tenantA.userContext,
          "tenant-a",
        );
        await recordRowndAppVariantForUser(
          result.user.id,
          "variant_shared",
          tenantB.userContext,
          "tenant-b",
        );

        const metadata = await getUserMetadata(result.user.id);
        expect(
          (
            metadata.metadata as unknown as {
              original_rownd_user: {
                attributes: Record<string, unknown>;
              };
            }
          ).original_rownd_user.attributes["rownd:app_variants_by_tenant"],
        ).toEqual({
          "tenant-a": ["variant_shared", "variant_a_only"],
          "tenant-b": ["variant_shared"],
        });
        const userA = await getUserById(
          result.user.id,
          "tenant-a",
          tenantA.userContext,
        );
        const userB = await getUserById(
          result.user.id,
          "tenant-b",
          tenantB.userContext,
        );

        expect(userA.attributes["rownd:app_variants"]).toEqual([
          "variant_shared",
          "variant_a_only",
        ]);
        expect(userB.attributes["rownd:app_variants"]).toEqual([
          "variant_shared",
        ]);
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

      it("preserves secondary Rownd metadata when the plugin automatically links accounts", async () => {
        const { server: s, port } = await setup(importCoreConnectionURI);
        server = s;
        testPORT = port;
        const email = `linked-metadata-${randomUUID()}@example.com`;
        const providerUserId = `google-${randomUUID()}`;

        const passwordlessResult = await Passwordless.signInUp({
          email,
          tenantId: "public",
        });
        const primaryResult = await AccountLinking.createPrimaryUser(
          passwordlessResult.recipeUserId,
        );
        expect(primaryResult.status).toBe("OK");
        if (primaryResult.status !== "OK") {
          throw new Error("failed to create primary user");
        }
        const primaryUserId = primaryResult.user.id;
        await UserMetadata.updateUserMetadata(primaryUserId, {
          primary_metadata: "preserved",
          shared_metadata: "primary",
        });

        const thirdPartyResult = await ThirdParty.manuallyCreateOrUpdateUser(
          "public",
          "google",
          providerUserId,
          email,
          true,
          undefined,
          { rowndDisableAutomaticAccountLinking: true },
        );
        expect(thirdPartyResult.status).toBe("OK");
        if (thirdPartyResult.status !== "OK") {
          throw new Error("failed to create third-party user");
        }
        const secondaryUserId = thirdPartyResult.user.id;
        expect(secondaryUserId).not.toBe(primaryUserId);
        await UserMetadata.updateUserMetadata(secondaryUserId, {
          original_rownd_user: {
            state: "enabled",
            auth_level: "verified",
            data: {
              user_id: secondaryUserId,
              email,
              first_name: "jane",
            },
            verified_data: { email },
            attributes: {
              "stripe:customer_id": ["cus_linked_metadata"],
            },
            groups: [],
            meta: {},
          },
          first_name: "jane",
          shared_metadata: "secondary",
          rownd_pending_verification: [
            {
              id: "stale-secondary-verification",
              field: "email",
              value: "stale@example.com",
              created_at: "2026-01-01T00:00:00.000Z",
            },
          ],
        });
        const secondaryMetadataBeforeLogin =
          await UserMetadata.getUserMetadata(secondaryUserId);

        const pluginSignInResult = await signInUpWithTestProvider({
          providerId: "google",
          providerUserId,
          email,
        });
        expect(pluginSignInResult.status).toBe("OK");
        expect(pluginSignInResult.user.id).toBe(primaryUserId);
        expect(pluginSignInResult.accessToken).toBeDefined();

        const usersById = await Promise.all([
          SuperTokens.getUser(primaryUserId),
          SuperTokens.getUser(secondaryUserId),
        ]);
        expect(usersById.map((user) => user?.id)).toEqual([
          primaryUserId,
          primaryUserId,
        ]);

        const res = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user`,
          {
            headers: getAuthedHeaders(pluginSignInResult.accessToken!),
          },
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toMatchObject({
          status: "OK",
          rownd_user: secondaryUserId,
          data: {
            first_name: "jane",
          },
          meta: {
            primary_metadata: "preserved",
            shared_metadata: "primary",
          },
          attributes: {
            "stripe:customer_id": ["cus_linked_metadata"],
          },
        });

        const primaryMetadataAfterLogin =
          await UserMetadata.getUserMetadata(primaryUserId);
        expect(primaryMetadataAfterLogin.metadata).toEqual({
          primary_metadata: "preserved",
          shared_metadata: "primary",
        });
        await expect(
          UserMetadata.getUserMetadata(secondaryUserId),
        ).resolves.toEqual(secondaryMetadataBeforeLogin);

        await UserMetadata.updateUserMetadata(secondaryUserId, {
          original_rownd_user: {
            state: "enabled",
            auth_level: "verified",
            data: {
              user_id: secondaryUserId,
              email,
              first_name: "jane",
              last_name: "doe",
            },
            verified_data: { email },
            attributes: {
              "stripe:customer_id": ["cus_linked_metadata"],
            },
            groups: [],
            meta: {},
          },
        });
        const secondaryMetadataBeforeSubsequentLogin =
          await UserMetadata.getUserMetadata(secondaryUserId);
        const subsequentSignIn = await signInUpWithTestProvider({
          providerId: "google",
          providerUserId,
          email,
        });
        expect(subsequentSignIn.status).toBe("OK");
        expect(subsequentSignIn.accessToken).toBeDefined();

        const subsequentResponse = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user`,
          {
            headers: getAuthedHeaders(subsequentSignIn.accessToken!),
          },
        );
        expect(subsequentResponse.status).toBe(200);
        await expect(subsequentResponse.json()).resolves.toMatchObject({
          data: {
            first_name: "jane",
            last_name: "doe",
          },
          attributes: {
            "stripe:customer_id": ["cus_linked_metadata"],
          },
        });

        await expect(
          UserMetadata.getUserMetadata(primaryUserId),
        ).resolves.toEqual({
          status: "OK",
          metadata: {
            primary_metadata: "preserved",
            shared_metadata: "primary",
          },
        });
        await expect(
          UserMetadata.getUserMetadata(secondaryUserId),
        ).resolves.toEqual(secondaryMetadataBeforeSubsequentLogin);
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
        expect(
          (metadata.metadata as any).rownd_pending_verification,
        ).toBeUndefined();
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

      it.each([
        {
          endpoint: "/user",
          body: {
            data: {
              email: "mobile-upgrade-user-target@example.com",
              first_name: "Must not be saved",
            },
            context: { rowndDisplayContext: "mobile_app" },
          },
        },
        {
          endpoint: "/user/field?field=email",
          body: {
            value: "mobile-upgrade-field-target@example.com",
            context: {
              rowndDisplayContext: "mobile_app",
              rowndNativeEmailVerification: false,
            },
          },
        },
      ])(
        "rejects unsupported mobile email changes through $endpoint before side effects",
        async ({ endpoint, body }) => {
          const emailVerificationLinks: string[] = [];
          const { server: s, port } = await setup(
            coreConnectionURI,
            undefined,
            { enableEmailVerification: true, emailVerificationLinks },
          );
          server = s;
          testPORT = port;
          const currentEmail = `mobile-upgrade-${randomUUID()}@example.com`;
          const { accessToken, userId } =
            await createPasswordlessSessionForUser(currentEmail);
          const metadataBefore = await UserMetadata.getUserMetadata(userId);

          const res = await fetch(
            `http://localhost:${testPORT}/auth/plugin/rownd${endpoint}`,
            {
              method: "PUT",
              headers: {
                ...getAuthedHeaders(accessToken),
                "Content-Type": "application/json",
              },
              body: JSON.stringify(body),
            },
          );

          expect(res.status).toBe(426);
          await expect(res.json()).resolves.toEqual({
            status: "ERROR",
            code: 426,
            message: NATIVE_EMAIL_VERIFICATION_UPGRADE_REQUIRED_MESSAGE,
          });
          expect(emailVerificationLinks).toEqual([]);
          await expect(UserMetadata.getUserMetadata(userId)).resolves.toEqual(
            metadataBefore,
          );
          expect(
            (await SuperTokens.getUser(userId))?.loginMethods.find(
              (method) => method.recipeId === "passwordless",
            )?.email,
          ).toBe(currentEmail);
        },
      );

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
        expect(
          (metadata.metadata as any).rownd_pending_verification,
        ).toBeUndefined();
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
        const originalSessionInfo =
          await Session.getSessionInformation(sessionHandle);
        expect(originalSessionInfo).toBeDefined();
        await new Promise((resolve) => setTimeout(resolve, 10));

        const refreshedSession =
          await Session.refreshSessionWithoutRequestResponse(
            refreshToken,
            true,
          );
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

      it("keeps ordinary unmarked email verification session-optional", async () => {
        const emailVerificationLinks: string[] = [];
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
          emailVerificationLinks,
          passwordlessContactMethod: "EMAIL_OR_PHONE",
        });
        server = s;
        testPORT = port;
        const email = "ordinary-verification@example.com";
        const signInUpResult = await Passwordless.signInUp({
          tenantId: "public",
          email,
        });
        await EmailVerification.unverifyEmail(
          signInUpResult.recipeUserId,
          email,
        );

        const sendResult = await EmailVerification.sendEmailVerificationEmail(
          "public",
          signInUpResult.user.id,
          signInUpResult.recipeUserId,
          email,
        );

        expect(sendResult.status).toBe("OK");
        expect(emailVerificationLinks).toHaveLength(1);
        const verificationUrl = new URL(emailVerificationLinks[0]);
        expect(
          verificationUrl.searchParams.get("rowndPendingVerificationId"),
        ).toBeNull();
        const token = verificationUrl.searchParams.get("token");
        expect(token).toBeTruthy();

        const verifyRes = await verifyEmailToken(token || "unused");
        expect(verifyRes.status).toBe(200);
        await expect(verifyRes.json()).resolves.toEqual({ status: "OK" });
      });

      it("does not complete a pending email change with an ordinary Core token", async () => {
        const emailVerificationLinks: string[] = [];
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
          emailVerificationLinks,
        });
        server = s;
        testPORT = port;
        const currentEmail = "ordinary-pending-current@example.com";
        const targetEmail = "ordinary-pending-target@example.com";
        const initiatingUser =
          await createPasswordlessSessionForUser(currentEmail);

        const updateRes = await requestEmailChange(
          initiatingUser.accessToken,
          targetEmail,
        );
        expect(updateRes.status).toBe(200);
        expect(emailVerificationLinks).toHaveLength(1);

        const ordinaryToken =
          await EmailVerification.createEmailVerificationToken(
            "public",
            initiatingUser.recipeUserId,
            targetEmail,
          );
        expect(ordinaryToken.status).toBe("OK");
        const ordinaryVerifyRes = await verifyEmailToken(
          ordinaryToken.status === "OK" ? ordinaryToken.token : "unused",
          initiatingUser.accessToken,
        );
        expect(ordinaryVerifyRes.status).toBe(200);
        await expect(ordinaryVerifyRes.json()).resolves.toEqual({
          status: "OK",
        });
        const unchangedUser = await SuperTokens.getUser(initiatingUser.userId);
        expect(
          unchangedUser?.loginMethods.find(
            (method) => method.recipeId === "passwordless" && method.email,
          )?.email,
        ).toBe(currentEmail);
        const metadata = await UserMetadata.getUserMetadata(
          initiatingUser.userId,
        );
        expect(
          (metadata.metadata as any).rownd_pending_verification,
        ).toHaveLength(1);
      });

      it("allows legacy HTTP sign-in-or-sign-up without intent when explicit flow is enabled", async () => {
        const passwordlessLinks: string[] = [];
        const { server: s, port } = await setup(
          coreConnectionURI,
          {
            appConfig: {
              auth: { useExplicitSignUpFlow: true },
              signInMethods: [{ method: "email" }],
            },
          },
          { passwordlessLinks },
        );
        server = s;
        testPORT = port;
        const email = "implicit-sign-in-up-new@example.com";

        const createCode = await requestPasswordlessCode(email);
        await expect(createCode.json()).resolves.toMatchObject({ status: "OK" });
        expect(passwordlessLinks).toHaveLength(1);

        const consume = await consumePasswordlessLink(passwordlessLinks[0]);
        await expect(consume.json()).resolves.toMatchObject({
          status: "OK",
          createdNewRecipeUser: true,
        });
        expect(consume.headers.get("st-access-token")).toBeTruthy();
        await expect(
          SuperTokens.listUsersByAccountInfo("public", { email }, false),
        ).resolves.toHaveLength(1);

        const existingCreateCode = await requestPasswordlessCode(email);
        await expect(existingCreateCode.json()).resolves.toMatchObject({
          status: "OK",
        });
        const existingConsume = await consumePasswordlessLink(
          passwordlessLinks[1],
        );
        await expect(existingConsume.json()).resolves.toMatchObject({
          status: "OK",
          createdNewRecipeUser: false,
        });
      });

      it("allows a consumed Passwordless method linked to an instant user", async () => {
        const passwordlessLinks: string[] = [];
        const { server: s, port } = await setup(
          coreConnectionURI,
          undefined,
          { passwordlessLinks },
        );
        server = s;
        testPORT = port;
        const email = "instant-passwordless-link@example.com";
        const instantSession = await createGuestSession("instant");

        const createCode = await requestPasswordlessCode(email);
        await expect(createCode.json()).resolves.toMatchObject({ status: "OK" });
        expect(passwordlessLinks).toHaveLength(1);

        const consume = await consumePasswordlessLink(
          passwordlessLinks[0],
          undefined,
          instantSession.accessToken,
        );
        await expect(consume.json()).resolves.toMatchObject({
          status: "OK",
          createdNewRecipeUser: true,
        });

        const linkedUser = await SuperTokens.getUser(instantSession.userId);
        expect(linkedUser?.loginMethods).toContainEqual(
          expect.objectContaining({ recipeId: "passwordless", email }),
        );
      });

      it("retires a verified email for explicit HTTP sign-in and allows sign-up reuse", async () => {
        const emailVerificationLinks: string[] = [];
        const passwordlessLinks: string[] = [];
        const { server: s, port } = await setup(
          coreConnectionURI,
          {
            appConfig: {
              auth: { useExplicitSignUpFlow: true },
              signInMethods: [{ method: "email" }],
            },
          },
          {
            enableEmailVerification: true,
            emailVerificationLinks,
            passwordlessLinks,
          },
        );
        server = s;
        testPORT = port;
        const oldEmail = "customer-regression-old@example.com";
        const newEmail = "customer-regression-new@example.com";
        const account = await createPasswordlessSessionForUser(oldEmail);
        const staleCodeResponse = await requestPasswordlessCode(
          oldEmail,
          "sign_in",
        );
        await expect(staleCodeResponse.json()).resolves.toMatchObject({
          status: "OK",
        });
        expect(passwordlessLinks).toHaveLength(1);

        expect(
          await requestEmailChange(account.accessToken, newEmail),
        ).toMatchObject({ status: 200 });
        const verificationUrl = new URL(emailVerificationLinks[0]);
        const revokeCodes = vi
          .spyOn(Passwordless, "revokeAllCodes")
          .mockResolvedValue({ status: "OK" });
        const verification = await verifyEmailToken(
          verificationUrl.searchParams.get("token") || "unused",
          account.accessToken,
          verificationUrl.searchParams.get("rowndPendingVerificationId") ||
            "unused",
        );
        await expect(verification.json()).resolves.toEqual({ status: "OK" });
        revokeCodes.mockRestore();

        const staleConsume = await consumePasswordlessLink(
          passwordlessLinks[0],
          "sign_in",
        );
        await expect(staleConsume.json()).resolves.toEqual({
          status: "SIGN_IN_UP_NOT_ALLOWED",
          reason: "No existing account found",
        });
        expect(staleConsume.headers.get("st-access-token")).toBeFalsy();

        const createCode = vi.spyOn(Passwordless, "createCode");
        const usersBefore = await SuperTokens.listUsersByAccountInfo(
          "public",
          { email: oldEmail },
          false,
        );
        expect(usersBefore).toEqual([]);

        const signIn = await requestPasswordlessCode(oldEmail, "sign_in");
        await expect(signIn.json()).resolves.toEqual({
          status: "SIGN_IN_UP_NOT_ALLOWED",
          reason: "No existing account found",
        });
        expect(createCode).not.toHaveBeenCalled();
        await expect(
          SuperTokens.listUsersByAccountInfo(
            "public",
            { email: oldEmail },
            false,
          ),
        ).resolves.toEqual([]);

        const signUp = await requestPasswordlessCode(oldEmail, "sign_up");
        await expect(signUp.json()).resolves.toMatchObject({ status: "OK" });
        expect(passwordlessLinks).toHaveLength(2);
        const signUpConsume = await consumePasswordlessLink(
          passwordlessLinks[1],
          "sign_up",
        );
        await expect(signUpConsume.json()).resolves.toMatchObject({
          status: "OK",
          createdNewRecipeUser: true,
        });
        expect(signUpConsume.headers.get("st-access-token")).toBeTruthy();
        const reusedEmailUsers = await SuperTokens.listUsersByAccountInfo(
          "public",
          { email: oldEmail },
          false,
        );
        expect(reusedEmailUsers).toHaveLength(1);
        expect(reusedEmailUsers[0]?.id).not.toBe(account.userId);
        expect(reusedEmailUsers[0]?.loginMethods).toHaveLength(1);
      });

      it("defers email updates until verification completes", async () => {
        const emailVerificationLinks: string[] = [];
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
          emailVerificationLinks,
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
        expect(body.email_verification_pending).toBe(true);
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
        expect(
          (metadata.metadata as any).rownd_pending_verification[0],
        ).not.toHaveProperty("emailVerificationTokenHash");
        expect(
          (metadata.metadata as any).rownd_pending_verification[0],
        ).not.toHaveProperty("emailVerificationCoreTokenCiphertext");
        expect((metadata.metadata as any).email).toBeUndefined();

        expect(emailVerificationLinks).toHaveLength(1);
        const verificationUrl = new URL(emailVerificationLinks[0]);

        const verifyRes = await verifyEmailToken(
          verificationUrl.searchParams.get("token") || "unused",
          accessToken,
          verificationUrl.searchParams.get("rowndPendingVerificationId") ||
            "unused",
        );
        expect(verifyRes.status).toBe(200);
        await expect(verifyRes.json()).resolves.toEqual({ status: "OK" });
        const replacementAccessToken = verifyRes.headers.get("st-access-token");
        expect(replacementAccessToken).toBeTruthy();

        const replayRes = await verifyEmailToken(
          verificationUrl.searchParams.get("token") || "unused",
          replacementAccessToken || "unused",
          verificationUrl.searchParams.get("rowndPendingVerificationId") ||
            "unused",
        );
        await expect(replayRes.json()).resolves.toEqual({
          status: "GENERAL_ERROR",
          message: "email change verification requires the initiating session",
        });

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
        expect(passwordlessMethods).toEqual([
          expect.objectContaining({ email: "new-email-update@example.com" }),
        ]);
        const originalMethod = passwordlessMethods?.find(
          (method) =>
            method.recipeUserId.getAsString() === recipeUserId.getAsString(),
        );
        const canonicalMethod = passwordlessMethods?.find(
          (method) => method.email === "new-email-update@example.com",
        );
        expect(originalMethod).toBeUndefined();
        expect(canonicalMethod?.recipeUserId.getAsString()).not.toBe(
          recipeUserId.getAsString(),
        );
        expect((metadata.metadata as any).rownd_email_recipe_user_id).toBe(
          canonicalMethod?.recipeUserId.getAsString(),
        );
        expect((metadata.metadata as any).rownd_email_recipe_user_ids).toEqual({
          public: canonicalMethod?.recipeUserId.getAsString(),
        });

        const newEmailSignIn = await Passwordless.signInUp({
          email: "new-email-update@example.com",
          tenantId: "public",
        });
        expect(newEmailSignIn.createdNewRecipeUser).toBe(false);
        expect(newEmailSignIn.user.id).toBe(userId);

        const secondTargetEmail = "second-email-update@example.com";
        const secondUpdateRes = await requestEmailChange(
          replacementAccessToken!,
          secondTargetEmail,
        );
        expect(secondUpdateRes.status).toBe(200);
        expect(emailVerificationLinks).toHaveLength(2);
        const secondVerificationUrl = new URL(emailVerificationLinks[1]);
        const secondVerifyRes = await verifyEmailToken(
          secondVerificationUrl.searchParams.get("token") || "unused",
          replacementAccessToken!,
          secondVerificationUrl.searchParams.get(
            "rowndPendingVerificationId",
          ) || "unused",
        );
        await expect(secondVerifyRes.json()).resolves.toEqual({ status: "OK" });
        const secondReplacementAccessToken =
          secondVerifyRes.headers.get("st-access-token");
        expect(secondReplacementAccessToken).toBeTruthy();

        const twiceUpdatedUser = await SuperTokens.getUser(userId);
        expect(
          twiceUpdatedUser?.loginMethods.filter(
            (method) => method.recipeId === "passwordless" && method.email,
          ),
        ).toHaveLength(1);
        const twiceUpdatedMetadata = await UserMetadata.getUserMetadata(userId);
        expect(
          (twiceUpdatedMetadata.metadata as any).rownd_email_recipe_user_id,
        ).toBe(
          twiceUpdatedUser?.loginMethods
            .find((method) => method.email === secondTargetEmail)
            ?.recipeUserId.getAsString(),
        );

        const restoreAliasRes = await requestEmailChange(
          secondReplacementAccessToken!,
          "email-update-user@example.com",
        );
        expect(restoreAliasRes.status).toBe(200);
        expect(emailVerificationLinks).toHaveLength(3);
        const restoreAliasUrl = new URL(emailVerificationLinks[2]);
        const restoreAliasVerifyRes = await verifyEmailToken(
          restoreAliasUrl.searchParams.get("token") || "unused",
          secondReplacementAccessToken!,
          restoreAliasUrl.searchParams.get("rowndPendingVerificationId") ||
            "unused",
        );
        await expect(restoreAliasVerifyRes.json()).resolves.toEqual({
          status: "OK",
        });

        const restoredAliasUser = await SuperTokens.getUser(userId);
        expect(
          restoredAliasUser?.loginMethods.filter(
            (method) => method.recipeId === "passwordless" && method.email,
          ),
        ).toHaveLength(1);
        const restoredAliasMetadata =
          await UserMetadata.getUserMetadata(userId);
        expect(
          (restoredAliasMetadata.metadata as any).rownd_email_recipe_user_ids,
        ).toEqual({
          public: restoredAliasUser?.loginMethods
            .find((method) => method.email === "email-update-user@example.com")
            ?.recipeUserId.getAsString(),
        });
      });

      it("replaces the confirmed email across doejohn@gmail.com -> johndoe@email.com -> doejohn@gmail.com", async () => {
        const emailVerificationLinks: string[] = [];
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
          emailVerificationLinks,
        });
        server = s;
        testPORT = port;
        const originalEmail = "doejohn@gmail.com";
        const replacementEmail = "johndoe@email.com";
        const initial = await createPasswordlessSessionForUser(originalEmail);
        const primary = await AccountLinking.createPrimaryUser(
          initial.recipeUserId,
        );
        expect(primary.status).toBe("OK");
        if (primary.status !== "OK")
          throw new Error("failed to create primary");
        const phone = await Passwordless.signInUp({
          tenantId: "public",
          phoneNumber: "+15555550899",
        });
        const apple = await ThirdParty.manuallyCreateOrUpdateUser(
          "public",
          "apple",
          "sirinbugra-apple-id",
          originalEmail,
          true,
          undefined,
          { rowndDisableAutomaticAccountLinking: true },
        );
        expect(apple.status).toBe("OK");
        if (apple.status !== "OK")
          throw new Error("failed to create Apple user");
        await expect(
          AccountLinking.linkAccounts(phone.recipeUserId, primary.user.id),
        ).resolves.toMatchObject({ status: "OK" });
        await expect(
          AccountLinking.linkAccounts(apple.recipeUserId, primary.user.id),
        ).resolves.toMatchObject({ status: "OK" });
        await MultiTenancy.createOrUpdateTenant("preserved-tenant");
        await expect(
          MultiTenancy.associateUserToTenant(
            "preserved-tenant",
            initial.recipeUserId,
          ),
        ).resolves.toMatchObject({ status: "OK" });

        expect(
          await requestEmailChange(initial.accessToken, replacementEmail),
        ).toMatchObject({ status: 200 });
        const firstLink = new URL(emailVerificationLinks[0]);
        const firstVerification = await verifyEmailToken(
          firstLink.searchParams.get("token") || "unused",
          initial.accessToken,
          firstLink.searchParams.get("rowndPendingVerificationId") || "unused",
        );
        await expect(firstVerification.json()).resolves.toEqual({
          status: "OK",
        });
        const firstReplacementToken =
          firstVerification.headers.get("st-access-token");
        expect(firstReplacementToken).toBeTruthy();

        const afterFirstChange = await SuperTokens.getUser(initial.userId);
        const firstMethods = afterFirstChange?.loginMethods.filter(
          (method) =>
            method.recipeId === "passwordless" &&
            method.email &&
            method.tenantIds.includes("public"),
        );
        expect(firstMethods).toEqual([
          expect.objectContaining({ email: replacementEmail }),
        ]);
        const firstReplacementSession =
          await Session.getSessionWithoutRequestResponse(
            firstReplacementToken!,
          );
        expect(firstReplacementSession?.getRecipeUserId().getAsString()).toBe(
          firstMethods?.[0]?.recipeUserId.getAsString(),
        );
        expect(
          afterFirstChange?.loginMethods.find(
            (method) =>
              method.recipeId === "passwordless" &&
              method.email === originalEmail,
          )?.tenantIds,
        ).toEqual(["preserved-tenant"]);
        expect(
          afterFirstChange?.loginMethods.find(
            (method) => method.phoneNumber === "+15555550899",
          ),
        ).toBeDefined();
        expect(
          afterFirstChange?.loginMethods.find(
            (method) => method.thirdParty?.id === "apple",
          ),
        ).toBeDefined();

        expect(
          await requestEmailChange(firstReplacementToken!, originalEmail),
        ).toMatchObject({ status: 200 });
        const secondLink = new URL(emailVerificationLinks[1]);
        const secondVerification = await verifyEmailToken(
          secondLink.searchParams.get("token") || "unused",
          firstReplacementToken!,
          secondLink.searchParams.get("rowndPendingVerificationId") || "unused",
        );
        await expect(secondVerification.json()).resolves.toEqual({
          status: "OK",
        });

        const restored = await SuperTokens.getUser(initial.userId);
        expect(
          restored?.loginMethods.filter(
            (method) =>
              method.recipeId === "passwordless" &&
              method.email &&
              method.tenantIds.includes("public"),
          ),
        ).toEqual([expect.objectContaining({ email: originalEmail })]);
        expect(
          restored?.loginMethods.find(
            (method) =>
              method.recipeId === "passwordless" &&
              method.email === originalEmail &&
              method.tenantIds.includes("preserved-tenant"),
          )?.tenantIds,
        ).toEqual(["preserved-tenant"]);
        await expect(
          SuperTokens.listUsersByAccountInfo(
            "public",
            { email: replacementEmail },
            false,
          ),
        ).resolves.toEqual([]);
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

      it("uses the recorded method if more than one Passwordless method exists after reloading the user", async () => {
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
        });
        server = s;
        testPORT = port;
        const currentEmail = "ambiguous-completion-current@example.com";
        const targetEmail = "ambiguous-completion-target@example.com";
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
            if (getUserCallCount !== 2 || !user) return user;

            const passwordlessMethod = user.loginMethods.find(
              (method) => method.recipeId === "passwordless",
            );
            return passwordlessMethod
              ? {
                  ...user,
                  loginMethods: [passwordlessMethod, passwordlessMethod],
                }
              : user;
          });
        await expect(
          completePendingEmailVerification({
            recipeUserId: initiatingUser.recipeUserId,
            email: targetEmail,
            sessionHandle: initiatingUser.sessionHandle,
          }),
        ).resolves.toMatchObject({ replaceSession: true });
        getUser.mockRestore();

        const user = await SuperTokens.getUser(initiatingUser.userId);
        expect(user?.loginMethods).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ email: targetEmail }),
          ]),
        );
        const metadata = await UserMetadata.getUserMetadata(
          initiatingUser.userId,
        );
        expect((metadata.metadata as any).rownd_email_recipe_user_id).toBe(
          user?.loginMethods
            .find((method) => method.email === targetEmail)
            ?.recipeUserId.getAsString(),
        );
      });

      it("restores PENDING when completion cleanup fails so a new change can supersede it", async () => {
        const emailVerificationLinks: string[] = [];
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
          emailVerificationLinks,
        });
        server = s;
        testPORT = port;
        const currentEmail = "committing-failure-current@example.com";
        const targetEmail = "committing-failure-target@example.com";
        const initiatingUser =
          await createPasswordlessSessionForUser(currentEmail);

        const updateRes = await requestEmailChange(
          initiatingUser.accessToken,
          targetEmail,
        );
        expect(updateRes.status).toBe(200);
        expect(emailVerificationLinks).toHaveLength(1);
        const verificationUrl = new URL(emailVerificationLinks[0]);
        const token = verificationUrl.searchParams.get("token") || "unused";
        const pendingVerificationId =
          verificationUrl.searchParams.get("rowndPendingVerificationId") ||
          "unused";

        let statusAtFailure: string | undefined;
        const originalGetSessionInformation = Session.getSessionInformation;
        let getSessionInformationCalls = 0;
        vi.spyOn(Session, "getSessionInformation").mockImplementation(
          async (...input) => {
            getSessionInformationCalls += 1;
            if (getSessionInformationCalls !== 2) {
              return originalGetSessionInformation(...input);
            }
            const metadata = await UserMetadata.getUserMetadata(
              initiatingUser.userId,
            );
            statusAtFailure = (metadata.metadata as any)
              .rownd_pending_verification[0]?.status;
            throw new Error("session Core request failed after COMMITTING");
          },
        );
        const unverifyEmail = vi
          .spyOn(EmailVerification, "unverifyEmail")
          .mockRejectedValueOnce(new Error("transient unverify failure"));

        const failedCompletionRes = await verifyEmailToken(
          token,
          initiatingUser.accessToken,
          pendingVerificationId,
        );
        expect(failedCompletionRes.status).toBe(500);
        expect(statusAtFailure).toBe("PENDING");

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
        const failedPending = (metadata.metadata as any)
          .rownd_pending_verification;
        expect(failedPending).toEqual([
          expect.objectContaining({ status: "PENDING" }),
        ]);
        await expect(
          EmailVerification.isEmailVerified(
            initiatingUser.recipeUserId,
            targetEmail,
          ),
        ).resolves.toBe(true);
        expect(unverifyEmail).toHaveBeenCalledTimes(1);

        const replacementSession =
          await Session.createNewSessionWithoutRequestResponse(
            "public",
            initiatingUser.recipeUserId,
            {},
            {},
            true,
          );
        const replacementEmail = "committing-failure-replacement@example.com";
        const replacementRes = await requestEmailChange(
          replacementSession.getAccessToken(),
          replacementEmail,
        );
        expect(replacementRes.status).toBe(200);

        const metadataAfterReplacement = await UserMetadata.getUserMetadata(
          initiatingUser.userId,
        );
        const replacementPending = (metadataAfterReplacement.metadata as any)
          .rownd_pending_verification;
        expect(replacementPending).toEqual([
          expect.objectContaining({
            status: "PENDING",
            value: replacementEmail,
          }),
        ]);
        expect(replacementPending[0].id).not.toBe(failedPending[0].id);
        await expect(
          EmailVerification.isEmailVerified(
            initiatingUser.recipeUserId,
            replacementEmail,
          ),
        ).resolves.toBe(false);
        const consumedRetryRes = await verifyEmailToken(
          token,
          replacementSession.getAccessToken(),
          pendingVerificationId,
        );
        await expect(consumedRetryRes.json()).resolves.toEqual({
          status: "GENERAL_ERROR",
          message: "email change verification requires the initiating session",
        });
      });

      it("rejects the revoked pre-change token on every account-management route", async () => {
        const emailVerificationLinks: string[] = [];
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
          emailVerificationLinks,
        });
        server = s;
        testPORT = port;
        const currentEmail = "revoked-route-current@example.com";
        const targetEmail = "revoked-route-target@example.com";
        const { accessToken, userId } =
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

        expect(emailVerificationLinks).toHaveLength(1);
        const verificationUrl = new URL(emailVerificationLinks[0]);
        const verifyRes = await verifyEmailToken(
          verificationUrl.searchParams.get("token") || "unused",
          accessToken,
          verificationUrl.searchParams.get("rowndPendingVerificationId") ||
            "unused",
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
        const emailVerificationLinks: string[] = [];
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
          emailVerificationLinks,
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

        expect(emailVerificationLinks).toHaveLength(1);
        const verificationUrl = new URL(emailVerificationLinks[0]);

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
          verificationUrl.searchParams.get("token") || "unused",
          initiatingUser.accessToken,
          verificationUrl.searchParams.get("rowndPendingVerificationId") ||
            "unused",
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

      it("preserves reconciliation state after cleanup and a later Core failure", async () => {
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
        ).rejects.toThrow(
          "email change cleanup incomplete; account reconciliation is required",
        );
        expect(accountRevocationCount).toBe(3);
        expect(emailAtSecondRevocation).toBeUndefined();

        const user = await SuperTokens.getUser(initiatingUser.userId);
        expect(user?.loginMethods).toEqual([
          expect.objectContaining({ email: targetEmail }),
        ]);
        const metadata = await UserMetadata.getUserMetadata(
          initiatingUser.userId,
        );
        expect((metadata.metadata as any).rownd_pending_verification).toEqual([
          expect.objectContaining({ status: "COMMITTING", value: targetEmail }),
        ]);
        await expect(
          EmailVerification.isEmailVerified(
            user!.loginMethods[0].recipeUserId,
            targetEmail,
          ),
        ).resolves.toBe(true);
        await expect(
          Session.getAllSessionHandlesForUser(
            initiatingUser.userId,
            true,
            "public",
          ),
        ).resolves.toEqual([]);
      });

      it("preserves reconciliation state when replaced-method cleanup fails", async () => {
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
        });
        server = s;
        testPORT = port;
        const currentEmail = "rollback-status-current@example.com";
        const targetEmail = "rollback-status-target@example.com";
        const initiatingUser =
          await createPasswordlessSessionForUser(currentEmail);

        const updateRes = await requestEmailChange(
          initiatingUser.accessToken,
          targetEmail,
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
        vi.spyOn(Session, "revokeAllSessionsForUser").mockImplementation(
          async (...input) => {
            accountRevocationCount += 1;
            if (accountRevocationCount === 2) {
              throw new Error("second account revocation failed");
            }
            return originalRevokeAllSessionsForUser(...input);
          },
        );
        const deleteUser = vi
          .spyOn(SuperTokens, "deleteUser")
          .mockRejectedValue(new Error("linked method deletion failed"));
        const unverifyEmail = vi.spyOn(EmailVerification, "unverifyEmail");

        await expect(
          completePendingEmailVerification({
            recipeUserId: initiatingUser.recipeUserId,
            email: targetEmail,
            sessionHandle: initiatingUser.sessionHandle,
          }),
        ).rejects.toThrow(
          "email change cleanup incomplete; account reconciliation is required",
        );
        expect(deleteUser).toHaveBeenCalledTimes(1);
        expect(accountRevocationCount).toBe(2);
        expect(unverifyEmail).not.toHaveBeenCalled();

        const user = await SuperTokens.getUser(initiatingUser.userId);
        expect(user?.loginMethods).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ email: targetEmail }),
          ]),
        );
        const metadata = await UserMetadata.getUserMetadata(
          initiatingUser.userId,
        );
        expect((metadata.metadata as any).rownd_pending_verification).toEqual([
          expect.objectContaining({
            status: "COMMITTING",
            value: targetEmail,
            verificationRecipeUserId: initiatingUser.recipeUserId.getAsString(),
            targetCanonicalRecipeUserId: expect.any(String),
            retiredMethods: [
              {
                recipeUserId: initiatingUser.recipeUserId.getAsString(),
                email: currentEmail,
              },
            ],
          }),
        ]);
        await expect(
          EmailVerification.isEmailVerified(
            initiatingUser.recipeUserId,
            targetEmail,
          ),
        ).resolves.toBe(true);
      });

      it("resumes durable reconciliation through the target method after partial cleanup", async () => {
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
        });
        server = s;
        testPORT = port;
        const currentEmail = "durable-current@example.com";
        const secondEmail = "durable-second@example.com";
        const targetEmail = "durable-target@example.com";
        const initiatingUser =
          await createPasswordlessSessionForUser(currentEmail);
        const primary = await AccountLinking.createPrimaryUser(
          initiatingUser.recipeUserId,
        );
        expect(primary.status).toBe("OK");
        if (primary.status !== "OK")
          throw new Error("failed to create primary");
        const second = await Passwordless.signInUp({
          tenantId: "public",
          email: secondEmail,
          userContext: { rowndDisableAutomaticAccountLinking: true },
        });
        await expect(
          AccountLinking.linkAccounts(second.recipeUserId, primary.user.id),
        ).resolves.toMatchObject({ status: "OK" });
        await UserMetadata.updateUserMetadata(primary.user.id, {
          rownd_email_recipe_user_id: initiatingUser.recipeUserId.getAsString(),
          rownd_email_recipe_user_ids: {
            public: initiatingUser.recipeUserId.getAsString(),
          },
        });
        expect(
          await requestEmailChange(initiatingUser.accessToken, targetEmail),
        ).toMatchObject({ status: 200 });
        const token = await EmailVerification.createEmailVerificationToken(
          "public",
          initiatingUser.recipeUserId,
          targetEmail,
        );
        expect(token.status).toBe("OK");
        if (token.status !== "OK") throw new Error("failed to create token");
        await EmailVerification.verifyEmailUsingToken(
          "public",
          token.token,
          false,
        );

        const originalDeleteUser = SuperTokens.deleteUser;
        let deleteCount = 0;
        const deleteUser = vi
          .spyOn(SuperTokens, "deleteUser")
          .mockImplementation(async (...input) => {
            deleteCount += 1;
            if (deleteCount === 2) {
              throw new Error("second cleanup failed");
            }
            return originalDeleteUser(...input);
          });
        await expect(
          completePendingEmailVerification({
            recipeUserId: initiatingUser.recipeUserId,
            email: targetEmail,
            sessionHandle: initiatingUser.sessionHandle,
          }),
        ).rejects.toThrow(
          "email change cleanup incomplete; account reconciliation is required",
        );
        deleteUser.mockRestore();

        const pendingMetadata = await UserMetadata.getUserMetadata(
          primary.user.id,
        );
        const durablePlan = (pendingMetadata.metadata as any)
          .rownd_pending_verification[0];
        expect(durablePlan).toMatchObject({
          status: "COMMITTING",
          value: targetEmail,
          targetCanonicalRecipeUserId: expect.any(String),
          retiredMethods: expect.arrayContaining([
            expect.objectContaining({
              recipeUserId: initiatingUser.recipeUserId.getAsString(),
              email: currentEmail,
            }),
            expect.objectContaining({
              recipeUserId: second.recipeUserId.getAsString(),
              email: secondEmail,
            }),
          ]),
        });
        const partiallyCleanedUser = await SuperTokens.getUser(primary.user.id);
        expect(
          durablePlan.retiredMethods.filter(
            (retiredMethod: { recipeUserId: string }) =>
              partiallyCleanedUser?.loginMethods.some(
                (method) =>
                  method.recipeUserId.getAsString() ===
                  retiredMethod.recipeUserId,
              ),
          ),
        ).toHaveLength(1);
        const targetMethod = partiallyCleanedUser?.loginMethods.find(
          (method) =>
            method.recipeUserId.getAsString() ===
            durablePlan.targetCanonicalRecipeUserId,
        );
        expect(targetMethod?.email).toBe(targetEmail);
        const recoverySession =
          await Session.createNewSessionWithoutRequestResponse(
            "public",
            targetMethod!.recipeUserId,
            {},
            {},
            true,
          );

        const recoveryResponse = await requestEmailChange(
          recoverySession.getAccessToken(),
          targetEmail,
        );
        expect(recoveryResponse.status).toBe(200);
        const reconciledMetadata = await UserMetadata.getUserMetadata(
          primary.user.id,
        );
        expect(
          (reconciledMetadata.metadata as any).rownd_pending_verification,
        ).toEqual([]);
        expect(
          (reconciledMetadata.metadata as any).rownd_email_recipe_user_ids
            .public,
        ).toBe(targetMethod!.recipeUserId.getAsString());
        expect(
          (reconciledMetadata.metadata as any).original_rownd_user.data.email,
        ).toBe(targetEmail);
      });

      it("revokes a durable retired email before deleting its zero-tenant orphan", async () => {
        const { server: s, port } = await setup(coreConnectionURI);
        server = s;
        testPORT = port;
        const cleanupEmail = "missing-cleanup-method@example.com";
        const targetEmail = "missing-cleanup-target@example.com";
        const cleanup = await Passwordless.signInUp({
          tenantId: "public",
          email: cleanupEmail,
        });
        const primary = await AccountLinking.createPrimaryUser(
          cleanup.recipeUserId,
        );
        expect(primary.status).toBe("OK");
        if (primary.status !== "OK")
          throw new Error("failed to create primary");
        const staleCode = await Passwordless.createCode({
          tenantId: "public",
          email: cleanupEmail,
        });
        const target = await Passwordless.signInUp({
          tenantId: "public",
          email: targetEmail,
          userContext: { rowndDisableAutomaticAccountLinking: true },
        });
        await expect(
          AccountLinking.linkAccounts(target.recipeUserId, primary.user.id),
        ).resolves.toMatchObject({ status: "OK" });
        const plan = {
          id: "missing-cleanup-plan",
          field: "email",
          value: targetEmail,
          created_at: new Date().toISOString(),
          tenantId: "public",
          purpose: "UPDATE_PASSWORDLESS",
          status: "COMMITTING",
          targetCanonicalRecipeUserId: target.recipeUserId.getAsString(),
          retiredMethods: [
            {
              recipeUserId: cleanup.recipeUserId.getAsString(),
              email: cleanupEmail,
            },
          ],
        };
        await UserMetadata.updateUserMetadata(primary.user.id, {
          original_rownd_user: {
            state: "enabled",
            auth_level: "verified",
            data: { user_id: primary.user.id, email: cleanupEmail },
            verified_data: { email: cleanupEmail },
          },
          rownd_pending_verification: [plan],
        });
        await expect(
          MultiTenancy.disassociateUserFromTenant(
            "public",
            cleanup.recipeUserId,
          ),
        ).resolves.toMatchObject({ status: "OK" });

        const events: string[] = [];
        const originalUpdateUserMetadata = UserMetadata.updateUserMetadata;
        vi.spyOn(UserMetadata, "updateUserMetadata").mockImplementation(
          async (...input) => {
            const pending = (input[1] as any).rownd_pending_verification;
            if (Array.isArray(pending) && pending.length === 0) {
              events.push("finalize");
            }
            return originalUpdateUserMetadata(...input);
          },
        );
        const originalRevokeAllCodes = Passwordless.revokeAllCodes;
        const revokeAllCodes = vi
          .spyOn(Passwordless, "revokeAllCodes")
          .mockImplementation(async (input) => {
            const metadata = await UserMetadata.getUserMetadata(
              primary.user.id,
            );
            expect(
              (metadata.metadata as any).rownd_pending_verification[0]
                .retiredMethods,
            ).toEqual(plan.retiredMethods);
            events.push(`revoke ${input.email}`);
            return originalRevokeAllCodes(input);
          });

        await expect(
          prepareEmailForPasswordlessAuth({
            email: targetEmail,
            tenantId: "public",
            reconcileTarget: true,
          }),
        ).resolves.toEqual({ status: "ALLOW" });

        expect(events).toEqual([`revoke ${cleanupEmail}`, "finalize"]);
        expect(revokeAllCodes).toHaveBeenCalledWith(
          expect.objectContaining({ email: cleanupEmail, tenantId: "public" }),
        );
        await expect(
          Passwordless.consumeCode({
            tenantId: "public",
            preAuthSessionId: staleCode.preAuthSessionId,
            linkCode: staleCode.linkCode,
          }),
        ).resolves.toEqual({ status: "RESTART_FLOW_ERROR" });
        const metadata = await UserMetadata.getUserMetadata(primary.user.id);
        expect((metadata.metadata as any).rownd_pending_verification).toEqual(
          [],
        );
        expect((metadata.metadata as any).original_rownd_user.data.email).toBe(
          targetEmail,
        );
        const ownerAfterCleanup = await SuperTokens.getUser(primary.user.id);
        expect(
          ownerAfterCleanup?.loginMethods.some(
            (method) =>
              method.recipeUserId.getAsString() ===
              cleanup.recipeUserId.getAsString(),
          ),
        ).toBe(false);
      });

      it("requires sign-in again when reconciliation removes the authenticated cleanup method", async () => {
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
        });
        server = s;
        testPORT = port;
        const currentEmail = "cleanup-retry-current@example.com";
        const targetEmail = "cleanup-retry-target@example.com";
        const account = await createPasswordlessSessionForUser(currentEmail);

        expect(
          await requestEmailChange(account.accessToken, targetEmail),
        ).toMatchObject({ status: 200 });
        const token = await EmailVerification.createEmailVerificationToken(
          "public",
          account.recipeUserId,
          targetEmail,
        );
        expect(token.status).toBe("OK");
        if (token.status !== "OK") throw new Error("failed to create token");
        await EmailVerification.verifyEmailUsingToken(
          "public",
          token.token,
          false,
        );

        const disassociate = vi
          .spyOn(MultiTenancy, "disassociateUserFromTenant")
          .mockRejectedValueOnce(new Error("tenant cleanup failed"));
        await expect(
          completePendingEmailVerification({
            recipeUserId: account.recipeUserId,
            email: targetEmail,
            sessionHandle: account.sessionHandle,
          }),
        ).rejects.toThrow(
          "email change cleanup incomplete; account reconciliation is required",
        );
        disassociate.mockRestore();

        const cleanupSession =
          await Session.createNewSessionWithoutRequestResponse(
            "public",
            account.recipeUserId,
            {},
            {},
            true,
          );
        const retryResponse = await requestEmailChange(
          cleanupSession.getAccessToken(),
          "cleanup-retry-new@example.com",
        );
        expect(retryResponse.status).toBe(409);
        await expect(retryResponse.json()).resolves.toMatchObject({
          message: "email change sign-in method was removed; sign in again",
        });
        await expect(
          Session.getSessionInformation(cleanupSession.getHandle()),
        ).resolves.toBeUndefined();

        const metadata = await UserMetadata.getUserMetadata(account.userId);
        expect((metadata.metadata as any).rownd_pending_verification).toEqual(
          [],
        );
        expect(
          (metadata.metadata as any).rownd_email_recipe_user_ids.public,
        ).not.toBe(account.recipeUserId.getAsString());
      });

      it("extends a truncated cleanup plan before removing a current email alias", async () => {
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
        });
        server = s;
        testPORT = port;
        const targetEmail = "truncated-plan-target@example.com";
        const aliasEmail = "truncated-plan-alias@example.com";
        const account = await createPasswordlessSessionForUser(targetEmail);
        const primary = await AccountLinking.createPrimaryUser(
          account.recipeUserId,
        );
        expect(primary.status).toBe("OK");
        if (primary.status !== "OK")
          throw new Error("failed to create primary");
        const alias = await Passwordless.signInUp({
          tenantId: "public",
          email: aliasEmail,
          userContext: { rowndDisableAutomaticAccountLinking: true },
        });
        await expect(
          AccountLinking.linkAccounts(alias.recipeUserId, primary.user.id),
        ).resolves.toMatchObject({ status: "OK" });
        await UserMetadata.updateUserMetadata(primary.user.id, {
          rownd_pending_verification: [
            {
              id: "truncated-plan",
              field: "email",
              value: targetEmail,
              created_at: new Date().toISOString(),
              tenantId: "public",
              purpose: "UPDATE_PASSWORDLESS",
              initiatingSessionHandle: account.sessionHandle,
              verificationRecipeUserId: account.recipeUserId.getAsString(),
              status: "COMMITTING",
              targetCanonicalRecipeUserId: account.recipeUserId.getAsString(),
              retiredMethods: [],
            },
          ],
        });

        const originalDisassociate = MultiTenancy.disassociateUserFromTenant;
        let planPersistedBeforeCleanup = false;
        vi.spyOn(MultiTenancy, "disassociateUserFromTenant").mockImplementation(
          async (...input) => {
            const metadata = await UserMetadata.getUserMetadata(
              primary.user.id,
            );
            const pendingVerifications = (
              metadata.metadata as unknown as {
                rownd_pending_verification: Array<{
                  retiredMethods: Array<{
                    recipeUserId: string;
                    email: string;
                  }>;
                }>;
              }
            ).rownd_pending_verification;
            expect(pendingVerifications[0].retiredMethods).toContainEqual({
              recipeUserId: alias.recipeUserId.getAsString(),
              email: aliasEmail,
            });
            planPersistedBeforeCleanup = true;
            return originalDisassociate(...input);
          },
        );
        const originalDeleteUser = SuperTokens.deleteUser;
        let aliasWasDisassociatedBeforeDelete = false;
        vi.spyOn(SuperTokens, "deleteUser").mockImplementation(
          async (...input) => {
            if (input[0] === alias.recipeUserId.getAsString()) {
              const owner = await SuperTokens.getUser(input[0]);
              const method = owner?.loginMethods.find(
                (candidate) =>
                  candidate.recipeUserId.getAsString() === input[0],
              );
              aliasWasDisassociatedBeforeDelete =
                method !== undefined && !method.tenantIds.includes("public");
            }
            return originalDeleteUser(...input);
          },
        );

        const response = await requestEmailChange(
          account.accessToken,
          targetEmail,
        );
        expect(response.status).toBe(200);
        expect(planPersistedBeforeCleanup).toBe(true);
        expect(aliasWasDisassociatedBeforeDelete).toBe(true);
        await expect(
          SuperTokens.getUser(alias.recipeUserId.getAsString()),
        ).resolves.toBeUndefined();
        const replacementAlias = await Passwordless.signInUp({
          tenantId: "public",
          email: aliasEmail,
          userContext: { rowndDisableAutomaticAccountLinking: true },
        });
        expect(replacementAlias.recipeUserId.getAsString()).not.toBe(
          alias.recipeUserId.getAsString(),
        );
      });

      it("fails closed when the target is unverified immediately before metadata finalization", async () => {
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
        });
        server = s;
        testPORT = port;
        const targetEmail = "final-target-validation@example.com";
        const account = await createPasswordlessSessionForUser(targetEmail);
        await UserMetadata.updateUserMetadata(account.userId, {
          rownd_pending_verification: [
            {
              id: "final-target-validation",
              field: "email",
              value: targetEmail,
              created_at: new Date().toISOString(),
              tenantId: "public",
              purpose: "UPDATE_PASSWORDLESS",
              initiatingSessionHandle: account.sessionHandle,
              verificationRecipeUserId: account.recipeUserId.getAsString(),
              status: "COMMITTING",
              targetCanonicalRecipeUserId: account.recipeUserId.getAsString(),
              retiredMethods: [],
            },
          ],
        });

        const originalGetUser = SuperTokens.getUser;
        let targetLookupCount = 0;
        vi.spyOn(SuperTokens, "getUser").mockImplementation(
          async (...input) => {
            if (input[0] === account.userId) {
              targetLookupCount += 1;
              if (targetLookupCount === 4) {
                await EmailVerification.unverifyEmail(
                  account.recipeUserId,
                  targetEmail,
                );
              }
            }
            return originalGetUser(...input);
          },
        );

        await expect(
          startPendingEmailVerification({
            userId: account.userId,
            recipeUserId: account.recipeUserId,
            email: "final-target-validation-new@example.com",
            tenantId: "public",
            pendingVerificationId: "must-not-be-created",
            initiatingSessionHandle: account.sessionHandle,
          }),
        ).rejects.toThrow(
          "email change cleanup incomplete; account reconciliation is required",
        );
        const metadata = await UserMetadata.getUserMetadata(account.userId);
        expect((metadata.metadata as any).rownd_pending_verification).toEqual([
          expect.objectContaining({ id: "final-target-validation" }),
        ]);
        expect(
          (metadata.metadata as any).rownd_pending_verification,
        ).not.toEqual([expect.objectContaining({ id: "must-not-be-created" })]);
      });

      it("requires the target to remain verified across account linking", async () => {
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
        });
        server = s;
        testPORT = port;
        const currentEmail = "link-verification-current@example.com";
        const targetEmail = "link-verification-target@example.com";
        const account = await createPasswordlessSessionForUser(currentEmail);
        expect(
          await requestEmailChange(account.accessToken, targetEmail),
        ).toMatchObject({ status: 200 });
        const token = await EmailVerification.createEmailVerificationToken(
          "public",
          account.recipeUserId,
          targetEmail,
        );
        expect(token.status).toBe("OK");
        if (token.status !== "OK") throw new Error("failed to create token");
        await EmailVerification.verifyEmailUsingToken(
          "public",
          token.token,
          false,
        );

        const originalLinkAccounts = AccountLinking.linkAccounts;
        let targetRecipeUserId: string | undefined;
        vi.spyOn(AccountLinking, "linkAccounts").mockImplementation(
          async (recipeUserId, primaryUserId, userContext) => {
            targetRecipeUserId = recipeUserId.getAsString();
            const targetBeforeLink = await SuperTokens.getUser(
              targetRecipeUserId,
            );
            expect(
              targetBeforeLink?.loginMethods.find(
                (method) =>
                  method.recipeUserId.getAsString() === targetRecipeUserId,
              )?.verified,
            ).toBe(true);
            const result = await originalLinkAccounts(
              recipeUserId,
              primaryUserId,
              userContext,
            );
            await EmailVerification.unverifyEmail(recipeUserId, targetEmail);
            return result;
          },
        );

        await expect(
          completePendingEmailVerification({
            recipeUserId: account.recipeUserId,
            email: targetEmail,
            sessionHandle: account.sessionHandle,
          }),
        ).rejects.toThrow("verified email target is invalid");
        expect(targetRecipeUserId).toBeDefined();
        const user = await SuperTokens.getUser(account.userId);
        expect(
          user?.loginMethods.some(
            (method) =>
              method.recipeUserId.getAsString() === targetRecipeUserId,
          ),
        ).toBe(false);
        const metadata = await UserMetadata.getUserMetadata(account.userId);
        expect((metadata.metadata as any).rownd_pending_verification).toEqual(
          [],
        );
      });

      it("fails closed for malformed committing cleanup state", async () => {
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
        });
        server = s;
        testPORT = port;
        const account = await createPasswordlessSessionForUser(
          "malformed-committing@example.com",
        );
        const victim = await Passwordless.signInUp({
          tenantId: "public",
          email: "malformed-victim@example.com",
          userContext: { rowndDisableAutomaticAccountLinking: true },
        });
        await UserMetadata.updateUserMetadata(account.userId, {
          rownd_pending_verification: [
            {
              id: "malformed-committing",
              field: "email",
              value: "malformed-committing@example.com",
              created_at: new Date().toISOString(),
              tenantId: "public",
              purpose: "UPDATE_PASSWORDLESS",
              initiatingSessionHandle: account.sessionHandle,
              verificationRecipeUserId: account.recipeUserId.getAsString(),
              status: "COMMITTING",
              targetCanonicalRecipeUserId: account.recipeUserId.getAsString(),
              retiredMethods: [
                {
                  recipeUserId: victim.recipeUserId.getAsString(),
                  email: "malformed-victim@example.com",
                },
              ],
            },
          ],
        });

        const response = await requestEmailChange(
          account.accessToken,
          "malformed-new@example.com",
        );
        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toMatchObject({
          message:
            "email change cleanup incomplete; account reconciliation is required",
        });
        await expect(
          SuperTokens.getUser(victim.recipeUserId.getAsString()),
        ).resolves.toMatchObject({ id: victim.user.id });
        const metadata = await UserMetadata.getUserMetadata(account.userId);
        expect((metadata.metadata as any).rownd_pending_verification).toEqual([
          expect.objectContaining({ id: "malformed-committing" }),
        ]);
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

      it("allows ordinary Core verification when the pending marker is removed without changing the login method", async () => {
        const emailVerificationLinks: string[] = [];
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
          emailVerificationLinks,
        });
        server = s;
        testPORT = port;
        const initiatingUser = await createPasswordlessSessionForUser(
          "missing-session-current@example.com",
        );
        const targetEmail = "missing-session-target@example.com";

        const updateRes = await requestEmailChange(
          initiatingUser.accessToken,
          targetEmail,
        );
        expect(updateRes.status).toBe(200);
        expect(emailVerificationLinks).toHaveLength(1);
        const verificationUrl = new URL(emailVerificationLinks[0]);
        const token = verificationUrl.searchParams.get("token");
        const pendingVerificationId = verificationUrl.searchParams.get(
          "rowndPendingVerificationId",
        );
        expect(token).toBeTruthy();
        expect(pendingVerificationId).toBeTruthy();

        const ordinaryVerificationRes = await verifyEmailToken(
          token || "unused",
        );
        expect(ordinaryVerificationRes.status).toBe(200);
        await expect(ordinaryVerificationRes.json()).resolves.toEqual({
          status: "OK",
        });

        const user = await SuperTokens.getUser(initiatingUser.userId);
        expect(
          user?.loginMethods.find(
            (method) => method.recipeId === "passwordless",
          )?.email,
        ).toBe("missing-session-current@example.com");
        await expect(
          EmailVerification.isEmailVerified(
            initiatingUser.recipeUserId,
            targetEmail,
          ),
        ).resolves.toBe(true);
      });

      it("does not consume a pending token from another session for the same user", async () => {
        const emailVerificationLinks: string[] = [];
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
          emailVerificationLinks,
        });
        server = s;
        testPORT = port;
        const initiatingUser = await createPasswordlessSessionForUser(
          "unrelated-session-current@example.com",
        );
        const otherSession =
          await Session.createNewSessionWithoutRequestResponse(
            "public",
            initiatingUser.recipeUserId,
            {},
            {},
            true,
          );
        const otherSessionAccessToken = otherSession.getAccessToken();
        const otherSessionHandle = otherSession.getHandle();

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
        expect(emailVerificationLinks).toHaveLength(1);
        const verificationUrl = new URL(emailVerificationLinks[0]);
        const token = verificationUrl.searchParams.get("token");
        const pendingVerificationId = verificationUrl.searchParams.get(
          "rowndPendingVerificationId",
        );
        expect(token).toBeTruthy();
        expect(pendingVerificationId).toBeTruthy();

        const verifyRes = await verifyEmailToken(
          token || "unused",
          otherSessionAccessToken,
          pendingVerificationId || "unused",
        );
        expect(verifyRes.status).toBe(200);
        await expect(verifyRes.json()).resolves.toEqual({
          status: "GENERAL_ERROR",
          message: "email change verification requires the initiating session",
        });
        expect(verifyRes.headers.get("st-access-token")).toBeNull();
        await expect(
          Session.getSessionInformation(otherSessionHandle),
        ).resolves.toBeDefined();

        const initiatingSessionRes = await verifyEmailToken(
          token || "unused",
          initiatingUser.accessToken,
          pendingVerificationId || "unused",
        );
        expect(initiatingSessionRes.status).toBe(200);
        await expect(initiatingSessionRes.json()).resolves.toEqual({
          status: "OK",
        });
      });

      it("retains pending metadata after a consumed-token retry until a new change supersedes it", async () => {
        const emailVerificationLinks: string[] = [];
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
          emailVerificationLinks,
        });
        server = s;
        testPORT = port;
        const initiatingUser = await createPasswordlessSessionForUser(
          "consumed-envelope-current@example.com",
        );
        const targetEmail = "consumed-envelope-target@example.com";

        const updateRes = await requestEmailChange(
          initiatingUser.accessToken,
          targetEmail,
        );
        expect(updateRes.status).toBe(200);
        expect(emailVerificationLinks).toHaveLength(1);
        const verificationUrl = new URL(emailVerificationLinks[0]);
        const token = verificationUrl.searchParams.get("token") || "unused";
        const pendingVerificationId =
          verificationUrl.searchParams.get("rowndPendingVerificationId") ||
          "unused";

        const getUser = vi
          .spyOn(SuperTokens, "getUser")
          .mockRejectedValueOnce(new Error("completion crashed"));
        const crashedRes = await verifyEmailToken(
          token,
          initiatingUser.accessToken,
          pendingVerificationId,
        );
        expect(crashedRes.status).toBe(500);
        getUser.mockRestore();

        await expect(
          EmailVerification.isEmailVerified(
            initiatingUser.recipeUserId,
            targetEmail,
          ),
        ).resolves.toBe(true);
        const pendingMetadata = await UserMetadata.getUserMetadata(
          initiatingUser.userId,
        );
        expect(
          (pendingMetadata.metadata as any).rownd_pending_verification,
        ).toEqual([expect.objectContaining({ id: pendingVerificationId })]);

        const retryRes = await verifyEmailToken(
          token,
          initiatingUser.accessToken,
          pendingVerificationId,
        );
        expect(retryRes.status).toBe(200);
        await expect(retryRes.json()).resolves.toEqual({
          status: "EMAIL_VERIFICATION_INVALID_TOKEN_ERROR",
        });
        await expect(
          EmailVerification.isEmailVerified(
            initiatingUser.recipeUserId,
            targetEmail,
          ),
        ).resolves.toBe(true);
        const metadataAfterRetry = await UserMetadata.getUserMetadata(
          initiatingUser.userId,
        );
        expect(
          (metadataAfterRetry.metadata as any).rownd_pending_verification,
        ).toEqual([expect.objectContaining({ id: pendingVerificationId })]);

        const replacementRes = await requestEmailChange(
          initiatingUser.accessToken,
          targetEmail,
        );
        expect(replacementRes.status).toBe(200);
        expect(emailVerificationLinks).toHaveLength(2);
        await expect(
          EmailVerification.isEmailVerified(
            initiatingUser.recipeUserId,
            targetEmail,
          ),
        ).resolves.toBe(false);
        const replacementMetadata = await UserMetadata.getUserMetadata(
          initiatingUser.userId,
        );
        const replacementPending = (replacementMetadata.metadata as any)
          .rownd_pending_verification;
        expect(replacementPending).toEqual([
          expect.objectContaining({
            status: "PENDING",
            value: targetEmail,
          }),
        ]);
        expect(replacementPending[0].id).not.toBe(pendingVerificationId);
      });

      it("allows one concurrent duplicate verification to complete", async () => {
        const emailVerificationLinks: string[] = [];
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
          emailVerificationLinks,
        });
        server = s;
        testPORT = port;
        const initiatingUser = await createPasswordlessSessionForUser(
          "concurrent-envelope-current@example.com",
        );
        const targetEmail = "concurrent-envelope-target@example.com";

        const updateRes = await requestEmailChange(
          initiatingUser.accessToken,
          targetEmail,
        );
        expect(updateRes.status).toBe(200);
        const verificationUrl = new URL(emailVerificationLinks[0]);
        const token = verificationUrl.searchParams.get("token") || "unused";
        const pendingVerificationId =
          verificationUrl.searchParams.get("rowndPendingVerificationId") ||
          "unused";

        const originalGetSessionInformation = Session.getSessionInformation;
        let pendingResolutionCount = 0;
        let releasePendingResolutions: () => void = () => undefined;
        const pendingResolutionsReady = new Promise<void>((resolve) => {
          releasePendingResolutions = resolve;
        });
        vi.spyOn(Session, "getSessionInformation").mockImplementation(
          async (...input) => {
            const result = await originalGetSessionInformation(...input);
            if (pendingResolutionCount < 2) {
              pendingResolutionCount += 1;
              if (pendingResolutionCount === 2) {
                releasePendingResolutions();
              }
              await pendingResolutionsReady;
            }
            return result;
          },
        );

        const responses = await Promise.all([
          verifyEmailToken(
            token,
            initiatingUser.accessToken,
            pendingVerificationId,
          ),
          verifyEmailToken(
            token,
            initiatingUser.accessToken,
            pendingVerificationId,
          ),
        ]);
        const bodies = await Promise.all(
          responses.map((response) => response.json()),
        );
        expect(bodies).toEqual(
          expect.arrayContaining([
            { status: "OK" },
            { status: "EMAIL_VERIFICATION_INVALID_TOKEN_ERROR" },
          ]),
        );

        const user = await SuperTokens.getUser(initiatingUser.userId);
        const passwordlessMethods = user?.loginMethods.filter(
          (method) => method.recipeId === "passwordless",
        );
        expect(passwordlessMethods).toHaveLength(1);
        expect(
          passwordlessMethods
            ?.find((method) => method.email === targetEmail)
            ?.recipeUserId.getAsString(),
        ).not.toBe(initiatingUser.recipeUserId.getAsString());
        const metadata = await UserMetadata.getUserMetadata(
          initiatingUser.userId,
        );
        expect((metadata.metadata as any).rownd_pending_verification).toEqual(
          [],
        );
      });

      it("rejects a mismatched pending marker before consuming its Core token", async () => {
        const emailVerificationLinks: string[] = [];
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
          emailVerificationLinks,
        });
        server = s;
        testPORT = port;
        const initiatingUser = await createPasswordlessSessionForUser(
          "tampered-envelope-current@example.com",
        );

        const updateRes = await requestEmailChange(
          initiatingUser.accessToken,
          "tampered-envelope-target@example.com",
        );
        expect(updateRes.status).toBe(200);
        const verificationUrl = new URL(emailVerificationLinks[0]);
        const token = verificationUrl.searchParams.get("token");
        expect(token).toBeTruthy();
        const pendingVerificationId = verificationUrl.searchParams.get(
          "rowndPendingVerificationId",
        );

        const mismatchedMarkerRes = await verifyEmailToken(
          token || "unused",
          initiatingUser.accessToken,
          "wrong-pending-id",
        );
        await expect(mismatchedMarkerRes.json()).resolves.toEqual({
          status: "GENERAL_ERROR",
          message: "email change verification requires the initiating session",
        });
        const metadataAfterMismatch = await UserMetadata.getUserMetadata(
          initiatingUser.userId,
        );
        expect(
          (metadataAfterMismatch.metadata as any).rownd_pending_verification,
        ).toEqual([
          expect.objectContaining({
            id: pendingVerificationId,
            status: "PENDING",
          }),
        ]);

        const validRes = await verifyEmailToken(
          token || "unused",
          initiatingUser.accessToken,
          pendingVerificationId || "unused",
        );
        expect(validRes.status).toBe(200);
        await expect(validRes.json()).resolves.toEqual({ status: "OK" });
      });

      it("cleans up verification when email ownership changes before completion", async () => {
        const emailVerificationLinks: string[] = [];
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
          emailVerificationLinks,
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

        expect(emailVerificationLinks).toHaveLength(1);
        const verificationUrl = new URL(emailVerificationLinks[0]);

        const verifyRes = await verifyEmailToken(
          verificationUrl.searchParams.get("token") || "unused",
          changingUser.accessToken,
          verificationUrl.searchParams.get("rowndPendingVerificationId") ||
            "unused",
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

      it("ignores malformed other-tenant plans and preserves colliding IDs", async () => {
        const emailVerificationLinks: string[] = [];
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
          emailVerificationLinks,
        });
        server = s;
        testPORT = port;
        const currentEmail = "tenant-safe-current@example.com";
        const account = await createPasswordlessSessionForUser(currentEmail);
        const malformedOtherTenantPlan = {
          id: "colliding-plan-id",
          field: "email",
          value: "other-target@example.com",
          created_at: new Date().toISOString(),
          tenantId: "other-tenant",
          status: "COMMITTING",
          targetCanonicalRecipeUserId: 42,
          retiredMethods: "invalid",
        };
        await UserMetadata.updateUserMetadata(account.userId, {
          rownd_pending_verification: [malformedOtherTenantPlan],
        });

        await startPendingEmailVerification({
          userId: account.userId,
          recipeUserId: account.recipeUserId,
          email: "public-target@example.com",
          tenantId: "public",
          pendingVerificationId: "colliding-plan-id",
          initiatingSessionHandle: account.sessionHandle,
        });
        let metadata = await UserMetadata.getUserMetadata(account.userId);
        expect((metadata.metadata as any).rownd_pending_verification).toEqual([
          malformedOtherTenantPlan,
          expect.objectContaining({
            id: "colliding-plan-id",
            tenantId: "public",
            status: "PENDING",
          }),
        ]);

        await startPendingEmailVerification({
          userId: account.userId,
          recipeUserId: account.recipeUserId,
          email: currentEmail,
          tenantId: "public",
          pendingVerificationId: "unused",
          initiatingSessionHandle: account.sessionHandle,
        });
        metadata = await UserMetadata.getUserMetadata(account.userId);
        expect((metadata.metadata as any).rownd_pending_verification).toEqual([
          malformedOtherTenantPlan,
        ]);
      });

      it("preserves another tenant's pending and committing plans and tokens during public start and reset", async () => {
        const emailVerificationLinks: string[] = [];
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
          emailVerificationLinks,
        });
        server = s;
        testPORT = port;
        const currentEmail = "tenant-plan-current@example.com";
        const account = await createPasswordlessSessionForUser(currentEmail);
        const primary = await AccountLinking.createPrimaryUser(
          account.recipeUserId,
        );
        expect(primary.status).toBe("OK");
        if (primary.status !== "OK")
          throw new Error("failed to create primary");
        await MultiTenancy.createOrUpdateTenant("tenant-plan-b");
        const otherTarget = await Passwordless.signInUp({
          tenantId: "tenant-plan-b",
          email: "tenant-plan-target@example.com",
          userContext: { rowndDisableAutomaticAccountLinking: true },
        });
        await expect(
          AccountLinking.linkAccounts(
            otherTarget.recipeUserId,
            primary.user.id,
          ),
        ).resolves.toMatchObject({ status: "OK" });
        const otherPendingPlan = {
          id: "other-tenant-pending",
          field: "email",
          value: "tenant-plan-target@example.com",
          created_at: new Date().toISOString(),
          tenantId: "tenant-plan-b",
          purpose: "UPDATE_PASSWORDLESS",
          initiatingSessionHandle: "other-tenant-session",
          verificationRecipeUserId: otherTarget.recipeUserId.getAsString(),
          status: "PENDING",
        };
        await UserMetadata.updateUserMetadata(primary.user.id, {
          rownd_pending_verification: [otherPendingPlan],
        });
        await EmailVerification.unverifyEmail(
          otherTarget.recipeUserId,
          "tenant-plan-target@example.com",
        );
        const pendingToken =
          await EmailVerification.createEmailVerificationToken(
            "tenant-plan-b",
            otherTarget.recipeUserId,
            "tenant-plan-target@example.com",
          );
        expect(pendingToken.status).toBe("OK");
        if (pendingToken.status !== "OK")
          throw new Error("failed to create token");

        await startPendingEmailVerification({
          userId: primary.user.id,
          recipeUserId: account.recipeUserId,
          email: "public-pending@example.com",
          tenantId: "public",
          pendingVerificationId: "public-pending",
          initiatingSessionHandle: account.sessionHandle,
        });

        const afterStart = await UserMetadata.getUserMetadata(primary.user.id);
        expect((afterStart.metadata as any).rownd_pending_verification).toEqual(
          [
            otherPendingPlan,
            expect.objectContaining({
              id: "public-pending",
              tenantId: "public",
              status: "PENDING",
            }),
          ],
        );
        await expect(
          EmailVerification.verifyEmailUsingToken(
            "tenant-plan-b",
            pendingToken.token,
            false,
          ),
        ).resolves.toMatchObject({ status: "OK" });

        const publicPlan = (afterStart.metadata as any)
          .rownd_pending_verification[1];
        const otherCommittingPlan = {
          ...otherPendingPlan,
          id: "other-tenant-committing",
          status: "COMMITTING",
          targetCanonicalRecipeUserId: otherTarget.recipeUserId.getAsString(),
          retiredMethods: [],
        };
        await UserMetadata.updateUserMetadata(primary.user.id, {
          rownd_pending_verification: [otherCommittingPlan, publicPlan],
        });
        await EmailVerification.unverifyEmail(
          otherTarget.recipeUserId,
          "tenant-plan-target@example.com",
        );
        const committingToken =
          await EmailVerification.createEmailVerificationToken(
            "tenant-plan-b",
            otherTarget.recipeUserId,
            "tenant-plan-target@example.com",
          );
        expect(committingToken.status).toBe("OK");
        if (committingToken.status !== "OK") {
          throw new Error("failed to create committing token");
        }

        await startPendingEmailVerification({
          userId: primary.user.id,
          recipeUserId: account.recipeUserId,
          email: currentEmail,
          tenantId: "public",
          pendingVerificationId: "unused-reset-id",
          initiatingSessionHandle: account.sessionHandle,
        });

        const afterReset = await UserMetadata.getUserMetadata(primary.user.id);
        expect((afterReset.metadata as any).rownd_pending_verification).toEqual(
          [otherCommittingPlan],
        );
        await expect(
          EmailVerification.verifyEmailUsingToken(
            "tenant-plan-b",
            committingToken.token,
            false,
          ),
        ).resolves.toMatchObject({ status: "OK" });
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
        const staleVerificationUrl = new URL(emailVerificationLinks[0]);
        const staleToken = staleVerificationUrl.searchParams.get("token");
        const stalePendingVerificationId =
          staleVerificationUrl.searchParams.get("rowndPendingVerificationId");
        expect(staleToken).toBeTruthy();
        expect(stalePendingVerificationId).toBeTruthy();

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
          stalePendingVerificationId || "unused",
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
        "rejects profile email changes for %s accounts without a Passwordless method",
        async (authLevel) => {
          const { server: s, port } = await setup(
            coreConnectionURI,
            undefined,
            {
              enableEmailVerification: true,
            },
          );
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

          expect(res.status).toBe(409);
          const metadata = await UserMetadata.getUserMetadata(
            guestSession.recipeUserId.getAsString(),
          );
          expect(
            (metadata.metadata as any).rownd_pending_verification,
          ).toBeUndefined();
        },
      );

      it("rejects a guest email change before checking ownership", async () => {
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
        expect(res.status).toBe(409);
        await expect(res.json()).resolves.toEqual({
          status: "ERROR",
          code: 409,
          message: "the account has no passwordless sign-in method",
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
        expect(res.status).toBe(409);

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

      it.each(["google", "apple"])(
        "adds a Passwordless email method for %s-only accounts",
        async (providerId) => {
          const emailVerificationLinks: string[] = [];
          const { server: s, port } = await setup(
            coreConnectionURI,
            undefined,
            {
              enableEmailVerification: true,
              emailVerificationLinks,
            },
          );
          server = s;
          testPORT = port;
          const thirdPartyUser = await createThirdPartySessionForUser(
            `${providerId}-only-user@example.com`,
            providerId,
          );
          const originalUser = await SuperTokens.getUser(thirdPartyUser.userId);
          const originalMetadata = await UserMetadata.getUserMetadata(
            thirdPartyUser.userId,
          );
          const originalThirdPartyMethod = originalUser?.loginMethods[0];
          const targetEmail = `${providerId}-updated@example.com`;

          const res = await fetch(
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

          expect(res.status).toBe(200);
          expect(emailVerificationLinks).toHaveLength(1);
          const verificationUrl = new URL(emailVerificationLinks[0]);
          const verifyRes = await verifyEmailToken(
            verificationUrl.searchParams.get("token") || "unused",
            thirdPartyUser.accessToken,
            verificationUrl.searchParams.get("rowndPendingVerificationId") ||
              "unused",
          );
          expect(verifyRes.status).toBe(200);
          await expect(verifyRes.json()).resolves.toEqual({ status: "OK" });
          expect(verifyRes.headers.get("st-access-token")).toBeTruthy();

          const updatedUser = await SuperTokens.getUser(thirdPartyUser.userId);
          expect(updatedUser?.id).toBe(originalUser?.id);
          expect(updatedUser?.isPrimaryUser).toBe(true);
          expect(updatedUser?.loginMethods).toHaveLength(2);
          const updatedThirdPartyMethod = updatedUser?.loginMethods.find(
            (method) => method.recipeId === "thirdparty",
          );
          expect(updatedThirdPartyMethod?.recipeUserId.getAsString()).toBe(
            originalThirdPartyMethod?.recipeUserId.getAsString(),
          );
          expect(updatedUser?.loginMethods).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                recipeId: "thirdparty",
                email: `${providerId}-only-user@example.com`,
                thirdParty: originalThirdPartyMethod?.thirdParty,
              }),
              expect.objectContaining({
                recipeId: "passwordless",
                email: targetEmail,
                verified: true,
                tenantIds: ["public"],
              }),
            ]),
          );
          const metadata = await UserMetadata.getUserMetadata(
            thirdPartyUser.userId,
          );
          expect(metadata.metadata).toEqual(
            expect.objectContaining({
              ...originalMetadata.metadata,
              rownd_pending_verification: [],
              original_rownd_user: expect.objectContaining({
                data: expect.objectContaining({ email: targetEmail }),
                verified_data: expect.objectContaining({ email: targetEmail }),
              }),
            }),
          );
        },
      );

      it("rolls back the new Passwordless method when commit publication fails", async () => {
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
        });
        server = s;
        testPORT = port;
        const thirdPartyUser = await createThirdPartySessionForUser(
          "metadata-failure-provider@example.com",
        );
        const targetEmail = "metadata-failure-target@example.com";
        const updateRes = await requestEmailChange(
          thirdPartyUser.accessToken,
          targetEmail,
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
        expect((metadata.metadata as any).rownd_pending_verification).toEqual(
          [],
        );
      });

      it("retains the canonical method when replacement session creation fails", async () => {
        const emailVerificationLinks: string[] = [];
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
          emailVerificationLinks,
        });
        server = s;
        testPORT = port;
        const providerEmail = "session-failure-provider@example.com";
        const targetEmail = "session-failure-target@example.com";
        const thirdPartyUser =
          await createThirdPartySessionForUser(providerEmail);
        const updateRes = await requestEmailChange(
          thirdPartyUser.accessToken,
          targetEmail,
        );
        expect(updateRes.status).toBe(200);
        const verificationUrl = new URL(emailVerificationLinks[0]);
        const createNewSession = vi
          .spyOn(Session, "createNewSession")
          .mockRejectedValueOnce(new Error("replacement session failed"));

        const verifyRes = await verifyEmailToken(
          verificationUrl.searchParams.get("token") || "unused",
          thirdPartyUser.accessToken,
          verificationUrl.searchParams.get("rowndPendingVerificationId") ||
            "unused",
        );
        createNewSession.mockRestore();

        expect(verifyRes.status).toBe(500);
        const user = await SuperTokens.getUser(thirdPartyUser.userId);
        expect(user?.loginMethods).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              recipeId: "thirdparty",
              email: providerEmail,
            }),
            expect.objectContaining({
              recipeId: "passwordless",
              email: targetEmail,
            }),
          ]),
        );
        const metadata = await UserMetadata.getUserMetadata(
          thirdPartyUser.userId,
        );
        expect((metadata.metadata as any).original_rownd_user.data.email).toBe(
          targetEmail,
        );
        expect((metadata.metadata as any).rownd_pending_verification).toEqual(
          [],
        );
        await expect(
          Session.getAllSessionHandlesForUser(
            thirdPartyUser.userId,
            true,
            "public",
          ),
        ).resolves.toEqual([]);
        await expect(
          EmailVerification.isEmailVerified(
            user!.loginMethods.find((method) => method.email === targetEmail)!
              .recipeUserId,
            targetEmail,
          ),
        ).resolves.toBe(true);
      });

      it("does not unverify another account when its token is submitted with a pending marker", async () => {
        const emailVerificationLinks: string[] = [];
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
          emailVerificationLinks,
        });
        server = s;
        testPORT = port;
        const attacker = await createThirdPartySessionForUser(
          "marker-attacker-provider@example.com",
        );
        const attackerTarget = "marker-attacker-target@example.com";
        const updateRes = await requestEmailChange(
          attacker.accessToken,
          attackerTarget,
        );
        expect(updateRes.status).toBe(200);
        const attackerVerificationUrl = new URL(emailVerificationLinks[0]);
        const victim = await createPasswordlessSessionForUser(
          "foreign-token-victim@example.com",
        );
        await EmailVerification.unverifyEmail(
          victim.recipeUserId,
          "foreign-token-victim@example.com",
        );
        const victimToken =
          await EmailVerification.createEmailVerificationToken(
            "public",
            victim.recipeUserId,
            "foreign-token-victim@example.com",
          );
        expect(victimToken.status).toBe("OK");

        const verifyRes = await verifyEmailToken(
          victimToken.status === "OK" ? victimToken.token : "unused",
          attacker.accessToken,
          attackerVerificationUrl.searchParams.get(
            "rowndPendingVerificationId",
          ) || "unused",
        );

        await expect(verifyRes.json()).resolves.toEqual({
          status: "GENERAL_ERROR",
          message:
            "email change session is no longer active; start the email change again",
        });
        await expect(
          EmailVerification.isEmailVerified(
            victim.recipeUserId,
            "foreign-token-victim@example.com",
          ),
        ).resolves.toBe(true);
        const attackerMetadata = await UserMetadata.getUserMetadata(
          attacker.userId,
        );
        expect(
          (attackerMetadata.metadata as any).rownd_pending_verification,
        ).toEqual([]);
      });

      it("links an email method to a phone-only Passwordless user and retains the phone method", async () => {
        const emailVerificationLinks: string[] = [];
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
          emailVerificationLinks,
          passwordlessContactMethod: "EMAIL_OR_PHONE",
        });
        server = s;
        testPORT = port;
        const phoneNumber = "+15555550199";
        const targetEmail = "phone-only-target@example.com";
        const signInUpResponse = await Passwordless.signInUp({
          phoneNumber,
          tenantId: "public",
        });
        const session = await Session.createNewSessionWithoutRequestResponse(
          "public",
          signInUpResponse.recipeUserId,
          {},
          {},
          true,
        );

        const updateRes = await requestEmailChange(
          session.getAccessToken(),
          targetEmail,
        );
        expect(updateRes.status).toBe(200);
        expect(emailVerificationLinks).toHaveLength(1);
        const verificationUrl = new URL(emailVerificationLinks[0]);
        const verifyRes = await verifyEmailToken(
          verificationUrl.searchParams.get("token") || "unused",
          session.getAccessToken(),
          verificationUrl.searchParams.get("rowndPendingVerificationId") ||
            "unused",
        );
        await expect(verifyRes.json()).resolves.toEqual({ status: "OK" });

        const user = await SuperTokens.getUser(signInUpResponse.user.id);
        const passwordlessMethods = user?.loginMethods.filter(
          (method) => method.recipeId === "passwordless",
        );
        expect(passwordlessMethods).toHaveLength(2);
        expect(
          passwordlessMethods?.find(
            (method) =>
              method.recipeUserId.getAsString() ===
              signInUpResponse.recipeUserId.getAsString(),
          )?.phoneNumber,
        ).toBe(phoneNumber);
        expect(
          passwordlessMethods
            ?.find((method) => method.email === targetEmail)
            ?.recipeUserId.getAsString(),
        ).not.toBe(signInUpResponse.recipeUserId.getAsString());
      });

      it("ignores unrelated-tenant email methods when adding email to a phone and third-party account", async () => {
        const emailVerificationLinks: string[] = [];
        const { server: s, port } = await setup(coreConnectionURI, undefined, {
          enableEmailVerification: true,
          emailVerificationLinks,
          passwordlessContactMethod: "EMAIL_OR_PHONE",
        });
        server = s;
        testPORT = port;
        const otherTenant = "unrelated-email-tenant";
        const targetEmail = "tenant-scoped-target@example.com";
        await MultiTenancy.createOrUpdateTenant(otherTenant);
        const phone = await Passwordless.signInUp({
          phoneNumber: "+15555550200",
          tenantId: "public",
        });
        const primary = await AccountLinking.createPrimaryUser(
          phone.recipeUserId,
        );
        expect(primary.status).toBe("OK");
        if (primary.status !== "OK")
          throw new Error("failed to create primary");
        const thirdParty = await ThirdParty.manuallyCreateOrUpdateUser(
          "public",
          "google",
          "tenant-scoped-google-id",
          "tenant-scoped-provider@example.com",
          true,
          undefined,
          { rowndDisableAutomaticAccountLinking: true },
        );
        expect(thirdParty.status).toBe("OK");
        if (thirdParty.status !== "OK") {
          throw new Error("failed to create third-party user");
        }
        const unrelatedEmail = await Passwordless.signInUp({
          email: "other-tenant-email@example.com",
          tenantId: otherTenant,
          userContext: { rowndDisableAutomaticAccountLinking: true },
        });
        await expect(
          AccountLinking.linkAccounts(thirdParty.recipeUserId, primary.user.id),
        ).resolves.toMatchObject({ status: "OK" });
        await expect(
          AccountLinking.linkAccounts(
            unrelatedEmail.recipeUserId,
            primary.user.id,
          ),
        ).resolves.toMatchObject({ status: "OK" });
        const session = await Session.createNewSessionWithoutRequestResponse(
          "public",
          phone.recipeUserId,
          {},
          {},
          true,
        );

        const updateRes = await requestEmailChange(
          session.getAccessToken(),
          targetEmail,
        );
        expect(updateRes.status).toBe(200);
        expect(emailVerificationLinks).toHaveLength(1);
        const verificationUrl = new URL(emailVerificationLinks[0]);
        const verifyRes = await verifyEmailToken(
          verificationUrl.searchParams.get("token") || "unused",
          session.getAccessToken(),
          verificationUrl.searchParams.get("rowndPendingVerificationId") ||
            "unused",
        );
        await expect(verifyRes.json()).resolves.toEqual({ status: "OK" });

        const user = await SuperTokens.getUser(primary.user.id);
        expect(user?.loginMethods).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              recipeId: "passwordless",
              phoneNumber: "+15555550200",
              tenantIds: ["public"],
            }),
            expect.objectContaining({
              recipeId: "thirdparty",
              tenantIds: ["public"],
            }),
            expect.objectContaining({
              recipeId: "passwordless",
              email: "other-tenant-email@example.com",
              tenantIds: [otherTenant],
            }),
            expect.objectContaining({
              recipeId: "passwordless",
              email: targetEmail,
              tenantIds: ["public"],
            }),
          ]),
        );
      });

      it("removes only the completed pending email verification", async () => {
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
            id: "duplicate-email-2",
            field: "email",
            value: "duplicate-pending-target@example.com",
          }),
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
          {
            auth_level: "guest",
            is_anonymous: true,
            [ROWND_JWT_CLAIMS.IsAnonymous]: true,
          },
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

      it("does not rebuild registered claims while preserving the OAuth payload", async () => {
        const { server: s, port } = await setup(coreConnectionURI, {
          schema: {
            spoofed_auth_level: {
              display_name: "Spoofed auth level",
              type: "string",
              include_in_session_claims: true,
              session_claim_name: ROWND_JWT_CLAIMS.AuthLevel,
            },
            spoofed_audience: {
              display_name: "Spoofed audience",
              type: "string",
              include_in_session_claims: true,
              session_claim_name: "aud",
            },
            spoofed_subject: {
              display_name: "Spoofed subject",
              type: "string",
              include_in_session_claims: true,
              session_claim_name: "sub",
            },
            spoofed_issuer: {
              display_name: "Spoofed issuer",
              type: "string",
              include_in_session_claims: true,
              session_claim_name: "iss",
            },
            spoofed_expiry: {
              display_name: "Spoofed expiry",
              type: "number",
              include_in_session_claims: true,
              session_claim_name: "exp",
            },
          },
        });
        server = s;
        testPORT = port;
        const result = await Passwordless.signInUp({
          email: "reserved-claims@example.com",
          tenantId: "public",
        });
        await UserMetadata.updateUserMetadata(result.user.id, {
          spoofed_auth_level: "attacker",
          spoofed_audience: ["app:attacker"],
          spoofed_subject: "attacker",
          spoofed_issuer: "https://attacker.example.com",
          spoofed_expiry: 1,
        });

        const authoritativeClaims = {
          sub: result.user.id,
          iss: "https://issuer.example.com",
          exp: 4_000_000_000,
        };
        const claims = await buildRowndSessionClaims(
          result.user.id,
          authoritativeClaims,
        );
        const oauthClaims = await buildRowndOAuthPayload({
          user: result.user,
          scopes: ["openid"],
          currentPayload: authoritativeClaims,
        });

        expect(claims[ROWND_JWT_CLAIMS.AuthLevel]).toBe("verified");
        expect(claims.aud).toBeUndefined();
        expect(claims).not.toHaveProperty("sub");
        expect(claims).not.toHaveProperty("iss");
        expect(claims).not.toHaveProperty("exp");
        expect(oauthClaims).toMatchObject(authoritativeClaims);
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
                rowndNativeEmailVerification: true,
                rowndRedirectToPath: "/untrusted-redirect",
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
        expect(verificationUrl.searchParams.has("redirectToPath")).toBe(false);

        const body = await res.json();
        expect(body.email_verification_pending).toBe(true);
        expect(body.data.email).toBe("email-verified-current@example.com");
        expect(body.verified_data.email).toBe(
          "email-verified-current@example.com",
        );

        const metadata = await UserMetadata.getUserMetadata(userId);
        const pendingVerification = (metadata.metadata as any)
          .rownd_pending_verification[0];
        expect((metadata.metadata as any).rownd_pending_verification).toEqual([
          expect.objectContaining({
            field: "email",
            value: "email-new-target@example.com",
          }),
        ]);
        expect(
          verificationUrl.searchParams.get("rowndPendingVerificationId"),
        ).toBe(pendingVerification.id);
        expect(pendingVerification).not.toHaveProperty(
          "emailVerificationTokenHash",
        );
        expect(pendingVerification).not.toHaveProperty(
          "emailVerificationCoreTokenCiphertext",
        );
        expect(pendingVerification).not.toHaveProperty(
          "emailVerificationCoreToken",
        );
        const coreToken = verificationUrl.searchParams.get("token");
        expect(coreToken).toBeTruthy();
        expect(coreToken).not.toMatch(/^rownd-pending-email-/);

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

      it("returns combined metadata after updating a linked account", async () => {
        const { server: s, port } = await setup(importCoreConnectionURI);
        server = s;
        testPORT = port;
        const passwordlessResult = await Passwordless.signInUp({
          email: `linked-meta-update-${randomUUID()}@example.com`,
          tenantId: "public",
        });
        const linkedRecipeUserId =
          passwordlessResult.recipeUserId.getAsString();
        const { session, linkedUser } = await createLinkedGuestSession(
          passwordlessResult.recipeUserId,
        );

        await UserMetadata.updateUserMetadata(linkedUser.id, {
          primary_only: "before",
        });
        await UserMetadata.updateUserMetadata(linkedRecipeUserId, {
          linked_only: "linked",
        });

        const updateRes = await fetch(
          `http://localhost:${testPORT}/auth/plugin/rownd/user/meta`,
          {
            method: "PUT",
            headers: {
              ...getAuthedHeaders(session.getAccessToken()),
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ meta: { primary_only: "after" } }),
          },
        );

        expect(updateRes.status).toBe(200);
        await expect(updateRes.json()).resolves.toEqual({
          status: "OK",
          id: linkedUser.id,
          meta: {
            primary_only: "after",
            linked_only: "linked",
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
        const emailVerificationLinks: string[] = [];
        const { server: s, port } = await setup(
          coreConnectionURI,
          { clientDomains: { mobile: "rowndsupertokens://" } },
          {
            enableEmailVerification: true,
            emailVerificationLinks,
          },
        );
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
            body: JSON.stringify({
              value: "new-email-field@example.com",
              context: {
                rowndDisplayContext: "mobile_app",
                rowndClientDomain: "mobile",
                rowndNativeEmailVerification: true,
                rowndRedirectToPath: "/untrusted-redirect",
              },
            }),
          },
        );
        expect(updateRes.status).toBe(200);
        const body = await updateRes.json();
        expect(body.status).toBe("OK");
        expect(body.data.email).toBe("email-field-user@example.com");
        expect(body.verified_data.email).toBe("email-field-user@example.com");
        expect(emailVerificationLinks).toHaveLength(1);
        const verificationUrl = new URL(emailVerificationLinks[0]);
        expect(verificationUrl.protocol).toBe("rowndsupertokens:");
        expect(verificationUrl.searchParams.get("displayContext")).toBe(
          "mobile_app",
        );
        expect(verificationUrl.searchParams.has("redirectToPath")).toBe(false);
        expect(
          verificationUrl.searchParams.get("rowndPendingVerificationId"),
        ).toBeTruthy();

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

    async function verifyEmailToken(
      token: string,
      accessToken?: string,
      pendingVerificationId?: string,
    ) {
      const url = new URL(
        `http://localhost:${testPORT}/auth/user/email/verify`,
      );
      if (pendingVerificationId !== undefined) {
        url.searchParams.set(
          "rowndPendingVerificationId",
          pendingVerificationId,
        );
      }

      return fetch(url, {
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

    async function createThirdPartySessionForUser(
      email: string,
      thirdPartyId = "google",
    ) {
      const signInUpResponse = await ThirdParty.manuallyCreateOrUpdateUser(
        "public",
        thirdPartyId,
        `${thirdPartyId}-${randomUUID()}`,
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

    async function requestPasswordlessCode(
      email: string,
      intent?: "sign_in" | "sign_up",
    ) {
      return fetch(`http://localhost:${testPORT}/auth/signinup/code`, {
        method: "POST",
        headers: {
          rid: "passwordless",
          "content-type": "application/json",
          "fdi-version": "1.18",
          "st-auth-mode": "header",
        },
        body: JSON.stringify({ email, ...(intent ? { intent } : {}) }),
      });
    }

    async function consumePasswordlessLink(
      link: string,
      intent?: "sign_in" | "sign_up",
      accessToken?: string,
    ) {
      const url = new URL(link);
      return fetch(`http://localhost:${testPORT}/auth/signinup/code/consume`, {
        method: "POST",
        headers: {
          rid: "passwordless",
          "content-type": "application/json",
          "fdi-version": "1.18",
          "st-auth-mode": "header",
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({
          preAuthSessionId: url.searchParams.get("preAuthSessionId"),
          linkCode:
            url.searchParams.get("linkCode") || url.hash.replace(/^#/, ""),
          ...(intent ? { intent } : {}),
          ...(accessToken ? { shouldTryLinkingWithSessionUser: true } : {}),
        }),
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

function makeRequest(
  query: Record<string, string>,
  body: Record<string, unknown> = {},
) {
  return {
    getKeyValueFromQuery: (key: string) => query[key],
    getJSONBody: async () => body,
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
    passwordlessLinks?: string[];
    passwordlessContactMethod?: "EMAIL" | "PHONE" | "EMAIL_OR_PHONE";
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
            contactMethod: options?.passwordlessContactMethod ?? "EMAIL",
            flowType: "MAGIC_LINK",
            emailDelivery: options?.passwordlessLinks
              ? {
                  override: (originalImplementation) => ({
                    ...originalImplementation,
                    sendEmail: async (input) => {
                      options.passwordlessLinks?.push(input.urlWithLinkCode);
                    },
                  }),
                }
              : undefined,
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

describe("linked user metadata", () => {
  it("combines linked metadata recursively while preserving primary values", () => {
    const result = combineLinkedMetadata({
      primaryUserId: "primary",
      primaryMetadata: {
        shared: "primary",
      },
      linkedMetadata: [
        {
          userId: "google",
          metadata: {
            shared: "secondary",
            original_rownd_user: {
              state: "enabled",
              auth_level: "verified",
              data: { user_id: "rownd-user", first_name: "jane" },
              verified_data: {},
            },
            rownd_pending_verification: [
              {
                id: "stale",
                field: "email",
                value: "stale@example.com",
                created_at: "2026-01-01T00:00:00.000Z",
              },
            ],
          },
        },
        {
          userId: "z-apple",
          metadata: {
            original_rownd_user: {
              state: "enabled",
              auth_level: "verified",
              data: { user_id: "rownd-user", last_name: "doe" },
              verified_data: {},
              attributes: { customer: ["customer-id"] },
            },
          },
        },
      ],
    });

    expect(result.combinedMetadata).toMatchObject({
      shared: "primary",
      original_rownd_user: {
        data: {
          user_id: "rownd-user",
          first_name: "jane",
          last_name: "doe",
        },
        attributes: { customer: ["customer-id"] },
      },
    });
    expect(result.combinedMetadata).not.toHaveProperty(
      "rownd_pending_verification",
    );
  });

  it("combines missing Rownd user fields while keeping primary conflicts", () => {
    const primaryRowndUser = {
      state: "enabled",
      auth_level: "unverified",
      data: { user_id: "rownd-user" },
      verified_data: {},
    };
    const result = combineLinkedMetadata({
      primaryUserId: "primary",
      primaryMetadata: { original_rownd_user: primaryRowndUser },
      linkedMetadata: [
        {
          userId: "secondary",
          metadata: {
            original_rownd_user: {
              state: "enabled",
              auth_level: "verified",
              data: { user_id: "rownd-user", role: "admin" },
              verified_data: { email: "user@example.com" },
            },
          },
        },
      ],
    });

    expect(result.combinedMetadata.original_rownd_user).toEqual({
      ...primaryRowndUser,
      data: { user_id: "rownd-user", role: "admin" },
      verified_data: { email: "user@example.com" },
    });
    expect(result.metadataUpdate).toEqual({
      original_rownd_user: {
        ...primaryRowndUser,
        data: { user_id: "rownd-user", role: "admin" },
        verified_data: { email: "user@example.com" },
      },
    });
  });

  it("replaces a malformed primary Rownd snapshot with a valid secondary snapshot", () => {
    const secondaryRowndUser = {
      state: "enabled",
      auth_level: "verified",
      data: { user_id: "rownd-user" },
      verified_data: {},
    };
    const result = combineLinkedMetadata({
      primaryUserId: "primary",
      primaryMetadata: { original_rownd_user: {} as any },
      linkedMetadata: [
        {
          userId: "secondary",
          metadata: { original_rownd_user: secondaryRowndUser },
        },
      ],
    });

    expect(result.combinedMetadata.original_rownd_user).toEqual(
      secondaryRowndUser,
    );
    expect(result.metadataUpdate.original_rownd_user).toEqual(
      secondaryRowndUser,
    );
  });

  it("does not replace defined empty values", () => {
    const result = combineLinkedMetadata({
      primaryUserId: "primary",
      primaryMetadata: {
        nullable: null,
        disabled: false,
        emptyString: "",
        emptyList: [],
        zero: 0,
      },
      linkedMetadata: [
        {
          userId: "secondary",
          metadata: {
            original_rownd_user: {
              state: "enabled",
              auth_level: "verified",
              data: { user_id: "rownd-user" },
              verified_data: {},
            },
            nullable: "replacement",
            disabled: true,
            emptyString: "replacement",
            emptyList: ["replacement"],
            zero: 1,
          },
        },
      ],
    });

    expect(result.combinedMetadata).toMatchObject({
      nullable: null,
      disabled: false,
      emptyString: "",
      emptyList: [],
      zero: 0,
    });
  });

  it("does not combine operational metadata from linked users", () => {
    const pendingVerification = [
      {
        id: "primary-pending",
        field: "email",
        value: "pending@example.com",
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ];
    const result = combineLinkedMetadata({
      primaryUserId: "primary",
      primaryMetadata: {
        rownd_email_recipe_user_ids: { public: "primary-email-user" },
        rownd_pending_verification: pendingVerification,
      },
      linkedMetadata: [
        {
          userId: "secondary",
          metadata: {
            linked_profile: true,
            rownd_email_recipe_user_id: "stale-email-user",
            rownd_email_recipe_user_ids: { tenant: "stale-email-user" },
            rownd_migration_complete: true,
            rownd_pending_verification: [],
          },
        },
      ],
    });

    expect(result.combinedMetadata).toEqual({
      linked_profile: true,
      rownd_email_recipe_user_ids: { public: "primary-email-user" },
      rownd_pending_verification: pendingVerification,
    });
    expect(result.metadataUpdate).toEqual({ linked_profile: true });
  });

  it("selects secondary metadata deterministically by user ID", () => {
    const rowndUser = (firstName: string) => ({
      state: "enabled" as const,
      auth_level: "verified",
      data: { user_id: "rownd-user", first_name: firstName },
      verified_data: {},
    });
    const linkedMetadata = [
      { userId: "z-user", metadata: { original_rownd_user: rowndUser("Z") } },
      { userId: "a-user", metadata: { original_rownd_user: rowndUser("A") } },
    ];

    const forward = combineLinkedMetadata({
      primaryUserId: "primary",
      primaryMetadata: {},
      linkedMetadata,
    });
    const reversed = combineLinkedMetadata({
      primaryUserId: "primary",
      primaryMetadata: {},
      linkedMetadata: [...linkedMetadata].reverse(),
    });

    expect(forward).toEqual(reversed);
    expect(forward.rowndMetadataSourceUserId).toBe("a-user");
    expect(forward.combinedMetadata.original_rownd_user).toEqual(
      rowndUser("A"),
    );
  });

  it("uses user ID ordering when there is no canonical Rownd ID", () => {
    const rowndUser = {
      state: "enabled" as const,
      auth_level: "verified",
      data: { user_id: "rownd-user" },
      verified_data: {},
    };
    const linkedMetadata = [
      { userId: "z-user", metadata: { shared: "z-user" } },
      {
        userId: "a-user",
        metadata: { shared: "a-user", original_rownd_user: rowndUser },
      },
    ];

    const forward = combineLinkedMetadata({
      primaryUserId: "primary",
      primaryMetadata: {},
      linkedMetadata,
    });
    const reversed = combineLinkedMetadata({
      primaryUserId: "primary",
      primaryMetadata: {},
      linkedMetadata: [...linkedMetadata].reverse(),
    });

    expect(forward).toEqual(reversed);
    expect(forward.linkedUserIds).toEqual(["a-user", "z-user"]);
    expect(forward.combinedMetadata.shared).toBe("a-user");
    expect(forward.rowndMetadataSourceUserId).toBe("a-user");
  });

  it("merges metadata from different Rownd identities deterministically", () => {
    const primaryMetadata = { shared: "primary" };
    const result = combineLinkedMetadata({
      primaryUserId: "primary",
      primaryMetadata,
      linkedMetadata: [
        {
          userId: "google",
          metadata: {
            original_rownd_user: {
              state: "enabled",
              auth_level: "verified",
              data: { user_id: "rownd-a" },
              verified_data: {},
            },
          },
        },
        {
          userId: "apple",
          metadata: {
            original_rownd_user: {
              state: "enabled",
              auth_level: "verified",
              data: { user_id: "rownd-b" },
              verified_data: {},
            },
          },
        },
      ],
    });

    expect(result.combinedMetadata).toEqual({
      ...primaryMetadata,
      original_rownd_user: {
        state: "enabled",
        auth_level: "verified",
        data: { user_id: "rownd-b" },
        verified_data: {},
      },
    });
  });

  it("prioritizes mapped Rownd metadata before other linked metadata", () => {
    const canonicalRowndUser = {
      state: "enabled",
      auth_level: "verified",
      data: { user_id: "rownd-canonical", first_name: "Canonical" },
      verified_data: {},
    };
    const result = combineLinkedMetadata({
      primaryUserId: "primary",
      canonicalRowndUserId: "rownd-canonical",
      primaryMetadata: {},
      linkedMetadata: [
        {
          userId: "stale-recipe-user",
          metadata: {
            stale_only: true,
            original_rownd_user: {
              state: "enabled",
              auth_level: "verified",
              data: { user_id: "rownd-stale" },
              verified_data: {},
            },
          },
        },
        {
          userId: "canonical-recipe-user",
          metadata: {
            canonical_only: true,
            original_rownd_user: canonicalRowndUser,
          },
        },
      ],
    });

    expect(result.combinedMetadata.original_rownd_user).toEqual(
      canonicalRowndUser,
    );
    expect(result.combinedMetadata).toMatchObject({
      canonical_only: true,
      stale_only: true,
    });
    expect(result.rowndMetadataSourceUserId).toBe("canonical-recipe-user");
  });

  it("replaces a stale primary Rownd snapshot with the mapped identity", () => {
    const canonicalRowndUser = {
      state: "enabled" as const,
      auth_level: "verified",
      data: { user_id: "rownd-canonical", first_name: "Canonical" },
      verified_data: {},
    };
    const result = combineLinkedMetadata({
      primaryUserId: "primary",
      canonicalRowndUserId: "rownd-canonical",
      primaryMetadata: {
        primary_only: true,
        original_rownd_user: {
          state: "enabled",
          auth_level: "verified",
          data: { user_id: "rownd-stale", first_name: "Stale" },
          verified_data: {},
        },
      },
      linkedMetadata: [
        {
          userId: "canonical-recipe-user",
          metadata: { original_rownd_user: canonicalRowndUser },
        },
      ],
    });

    expect(result.combinedMetadata).toEqual({
      primary_only: true,
      original_rownd_user: canonicalRowndUser,
    });
    expect(result.metadataUpdate).toEqual({
      original_rownd_user: canonicalRowndUser,
    });
    expect(result.rowndMetadataSourceUserId).toBe("canonical-recipe-user");
  });

  it("merges linked metadata when no metadata matches the mapped Rownd ID", () => {
    const result = combineLinkedMetadata({
      primaryUserId: "primary",
      canonicalRowndUserId: "rownd-canonical",
      primaryMetadata: {},
      linkedMetadata: [
        {
          userId: "stale-recipe-user",
          metadata: {
            original_rownd_user: {
              state: "enabled",
              auth_level: "verified",
              data: { user_id: "rownd-stale" },
              verified_data: {},
            },
          },
        },
      ],
    });

    expect(result.combinedMetadata.original_rownd_user?.data.user_id).toBe(
      "rownd-stale",
    );
  });

  it("keeps a stale primary as the source when canonical metadata is missing", () => {
    const result = combineLinkedMetadata({
      primaryUserId: "primary",
      canonicalRowndUserId: "rownd-canonical",
      primaryMetadata: {
        original_rownd_user: {
          state: "enabled",
          auth_level: "verified",
          data: { user_id: "rownd-primary" },
          verified_data: {},
        },
      },
      linkedMetadata: [
        {
          userId: "linked",
          metadata: {
            original_rownd_user: {
              state: "enabled",
              auth_level: "verified",
              data: { user_id: "rownd-linked" },
              verified_data: {},
            },
          },
        },
      ],
    });

    expect(result.combinedMetadata.original_rownd_user?.data.user_id).toBe(
      "rownd-primary",
    );
    expect(result.rowndMetadataSourceUserId).toBe("primary");
  });
});

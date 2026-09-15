import { afterEach, describe, expect, it, vi } from "vitest";
import SuperTokens from "supertokens-node";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import { LoginMethod, User } from "supertokens-node/lib/build/user";
import {
  discoverMigrationById,
  planMigration as planAuthenticatedMigration,
  type MigrationIdDiscovery,
} from "./migration-plan";
import { mapRowndUserToSuperTokens } from "./rownd-compatibility";
import type { SuperTokensUserImport } from "./types";

function planMigration(input: MigrationIdDiscovery, source: SuperTokensUserImport = mapRowndUserToSuperTokens({ data: { user_id: "rownd", email: "native@example.test" } }, "public")) {
  return planAuthenticatedMigration(input, source);
}

function discovered(): MigrationIdDiscovery {
  const mapping = {
    status: "OK" as const,
    superTokensUserId: "internal",
    externalUserId: "rownd",
  };
  return {
    sourceId: "rownd",
    tenantId: "public",
    mapping,
    reverse: mapping,
    metadata: [{ rownd_migration_complete: true }],
    metadataById: new Map([["internal", { rownd_migration_complete: true }]]),
    user: new User({
      id: "rownd",
      isPrimaryUser: true,
      tenantIds: ["public"],
      timeJoined: 1,
      emails: ["native@example.test"],
      phoneNumbers: [],
      thirdParty: [],
      webauthn: { credentialIds: [] },
      loginMethods: [
        {
          recipeId: "passwordless",
          recipeUserId: "rownd",
          email: "native@example.test",
          verified: true,
          tenantIds: ["public"],
          timeJoined: 1,
        },
      ],
    }),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("ID-first migration planning", () => {
  it.each(["unchanged", "recipe introduction", "ledger only", "other tenant history", "reintroduced history"])(
    "reads each discovery ID once with linked methods and %s", async (scenario) => {
      const input = discovered();
      input.user!.loginMethods.push(new LoginMethod({ recipeId: "thirdparty", recipeUserId: "google", timeJoined: 1,
        tenantIds: ["public"], thirdParty: { id: "google", userId: "subject" }, verified: false }));
      const retired = { rowndUserId: "rownd", recipeUserId: scenario === "other tenant history" ? "old-google" : "google",
        provider: "google", subject: "subject", pendingTenantIds: [] };
      const records = new Map(input.metadataById);
      if (scenario === "recipe introduction") records.set("internal", { rownd_migration_complete: true, rownd_migration_provider_introductions: [] });
      if (scenario.includes("history")) records.set("internal", { rownd_migration_complete: true, rownd_migration_provider_retirements: [retired, retired] });
      if (scenario === "recipe introduction") records.set("google", { rownd_migration_provider_introduction: {
        ...retired, internalUserId: "internal", tenantId: "public", created: true,
      } });
      vi.spyOn(SuperTokens, "getUserIdMapping").mockResolvedValue(input.mapping);
      const users = vi.spyOn(SuperTokens, "getUser").mockImplementation(async (id) => id === "old-google" ? undefined : input.user);
      const metadata = vi.spyOn(UserMetadata, "getUserMetadata").mockImplementation(async (id) => ({ status: "OK", metadata:
        records.get(id) ?? (scenario === "ledger only" && id.startsWith("rownd-provider-revocations-") ? {
          debt: { ...retired, internalUserId: "internal", tenantId: "public" },
        } : {}),
      }));
      const discovery = await discoverMigrationById("rownd", "public", {});
      expect(discovery.pendingProviderOperations).toBe(!["unchanged", "other tenant history"].includes(scenario));
      if (scenario === "recipe introduction") expect(records.get("internal")!.rownd_migration_provider_introductions).toEqual([]);
      const ids = metadata.mock.calls.map(([id]) => id);
      expect(ids).toContain("google");
      expect(new Set(ids).size).toBe(ids.length);
      expect(users.mock.calls.map(([id]) => id)).toEqual(scenario === "other tenant history" ? ["internal", "old-google"] : ["internal"]);
    },
  );

  it("plans added providers without looking for foreign owners", () => {
    const search = vi.spyOn(SuperTokens, "listUsersByAccountInfo");
    expect(planMigration(discovered(), mapRowndUserToSuperTokens({ data: { user_id: "rownd", email: "native@example.test", apple_id: "new" } })))
      .toMatchObject({ status: "PLAN" });
    expect(search).not.toHaveBeenCalled();
  });

  it.each([
    { rownd_email_recipe_user_ids: { public: "native" } },
    { rownd_pending_verification: [{ id: "pending", field: "email", value: "pending@example.test", tenantId: "public", status: "PENDING", created_at: "2026-01-01" }] },
  ])("preserves protected native email: %j", (protection) => {
    const input = discovered();
    input.metadataById = new Map([["internal", { rownd_migration_complete: true, ...protection }]]);
    expect(planMigration(input, mapRowndUserToSuperTokens({ data: { user_id: "rownd", email: "stale@example.test" } })))
      .toMatchObject({ status: "NOOP" });
  });

  it("accepts a completed mapped user without rediscovering native identities", async () => {
    const input = discovered();
    vi.spyOn(SuperTokens, "getUserIdMapping").mockResolvedValue(input.mapping);
    const users = vi.spyOn(SuperTokens, "getUser").mockResolvedValue(input.user);
    const metadata = vi.spyOn(UserMetadata, "getUserMetadata").mockImplementation(
      async (id) => ({
        status: "OK",
        metadata: id.startsWith("rownd-provider-revocations-")
          ? {}
          : input.metadata[0]!,
      }),
    );
    const search = vi.spyOn(SuperTokens, "listUsersByAccountInfo");
    expect(
      planMigration(await discoverMigrationById("rownd", "public", {})),
    ).toMatchObject({
      status: "NOOP",
      internalUserId: "internal",
      recipeUserId: "rownd",
    });
    expect(search).not.toHaveBeenCalled();
    expect(users).toHaveBeenCalledTimes(1);
    const ids = metadata.mock.calls.map(([id]) => id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("blocks contradictory reverse ownership", () => {
    expect(
      planMigration({
        ...discovered(),
        reverse: {
          status: "OK",
          superTokensUserId: "internal",
          externalUserId: "other",
        },
      }),
    ).toMatchObject({ status: "BLOCKED" });
  });

  it("requires reconciliation when the authenticated mapping is absent", () => {
    expect(
      planMigration({
        ...discovered(),
        mapping: { status: "UNKNOWN_MAPPING_ERROR" },
      }),
    ).toMatchObject({ status: "PLAN", action: { kind: "reconcile" } });
  });

  it("requires reconciliation for a new tenant", () => {
    expect(planMigration({ ...discovered(), tenantId: "other" })).toMatchObject(
      { status: "PLAN" },
    );
  });

  it("routes secondary consolidated aliases through their migration-specific binding checks", () => {
    const input = discovered();
    input.user!.id = "canonical-rownd-owner";
    expect(planMigration(input)).toMatchObject({ status: "PLAN" });
  });

  it("blocks a mapping whose owner disappeared", () => {
    expect(planMigration({ ...discovered(), user: undefined })).toMatchObject({
      status: "BLOCKED",
    });
  });

  it("resumes revocation debt even when account metadata has no pending entries", () => {
    expect(
      planMigration({ ...discovered(), pendingProviderOperations: true }),
    ).toMatchObject({ status: "PLAN" });
  });

  it("keeps completed public login on the fast path with valid retirement history for another tenant", () => {
    const input = discovered();
    input.metadata.push({
      rownd_migration_provider_retirements: [
        {
          rowndUserId: "rownd",
          recipeUserId: "old-google",
          provider: "google",
          subject: "old-subject",
          pendingTenantIds: ["other"],
        },
      ],
    });
    expect(
      planMigration({ ...input, pendingProviderOperations: false }),
    ).toMatchObject({ status: "NOOP" });
  });

  it("blocks malformed retirement history independently of tenant pending-work inspection", () => {
    const input = discovered();
    input.metadata.push({
      rownd_migration_provider_retirements: [{ pendingTenantIds: ["other"] }],
    });
    expect(planMigration(input)).toMatchObject({ status: "BLOCKED" });
  });

  it("does not let alias completion override an incomplete internal owner", () => {
    expect(
      planMigration({
        ...discovered(),
        metadata: [
          { rownd_migration_complete: false },
          { rownd_migration_complete: true },
        ],
        metadataById: new Map([
          ["internal", { rownd_migration_complete: false }],
          ["rownd", { rownd_migration_complete: true }],
        ]),
      }),
    ).toMatchObject({ status: "PLAN" });
  });

  it.each([
    { rownd_migration_owner_consolidation: { status: "RECONCILING" } },
    { rownd_migration_mapping_publication: {} },
    { rownd_migration_provider_introductions: [{}] },
    { rownd_migration_email_retirements: { public: {} } },
    {
      rownd_pending_verification: [
        { tenantId: "public", status: "COMMITTING" },
      ],
    },
  ])("resumes substantive checkpoints: %j", (checkpoint) => {
    const input = discovered();
    input.metadata.push(checkpoint);
    expect(planMigration(input)).toMatchObject({ status: "PLAN" });
  });

  it("ignores obsolete reservations and completed snapshots", () => {
    const input = discovered();
    input.metadata.push({
      rownd_migration_admin_donor_sessions: "malformed legacy data",
      rownd_migration_owner_consolidation: {
        status: "COMPLETE",
        completion: { identity: "old" },
      },
      rownd_pending_verification: [{ tenantId: "public", status: "PENDING" }],
    });
    expect(planMigration(input)).toMatchObject({ status: "NOOP" });
  });
});

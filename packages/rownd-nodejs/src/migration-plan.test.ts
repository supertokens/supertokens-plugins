import { afterEach, describe, expect, it, vi } from "vitest";
import SuperTokens from "supertokens-node";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import { User } from "supertokens-node/lib/build/user";
import {
  discoverMigrationById,
  planMigration,
  type MigrationIdDiscovery,
} from "./migration-plan";

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
  it("accepts a completed mapped user without rediscovering native identities", async () => {
    const input = discovered();
    vi.spyOn(SuperTokens, "getUserIdMapping").mockResolvedValue(input.mapping);
    vi.spyOn(SuperTokens, "getUser").mockResolvedValue(input.user);
    vi.spyOn(UserMetadata, "getUserMetadata").mockImplementation(
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

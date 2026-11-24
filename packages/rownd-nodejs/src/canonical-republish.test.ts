import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SuperTokens from "supertokens-node";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import { resolveCanonicalEmailForTenant } from "./canonical-email";
import { projectPresentation, republishAfterMigration, republishCanonicalPresentation } from "./canonical-republish";
import { getPluginConfig, setPluginConfig } from "./config";
import { orphanCheckpointKey } from "./migration-orphan-checkpoint";
import { OWNER_PLAN_KEY } from "./migration-owner-plan";
import { init } from "./plugin";
import {
  buildConfiguredSessionClaims,
  buildRowndOAuthPayload,
  buildRowndSessionClaimPayload,
  inspectUserPresentationMetadata,
  ROWND_APP_VARIANTS_KEY,
  ROWND_PROFILE_AUTHORITY_PREFIX,
  type RowndMetadata,
  type SuperTokensUser,
} from "./rownd-compatibility";
import { assembleUserProfile } from "./supertokens-repository";
import { MigrationTelemetry } from "./telemetry/migrationTelemetry";
import type { RowndMetadataMode, RowndPluginConfig } from "./types";
import type { JsonRecord } from "./utils";

const internalId = "internal-owner";
const externalId = "rownd-owner";
const tenants = ["public", "other"];
const schema: NonNullable<RowndPluginConfig["schema"]> = {
  first_name: { display_name: "First", type: "string", user_visible: true, include_in_session_claims: true },
  last_name: { display_name: "Last", type: "string", user_visible: true, include_in_session_claims: true },
  custom: { display_name: "Custom", type: "object", user_visible: true, include_in_session_claims: true, session_claim_name: "custom_claim" },
  deleted: { display_name: "Deleted", type: "string", user_visible: true, include_in_session_claims: true },
};
const initialConfig = getPluginConfig();

type Store = Map<string, RowndMetadata>;

function configure(metadataMode: RowndMetadataMode) {
  init({ metadataMode, disableRowndUserMigration: metadataMode === "canonical", rowndAppId: "app", schema, subBrands: { blue: {}, green: {} } });
}

function method(id: string, email: string, tenantIds: string[], timeJoined: number) {
  return {
    recipeUserId: SuperTokens.convertToRecipeUserId(id), recipeId: "passwordless", email, verified: true, tenantIds, timeJoined,
    hasSameEmailAs: (candidate: string | undefined) => candidate?.toLowerCase() === email,
    hasSamePhoneNumberAs: () => false,
    hasSameThirdPartyInfoAs: () => false,
  };
}

function original(userId: string, firstName = "Original first") {
  return {
    data: { user_id: userId, first_name: firstName, last_name: "Original last", deleted: "Original deleted", custom: { original: true } },
    state: "enabled", auth_level: "verified", verified_data: { custom: true }, groups: [{ id: "group" }],
    attributes: { "rownd:app_variants": ["blue"], "rownd:app_variants_by_tenant": { other: ["green"] } },
    meta: { operational: true },
  };
}

// Owner layouts each migration path leaves behind, before the dual-write republish.
const layouts: Record<string, { mapped: boolean; linked: boolean; status: string; records: () => Record<string, RowndMetadata> }> = {
  "bulk import of a new user": { mapped: true, linked: false, status: "UNCHANGED", records: () => ({
    [externalId]: { original_rownd_user: original(externalId), first_name: "Imported", rownd_migration_complete: true },
  }) },
  "reconciliation onto an existing user": { mapped: true, linked: false, status: "PUBLISHED", records: () => ({
    [internalId]: { original_rownd_user: original(externalId), first_name: "Live first", custom: { live: true },
      rownd_migration_complete: true, rownd_email_metadata_version: 1, rownd_email_recipe_user_ids: { public: internalId } },
    [externalId]: { rownd_migration_canonical_target: internalId },
  }) },
  "repair that linked methods and deleted a stale field": { mapped: true, linked: true, status: "PUBLISHED", records: () => ({
    [internalId]: { original_rownd_user: original(externalId), first_name: "Live first",
      rownd_profile_authoritative_fields: ["deleted"], rownd_migration_complete: true },
    [externalId]: { rownd_migration_canonical_target: internalId, deleted: "Stale alias", alias_only: "alias", custom: { alias: true } },
    "linked-recipe": { linked_only: "linked", custom: { linked: true } },
  }) },
  "unmapped owner with linked method metadata": { mapped: false, linked: true, status: "PUBLISHED", records: () => ({
    [internalId]: { original_rownd_user: original(internalId), first_name: "Live first", rownd_migration_complete: true },
    "linked-recipe": { linked_only: "linked", custom: { linked: true } },
  }) },
};

describe("dual-write canonical republish", () => {
  let store: Store;
  let user: SuperTokensUser;
  let mapped: boolean;
  let puts: Array<{ id: string; patch: JsonRecord }>;
  let failPut: Error | undefined;

  function install(layout: (typeof layouts)[string], mutate?: (records: Record<string, RowndMetadata>) => void) {
    mapped = layout.mapped;
    const records = layout.records();
    mutate?.(records);
    store = new Map(Object.entries(records));
    user = {
      id: mapped ? externalId : internalId, isPrimaryUser: true, timeJoined: 1000, tenantIds: tenants,
      emails: ["owner@example.com", "linked@example.com"], phoneNumbers: [], thirdParty: [],
      loginMethods: [
        method(internalId, "owner@example.com", ["public"], 1000),
        ...(layout.linked ? [method("linked-recipe", "linked@example.com", ["other"], 2000)] : []),
      ],
    } as unknown as SuperTokensUser;
  }

  beforeEach(() => {
    puts = [];
    failPut = undefined;
    vi.spyOn(SuperTokens, "getUser").mockImplementation(async (id) =>
      [user.id, ...user.loginMethods.map((entry) => entry.recipeUserId.getAsString())].includes(id) ? user : undefined);
    vi.spyOn(SuperTokens, "getUserIdMapping").mockImplementation(async ({ userId, userIdType }) =>
      mapped && ((userIdType === "SUPERTOKENS" && userId === internalId) || (userIdType === "EXTERNAL" && userId === externalId))
        ? { status: "OK", superTokensUserId: internalId, externalUserId: externalId, externalUserIdInfo: undefined }
        : { status: "UNKNOWN_MAPPING_ERROR" });
    vi.spyOn(UserMetadata, "getUserMetadata").mockImplementation(async (id) => ({
      status: "OK", metadata: structuredClone(store.get(id) ?? {}),
    }));
    vi.spyOn(UserMetadata, "updateUserMetadata").mockImplementation(async (id, patch) => {
      if (failPut) throw failPut;
      puts.push({ id, patch: structuredClone(patch) as JsonRecord });
      const next = { ...store.get(id) };
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete next[key];
        else next[key] = structuredClone(value);
      }
      store.set(id, next);
      return { status: "OK", metadata: structuredClone(next) };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setPluginConfig(initialConfig!);
  });

  async function projections(mode: "compatibility" | "canonical") {
    configure(mode);
    const config = getPluginConfig()!;
    const { user: inspected, combinedMetadata: metadata } = await inspectUserPresentationMetadata(user.id);
    if (!inspected) throw new Error("fixture user missing");
    return {
      profiles: tenants.map((tenantId) => assembleUserProfile(user.id, tenantId, inspected, metadata, config, "profile")),
      configuredClaims: buildConfiguredSessionClaims(metadata, config),
      sessionClaims: ["blue", "green"].map((appVariantId) => buildRowndSessionClaimPayload({
        userId: user.id, user: inspected, metadata, pluginConfig: config, appVariantId, authenticationOrigin: "authenticated",
      })),
      oauth: await buildRowndOAuthPayload({ user: inspected, scopes: ["openid", "email", "phone", "profile"] }),
      emails: tenants.map((tenantId) => resolveCanonicalEmailForTenant({ user: inspected, metadata, tenantId })),
    };
  }

  it.each(Object.keys(layouts))("publishes canonical parity after %s", async (name) => {
    const layout = layouts[name]!;
    install(layout);
    const compatibility = await projections("compatibility");
    if (layout.status === "PUBLISHED") expect(await projections("canonical")).not.toEqual(compatibility);
    configure("dual-write");
    const result = await republishCanonicalPresentation({ userId: user.id, userContext: {} });
    expect(result.status).toBe(layout.status);
    expect(puts).toHaveLength(layout.status === "PUBLISHED" ? 1 : 0);
    expect(await projections("compatibility")).toEqual(compatibility);
    expect(await projections("canonical")).toEqual(compatibility);
    for (const { id, patch } of puts) {
      expect(id).toBe(user.id);
      expect(Object.keys(patch).filter((key) => key.startsWith("rownd_migration_") || key.startsWith("rownd_pending_") ||
        key.startsWith(ROWND_PROFILE_AUTHORITY_PREFIX) || key === ROWND_APP_VARIANTS_KEY)).toEqual([]);
    }
    const stored = store.get(user.id)!;
    if (mapped && name !== "bulk import of a new user") expect(stored.rownd_migration_canonical_target).toBe(internalId);
    // Republish is idempotent: a converged owner costs no write.
    configure("dual-write");
    puts = [];
    expect(await republishCanonicalPresentation({ userId: user.id, userContext: {} })).toEqual({ status: "UNCHANGED" });
    expect(puts).toEqual([]);
  });

  it("deletes stale alias presentation keys with null and keeps operational members", async () => {
    install(layouts["repair that linked methods and deleted a stale field"]!);
    configure("dual-write");
    expect(await republishCanonicalPresentation({ userId: externalId, userContext: {} })).toMatchObject({ status: "PUBLISHED" });
    expect(puts).toHaveLength(1);
    expect(puts[0]!.patch).toMatchObject({ deleted: null, first_name: "Live first", rownd_profile_authoritative_fields: ["deleted"] });
    expect(store.get(externalId)).not.toHaveProperty("deleted");
    expect(store.get(externalId)?.original_rownd_user).not.toHaveProperty("meta");
  });

  const refusals: Array<[string, string, (records: Record<string, RowndMetadata>) => void]> = [
    ["consolidation with retired aliases", "retirement-dependent", (r) => { r[internalId]![OWNER_PLAN_KEY] = { retiredAliases: [] }; }],
    ["a superseded alias marker", "retirement-dependent", (r) => {
      r[externalId]!.rownd_migration_superseded = { rowndUserId: externalId, targetUserId: internalId };
    }],
    ["an orphan-mapping checkpoint", "retirement-dependent", (r) => { r[externalId]![orphanCheckpointKey] = "{}"; }],
    ["an unfinished owner plan", "unsupported-checkpoint", (r) => { r[internalId]![OWNER_PLAN_KEY] = { status: "PENDING" }; }],
    ["an unfinished owner recovery", "unsupported-checkpoint", (r) => { r[internalId]!.rownd_migration_owner_recovery = { status: "PENDING" }; }],
    ["an email retirement ledger", "unsupported-checkpoint", (r) => { r[internalId]!.rownd_migration_email_retirements = {}; }],
    ["pending verification", "pending-verification", (r) => {
      r[internalId]!.rownd_pending_verification = [{ id: "p", field: "email", value: "new@example.com", created_at: "2026-01-01" }];
    }],
    ["a conflicting migration target", "conflicting-target", (r) => { r[externalId]!.rownd_migration_canonical_target = "another-owner"; }],
    ["an app variant overlay", "reserved-metadata-collision", (r) => { r[externalId]![ROWND_APP_VARIANTS_KEY] = { public: ["blue"] }; }],
    ["an authority marker", "reserved-metadata-collision", (r) => { r[externalId]![`${ROWND_PROFILE_AUTHORITY_PREFIX}first_name`] = true; }],
    ["an unsafe integer", "unsupported-json", (r) => { r[internalId]!.counter = 2 ** 53; }],
    ["a stored top-level null", "unrepresentable-top-level-null", (r) => { r[internalId]!.nullable = null; }],
    ["an incomplete migration", "migration-incomplete", (r) => { r[internalId]!.rownd_migration_complete = false as never; }],
    ["identity authority", "invalid-authority", (r) => { r[internalId]!.rownd_profile_authoritative_fields = ["email"]; }],
    ["an invalid email selector", "invalid-email-pointers", (r) => { r[internalId]!.rownd_email_recipe_user_ids = { public: "missing" }; }],
    ["an unproven alias original with operational members", "existing-original-operational-conflict", (r) => {
      r[externalId]!.original_rownd_user = { ...original("superseded-rownd"), data: { user_id: "superseded-rownd" } } as never;
    }],
  ];

  it.each(refusals)("skips owners with %s", async (_name, reason, mutate) => {
    install(layouts["reconciliation onto an existing user"]!, mutate);
    configure("dual-write");
    const before = structuredClone([...store]);
    expect(await republishCanonicalPresentation({ userId: externalId, userContext: {} })).toEqual({ status: "SKIPPED", reason });
    expect(puts).toEqual([]);
    expect([...store]).toEqual(before);
  });

  it("skips an ambiguous selected original across linked records", async () => {
    install(layouts["repair that linked methods and deleted a stale field"]!, (r) => {
      r["linked-recipe"]!.original_rownd_user = original(externalId, "Different snapshot") as never;
    });
    configure("dual-write");
    expect(await republishCanonicalPresentation({ userId: externalId, userContext: {} }))
      .toEqual({ status: "SKIPPED", reason: "ambiguous-original" });
  });

  it("skips a missing owner without writing", async () => {
    install(layouts["reconciliation onto an existing user"]!);
    configure("dual-write");
    expect(await republishCanonicalPresentation({ userId: "unknown", userContext: {} }))
      .toEqual({ status: "SKIPPED", reason: "owner-not-found" });
    expect(puts).toEqual([]);
  });

  it("projects a mode explicitly without touching the global plugin config", () => {
    install(layouts["bulk import of a new user"]!);
    configure("dual-write");
    const global = getPluginConfig();
    const metadata: RowndMetadata = { original_rownd_user: original(externalId) as never,
      [`${ROWND_PROFILE_AUTHORITY_PREFIX}first_name`]: true };
    const canonical = projectPresentation(user, metadata, global!, "canonical");
    const compatibility = projectPresentation(user, metadata, global!, "compatibility");
    expect(getPluginConfig()).toBe(global);
    // Only canonical mode treats the marker as authority, deleting the snapshot value.
    expect(canonical.profiles.public!.data).not.toHaveProperty("first_name");
    expect(canonical.configuredClaims).not.toHaveProperty("first_name");
    expect(compatibility.profiles.public!.data.first_name).toBe("Original first");
    expect(compatibility.configuredClaims.first_name).toBe("Original first");
  });

  describe("migration failure semantics", () => {
    it("never runs or reads in compatibility mode", async () => {
      install(layouts["reconciliation onto an existing user"]!);
      configure("compatibility");
      vi.clearAllMocks();
      const telemetry = new MigrationTelemetry(() => {});
      telemetry.stage = "session_creation";
      expect(await republishAfterMigration({ userId: externalId, userContext: {}, telemetry })).toBeUndefined();
      expect(telemetry.stage).toBe("session_creation");
      expect(SuperTokens.getUser).not.toHaveBeenCalled();
      expect(UserMetadata.getUserMetadata).not.toHaveBeenCalled();
    });

    it("logs a refusal without identifiers and does not throw", async () => {
      install(layouts["reconciliation onto an existing user"]!, (r) => { r[internalId]![OWNER_PLAN_KEY] = { retiredAliases: [] }; });
      configure("dual-write");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const events: unknown[] = [];
      const telemetry = new MigrationTelemetry((event) => { events.push(event); });
      expect(await republishAfterMigration({ userId: externalId, userContext: {}, telemetry }))
        .toEqual({ status: "SKIPPED", reason: "retirement-dependent" });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain("retirement-dependent");
      expect(warn.mock.calls[0]![0]).not.toMatch(/owner@|internal-owner|rownd-owner/);
      expect(events).toEqual([expect.objectContaining({ reason: "canonical_republish_skipped:retirement-dependent", result: "skipped" })]);
    });

    it.each(["write", "read"])("lets the migration result stand when the republish %s fails", async (failure) => {
      install(layouts["reconciliation onto an existing user"]!);
      configure("dual-write");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      if (failure === "write") failPut = new Error(`Core rejected ${internalId}`);
      else vi.mocked(UserMetadata.getUserMetadata).mockRejectedValue(new Error(`Core unavailable for ${externalId}`));
      const events: unknown[] = [];
      const telemetry = new MigrationTelemetry((event) => { events.push(event); });
      expect(await republishAfterMigration({ userId: externalId, userContext: {}, telemetry })).toEqual({ status: "FAILED" });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).not.toMatch(/internal-owner|rownd-owner/);
      expect(events).toEqual([expect.objectContaining({ reason: "canonical_republish_failed", result: "error" })]);
      expect(JSON.stringify(events)).not.toMatch(/internal-owner|rownd-owner/);
      // The next migration request converges the owner.
      failPut = undefined;
      vi.mocked(UserMetadata.getUserMetadata).mockImplementation(async (id) => ({ status: "OK", metadata: structuredClone(store.get(id) ?? {}) }));
      expect(await republishAfterMigration({ userId: externalId, userContext: {} })).toMatchObject({ status: "PUBLISHED" });
    });
  });
});

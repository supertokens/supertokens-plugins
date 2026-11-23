import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SuperTokens from "supertokens-node";
import EmailVerification from "supertokens-node/recipe/emailverification";
import Multitenancy from "supertokens-node/recipe/multitenancy";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import { resolveCanonicalEmailForTenant } from "./canonical-email";
import { getPluginConfig, setPluginConfig } from "./config";
import { init } from "./plugin";
import { handleUpdateUser, handleUpdateUserField, handleUpdateUserMeta } from "./pluginImplementation";
import {
  buildConfiguredSessionClaims,
  buildRowndOAuthPayload,
  buildRowndSessionClaimPayload,
  canUpdateUserDataField,
  getCanonicalPresentationMetadata,
  getPrimaryUserMetadata,
  inspectLinkedUserMetadata,
  inspectUserPresentationMetadata,
  isCanonicalReservedMetadataKey,
  updatePrimaryUserMetadata,
  updateUserPresentationMetadata,
  type RowndMetadata,
  type SuperTokensUser,
} from "./rownd-compatibility";
import {
  assembleUserProfile,
  recordRowndAppVariantForUser,
  startPendingEmailVerification,
  updateUserMetadata,
} from "./supertokens-repository";
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
  phone_number: { display_name: "Phone", type: "string", user_visible: true },
};
const initialConfig = getPluginConfig();

type Store = Map<string, RowndMetadata>;
type Fixture = { mapped: boolean; source: "internal" | "alias" | "recipe" | "wrong-source"; linked: boolean };
type Writer = { name: string; run: (sdkId: string, context: JsonRecord) => Promise<unknown>; linkedOnly?: boolean };

function configure(metadataMode: RowndMetadataMode) {
  init({ disableRowndUserMigration: true, metadataMode, schema, subBrands: { blue: {}, green: {} } });
}

function method(id: string, email: string, tenantIds: string[], timeJoined: number, recipeId = "passwordless") {
  return {
    recipeUserId: SuperTokens.convertToRecipeUserId(id), recipeId, email, verified: true, tenantIds, timeJoined,
    hasSameEmailAs: (candidate: string | undefined) => candidate?.toLowerCase() === email,
    hasSamePhoneNumberAs: () => false,
    hasSameThirdPartyInfoAs: () => false,
  };
}

function makeUser({ mapped, linked }: Fixture): SuperTokensUser {
  return {
    id: mapped ? externalId : internalId, isPrimaryUser: true, timeJoined: 1000, tenantIds: tenants,
    emails: ["owner@example.com", "linked@example.com", "other@example.com"], phoneNumbers: [], thirdParty: [],
    loginMethods: [
      method(internalId, "owner@example.com", ["public"], 1000),
      ...(linked ? [method("linked-recipe", "linked@example.com", ["public"], 2000),
        method("other-recipe", "other@example.com", ["other"], 3000)] : []),
    ],
  } as unknown as SuperTokensUser;
}

function originalFor(userId: string, firstName = "Original first") {
  return {
    data: { user_id: userId, first_name: firstName, last_name: "Original last", deleted: "Original deleted",
      custom: { original: true } },
    state: "enabled", auth_level: "verified", verified_data: { custom: true }, groups: [{ id: "group" }],
    attributes: { "rownd:app_variants": ["blue"], "rownd:app_variants_by_tenant": { other: ["green"] } },
    meta: { not_presented: true },
  };
}

// Compatibility state before any copy, covering each place that can source the Rownd user.
function seed(fixture: Fixture): Store {
  const sdkId = fixture.mapped ? externalId : internalId;
  const primary: RowndMetadata = {
    first_name: "Live first", custom: { live: true }, overlay: "primary", deleted: "Live deleted",
    rownd_profile_authoritative_fields: ["deleted"], rownd_migration_complete: true,
  };
  delete primary.deleted;
  if (fixture.linked) primary.rownd_email_recipe_user_ids = { public: internalId, other: "other-recipe" };
  const alias: RowndMetadata = { alias_only: "alias", first_name: "Alias first", custom: { alias: true } };
  const recipe: RowndMetadata = { linked_only: "linked", custom: { linked: true } };
  if (fixture.source === "internal") primary.original_rownd_user = originalFor(sdkId);
  if (fixture.source === "wrong-source") {
    primary.original_rownd_user = originalFor("superseded-rownd-user", "Wrong source");
    alias.original_rownd_user = originalFor(sdkId);
  }
  if (fixture.source === "alias") alias.original_rownd_user = originalFor(sdkId);
  if (fixture.source === "recipe") recipe.original_rownd_user = originalFor(sdkId);
  return new Map<string, RowndMetadata>([
    [internalId, primary],
    ...(fixture.mapped ? [[externalId, alias] as const] : []),
    ...(fixture.linked ? [["linked-recipe", recipe] as const] : []),
  ]);
}

const fixtures: Fixture[] = [false, true].flatMap((mapped) => [false, true].flatMap((linked) =>
  (mapped ? ["internal", "alias", "wrong-source", ...(linked ? ["recipe"] : [])] as const
    : ["internal", ...(linked ? ["recipe"] : [])] as const)
    .map((source) => ({ mapped, linked, source }))));

describe("dual-write metadata transition mode", () => {
  let store: Store;
  let user: SuperTokensUser;
  let fixture: Fixture;
  let beforePut: ((id: string, patch: JsonRecord) => Promise<void>) | undefined;
  let puts: Array<{ id: string; patch: JsonRecord }>;

  function install(nextFixture: Fixture, nextStore = seed(nextFixture)) {
    fixture = nextFixture;
    store = nextStore;
    user = makeUser(nextFixture);
  }

  beforeEach(() => {
    beforePut = undefined;
    puts = [];
    vi.spyOn(SuperTokens, "getUser").mockImplementation(async (id) =>
      [user.id, ...user.loginMethods.map((entry) => entry.recipeUserId.getAsString())].includes(id) ? user : undefined);
    vi.spyOn(SuperTokens, "getUserIdMapping").mockImplementation(async ({ userId, userIdType }) =>
      fixture.mapped && ((userIdType === "SUPERTOKENS" && userId === internalId) ||
        (userIdType === "EXTERNAL" && userId === externalId))
        ? { status: "OK", superTokensUserId: internalId, externalUserId: externalId, externalUserIdInfo: undefined }
        : { status: "UNKNOWN_MAPPING_ERROR" });
    vi.spyOn(UserMetadata, "getUserMetadata").mockImplementation(async (id) => ({
      status: "OK", metadata: structuredClone(store.get(id) ?? {}),
    }));
    vi.spyOn(UserMetadata, "updateUserMetadata").mockImplementation(async (id, patch) => {
      await beforePut?.(id, patch as JsonRecord);
      puts.push({ id, patch: structuredClone(patch) as JsonRecord });
      // Core merges top-level keys and deletes nulls; nested values are stored verbatim.
      const next = { ...store.get(id) };
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete next[key];
        else next[key] = structuredClone(value);
      }
      store.set(id, next);
      return { status: "OK", metadata: structuredClone(next) };
    });
    vi.spyOn(Multitenancy, "listAllTenants").mockResolvedValue({ status: "OK", tenants: [] } as never);
    vi.spyOn(SuperTokens, "listUsersByAccountInfo").mockResolvedValue([]);
    vi.spyOn(EmailVerification, "revokeEmailVerificationTokens").mockResolvedValue({ status: "OK" });
    vi.spyOn(EmailVerification, "unverifyEmail").mockResolvedValue({ status: "OK" });
    vi.spyOn(EmailVerification, "sendEmailVerificationEmail").mockResolvedValue({ status: "OK" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setPluginConfig(initialConfig!);
  });

  // Mirrors the offline copy: the SDK record's presentation keys become exactly the
  // canonical presentation, while its operational keys are left to compatibility.
  async function publish() {
    configure("compatibility");
    const sdkId = user.id;
    const presentation = getCanonicalPresentationMetadata((await inspectLinkedUserMetadata(sdkId)).combinedMetadata);
    const current = store.get(sdkId) ?? {};
    store.set(sdkId, { ...Object.fromEntries(Object.entries(current)
      .filter(([key]) => !Object.prototype.hasOwnProperty.call(getCanonicalPresentationMetadata({ [key]: current[key] }), key))),
    ...presentation });
  }

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

  async function expectEqualPresentation() {
    expect(await projections("canonical")).toEqual(await projections("compatibility"));
  }

  const writers: Writer[] = [
    { name: "profile edit", run: (id) => updateUserPresentationMetadata(id, { first_name: "Edited" }) },
    { name: "profile deletion", run: (id) => updateUserPresentationMetadata(id, { first_name: null }) },
    { name: "deleted field restoration", run: (id) => updateUserPresentationMetadata(id, { deleted: "Restored" }) },
    { name: "object replacement with nested null",
      run: (id) => updateUserPresentationMetadata(id, { custom: { replacement: { nested_null: null } } }) },
    { name: "empty object replacement", run: (id) => updateUserPresentationMetadata(id, { custom: {} }) },
    { name: "new field", run: (id) => updateUserPresentationMetadata(id, { brand_new: ["x", { y: null }] }) },
    { name: "multi-field edit", run: (id) => updateUserPresentationMetadata(id, { first_name: "A", last_name: null }) },
    { name: "identity field", run: (id) => updateUserPresentationMetadata(id, { phone_number: "+15550000000" }) },
    { name: "identity field deletion", run: (id) => updateUserPresentationMetadata(id, { phone_number: null }) },
    { name: "meta PUT", run: (id) => updateUserMetadata(id, { overlay: { meta: true }, last_active: null }) },
    { name: "meta PUT deletion", run: (id) => updateUserMetadata(id, { overlay: null }) },
    { name: "public app variant", run: (id, context) => recordRowndAppVariantForUser(id, "green", context, "public") },
    { name: "existing app variant", run: (id, context) => recordRowndAppVariantForUser(id, "blue", context, "public") },
    { name: "tenant app variant", run: (id, context) => recordRowndAppVariantForUser(id, "blue", context, "other") },
    { name: "pending email start", run: (id, context) => startPendingEmailVerification({
      userId: id, recipeUserId: SuperTokens.convertToRecipeUserId(internalId), email: "pending@example.com",
      tenantId: "public", pendingVerificationId: "pending-id", initiatingSessionHandle: "handle", userContext: context,
    }) },
    { name: "current verified email publication", run: (id, context) => startPendingEmailVerification({
      userId: id, recipeUserId: SuperTokens.convertToRecipeUserId(internalId), email: "owner@example.com",
      tenantId: "public", pendingVerificationId: "pending-id", initiatingSessionHandle: "handle", userContext: context,
    }) },
    { name: "pending cleanup", run: async (id) => updatePrimaryUserMetadata(id, {
      rownd_pending_verification: [] }) },
    { name: "linked selector publication", linkedOnly: true, run: async (id) => {
      // Shape of the verified-email publication after a replacement selects a linked method.
      const metadata = await getPrimaryUserMetadata(id);
      return updatePrimaryUserMetadata(id, { ...metadata,
        original_rownd_user: metadata.original_rownd_user && { ...metadata.original_rownd_user,
          data: { ...metadata.original_rownd_user.data, email: "linked@example.com" },
          verified_data: { ...metadata.original_rownd_user.verified_data, email: "linked@example.com" } },
        rownd_email_recipe_user_id: "linked-recipe",
        rownd_email_recipe_user_ids: { ...metadata.rownd_email_recipe_user_ids, public: "linked-recipe" },
        rownd_pending_verification: [] });
    } },
  ];

  const cases = fixtures.flatMap((entry) => writers.filter((writer) => !writer.linkedOnly || entry.linked)
    .map((writer) => ({ ...entry, writer: writer.name })));

  it.each(cases)("keeps published owners equal: $writer (mapped=$mapped, linked=$linked, source=$source)", async (entry) => {
    const writer = writers.find(({ name }) => name === entry.writer)!;
    // Oracle: the same writer in compatibility mode on an identical published state.
    install(entry);
    await publish();
    const published = structuredClone(store);
    await expectEqualPresentation();
    configure("compatibility");
    await writer.run(user.id, {});
    const compatibilityOracle = await projections("compatibility");

    install(entry, structuredClone(published));
    puts = [];
    configure("dual-write");
    await writer.run(user.id, {});
    const compatibility = await projections("compatibility");
    // Mirrors never change what compatibility presents.
    expect(compatibility).toEqual(compatibilityOracle);
    expect(await projections("canonical")).toEqual(compatibility);
    for (const { patch } of puts) {
      expect(Object.keys(patch).some(isCanonicalReservedMetadataKey)).toBe(false);
    }
    if (entry.mapped) {
      // The SDK record only ever receives presentation keys (pending state stays internal).
      for (const { patch } of puts.filter(({ id }) => id === externalId)) {
        expect(Object.keys(getCanonicalPresentationMetadata(patch as RowndMetadata)).sort()).toEqual(Object.keys(patch).sort());
      }
    }
  });

  it.each(fixtures.filter(({ mapped }) => mapped))(
    "mirrors only the presentation of a mapped profile write (linked=$linked, source=$source)", async (entry) => {
      install(entry);
      await publish();
      configure("dual-write");
      puts = [];
      await updateUserPresentationMetadata(externalId, { first_name: null, custom: { next: true } });
      expect(puts).toEqual([
        { id: internalId, patch: { first_name: null, custom: { next: true },
          rownd_profile_authoritative_fields: ["deleted", "first_name", "custom"] } },
        { id: externalId, patch: { first_name: null, custom: { next: true },
          rownd_profile_authoritative_fields: ["deleted", "first_name", "custom"] } },
      ]);
    },
  );

  it("never mirrors canonical-only keys written through the repository API", async () => {
    install({ mapped: true, linked: false, source: "internal" });
    configure("dual-write");
    await updateUserPresentationMetadata(externalId, { rownd_app_variants: { public: ["x"] }, first_name: "Edited" });
    expect(puts[puts.length - 1]).toEqual({ id: externalId, patch: { first_name: "Edited",
      rownd_profile_authoritative_fields: ["deleted", "rownd_app_variants", "first_name"] } });
  });

  it("does not mirror unmapped writes or compatibility-mode writes", async () => {
    install({ mapped: false, linked: false, source: "internal" });
    configure("dual-write");
    await updateUserPresentationMetadata(internalId, { first_name: "Edited" });
    expect(puts.map(({ id }) => id)).toEqual([internalId]);
    install({ mapped: true, linked: false, source: "internal" });
    puts = [];
    configure("compatibility");
    await updateUserPresentationMetadata(externalId, { first_name: "Edited" });
    await recordRowndAppVariantForUser(externalId, "green", {}, "public");
    await updatePrimaryUserMetadata(externalId, { rownd_pending_verification: [] });
    expect(puts.map(({ id }) => id)).toEqual([internalId, internalId, internalId]);
  });

  it("mirrors variants written to an unmapped owner's linked recipe with no extra read", async () => {
    const entry: Fixture = { mapped: false, linked: true, source: "recipe" };
    install(entry);
    configure("compatibility");
    await recordRowndAppVariantForUser(internalId, "green", {}, "public");
    const reads = vi.mocked(UserMetadata.getUserMetadata).mock.calls.map(([id]) => id);
    const compatibility = await projections("compatibility");

    install(entry);
    puts = [];
    vi.mocked(UserMetadata.getUserMetadata).mockClear();
    configure("dual-write");
    await recordRowndAppVariantForUser(internalId, "green", {}, "public");
    expect(vi.mocked(UserMetadata.getUserMetadata).mock.calls.map(([id]) => id)).toEqual(reads);
    expect(puts.map(({ id }) => id)).toEqual(["linked-recipe", internalId]);
    expect(await projections("compatibility")).toEqual(compatibility);
    expect((await projections("canonical")).profiles[0]?.attributes?.["rownd:app_variants"]).toEqual(["blue", "green"]);
  });

  it("mirrors email selector state without operational pending state", async () => {
    install({ mapped: true, linked: true, source: "internal" });
    await publish();
    configure("dual-write");
    puts = [];
    await updatePrimaryUserMetadata(externalId, {
      rownd_email_recipe_user_ids: { public: "linked-recipe" },
      rownd_pending_verification: [{ id: "p", field: "email", value: "x@example.com", created_at: "2026-01-01T00:00:00.000Z" }],
    });
    // Keys already equal on the SDK record (here the absent scalar selector) are not rewritten.
    expect(puts[1]).toEqual({ id: externalId, patch: {
      rownd_email_metadata_version: 1, rownd_email_recipe_user_ids: { public: "linked-recipe" },
    } });
  });

  it("never copies a superseded primary original over the selected alias original", async () => {
    install({ mapped: true, linked: false, source: "wrong-source" });
    await publish();
    const aliasOriginal = store.get(externalId)?.original_rownd_user;
    configure("dual-write");
    await updatePrimaryUserMetadata(externalId, { ...store.get(internalId), rownd_pending_verification: [] });
    expect(store.get(externalId)?.original_rownd_user).toEqual(aliasOriginal);
    await expectEqualPresentation();
  });

  describe("concurrent different-field profile edits", () => {
    const reversedMirrors = ["A:internal", "B:internal", "B:sdk", "A:sdk"];
    const scenarios = [
      { order: ["A:internal", "A:sdk", "B:internal", "B:sdk"], repair: "none" },
      { order: ["A:internal", "B:internal", "A:sdk", "B:sdk"], repair: "none" },
      { order: reversedMirrors, repair: "new variant then pending cleanup" },
      { order: reversedMirrors, repair: "existing variant then pending cleanup" },
      { order: reversedMirrors, repair: "pending cleanup alone" },
    ];

    it.each(scenarios.flatMap((scenario) => [false, true].map((linked) => ({ ...scenario, linked }))))(
      "converges for $order with $repair (linked=$linked)", async ({ order, repair, linked }) => {
        install({ mapped: true, linked, source: "internal" });
        await publish();
        configure("dual-write");
        const waiting = new Map<string, () => void>();
        let next = 0;
        const step = () => {
          const release = waiting.get(order[next]!);
          if (!release) return;
          waiting.delete(order[next]!);
          next++;
          release();
        };
        beforePut = async (id, patch) => {
          const name = `${Object.prototype.hasOwnProperty.call(patch, "first_name") ? "A" : "B"}:${id === internalId ? "internal" : "sdk"}`;
          await new Promise<void>((resolve) => {
            waiting.set(name, resolve);
            step();
          });
          // Let the released write land before the next one is admitted.
          setImmediate(step);
        };
        await Promise.all([
          updateUserPresentationMetadata(externalId, { first_name: "A" }),
          updateUserPresentationMetadata(externalId, { last_name: "B" }),
        ]);
        beforePut = undefined;
        expect(next).toBe(4);
        expect(store.get(externalId)).toMatchObject({ first_name: "A", last_name: "B" });
        if (repair !== "none") {
          const expectedClaims = { first_name: "Original first", last_name: "B" };
          expect((await projections("compatibility")).configuredClaims).toMatchObject(expectedClaims);
          let afterVariant;
          if (repair.includes("variant")) {
            configure("dual-write");
            await recordRowndAppVariantForUser(externalId, repair.startsWith("new") ? "green" : "blue", {}, "public");
            afterVariant = (await projections("canonical")).configuredClaims;
          }
          configure("dual-write");
          await updatePrimaryUserMetadata(externalId, { rownd_pending_verification: [] });
          expect((await projections("canonical")).configuredClaims).toMatchObject(expectedClaims);
          if (afterVariant) expect(afterVariant).toMatchObject(expectedClaims);
        }
        await expectEqualPresentation();
      },
    );
  });

  it("repairs stale authority when the app variant is already on the SDK record", async () => {
    install({ mapped: true, linked: false, source: "alias" });
    await publish();
    store.set(externalId, { ...store.get(externalId), rownd_profile_authoritative_fields: ["first_name"] });
    configure("dual-write");
    await recordRowndAppVariantForUser(externalId, "blue", {}, "public");
    expect(puts).toEqual([{ id: externalId, patch: { rownd_profile_authoritative_fields: ["deleted"] } }]);
    await expectEqualPresentation();
  });

  it.each([false, true].flatMap((mapped) => (["meta", "profile", "field"] as const).map((route) => ({ mapped, route }))))(
    "rejects null identity keys in $route PUT without losing linked fallback (mapped=$mapped)", async ({ mapped, route }) => {
      install({ mapped, linked: true, source: "internal" });
      const field = route === "meta" ? "google_id" : "phone_number";
      const linkedValue = route === "meta" ? "g-linked" : "+15550000000";
      store.set("linked-recipe", { [field]: linkedValue });
      await publish();
      configure("dual-write");
      const deps: Parameters<typeof handleUpdateUser>[0] = {
        pluginConfig: getPluginConfig()!,
        stConfig: {} as Parameters<typeof handleUpdateUser>[0]["stConfig"],
        telemetryClient: { recordEvent: vi.fn(), recordSuccess: vi.fn(), recordError: vi.fn() },
      };
      const handler = route === "meta" ? handleUpdateUserMeta()
        : route === "profile" ? handleUpdateUser(deps) : handleUpdateUserField(deps);
      const patch = { [field]: null };
      const body = route === "meta" ? { meta: patch } : route === "profile" ? { data: patch } : { value: null };
      const result = await handler({
        getJSONBody: async () => body,
        getKeyValueFromQuery: (key: string) => key === "field" ? field : undefined,
      } as Parameters<typeof handler>[0], {} as Parameters<typeof handler>[1], {
        getUserId: () => user.id,
        getTenantId: () => "public",
      } as Parameters<typeof handler>[2], {});
      expect(result).toEqual({ status: "ERROR", code: 403, message: `field is not writable: ${field}` });
      expect(puts).toEqual([]);
      expect((await inspectUserPresentationMetadata(user.id)).combinedMetadata[field]).toBe(linkedValue);
      configure("canonical");
      expect((await inspectUserPresentationMetadata(user.id)).combinedMetadata[field]).toBe(linkedValue);
    },
  );

  describe("mirror failures", () => {
    function failSdkWrites() {
      beforePut = async (id) => {
        if (id === externalId) throw new Error("mirror unavailable");
      };
    }

    it.each([
      { name: "profile edit", run: () => updateUserPresentationMetadata(externalId, { first_name: "Edited" }) },
      { name: "app variant", run: () => recordRowndAppVariantForUser(externalId, "green", {}, "public") },
      { name: "email selector", run: () => updatePrimaryUserMetadata(externalId, { rownd_email_recipe_user_ids: { public: "linked-recipe" } }) },
    ])("fails the $name write, leaves compatibility reads unaffected and re-converges on replay", async ({ run }) => {
      install({ mapped: true, linked: true, source: "internal" });
      await publish();
      const published = structuredClone(store);
      configure("compatibility");
      await run();
      const compatibilityOracle = await projections("compatibility");

      install({ mapped: true, linked: true, source: "internal" }, published);
      configure("dual-write");
      const sdkBefore = structuredClone(store.get(externalId));
      failSdkWrites();
      await expect(run()).rejects.toThrow("mirror unavailable");
      beforePut = undefined;
      expect(store.get(externalId)).toEqual(sdkBefore);
      expect(await projections("compatibility")).toEqual(compatibilityOracle);

      configure("dual-write");
      await run();
      expect(await projections("compatibility")).toEqual(compatibilityOracle);
      await expectEqualPresentation();
    });

    it("leaves an unpublished owner no worse for a later copy", async () => {
      install({ mapped: true, linked: true, source: "internal" });
      configure("dual-write");
      await updateUserPresentationMetadata(externalId, { first_name: null, custom: { next: true } });
      await recordRowndAppVariantForUser(externalId, "green", {}, "public");
      const before = await projections("compatibility");
      // Every key a mirror wrote already holds its published value, so the copy only adds.
      const sdkBeforeCopy = structuredClone(store.get(externalId)!);
      await publish();
      for (const [key, value] of Object.entries(sdkBeforeCopy)) expect(store.get(externalId)?.[key]).toEqual(value);
      expect(await projections("compatibility")).toEqual(before);
      await expectEqualPresentation();
    });
  });

  it.each(["rownd_app_variants", "rownd_profile_authority:first_name", "original_rownd_user"])(
    "rejects profile-writable %s in dual-write mode like canonical mode", (field) => {
      const writableSchema = { ...schema, [field]: { display_name: "Reserved", type: "string" as const, user_visible: true } };
      init({ disableRowndUserMigration: true, metadataMode: "dual-write", schema: writableSchema });
      expect(canUpdateUserDataField(field)).toBe(false);
      init({ disableRowndUserMigration: true, schema: writableSchema });
      expect(canUpdateUserDataField(field)).toBe(true);
    },
  );
});

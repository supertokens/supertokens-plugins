import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SuperTokens from "supertokens-node";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import EmailVerification from "supertokens-node/recipe/emailverification";
import AccountLinking from "supertokens-node/recipe/accountlinking";
import Passwordless from "supertokens-node/recipe/passwordless";
import MultiTenancy from "supertokens-node/recipe/multitenancy";
import Session from "supertokens-node/recipe/session";
import type { UserContext } from "supertokens-node/types";
import { getPluginConfig, setPluginConfig } from "./config";
import { buildRowndOAuthUserInfo, getAuthoritativeProfileFields, ROWND_APP_VARIANTS_KEY, updatePrimaryUserMetadata } from "./rownd-compatibility";
import {
  buildRowndSessionClaims,
  buildRowndSessionAndAnonymousClaims,
  completePendingEmailVerification,
  getUserById,
  prepareEmailForPasswordlessAuth,
  recordRowndAppVariantForUser,
  startPendingEmailVerification,
  updateUserData,
  updateUserMetadata,
} from "./supertokens-repository";
import type { RowndMetadata, RowndPendingVerification } from "./rownd-compatibility";
import type { RowndPluginNormalisedConfig, RowndTelemetryEvent } from "./types";
import type { JsonRecord } from "./utils";

type User = NonNullable<Awaited<ReturnType<typeof SuperTokens.getUser>>>;
type LoginMethod = User["loginMethods"][number];

describe("canonical presentation runtime writes", () => {
  const ownerId = "internal-owner";
  const sdkId = "sdk-owner";
  const oldRecipeId = "old-email";
  const nextRecipeId = "next-email";
  const oldEmail = "old@example.com";
  const nextEmail = "next@example.com";
  const oldRecipe = SuperTokens.convertToRecipeUserId(oldRecipeId);
  const priorConfig = getPluginConfig();
  let records: Map<string, RowndMetadata>;
  let methods: LoginMethod[];
  let mapped: boolean;
  let missing: boolean;
  let nextCreated: boolean;
  let linked: boolean;
  let beforeWrite: ((id: string, patch: JsonRecord) => void | Promise<void>) | undefined;
  let afterWrite: ((id: string, patch: JsonRecord) => void) | undefined;
  let config: RowndPluginNormalisedConfig;

  const method = (id: string, email: string, tenantIds = ["public"]): LoginMethod => ({
    recipeUserId: SuperTokens.convertToRecipeUserId(id), recipeId: "passwordless", email,
    verified: true, timeJoined: 1000, tenantIds,
    hasSameEmailAs: (other: string) => email.toLowerCase() === other.toLowerCase(),
  }) as LoginMethod;
  const user = (): User => ({
    id: mapped ? sdkId : ownerId, isPrimaryUser: true, timeJoined: 1000,
    tenantIds: ["public", "other"], emails: methods.flatMap((entry) => entry.email ? [entry.email] : []),
    phoneNumbers: [], loginMethods: methods,
  }) as unknown as User;
  const original = (name: string) => ({
    data: { user_id: "original-rownd-id", first_name: name, email: oldEmail, custom: { retained: true } },
    verified_data: { email: oldEmail, phone_number: "+15555550100" }, state: "enabled", auth_level: "verified",
    groups: [{ id: "group" }], attributes: { preserved: name, "rownd:app_variants": ["existing"] },
  });
  const pending = (overrides: Partial<RowndPendingVerification> = {}): RowndPendingVerification => ({
    id: "pending", field: "email", value: nextEmail, tenantId: "public", created_at: "2026-11-17T00:00:00Z",
    status: "PENDING", purpose: "UPDATE_PASSWORDLESS", verificationRecipeUserId: oldRecipeId,
    initiatingSessionHandle: "session", ...overrides,
  });
  const begin = (email = nextEmail) => startPendingEmailVerification({
    userId: sdkId, recipeUserId: oldRecipe, email, tenantId: "public", pendingVerificationId: "new-pending",
    initiatingSessionHandle: "session", userContext: {},
  });
  const complete = () => completePendingEmailVerification({
    recipeUserId: oldRecipe, email: nextEmail, tenantId: "public", sessionHandle: "session",
    pendingVerificationId: "pending", pendingUserId: user().id, userContext: {},
  });
  const literal = (id: string) => records.get(id)!;
  const canonical = () => literal(mapped ? sdkId : ownerId);

  beforeEach(() => {
    mapped = true;
    missing = false;
    nextCreated = false;
    linked = false;
    beforeWrite = undefined;
    afterWrite = undefined;
    config = {
      rowndAppKey: "test", rowndAppSecret: "test", disableRowndUserMigration: true,
      metadataMode: "canonical", emailChange: { maxSessionAgeSeconds: null },
      appConfig: { signInMethods: [{ method: "email" }] },
      subBrands: { existing: { variant: { id: "existing" } }, added: { variant: { id: "added" } } },
      schema: { first_name: { display_name: "Name", type: "string", user_visible: true, owned_by: "user", include_in_session_claims: true } },
    };
    setPluginConfig(config);
    methods = [method(oldRecipeId, oldEmail), method("other-email", "other@example.com", ["other"])];
    records = new Map([
      [ownerId, { original_rownd_user: original("Internal stale"), preference: "internal", rownd_email_metadata_version: 1,
        rownd_email_recipe_user_ids: { public: oldRecipeId, other: "other-email" } }],
      [sdkId, { original_rownd_user: original("Canonical"), preference: "canonical", rownd_email_metadata_version: 1,
        rownd_email_recipe_user_ids: { public: oldRecipeId, other: "other-email" } }],
      [oldRecipeId, { preference: "recipe-stale", mustNotAppear: true }],
    ]);
    vi.spyOn(SuperTokens, "getUser").mockImplementation(async (id) => {
      if (missing) return undefined;
      if (id === nextRecipeId && nextCreated && !linked) return { ...user(), id: nextRecipeId, isPrimaryUser: false, loginMethods: [method(nextRecipeId, nextEmail)] };
      return [ownerId, sdkId, ...methods.map((entry) => entry.recipeUserId.getAsString())].includes(id) ? user() : undefined;
    });
    vi.spyOn(SuperTokens, "getUserIdMapping").mockImplementation(async ({ userId, userIdType }) =>
      mapped && userId === (userIdType === "EXTERNAL" ? sdkId : ownerId)
        ? { status: "OK", superTokensUserId: ownerId, externalUserId: sdkId, externalUserIdInfo: undefined }
        : { status: "UNKNOWN_MAPPING_ERROR" });
    vi.spyOn(UserMetadata, "getUserMetadata").mockImplementation(async (id) => ({
      status: "OK", metadata: structuredClone(records.get(id) ?? {}),
    }));
    vi.spyOn(UserMetadata, "updateUserMetadata").mockImplementation(async (id, patch) => {
      await beforeWrite?.(id, patch);
      const metadata = { ...records.get(id), ...structuredClone(patch) };
      for (const key of Object.keys(metadata)) if (metadata[key] === null) delete metadata[key];
      records.set(id, metadata);
      afterWrite?.(id, patch);
      return { status: "OK", metadata };
    });
    vi.spyOn(SuperTokens, "listUsersByAccountInfo").mockResolvedValue([]);
    vi.spyOn(MultiTenancy, "listAllTenants").mockResolvedValue({ status: "OK", tenants: [{ tenantId: "public" }, { tenantId: "other" }] } as Awaited<ReturnType<typeof MultiTenancy.listAllTenants>>);
    vi.spyOn(Session, "getAllSessionHandlesForUser").mockResolvedValue([]);
    vi.spyOn(Session, "getSessionInformation").mockResolvedValue({
      sessionHandle: "session", userId: ownerId, tenantId: "public", recipeUserId: oldRecipe,
    } as Awaited<ReturnType<typeof Session.getSessionInformation>>);
    vi.spyOn(Session, "validateClaimsForSessionHandle").mockResolvedValue({ status: "OK", invalidClaims: [] });
    vi.spyOn(Session, "revokeSession").mockResolvedValue(true);
    vi.spyOn(Session, "revokeAllSessionsForUser").mockResolvedValue([]);
    vi.spyOn(EmailVerification, "revokeEmailVerificationTokens").mockResolvedValue({ status: "OK" });
    vi.spyOn(EmailVerification, "unverifyEmail").mockResolvedValue({ status: "OK" });
    vi.spyOn(EmailVerification, "sendEmailVerificationEmail").mockResolvedValue({ status: "OK" });
    vi.spyOn(Passwordless, "revokeAllCodes").mockResolvedValue({ status: "OK" });
    vi.spyOn(Passwordless, "signInUp").mockImplementation(async () => {
      nextCreated = true;
      return { status: "OK", createdNewRecipeUser: true, recipeUserId: SuperTokens.convertToRecipeUserId(nextRecipeId),
        user: { ...user(), id: nextRecipeId, isPrimaryUser: false, loginMethods: [method(nextRecipeId, nextEmail)] } };
    });
    vi.spyOn(AccountLinking, "linkAccounts").mockImplementation(async () => {
      linked = true;
      methods.push(method(nextRecipeId, nextEmail));
      return { status: "OK", accountsAlreadyLinked: false, user: user() };
    });
    vi.spyOn(MultiTenancy, "disassociateUserFromTenant").mockImplementation(async (tenant, recipe) => {
      methods = methods.map((entry) => entry.recipeUserId.getAsString() === recipe.getAsString()
        ? { ...entry, tenantIds: entry.tenantIds.filter((id) => id !== tenant) } : entry);
      return { status: "OK", wasAssociated: true };
    });
    vi.spyOn(SuperTokens, "deleteUser").mockImplementation(async (id) => {
      methods = methods.filter((entry) => entry.recipeUserId.getAsString() !== id);
      return { status: "OK" };
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setPluginConfig(priorConfig as RowndPluginNormalisedConfig);
  });

  it("reads one literal current SDK source while preserving projection IDs, tenants and telemetry", async () => {
    const events: RowndTelemetryEvent[] = [];
    const result = await getUserById(oldRecipeId, "other", {}, { recordEvent: (event) => { events.push(event); } });
    expect(result).toMatchObject({ rownd_user: "original-rownd-id", data: { user_id: oldRecipeId, first_name: "Canonical", email: "other@example.com" },
      meta: { preference: "canonical", last_active: null }, attributes: { preserved: "Canonical" } });
    expect(SuperTokens.getUserIdMapping).not.toHaveBeenCalled();
    expect(UserMetadata.getUserMetadata).toHaveBeenCalledTimes(1);
    expect(UserMetadata.getUserMetadata).toHaveBeenCalledWith(sdkId, expect.anything());
    expect(events[0]?.sdkCalls).toEqual({ user: 1, mapping: 0, metadata: 1, sessionList: 0, sessionDetail: 0 });
  });

  it.each(["single", "combined"])("uses canonical configured/original claims in the %s builder", async (builder) => {
    const payload = { rownd_session_authentication: "authenticated" };
    const context = {} as UserContext;
    const result = builder === "single" ? await buildRowndSessionClaims(oldRecipeId, payload) :
      (await buildRowndSessionAndAnonymousClaims(oldRecipeId, payload, undefined, context, oldRecipeId)).rowndSessionClaims;
    expect(result).toMatchObject({ first_name: "Canonical", app_user_id: "original-rownd-id", auth_level: "verified" });
    expect(SuperTokens.getUserIdMapping).not.toHaveBeenCalled();
    expect(UserMetadata.getUserMetadata).toHaveBeenCalledTimes(1);
    expect(UserMetadata.getUserMetadata).toHaveBeenCalledWith(sdkId, builder === "single" ? undefined : {});
  });

  it("keeps an empty canonical record authoritative without alias fallback", async () => {
    records.set(sdkId, {});
    const result = await getUserById(oldRecipeId);
    expect(result.data.first_name).toBe("");
    expect(result.meta.preference).toBeUndefined();
    expect(result.rownd_user).toBe(oldRecipeId);
    expect(SuperTokens.getUserIdMapping).not.toHaveBeenCalled();
    expect(UserMetadata.getUserMetadata).toHaveBeenCalledTimes(1);
  });

  it("retains independent raw origin validation for an unmarked legacy session", async () => {
    const context = {} as UserContext;
    await buildRowndSessionAndAnonymousClaims(sdkId, {}, undefined, context, oldRecipeId);
    expect(SuperTokens.getUserIdMapping).toHaveBeenCalled();
    expect(UserMetadata.getUserMetadata).toHaveBeenCalledWith(ownerId, {});
  });

  it("keeps explicit tenant activity enrichment separate from the canonical metadata read", async () => {
    vi.mocked(Session.getAllSessionHandlesForUser).mockResolvedValue(["session"]);
    vi.mocked(Session.getSessionInformation).mockResolvedValue({
      timeCreated: 2000, recipeUserId: oldRecipe,
    } as Awaited<ReturnType<typeof Session.getSessionInformation>>);
    const result = await getUserById(oldRecipeId, "public", {}, { includeActivity: true });
    expect(result.meta.last_active).toBe(new Date(2000).toISOString());
    expect(Session.getAllSessionHandlesForUser).toHaveBeenCalledWith(sdkId, true, "public", expect.anything());
    expect(UserMetadata.getUserMetadata).toHaveBeenCalledTimes(1);
    expect(SuperTokens.getUserIdMapping).not.toHaveBeenCalled();
  });

  it("propagates canonical metadata errors and still records failed profile instrumentation", async () => {
    const events: RowndTelemetryEvent[] = [];
    vi.mocked(UserMetadata.getUserMetadata).mockRejectedValue(new Error("canonical unavailable"));
    await expect(getUserById(sdkId, "public", {}, { recordEvent: (event) => { events.push(event); } })).rejects.toThrow("canonical unavailable");
    expect(SuperTokens.getUserIdMapping).not.toHaveBeenCalled();
    expect(UserMetadata.getUserMetadata).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
  });

  it("updates profiles at SDK user.id with authoritative deletions and nested replacement", async () => {
    const result = await updateUserData(oldRecipeId, { first_name: null, custom: { replaced: true } });
    expect(result.data.user_id).toBe(sdkId);
    expect(result.data.first_name).toBeUndefined();
    expect(result.data.custom).toEqual({ replaced: true });
    expect(getAuthoritativeProfileFields(canonical())).toEqual(expect.arrayContaining(["first_name", "custom"]));
    const reloaded = await getUserById(sdkId);
    expect(reloaded.data.first_name).toBeUndefined();
    expect(reloaded.data.custom).toEqual({ replaced: true });
    expect(literal(ownerId).original_rownd_user?.data.first_name).toBe("Internal stale");
    expect(UserMetadata.updateUserMetadata).toHaveBeenCalledTimes(1);
    expect(vi.mocked(UserMetadata.updateUserMetadata).mock.calls[0]?.[0]).toBe(sdkId);
    expect(SuperTokens.getUserIdMapping).not.toHaveBeenCalled();
  });

  it.each([undefined, null, {}])("preserves own-key public metadata writes with %j", async (value) => {
    const result = await updateUserMetadata(oldRecipeId, { preference: value, last_active: null });
    expect(result.id).toBe(sdkId);
    expect(result.meta.preference).toEqual(value === null ? undefined : value);
    expect(UserMetadata.updateUserMetadata).toHaveBeenCalledTimes(1);
    expect(vi.mocked(UserMetadata.updateUserMetadata).mock.calls[0]?.[1]).toHaveProperty("preference", value);
    expect(literal(ownerId).preference).toBe("internal");
    expect(canonical()).not.toHaveProperty("last_active");
  });

  it("keeps no-op response identity and stored activity without writing or reading aliases", async () => {
    records.set(sdkId, { ...canonical(), last_active: "stored" });
    expect(await updateUserMetadata(oldRecipeId, { last_active: null })).toEqual({
      id: sdkId, meta: { preference: "canonical", last_active: "stored" },
    });
    expect(UserMetadata.updateUserMetadata).not.toHaveBeenCalled();
    expect(UserMetadata.getUserMetadata).toHaveBeenCalledTimes(1);
    expect(SuperTokens.getUser).toHaveBeenCalledTimes(1);
    expect(SuperTokens.getUserIdMapping).not.toHaveBeenCalled();
  });

  it("does not resurrect public deletions or nested values in a later metadata no-op", async () => {
    records.set(sdkId, { ...canonical(), settings: { retained: true, removed: true } });
    await updateUserMetadata(oldRecipeId, { preference: null, settings: { retained: false } });
    vi.mocked(UserMetadata.updateUserMetadata).mockClear();
    expect(await updateUserMetadata(oldRecipeId, {})).toEqual({ id: sdkId, meta: { settings: { retained: false } } });
    expect(UserMetadata.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("leaves operational writer addresses and lifecycle authority unchanged", async () => {
    await updatePrimaryUserMetadata(sdkId, { rownd_pending_verification: [pending()] });
    expect(literal(ownerId).rownd_pending_verification).toEqual([pending()]);
    expect(canonical().rownd_pending_verification).toBeUndefined();
    expect(SuperTokens.getUserIdMapping).toHaveBeenCalled();
  });

  it.each([undefined, "public", "other"])("adds a variant at the fresh canonical source (tenant=%s)", async (tenant) => {
    const legacyOriginal = original("Canonical");
    const originalWithTenantVariants = {
      ...legacyOriginal, attributes: { ...legacyOriginal.attributes, "rownd:app_variants_by_tenant": { other: ["existing"] } },
    };
    records.set(sdkId, { ...canonical(), original_rownd_user: originalWithTenantVariants });
    await recordRowndAppVariantForUser(oldRecipeId, "added", {}, tenant);
    expect(SuperTokens.getUserIdMapping).not.toHaveBeenCalled();
    expect(UserMetadata.getUserMetadata).toHaveBeenCalledTimes(1);
    expect(vi.mocked(UserMetadata.updateUserMetadata).mock.calls).toEqual([[sdkId, {
      [ROWND_APP_VARIANTS_KEY]: { [tenant ?? "public"]: ["existing", "added"] },
    }, expect.anything()]]);
    expect(canonical().original_rownd_user).toEqual(originalWithTenantVariants);
    for (const scope of ["public", "other"]) {
      expect((await getUserById(sdkId, scope)).attributes).toEqual({
        preserved: "Canonical", "rownd:app_variants": scope === (tenant ?? "public") ? ["existing", "added"] : ["existing"],
      });
    }
  });

  it.each([undefined, "other"])("does not write an existing variant (tenant=%s)", async (tenant) => {
    await recordRowndAppVariantForUser(oldRecipeId, "existing", {}, tenant);
    expect(UserMetadata.updateUserMetadata).not.toHaveBeenCalled();
    expect(SuperTokens.getUserIdMapping).not.toHaveBeenCalled();
  });

  it.each(["public", "other"])("honors an empty overlay in %s without affecting any other scope", async (scope) => {
    records.set(sdkId, { ...canonical(), [ROWND_APP_VARIANTS_KEY]: { [scope]: [] } });
    const otherScope = scope === "public" ? "other" : "public";
    expect((await getUserById(sdkId, scope)).attributes?.["rownd:app_variants"]).toEqual([]);
    expect((await getUserById(sdkId, otherScope)).attributes?.["rownd:app_variants"]).toEqual(["existing"]);
    await recordRowndAppVariantForUser(sdkId, "added", {}, otherScope);
    await recordRowndAppVariantForUser(sdkId, "added", {}, scope);
    expect(canonical()[ROWND_APP_VARIANTS_KEY]).toEqual({
      [scope]: ["added"], [otherScope]: ["existing", "added"],
    });
    expect((await getUserById(sdkId, scope)).attributes?.["rownd:app_variants"]).toEqual(["added"]);
    expect((await getUserById(sdkId, otherScope)).attributes?.["rownd:app_variants"]).toEqual(["existing", "added"]);
  });

  it("honors an empty legacy tenant array when seeding an absent overlay scope", async () => {
    records.set(sdkId, { original_rownd_user: { ...original("Canonical"), attributes: {
      "rownd:app_variants": ["existing"], "rownd:app_variants_by_tenant": { other: [] },
    } } });
    await recordRowndAppVariantForUser(sdkId, "added", {}, "other");
    expect(canonical()[ROWND_APP_VARIANTS_KEY]).toEqual({ other: ["added"] });
    expect((await getUserById(sdkId)).attributes?.["rownd:app_variants"]).toEqual(["existing"]);
  });

  it("filters overlay variants against resolved config and keeps tenant fallback disabled", async () => {
    config.resolveConfig = async () => ({});
    records.set(sdkId, { ...canonical(), [ROWND_APP_VARIANTS_KEY]: { public: ["added", "unconfigured"] } });
    const publicProfile = await getUserById(sdkId);
    expect(publicProfile.attributes?.["rownd:app_variants"]).toEqual(["added"]);
    expect(publicProfile.meta).not.toHaveProperty(ROWND_APP_VARIANTS_KEY);
    expect((await getUserById(sdkId, "other")).attributes?.["rownd:app_variants"]).toEqual([]);
    await recordRowndAppVariantForUser(sdkId, "added", {}, "other");
    expect((await getUserById(sdkId, "other")).attributes?.["rownd:app_variants"]).toEqual(["added"]);
  });

  it("propagates variant metadata failures without discovery or a speculative write", async () => {
    vi.mocked(UserMetadata.getUserMetadata).mockRejectedValue(new Error("variant source unavailable"));
    await expect(recordRowndAppVariantForUser(sdkId, "added")).rejects.toThrow("variant source unavailable");
    expect(SuperTokens.getUserIdMapping).not.toHaveBeenCalled();
    expect(UserMetadata.updateUserMetadata).not.toHaveBeenCalled();
  });

  it.each(["variant", "email"])("preserves both writes when the %s publication is delayed", async (delayed) => {
    records.set(ownerId, { ...literal(ownerId), rownd_pending_verification: [pending()] });
    let reachedWrite!: () => void;
    let releaseWrite!: () => void;
    const atWrite = new Promise<void>((resolve) => { reachedWrite = resolve; });
    const resume = new Promise<void>((resolve) => { releaseWrite = resolve; });
    beforeWrite = async (id) => {
      if (id !== sdkId) return;
      beforeWrite = undefined;
      reachedWrite();
      await resume;
    };
    const addVariant = () => recordRowndAppVariantForUser(sdkId, "added");
    const first = delayed === "variant" ? addVariant() : complete();
    try {
      await Promise.race([atWrite, first]);
      await (delayed === "variant" ? complete() : addVariant());
    } finally {
      releaseWrite();
      await first;
    }

    expect(await getUserById(sdkId)).toMatchObject({
      data: { email: nextEmail }, verified_data: { email: nextEmail },
      attributes: { "rownd:app_variants": ["existing", "added"] },
    });
    expect(await buildRowndOAuthUserInfo({ user: user(), accessTokenPayload: {}, scopes: ["email"] }))
      .toMatchObject({ email: nextEmail, email_verified: true });
  });

  it("initializes absent presentation inputs for an already-final new owner without marking migration complete", async () => {
    mapped = false;
    records.set(ownerId, {});
    await updateUserData(oldRecipeId, { first_name: "New" });
    await recordRowndAppVariantForUser(oldRecipeId, "added");
    expect(canonical()).toMatchObject({ first_name: "New", [ROWND_APP_VARIANTS_KEY]: { public: ["added"] } });
    expect(canonical().original_rownd_user).toBeUndefined();
    expect(canonical().rownd_migration_complete).toBeUndefined();
    expect(await getUserById(ownerId)).toMatchObject({
      rownd_user: ownerId, data: { first_name: "New" }, attributes: { "rownd:app_variants": ["added"] },
    });
  });

  it("fails a missing-owner variant write rather than publishing orphan metadata", async () => {
    missing = true;
    await expect(recordRowndAppVariantForUser(sdkId, "added")).rejects.toThrow();
    expect(UserMetadata.updateUserMetadata).not.toHaveBeenCalled();
  });

  it.each([true, false])("publishes before a single pending-array PUT on same-email cancellation (mapped=%s)", async (isMapped) => {
    mapped = isMapped;
    records.set(ownerId, { ...literal(ownerId), rownd_pending_verification: [pending(), pending({ id: "other-plan", tenantId: "other" })] });
    await begin(oldEmail);
    expect(canonical().original_rownd_user).toEqual(original(mapped ? "Canonical" : "Internal stale"));
    expect(canonical().rownd_email_recipe_user_ids).toEqual({ public: oldRecipeId, other: "other-email" });
    const remaining = [pending({ id: "other-plan", tenantId: "other" })];
    expect(literal(ownerId).rownd_pending_verification).toEqual(remaining);
    const writes = vi.mocked(UserMetadata.updateUserMetadata).mock.calls;
    expect(writes).toHaveLength(2);
    expect(writes[0]?.[0]).toBe(mapped ? sdkId : ownerId);
    expect(writes[0]?.[1]).toHaveProperty("original_rownd_user");
    expect(writes[0]?.[1]).not.toHaveProperty("rownd_pending_verification");
    expect(writes[1]?.[0]).toBe(ownerId);
    expect(writes[1]?.[1]).toHaveProperty("rownd_pending_verification", remaining);
    expect(writes[1]?.[1]).not.toHaveProperty("original_rownd_user");
    expect(EmailVerification.sendEmailVerificationEmail).not.toHaveBeenCalled();
  });

  it("only cleans up pending state when same-email cancellation has no verified method to publish", async () => {
    methods = methods.map((entry) => ({ ...entry, verified: false }));
    records.set(ownerId, { ...literal(ownerId), rownd_pending_verification: [pending()] });
    await begin(oldEmail);
    expect(vi.mocked(UserMetadata.updateUserMetadata).mock.calls).toEqual([[ownerId, {
      rownd_pending_verification: [], rownd_email_metadata_version: 1,
    }, expect.anything()]]);
    expect(canonical().original_rownd_user).toEqual(original("Canonical"));
  });

  it("preserves edits made by token revocation hooks when raw and canonical addresses coincide", async () => {
    mapped = false;
    records.set(ownerId, { ...literal(ownerId), rownd_pending_verification: [pending()] });
    vi.mocked(EmailVerification.revokeEmailVerificationTokens).mockImplementation(async () => {
      records.set(ownerId, { ...literal(ownerId), preference: "hook edit", original_rownd_user: original("Hook edit") });
      return { status: "OK" };
    });
    await begin(oldEmail);
    expect(canonical()).toMatchObject({ preference: "hook edit", original_rownd_user: original("Hook edit"), rownd_pending_verification: [] });
  });

  it("does not replay an original deleted by a token revocation hook", async () => {
    mapped = false;
    records.set(ownerId, { ...literal(ownerId), rownd_pending_verification: [pending()] });
    vi.mocked(EmailVerification.revokeEmailVerificationTokens).mockImplementation(async () => {
      delete literal(ownerId).original_rownd_user;
      return { status: "OK" };
    });
    await begin(oldEmail);
    expect(canonical().original_rownd_user?.data).toEqual({ user_id: ownerId, email: oldEmail });
    expect(canonical().original_rownd_user?.attributes).toBeUndefined();
  });

  it("keeps same-email pending state recoverable if canonical publication fails", async () => {
    records.set(ownerId, { ...literal(ownerId), rownd_pending_verification: [pending()] });
    beforeWrite = (id) => { if (id === sdkId) throw new Error("publication failed"); };
    await expect(begin(oldEmail)).rejects.toThrow("publication failed");
    expect(literal(ownerId).rownd_pending_verification).toEqual([pending()]);
    expect(UserMetadata.updateUserMetadata).toHaveBeenCalledTimes(1);
    beforeWrite = undefined;
    await begin(oldEmail);
    expect(literal(ownerId).rownd_pending_verification).toEqual([]);
    const pendingWrites = vi.mocked(UserMetadata.updateUserMetadata).mock.calls
      .filter(([, patch]) => Object.prototype.hasOwnProperty.call(patch, "rownd_pending_verification"));
    expect(pendingWrites).toHaveLength(1);
  });

  it("retains post-delivery missing-user validation and does not publish a profile after deletion", async () => {
    vi.mocked(EmailVerification.sendEmailVerificationEmail).mockImplementation(async () => {
      missing = true;
      return { status: "OK" };
    });
    await expect(begin()).rejects.toThrow();
    expect(literal(ownerId).rownd_pending_verification).toEqual([expect.objectContaining({ id: "new-pending" })]);
    expect(vi.mocked(UserMetadata.updateUserMetadata).mock.calls.every(([id]) => id === ownerId)).toBe(true);
    expect(canonical().original_rownd_user).toEqual(original("Canonical"));
  });

  it("propagates post-delivery canonical metadata failures without erasing the delivered pending state", async () => {
    vi.mocked(EmailVerification.sendEmailVerificationEmail).mockImplementation(async () => {
      vi.mocked(UserMetadata.getUserMetadata).mockImplementation(async (id) => {
        if (id === sdkId) throw new Error("post-delivery read failed");
        return { status: "OK", metadata: structuredClone(records.get(id) ?? {}) };
      });
      return { status: "OK" };
    });
    await expect(begin()).rejects.toThrow("post-delivery read failed");
    expect(literal(ownerId).rownd_pending_verification).toEqual([expect.objectContaining({ id: "new-pending" })]);
  });

  it("cleans delivery failures through the raw writer without touching canonical originals", async () => {
    vi.mocked(EmailVerification.sendEmailVerificationEmail).mockRejectedValue(new Error("delivery failed"));
    await expect(begin()).rejects.toThrow("delivery failed");
    expect(literal(ownerId).rownd_pending_verification).toEqual([]);
    expect(canonical().original_rownd_user).toEqual(original("Canonical"));
  });

  it.each([true, false])("separates the replacement checkpoint from canonical publication (mapped=%s)", async (isMapped) => {
    mapped = isMapped;
    const canonicalId = user().id;
    const operationalMetadata = { ...literal(ownerId), rownd_pending_verification: [pending()] };
    if (mapped) delete operationalMetadata.original_rownd_user;
    records.set(ownerId, operationalMetadata);
    afterWrite = (id, patch) => {
      if (id === ownerId && (patch.rownd_pending_verification as RowndPendingVerification[])?.[0]?.status === "COMMITTING") {
        records.set(canonicalId, { ...canonical(), preference: "edited during commit", original_rownd_user: {
          ...original("Edited during commit"), attributes: { ...original("Edited during commit").attributes, extra: true },
        } });
      }
    };
    expect(await complete()).toMatchObject({ userId: canonicalId, replaceSession: true });
    expect(canonical()).toMatchObject({ preference: "edited during commit", rownd_email_recipe_user_ids: { public: nextRecipeId, other: "other-email" },
      original_rownd_user: { data: { first_name: "Edited during commit", email: nextEmail, custom: { retained: true } },
        verified_data: { email: nextEmail, phone_number: "+15555550100" }, attributes: { extra: true } } });
    const writes = vi.mocked(UserMetadata.updateUserMetadata).mock.calls;
    expect(writes.map(([id]) => id)).toEqual([ownerId, canonicalId, ownerId]);
    expect(writes[0]?.[1]).toEqual({
      rownd_pending_verification: [expect.objectContaining({ status: "COMMITTING", targetCanonicalRecipeUserId: nextRecipeId })],
      rownd_email_recipe_user_id: nextRecipeId,
      rownd_email_recipe_user_ids: { public: nextRecipeId, other: "other-email" },
      rownd_email_metadata_version: 1,
    });
    expect(writes[1]?.[1]).not.toHaveProperty("rownd_pending_verification");
    expect(writes[2]?.[1]).toEqual({ rownd_pending_verification: [], rownd_email_metadata_version: 1 });
    expect(literal(ownerId).rownd_pending_verification).toEqual([]);
    const oauth = () => buildRowndOAuthUserInfo({ user: user(), accessTokenPayload: {}, scopes: ["email", "profile"] });
    const claims = await oauth();
    expect(claims).toMatchObject({ email: nextEmail, email_verified: true, given_name: "Edited during commit" });
    if (mapped) {
      expect(literal(ownerId).original_rownd_user).toBeUndefined();
      expect(literal(ownerId).preference).toBe("internal");
      config.metadataMode = "compatibility";
      expect(await oauth()).toEqual(claims);
    }
  });

  it("keeps the old method active on publication failure and publishes before retirement on retry", async () => {
    records.set(ownerId, { ...literal(ownerId), rownd_pending_verification: [pending()] });
    beforeWrite = (id) => { if (id === sdkId) throw new Error("publication failed"); };
    await expect(complete()).rejects.toThrow("reconciliation");
    expect(literal(ownerId).rownd_pending_verification).toEqual([expect.objectContaining({ status: "COMMITTING", targetCanonicalRecipeUserId: nextRecipeId })]);
    expect(methods).toContainEqual(expect.objectContaining({ email: oldEmail, verified: true, tenantIds: ["public"] }));
    expect(Passwordless.revokeAllCodes).not.toHaveBeenCalled();
    expect(MultiTenancy.disassociateUserFromTenant).not.toHaveBeenCalled();
    expect(SuperTokens.deleteUser).not.toHaveBeenCalled();
    const oauth = () => buildRowndOAuthUserInfo({ user: user(), accessTokenPayload: {}, scopes: ["email"] });
    expect(await oauth()).toEqual({ email: oldEmail, email_verified: true });
    expect(canonical().original_rownd_user?.data.email).toBe(oldEmail);
    beforeWrite = undefined;
    records.set(sdkId, { ...canonical(), preference: "recovery edit", original_rownd_user: original("Recovery edit") });
    vi.mocked(SuperTokens.listUsersByAccountInfo).mockResolvedValue([user()]);
    vi.mocked(Session.revokeAllSessionsForUser).mockClear().mockImplementationOnce(async () => {
      expect(methods.some((entry) => entry.email === oldEmail)).toBe(false);
      expect(literal(ownerId).rownd_pending_verification?.[0]?.status).toBe("COMMITTING");
      expect(await oauth()).toEqual({ email: nextEmail, email_verified: true });
      return [];
    });
    expect(await prepareEmailForPasswordlessAuth({ email: nextEmail, tenantId: "public", reconcileTarget: true, userContext: {} })).toMatchObject({ status: "ALLOW" });
    expect(SuperTokens.deleteUser).toHaveBeenCalledTimes(1);
    expect(SuperTokens.deleteUser).toHaveBeenCalledWith(oldRecipeId, false, expect.anything());
    expect(Session.revokeAllSessionsForUser).toHaveBeenCalledTimes(1);
    expect(literal(ownerId).rownd_pending_verification).toEqual([]);
    expect(canonical()).toMatchObject({ preference: "recovery edit", original_rownd_user: { data: { first_name: "Recovery edit", email: nextEmail } } });
  });

  it("retries publication when final raw checkpoint cleanup fails after a successful canonical write", async () => {
    records.set(ownerId, { ...literal(ownerId), rownd_pending_verification: [pending()] });
    beforeWrite = (id, patch) => {
      if (id === ownerId && Array.isArray(patch.rownd_pending_verification) && patch.rownd_pending_verification.length === 0) {
        throw new Error("checkpoint cleanup failed");
      }
    };
    await expect(complete()).rejects.toThrow("reconciliation");
    const published = canonical().original_rownd_user!;
    expect(published.data.email).toBe(nextEmail);
    expect(literal(ownerId).rownd_pending_verification?.[0]?.status).toBe("COMMITTING");
    expect(methods.some((entry) => entry.email === oldEmail)).toBe(false);
    beforeWrite = undefined;
    records.set(sdkId, { ...canonical(), original_rownd_user: {
      ...published, data: { ...published.data, first_name: "Post-publish edit" }, state: "disabled",
    } });
    vi.mocked(SuperTokens.listUsersByAccountInfo).mockResolvedValue([user()]);
    vi.mocked(UserMetadata.updateUserMetadata).mockClear();
    await prepareEmailForPasswordlessAuth({ email: nextEmail, tenantId: "public", reconcileTarget: true });
    expect(literal(ownerId).rownd_pending_verification).toEqual([]);
    expect(vi.mocked(UserMetadata.updateUserMetadata).mock.calls.map(([id]) => id)).toEqual([sdkId, ownerId]);
    expect(canonical().original_rownd_user).toMatchObject({
      data: { first_name: "Post-publish edit", email: nextEmail }, verified_data: { email: nextEmail }, state: "disabled",
    });
  });

  it("keeps compatibility replacement publication and cleanup on the internal owner", async () => {
    config.metadataMode = "compatibility";
    records.set(ownerId, { ...literal(ownerId), rownd_pending_verification: [pending()] });
    expect(await complete()).toMatchObject({ userId: sdkId, replaceSession: true });
    const writes = vi.mocked(UserMetadata.updateUserMetadata).mock.calls;
    expect(writes.map(([id]) => id)).toEqual([ownerId, ownerId]);
    expect(writes[0]?.[1]).toMatchObject({
      preference: "internal",
      original_rownd_user: { data: { first_name: "Internal stale", email: nextEmail } },
      rownd_pending_verification: [expect.objectContaining({ status: "COMMITTING" })],
    });
    expect(literal(ownerId).rownd_pending_verification).toEqual([]);
    expect(canonical().original_rownd_user).toEqual(original("Canonical"));
  });

  it("keeps compatibility public writes and variant provenance at their existing sources", async () => {
    config.metadataMode = "compatibility";
    await updateUserData(oldRecipeId, { first_name: "Legacy edit" });
    expect(literal(ownerId).first_name).toBe("Legacy edit");
    expect(canonical().first_name).toBeUndefined();
    await recordRowndAppVariantForUser(sdkId, "added");
    expect(SuperTokens.getUserIdMapping).toHaveBeenCalled();
    expect(UserMetadata.updateUserMetadata).toHaveBeenCalledTimes(2);
    expect(vi.mocked(UserMetadata.updateUserMetadata).mock.calls[1]).toEqual([ownerId, {
      original_rownd_user: { ...original("Internal stale"), attributes: {
        preserved: "Internal stale", "rownd:app_variants": ["existing", "added"],
      } },
    }, expect.anything()]);
  });
});

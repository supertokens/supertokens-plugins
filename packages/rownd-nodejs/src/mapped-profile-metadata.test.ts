import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SuperTokens from "supertokens-node";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import EmailVerification from "supertokens-node/recipe/emailverification";
import Session from "supertokens-node/recipe/session";
import MultiTenancy from "supertokens-node/recipe/multitenancy";
import { buildConfiguredSessionClaims, buildRowndUserMetadata, getCombinedUserMetadata, updatePrimaryUserMetadata } from "./rownd-compatibility";
import { getUserById, resolvePendingEmailVerificationToken, startPendingEmailVerification, updateUserData, updateUserMetadata } from "./supertokens-repository";
import type { JsonRecord } from "./utils";

describe("mapped profile metadata", () => {
  const ownerId = "internal-owner";
  const externalId = "rownd-owner";
  const recipeUserId = SuperTokens.convertToRecipeUserId("passwordless");
  let records: Map<string, JsonRecord>;
  let mapped: boolean;
  const method = (id: string, email: string, tenantIds = ["public"]) => ({
    recipeUserId: SuperTokens.convertToRecipeUserId(id), recipeId: "passwordless",
    email, tenantIds, verified: true, timeJoined: 2,
  });
  const user = () => ({
    id: mapped ? externalId : ownerId, isPrimaryUser: true, timeJoined: 1, tenantIds: ["public", "other"],
    emails: ["old@example.com", "new@example.com"], phoneNumbers: [],
    loginMethods: [
      { ...method(ownerId, "old@example.com"), recipeId: "thirdparty", timeJoined: 1,
        thirdParty: { id: "google", userId: "google-subject" } },
      method("passwordless", "new@example.com"),
      method("other-passwordless", "other@example.com", ["other"]),
    ],
  }) as unknown as NonNullable<Awaited<ReturnType<typeof SuperTokens.getUser>>>;
  const pending = (id: string, tenantId = "public") => ({
    id, tenantId, field: "email", value: "next@example.com", created_at: new Date().toISOString(),
    status: "PENDING", purpose: "UPDATE_PASSWORDLESS", verificationRecipeUserId: "passwordless",
    initiatingSessionHandle: "session",
  });

  beforeEach(() => {
    mapped = true;
    records = new Map([[ownerId, {
      first_name: "Old name", original_rownd_user: { data: { user_id: externalId, first_name: "Old name" } },
    }]]);
    vi.spyOn(SuperTokens, "getUser").mockImplementation(async (id) =>
      [ownerId, externalId, "passwordless", "other-passwordless"].includes(id) ? user() : undefined);
    vi.spyOn(SuperTokens, "getUserIdMapping").mockImplementation(async ({ userId, userIdType }) =>
      mapped && userId === (userIdType === "EXTERNAL" ? externalId : ownerId)
        ? { status: "OK", superTokensUserId: ownerId, externalUserId: externalId }
        : { status: "UNKNOWN_MAPPING_ERROR" });
    vi.spyOn(UserMetadata, "getUserMetadata").mockImplementation(async (id) => ({
      status: "OK", metadata: structuredClone(records.get(id) ?? {}),
    }));
    vi.spyOn(UserMetadata, "updateUserMetadata").mockImplementation(async (id, patch) => {
      const metadata = { ...records.get(id), ...patch };
      for (const key of Object.keys(metadata)) if (metadata[key] === null) delete metadata[key];
      records.set(id, metadata);
      return { status: "OK", metadata };
    });
    vi.spyOn(SuperTokens, "listUsersByAccountInfo").mockResolvedValue([]);
    vi.spyOn(Session, "getAllSessionHandlesForUser").mockResolvedValue([]);
    vi.spyOn(MultiTenancy, "listAllTenants").mockResolvedValue({ status: "OK", tenants: [{ tenantId: "public" }, { tenantId: "other" }] } as any);
    vi.spyOn(EmailVerification, "revokeEmailVerificationTokens").mockResolvedValue({ status: "OK" });
    vi.spyOn(EmailVerification, "unverifyEmail").mockResolvedValue({ status: "OK" });
    vi.spyOn(EmailVerification, "sendEmailVerificationEmail").mockResolvedValue({ status: "OK" });
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([true, false])("returns updated profile names with stable public identity (mapped=%s)", async (isMapped) => {
    mapped = isMapped;
    const id = mapped ? externalId : ownerId;
    expect((await updateUserData(id, { first_name: "New name" })).data).toMatchObject({
      user_id: id, first_name: "New name",
    });
    expect((await getUserById(id)).data.first_name).toBe("New name");
    expect(records.get(ownerId)?.first_name).toBe("New name");
  });

  it("reads the changed email rather than the older Google email after a canonical pointer write", async () => {
    await updatePrimaryUserMetadata(externalId, { rownd_email_recipe_user_ids: { public: "passwordless" } });
    expect((await getUserById(externalId)).data.email).toBe("new@example.com");
  });

  it("keeps the external ID in metadata update responses", async () => {
    expect(await updateUserMetadata(externalId, { preference: "new" })).toMatchObject({
      id: externalId, meta: { preference: "new" },
    });
  });

  it("does not restore deleted fields or replaced nested values from the alias", async () => {
    records.set(externalId, { preference: "old", settings: { keep: true, removed: true } });
    const result = await updateUserMetadata(externalId, { preference: null, settings: { keep: false } });
    expect(result.meta.preference).toBeUndefined();
    expect(result.meta.settings).toEqual({ keep: false });
    expect((await getCombinedUserMetadata(externalId)).preference).toBeUndefined();
  });

  it("does not restore a deleted profile name from the original Rownd snapshot", async () => {
    records.set(externalId, { first_name: "Alias name" });
    expect((await updateUserData(externalId, { first_name: null })).data.first_name).toBeUndefined();
    expect((await getUserById(externalId)).data.first_name).toBeUndefined();
  });

  it.each([true, false])("retains deletions and whole-object replacements through subsequent edits (mapped=%s)", async (isMapped) => {
    mapped = isMapped;
    const id = mapped ? externalId : ownerId;
    records.set("passwordless", { preference: "old", settings: { removed: true }, first_name: "Alias" });
    for (let attempt = 0; attempt < 2; attempt++) {
      await updateUserMetadata(id, { preference: null, settings: { nested: null } });
      await updateUserData(id, { first_name: null });
      await updateUserMetadata(id, { unrelated: attempt });
      const metadata = await getCombinedUserMetadata(id);
      expect(metadata.preference).toBeUndefined();
      expect(metadata.settings).toEqual({ nested: null });
      expect((await getUserById(id)).data.first_name).toBeUndefined();
    }
    expect((await updateUserMetadata(id, { preference: "new", settings: {} })).meta).toMatchObject({ preference: "new", settings: {} });
    expect((await updateUserData(id, { first_name: "Restored" })).data.first_name).toBe("Restored");
    expect((await updateUserMetadata(id, { preference: "overwritten" })).meta.preference).toBe("overwritten");
    const profile = await getUserById(id);
    expect(profile.meta.preference).toBe("overwritten");
    expect(profile.data.preference).toBeUndefined();
  });

  it("keeps field authority private and ignores alias and caller-supplied markers", async () => {
    records.set(externalId, { rownd_profile_authoritative_fields: ["preference"], preference: "fallback" });
    expect((await getCombinedUserMetadata(externalId)).rownd_profile_authoritative_fields).toBeUndefined();
    await updateUserMetadata(externalId, { preference: null });
    const response = await updateUserMetadata(externalId, { rownd_profile_authoritative_fields: null });
    expect(response.meta.preference).toBeUndefined();
    expect(response.meta.rownd_profile_authoritative_fields).toBeUndefined();
    const profile = await getUserById(externalId);
    expect(profile.data.rownd_profile_authoritative_fields).toBeUndefined();
    expect(profile.meta.rownd_profile_authoritative_fields).toBeUndefined();
  });

  it("does not establish profile authority for operational writes carrying fallback data", async () => {
    records.set(externalId, { settings: { legacy: true } });
    await updatePrimaryUserMetadata(externalId, { settings: { current: true }, rownd_pending_verification: [] });
    expect((await getCombinedUserMetadata(externalId)).settings).toEqual({ current: true, legacy: true });
    expect(records.get(ownerId)?.rownd_profile_authoritative_fields).toBeUndefined();
  });

  it("applies profile authority to session claims and excludes reserved schema/import fields", async () => {
    await updateUserData(externalId, { first_name: null });
    const config = { schema: {
      first_name: { include_in_session_claims: true },
      rownd_profile_authoritative_fields: { include_in_session_claims: true },
    } } as any;
    expect(buildConfiguredSessionClaims(await getCombinedUserMetadata(externalId), config)).toEqual({});
    await updateUserData(externalId, { first_name: "Current" });
    expect(buildConfiguredSessionClaims(await getCombinedUserMetadata(externalId), config)).toEqual({ first_name: "Current" });
    const imported = buildRowndUserMetadata({
      data: { user_id: "source", rownd_profile_authoritative_fields: ["first_name"] },
      meta: { rownd_profile_authoritative_fields: ["settings"] },
    });
    expect(imported.rownd_profile_authoritative_fields).toBeUndefined();
  });

  it.each([true, false])("returns the owner identity when editing through a linked recipe (mapped=%s)", async (isMapped) => {
    mapped = isMapped;
    const id = mapped ? externalId : ownerId;
    expect((await updateUserData("passwordless", { first_name: "New name" })).data.user_id).toBe(id);
    expect((await updateUserMetadata("passwordless", { preference: "new" })).id).toBe(id);
  });

  it("honors existing external-row pointers only in their tenant and owner graph", async () => {
    records.set(externalId, { rownd_email_recipe_user_ids: { public: "passwordless", other: "passwordless" } });
    expect((await getUserById(externalId)).data.email).toBe("new@example.com");
    expect((await getUserById(externalId, "other")).data.email).toBe("other@example.com");
    records.set(externalId, { rownd_email_recipe_user_ids: { public: "unrelated-owner" } });
    expect((await getUserById(externalId)).data.email).toBe("old@example.com");
  });

  it("does not import pending plans or pointers from linked recipe rows", async () => {
    records.set("passwordless", { rownd_email_recipe_user_ids: { public: "passwordless" }, rownd_pending_verification: [pending("unrelated")] });
    const metadata = await getCombinedUserMetadata(externalId);
    expect(metadata.rownd_pending_verification).toBeUndefined();
    expect(metadata.rownd_email_recipe_user_ids).toBeUndefined();
  });

  it("does not import operational state from retired aliases that reference the owner", async () => {
    records.set("retired", { rownd_migration_target: ownerId, rownd_email_recipe_user_ids: { public: "passwordless" }, rownd_pending_verification: [pending("retired")] });
    const metadata = await getCombinedUserMetadata("retired");
    expect(metadata.rownd_email_recipe_user_ids).toBeUndefined();
    expect(metadata.rownd_pending_verification).toBeUndefined();
  });

  it("supports external legacy scalar pointers without overriding an internal scalar", async () => {
    records.set(externalId, { rownd_email_recipe_user_id: "passwordless" });
    expect((await getUserById(externalId)).data.email).toBe("new@example.com");
    records.set(ownerId, { ...records.get(ownerId), rownd_email_recipe_user_id: ownerId });
    records.set(externalId, { rownd_email_recipe_user_ids: { public: "passwordless" } });
    expect((await getUserById(externalId)).data.email).toBe("old@example.com");
  });

  it.each([ownerId, "unrelated-owner"])("validates literal session owner %s against the current mapping", async (sessionOwner) => {
    records.set(ownerId, { ...records.get(ownerId), rownd_pending_verification: [pending("plan")] });
    vi.spyOn(Session, "getSessionInformation").mockResolvedValue({ sessionHandle: "session", userId: sessionOwner, tenantId: "public" } as any);
    const session = { getHandle: () => "session", getUserId: () => externalId, getTenantId: () => "public" } as any;
    expect(await resolvePendingEmailVerificationToken({ token: "token", queryPendingVerificationId: "plan", tenantId: "public", session }))
      .toMatchObject({ status: sessionOwner === ownerId ? "OK" : "INVALID_PENDING" });
  });

  it("keeps canonical empty pending state authoritative over stale external plans", async () => {
    records.set(externalId, { rownd_pending_verification: [pending("stale")] });
    await updatePrimaryUserMetadata(externalId, { rownd_pending_verification: [] });
    expect(records.get(ownerId)?.rownd_pending_verification).toEqual([]);
    expect((await getCombinedUserMetadata(externalId)).rownd_pending_verification).toEqual([]);
  });

  it("starts, resolves and cancels pending changes while preserving another tenant's canonical plan", async () => {
    records.set(ownerId, { ...records.get(ownerId), rownd_pending_verification: [pending("other-plan", "other")] });
    await startPendingEmailVerification({ userId: externalId, recipeUserId, email: "next@example.com",
      tenantId: "public", pendingVerificationId: "new-plan", initiatingSessionHandle: "session" });
    expect(records.get(ownerId)?.rownd_pending_verification).toEqual([
      expect.objectContaining({ id: "other-plan", tenantId: "other" }), expect.objectContaining({ id: "new-plan" }),
    ]);
    vi.spyOn(Session, "getSessionInformation").mockResolvedValue({
      sessionHandle: "session", userId: externalId, tenantId: "public",
    } as any);
    const session = { getHandle: () => "session", getUserId: () => externalId, getTenantId: () => "public" } as any;
    expect(await resolvePendingEmailVerificationToken({ token: "token", queryPendingVerificationId: "new-plan", tenantId: "public", session })).toMatchObject({ status: "OK" });
    expect(await resolvePendingEmailVerificationToken({ token: "token", queryPendingVerificationId: "other-plan", tenantId: "public", session })).toMatchObject({ status: "INVALID_PENDING" });
    await startPendingEmailVerification({ userId: externalId, recipeUserId, email: "old@example.com",
      tenantId: "public", pendingVerificationId: "cancel", initiatingSessionHandle: "session" });
    expect(records.get(ownerId)?.rownd_pending_verification).toEqual([expect.objectContaining({ id: "other-plan", tenantId: "other" })]);
  });

  it("removes a failed send's canonical pending entry without resurrecting legacy plans", async () => {
    records.set(externalId, { rownd_pending_verification: [pending("old-plan"), pending("other-plan", "other")] });
    records.set(ownerId, { ...records.get(ownerId), rownd_pending_verification: [pending("other-plan", "other")] });
    vi.mocked(EmailVerification.sendEmailVerificationEmail).mockRejectedValue(new Error("delivery failed"));
    await expect(startPendingEmailVerification({ userId: externalId, recipeUserId, email: "next@example.com",
      tenantId: "public", pendingVerificationId: "new-plan", initiatingSessionHandle: "session" })).rejects.toThrow("delivery failed");
    expect(records.get(ownerId)?.rownd_pending_verification).toEqual([expect.objectContaining({ id: "other-plan" })]);
    expect((await getCombinedUserMetadata(externalId)).rownd_pending_verification).toEqual([expect.objectContaining({ id: "other-plan" })]);
  });

  it("preserves internal pointer and name authority when both rows are populated", async () => {
    records.set(ownerId, { ...records.get(ownerId), rownd_email_recipe_user_ids: { public: ownerId } });
    records.set(externalId, { first_name: "Conflicting name", rownd_email_recipe_user_ids: { public: "passwordless" } });
    expect((await getUserById(externalId)).data).toMatchObject({ email: "old@example.com", first_name: "Old name" });
  });

  it("does not fill missing tenant pointers or use a scalar when an internal scoped map exists", async () => {
    records.set(ownerId, { ...records.get(ownerId), rownd_email_recipe_user_ids: {} });
    records.set(externalId, { rownd_email_recipe_user_id: "passwordless", rownd_email_recipe_user_ids: { public: "passwordless" } });
    expect((await getUserById(externalId)).data.email).toBe("old@example.com");
  });

  it("does not replay external pending plans without internal authority", async () => {
    records.set(externalId, { rownd_pending_verification: [pending("legacy")] });
    expect((await getCombinedUserMetadata(externalId)).rownd_pending_verification).toBeUndefined();
  });

  it("blocks ambiguous external committing state before sending or mutating credentials", async () => {
    records.set(externalId, { rownd_pending_verification: [{ ...pending("legacy"), status: "COMMITTING", targetCanonicalRecipeUserId: "passwordless", retiredMethods: [] }] });
    await expect(startPendingEmailVerification({ userId: externalId, recipeUserId, email: "next@example.com",
      tenantId: "public", pendingVerificationId: "new-plan", initiatingSessionHandle: "session" })).rejects.toThrow("reconciliation");
    expect(EmailVerification.sendEmailVerificationEmail).not.toHaveBeenCalled();
    expect(UserMetadata.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("never resurrects external committing state after internal operational writes, even if pending is absent", async () => {
    records.set(externalId, { rownd_pending_verification: [{ ...pending("stale"), status: "COMMITTING" }] });
    await updatePrimaryUserMetadata(externalId, { rownd_pending_verification: [] });
    delete records.get(ownerId)!.rownd_pending_verification;
    await startPendingEmailVerification({ userId: externalId, recipeUserId, email: "next@example.com",
      tenantId: "public", pendingVerificationId: "new-plan", initiatingSessionHandle: "session" });
    expect(records.get(ownerId)?.rownd_pending_verification).toEqual([expect.objectContaining({ id: "new-plan" })]);
  });
});

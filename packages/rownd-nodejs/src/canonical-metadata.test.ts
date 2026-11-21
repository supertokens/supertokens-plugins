import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SuperTokens from "supertokens-node";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import { getPluginConfig, resolvePluginConfigSnapshot, setPluginConfig } from "./config";
import { init } from "./plugin";
import { ProfileReadOperation } from "./profile-read";
import {
  buildConfiguredSessionClaims,
  buildRowndOAuthPayload,
  buildRowndOAuthUserInfo,
  buildRowndSessionClaimPayload,
  buildRowndUserMetadata,
  combineLinkedMetadata,
  getAuthoritativeProfileFields,
  getCanonicalPresentationMetadata,
  getRawUserMetadata,
  getRowndProfileData,
  inspectUserPresentationMetadata,
  isInternalMetadataField,
  mergeMissingProfileMetadata,
  ROWND_APP_VARIANTS_KEY,
  ROWND_PROFILE_AUTHORITY_PREFIX,
  updatePrimaryUserMetadata,
  updateUserPresentationMetadata,
  type RowndMetadata,
  type SuperTokensUser,
} from "./rownd-compatibility";
import { assembleUserProfile } from "./supertokens-repository";
import type { RowndPluginConfig } from "./types";
import type { JsonRecord } from "./utils";

const initialConfig = getPluginConfig();

function configure(metadataMode?: RowndPluginConfig["metadataMode"]) {
  init({ disableRowndUserMigration: true, metadataMode });
}

function makeUser(id = "sdk-owner"): SuperTokensUser {
  return {
    id, isPrimaryUser: true, timeJoined: 1000, tenantIds: ["public", "other"],
    emails: ["core@example.com"], phoneNumbers: [],
    loginMethods: [{
      recipeUserId: SuperTokens.convertToRecipeUserId("recipe"),
      recipeId: "passwordless", email: "core@example.com", verified: true,
      timeJoined: 1000, tenantIds: ["public", "other"],
      hasSameEmailAs: (email: string) => email === "core@example.com",
      hasSamePhoneNumberAs: () => false,
    }],
  } as unknown as SuperTokensUser;
}

afterEach(() => {
  vi.restoreAllMocks();
  setPluginConfig(initialConfig!);
});

describe("static presentation metadata configuration", () => {
  it("defaults to compatibility", () => {
    configure();
    expect(getPluginConfig()?.metadataMode).toBe("compatibility");
  });

  it.each(["canonical", "compatibility"] as const)("normalizes explicit %s mode", (mode) => {
    configure(mode);
    expect(getPluginConfig()?.metadataMode).toBe(mode);
  });

  it.each([undefined, false])("rejects canonical mode with credentials unless migration is explicitly disabled: %j", (disableRowndUserMigration) => {
    expect(() => init({ metadataMode: "canonical", disableRowndUserMigration,
      rowndAppKey: "key", rowndAppSecret: "secret", rowndAppId: "app",
    })).toThrow("canonical metadata mode requires Rownd user migration to be disabled");
  });

  it("accepts canonical mode with credentials when migration is explicitly disabled", () => {
    init({ metadataMode: "canonical", disableRowndUserMigration: true,
      rowndAppKey: "key", rowndAppSecret: "secret", rowndAppId: "app",
    });
    expect(getPluginConfig()).toMatchObject({ metadataMode: "canonical", disableRowndUserMigration: true });
  });

  it.each([undefined, "compatibility"] as const)("retains migration-enabled legacy configuration in mode %s", (metadataMode) => {
    init({ metadataMode, rowndAppKey: "key", rowndAppSecret: "secret", rowndAppId: "app" });
    expect(getPluginConfig()).toMatchObject({ metadataMode: "compatibility", disableRowndUserMigration: false });
  });

  it.each(["auto", "", null, true, 1, {}])("rejects invalid mode %j", (mode) => {
    expect(() => configure(mode as RowndPluginConfig["metadataMode"]))
      .toThrow("metadataMode must be compatibility or canonical");
  });

  it("does not permit dynamic config to change the static mode", async () => {
    init({ disableRowndUserMigration: true, metadataMode: "canonical",
      resolveConfig: async () => ({ metadataMode: "compatibility", appConfig: { id: "dynamic" } }),
    });
    const resolved = await resolvePluginConfigSnapshot(getPluginConfig()!, { userContext: {} });
    expect(resolved.config.metadataMode).toBe("canonical");
    expect(resolved.config.appConfig?.id).toBe("dynamic");
  });
});

describe("canonical presentation resolver and writer", () => {
  let records: Map<string, JsonRecord>;
  let user: SuperTokensUser;

  beforeEach(() => {
    configure("canonical");
    user = makeUser();
    records = new Map([
      ["sdk-owner", { custom: "canonical" }],
      ["internal-owner", { custom: "internal", original_rownd_user: { data: { user_id: "legacy" } } }],
      ["recipe", { custom: "recipe" }],
    ]);
    vi.spyOn(SuperTokens, "getUser").mockImplementation(async (id) =>
      ["sdk-owner", "internal-owner", "recipe"].includes(id) ? user : undefined);
    vi.spyOn(SuperTokens, "getUserIdMapping").mockImplementation(async () => {
      throw new Error("canonical presentation must not discover mappings");
    });
    vi.spyOn(UserMetadata, "getUserMetadata").mockImplementation(async (id) => ({
      status: "OK", metadata: structuredClone(records.get(id) ?? {}),
    }));
    vi.spyOn(UserMetadata, "updateUserMetadata").mockImplementation(async (id, patch) => {
      const metadata = { ...records.get(id), ...patch };
      for (const key of Object.keys(metadata)) if (metadata[key] === null) delete metadata[key];
      records.set(id, metadata);
      return { status: "OK", metadata };
    });
  });

  async function commitSecondWriteFirst(firstPatch: JsonRecord, secondPatch: JsonRecord) {
    const applyPatch = vi.mocked(UserMetadata.updateUserMetadata).getMockImplementation()!;
    let firstArrived!: () => void;
    let releaseFirst!: () => void;
    const arrived = new Promise<void>((resolve) => { firstArrived = resolve; });
    const release = new Promise<void>((resolve) => { releaseFirst = resolve; });
    vi.mocked(UserMetadata.updateUserMetadata).mockImplementationOnce(async (...args) => {
      firstArrived();
      await release;
      return applyPatch(...args);
    });
    const first = updateUserPresentationMetadata("recipe", firstPatch);
    await arrived;
    await updateUserPresentationMetadata("recipe", secondPatch);
    releaseFirst();
    await first;
    return records.get("sdk-owner")! as RowndMetadata;
  }

  it.each(["sdk-owner", "internal-owner", "recipe"])("reads one literal SDK address for selector %s", async (selector) => {
    const context = { marker: "context" };
    expect(await inspectUserPresentationMetadata(selector, context)).toEqual({
      user, combinedMetadata: { custom: "canonical" },
    });
    expect(vi.mocked(SuperTokens.getUser).mock.calls).toEqual([[selector, context]]);
    expect(vi.mocked(UserMetadata.getUserMetadata).mock.calls).toEqual([["sdk-owner", context]]);
    expect(SuperTokens.getUserIdMapping).not.toHaveBeenCalled();
  });

  it("also reads an unmapped user's literal address", async () => {
    user = makeUser("internal-owner");
    const result = await inspectUserPresentationMetadata("recipe");
    expect(result.combinedMetadata.custom).toBe("internal");
    expect(vi.mocked(UserMetadata.getUserMetadata).mock.calls).toEqual([["internal-owner", undefined]]);
    expect(SuperTokens.getUserIdMapping).not.toHaveBeenCalled();
  });

  it("uses a provided current snapshot without another user lookup", async () => {
    const operation = new ProfileReadOperation();
    await inspectUserPresentationMetadata("recipe", {}, user, operation.read);
    expect(operation.counts).toMatchObject({ user: 0, mapping: 0, metadata: 1 });
    expect(SuperTokens.getUser).not.toHaveBeenCalled();
    expect(vi.mocked(UserMetadata.getUserMetadata).mock.calls).toEqual([["sdk-owner", {}]]);
  });

  it("reports exactly one user and one metadata read at the profile boundary", async () => {
    const operation = new ProfileReadOperation();
    await inspectUserPresentationMetadata("recipe", {}, undefined, operation.read);
    expect(operation.counts).toEqual({ user: 1, mapping: 0, metadata: 1, sessionList: 0, sessionDetail: 0 });
  });

  it.each([undefined, {}])("keeps missing or empty canonical records empty: %j", async (metadata) => {
    if (metadata) records.set("sdk-owner", metadata);
    else records.delete("sdk-owner");
    expect((await inspectUserPresentationMetadata("recipe")).combinedMetadata).toEqual({});
    expect(UserMetadata.getUserMetadata).toHaveBeenCalledTimes(1);
    expect(SuperTokens.getUserIdMapping).not.toHaveBeenCalled();
  });

  it("never follows references for a missing current user", async () => {
    records.set("retired", { rownd_migration_target: "sdk-owner", custom: "orphan" });
    expect(await inspectUserPresentationMetadata("retired")).toEqual({ user: undefined, combinedMetadata: {} });
    expect(UserMetadata.getUserMetadata).not.toHaveBeenCalled();
    expect(SuperTokens.getUser).toHaveBeenCalledTimes(1);
  });

  it("propagates metadata errors without fallback", async () => {
    const error = new Error("metadata unavailable");
    vi.mocked(UserMetadata.getUserMetadata).mockRejectedValue(error);
    await expect(inspectUserPresentationMetadata("recipe")).rejects.toBe(error);
    expect(UserMetadata.getUserMetadata).toHaveBeenCalledTimes(1);
    expect(SuperTokens.getUserIdMapping).not.toHaveBeenCalled();
  });

  it("propagates current-user lookup errors", async () => {
    const error = new Error("user unavailable");
    vi.mocked(SuperTokens.getUser).mockRejectedValue(error);
    await expect(inspectUserPresentationMetadata("recipe")).rejects.toBe(error);
    expect(UserMetadata.getUserMetadata).not.toHaveBeenCalled();
  });

  it.each([null, {}, { nested: null }, undefined])("maintains authority for a real custom patch %j", async (value) => {
    records.set("sdk-owner", {
      rownd_profile_authoritative_fields: ["deleted"],
      custom: { old: true },
      original_rownd_user: { data: { user_id: "legacy", deleted: "old", custom: { resurrected: true } } },
    });
    const result = await updateUserPresentationMetadata("recipe", { custom: value });
    expect(result.primaryUserId).toBe("sdk-owner");
    expect(result.sdkUserId).toBe("sdk-owner");
    expect(getAuthoritativeProfileFields(result.metadata)).toEqual(["deleted", "custom"]);
    expect(result.metadata.rownd_profile_authoritative_fields).toEqual(["deleted"]);
    expect(getRowndProfileData(result.metadata).deleted).toBeUndefined();
    expect(getRowndProfileData(result.metadata).custom).toEqual(value === null ? undefined : value);
    expect(vi.mocked(UserMetadata.updateUserMetadata).mock.calls).toEqual([["sdk-owner", {
      custom: value, [`${ROWND_PROFILE_AUTHORITY_PREFIX}custom`]: true,
    }, undefined]]);
    expect(records.get("recipe")?.custom).toBe("recipe");
    expect(UserMetadata.getUserMetadata).not.toHaveBeenCalled();
    expect(SuperTokens.getUserIdMapping).not.toHaveBeenCalled();
  });

  it("ignores caller authority and excludes identity fields from authority", async () => {
    records.set("sdk-owner", { rownd_profile_authoritative_fields: ["retained"],
      [`${ROWND_PROFILE_AUTHORITY_PREFIX}deleted`]: true });
    await updateUserPresentationMetadata("recipe", {
      rownd_profile_authoritative_fields: ["forged"], user_id: "not-authority", custom: "new",
      [`${ROWND_PROFILE_AUTHORITY_PREFIX}forged`]: true,
      [`${ROWND_PROFILE_AUTHORITY_PREFIX}deleted`]: null,
      [ROWND_APP_VARIANTS_KEY]: { public: ["forged"] },
    });
    expect(getAuthoritativeProfileFields(records.get("sdk-owner")!)).toEqual(["retained", "deleted", "custom"]);
    expect(records.get("sdk-owner")?.rownd_profile_authoritative_fields).toEqual(["retained"]);
    expect(records.get("sdk-owner")).not.toHaveProperty(ROWND_APP_VARIANTS_KEY);
  });

  it("does not apply marker authority from other addresses when projecting the literal destination", async () => {
    records.set("sdk-owner", {
      original_rownd_user: { data: { user_id: "legacy", first_name: "Original", last_name: "Deleted" } },
      [`${ROWND_PROFILE_AUTHORITY_PREFIX}last_name`]: true,
    });
    records.set("internal-owner", { [`${ROWND_PROFILE_AUTHORITY_PREFIX}first_name`]: true });
    records.set("recipe", { [`${ROWND_PROFILE_AUTHORITY_PREFIX}first_name`]: true });
    const { combinedMetadata } = await inspectUserPresentationMetadata("recipe");
    expect(getAuthoritativeProfileFields(combinedMetadata)).toEqual(["last_name"]);
    expect(getRowndProfileData(combinedMetadata)).toEqual({ user_id: "legacy", first_name: "Original" });
  });

  it("rejects public writes for missing current users instead of creating orphan metadata", async () => {
    await expect(updateUserPresentationMetadata("retired", { custom: "new" })).rejects.toThrow("User not found");
    expect(UserMetadata.updateUserMetadata).not.toHaveBeenCalled();
    expect(UserMetadata.getUserMetadata).not.toHaveBeenCalled();
  });

  it("does not read or replace shared authority before writing", async () => {
    vi.mocked(UserMetadata.getUserMetadata).mockRejectedValue(new Error("read failed"));
    await expect(updateUserPresentationMetadata("recipe", { custom: null })).resolves.toMatchObject({
      metadata: { [`${ROWND_PROFILE_AUTHORITY_PREFIX}custom`]: true },
    });
    expect(UserMetadata.getUserMetadata).not.toHaveBeenCalled();
  });

  it.each([false, true])("retains independent deletion and edit authority across overlapping calls (delete commits last=%s)", async (deleteCommitsLast) => {
    records.set("sdk-owner", { original_rownd_user: {
      data: { user_id: "legacy", first_name: "Old first", last_name: "Old last" },
    } });
    const deletion = { first_name: null };
    const edit = { last_name: "New last" };
    const metadata = await commitSecondWriteFirst(deleteCommitsLast ? deletion : edit,
      deleteCommitsLast ? edit : deletion);
    expect(new Set(getAuthoritativeProfileFields(metadata))).toEqual(new Set(["first_name", "last_name"]));
    expect(getRowndProfileData(metadata)).toEqual({ user_id: "legacy", last_name: "New last" });
    expect(metadata[`${ROWND_PROFILE_AUTHORITY_PREFIX}first_name`]).toBe(true);
    expect(metadata[`${ROWND_PROFILE_AUTHORITY_PREFIX}last_name`]).toBe(true);
    expect(metadata.rownd_profile_authoritative_fields).toBeUndefined();
    expect(UserMetadata.getUserMetadata).not.toHaveBeenCalled();
    for (const [, patch] of vi.mocked(UserMetadata.updateUserMetadata).mock.calls) {
      expect(patch.rownd_profile_authoritative_fields).toBeUndefined();
    }
  });

  it.each([null, "Restored", { replacement: true }, {}])("keeps same-field authority coherent with the last applied Core patch %j", async (lastValue) => {
    records.set("sdk-owner", { original_rownd_user: { data: { user_id: "legacy", custom: "Original" } } });
    const metadata = await commitSecondWriteFirst({ custom: lastValue }, { custom: "Intermediate" });
    expect(getAuthoritativeProfileFields(metadata)).toEqual(["custom"]);
    expect(getRowndProfileData(metadata).custom).toEqual(lastValue === null ? undefined : lastValue);
    expect(metadata[`${ROWND_PROFILE_AUTHORITY_PREFIX}custom`]).toBe(true);
  });

  it.each(["", "名:👩🏽‍💻", " spaces ", "rownd_profile_authority", "rownd_profile_authorityish:key", "__proto__"])("encodes exact arbitrary public field names without ambiguity: %j", async (field) => {
    records.set("sdk-owner", { original_rownd_user: { data: { user_id: "legacy", [field]: "Old" } } });
    const result = await updateUserPresentationMetadata("recipe", { [field]: null });
    expect(getAuthoritativeProfileFields(result.metadata)).toEqual([field]);
    expect(result.metadata[`${ROWND_PROFILE_AUTHORITY_PREFIX}${field}`]).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(getRowndProfileData(result.metadata), field)).toBe(false);
    expect(isInternalMetadataField(field)).toBe(false);
  });

  it("propagates write errors", async () => {
    vi.mocked(UserMetadata.updateUserMetadata).mockRejectedValue(new Error("write failed"));
    await expect(updateUserPresentationMetadata("recipe", { custom: {} })).rejects.toThrow("write failed");
  });

  it("leaves literal raw reads and legacy lifecycle writers unchanged in canonical mode", async () => {
    expect((await getRawUserMetadata("internal-owner")).custom).toBe("internal");
    vi.mocked(SuperTokens.getUserIdMapping).mockResolvedValue({
      status: "OK", superTokensUserId: "internal-owner", externalUserId: "sdk-owner", externalUserIdInfo: undefined,
    });
    await updatePrimaryUserMetadata("recipe", { rownd_pending_verification: [] });
    expect(records.get("internal-owner")?.rownd_pending_verification).toEqual([]);
    expect(records.get("sdk-owner")?.rownd_pending_verification).toBeUndefined();
  });

  it.each([undefined, "compatibility"] as const)("preserves legacy resolver and writer addresses in mode %s", async (mode) => {
    configure(mode);
    vi.mocked(SuperTokens.getUserIdMapping).mockResolvedValue({
      status: "OK", superTokensUserId: "internal-owner", externalUserId: "sdk-owner", externalUserIdInfo: undefined,
    });
    expect((await inspectUserPresentationMetadata("recipe")).combinedMetadata.custom).toBe("internal");
    const result = await updateUserPresentationMetadata("recipe", { custom: "edited" });
    expect(result).toMatchObject({ primaryUserId: "internal-owner", sdkUserId: "sdk-owner" });
    expect(records.get("internal-owner")?.custom).toBe("edited");
    expect(records.get("sdk-owner")?.custom).toBe("canonical");
  });

  it("preserves the requested legacy writer ID for missing users", async () => {
    configure();
    const result = await updateUserPresentationMetadata("retired", { custom: "legacy" });
    expect(result).toMatchObject({ primaryUserId: "retired", sdkUserId: "retired" });
  });

  it.each(["payload", "userinfo"])("OAuth %s uses the provided user and one literal metadata read", async (builder) => {
    records.set("sdk-owner", { original_rownd_user: {
      data: { user_id: "legacy", first_name: "Published" },
    } });
    const result = builder === "payload"
      ? await buildRowndOAuthPayload({ user, scopes: ["profile"] })
      : await buildRowndOAuthUserInfo({ user, scopes: ["profile"], accessTokenPayload: {} });
    expect(result).toMatchObject({ given_name: "Published" });
    expect(SuperTokens.getUser).not.toHaveBeenCalled();
    expect(vi.mocked(UserMetadata.getUserMetadata).mock.calls).toEqual([["sdk-owner", undefined]]);
    expect(SuperTokens.getUserIdMapping).not.toHaveBeenCalled();
  });
});

describe("pure canonical presentation publication", () => {
  it("retains primary authority markers in offline publication without accepting alias authority", () => {
    configure("canonical");
    const deletedMarker = `${ROWND_PROFILE_AUTHORITY_PREFIX}first_name`;
    const forgedMarker = `${ROWND_PROFILE_AUTHORITY_PREFIX}last_name`;
    const primary: RowndMetadata = {
      [deletedMarker]: true,
      original_rownd_user: { data: { user_id: "legacy", first_name: "Deleted", last_name: "Original" },
        state: "enabled", auth_level: "guest", verified_data: {} },
    };
    const alias: RowndMetadata = { [forgedMarker]: true, first_name: "Alias",
      [ROWND_APP_VARIANTS_KEY]: { public: ["alias"] } };
    const combined = combineLinkedMetadata({ primaryUserId: "owner", primaryMetadata: primary,
      linkedMetadata: [{ userId: "alias", metadata: alias }] }).combinedMetadata;
    expect(combined[forgedMarker]).toBeUndefined();
    expect(combined[ROWND_APP_VARIANTS_KEY]).toBeUndefined();
    expect(getRowndProfileData(combined)).toEqual({ user_id: "legacy", last_name: "Original" });
    const canonical = getCanonicalPresentationMetadata(combined);
    expect(canonical[deletedMarker]).toBe(true);
    expect(getAuthoritativeProfileFields(canonical)).toEqual(["first_name"]);
    expect(getRowndProfileData(canonical)).toEqual(getRowndProfileData(combined));
    expect(mergeMissingProfileMetadata(primary, alias)[forgedMarker]).toBeUndefined();
    expect(mergeMissingProfileMetadata({}, alias)[forgedMarker]).toBeUndefined();
    expect(mergeMissingProfileMetadata({}, alias)[ROWND_APP_VARIANTS_KEY]).toBeUndefined();
  });

  it("keeps reserved keys internal at import, profile and OAuth/configured-claim boundaries", async () => {
    configure("canonical");
    const marker = `${ROWND_PROFILE_AUTHORITY_PREFIX}first_name`;
    const nestedMarker = `${ROWND_PROFILE_AUTHORITY_PREFIX}${marker}`;
    const source: RowndMetadata = {
      [marker]: true, [nestedMarker]: true,
      [ROWND_APP_VARIANTS_KEY]: { public: [] },
      [`${ROWND_PROFILE_AUTHORITY_PREFIX}${ROWND_APP_VARIANTS_KEY}`]: true,
      [`${ROWND_PROFILE_AUTHORITY_PREFIX}email`]: true,
      [`${ROWND_PROFILE_AUTHORITY_PREFIX}ignored`]: "true",
      original_rownd_user: {
        data: { user_id: "legacy", first_name: "Deleted", [marker]: true, [ROWND_APP_VARIANTS_KEY]: "legacy" },
        meta: { [marker]: true, [ROWND_APP_VARIANTS_KEY]: "legacy" },
        state: "enabled", auth_level: "guest", verified_data: {},
      },
    };
    expect(isInternalMetadataField(marker)).toBe(true);
    expect(isInternalMetadataField(ROWND_PROFILE_AUTHORITY_PREFIX)).toBe(true);
    expect(getAuthoritativeProfileFields(source)).toEqual(["first_name"]);
    const imported = buildRowndUserMetadata(source.original_rownd_user!);
    expect(imported[marker]).toBeUndefined();
    expect(imported[ROWND_APP_VARIANTS_KEY]).toBeUndefined();
    const config = { ...getPluginConfig()!, schema: { [marker]: {
      display_name: "Private", type: "boolean", user_visible: true,
      include_in_session_claims: true, session_claim_name: "public_claim",
    }, [ROWND_APP_VARIANTS_KEY]: {
      display_name: "Variants", type: "string", user_visible: true,
      include_in_session_claims: true, session_claim_name: "variants_claim",
    } } };
    expect(buildConfiguredSessionClaims(source, config)).toEqual({});
    const profile = assembleUserProfile("sdk-owner", "public", makeUser(), source, config, "profile");
    expect(profile.data[marker]).toBeUndefined();
    expect(profile.meta[marker]).toBeUndefined();
    expect(profile.meta[nestedMarker]).toBeUndefined();
    expect(profile.data).not.toHaveProperty(ROWND_APP_VARIANTS_KEY);
    expect(profile.meta).not.toHaveProperty(ROWND_APP_VARIANTS_KEY);
    expect(profile.data.first_name).toBeUndefined();
    setPluginConfig(config);
    vi.spyOn(UserMetadata, "getUserMetadata").mockResolvedValue({ status: "OK", metadata: source });
    const payload = await buildRowndOAuthPayload({ user: makeUser(), scopes: ["profile"] });
    const userinfo = await buildRowndOAuthUserInfo({ user: makeUser(), scopes: ["profile"], accessTokenPayload: {} });
    for (const result of [payload, userinfo]) {
      expect(result).not.toHaveProperty(marker);
      expect(result).not.toHaveProperty(nestedMarker);
      expect(result).not.toHaveProperty("public_claim");
      expect(result).not.toHaveProperty("variants_claim");
      expect(result).not.toHaveProperty("given_name");
    }
  });

  it("preserves the existing exclusion of internal claim sources even when renamed to public claims", () => {
    const internalKeys = [
      "original_rownd_user", "rownd_profile_authoritative_fields", "rownd_email_metadata_version",
      "rownd_email_recipe_user_id", "rownd_email_recipe_user_ids",
      "rownd_migration_placeholder_provenance_override", "rownd_migration_complete",
      "rownd_migration_email_retirements", "rownd_migration_provider_retirements",
      "rownd_migration_provider_introductions", "rownd_migration_provider_introduction",
      "rownd_pending_verification", "rownd_migration_superseded", "rownd_migration_target",
      "rownd_migration_canonical_target", "rownd_migration_reconciliation",
      "rownd_migration_owner_consolidation", "rownd_migration_owner_recovery",
      "rownd_migration_admin_donor_sessions", "rownd_migration_mapping_publication",
    ];
    const schema = Object.fromEntries(internalKeys.map((key, index) => [key, {
      display_name: key, type: "object", user_visible: false,
      include_in_session_claims: true, session_claim_name: `public_name_${index}`,
    }]));
    init({ disableRowndUserMigration: true, schema });
    const source = Object.fromEntries(internalKeys.filter((key) => key !== "original_rownd_user")
      .map((key) => [key, { raw: "checkpoint" }])) as RowndMetadata;
    source.original_rownd_user = {
      data: { user_id: "legacy", ...Object.fromEntries(internalKeys.map((key) => [key, "original raw"])) },
      state: "enabled", auth_level: "guest", verified_data: {},
    };
    expect(buildConfiguredSessionClaims(source, getPluginConfig())).toEqual({});
    expect(buildConfiguredSessionClaims(getCanonicalPresentationMetadata(source), getPluginConfig())).toEqual({});
  });

  it("preserves literal public null versus absence without applying SDK deletion semantics", () => {
    const source: RowndMetadata = {
      literal_null: null, nested: { present: null },
      rownd_profile_authoritative_fields: ["literal_null", "absent"],
      original_rownd_user: { data: { user_id: "legacy", literal_null: "old", absent: "old" },
        state: "enabled", auth_level: "guest", verified_data: {} },
    };
    const canonical = getCanonicalPresentationMetadata(source);
    expect(Object.prototype.hasOwnProperty.call(canonical, "literal_null")).toBe(true);
    expect(canonical.literal_null).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(canonical, "absent")).toBe(false);
    expect(canonical.nested).toEqual({ present: null });
    expect(getRowndProfileData(canonical)).toEqual({ user_id: "legacy", literal_null: null });
    expect(getRowndProfileData(canonical)).toEqual(getRowndProfileData(source));
  });

  it("preserves complete presentation inputs and standalone projection parity", async () => {
    configure();
    const combined = combineLinkedMetadata({
      primaryUserId: "internal-owner",
      primaryMetadata: {
        custom: { current: true }, first_name: "Current", deleted: undefined,
        rownd_profile_authoritative_fields: ["first_name", "deleted", "settings"],
        settings: { replaced: true }, rownd_email_metadata_version: 1,
        rownd_email_recipe_user_id: "recipe", rownd_email_recipe_user_ids: {},
        rownd_pending_verification: [], rownd_migration_complete: true,
        rownd_migration_owner_consolidation: { version: "operational" },
      },
      linkedMetadata: [{ userId: "alias", metadata: {
        custom: { legacy: true }, arbitrary: ["custom"],
        original_rownd_user: {
          data: { user_id: "legacy", anonymous_id: "anon", first_name: "Old", last_name: "Family",
            deleted: "stale", settings: { stale: true }, email: "original@example.com", updated_at: "yesterday" },
          state: "disabled", auth_level: "guest", verified_data: { email: true, phone_number: true },
          groups: [{ id: "group" }], attributes: { "rownd:app_variants": ["variant"],
            "rownd:app_variants_by_tenant": { other: ["variant"] }, custom: "attribute" },
          meta: { last_sign_in: "operational history" }, security: { token_cutoff: 123 },
        },
        rownd_migration_provider_retirements: { secret: true },
      } }],
    }).combinedMetadata;
    const before = structuredClone(combined);
    const canonical = getCanonicalPresentationMetadata(combined);
    const config = { ...getPluginConfig()!, schema: {
      first_name: { display_name: "Name", type: "string", user_visible: true, include_in_session_claims: true },
      settings: { display_name: "Settings", type: "object", user_visible: true, include_in_session_claims: true },
      deleted: { display_name: "Deleted", type: "string", user_visible: true, include_in_session_claims: true },
    } };
    const user = makeUser();
    expect(canonical.custom).toEqual({ current: true, legacy: true });
    expect(canonical.arbitrary).toEqual(["custom"]);
    expect(canonical.rownd_email_recipe_user_ids).toEqual({});
    expect(canonical.rownd_email_recipe_user_id).toBe("recipe");
    expect(canonical.rownd_email_metadata_version).toBe(1);
    expect(canonical.rownd_profile_authoritative_fields).toEqual(["first_name", "deleted", "settings"]);
    expect(canonical.original_rownd_user).toEqual(Object.fromEntries(Object.entries(combined.original_rownd_user!)
      .filter(([key]) => !["meta", "security"].includes(key))));
    for (const tenant of ["public", "other"]) {
      expect(assembleUserProfile(user.id, tenant, user, canonical, config, "profile"))
        .toEqual(assembleUserProfile(user.id, tenant, user, combined, config, "profile"));
    }
    expect(buildConfiguredSessionClaims(canonical, config)).toEqual(buildConfiguredSessionClaims(combined, config));
    expect(buildRowndSessionClaimPayload({ userId: user.id, user, metadata: canonical, pluginConfig: config }))
      .toEqual(buildRowndSessionClaimPayload({ userId: user.id, user, metadata: combined, pluginConfig: config }));
    expect(getRowndProfileData(canonical)).toEqual(getRowndProfileData(combined));
    vi.spyOn(SuperTokens, "getUserIdMapping").mockResolvedValue({ status: "UNKNOWN_MAPPING_ERROR" });
    let literalMetadata = combined;
    const readMetadata = vi.spyOn(UserMetadata, "getUserMetadata").mockImplementation(async (id) => ({
      status: "OK", metadata: id === user.id ? literalMetadata : {},
    }));
    const scopes = ["profile", "email", "phone"];
    const projectOAuth = () => Promise.all([
      buildRowndOAuthPayload({ user, scopes }),
      buildRowndOAuthUserInfo({ user, scopes, accessTokenPayload: {} }),
    ]);
    setPluginConfig(config);
    const compatibilityProjection = await projectOAuth();
    expect(readMetadata).toHaveBeenCalledWith("recipe", undefined);
    readMetadata.mockClear();
    literalMetadata = canonical;
    setPluginConfig({ ...config, metadataMode: "canonical" });
    expect(await projectOAuth()).toEqual(compatibilityProjection);
    expect(readMetadata.mock.calls).toEqual([[user.id, undefined], [user.id, undefined]]);
    expect(canonical.rownd_pending_verification).toBeUndefined();
    expect(canonical.rownd_migration_complete).toBeUndefined();
    expect(canonical.rownd_migration_owner_consolidation).toBeUndefined();
    expect(canonical.rownd_migration_provider_retirements).toBeUndefined();
    expect(combined).toEqual(before);
  });

  it("excludes every reserved operational field without inventing original data", () => {
    const metadata: RowndMetadata = Object.fromEntries([
      "rownd_migration_placeholder_provenance_override", "rownd_migration_complete",
      "rownd_migration_email_retirements", "rownd_migration_provider_retirements",
      "rownd_migration_provider_introductions", "rownd_migration_provider_introduction",
      "rownd_pending_verification", "rownd_migration_superseded", "rownd_migration_target",
      "rownd_migration_canonical_target", "rownd_migration_reconciliation",
      "rownd_migration_owner_consolidation", "rownd_migration_owner_recovery",
      "rownd_migration_admin_donor_sessions", "rownd_migration_mapping_publication",
    ].map((key) => [key, { excluded: true }]));
    expect(getCanonicalPresentationMetadata(metadata)).toEqual({});
    expect(getCanonicalPresentationMetadata({})).toEqual({});
  });
});

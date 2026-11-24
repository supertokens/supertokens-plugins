import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SuperTokens from "supertokens-node";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import Session from "supertokens-node/recipe/session";
import { getUserById, updateUserMetadata } from "./supertokens-repository";
import type { JsonRecord } from "./utils";

describe("public metadata no-op updates", () => {
  const ownerId = "owner";
  const externalId = "rownd-owner";
  const activity = {
    last_sign_in: "stored-sign-in",
    last_active: "stored-active",
    last_sign_in_method: "phone",
  };
  let records: Map<string, JsonRecord>;
  let mapped: boolean;
  let linked: boolean;
  const user = () => ({
    id: mapped ? externalId : ownerId,
    isPrimaryUser: linked,
    timeJoined: 1000,
    tenantIds: ["public"],
    emails: ["owner@example.com"],
    phoneNumbers: [],
    loginMethods: (linked ? [ownerId, "linked"] : [ownerId]).map((id) => ({
      recipeUserId: SuperTokens.convertToRecipeUserId(id),
      recipeId: "passwordless",
      email: "owner@example.com",
      tenantIds: ["public"],
      verified: true,
      timeJoined: 1000,
    })),
  }) as unknown as NonNullable<Awaited<ReturnType<typeof SuperTokens.getUser>>>;

  beforeEach(() => {
    mapped = false;
    linked = false;
    records = new Map([[ownerId, { custom: "stored", ...activity }]]);
    vi.spyOn(SuperTokens, "getUser").mockImplementation(async (id) =>
      id === ownerId || (mapped && id === externalId) || (linked && id === "linked")
        ? user() : undefined);
    vi.spyOn(SuperTokens, "getUserIdMapping").mockImplementation(async ({ userId, userIdType }) =>
      mapped && userId === (userIdType === "EXTERNAL" ? externalId : ownerId)
        ? { status: "OK", superTokensUserId: ownerId, externalUserId: externalId, externalUserIdInfo: undefined }
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
    vi.spyOn(Session, "getAllSessionHandlesForUser").mockResolvedValue([]);
    vi.spyOn(Session, "getSessionInformation").mockResolvedValue(undefined);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it.each([
    {},
    { last_sign_in: null },
    { last_active: "client-echo", last_sign_in_method: undefined },
    { last_sign_in: null, last_active: null, last_sign_in_method: null },
  ])("skips a patch with no writable keys: %j", async (input) => {
    const context = {};
    expect(await updateUserMetadata(ownerId, input, context)).toEqual({
      id: ownerId, meta: { custom: "stored", ...activity },
    });
    expect(SuperTokens.getUser).toHaveBeenCalledTimes(1);
    expect(SuperTokens.getUser).toHaveBeenCalledWith(ownerId, context);
    expect(SuperTokens.getUserIdMapping).toHaveBeenCalledTimes(2);
    expect(UserMetadata.getUserMetadata).toHaveBeenCalledTimes(1);
    expect(UserMetadata.getUserMetadata).toHaveBeenCalledWith(ownerId, context);
    expect(UserMetadata.updateUserMetadata).not.toHaveBeenCalled();
    expect(Session.getAllSessionHandlesForUser).not.toHaveBeenCalled();
    expect(Session.getSessionInformation).not.toHaveBeenCalled();
    expect(context).toEqual({});
  });

  it.each([false, true])("returns the writer's normalized live identity (mapped=%s)", async (isMapped) => {
    mapped = isMapped;
    linked = true;
    records.set("linked", { linkedCustom: true });
    if (mapped) records.set(externalId, { aliasCustom: true });
    const id = mapped ? externalId : ownerId;
    for (const selector of [ownerId, "linked", ...(mapped ? [externalId] : [])]) {
      expect(await updateUserMetadata(selector, {})).toEqual({
        id,
        meta: { custom: "stored", linkedCustom: true, ...(mapped ? { aliasCustom: true } : {}), ...activity },
      });
    }
    expect(UserMetadata.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("does not add the requested live linked selector to the normalized inspection", async () => {
    vi.mocked(SuperTokens.getUser).mockImplementation(async (id) =>
      [ownerId, "linked-selector"].includes(id) ? user() : undefined);
    records.set("linked-selector", { mustNotAppear: true });
    expect(await updateUserMetadata("linked-selector", {})).toEqual({
      id: ownerId, meta: { custom: "stored", ...activity },
    });
    expect(UserMetadata.getUserMetadata).toHaveBeenCalledTimes(1);
    expect(UserMetadata.getUserMetadata).toHaveBeenCalledWith(ownerId, undefined);
    expect(SuperTokens.getUser).toHaveBeenCalledTimes(1);
    expect(SuperTokens.getUser).toHaveBeenCalledWith("linked-selector", undefined);
  });

  it.each(["rownd_migration_target", "rownd_migration_canonical_target"])(
    "keeps a retired selector's response ID while following %s",
    async (pointer) => {
      mapped = true;
      records.set("retired", { [pointer]: ownerId, retiredCustom: true });
      expect(await updateUserMetadata("retired", {})).toEqual({
        id: "retired", meta: { custom: "stored", retiredCustom: true, ...activity },
      });
      expect(vi.mocked(SuperTokens.getUser).mock.calls.map(([id]) => id)).toEqual(["retired", ownerId]);
      const metadataIds = vi.mocked(UserMetadata.getUserMetadata).mock.calls.map(([id]) => id);
      expect(metadataIds).toHaveLength(3);
      expect(new Set(metadataIds)).toEqual(new Set(["retired", ownerId, externalId]));
      expect(UserMetadata.updateUserMetadata).not.toHaveBeenCalled();
    },
  );

  it.each(["orphan", "missing-reference", "cycle"])("preserves literal %s metadata", async (kind) => {
    records.set("missing", {
      custom: "literal", ...activity,
      ...(kind === "orphan" ? {} : { rownd_migration_target: "middle" }),
    });
    if (kind !== "orphan") records.set("middle", {
      rownd_migration_target: kind === "cycle" ? "missing" : "absent",
      mustNotAppear: true,
    });
    expect(await updateUserMetadata("missing", {})).toEqual({
      id: "missing", meta: { custom: "literal", ...activity },
    });
    const userIds = vi.mocked(SuperTokens.getUser).mock.calls.map(([id]) => id);
    const metadataIds = vi.mocked(UserMetadata.getUserMetadata).mock.calls.map(([id]) => id);
    expect(userIds.filter((id) => id === "missing")).toHaveLength(1);
    expect(metadataIds.filter((id) => id === "missing")).toHaveLength(1);
    expect(SuperTokens.getUserIdMapping).not.toHaveBeenCalled();
    expect(UserMetadata.updateUserMetadata).not.toHaveBeenCalled();
    await expect(getUserById("missing")).rejects.toThrow();
  });

  it("returns empty public metadata for a missing user with no literal record", async () => {
    expect(await updateUserMetadata("missing", {})).toEqual({ id: "missing", meta: {} });
    expect(SuperTokens.getUser).toHaveBeenCalledTimes(1);
    expect(UserMetadata.getUserMetadata).toHaveBeenCalledTimes(1);
    expect(UserMetadata.updateUserMetadata).not.toHaveBeenCalled();
  });

  it.each([undefined, null, {}])("writes a custom own key even when its value is %j", async (value) => {
    await updateUserMetadata(ownerId, { custom: value, last_active: null });
    expect(UserMetadata.updateUserMetadata).toHaveBeenCalledTimes(1);
    const [id, patch] = vi.mocked(UserMetadata.updateUserMetadata).mock.calls[0]!;
    expect(id).toBe(ownerId);
    expect(Object.prototype.hasOwnProperty.call(patch, "custom")).toBe(true);
    expect(patch.custom).toEqual(value);
    expect(patch).not.toHaveProperty("last_active");
    expect(records.get(ownerId)).toMatchObject(activity);
  });

  it("keeps creation and first-sign-in fields writable rather than treating a profile echo as empty", async () => {
    const input = { created: "created", first_sign_in: "first", first_sign_in_method: "email" };
    expect((await updateUserMetadata(ownerId, input)).meta).toMatchObject(input);
    expect(UserMetadata.updateUserMetadata).toHaveBeenCalledTimes(1);
  });

  it("preserves authoritative absence and nested replacement across a later no-op", async () => {
    mapped = true;
    records.set(externalId, { deleted: "stale", custom: { stale: true, keep: true } });
    await updateUserMetadata(externalId, { deleted: null, custom: { keep: false } });
    vi.mocked(UserMetadata.updateUserMetadata).mockClear();
    const response = await updateUserMetadata(externalId, { last_active: null });
    expect(response).toEqual({
      id: externalId, meta: { custom: { keep: false }, ...activity },
    });
    expect(records.get(ownerId)?.rownd_profile_authoritative_fields).toEqual(["deleted", "custom"]);
    expect(UserMetadata.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("does not carry no-op reads across calls sharing a caller context", async () => {
    const context = {};
    expect((await updateUserMetadata(ownerId, {}, context)).meta.custom).toBe("stored");
    records.set(ownerId, { custom: "changed" });
    expect((await updateUserMetadata(ownerId, {}, context)).meta.custom).toBe("changed");
    expect(UserMetadata.getUserMetadata).toHaveBeenCalledTimes(2);
  });

  it("propagates failures of metadata that remains necessary", async () => {
    vi.mocked(UserMetadata.getUserMetadata).mockRejectedValue(new Error("metadata unavailable"));
    await expect(updateUserMetadata(ownerId, {})).rejects.toThrow("metadata unavailable");
    expect(UserMetadata.updateUserMetadata).not.toHaveBeenCalled();
  });
});

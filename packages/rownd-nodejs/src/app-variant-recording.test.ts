import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SuperTokens from "supertokens-node";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import { getPluginConfig, setPluginConfig } from "./config";
import { ROWND_APP_VARIANTS_KEY } from "./rownd-compatibility";
import { buildRowndSessionAndAnonymousClaims, recordRowndAppVariantForUser } from "./supertokens-repository";
import type { RowndPluginNormalisedConfig } from "./types";
import type { JsonRecord } from "./utils";

describe("app variant recording", () => {
  const priorConfig = getPluginConfig();
  const config: RowndPluginNormalisedConfig = {
    rowndAppKey: "test",
    rowndAppSecret: "test",
    disableRowndUserMigration: true,
    subBrands: { added: { variant: { id: "added" } } },
    schema: {
      first_name: { display_name: "Name", type: "string", user_visible: true, owned_by: "user", include_in_session_claims: true },
    },
  };
  const primaryId = "internal-user";
  const sdkId = "rownd-user";
  const recipeId = "z-passwordless";
  const user = new SuperTokens.User({
    id: sdkId, isPrimaryUser: true, timeJoined: 1, tenantIds: ["public"],
    emails: ["user@example.com"], phoneNumbers: [], thirdParty: [], webauthn: [],
    loginMethods: [{
      recipeUserId: recipeId, recipeId: "passwordless", email: "user@example.com", tenantIds: ["public"],
      verified: true, timeJoined: 1,
    }],
  });
  const original = (variants: string[], firstName = "Current") => ({
    data: { user_id: sdkId, first_name: firstName },
    verified_data: { email: "user@example.com" },
    groups: [{ id: "group" }],
    attributes: { "rownd:app_variants": variants, custom: "retained" },
  });
  let records: Map<string, JsonRecord>;
  let userContext: { _default: { coreCallCache: Record<string, JsonRecord> } };
  const loadMetadata = vi.fn((id: string) => structuredClone(records.get(id) ?? {}));

  beforeEach(() => {
    setPluginConfig({ ...config, metadataMode: "compatibility" });
    records = new Map();
    userContext = { _default: { coreCallCache: {} } };
    loadMetadata.mockClear();
    vi.spyOn(SuperTokens, "getUser").mockResolvedValue(user);
    vi.spyOn(SuperTokens, "getUserIdMapping").mockImplementation(async ({ userId, userIdType }) =>
      userId === sdkId && userIdType === "EXTERNAL"
        ? { status: "OK", superTokensUserId: primaryId, externalUserId: sdkId }
        : { status: "UNKNOWN_MAPPING_ERROR" });
    vi.spyOn(UserMetadata, "getUserMetadata").mockImplementation(async (id, context) => {
      const cache = context?._default?.coreCallCache;
      if (cache && id in cache) return { status: "OK", metadata: cache[id] };
      const metadata = loadMetadata(id);
      if (context) {
        context._default = { ...context._default, coreCallCache: { ...cache, [id]: metadata } };
      }
      return { status: "OK", metadata };
    });
    vi.spyOn(UserMetadata, "updateUserMetadata").mockResolvedValue({ status: "OK", metadata: {} });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setPluginConfig(priorConfig as RowndPluginNormalisedConfig);
  });

  it("reads the linked write target fresh and appends without merging another row's metadata", async () => {
    const fresh = original(["existing"]);
    const cached = { original_rownd_user: original(["stale", "added"]) };
    const sharedCache = { [primaryId]: {}, [sdkId]: cached, [recipeId]: {
      original_rownd_user: { data: { user_id: sdkId }, attributes: { linked_only: true } },
    } };
    userContext._default.coreCallCache = sharedCache;
    records.set(sdkId, { original_rownd_user: fresh });
    loadMetadata.mockImplementationOnce((id) => {
      expect(userContext._default.coreCallCache).toBe(sharedCache);
      return structuredClone(records.get(id) ?? {});
    });

    await recordRowndAppVariantForUser(sdkId, "added", userContext);

    const reads = vi.mocked(UserMetadata.getUserMetadata).mock.calls;
    expect(reads.slice(0, 3)).toEqual([[primaryId, userContext], [sdkId, userContext], [recipeId, userContext]]);
    expect(reads).toHaveLength(4);
    const [readId, readContext] = reads[3]!;
    expect(readId).toBe(sdkId);
    expect(readContext).toBeDefined();
    expect(readContext).not.toBe(userContext);
    expect(readContext?._default?.coreCallCache).not.toBe(sharedCache);
    expect(loadMetadata.mock.calls).toEqual([[sdkId]]);
    expect(userContext._default.coreCallCache).toEqual({});
    expect(UserMetadata.updateUserMetadata).toHaveBeenCalledOnce();
    expect(UserMetadata.updateUserMetadata).toHaveBeenCalledWith(sdkId, {
      original_rownd_user: {
        ...fresh,
        attributes: { ...fresh.attributes, "rownd:app_variants": ["existing", "added"] },
      },
    }, userContext);
  });

  it("falls back to raw primary metadata when no row has a Rownd user ID", async () => {
    records.set(primaryId, { original_rownd_user: { data: { first_name: "Primary" } } });
    records.set(sdkId, { original_rownd_user: { attributes: { linked_only: true } } });

    await recordRowndAppVariantForUser(sdkId, "added", userContext, "tenant-a");

    expect(UserMetadata.updateUserMetadata).toHaveBeenCalledWith(primaryId, {
      original_rownd_user: {
        data: { first_name: "Primary" }, verified_data: {},
        attributes: { "rownd:app_variants_by_tenant": { "tenant-a": ["added"] } },
      },
    }, userContext);
  });

  it("retains the shared cache when the fresh metadata matches the inspected copy", async () => {
    const cached = { original_rownd_user: original(["added"]) };
    const sharedCache = { [primaryId]: {}, [sdkId]: cached, [recipeId]: {} };
    userContext._default.coreCallCache = sharedCache;
    records.set(sdkId, cached);

    await recordRowndAppVariantForUser(sdkId, "added", userContext);

    expect(UserMetadata.updateUserMetadata).not.toHaveBeenCalled();
    expect(loadMetadata.mock.calls).toEqual([[sdkId]]);
    expect(userContext._default.coreCallCache).toBe(sharedCache);
    expect(sharedCache[sdkId]).toBe(cached);
  });

  it.each(["added", "stale"])("refreshes compatibility claims without a write when the cached variant is %s", async (cachedVariant) => {
    userContext._default.coreCallCache = {
      [primaryId]: {}, [sdkId]: { original_rownd_user: original([cachedVariant], "Old") }, [recipeId]: {},
    };
    records.set(sdkId, { original_rownd_user: original(["added"], "New") });

    await recordRowndAppVariantForUser(sdkId, "added", userContext);

    expect(UserMetadata.updateUserMetadata).not.toHaveBeenCalled();
    expect(loadMetadata.mock.calls).toEqual([[sdkId]]);
    expect(userContext._default.coreCallCache).toEqual({});

    const { rowndSessionClaims } = await buildRowndSessionAndAnonymousClaims(
      sdkId, { rownd_session_authentication: "authenticated" }, "added", userContext, recipeId,
    );
    expect(rowndSessionClaims).toMatchObject({ first_name: "New", app_user_id: sdkId, auth_level: "verified" });
    expect(loadMetadata.mock.calls).toEqual([[sdkId], [primaryId], [sdkId], [recipeId]]);
  });

  it("writes the canonical overlay from fresh metadata without looking up the sign-in user again", async () => {
    setPluginConfig({ ...config, metadataMode: "canonical" });
    userContext._default.coreCallCache[sdkId] = { [ROWND_APP_VARIANTS_KEY]: { public: ["stale", "added"] } };
    records.set(sdkId, { [ROWND_APP_VARIANTS_KEY]: { public: ["current"], other: ["keep"] } });

    await recordRowndAppVariantForUser(primaryId, "added", userContext, "public", { userSnapshot: user });

    expect(SuperTokens.getUser).not.toHaveBeenCalled();
    expect(SuperTokens.getUserIdMapping).not.toHaveBeenCalled();
    expect(vi.mocked(UserMetadata.getUserMetadata).mock.calls).toEqual([[sdkId, userContext]]);
    expect(loadMetadata.mock.calls).toEqual([[sdkId]]);
    expect(UserMetadata.updateUserMetadata).toHaveBeenCalledWith(sdkId, {
      [ROWND_APP_VARIANTS_KEY]: { public: ["current", "added"], other: ["keep"] },
    }, userContext);
  });

  it("clears the shared cache before looking up the canonical user when no snapshot is supplied", async () => {
    setPluginConfig({ ...config, metadataMode: "canonical" });
    const sharedCache = { [sdkId]: { original_rownd_user: original(["stale"]) } };
    userContext._default.coreCallCache = sharedCache;
    records.set(sdkId, { original_rownd_user: original(["added"]) });
    const getUser = vi.mocked(SuperTokens.getUser).mockImplementationOnce(async (_id, context) => {
      expect(context).toBe(userContext);
      expect(context?._default?.coreCallCache).toEqual({});
      return user;
    });

    await recordRowndAppVariantForUser(primaryId, "added", userContext, "public");

    expect(getUser).toHaveBeenCalledOnce();
    expect(getUser).toHaveBeenCalledWith(primaryId, userContext);
    expect(SuperTokens.getUserIdMapping).not.toHaveBeenCalled();
    expect(vi.mocked(UserMetadata.getUserMetadata).mock.calls).toEqual([[sdkId, userContext]]);
    expect(getUser.mock.invocationCallOrder[0]!).toBeLessThan(vi.mocked(UserMetadata.getUserMetadata).mock.invocationCallOrder[0]!);
    expect(loadMetadata.mock.calls).toEqual([[sdkId]]);
    expect(UserMetadata.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("reuses the sign-in snapshot and fresh metadata for canonical claims after a no-op", async () => {
    setPluginConfig({ ...config, metadataMode: "canonical" });
    userContext._default.coreCallCache[sdkId] = { original_rownd_user: original(["added"], "Old") };
    records.set(sdkId, { original_rownd_user: original(["added"], "New") });

    await recordRowndAppVariantForUser(sdkId, "added", userContext, "public", { userSnapshot: user });
    const { rowndSessionClaims } = await buildRowndSessionAndAnonymousClaims(
      sdkId, { rownd_session_authentication: "authenticated" }, "added", userContext, recipeId, false, { userSnapshot: user },
    );

    expect(rowndSessionClaims).toMatchObject({ first_name: "New", app_user_id: sdkId, auth_level: "verified" });
    expect(UserMetadata.updateUserMetadata).not.toHaveBeenCalled();
    expect(SuperTokens.getUser).not.toHaveBeenCalled();
    expect(loadMetadata.mock.calls).toEqual([[sdkId]]);
  });
});

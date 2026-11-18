import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SuperTokens from "supertokens-node";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import Session from "supertokens-node/recipe/session";
import { LoginMethod, User as SuperTokensUserFixture } from "supertokens-node/lib/build/user";
import {
  assertNoDisconnectedSignInMethods,
  assertNoDisconnectedSignInMethodsAtInternalOwner,
  assertSignInMethodAuthenticationAllowed,
  assertSignInMethodLinkAllowed,
  assertSignInMethodTenantAssociationAllowed,
  getDisconnectedSignInMethods,
  isDisconnectedSignInMethodMetadataKey,
  recordDisconnectedSignInMethod,
  completeDisconnectedSignInMethod,
} from "./disconnected-sign-in-identities";
import { reconciliationUserMetadata } from "./reconciliation-sdk";
import { reconciliationReadRevision, withReadOnlyReconciliationReads, withReconciliationReads } from "./reconciliation-reads";
import { buildConfiguredSessionClaims, buildRowndUserMetadata, combineLinkedMetadata, getCombinedUserMetadata,
  isInternalMetadataField, mapRowndUserToSuperTokens, mergeMissingProfileMetadata, updatePrimaryUserMetadata } from "./rownd-compatibility";
import { previewReconciliation } from "./reconcile-preview";
import { importUser, reconcileRowndUserWithExistingLoginMethods, updateUserData, updateUserMetadata } from "./supertokens-repository";
import type { JsonRecord } from "./utils";
import { fetchAdministrativeMigrationSource } from "./migration-email";
import { prepareOwnerConsolidation } from "./migration-consolidation";
import { setRowndClient } from "./rownd-repository";
import { OWNER_PLAN_KEY, readOwnerPlanCheckpoint, type OwnerPlanCheckpoint } from "./migration-owner-plan";

type User = NonNullable<Awaited<ReturnType<typeof SuperTokens.getUser>>>;
const recipe = (id: string) => SuperTokens.convertToRecipeUserId(id);
const thirdparty = (id = "google-old", providerId = "google", subject = "subject", tenantIds = ["public"]) =>
  new LoginMethod({ recipeId: "thirdparty", recipeUserId: id, thirdParty: { id: providerId, userId: subject },
    email: "old@example.com", verified: true, tenantIds, timeJoined: 1 });
const passwordless = () => new LoginMethod({ recipeId: "passwordless", recipeUserId: "owner", email: "retained@example.com",
  verified: true, tenantIds: ["public"], timeJoined: 0 });
const user = (id: string, loginMethods: User["loginMethods"], primary = true) => new SuperTokensUserFixture({ id, isPrimaryUser: primary,
  timeJoined: 0, tenantIds: [...new Set(loginMethods.flatMap((method) => method.tenantIds))],
  emails: loginMethods.flatMap((method) => method.email ? [method.email] : []), phoneNumbers: [],
  thirdParty: loginMethods.flatMap((method) => method.thirdParty ? [method.thirdParty] : []), webauthn: { credentialIds: [] },
  loginMethods: loginMethods.map((method) => ({ recipeId: method.recipeId, recipeUserId: method.recipeUserId.getAsString(),
    tenantIds: method.tenantIds, email: method.email, phoneNumber: method.phoneNumber, thirdParty: method.thirdParty,
    verified: method.verified, timeJoined: method.timeJoined })),
});
const input = { userId: "owner", tenantId: "public", recipeUserId: "google-old", providerId: "google", providerUserId: "subject" };

describe("owner-scoped disconnected sign-in policy", () => {
  let owners: Map<string, User>;
  let records: Map<string, JsonRecord>;
  let mappings: Map<string, string>;

  beforeEach(() => {
    owners = new Map([["owner", user("owner", [passwordless(), thirdparty()])]]);
    records = new Map();
    mappings = new Map();
    vi.spyOn(SuperTokens, "getUserIdMapping").mockImplementation(async ({ userId, userIdType }) => {
      const match = [...mappings].find(([id, alias]) => userIdType === "EXTERNAL" ? userId === alias : userId === id);
      return match ? { status: "OK", superTokensUserId: match[0], externalUserId: match[1], externalUserIdInfo: undefined } : { status: "UNKNOWN_MAPPING_ERROR" };
    });
    vi.spyOn(SuperTokens, "getUser").mockImplementation(async (id) => {
      const internal = [...mappings].find(([, alias]) => alias === id)?.[0] ?? id;
      const entry = [...owners].find(([ownerId, graph]) => ownerId === internal ||
        graph.loginMethods.some((method) => method.recipeUserId.getAsString() === internal));
      return entry ? user(mappings.get(entry[0]) ?? entry[0], entry[1].loginMethods, entry[1].isPrimaryUser) : undefined;
    });
    vi.spyOn(SuperTokens, "listUsersByAccountInfo").mockImplementation(async (tenantId, accountInfo) =>
      [...owners.values()].filter((graph) => graph.loginMethods.some((method) => method.tenantIds.includes(tenantId) &&
        (accountInfo.email ? method.email === accountInfo.email : accountInfo.thirdParty ?
          method.thirdParty?.id === accountInfo.thirdParty.id && method.thirdParty.userId === accountInfo.thirdParty.userId : false))));
    vi.spyOn(UserMetadata, "getUserMetadata").mockImplementation(async (id) => ({ status: "OK", metadata: structuredClone(records.get(id) ?? {}) }));
    vi.spyOn(UserMetadata, "updateUserMetadata").mockImplementation(async (id, update) => {
      const metadata = { ...records.get(id), ...structuredClone(update) };
      for (const [key, value] of Object.entries(metadata)) if (value === null) delete metadata[key];
      records.set(id, metadata);
      return { status: "OK", metadata };
    });
  });

  afterEach(() => { setRowndClient(undefined); vi.restoreAllMocks(); });

  const checkpoint = async () => {
    await recordDisconnectedSignInMethod(input);
    const key = Object.keys(records.get("owner")!).find(isDisconnectedSignInMethodMetadataKey)!;
    return { key, value: records.get("owner")![key] };
  };

  it("preserves legacy behavior without policy and accepts retained authentication", async () => {
    await expect(getDisconnectedSignInMethods("owner")).resolves.toEqual([]);
    await expect(assertNoDisconnectedSignInMethods("owner")).resolves.toBeUndefined();
    await expect(assertSignInMethodAuthenticationAllowed("owner", recipe("google-old"), "public")).resolves.toEqual({ policy: [] });
    await checkpoint();
    await expect(assertSignInMethodAuthenticationAllowed("owner", recipe("owner"), "public")).resolves.toMatchObject({
      policy: [{ ...input, version: 1 }], method: { recipeId: "passwordless" },
    });
    await expect(assertNoDisconnectedSignInMethods("owner")).rejects.toMatchObject({ code: "DISCONNECT_RESTORATION_BLOCKED" });
  });

  it("keeps absent-owner legacy repair discoverable but never authenticates an absent graph", async () => {
    mappings.set("absent", "orphan");
    await expect(assertNoDisconnectedSignInMethods("orphan")).resolves.toBeUndefined();
    await expect(assertSignInMethodAuthenticationAllowed("orphan", recipe("absent"), "public")).rejects.toMatchObject({ code: "DISCONNECT_OWNER_CHANGED" });
  });

  it("uses four SDK reads for ordinary unmapped one-method authentication without policy", async () => {
    owners.set("owner", user("owner", [thirdparty("owner")]));
    const context = {};
    expect(await assertSignInMethodAuthenticationAllowed("owner", recipe("owner"), "public", context)).toEqual({ policy: [] });
    expect(SuperTokens.getUser).toHaveBeenCalledTimes(1);
    expect(SuperTokens.getUserIdMapping).toHaveBeenCalledTimes(2);
    expect(UserMetadata.getUserMetadata).toHaveBeenCalledTimes(1);
    await recordDisconnectedSignInMethod({ ...input, recipeUserId: "owner" }, context);
    await expect(assertSignInMethodAuthenticationAllowed("owner", recipe("owner"), "public", context)).rejects.toMatchObject({ code: "SIGN_IN_METHOD_DISCONNECTED" });
  });

  it("returns the final protected-method snapshot without caching it across decisions", async () => {
    await checkpoint();
    const decision = await assertSignInMethodAuthenticationAllowed("owner", recipe("owner"), "public");
    expect(decision.policy).toEqual([{ ...input, version: 1 }]);
    expect(decision.method?.recipeUserId.getAsString()).toBe("owner");
    decision.policy.length = 0;
    await expect(assertSignInMethodAuthenticationAllowed("owner", recipe("google-old"), "public")).rejects.toMatchObject({ code: "SIGN_IN_METHOD_DISCONNECTED" });
  });

  it("does not take the empty-policy fast path past a validated historical owner checkpoint", async () => {
    const { key, value } = await checkpoint();
    owners.delete("owner");
    owners.set("survivor", user("survivor", [thirdparty("survivor", "apple", "separate")]));
    const plan: OwnerPlanCheckpoint = {
      version: 2, id: "pinned-owner-plan", sourceId: "rownd", target: "survivor", status: "READY", cursor: 0,
      candidates: [{ rownd_user_id: "rownd", supertokens_user_id: "survivor" }], absentAliases: [],
      recipes: [{ id: "owner", identity: "donor", verified: true }, { id: "survivor", identity: "survivor", verified: true }],
      aliases: [{ id: "rownd", to: "survivor" }],
      initial: { graph: [{ id: "owner", owner: "owner", primary: true }, { id: "survivor", owner: "survivor", primary: true }],
        mappings: [{ id: "owner" }, { id: "survivor" }], markers: ["owner", "survivor", "rownd"].map((id) => ({ id, values: {} })), verifications: [] },
      operations: [{ kind: "detach", id: "owner" }, { kind: "link", id: "owner" }, { kind: "create_mapping", id: "survivor", alias: "rownd" }],
    };
    records.set("survivor", { [OWNER_PLAN_KEY]: plan });
    expect(readOwnerPlanCheckpoint(records.get("survivor")!)).toEqual(plan);
    await expect(assertSignInMethodAuthenticationAllowed("survivor", recipe("survivor"), "public")).rejects.toMatchObject({ code: "DISCONNECT_OWNER_CHANGED" });
    expect(records.get("owner")![key]).toEqual(value);
    expect(records.get("survivor")![key]).toBeUndefined();
  });

  it("writes a hashed top-level owner checkpoint and is idempotent after credential removal", async () => {
    const { key } = await checkpoint();
    expect(key).toMatch(/^rownd_disconnected_sign_in_identity_[a-f0-9]{64}$/);
    expect(key).not.toContain("subject");
    expect(await getDisconnectedSignInMethods("owner")).toEqual([{ ...input, version: 1 }]);
    owners.set("owner", user("owner", [passwordless()]));
    await recordDisconnectedSignInMethod(input);
    expect(UserMetadata.updateUserMetadata).toHaveBeenCalledTimes(1);
    expect(records.has("google-old")).toBe(false);
  });

  it("keeps a deleted credential retryable until explicit completion without clearing suppression", async () => {
    const { key, value } = await checkpoint();
    owners.set("owner", user("owner", [passwordless()]));
    expect(await getDisconnectedSignInMethods("owner")).toEqual([{ ...input, version: 1 }]);
    await completeDisconnectedSignInMethod(input);
    expect(await getDisconnectedSignInMethods("owner")).toEqual([{ ...input, version: 1, completed: true }]);
    expect(records.get("owner")![key]).toEqual(value);
    expect(Object.keys(records.get("owner")!).some((field) => field.startsWith("rownd_disconnected_sign_in_identity_completion_"))).toBe(true);
    const writes = vi.mocked(UserMetadata.updateUserMetadata).mock.calls.length;
    await completeDisconnectedSignInMethod(input);
    await recordDisconnectedSignInMethod(input);
    expect(UserMetadata.updateUserMetadata).toHaveBeenCalledTimes(writes);
    await expect(assertNoDisconnectedSignInMethods("owner")).rejects.toMatchObject({ code: "DISCONNECT_RESTORATION_BLOCKED" });
    owners.set("owner", user("owner", [passwordless(), thirdparty("recreated")]));
    await expect(assertSignInMethodAuthenticationAllowed("owner", recipe("recreated"), "public")).rejects.toMatchObject({ code: "SIGN_IN_METHOD_DISCONNECTED" });
  });

  it("cannot complete an absent checkpoint or a different credential receipt", async () => {
    await expect(completeDisconnectedSignInMethod(input)).rejects.toMatchObject({ code: "DISCONNECT_POLICY_INVALID" });
    await checkpoint();
    await expect(completeDisconnectedSignInMethod({ ...input, recipeUserId: "other-recipe" })).rejects.toMatchObject({ code: "DISCONNECT_POLICY_INVALID" });
    expect(await getDisconnectedSignInMethods("owner")).toEqual([{ ...input, version: 1 }]);
  });

  it("preserves completion when an earlier intent write resumes after another request completes", async () => {
    const write = vi.mocked(UserMetadata.updateUserMetadata);
    const original = write.getMockImplementation()!;
    let resume!: () => void;
    let signal!: () => void;
    const stalled = new Promise<void>((resolve) => { resume = resolve; });
    const atWrite = new Promise<void>((resolve) => { signal = resolve; });
    let first = true;
    write.mockImplementation(async (...args) => {
      if (first) {
        first = false;
        signal();
        await stalled;
        await original(...args);
        throw new Error("Delayed intent response lost");
      }
      return original(...args);
    });
    const delayed = recordDisconnectedSignInMethod(input).then(() => undefined, (error: unknown) => error);
    await atWrite;
    let completedSnapshot: JsonRecord | undefined;
    try {
      await recordDisconnectedSignInMethod(input);
      await completeDisconnectedSignInMethod(input);
      expect(await getDisconnectedSignInMethods("owner")).toEqual([{ ...input, version: 1, completed: true }]);
      completedSnapshot = structuredClone(records.get("owner")!);
    } finally {
      resume();
    }
    expect(await delayed).toMatchObject({ message: "Delayed intent response lost" });
    expect(records.get("owner")).toEqual(completedSnapshot);
    expect(await getDisconnectedSignInMethods("owner")).toEqual([{ ...input, version: 1, completed: true }]);
    const updates = write.mock.calls.map(([, update]) => Object.keys(update));
    expect(updates).toHaveLength(3);
    expect(updates.every((keys) => keys.length === 1)).toBe(true);
    expect(updates[0]).toEqual(updates[1]);
    expect(updates[2]![0]).toMatch(/^rownd_disconnected_sign_in_identity_completion_[a-f0-9]{64}$/);
  });

  it.each([{ completed: false }, { completed: null }, { completed: undefined }, { version: 2 },
    { userId: "other-owner" }, { tenantId: "other" }, { providerId: "other-issuer" },
    { providerUserId: "other-subject" }, { recipeUserId: "other-recipe" }])("rejects malformed or unbound completion markers %j", async (change) => {
    await checkpoint();
    await completeDisconnectedSignInMethod(input);
    const metadata = records.get("owner")!;
    const key = Object.keys(metadata).find((field) => field.startsWith("rownd_disconnected_sign_in_identity_completion_"))!;
    metadata[key] = { ...(metadata[key] as JsonRecord), ...change };
    await expect(getDisconnectedSignInMethods("owner")).rejects.toMatchObject({ code: "DISCONNECT_POLICY_INVALID" });
    await expect(assertSignInMethodAuthenticationAllowed("owner", recipe("owner"), "public")).rejects.toMatchObject({ code: "DISCONNECT_POLICY_INVALID" });
  });

  it("rejects an orphaned completion marker without its matching intent", async () => {
    const { key } = await checkpoint();
    await completeDisconnectedSignInMethod(input);
    delete records.get("owner")![key];
    await expect(getDisconnectedSignInMethods("owner")).rejects.toMatchObject({ code: "DISCONNECT_POLICY_INVALID" });
    await expect(assertNoDisconnectedSignInMethods("owner")).rejects.toMatchObject({ code: "DISCONNECT_POLICY_INVALID" });
  });

  it("does not persist new intent when the final proof callback rejects", async () => {
    const beforeCommit = vi.fn(async () => { throw new Error("Initiating session expired"); });
    await expect(recordDisconnectedSignInMethod(input, {}, beforeCommit)).rejects.toThrow("Initiating session expired");
    expect(beforeCommit).toHaveBeenCalledOnce();
    expect(UserMetadata.updateUserMetadata).not.toHaveBeenCalled();
    expect(await getDisconnectedSignInMethods("owner")).toEqual([]);
  });

  it("checks final proof on idempotent intent without replacing the checkpoint", async () => {
    const { key, value } = await checkpoint();
    const beforeCommit = vi.fn(async () => { throw new Error("Reauthentication required"); });
    await expect(recordDisconnectedSignInMethod(input, {}, beforeCommit)).rejects.toThrow("Reauthentication required");
    expect(beforeCommit).toHaveBeenCalledOnce();
    expect(UserMetadata.updateUserMetadata).toHaveBeenCalledTimes(1);
    expect(records.get("owner")![key]).toEqual(value);
  });

  it("resolves external owner and recipe aliases without putting policy on the external row", async () => {
    mappings.set("owner", "rownd-owner");
    await recordDisconnectedSignInMethod({ ...input, userId: "rownd-owner" });
    expect(await getDisconnectedSignInMethods("rownd-owner")).toEqual([{ ...input, version: 1 }]);
    expect(records.has("rownd-owner")).toBe(false);
    await expect(assertSignInMethodAuthenticationAllowed("rownd-owner", recipe("rownd-owner"), "public")).resolves.toMatchObject({ policy: [{ ...input, version: 1 }], method: { recipeId: "passwordless" } });
  });

  it("blocks the same provider subject with a recreated recipe ID", async () => {
    await checkpoint();
    owners.set("owner", user("owner", [passwordless(), thirdparty("google-new")]));
    await expect(assertSignInMethodAuthenticationAllowed("owner", recipe("google-new"), "public")).rejects.toMatchObject({ code: "SIGN_IN_METHOD_DISCONNECTED" });
    await expect(assertSignInMethodLinkAllowed("owner", recipe("google-new"))).rejects.toMatchObject({ code: "SIGN_IN_METHOD_DISCONNECTED" });
    await expect(recordDisconnectedSignInMethod({ ...input, recipeUserId: "google-new" })).rejects.toMatchObject({ code: "SIGN_IN_METHOD_DISCONNECTED" });
  });

  it("matches exact configured provider namespaces, subjects and tenants", async () => {
    await checkpoint();
    owners.set("owner", user("owner", [passwordless(), thirdparty("namespaced", "google-issuer-b"),
      thirdparty("new-subject", "google", "other-subject"), thirdparty("other-tenant", "google", "subject", ["other"])]));
    for (const [id, tenant] of [["namespaced", "public"], ["new-subject", "public"], ["other-tenant", "other"]]) {
      await expect(assertSignInMethodAuthenticationAllowed("owner", recipe(id!), tenant!)).resolves.toMatchObject({ policy: [{ ...input, version: 1 }], method: { recipeId: "thirdparty" } });
    }
    await expect(assertSignInMethodTenantAssociationAllowed(recipe("other-tenant"), "public")).rejects.toMatchObject({ code: "SIGN_IN_METHOD_DISCONNECTED" });
  });

  it("supports Apple and custom provider checkpoints", async () => {
    for (const providerId of ["apple", "oidc:issuer-a"]) {
      const id = `recipe-${providerId}`;
      owners.get("owner")!.loginMethods.push(thirdparty(id, providerId));
      await recordDisconnectedSignInMethod({ ...input, recipeUserId: id, providerId });
      await expect(assertSignInMethodAuthenticationAllowed("owner", recipe(id), "public")).rejects.toMatchObject({ code: "SIGN_IN_METHOD_DISCONNECTED" });
    }
  });

  it("permits a separate new account but prevents linking it back to the original owner", async () => {
    await checkpoint();
    owners.set("owner", user("owner", [passwordless()]));
    owners.set("new-owner", user("new-owner", [thirdparty("google-new")], false));
    await expect(assertSignInMethodAuthenticationAllowed("new-owner", recipe("google-new"), "public")).resolves.toEqual({ policy: [] });
    await expect(assertSignInMethodLinkAllowed("owner", recipe("google-new"))).rejects.toMatchObject({ code: "SIGN_IN_METHOD_DISCONNECTED" });
    await expect(assertSignInMethodAuthenticationAllowed("owner", recipe("google-new"), "public")).rejects.toMatchObject({ code: "DISCONNECT_OWNER_CHANGED" });
  });

  it("refuses importing a donor graph's policy or suppressed identity into another owner", async () => {
    await checkpoint();
    owners.set("destination", user("destination", [thirdparty("destination", "apple", "different")]));
    await expect(assertSignInMethodLinkAllowed("destination", recipe("owner"))).rejects.toMatchObject({ code: "DISCONNECT_RESTORATION_BLOCKED" });
    owners.set("donor", user("donor", [thirdparty("allowed", "apple", "different"), thirdparty("restored")]));
    await expect(assertSignInMethodLinkAllowed("owner", recipe("allowed"))).rejects.toMatchObject({ code: "SIGN_IN_METHOD_DISCONNECTED" });
  });

  it("does not inherit linked or external-row policy into the authoritative owner", async () => {
    const { key, value } = await checkpoint();
    records.set("owner", {});
    records.set("google-old", { [key]: value });
    mappings.set("owner", "rownd-owner");
    records.set("rownd-owner", { [key]: null });
    expect(await getDisconnectedSignInMethods("rownd-owner")).toEqual([]);
    expect((await getCombinedUserMetadata("owner"))[key]).toBeUndefined();
    await expect(assertSignInMethodAuthenticationAllowed("rownd-owner", recipe("google-old"), "public")).resolves.toEqual({ policy: [] });
  });

  it.each([null, {}, [], { version: 2 }, { userId: "different-owner" }, { tenantId: "" },
    { recipeUserId: 42 }, { providerId: "instant" }, { providerUserId: "different-subject" },
    { completed: true }, { completed: false }, { completed: null }, { completed: "true" }, { completed: undefined }])("fails closed for malformed present policy %j", async (bad) => {
    const { key, value } = await checkpoint();
    records.set("owner", { [key]: bad && !Array.isArray(bad) && Object.keys(bad).length > 0
      ? { ...(value as JsonRecord), ...bad } : bad });
    await expect(getDisconnectedSignInMethods("owner")).rejects.toMatchObject({ code: "DISCONNECT_POLICY_INVALID" });
    await expect(assertSignInMethodAuthenticationAllowed("owner", recipe("owner"), "public")).rejects.toMatchObject({ code: "DISCONNECT_POLICY_INVALID" });
    await expect(assertSignInMethodLinkAllowed("owner", recipe("google-old"))).rejects.toMatchObject({ code: "DISCONNECT_POLICY_INVALID" });
    await expect(assertNoDisconnectedSignInMethods("owner")).rejects.toMatchObject({ code: "DISCONNECT_POLICY_INVALID" });
  });

  it("keeps simultaneous checkpoints for different identities", async () => {
    owners.get("owner")!.loginMethods.push(thirdparty("apple", "apple", "apple-subject"));
    await Promise.all([recordDisconnectedSignInMethod(input), recordDisconnectedSignInMethod({ ...input,
      recipeUserId: "apple", providerId: "apple", providerUserId: "apple-subject" })]);
    expect(await getDisconnectedSignInMethods("owner")).toHaveLength(2);
    for (const [, update] of vi.mocked(UserMetadata.updateUserMetadata).mock.calls) expect(Object.keys(update)).toHaveLength(1);
  });

  it("refreshes cached policy before returning authentication and link decisions", async () => {
    const { key, value } = await checkpoint();
    records.set("owner", {});
    await withReconciliationReads(async () => {
      await reconciliationUserMetadata.getUserMetadata("owner");
      records.set("owner", { [key]: value });
      await expect(assertSignInMethodAuthenticationAllowed("owner", recipe("google-old"), "public")).rejects.toMatchObject({ code: "SIGN_IN_METHOD_DISCONNECTED" });
      await expect(assertSignInMethodLinkAllowed("owner", recipe("google-old"))).rejects.toMatchObject({ code: "SIGN_IN_METHOD_DISCONNECTED" });
    });
  });

  it("does not invalidate adjacent reconciliation evidence on policy reads, but does after a checkpoint write", async () => {
    await withReconciliationReads(async () => {
      const revision = reconciliationReadRevision();
      expect(await getDisconnectedSignInMethods("owner")).toEqual([]);
      expect(reconciliationReadRevision()).toBe(revision);
      await assertNoDisconnectedSignInMethods("owner");
      expect(reconciliationReadRevision()).toBe(revision);
      await recordDisconnectedSignInMethod(input);
      expect(reconciliationReadRevision()).not.toBe(revision);
      const writtenRevision = reconciliationReadRevision();
      expect(await getDisconnectedSignInMethods("owner")).toEqual([{ ...input, version: 1 }]);
      expect(reconciliationReadRevision()).toBe(writtenRevision);
    });
  });

  it("sees checkpoints committed during the complete linked-owner policy scan", async () => {
    const { key, value } = await checkpoint();
    records.set("owner", {});
    const read = vi.mocked(UserMetadata.getUserMetadata);
    const original = read.getMockImplementation()!;
    read.mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[0] === "google-old") records.set("owner", { [key]: value });
      return result;
    });
    await expect(assertSignInMethodAuthenticationAllowed("owner", recipe("google-old"), "public")).rejects.toMatchObject({ code: "SIGN_IN_METHOD_DISCONNECTED" });
    records.set("owner", {});
    await expect(assertSignInMethodLinkAllowed("owner", recipe("google-old"))).rejects.toMatchObject({ code: "SIGN_IN_METHOD_DISCONNECTED" });
  });

  it("rejects reassociation of the expected owner and never moves its policy", async () => {
    const { key, value } = await checkpoint();
    const graph = owners.get("owner")!;
    owners.delete("owner");
    owners.set("other", user("other", graph.loginMethods));
    await expect(assertSignInMethodAuthenticationAllowed("owner", recipe("owner"), "public")).rejects.toMatchObject({ code: "DISCONNECT_OWNER_CHANGED" });
    await expect(assertNoDisconnectedSignInMethods("owner")).rejects.toMatchObject({ code: "DISCONNECT_RESTORATION_BLOCKED" });
    await expect(assertNoDisconnectedSignInMethodsAtInternalOwner("owner", {}, "other")).rejects.toMatchObject({ code: "DISCONNECT_RESTORATION_BLOCKED" });
    await expect(recordDisconnectedSignInMethod(input)).rejects.toMatchObject({ code: "DISCONNECT_OWNER_CHANGED" });
    expect(records.get("owner")![key]).toEqual(value);
    expect(records.get("other")![key]).toBeUndefined();
    await expect(assertSignInMethodAuthenticationAllowed("other", recipe("google-old"), "public")).rejects.toMatchObject({ code: "DISCONNECT_OWNER_CHANGED" });
    owners.set("other", user("other", [thirdparty("survivor", "apple", "separate")]));
    await expect(assertSignInMethodAuthenticationAllowed("other", recipe("survivor"), "public")).rejects.toMatchObject({ code: "DISCONNECT_OWNER_CHANGED" });
  });

  it("denies protected owner conflicts without writes during read-only inspection", async () => {
    await checkpoint();
    const graph = owners.get("owner")!;
    owners.delete("owner");
    owners.set("other", user("other", graph.loginMethods));
    const writes = vi.mocked(UserMetadata.updateUserMetadata).mock.calls.length;
    await withReadOnlyReconciliationReads(async () => {
      await expect(assertSignInMethodAuthenticationAllowed("other", recipe("google-old"), "public")).rejects.toMatchObject({ code: "DISCONNECT_OWNER_CHANGED" });
      await expect(assertNoDisconnectedSignInMethodsAtInternalOwner("owner", {}, "other")).rejects.toMatchObject({ code: "DISCONNECT_RESTORATION_BLOCKED" });
    });
    expect(UserMetadata.updateUserMetadata).toHaveBeenCalledTimes(writes);
    expect(records.has("other")).toBe(false);
  });

  it("quarantines an already-reassociated protected graph before any restoration postcheck", async () => {
    const { key } = await checkpoint();
    const graph = owners.get("owner")!;
    owners.delete("owner");
    owners.set("survivor", user("survivor", graph.loginMethods));
    await expect(assertSignInMethodAuthenticationAllowed("survivor", recipe("google-old"), "public")).rejects.toMatchObject({ code: "DISCONNECT_OWNER_CHANGED" });
    expect(records.get("survivor")![key]).toBeUndefined();
    owners.set("survivor", user("survivor", [thirdparty("fresh", "apple", "fresh-subject")]));
    await expect(assertSignInMethodAuthenticationAllowed("survivor", recipe("fresh"), "public")).rejects.toMatchObject({ code: "DISCONNECT_OWNER_CHANGED" });
  });

  it("resolves retired migration aliases without restoring the removed provider", async () => {
    await checkpoint();
    records.set("retired-rownd", { rownd_migration_canonical_target: "owner" });
    await expect(assertNoDisconnectedSignInMethods("retired-rownd")).rejects.toMatchObject({ code: "DISCONNECT_RESTORATION_BLOCKED" });
    await expect(assertSignInMethodAuthenticationAllowed("owner", recipe("retired-rownd"), "public")).rejects.toMatchObject({ code: "DISCONNECT_OWNER_CHANGED" });
  });

  it("does not roll back committed intent after an ambiguous write response", async () => {
    const write = vi.mocked(UserMetadata.updateUserMetadata);
    const original = write.getMockImplementation()!;
    write.mockImplementation(async (...args) => { await original(...args); throw new Error("response lost"); });
    await expect(recordDisconnectedSignInMethod(input)).rejects.toThrow("response lost");
    expect(await getDisconnectedSignInMethods("owner")).toEqual([{ ...input, version: 1 }]);
    await expect(assertSignInMethodAuthenticationAllowed("owner", recipe("google-old"), "public")).rejects.toMatchObject({ code: "SIGN_IN_METHOD_DISCONNECTED" });
  });

  it("protects every reserved prefix key from operational and schema-independent profile writes", async () => {
    vi.spyOn(Session, "getAllSessionHandlesForUser").mockResolvedValue([]);
    const { key, value } = await checkpoint();
    await completeDisconnectedSignInMethod(input);
    const completionField = Object.keys(records.get("owner")!).find((field) => field.startsWith("rownd_disconnected_sign_in_identity_completion_"))!;
    const completion = structuredClone(records.get("owner")![completionField]);
    const unknownKey = "rownd_disconnected_sign_in_identity_future";
    await updatePrimaryUserMetadata("owner", { [key]: null, [completionField]: null, [unknownKey]: {} });
    await updateUserMetadata("owner", { [key]: null, [completionField]: {}, [unknownKey]: null, preference: "keep" });
    await updateUserData("owner", { [key]: null, [completionField]: false, [unknownKey]: {}, preference: "changed" });
    expect(records.get("owner")![key]).toEqual(value);
    expect(records.get("owner")![completionField]).toEqual(completion);
    expect(records.get("owner")![unknownKey]).toBeUndefined();
    expect(isInternalMetadataField(unknownKey)).toBe(true);
    expect(records.get("owner")!.rownd_profile_authoritative_fields).toEqual(["preference"]);
  });

  it("keeps checkpoint authority out of linked merges, external snapshots and configured claims", async () => {
    const { key, value } = await checkpoint();
    const unknownKey = "rownd_disconnected_sign_in_identity_future";
    expect(isInternalMetadataField(unknownKey)).toBe(true);
    const linked = combineLinkedMetadata({ primaryUserId: "owner", primaryMetadata: { [key]: value },
      linkedMetadata: [{ userId: "google-old", metadata: { [key]: null, [unknownKey]: value } }] });
    expect(linked.metadataUpdate).toEqual({});
    expect(linked.combinedMetadata[key]).toEqual(value);
    expect(mergeMissingProfileMetadata({ [key]: value }, { [key]: null, [unknownKey]: value })).toEqual({ [key]: value });
    const imported = buildRowndUserMetadata({ state: "enabled", auth_level: "verified", verified_data: {},
      data: { user_id: "external", [key]: null, [unknownKey]: value },
      meta: { [key]: value, [unknownKey]: null } });
    expect(imported[key]).toBeUndefined();
    expect(imported[unknownKey]).toBeUndefined();
    expect(imported.original_rownd_user).toEqual({ state: "enabled", auth_level: "verified", verified_data: {},
      data: { user_id: "external" }, meta: {} });
    expect(buildConfiguredSessionClaims({ [key]: value }, { schema: {
      [key]: { include_in_session_claims: true }, [unknownKey]: { include_in_session_claims: true },
    } } as any)).toEqual({});
    await updatePrimaryUserMetadata("owner", { [key]: null, [unknownKey]: value });
    expect(records.get("owner")![key]).toEqual(value);
    expect(records.get("owner")![unknownKey]).toBeUndefined();
  });

  it("also excludes separate completion markers from snapshots, linked inheritance and session claims", async () => {
    await checkpoint();
    await completeDisconnectedSignInMethod(input);
    const protectedFields = Object.fromEntries(Object.entries(records.get("owner")!).filter(([key]) => isDisconnectedSignInMethodMetadataKey(key)));
    expect(Object.keys(protectedFields)).toHaveLength(2);
    expect(combineLinkedMetadata({ primaryUserId: "destination", primaryMetadata: {},
      linkedMetadata: [{ userId: "owner", metadata: protectedFields }] }).combinedMetadata).toEqual({});
    expect(mergeMissingProfileMetadata({}, protectedFields)).toEqual({});
    const imported = buildRowndUserMetadata({ state: "enabled", auth_level: "verified", verified_data: {},
      data: { user_id: "external", ...protectedFields }, meta: protectedFields });
    for (const key of Object.keys(protectedFields)) expect(imported[key]).toBeUndefined();
    expect(imported.original_rownd_user).toEqual({ state: "enabled", auth_level: "verified", verified_data: {},
      data: { user_id: "external" }, meta: {} });
    expect(buildConfiguredSessionClaims(protectedFields, { schema: Object.fromEntries(Object.keys(protectedFields)
      .map((key) => [key, { include_in_session_claims: true }])) } as any)).toEqual({});
  });

  it("blocks direct bulk import before HTTP, including a retained-method-only legacy source", async () => {
    await checkpoint();
    mappings.set("owner", "rownd-owner");
    const request = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected Core import"));
    const source = mapRowndUserToSuperTokens({ state: "enabled", auth_level: "verified", verified_data: {},
      data: { user_id: "rownd-owner", email: "retained@example.com" } });
    await expect(importUser(source, { connectionURI: "http://unused.invalid" })).rejects.toMatchObject({ code: "DISCONNECT_RESTORATION_BLOCKED" });
    await expect(importUser({ ...source, externalUserId: undefined }, { connectionURI: "http://unused.invalid" })).rejects.toMatchObject({ code: "DISCONNECT_RESTORATION_BLOCKED" });
    await expect(importUser({ loginMethods: source.loginMethods, userMetadata: {} }, { connectionURI: "http://unused.invalid" })).rejects.toMatchObject({ code: "DISCONNECT_RESTORATION_BLOCKED" });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects reserved policy imports before the direct Core request", async () => {
    const { key, value } = await checkpoint();
    await completeDisconnectedSignInMethod(input);
    const completionField = Object.keys(records.get("owner")!).find((field) => field.startsWith("rownd_disconnected_sign_in_identity_completion_"))!;
    const request = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected Core import"));
    await expect(importUser({ loginMethods: [], userMetadata: { [key]: value } },
      { connectionURI: "http://unused.invalid" })).rejects.toThrow("Reserved sign-in method policy cannot be imported");
    await expect(importUser({ loginMethods: [], userMetadata: { [completionField]: records.get("owner")![completionField] } },
      { connectionURI: "http://unused.invalid" })).rejects.toThrow("Reserved sign-in method policy cannot be imported");
    expect(request).not.toHaveBeenCalled();
  });

  it("denies import completion when a checkpoint commits during the Core request", async () => {
    const { key, value } = await checkpoint();
    records.set("owner", {});
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      records.set("owner", { [key]: value });
      return new Response(JSON.stringify({ status: "OK", user: { id: "owner", loginMethods: [{ recipeUserId: "google-old" }] } }), { status: 200 });
    });
    const source = mapRowndUserToSuperTokens({ state: "enabled", auth_level: "verified", verified_data: {},
      data: { user_id: "owner", email: "retained@example.com" } });
    await expect(importUser(source, { connectionURI: "http://unused.invalid" })).rejects.toMatchObject({ code: "DISCONNECT_RESTORATION_BLOCKED" });
    expect(records.get("owner")![key]).toEqual(value);
    expect(UserMetadata.updateUserMetadata).toHaveBeenCalledTimes(1);
  });

  it("blocks existing-owner reconciliation and returns a blocked preview before mutation", async () => {
    await checkpoint();
    const source = mapRowndUserToSuperTokens({ state: "enabled", auth_level: "verified", verified_data: {},
      data: { user_id: "owner", email: "retained@example.com" } });
    const writes = vi.mocked(UserMetadata.updateUserMetadata).mock.calls.length;
    await expect(reconcileRowndUserWithExistingLoginMethods(source, "public", {})).rejects.toMatchObject({ code: "DISCONNECT_RESTORATION_BLOCKED" });
    expect(await previewReconciliation({ source, selected: owners.get("owner"), tenantId: "public", restoreMapping: false,
      userContext: {} })).toMatchObject({ status: "BLOCKED", canReconcile: false,
      blockers: [{ code: "DISCONNECT_RESTORATION_BLOCKED" }], proposedActions: [] });
    expect(UserMetadata.updateUserMetadata).toHaveBeenCalledTimes(writes);
  });

  it("refuses consolidation when either the survivor or a donor has policy", async () => {
    await checkpoint();
    owners.set("survivor", user("survivor", [thirdparty("survivor", "apple", "other-subject")]));
    setRowndClient({ validateToken: vi.fn(), fetchUserInfo: vi.fn().mockResolvedValue({ state: "enabled",
      data: { user_id: "rownd", email: "retained@example.com" }, verified_data: { email: true } }) });
    const source = (await fetchAdministrativeMigrationSource("rownd", "public", {}))!;
    for (const target of ["owner", "survivor"]) {
      await expect(prepareOwnerConsolidation({ source, target, tenantId: "public", userContext: {}, ownerIds: ["owner"],
        candidates: [{ rownd_user_id: "rownd", supertokens_user_id: "owner" }] })).rejects.toMatchObject({ code: "DISCONNECT_RESTORATION_BLOCKED" });
    }
  });

  it("detects a checkpoint plus donor reassociation injected after a clean consolidation precheck", async () => {
    const { key, value } = await checkpoint();
    records.set("owner", {});
    owners.set("survivor", user("survivor", [thirdparty("survivor", "apple", "separate")]));
    setRowndClient({ validateToken: vi.fn(), fetchUserInfo: vi.fn().mockResolvedValue({ state: "enabled", auth_level: "verified",
      data: { user_id: "rownd", email: "retained@example.com" }, verified_data: { email: true } }) });
    const source = (await fetchAdministrativeMigrationSource("rownd", "public", {}))!;
    const read = vi.mocked(UserMetadata.getUserMetadata);
    const original = read.getMockImplementation()!;
    let injected = false;
    read.mockImplementation(async (...args) => {
      const cleanSnapshot = await original(...args);
      if (args[0] === "owner" && !injected) {
        injected = true;
        records.set("owner", { [key]: value });
        const donor = owners.get("owner")!;
        owners.delete("owner");
        owners.set("survivor", user("survivor", [...owners.get("survivor")!.loginMethods, ...donor.loginMethods]));
      }
      return cleanSnapshot;
    });
    await expect(prepareOwnerConsolidation({ source, target: "survivor", tenantId: "public", userContext: {}, ownerIds: ["owner"],
      candidates: [{ rownd_user_id: "rownd", supertokens_user_id: "owner" }] })).rejects.toMatchObject({ code: "DISCONNECT_OWNER_CHANGED" });
    expect(injected).toBe(true);
    expect(records.get("owner")![key]).toEqual(value);
    expect(records.get("survivor")![key]).toBeUndefined();
    expect(owners.get("survivor")!.loginMethods.some((method) => method.recipeUserId.getAsString() === "owner")).toBe(true);
    owners.set("survivor", user("survivor", [thirdparty("survivor", "apple", "separate")]));
    await expect(assertSignInMethodAuthenticationAllowed("survivor", recipe("survivor"), "public")).rejects.toMatchObject({ code: "DISCONNECT_OWNER_CHANGED" });
    await expect(assertNoDisconnectedSignInMethodsAtInternalOwner("owner", {}, "survivor")).rejects.toMatchObject({ code: "DISCONNECT_RESTORATION_BLOCKED" });
  });
});

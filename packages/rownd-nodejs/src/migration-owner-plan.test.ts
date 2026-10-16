import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SuperTokens from "supertokens-node";
import AccountLinking from "supertokens-node/recipe/accountlinking";
import EmailVerification from "supertokens-node/recipe/emailverification";
import Session from "supertokens-node/recipe/session";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import { User } from "supertokens-node/lib/build/user";
import { assertCompletedPlan, assertConsolidationSessionMembership, prepareOwnerConsolidation } from "./migration-consolidation";
import { bindAdministrativeElection, inspectAdministrativeElection } from "./migration-election";
import { fetchAdministrativeMigrationSource } from "./migration-email";
import { applyOwnerOperation, OWNER_PLAN_KEY, readOwnerPlanCheckpoint } from "./migration-owner-plan";
import { setRowndClient } from "./rownd-repository";
import { recordAdministrativeMethodCreation } from "./migration-method-receipts";
import { assertMigrationSourceActive } from "./migration-mapping";
import { inspectInstantPrimaryProof } from "./migration-instant-election";
import { invalidateReconciliationReads, withReconciliationReads } from "./reconciliation-reads";
import { reconciliationAccountLinking, reconciliationSuperTokens, reconciliationUserMetadata } from "./reconciliation-sdk";
import type { RowndUser } from "./types";
import type { JsonRecord } from "./utils";

type Recipe = { id: string; owner: string; primary: boolean; email?: string; phoneNumber?: string; verified: boolean; thirdParty?: { id: string; userId: string } };
const email = "shared@example.test";
let recipes: Map<string, Recipe>;
let mappings: Map<string, string>;
let metadata: Map<string, JsonRecord>;
let profiles: Map<string, RowndUser>;
let sessions: Set<string>;
let writes: string[];
let verifications: Map<string, boolean>;

function internal(id: string) { return [...mappings].find(([, alias]) => alias === id)?.[0] ?? id; }
function external(id: string) { return mappings.get(id) ?? id; }
function verify(id: string, value: boolean) {
  const recipe = recipes.get(id)!;
  recipe.verified = value;
  if (recipe.email) verifications.set(`${external(id)}:${recipe.email}`, value);
}
function userFor(id: string) {
  const recipe = recipes.get(internal(id));
  if (!recipe) return undefined;
  const members = [...recipes.values()].filter((entry) => entry.owner === recipe.owner);
  return new User({ id: external(recipe.owner), isPrimaryUser: recipe.primary, tenantIds: ["public"], timeJoined: 1,
    emails: members.flatMap((entry) => entry.email ? [entry.email] : []), phoneNumbers: members.flatMap((entry) => entry.phoneNumber ? [entry.phoneNumber] : []),
    thirdParty: members.flatMap((entry) => entry.thirdParty ? [entry.thirdParty] : []), webauthn: { credentialIds: [] },
    loginMethods: members.map((entry) => ({ recipeId: entry.thirdParty ? "thirdparty" : "passwordless", recipeUserId: external(entry.id),
      ...(entry.thirdParty ? { thirdParty: entry.thirdParty } : {}),
      ...(entry.email ? { email: entry.email } : { phoneNumber: entry.phoneNumber }),
      verified: entry.email ? verifications.get(`${external(entry.id)}:${entry.email}`) ?? false : entry.verified, tenantIds: ["public"], timeJoined: 1 })) });
}

beforeEach(() => {
  recipes = new Map([
    ["T", { id: "T", owner: "T", primary: true, email, verified: false }],
    ["D", { id: "D", owner: "D", primary: true, phoneNumber: "+12025550101", verified: false }],
    ["D2", { id: "D2", owner: "D", primary: true, email: "historical@example.test", verified: false }],
  ]);
  mappings = new Map([["T", "older"], ["D", "newer"]]);
  profiles = new Map([
    ["older", { data: { user_id: "older", email }, meta: { last_active: "2020-01-01T00:00:00Z" } }],
    ["newer", { data: { user_id: "newer", email, phone_number: "+12025550101" }, meta: { last_active: "2020-02-01T00:00:00Z" } }],
  ]);
  metadata = new Map([
    ["T", { original_rownd_user: structuredClone(profiles.get("older")!), rownd_migration_complete: true }],
    ["D", { original_rownd_user: structuredClone(profiles.get("newer")!), rownd_migration_complete: true }],
    ["newer", { rownd_migration_target: "D", rownd_migration_canonical_target: "D" }],
    ["older", { rownd_migration_canonical_target: "T" }],
  ]);
  sessions = new Set();
  verifications = new Map();
  writes = [];
  vi.spyOn(EmailVerification, "isEmailVerified").mockImplementation(async (id, email) => verifications.get(`${id.getAsString()}:${email}`) ?? false);
  vi.spyOn(EmailVerification, "revokeEmailVerificationTokens").mockImplementation(async (_tenant, id, email) => {
    writes.push(`revoke-verification:${id.getAsString()}:${email}`);
    return { status: "OK" };
  });
  const tokens = new Map<string, { id: string; email: string }>();
  vi.spyOn(EmailVerification, "createEmailVerificationToken").mockImplementation(async (_tenant, id, email) => {
    const token = `token-${tokens.size}`;
    tokens.set(token, { id: id.getAsString(), email: email! });
    writes.push(`verification-token:${id.getAsString()}`);
    return { status: "OK", token };
  });
  vi.spyOn(EmailVerification, "verifyEmailUsingToken").mockImplementation(async (_tenant, token) => {
    const entry = tokens.get(token)!;
    verifications.set(`${entry.id}:${entry.email}`, true);
    writes.push(`verify:${entry.id}`);
    return { status: "OK", user: { recipeUserId: SuperTokens.convertToRecipeUserId(entry.id), email: entry.email } };
  });
  setRowndClient({ validateToken: async () => ({ user_id: "newer" }), fetchUserInfo: async ({ user_id }) => structuredClone(profiles.get(user_id)) });
  vi.spyOn(SuperTokens, "getUser").mockImplementation(async (id) => userFor(id));
  vi.spyOn(SuperTokens, "listUsersByAccountInfo").mockImplementation(async (_tenant, info) => {
    const owners = new Set([...recipes.values()].filter((recipe) => info.email ? recipe.email === info.email :
      info.phoneNumber ? recipe.phoneNumber === info.phoneNumber : info.thirdParty ?
        recipe.thirdParty?.id === info.thirdParty.id && recipe.thirdParty?.userId === info.thirdParty.userId : false).map((recipe) => recipe.owner));
    return [...owners].map((id) => userFor(id)!);
  });
  vi.spyOn(SuperTokens, "getUserIdMapping").mockImplementation(async ({ userId, userIdType }) => {
    const id = userIdType === "EXTERNAL" ? [...mappings].find(([, alias]) => alias === userId)?.[0] :
      userIdType === "SUPERTOKENS" ? userId : internal(userId);
    const alias = id && mappings.get(id);
    return id && alias ? { status: "OK", superTokensUserId: id, externalUserId: alias } : { status: "UNKNOWN_MAPPING_ERROR" };
  });
  vi.spyOn(SuperTokens, "deleteUserIdMapping").mockImplementation(async ({ userId, userIdType }) => {
    expect(userIdType).toBe("EXTERNAL");
    const id = internal(userId);
    writes.push(`delete:${userId}`);
    const didMappingExist = mappings.delete(id);
    return { status: "OK", didMappingExist };
  });
  vi.spyOn(SuperTokens, "createUserIdMapping").mockImplementation(async ({ superTokensUserId, externalUserId }) => {
    expect(recipes.has(superTokensUserId)).toBe(true);
    expect(mappings.has(superTokensUserId)).toBe(false);
    expect([...mappings.values()]).not.toContain(externalUserId);
    writes.push(`map:${externalUserId}:${superTokensUserId}`);
    mappings.set(superTokensUserId, externalUserId);
    return { status: "OK" };
  });
  vi.spyOn(UserMetadata, "getUserMetadata").mockImplementation(async (id) => ({ status: "OK", metadata: structuredClone(metadata.get(id) ?? {}) }));
  vi.spyOn(UserMetadata, "updateUserMetadata").mockImplementation(async (id, update) => {
    writes.push(`metadata:${id}`);
    const next = JSON.parse(JSON.stringify({ ...metadata.get(id), ...update })) as JsonRecord;
    for (const [field, value] of Object.entries(next)) if (value === null) delete next[field];
    metadata.set(id, next);
    return { status: "OK", metadata: structuredClone(next) };
  });
  vi.spyOn(Session, "getAllSessionHandlesForUser").mockImplementation(async (id, _linked, tenant) => {
    expect(tenant).toBe("public");
    const owner = recipes.get(internal(id))?.owner;
    return [...sessions].filter((recipeId) => recipeId === internal(id) || recipes.get(recipeId)?.owner === owner);
  });
  vi.spyOn(AccountLinking, "canLinkAccounts").mockResolvedValue({ status: "OK", accountsAlreadyLinked: false });
  vi.spyOn(AccountLinking, "canCreatePrimaryUser").mockResolvedValue({ status: "OK", wasAlreadyAPrimaryUser: false });
  vi.spyOn(AccountLinking, "createPrimaryUser").mockImplementation(async (id) => {
    const recipe = recipes.get(internal(id.getAsString()))!;
    writes.push(`promote:${recipe.id}`);
    recipe.primary = true;
    return { status: "OK", user: userFor(recipe.id)!, wasAlreadyAPrimaryUser: false };
  });
  vi.spyOn(AccountLinking, "unlinkAccount").mockImplementation(async (id) => {
    const recipe = recipes.get(internal(id.getAsString()))!;
    expect(recipe.owner).not.toBe("T");
    if (recipe.id === recipe.owner) expect([...recipes.values()].filter((entry) => entry.owner === recipe.owner)).toHaveLength(1);
    writes.push(`detach:${recipe.id}`);
    recipe.owner = recipe.id;
    recipe.primary = false;
    return { status: "OK", wasLinked: true, wasRecipeUserDeleted: false };
  });
  vi.spyOn(AccountLinking, "linkAccounts").mockImplementation(async (id, primary) => {
    expect(primary).toBe(external("T"));
    const recipe = recipes.get(internal(id.getAsString()))!;
    expect(id.getAsString()).toBe(external(recipe.id));
    writes.push(`link:${recipe.id}`);
    recipe.owner = "T";
    recipe.primary = true;
    return { status: "OK", accountsAlreadyLinked: false, user: userFor("T")! };
  });
});

afterEach(() => { vi.restoreAllMocks(); setRowndClient(undefined); });

async function prepare(bind = true, sourceId = "newer", ownerIds = ["T", "D"]) {
  const candidates = [...profiles.keys()].map((rownd_user_id) => ({ rownd_user_id,
    ...([...mappings].find(([, alias]) => alias === rownd_user_id)?.[0] ? { supertokens_user_id: internal(rownd_user_id) } : {}) }));
  const source = (await fetchAdministrativeMigrationSource(sourceId, "public", {}))!;
  const plan = await prepareOwnerConsolidation({ source, candidates, target: "T", ownerIds, tenantId: "public", userContext: {} });
  if (bind && plan) bindAdministrativeElection(source, "public", await inspectAdministrativeElection(candidates), () => plan.assertOwners());
  return plan!;
}

describe("durable owner transitions", () => {
  it.each(["mapping", "owner", "literal metadata"])("standalone completed observations deduplicate exact selectors but refresh after external %s changes", async (change) => {
    const consolidation = await prepare();
    await consolidation.execute();
    await consolidation.beginMethodReconciliation();
    await consolidation.complete();
    const checkpoint = readOwnerPlanCheckpoint(metadata.get("T")!)!;
    const users = vi.mocked(SuperTokens.getUser);
    const mappingReads = vi.mocked(SuperTokens.getUserIdMapping);
    const metadataReads = vi.mocked(UserMetadata.getUserMetadata);
    users.mockClear();
    mappingReads.mockClear();
    metadataReads.mockClear();
    const observation = await assertCompletedPlan(checkpoint, {});
    expect(observation.state.graph).toEqual(checkpoint.completion!.state.graph);
    const userIds = users.mock.calls.map(([id]) => id);
    const mappingIds = mappingReads.mock.calls.map(([input]) => `${input.userIdType}:${input.userId}`);
    const metadataIds = metadataReads.mock.calls.map(([id]) => id);
    expect(userIds.length).toBe(new Set(userIds).size);
    expect(mappingIds.length).toBe(new Set(mappingIds).size);
    expect(metadataIds.length).toBe(new Set(metadataIds).size);
    expect(metadataIds).toEqual(expect.arrayContaining(["T", "newer", "older"]));
    expect(mappingIds).toEqual(expect.arrayContaining(["EXTERNAL:newer", "SUPERTOKENS:T"]));
    if (change === "mapping") mappings.delete("T");
    else if (change === "owner") recipes.get("D")!.owner = "D";
    else metadata.set("older", { ...metadata.get("older"), rownd_migration_canonical_target: "outside" });
    await expect(assertCompletedPlan(checkpoint, {})).rejects.toThrow();
  });

  it("completed observations preserve outer graph reads across metadata-only writes and refresh on explicit invalidation", async () => {
    const consolidation = await prepare();
    await consolidation.execute();
    await consolidation.beginMethodReconciliation();
    await consolidation.complete();
    const checkpoint = readOwnerPlanCheckpoint(metadata.get("T")!)!;
    await withReconciliationReads(async () => {
      await assertCompletedPlan(checkpoint, {});
      vi.mocked(SuperTokens.getUser).mockClear();
      vi.mocked(SuperTokens.getUserIdMapping).mockClear();
      vi.mocked(UserMetadata.getUserMetadata).mockClear();
      vi.mocked(EmailVerification.isEmailVerified).mockClear();
      await assertCompletedPlan(checkpoint, {});
      expect(UserMetadata.getUserMetadata).not.toHaveBeenCalled();
      await reconciliationUserMetadata.updateUserMetadata("D", { preference: "kept" });
      await assertCompletedPlan(checkpoint, {});
      expect(UserMetadata.getUserMetadata).toHaveBeenCalledTimes(1);
      expect(vi.mocked(UserMetadata.getUserMetadata).mock.calls[0]![0]).toBe("D");
      expect(SuperTokens.getUser).not.toHaveBeenCalled();
      expect(SuperTokens.getUserIdMapping).not.toHaveBeenCalled();
      expect(EmailVerification.isEmailVerified).not.toHaveBeenCalled();
      invalidateReconciliationReads();
      await assertCompletedPlan(checkpoint, {});
      expect(SuperTokens.getUser).toHaveBeenCalledTimes(5);
      expect(SuperTokens.getUserIdMapping).toHaveBeenCalledTimes(10);
      expect(UserMetadata.getUserMetadata).toHaveBeenCalledTimes(6);
      expect(EmailVerification.isEmailVerified).toHaveBeenCalledTimes(10);
      mappings.delete("T");
      invalidateReconciliationReads();
      await expect(assertCompletedPlan(checkpoint, {})).rejects.toThrow();
    });
  });

  it.each(["mapping", "graph"])("completed observations respect SDK %s mutation invalidation in the outer scope", async (change) => {
    const consolidation = await prepare();
    await consolidation.execute();
    await consolidation.beginMethodReconciliation();
    await consolidation.complete();
    const checkpoint = readOwnerPlanCheckpoint(metadata.get("T")!)!;
    await withReconciliationReads(async () => {
      await assertCompletedPlan(checkpoint, {});
      if (change === "mapping") {
        await reconciliationSuperTokens.deleteUserIdMapping({ userId: "newer", userIdType: "EXTERNAL" });
      } else {
        vi.mocked(AccountLinking.unlinkAccount).mockImplementationOnce(async () => {
          recipes.get("D")!.owner = "D";
          return { status: "OK", wasLinked: true, wasRecipeUserDeleted: false };
        });
        await reconciliationAccountLinking.unlinkAccount(SuperTokens.convertToRecipeUserId(external("D")));
      }
      await expect(assertCompletedPlan(checkpoint, {})).rejects.toThrow();
    });
  });

  it("ordinary consolidation reuses discovery profiles across completion boundaries", async () => {
    const fetchUserInfo = vi.fn(async ({ user_id }: { user_id: string }) => structuredClone(profiles.get(user_id)));
    setRowndClient({ validateToken: async () => ({ user_id: "newer" }), fetchUserInfo });
    await withReconciliationReads(async () => {
      const plan = await prepare();
      expect(fetchUserInfo).toHaveBeenCalledTimes(2);
      await plan.execute();
      await plan.beginMethodReconciliation();
      await plan.complete();
      expect(fetchUserInfo).toHaveBeenCalledTimes(2);
    });
  });

  it.each(["unchanged", "drift"])("instant consolidation reuses adjacent fresh evidence and refreshes after metadata writes (%s)", async (mode) => {
    recipes = new Map([
      ["T", { id: "T", owner: "T", primary: true, verified: false, thirdParty: { id: "instant", userId: "older" } }],
      ["D", { id: "D", owner: "T", primary: true, verified: false, email, thirdParty: { id: "google", userId: "subject" } }],
    ]);
    profiles = new Map([
      ["older", { data: { user_id: "older" }, auth_level: "instant" }],
      ["newer", { data: { user_id: "newer", email, google_id: "subject" }, verified_data: { email, google_id: "subject" } }],
    ]);
    metadata = new Map([
      ["T", { original_rownd_user: structuredClone(profiles.get("older")), rownd_migration_complete: true }],
      ["D", { original_rownd_user: structuredClone(profiles.get("newer")), rownd_migration_complete: true }],
    ]);
    const fetchUserInfo = vi.fn(async ({ user_id }: { user_id: string }) => structuredClone(profiles.get(user_id)));
    setRowndClient({ validateToken: async () => ({ user_id: "newer" }), fetchUserInfo });
    await withReconciliationReads(async () => {
      const candidates = [{ rownd_user_id: "older", supertokens_user_id: "T" }, { rownd_user_id: "newer", supertokens_user_id: "D" }];
      const source = (await fetchAdministrativeMigrationSource("newer", "public", {}))!;
      const instantPrimaryProof = await inspectInstantPrimaryProof(candidates, "public", {});
      expect(instantPrimaryProof).toBeDefined();
      bindAdministrativeElection(source, "public", await inspectAdministrativeElection(candidates, { instantPrimaryProof }), async () => {});
      const plan = (await prepareOwnerConsolidation({ source, candidates, target: "T", tenantId: "public", userContext: {} }))!;
      fetchUserInfo.mockClear();
      await plan.execute();
      expect(fetchUserInfo).toHaveBeenCalledTimes(2);
      await plan.beginMethodReconciliation();
      expect(fetchUserInfo).toHaveBeenCalledTimes(2);
      await plan.assertOwners(true);
      expect(fetchUserInfo).toHaveBeenCalledTimes(4);
      await plan.assertOwners(true);
      expect(fetchUserInfo).toHaveBeenCalledTimes(4);
      // Even a non-policy metadata write must end reuse of the earlier evidence.
      await reconciliationUserMetadata.updateUserMetadata("D", { preference: "kept" });
      if (mode === "drift") profiles.get("older")!.auth_level = "verified";
      if (mode === "drift") await expect(plan.assertOwners(true)).rejects.toThrow("Instant primary source evidence changed");
      else await plan.assertOwners(true);
      expect(fetchUserInfo).toHaveBeenCalledTimes(6);
    });
  });

  function singleAppleOwner() {
    recipes = new Map([["T", { id: "T", owner: "T", primary: false, verified: false,
      thirdParty: { id: "apple", userId: "apple-subject" } }]]);
    mappings = new Map([["T", "older"]]);
    profiles = new Map([
      ["older", { data: { user_id: "older", apple_id: "apple-subject" } }],
      ["newer", { data: { user_id: "newer", apple_id: "apple-subject" }, meta: { last_active: "2025-11-20T07:57:01.703Z" } }],
    ]);
    metadata = new Map([
      ["T", { original_rownd_user: structuredClone(profiles.get("older")), preference: "keep" }],
      ["older", { rownd_migration_canonical_target: "T", preference: "literal" }],
    ]);
  }

  it("retires a single Apple owner's alias for an ownerless winner, preserving the immutable recipe", async () => {
    singleAppleOwner();
    const plan = await prepare(true, "newer", ["T"]);
    expect(writes).toEqual([]);
    expect(plan.proposedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "remove_mapping", rownd_user_id: "older" }),
      expect.objectContaining({ action: "create_mapping", rownd_user_id: "newer", supertokens_user_id: "T" }),
    ]));
    await plan.execute();
    await plan.beginMethodReconciliation();
    await plan.complete();
    expect([...recipes.values()]).toEqual([{ id: "T", owner: "T", primary: true, verified: false,
      thirdParty: { id: "apple", userId: "apple-subject" } }]);
    expect([...mappings]).toEqual([["T", "newer"]]);
    expect(metadata.get("T")).toMatchObject({ original_rownd_user: profiles.get("newer"), preference: "keep" });
    expect(metadata.get("older")).toMatchObject({ preference: "literal",
      rownd_migration_superseded: { rowndUserId: "newer", targetUserId: "T" } });
    const checkpoint = readOwnerPlanCheckpoint(metadata.get("T")!)!;
    expect(checkpoint.retiredAliases).toEqual([{ id: "older", from: "T" }]);
    expect(checkpoint.initial.markers.find(({ id }) => id === "T")?.values.original_rownd_user).toEqual(profiles.get("older"));
    await expect(assertMigrationSourceActive("older", {})).rejects.toThrow("superseded");
    await expect(assertConsolidationSessionMembership("newer", "newer", "public", {})).resolves.toBeUndefined();
    await expect(assertConsolidationSessionMembership("older", "T", "public", {})).rejects.toThrow();
    const count = writes.length;
    const retry = await prepare(true, "newer", ["T"]);
    await retry.execute();
    await retry.complete();
    expect(writes).toHaveLength(count);
    metadata.get("older")!.rownd_migration_superseded = { rowndUserId: "other", targetUserId: "T" };
    await expect(plan.assertOwners()).rejects.toThrow("literal metadata changed");
  });

  it.each(["retirement", "delete", "create"])("resumes a single-recipe alias retirement after a lost %s response", async (phase) => {
    singleAppleOwner();
    let lost = false;
    const update = vi.mocked(UserMetadata.updateUserMetadata).getMockImplementation()!;
    vi.mocked(UserMetadata.updateUserMetadata).mockImplementation(async (...args) => {
      const result = await update(...args);
      if (!lost && phase === "retirement" && args[1].rownd_migration_superseded) {
        lost = true;
        throw new Error("Lost response");
      }
      return result;
    });
    const remove = vi.mocked(SuperTokens.deleteUserIdMapping).getMockImplementation()!;
    vi.mocked(SuperTokens.deleteUserIdMapping).mockImplementation(async (...args) => {
      expect(metadata.get("older")?.rownd_migration_superseded).toEqual({ rowndUserId: "newer", targetUserId: "T" });
      const result = await remove(...args);
      if (!lost && phase === "delete") { lost = true; throw new Error("Lost response"); }
      return result;
    });
    const create = vi.mocked(SuperTokens.createUserIdMapping).getMockImplementation()!;
    vi.mocked(SuperTokens.createUserIdMapping).mockImplementation(async (...args) => {
      const result = await create(...args);
      if (!lost && phase === "create") { lost = true; throw new Error("Lost response"); }
      return result;
    });
    await expect((await prepare(true, "newer", ["T"])).execute()).rejects.toThrow("Lost response");
    const retry = await prepare(true, "newer", ["T"]);
    await retry.execute();
    await retry.beginMethodReconciliation();
    await retry.complete();
    expect([...mappings]).toEqual([["T", "newer"]]);
    expect(writes.filter((write) => write === "delete:older")).toHaveLength(1);
    expect(writes.filter((write) => write === "map:newer:T")).toHaveLength(1);
    await expect(assertMigrationSourceActive("older", {})).rejects.toThrow("superseded");
  });

  it.each(["mapping", "literal owner", "missing tombstone", "changed provenance"])("rejects completed retirement drift: %s", async (drift) => {
    singleAppleOwner();
    const plan = await prepare(true, "newer", ["T"]);
    await plan.execute();
    await plan.beginMethodReconciliation();
    await plan.complete();
    if (drift === "mapping") mappings.set("outside", "older");
    else if (drift === "literal owner") recipes.set("older", { id: "older", owner: "older", primary: false, verified: false });
    else {
      const checkpoint = metadata.get("T")![OWNER_PLAN_KEY];
      if (drift === "missing tombstone") {
        const operation = checkpoint.operations.find((op: JsonRecord) => op.kind === "metadata" && op.id === "older");
        delete operation.values.rownd_migration_superseded;
      } else checkpoint.retiredAliases[0].from = "outside";
      expect(() => readOwnerPlanCheckpoint(metadata.get("T")!)).toThrow("Invalid duplicate owner consolidation plan");
    }
    await expect(plan.assertOwners()).rejects.toThrow();
  });

  it("admits an engine provider introduction only for the recorded recipe and current subject", async () => {
    profiles.get("newer")!.data.google_id = "new-subject";
    const candidates = [{ rownd_user_id: "older", supertokens_user_id: "T" }, { rownd_user_id: "newer", supertokens_user_id: "D" }];
    const source = (await fetchAdministrativeMigrationSource("newer", "public", {}))!;
    const plan = (await prepareOwnerConsolidation({ source, candidates, target: "T", ownerIds: ["T", "D"], tenantId: "public", userContext: {} }))!;
    bindAdministrativeElection(source, "public", await inspectAdministrativeElection(candidates), () => plan.assertOwners());
    await plan.execute();
    await plan.beginMethodReconciliation();
    const provider = source.loginMethods.find((method) => method.recipeId === "thirdparty")!;
    recipes.set("created", { id: "created", owner: "created", primary: false, email: provider.email, verified: false, thirdParty: { id: "google", userId: "new-subject" } });
    await recordAdministrativeMethodCreation(source, "created");
    const entry = { recipeUserId: "created", rowndUserId: "newer", internalUserId: "T", tenantId: "public", provider: "google", subject: "new-subject", created: true };
    await UserMetadata.updateUserMetadata("T", { rownd_migration_provider_introductions: [entry] });
    await expect(plan.assertOwners()).resolves.toBeUndefined();
    await UserMetadata.updateUserMetadata("T", { rownd_migration_provider_introductions: [{ ...entry, subject: "unexpected" }] });
    await expect(plan.assertOwners()).rejects.toThrow(/unexpected provider introduction/);
  });

  it("admits only a privately recorded new email recipe and resumes its pending link", async () => {
    recipes.get("T")!.thirdParty = { id: "google", userId: "subject" };
    profiles.get("newer")!.data.google_id = "subject";
    const candidates = [{ rownd_user_id: "older", supertokens_user_id: "T" }, { rownd_user_id: "newer", supertokens_user_id: "D" }];
    const source = (await fetchAdministrativeMigrationSource("newer", "public", {}))!;
    const plan = (await prepareOwnerConsolidation({ source, candidates, target: "T", ownerIds: ["T", "D"], tenantId: "public", userContext: {} }))!;
    bindAdministrativeElection(source, "public", await inspectAdministrativeElection(candidates), () => plan.assertOwners());
    await plan.execute();
    await plan.beginMethodReconciliation();
    recipes.set("created", { id: "created", owner: "created", primary: false, email, verified: false });
    await expect(plan.assertOwners()).rejects.toThrow(/unplanned exact-email/);
    await recordAdministrativeMethodCreation(source, "created");
    expect(readOwnerPlanCheckpoint(metadata.get("T")!)?.createdRecipes).toEqual([expect.objectContaining({ id: "created" })]);
    await expect(plan.assertOwners()).resolves.toBeUndefined();
    expect(metadata.get("created")?.rownd_migration_owner_consolidation).toBeUndefined();
    await expect(assertConsolidationSessionMembership("created", "created", "public", {})).resolves.toBeUndefined();
    const retry = await prepare();
    await retry.beginMethodReconciliation();
    await AccountLinking.linkAccounts(SuperTokens.convertToRecipeUserId("created"), "newer");
    await retry.complete();
    await expect(assertConsolidationSessionMembership("newer", "created", "public", {})).resolves.toBeUndefined();
  });

  it("previews without writes and dissolves a primary donor secondary-first, preserving both aliases", async () => {
    const plan = await prepare();
    expect(writes).toEqual([]);
    expect(plan.proposedActions).toEqual(expect.arrayContaining([expect.objectContaining({ action: "unlink_method", recipeUserId: "D2" }),
      expect.objectContaining({ action: "remove_mapping", rownd_user_id: "newer" })]));
    await plan.execute();
    await plan.beginMethodReconciliation();
    await plan.complete();
    expect(writes.filter((write) => write.startsWith("detach:"))).toEqual(["detach:D2", "detach:D"]);
    expect([...recipes.keys()].sort()).toEqual(["D", "D2", "T"]);
    expect([...recipes.values()].every((recipe) => recipe.owner === "T")).toBe(true);
    expect(mappings.get("T")).toBe("newer");
    expect(mappings.get("D")).toBe("older");
    expect(metadata.get("newer")?.rownd_migration_canonical_target).toBe("T");
    expect(metadata.get("older")?.rownd_migration_canonical_target).toBe("D");
    await expect(assertConsolidationSessionMembership("newer", "older", "public", {})).resolves.toBeUndefined();
    sessions.add("D2");
    const count = writes.length;
    const retry = await prepare();
    expect(retry.proposedActions).toEqual([]);
    await retry.execute();
    await retry.beginMethodReconciliation();
    await retry.complete();
    expect(writes).toHaveLength(count);
  });

  it.each(["T", "D", "D2"])("allows existing sessions on %s during read-only preparation", async (id) => {
    sessions.add(id);
    await expect(prepare()).resolves.toBeDefined();
    expect(writes).toEqual([]);
    expect([...sessions]).toEqual([id]);
  });

  it("requires a privately bound election before the first checkpoint write", async () => {
    const plan = await prepare(false);
    await expect(plan.execute()).rejects.toThrow("private election binding");
    expect(writes).toEqual([]);
  });

  it.each(["unknown canonical", "pending", "committing", "email retirement", "provider retirement"])(
    "blocks owner transitions over deliberate native state: %s", async (state) => {
      const values: JsonRecord = state === "unknown canonical" ? { rownd_email_recipe_user_ids: { public: "missing" } } :
        state === "email retirement" ? { rownd_migration_email_retirements: { public: { planId: "unfinished" } } } :
          state === "provider retirement" ? { rownd_migration_provider_retirements: [{ recipeUserId: "D2" }] } :
            { rownd_pending_verification: [{ id: "native", field: "email", value: email, created_at: "2020-01-01", status: state === "pending" ? "PENDING" : "COMMITTING" }] };
      metadata.set("D", { ...metadata.get("D"), ...values });
      await expect(prepare()).rejects.toThrow("CANONICAL_EMAIL_POLICY");
      expect(writes).toEqual([]);
    });

  it("snapshots native canonical policy and blocks a raced pending verification before reparenting", async () => {
    metadata.set("T", { ...metadata.get("T"), rownd_email_recipe_user_ids: { public: "T" } });
    const plan = await prepare();
    const original = vi.mocked(UserMetadata.updateUserMetadata).getMockImplementation()!;
    vi.mocked(UserMetadata.updateUserMetadata).mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      metadata.set("D2", { ...metadata.get("D2"), rownd_pending_verification: [
        { id: "native", field: "email", value: email, created_at: "2020-01-01", status: "PENDING" },
      ] });
      return result;
    });
    await expect(plan.execute()).rejects.toThrow("Rownd activity election changed");
    expect(readOwnerPlanCheckpoint(metadata.get("T")!)!.initial.markers.find((entry) => entry.id === "T")?.values)
      .toMatchObject({ rownd_email_recipe_user_ids: { public: "T" } });
    expect(writes.filter((write) => /^(detach|link|delete|map):/.test(write))).toEqual([]);
  });

  it("ignores an unrelated native provider's incidental email during discovery freshness", async () => {
    recipes.set("A", { id: "A", owner: "A", primary: false, email, verified: false, thirdParty: { id: "apple", userId: "unrelated" } });
    sessions.add("A");
    const plan = await prepare();
    await plan.execute();
    await plan.beginMethodReconciliation();
    await plan.complete();
    expect(recipes.get("A")?.owner).toBe("A");
    expect(plan.plannedOwnerIds.has("A")).toBe(false);
    expect(writes).not.toContain("link:A");
  });

  it("rejects a supplied native provider owner with only incidental email proof", async () => {
    recipes.set("A", { id: "A", owner: "A", primary: false, email, verified: false, thirdParty: { id: "apple", userId: "unrelated" } });
    await expect(prepare(true, "newer", ["T", "D", "A"])).rejects.toThrow("lacks current exact identity proof");
    expect(writes).toEqual([]);
  });

  it.each(["mapping", "self-ID"])("blocks an ownerless losing candidate acquiring a %s before writes", async (kind) => {
    profiles.set("ownerless", { data: { user_id: "ownerless", email }, meta: { last_active: "2019-01-01T00:00:00Z" } });
    const plan = await prepare();
    if (kind === "mapping") mappings.set("D2", "ownerless");
    else recipes.set("ownerless", { id: "ownerless", owner: "ownerless", primary: false, phoneNumber: "+12025550199", verified: false });
    await expect(plan.assertOwners()).rejects.toThrow("ownerless consolidation candidate acquired an owner");
    await expect(plan.execute()).rejects.toThrow("Rownd activity election changed");
    expect(writes).toEqual([]);
  });

  it("blocks an ownerless losing candidate gaining an owner after reservation", async () => {
    profiles.set("ownerless", { data: { user_id: "ownerless", email }, meta: { last_active: "2019-01-01T00:00:00Z" } });
    const plan = await prepare();
    const original = vi.mocked(UserMetadata.updateUserMetadata).getMockImplementation()!;
    vi.mocked(UserMetadata.updateUserMetadata).mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      mappings.set("D2", "ownerless");
      return result;
    });
    await expect(plan.execute()).rejects.toThrow("Rownd activity election changed");
    expect(writes.filter((write) => /^(detach|link|delete|map):/.test(write))).toEqual([]);
  });

  it.each(["before reservation", "after reservation"])("blocks a newly appeared native exact-email owner %s", async (timing) => {
    const plan = await prepare();
    const addOwner = () => recipes.set("N", { id: "N", owner: "N", primary: false, email, verified: false });
    if (timing === "before reservation") addOwner();
    else {
      const original = vi.mocked(UserMetadata.updateUserMetadata).getMockImplementation()!;
      vi.mocked(UserMetadata.updateUserMetadata).mockImplementationOnce(async (...args) => {
        const result = await original(...args);
        addOwner();
        return result;
      });
    }
    if (timing === "before reservation") await expect(plan.assertOwners()).rejects.toThrow("an unplanned exact-email owner appeared");
    await expect(plan.execute()).rejects.toThrow("Rownd activity election changed");
    expect(writes.filter((write) => /^(detach|link|delete|map):/.test(write))).toEqual([]);
    if (timing === "before reservation") expect(writes).toEqual([]);
  });

  it("allows sessions on an exact current provider without enrolling it in consolidation", async () => {
    profiles.get("newer")!.data.google_id = "current-google";
    recipes.set("G", { id: "G", owner: "G", primary: false, email: "provider@example.test", verified: false, thirdParty: { id: "google", userId: "current-google" } });
    sessions.add("G");
    await expect(prepare()).resolves.toBeDefined();
    expect(writes).toEqual([]);
    sessions.clear();
    const plan = await prepare();
    expect(plan.plannedOwnerIds.has("G")).toBe(false);
  });

  it.each(["before", "after"])("resumes an interrupted mapping response %s the Core write", async (timing) => {
    const plan = await prepare();
    const original = vi.mocked(SuperTokens.deleteUserIdMapping).getMockImplementation()!;
    vi.mocked(SuperTokens.deleteUserIdMapping).mockImplementationOnce(async (input) => {
      if (timing === "after") await original(input);
      throw new Error("lost mapping response");
    });
    await expect(plan.execute()).rejects.toThrow("lost mapping response");
    await expect(assertConsolidationSessionMembership(external("T"), external("D"), "public", {})).rejects.toThrow(/consolidation/i);
    const checkpoint = readOwnerPlanCheckpoint(metadata.get("T")!)!;
    expect(checkpoint.status).toBe("APPLYING");
    expect(checkpoint.operations[checkpoint.cursor]?.kind).toBe("delete_mapping");
    const retry = await prepare();
    await retry.execute();
    await retry.beginMethodReconciliation();
    await retry.complete();
    expect(mappings.get("T")).toBe("newer");
    expect(writes.filter((write) => write === "detach:D")).toHaveLength(1);
  });

  it("does not advance a cursor when Core acknowledges a transition without applying it", async () => {
    const plan = await prepare();
    vi.mocked(AccountLinking.unlinkAccount).mockResolvedValueOnce({ status: "OK", wasLinked: true, wasRecipeUserDeleted: false });
    await expect(plan.execute()).rejects.toThrow("postcondition");
    expect(readOwnerPlanCheckpoint(metadata.get("T")!)).toMatchObject({ status: "APPLYING", cursor: 0 });
    const retry = await prepare();
    await retry.execute();
    expect(recipes.get("D2")?.owner).toBe("T");
  });

  it("rejects literal source marker drift before remapping", async () => {
    const plan = await prepare();
    metadata.set("newer", { rownd_migration_canonical_target: "T" });
    await expect(plan.execute()).rejects.toThrow();
    expect(writes).toEqual([]);
  });

  it("retains every secondary recipe's unverified baseline across an interrupted link", async () => {
    const plan = await prepare();
    const original = vi.mocked(AccountLinking.linkAccounts).getMockImplementation()!;
    vi.mocked(AccountLinking.linkAccounts).mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      verify("D2", true);
      return result;
    });
    await expect(plan.execute()).rejects.toThrow();
    expect(readOwnerPlanCheckpoint(metadata.get("T")!)?.recipes).toContainEqual(expect.objectContaining({ id: "D2", verified: false }));
    await expect(prepare()).rejects.toThrow();
  });

  it("rejects revoked baseline verification before writes", async () => {
    verify("D2", true);
    const plan = await prepare();
    verify("D2", false);
    await expect(plan.execute()).rejects.toThrow();
    expect(writes).toEqual([]);
  });

  it("allows sessions that appear during execution and never revokes them", async () => {
    const plan = await prepare();
    const original = vi.mocked(UserMetadata.updateUserMetadata).getMockImplementation()!;
    vi.mocked(UserMetadata.updateUserMetadata).mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      sessions.add("D2");
      return result;
    });
    await expect(plan.execute()).resolves.toBeUndefined();
    expect(writes.filter((write) => /^(detach|link|delete|map):/.test(write)).length).toBeGreaterThan(0);
    expect([...sessions]).toEqual(["D2"]);
  });

  it("starts a fresh canonical-alias plan after a later source election on a completed owner", async () => {
    const plan = await prepare();
    await plan.execute();
    await plan.beginMethodReconciliation();
    await plan.complete();
    profiles.get("older")!.meta = { last_active: "2021-01-01T00:00:00Z" };
    const newerElection = await prepare(true, "older");
    await newerElection.execute();
    await newerElection.beginMethodReconciliation();
    await newerElection.complete();
    expect(mappings.get("T")).toBe("older");
    expect(mappings.get("D")).toBe("newer");
  });

  it("preserves a previously verified immutable credential across force-remapping without Rownd verification proof", async () => {
    verify("T", true);
    const plan = await prepare();
    await plan.execute();
    await plan.beginMethodReconciliation();
    await plan.complete();
    expect(userFor("T")!.loginMethods.find((method) => method.recipeUserId.getAsString() === "newer")?.verified).toBe(true);
    expect(writes).toContain("verify:newer");
    expect(writes.indexOf(`revoke-verification:newer:${email}`)).toBeLessThan(writes.indexOf("map:newer:T"));
  });

  it("does not dissolve a primary donor on shared-provider proof without a shared current email", async () => {
    profiles.get("newer")!.data.google_id = "shared-google";
    profiles.get("older")!.data.google_id = "shared-google";
    profiles.get("older")!.data.email = "different@example.test";
    mappings.set("T", "newer");
    mappings.set("D", "older");
    recipes.get("D")!.thirdParty = { id: "google", userId: "shared-google" };
    recipes.get("D")!.email = "historical-provider@example.test";
    delete recipes.get("D")!.phoneNumber;
    metadata.set("T", { original_rownd_user: structuredClone(profiles.get("newer")!) });
    metadata.set("D", { original_rownd_user: structuredClone(profiles.get("older")!) });
    metadata.set("newer", { rownd_migration_canonical_target: "T" });
    metadata.set("older", { rownd_migration_canonical_target: "D" });
    await expect(prepare()).rejects.toThrow("primary donor merging requires a shared current exact email");
    expect(writes).toEqual([]);
  });

  it("blocks alias-induced verification from a stale destination cell during preview", async () => {
    recipes.delete("D2");
    recipes.get("D")!.email = "other@example.test";
    recipes.get("D")!.owner = "T";
    delete recipes.get("D")!.phoneNumber;
    mappings.delete("D");
    metadata.delete("newer");
    profiles.get("newer")!.data.phone_number = undefined;
    // No linking is needed. Only the alias move could expose this stale cell.
    verify("T", true);
    verifications.set("older:other@example.test", true);
    profiles.get("newer")!.verified_data = { email: true };
    await expect(prepare()).rejects.toThrow(/verify an unverified/);
    expect(writes).toEqual([]);
  });

  it.each(["empty completion", "missing donor", "separate graph", "missing marker", "wrong identity"])(
    "blocks malformed completed checkpoints: %s", async (kind) => {
      const plan = await prepare();
      await plan.execute();
      await plan.beginMethodReconciliation();
      await plan.complete();
      const checkpoint = structuredClone(readOwnerPlanCheckpoint(metadata.get("T")!)!);
      if (kind === "empty completion") checkpoint.completion = { recipes: [], state: { graph: [], mappings: [], markers: [], verifications: [] } };
      if (kind === "missing donor") checkpoint.completion!.recipes = checkpoint.completion!.recipes.filter((recipe) => recipe.id !== "D2");
      if (kind === "separate graph") checkpoint.completion!.state.graph.find((entry) => entry.id === "D2")!.owner = "D2";
      if (kind === "missing marker") checkpoint.completion!.state.markers = [];
      if (kind === "wrong identity") checkpoint.completion!.recipes.find((recipe) => recipe.id === "D2")!.identity = "forged";
      metadata.set("T", { ...metadata.get("T"), [OWNER_PLAN_KEY]: checkpoint });
      await expect(assertConsolidationSessionMembership("newer", "older", "public", {})).rejects.toThrow(/Invalid/);
    });
});

it("rejects primary-first detach even in a tampered durable operation sequence", async () => {
  const plan = await prepare();
  const write = vi.mocked(AccountLinking.unlinkAccount);
  write.mockRejectedValueOnce(new Error("interrupted"));
  await expect(plan.execute()).rejects.toThrow("interrupted");
  const checkpoint = readOwnerPlanCheckpoint(metadata.get("T")!)!;
  expect(() => applyOwnerOperation(checkpoint.initial, { kind: "detach", id: "D" }, "T")).toThrow(/Invalid/);
  expect(readOwnerPlanCheckpoint({ [OWNER_PLAN_KEY]: { version: 1 } })).toBeUndefined();
  expect(() => readOwnerPlanCheckpoint({ [OWNER_PLAN_KEY]: { version: 2 } })).toThrow(/Invalid/);
});

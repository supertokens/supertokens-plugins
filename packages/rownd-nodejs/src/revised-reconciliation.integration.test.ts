import express from "express";
import { createHash, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import SuperTokens from "supertokens-node";
import AccountLinking from "supertokens-node/recipe/accountlinking";
import Passwordless from "supertokens-node/recipe/passwordless";
import EmailVerification from "supertokens-node/recipe/emailverification";
import EmailPassword from "supertokens-node/recipe/emailpassword";
import Session from "supertokens-node/recipe/session";
import ThirdParty from "supertokens-node/recipe/thirdparty";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import Multitenancy from "supertokens-node/recipe/multitenancy";
import { middleware, errorHandler } from "supertokens-node/framework/express";
import { ProcessState } from "supertokens-node/lib/build/processState";
import { Querier } from "supertokens-node/lib/build/querier";
import SuperTokensRaw from "supertokens-node/lib/build/supertokens";
import AccountLinkingRaw from "supertokens-node/lib/build/recipe/accountlinking/recipe";
import EmailPasswordRaw from "supertokens-node/lib/build/recipe/emailpassword/recipe";
import EmailVerificationRaw from "supertokens-node/lib/build/recipe/emailverification/recipe";
import MultitenancyRaw from "supertokens-node/lib/build/recipe/multitenancy/recipe";
import PasswordlessRaw from "supertokens-node/lib/build/recipe/passwordless/recipe";
import SessionRaw from "supertokens-node/lib/build/recipe/session/recipe";
import ThirdPartyRaw from "supertokens-node/lib/build/recipe/thirdparty/recipe";
import UserMetadataRaw from "supertokens-node/lib/build/recipe/usermetadata/recipe";
import UserRolesRaw from "supertokens-node/lib/build/recipe/userroles/recipe";
import { GenericContainer, Network, Wait } from "testcontainers";
import type { StartedNetwork, StartedTestContainer } from "testcontainers";
import { init } from "./plugin";
import { reconcileUser, type ReconcileUserInput } from "./reconcile-user";
import type { RowndUser } from "./types";
import { setRowndClient } from "./rownd-repository";

const rownd = { validateToken: vi.fn(), fetchUserInfo: vi.fn() };
vi.mock("@rownd/node", () => ({ createInstance: () => rownd }));

const OLD = "2020-01-01T00:00:00.000Z";
const MID = "2020-06-01T00:00:00.000Z";
const NEW = "2021-01-01T00:00:00.000Z";
let phoneSequence = 0;

type CoreUser = NonNullable<Awaited<ReturnType<typeof SuperTokens.getUser>>>;
type PwlOwner = { internalId: string; recipeIds: string[] };

function resetST() {
  ProcessState.getInstance().reset();
  SessionRaw.reset();
  UserMetadataRaw.reset();
  UserRolesRaw.reset();
  AccountLinkingRaw.reset();
  EmailPasswordRaw.reset();
  PasswordlessRaw.reset();
  ThirdPartyRaw.reset();
  EmailVerificationRaw.reset();
  MultitenancyRaw.reset();
  SuperTokensRaw.reset();
  Querier.reset();
}

function uniqueEmail(prefix: string) {
  return `${prefix}-${randomUUID()}@example.com`;
}

function uniquePhone() {
  return `+1555${String(++phoneSequence).padStart(7, "0")}`;
}

function verifiedProfile(userId: string, input: {
  email?: string;
  phoneNumber?: string;
  googleId?: string;
  activity?: string;
}): RowndUser {
  const data: RowndUser["data"] = { user_id: userId };
  const verified: RowndUser["verified_data"] = {};
  if (input.email) {
    data.email = input.email;
    verified.email = true;
  }
  if (input.phoneNumber) {
    data.phone_number = input.phoneNumber;
    verified.phone_number = true;
  }
  if (input.googleId) {
    data.google_id = input.googleId;
    verified.google_id = input.googleId;
  }
  return {
    state: "enabled",
    auth_level: "verified",
    data,
    verified_data: verified,
    ...(input.activity ? { meta: { last_active: input.activity } } : {}),
  };
}

async function mapAlias(internalId: string, alias: string) {
  const result = await SuperTokens.createUserIdMapping({ superTokensUserId: internalId, externalUserId: alias, force: true });
  if (result.status !== "OK") throw new Error(`Failed to map ${alias}: ${result.status}`);
}

async function setSnapshot(internalId: string, profile: RowndUser) {
  await UserMetadata.updateUserMetadata(internalId, { original_rownd_user: profile, rownd_migration_complete: true });
}

async function verifyEmail(sdkId: string, email: string) {
  // EmailVerification keys use the effective alias after a mapping is published.
  const recipeId = SuperTokens.convertToRecipeUserId(sdkId);
  const token = await EmailVerification.createEmailVerificationToken("public", recipeId, email);
  if (token.status === "OK") expect(await EmailVerification.verifyEmailUsingToken("public", token.token)).toMatchObject({ status: "OK" });
  expect(await EmailVerification.isEmailVerified(recipeId, email)).toBe(true);
}

async function createPwlOwner(input: {
  email?: string;
  phoneNumber?: string;
  primary?: boolean;
  extras?: Array<{ phoneNumber: string }>;
}): Promise<PwlOwner> {
  const signIn = await Passwordless.signInUp({ tenantId: "public", ...(input.email ? { email: input.email } : { phoneNumber: input.phoneNumber! }) });
  const internalId = signIn.user.id;
  const recipeUserId = signIn.recipeUserId;
  const recipeIds = [recipeUserId.getAsString()];
  if (input.primary) {
    const created = await AccountLinking.createPrimaryUser(recipeUserId);
    if (created.status !== "OK") throw new Error(`Failed to promote owner: ${created.status}`);
  }
  for (const extra of input.extras ?? []) {
    const extraSignIn = await Passwordless.signInUp({ tenantId: "public", phoneNumber: extra.phoneNumber });
    const linked = await AccountLinking.linkAccounts(extraSignIn.recipeUserId, internalId);
    if (linked.status !== "OK") throw new Error(`Failed to link extra method: ${linked.status}`);
    recipeIds.push(extraSignIn.recipeUserId.getAsString());
  }
  return { internalId, recipeIds };
}

async function expectMapped(alias: string, internalId: string) {
  expect(await SuperTokens.getUserIdMapping({ userId: alias, userIdType: "EXTERNAL" })).toMatchObject({
    status: "OK", superTokensUserId: internalId,
  });
  expect(await SuperTokens.getUserIdMapping({ userId: internalId, userIdType: "SUPERTOKENS" })).toMatchObject({
    status: "OK", externalUserId: alias,
  });
}

async function immutableRecipeId(sdkId: string) {
  const mapping = await SuperTokens.getUserIdMapping({ userId: sdkId, userIdType: "EXTERNAL" });
  return mapping.status === "OK" ? mapping.superTokensUserId : sdkId;
}

async function recipeIdentities(user: CoreUser) {
  return (await Promise.all(user.loginMethods.map(async (method) => ({
    id: await immutableRecipeId(method.recipeUserId.getAsString()),
    recipeId: method.recipeId, email: method.email, phoneNumber: method.phoneNumber,
    thirdParty: method.thirdParty, tenantIds: [...method.tenantIds].sort(), timeJoined: method.timeJoined,
  })))).sort((a, b) => a.id.localeCompare(b.id));
}

async function captureRecipes(owners: PwlOwner[]) {
  const identities = (await Promise.all(owners.map(async ({ internalId }) => {
    const user = await SuperTokens.getUser(internalId);
    expect(user).toBeDefined();
    return recipeIdentities(user!);
  }))).flat();
  expect(new Set(identities.map(({ id }) => id)).size).toBe(identities.length);
  return identities.sort((a, b) => a.id.localeCompare(b.id));
}

async function expectGraph(target: string, canonicalId: string, aliases: string[], recipes: Awaited<ReturnType<typeof captureRecipes>>) {
  await expectMapped(canonicalId, target);
  const user = (await SuperTokens.getUser(canonicalId))!;
  expect(user).toMatchObject({ id: canonicalId, isPrimaryUser: true });
  expect(await recipeIdentities(user)).toEqual(recipes);
  const mappedRecipes = new Set<string>();
  for (const alias of new Set([canonicalId, ...aliases])) {
    const mapping = await SuperTokens.getUserIdMapping({ userId: alias, userIdType: "EXTERNAL" });
    expect(mapping, alias).toMatchObject({ status: "OK" });
    if (mapping.status !== "OK") throw new Error("Alias disappeared");
    expect(recipes.map(({ id }) => id)).toContain(mapping.superTokensUserId);
    expect(mappedRecipes.has(mapping.superTokensUserId)).toBe(false);
    mappedRecipes.add(mapping.superTokensUserId);
    await expectMapped(alias, mapping.superTokensUserId);
    expect((await SuperTokens.getUser(alias))?.id).toBe(canonicalId);
  }
  for (const { id } of recipes) {
    expect((await SuperTokens.getUser(id))?.id, id).toBe(canonicalId);
  }
  return user;
}

describe("revised reconciliation separates the canonical Rownd profile from the surviving Core owner", { timeout: 30000, sequential: true }, () => {
  it("reconciles a single source and two-method primary with missing mapping using one discovery profile read", async () => {
    const rowndId = `performance-${randomUUID()}`;
    const email = uniqueEmail("performance");
    const owner = await createPwlOwner({ email, primary: true, extras: [{ phoneNumber: uniquePhone() }] });
    const profile = verifiedProfile(rowndId, { email });
    await setSnapshot(owner.internalId, profile);
    rownd.fetchUserInfo.mockImplementation(async ({ user_id }) => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return user_id === rowndId ? profile : undefined;
    });
    const getUser = vi.spyOn(SuperTokens, "getUser");
    const getMapping = vi.spyOn(SuperTokens, "getUserIdMapping");
    const getMetadata = vi.spyOn(UserMetadata, "getUserMetadata");
    const search = vi.spyOn(SuperTokens, "listUsersByAccountInfo");
    const writes = vi.spyOn(UserMetadata, "updateUserMetadata");
    const transport = await import("supertokens-node/lib/build/querier");
    const fetchCore = transport.doFetch;
    const requests = vi.spyOn(transport, "doFetch").mockImplementation(async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return fetchCore(...args);
    });
    let discoveryReads = 0;
    const result = await reconcileUser({ rownd_user_id: rowndId, onProgress: ({ stage }) => {
      if (stage === "execution" && !discoveryReads) discoveryReads = rownd.fetchUserInfo.mock.calls.length;
    } });
    expect(result, JSON.stringify(result)).toMatchObject({ status: "OK", supertokens_user_id: owner.internalId });
    expect(discoveryReads).toBe(1);
    expect(rownd.fetchUserInfo).toHaveBeenCalledTimes(2);
    expect(writes.mock.calls.some(([, values]) => values.rownd_migration_owner_consolidation !== undefined)).toBe(false);
    const counts = { users: getUser.mock.calls.length, mappings: getMapping.mock.calls.length, metadata: getMetadata.mock.calls.length, searches: search.mock.calls.length };
    const network = { reads: requests.mock.calls.filter(([, options]) => options?.method === "GET").length,
      writes: requests.mock.calls.filter(([, options]) => options?.method !== "GET").length };
    console.info("single-owner reconciliation request counts", { sdk: counts, network });
    expect(counts).toEqual({ users: 12, mappings: 22, metadata: 9, searches: 2 });
    expect(network).toEqual({ reads: 51, writes: 6 });
    await expectMapped(rowndId, owner.internalId);
    expect((await SuperTokens.getUser(rowndId))?.loginMethods).toHaveLength(2);
    expect(await EmailVerification.isEmailVerified(SuperTokens.convertToRecipeUserId(rowndId), email)).toBe(true);
    expect((await UserMetadata.getUserMetadata(owner.internalId)).metadata).toMatchObject({ original_rownd_user: profile, rownd_migration_complete: true });
  });

  it("rejects stale literal alias verification before a fresh unverified import", async () => {
    const rowndId = `fresh-${randomUUID()}`;
    const email = uniqueEmail("fresh-stale");
    const profile: RowndUser = { data: { user_id: rowndId, email }, verified_data: {} };
    rownd.fetchUserInfo.mockImplementation(async ({ user_id }) => user_id === rowndId ? profile : undefined);
    await verifyEmail(rowndId, email);
    const writes = await spyOnAuthWrites();
    for (const dryRun of [true, false]) {
      const result = await expectNoWrites(writes, () => reconcileUser({ rownd_user_id: rowndId, dryRun }));
      expect(result, JSON.stringify(result)).toMatchObject({ status: "BLOCKED", changed: false });
    }
    expect(await SuperTokens.getUser(rowndId)).toBeUndefined();
    expect(await SuperTokens.listUsersByAccountInfo("public", { email }, false)).toEqual([]);
  });

  it("rechecks fresh alias verification after import and before mapping", async () => {
    const rowndId = `fresh-${randomUUID()}`;
    const email = uniqueEmail("fresh-raced");
    const profile: RowndUser = { data: { user_id: rowndId, email }, verified_data: {} };
    rownd.fetchUserInfo.mockImplementation(async ({ user_id }) => user_id === rowndId ? profile : undefined);
    const repository = await import("./supertokens-repository");
    const original = repository.importUser;
    const imported = vi.spyOn(repository, "importUser").mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      await verifyEmail(rowndId, email);
      return result;
    });
    const mapping = vi.spyOn(SuperTokens, "createUserIdMapping");
    const result = await reconcileUser({ rownd_user_id: rowndId });
    expect(imported).toHaveBeenCalledOnce();
    expect(result, JSON.stringify(result)).toMatchObject({ status: "BLOCKED" });
    expect(mapping).not.toHaveBeenCalled();
    expect(await SuperTokens.getUser(rowndId)).toBeUndefined();
  });

  it.each([false, true])("validates destination verification during actual duplicate-import recovery (stale alias=%s)", async (stale) => {
    const rowndId = `fresh-duplicate-${randomUUID()}`;
    const email = uniqueEmail("fresh-duplicate");
    const profile: RowndUser = { data: { user_id: rowndId, email }, verified_data: {} };
    rownd.fetchUserInfo.mockImplementation(async ({ user_id }) => user_id === rowndId ? profile : undefined);
    const repository = await import("./supertokens-repository");
    const original = repository.importUser;
    vi.spyOn(repository, "importUser").mockImplementationOnce(async (...args) => {
      await original(...args);
      if (stale) await verifyEmail(rowndId, email);
      return original(...args);
    });
    const mapping = vi.spyOn(SuperTokens, "createUserIdMapping");
    const result = await reconcileUser({ rownd_user_id: rowndId });
    expect(result, JSON.stringify(result)).toMatchObject({ status: stale ? "BLOCKED" : "OK" });
    if (stale) {
      expect(mapping).not.toHaveBeenCalled();
      expect(await SuperTokens.getUser(rowndId)).toBeUndefined();
    } else expect((await SuperTokens.getUser(rowndId))!.loginMethods[0]).toMatchObject({ verified: false });
  });

  it.each([false, true])("fresh publication preserves exact verification intent across lost mapping response (verified=%s)", async (verified) => {
    const rowndId = `fresh-${randomUUID()}`;
    const email = uniqueEmail("fresh-lost");
    const profile: RowndUser = { data: { user_id: rowndId, email }, verified_data: { email: verified } };
    rownd.fetchUserInfo.mockImplementation(async ({ user_id }) => user_id === rowndId ? profile : undefined);
    if (verified) await verifyEmail(rowndId, email);
    const original = SuperTokens.createUserIdMapping.bind(SuperTokens);
    const mapping = vi.spyOn(SuperTokens, "createUserIdMapping").mockImplementationOnce(async (...args) => {
      expect(await original(...args)).toMatchObject({ status: "OK" });
      throw new Error("Lost fresh mapping response");
    });
    const first = await reconcileUser({ rownd_user_id: rowndId });
    expect(first, JSON.stringify(first)).toMatchObject({ status: "ERROR", message: "Lost fresh mapping response" });
    mapping.mockRestore();
    await restartSDK();
    expect(await reconcileUser({ rownd_user_id: rowndId })).toMatchObject({ status: "OK", supertokens_user_id: first.supertokens_user_id });
    expect((await SuperTokens.getUser(rowndId))!.loginMethods.find((method) => method.hasSameEmailAs(email))).toMatchObject({ verified });
  });

  it("rejects stale verification introduced after a lost fresh mapping response on retry", async () => {
    const rowndId = `fresh-${randomUUID()}`;
    const email = uniqueEmail("fresh-retry-stale");
    const profile: RowndUser = { data: { user_id: rowndId, email }, verified_data: {} };
    rownd.fetchUserInfo.mockImplementation(async ({ user_id }) => user_id === rowndId ? profile : undefined);
    const original = SuperTokens.createUserIdMapping.bind(SuperTokens);
    const mapping = vi.spyOn(SuperTokens, "createUserIdMapping").mockImplementationOnce(async (...args) => {
      expect(await original(...args)).toMatchObject({ status: "OK" });
      throw new Error("Lost fresh mapping response");
    });
    expect(await reconcileUser({ rownd_user_id: rowndId })).toMatchObject({ status: "ERROR" });
    mapping.mockRestore();
    await verifyEmail(rowndId, email);
    await restartSDK();
    const writes = await spyOnAuthWrites();
    for (const dryRun of [true, false]) {
      const result = await expectNoWrites(writes, () => reconcileUser({ rownd_user_id: rowndId, dryRun }));
      expect(result, JSON.stringify(result)).toMatchObject({ status: "BLOCKED", changed: false });
    }
  });

  it("recovers a lost fresh verification-baseline checkpoint response without importing another owner", async () => {
    const rowndId = `fresh-checkpoint-${randomUUID()}`;
    const email = uniqueEmail("fresh-checkpoint");
    const profile: RowndUser = { data: { user_id: rowndId, email }, verified_data: {} };
    rownd.fetchUserInfo.mockImplementation(async ({ user_id }) => user_id === rowndId ? profile : undefined);
    const update = UserMetadata.updateUserMetadata.bind(UserMetadata);
    let interrupted = false;
    const save = vi.spyOn(UserMetadata, "updateUserMetadata").mockImplementation(async (...args) => {
      const result = await update(...args);
      if (!interrupted && args[1].rownd_migration_mapping_publication) {
        interrupted = true;
        throw new Error("Lost publication checkpoint response");
      }
      return result;
    });
    const first = await reconcileUser({ rownd_user_id: rowndId });
    expect(first, JSON.stringify(first)).toMatchObject({ status: "ERROR", message: "Lost publication checkpoint response" });
    save.mockRestore();
    await restartSDK();
    const repository = await import("./supertokens-repository");
    const imported = vi.spyOn(repository, "importUser");
    expect(await reconcileUser({ rownd_user_id: rowndId })).toMatchObject({ status: "OK", supertokens_user_id: first.supertokens_user_id });
    expect(imported).not.toHaveBeenCalled();
    expect((await SuperTokens.getUser(rowndId))!.loginMethods[0]).toMatchObject({ verified: false });
  });

  it.each(["PENDING", "COMMITTING"])("blocks administrative canonical override with a %s native email change before writes", async (status) => {
    const emailB = uniqueEmail("native-b");
    const emailA = uniqueEmail("rownd-a");
    const owner = await createPwlOwner({ email: emailB });
    const rowndId = `canonical-${randomUUID()}`;
    await mapAlias(owner.internalId, rowndId);
    await verifyEmail(rowndId, emailB);
    await setSnapshot(owner.internalId, { data: { user_id: rowndId, email: emailB }, verified_data: { email: true } });
    await UserMetadata.updateUserMetadata(owner.internalId, { rownd_email_recipe_user_ids: { public: rowndId },
      rownd_pending_verification: [{ id: randomUUID(), field: "email", value: emailA, tenantId: "public",
        created_at: new Date().toISOString(), purpose: "UPDATE_PASSWORDLESS", status,
        ...(status === "COMMITTING" ? { targetCanonicalRecipeUserId: rowndId, retiredMethods: [] } : {}) }] });
    rownd.fetchUserInfo.mockImplementation(async ({ user_id }) => user_id === rowndId ? { data: { user_id: rowndId, email: emailA }, verified_data: { email: true } } : undefined);
    const writes = await spyOnAuthWrites();
    for (const dryRun of [true, false]) {
      const result = await expectNoWrites(writes, () => reconcileUser({ rownd_user_id: rowndId, dryRun }));
      expect(result, JSON.stringify(result)).toMatchObject({ status: "BLOCKED", changed: false });
    }
    expect((await SuperTokens.getUser(rowndId))!.loginMethods).toHaveLength(1);
    expect((await SuperTokens.getUser(rowndId))!.loginMethods[0]).toMatchObject({ email: emailB, verified: true });
  });

  it.each([false, true])("restores a proven mapping without losing immutable verification (lost publication response=%s)", async (lostResponse) => {
    const email = uniqueEmail("restore-baseline");
    const owner = await createPwlOwner({ email });
    const rowndId = `restored-${randomUUID()}`;
    const profile: RowndUser = { data: { user_id: rowndId, email }, verified_data: {} };
    await setSnapshot(owner.internalId, profile);
    rownd.fetchUserInfo.mockImplementation(async ({ user_id }) => user_id === rowndId ? profile : undefined);
    expect(await EmailVerification.isEmailVerified(SuperTokens.convertToRecipeUserId(owner.internalId), email)).toBe(true);
    expect(await EmailVerification.isEmailVerified(SuperTokens.convertToRecipeUserId(rowndId), email)).toBe(false);
    const writes = await spyOnAuthWrites();
    const preview = await expectNoWrites(writes, () => reconcileUser({ rownd_user_id: rowndId, dryRun: true }));
    expect(preview, JSON.stringify(preview)).toMatchObject({ status: "PREVIEW", canReconcile: true,
      proposedActions: expect.arrayContaining([expect.objectContaining({ action: "verify_email", email })]) });
    for (const spy of writes) spy.mockRestore();
    if (lostResponse) {
      const original = SuperTokens.createUserIdMapping.bind(SuperTokens);
      const mapping = vi.spyOn(SuperTokens, "createUserIdMapping").mockImplementationOnce(async (...args) => {
        expect(await original(...args)).toMatchObject({ status: "OK" });
        throw new Error("Lost restored mapping response");
      });
      expect(await reconcileUser({ rownd_user_id: rowndId })).toMatchObject({ status: "ERROR", message: "Lost restored mapping response" });
      mapping.mockRestore();
      expect(await EmailVerification.isEmailVerified(SuperTokens.convertToRecipeUserId(rowndId), email)).toBe(false);
      await restartSDK();
    }
    const result = await reconcileUser({ rownd_user_id: rowndId });
    expect(result, JSON.stringify(result)).toMatchObject({ status: "OK", supertokens_user_id: owner.internalId });
    expect((await SuperTokens.getUser(rowndId))!.loginMethods.find((method) => method.hasSameEmailAs(email))).toMatchObject({ verified: true });
    expect(await reconcileUser({ rownd_user_id: rowndId })).toMatchObject({ status: "OK", changed: false });
  });

  it("blocks stale alias verification from authorizing an unverified restored recipient before writes", async () => {
    const email = uniqueEmail("restore-stale");
    const owner = await createPwlOwner({ email });
    const rowndId = `restored-${randomUUID()}`;
    const profile: RowndUser = { data: { user_id: rowndId, email }, verified_data: {} };
    await setSnapshot(owner.internalId, profile);
    await EmailVerification.unverifyEmail(SuperTokens.convertToRecipeUserId(owner.internalId), email);
    await verifyEmail(rowndId, email);
    rownd.fetchUserInfo.mockImplementation(async ({ user_id }) => user_id === rowndId ? profile : undefined);
    const writes = await spyOnAuthWrites();
    for (const dryRun of [true, false]) {
      const result = await expectNoWrites(writes, () => reconcileUser({ rownd_user_id: rowndId, dryRun }));
      expect(result, JSON.stringify(result)).toMatchObject({ status: "BLOCKED", changed: false });
    }
    expect((await SuperTokens.getUserIdMapping({ userId: rowndId, userIdType: "EXTERNAL" })).status).toBe("UNKNOWN_MAPPING_ERROR");
    expect(await EmailVerification.isEmailVerified(SuperTokens.convertToRecipeUserId(owner.internalId), email)).toBe(false);
  });

  let network: StartedNetwork;
  let postgres: StartedTestContainer;
  let core: StartedTestContainer;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    expect(process.env.TEST_MODE).toBe("testing");
    network = await new Network().start();
    postgres = await new GenericContainer("postgres:14")
      .withNetwork(network).withNetworkAliases("postgres")
      .withEnvironment({ POSTGRES_USER: "supertokens", POSTGRES_PASSWORD: "somepassword", POSTGRES_DB: "supertokens" })
      .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections")).start();
    core = await new GenericContainer("supertokens/supertokens-postgresql")
      .withNetwork(network)
      .withEnvironment({ POSTGRESQL_CONNECTION_URI: "postgresql://supertokens:somepassword@postgres:5432/supertokens" })
      .withExposedPorts(3567).withWaitStrategy(Wait.forHttp("/hello", 3567)).start();
    const response = await fetch(`http://${core.getHost()}:${core.getMappedPort(3567)}/ee/license`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ licenseKey: "N2uEOdEzd1XZZ5VBSTGYaM7Ia4s8wAqRWFAxLqTYrB6GQ=vssOLo3c=PkFgcExkaXs=IA-d9UWccoNKsyUgNhOhcKtM1bjC5OLrYRpTAgN-2EbKYsQGGQRQHuUN4EO1V" }),
    });
    expect(response.ok).toBe(true);
  }, 120000);

  afterAll(async () => {
    try { await core?.stop(); } finally {
      try { await postgres?.stop(); } finally { await network?.stop(); }
    }
  });

  async function startServer() {
    const app = express();
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    baseUrl = `http://localhost:${address.port}`;
    SuperTokens.init({
      supertokens: { connectionURI: `http://${core.getHost()}:${core.getMappedPort(3567)}` },
      appInfo: { appName: "Revised reconciliation", apiDomain: baseUrl, websiteDomain: "http://localhost:3000" },
      recipeList: [
        AccountLinking.init({ shouldDoAutomaticAccountLinking: async () => ({ shouldAutomaticallyLink: false }) }),
        Session.init(), UserMetadata.init(), EmailVerification.init({ mode: "OPTIONAL" }),
        Passwordless.init({ contactMethod: "EMAIL", flowType: "MAGIC_LINK" }), ThirdParty.init(), EmailPassword.init(),
      ],
      experimental: { plugins: [init({ rowndAppKey: "test-key", rowndAppSecret: "test-secret" })] },
    });
    app.use(middleware());
    app.post("/test/native-session", async (req, res) => {
      try {
        await Session.createNewSession(req, res, "public", SuperTokens.convertToRecipeUserId(req.header("x-recipe-user-id")!));
        res.json({ status: "OK" });
      } catch (error) {
        res.status(409).json({ status: "ERROR", message: error instanceof Error ? error.message : "Session failed" });
      }
    });
    app.use(errorHandler());
  }

  beforeEach(async () => {
    resetST();
    vi.resetAllMocks();
    await startServer();
  });

  afterEach(async () => {
    try {
      if (server?.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    } finally {
      resetST();
      vi.restoreAllMocks();
    }
  });

  async function spyOnAuthWrites() {
    const repository = await import("./supertokens-repository");
    return [
      vi.spyOn(repository, "importUser"),
      vi.spyOn(SuperTokens, "createUserIdMapping"),
      vi.spyOn(SuperTokens, "deleteUserIdMapping"),
      vi.spyOn(SuperTokens, "deleteUser"),
      vi.spyOn(AccountLinking, "createPrimaryUser"),
      vi.spyOn(AccountLinking, "linkAccounts"),
      vi.spyOn(AccountLinking, "unlinkAccount"),
      vi.spyOn(UserMetadata, "updateUserMetadata"),
      vi.spyOn(UserMetadata, "clearUserMetadata"),
      vi.spyOn(Passwordless, "signInUp"),
      vi.spyOn(Passwordless, "updateUser"),
      vi.spyOn(Passwordless, "revokeAllCodes"),
      vi.spyOn(EmailPassword, "signUp"),
      vi.spyOn(ThirdParty, "manuallyCreateOrUpdateUser"),
      vi.spyOn(EmailVerification, "createEmailVerificationToken"),
      vi.spyOn(EmailVerification, "verifyEmailUsingToken"),
      vi.spyOn(EmailVerification, "unverifyEmail"),
      vi.spyOn(EmailVerification, "revokeEmailVerificationTokens"),
      vi.spyOn(Session, "createNewSession"),
      vi.spyOn(Session, "createNewSessionWithoutRequestResponse"),
      vi.spyOn(Session, "revokeAllSessionsForUser"),
      vi.spyOn(Session, "revokeSession"),
      vi.spyOn(Session, "revokeMultipleSessions"),
      vi.spyOn(Multitenancy, "associateUserToTenant"),
      vi.spyOn(Multitenancy, "disassociateUserFromTenant"),
    ];
  }

  async function expectNoWrites<T>(writes: Array<{ mock: { calls: unknown[] } }>, action: () => Promise<T>) {
    const before = writes.map((write) => write.mock.calls.length);
    const result = await action();
    writes.forEach((write, index) => expect(write.mock.calls.length).toBe(before[index]));
    return result;
  }

  function emailSearch(profiles: RowndUser[]) {
    const search = vi.fn(async () => profiles.map((profile) => profile.data.user_id));
    const fresh = vi.fn(async ({ user_id }: { user_id: string }) => structuredClone(profiles.find((profile) => profile.data.user_id === user_id)));
    setRowndClient({ validateToken: rownd.validateToken, fetchUserInfo: rownd.fetchUserInfo,
      fetchFreshUserInfo: fresh, findUserIdsByEmail: search });
    return { search, fresh };
  }

  it.each([[true, true], [false, true], [false, false], [true, false]])("email lookup binds the native owner and backfills metadata (source verified %s, native verified %s)", async (verified, nativeVerified) => {
    const email = uniqueEmail("email-discovery");
    const owner = await createPwlOwner({ email });
    if (!nativeVerified) await EmailVerification.unverifyEmail(SuperTokens.convertToRecipeUserId(owner.internalId), email);
    const id = `discovered-${randomUUID()}`;
    const profile = verifiedProfile(id, { email });
    if (!verified) profile.verified_data = {};
    profile.data.given_name = "Current";
    profile.meta = { imported_origin: "rownd" };
    const { search, fresh } = emailSearch([profile]);
    const writes = await spyOnAuthWrites();
    const preview = await expectNoWrites(writes, () => reconcileUser({ email: `  ${email.toUpperCase()}  `, dryRun: true }));
    expect(preview, JSON.stringify(preview)).toMatchObject({ status: "PREVIEW", canReconcile: true, matchesSource: false, changed: false, supertokens_user_id: owner.internalId, rownd_user_id: id });
    expect(preview.proposedActions).toContainEqual({ action: "update_migration_metadata", supertokens_user_id: owner.internalId });
    const result = await reconcileUser({ email });
    expect(result, JSON.stringify(result)).toMatchObject({ status: "OK", changed: true, supertokens_user_id: owner.internalId, rownd_user_id: id });
    await expectMapped(id, owner.internalId);
    expect((await SuperTokens.getUser(id))?.loginMethods).toHaveLength(1);
    expect(await EmailVerification.isEmailVerified(SuperTokens.convertToRecipeUserId(id), email)).toBe(verified || nativeVerified);
    expect((await UserMetadata.getUserMetadata(owner.internalId)).metadata).toMatchObject({
      original_rownd_user: profile, given_name: "Current", imported_origin: "rownd", rownd_migration_complete: true,
    });
    search.mockClear();
    const retry = await expectNoWrites(writes, () => reconcileUser({ email }));
    expect(retry, JSON.stringify(retry)).toMatchObject({ status: "OK", changed: false });
    expect(search).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalled();
    expect(rownd.fetchUserInfo).not.toHaveBeenCalled();
  });

  it("email lookup finds a mapped Apple owner with historical email and preserves the native email owner", async () => {
    const email = uniqueEmail("email-apple-discovery");
    const owner = await createPwlOwner({ email });
    const id = `discovered-apple-${randomUUID()}`;
    const appleId = `apple-${randomUUID()}`;
    const oldEmail = uniqueEmail("historical-apple");
    const apple = await ThirdParty.manuallyCreateOrUpdateUser("public", "apple", appleId, oldEmail, false);
    expect(apple.status).toBe("OK");
    if (apple.status !== "OK") throw new Error("Apple fixture failed");
    const appleInternal = apple.recipeUserId.getAsString();
    await mapAlias(appleInternal, id);
    await UserMetadata.updateUserMetadata(id, { original_rownd_user: { data: { user_id: id, email: oldEmail, apple_id: appleId } }, preference: false });
    const profile = verifiedProfile(id, { email, activity: NEW });
    profile.data.apple_id = appleId;
    profile.verified_data!.apple_id = appleId;
    profile.data.given_name = "Current";
    profile.data.preference = "replace-me";
    const { search } = emailSearch([profile]);
    const writes = await spyOnAuthWrites();
    const preview = await expectNoWrites(writes, () => reconcileUser({ email, dryRun: true }));
    expect(preview, JSON.stringify(preview)).toMatchObject({ status: "PREVIEW", canReconcile: true, supertokens_user_id: owner.internalId, rownd_user_id: id });
    const result = await reconcileUser({ email });
    expect(result, JSON.stringify(result)).toMatchObject({ status: "OK", changed: true, supertokens_user_id: owner.internalId });
    await expectMapped(id, owner.internalId);
    const user = (await SuperTokens.getUser(id))!;
    expect(user.loginMethods).toHaveLength(2);
    expect(await immutableRecipeId(user.loginMethods.find((method) => method.recipeId === "thirdparty")!.recipeUserId.getAsString())).toBe(appleInternal);
    expect(user.loginMethods.find((method) => method.recipeId === "thirdparty")?.email).toBe(oldEmail);
    expect(await EmailVerification.isEmailVerified(SuperTokens.convertToRecipeUserId(id), email)).toBe(true);
    expect((await UserMetadata.getUserMetadata(owner.internalId)).metadata).toMatchObject({ original_rownd_user: profile, given_name: "Current" });
    const { getUserMetadata } = await import("./supertokens-repository");
    expect((await getUserMetadata(owner.internalId)).preference).toBe(false);
    search.mockClear();
    expect(await expectNoWrites(writes, () => reconcileUser({ email }))).toMatchObject({ status: "OK", changed: false });
    expect(search).not.toHaveBeenCalled();
  });

  it.each(["latest", "tie", "missing"])("email lookup collects all candidates for %s activity election", async (activity) => {
    const email = uniqueEmail("email-election");
    const owner = await createPwlOwner({ email });
    const profiles = ["a", "b"].map((suffix) => verifiedProfile(`email-election-${suffix}-${randomUUID()}`, { email,
      ...(activity === "missing" ? {} : { activity: suffix === "a" && activity === "latest" ? OLD : NEW }) }));
    emailSearch(profiles);
    const writes = await spyOnAuthWrites();
    const preview = await expectNoWrites(writes, () => reconcileUser({ email, dryRun: true }));
    if (activity !== "latest") {
      expect(preview, JSON.stringify(preview)).toMatchObject({ status: "AMBIGUOUS", changed: false });
      expect(await expectNoWrites(writes, () => reconcileUser({ email }))).toMatchObject({ status: "AMBIGUOUS", changed: false });
      return;
    }
    expect(preview, JSON.stringify(preview)).toMatchObject({ status: "PREVIEW", canReconcile: true, rownd_user_id: profiles[1]!.data.user_id });
    const result = await reconcileUser({ email });
    expect(result, JSON.stringify(result)).toMatchObject({ status: "OK", supertokens_user_id: owner.internalId, rownd_user_id: profiles[1]!.data.user_id });
    await expectMapped(profiles[1]!.data.user_id, owner.internalId);
    expect(await SuperTokens.getUserIdMapping({ userId: profiles[0]!.data.user_id, userIdType: "EXTERNAL" })).toMatchObject({ status: "UNKNOWN_MAPPING_ERROR" });
  });

  it.each(["disabled", "mismatch", "missing", "wrong-id", "transport", "unsupported"])("email lookup rejects %s discovery without writes", async (kind) => {
    const email = uniqueEmail("email-invalid");
    await createPwlOwner({ email });
    const profile = verifiedProfile(`email-invalid-${randomUUID()}`, { email });
    if (kind === "disabled") profile.state = "disabled";
    if (kind === "mismatch") profile.data.email = uniqueEmail("other");
    const { fresh, search } = emailSearch([profile]);
    if (kind === "missing") fresh.mockResolvedValue(undefined);
    if (kind === "wrong-id") search.mockResolvedValue(["other-id"]);
    if (kind === "wrong-id") fresh.mockResolvedValue(profile);
    if (kind === "transport") search.mockRejectedValue(new Error("lookup unavailable"));
    if (kind === "unsupported") setRowndClient(rownd);
    const writes = await spyOnAuthWrites();
    for (const dryRun of [true, false]) {
      const result = await expectNoWrites(writes, () => reconcileUser({ email, dryRun }));
      expect(result, JSON.stringify(result)).toMatchObject({ status: kind === "transport" ? "ERROR" : "BLOCKED", changed: false });
      if (kind === "unsupported") expect(result.message).toContain("ROWND_EMAIL_SEARCH_UNSUPPORTED");
      if (kind === "disabled" || kind === "mismatch") expect(result.message).toContain("verified-value lookup");
    }
  });

  it("email lookup permits active native sessions during mapping", async () => {
    const email = uniqueEmail("email-active");
    const owner = await createPwlOwner({ email });
    const session = await Session.createNewSessionWithoutRequestResponse("public", SuperTokens.convertToRecipeUserId(owner.internalId));
    emailSearch([verifiedProfile(`email-active-${randomUUID()}`, { email })]);
    const writes = await spyOnAuthWrites();
    expect(await expectNoWrites(writes, () => reconcileUser({ email, dryRun: true }))).toMatchObject({ status: "PREVIEW" });
    expect(await Session.getSessionInformation(session.getHandle())).toBeDefined();
    expect(await reconcileUser({ email })).toMatchObject({ status: "OK" });
  });

  it("email lookup detects source drift in the final fresh pass without rerunning discovery", async () => {
    const email = uniqueEmail("email-race");
    await createPwlOwner({ email });
    const profile = verifiedProfile(`email-race-${randomUUID()}`, { email });
    const { fresh } = emailSearch([profile]);
    fresh.mockResolvedValue({ ...profile, data: { ...profile.data, email: uniqueEmail("changed") } }).mockResolvedValueOnce(profile);
    const result = await reconcileUser({ email });
    expect(result, JSON.stringify(result)).toMatchObject({ status: "BLOCKED", partialProgress: true });
    expect(result.message).toContain("source identity changed");
    expect(fresh).toHaveBeenCalledTimes(2);
  });

  it("email lookup rejects a stale alias verification cell before publishing an unverified native credential", async () => {
    const email = uniqueEmail("email-alias-verification");
    const owner = await createPwlOwner({ email });
    await EmailVerification.unverifyEmail(SuperTokens.convertToRecipeUserId(owner.internalId), email);
    const id = `email-alias-verification-${randomUUID()}`;
    const profile = verifiedProfile(id, { email });
    profile.verified_data = {};
    await verifyEmail(id, email);
    emailSearch([profile]);
    const writes = await spyOnAuthWrites();
    for (const dryRun of [true, false]) {
      const result = await expectNoWrites(writes, () => reconcileUser({ email, dryRun }));
      expect(result, JSON.stringify(result)).toMatchObject({ status: "BLOCKED", changed: false });
    }
    expect(await EmailVerification.isEmailVerified(SuperTokens.convertToRecipeUserId(owner.internalId), email)).toBe(false);
    expect(await SuperTokens.getUserIdMapping({ userId: id, userIdType: "EXTERNAL" })).toMatchObject({ status: "UNKNOWN_MAPPING_ERROR" });
  });

  it.each(["PENDING", "COMMITTING"])("email lookup preserves %s native email operations and blocks before writes", async (status) => {
    const email = uniqueEmail("email-pending");
    const owner = await createPwlOwner({ email });
    const pending = { id: randomUUID(), field: "email", value: uniqueEmail("new-native-email"), tenantId: "public",
      created_at: new Date().toISOString(), status, purpose: "UPDATE_PASSWORDLESS" };
    await UserMetadata.updateUserMetadata(owner.internalId, { rownd_pending_verification: [pending] });
    emailSearch([verifiedProfile(`email-pending-${randomUUID()}`, { email })]);
    const writes = await spyOnAuthWrites();
    for (const dryRun of [true, false]) {
      const result = await expectNoWrites(writes, () => reconcileUser({ email, dryRun }));
      expect(result, JSON.stringify(result)).toMatchObject({ status: "BLOCKED", changed: false });
    }
    expect((await UserMetadata.getUserMetadata(owner.internalId)).metadata.rownd_pending_verification).toEqual([pending]);
  });

  it("email lookup reports source drift after publication without completing the checkpoint", async () => {
    const email = uniqueEmail("email-pre-map-change");
    const owner = await createPwlOwner({ email });
    const id = `email-pre-map-change-${randomUUID()}`;
    const profile = verifiedProfile(id, { email });
    emailSearch([profile]);
    const write = UserMetadata.updateUserMetadata.bind(UserMetadata);
    vi.spyOn(UserMetadata, "updateUserMetadata").mockImplementation(async (...args) => {
      const result = await write(...args);
      profile.data.email = uniqueEmail("now-other-contact");
      return result;
    });
    const mapping = vi.spyOn(SuperTokens, "createUserIdMapping");
    const result = await reconcileUser({ email });
    expect(result, JSON.stringify(result)).toMatchObject({ status: "BLOCKED", partialProgress: true });
    expect(mapping).toHaveBeenCalledOnce();
    await expectMapped(id, owner.internalId);
    expect((await UserMetadata.getUserMetadata(owner.internalId)).metadata.rownd_migration_mapping_publication).toBeDefined();
    expect((await SuperTokens.getUser(owner.internalId))?.emails).toEqual([email]);
  });

  it("email lookup does not import from an unanchored email selector", async () => {
    const email = uniqueEmail("email-no-owner");
    const { search } = emailSearch([verifiedProfile(`unanchored-${randomUUID()}`, { email })]);
    const writes = await spyOnAuthWrites();
    expect(await expectNoWrites(writes, () => reconcileUser({ email }))).toMatchObject({ status: "BLOCKED", changed: false });
    expect(search).not.toHaveBeenCalled();
  });

  async function seedContactConsolidation(mappedHistory = true) {
    const email = uniqueEmail("contact");
    const phoneNumber = uniquePhone();
    const googleSubject = `google-${randomUUID()}`;
    const requestedRowndId = `rownd-requested-${randomUUID()}`;
    const historicalRowndId = `rownd-historical-${randomUUID()}`;

    const emailOwner = await createPwlOwner({ email });
    if (mappedHistory) await mapAlias(emailOwner.internalId, historicalRowndId);
    await verifyEmail(mappedHistory ? historicalRowndId : emailOwner.internalId, email);
    await setSnapshot(emailOwner.internalId, verifiedProfile(historicalRowndId, { email, activity: OLD }));

    const phoneOwner = await createPwlOwner({ phoneNumber });
    await mapAlias(phoneOwner.internalId, requestedRowndId);
    await setSnapshot(phoneOwner.internalId, verifiedProfile(requestedRowndId, { phoneNumber, activity: OLD }));

    const requested = verifiedProfile(requestedRowndId, { email, phoneNumber, googleId: googleSubject, activity: NEW });
    const profiles = new Map<string, RowndUser>([
      [requestedRowndId, requested],
    ]);
    rownd.fetchUserInfo.mockImplementation(async ({ user_id }: { user_id: string }) => {
      if (user_id === historicalRowndId) throw Object.assign(new Error("Synthetic profile absent"), {
        name: "HTTPError", code: "ERR_NON_2XX_3XX_RESPONSE", response: { statusCode: 404 },
      });
      return profiles.get(user_id);
    });
    const recipes = await captureRecipes([emailOwner, phoneOwner]);
    return { email, phoneNumber, googleSubject, requestedRowndId, historicalRowndId, emailOwner, phoneOwner, requested, profiles, recipes };
  }

  // The requested mapped phone owner discovers the other owner by its live email.
  async function seedDuplicateOwners(options: {
    survivorMethods: number;
    donorMethods: number;
    survivorPrimary?: boolean;
    donorPrimary?: boolean;
    survivorActivity?: string;
    donorActivity?: string;
  }) {
    const email = uniqueEmail("duplicate");
    const survivorRowndId = `rownd-survivor-${randomUUID()}`;
    const survivorPhones = Array.from({ length: options.survivorMethods - 1 }, () => uniquePhone());
    const survivor = await createPwlOwner({ email, primary: options.survivorPrimary ?? true, extras: survivorPhones.map((phoneNumber) => ({ phoneNumber })) });
    await mapAlias(survivor.internalId, survivorRowndId);
    await verifyEmail(survivorRowndId, email);
    await setSnapshot(survivor.internalId, verifiedProfile(survivorRowndId, { email, activity: options.survivorActivity }));

    const rowndId = `rownd-donor-${randomUUID()}`;
    const donorPhones = Array.from({ length: options.donorMethods }, () => uniquePhone());
    const donor = { ...await createPwlOwner({ phoneNumber: donorPhones[0]!, primary: options.donorPrimary,
      extras: donorPhones.slice(1).map((phoneNumber) => ({ phoneNumber })) }), rowndId, phoneNumber: donorPhones[0]! };
    await mapAlias(donor.internalId, rowndId);
    await setSnapshot(donor.internalId, verifiedProfile(rowndId, { email, phoneNumber: donor.phoneNumber, activity: options.donorActivity }));

    const profiles = new Map<string, RowndUser>();
    profiles.set(survivorRowndId, verifiedProfile(survivorRowndId, { email, activity: options.survivorActivity }));
    profiles.set(donor.rowndId, verifiedProfile(donor.rowndId, { email, phoneNumber: donor.phoneNumber, activity: options.donorActivity }));
    rownd.fetchUserInfo.mockImplementation(async ({ user_id }: { user_id: string }) => profiles.get(user_id));
    const recipes = await captureRecipes([survivor, donor]);
    return { email, survivorRowndId, survivor, donor, profiles, recipes };
  }

  async function seedOwnerlessCanonical(capacity = true) {
    const email = uniqueEmail("ownerless");
    const ownerRowndId = `rownd-owner-${randomUUID()}`;
    const ownerlessRowndId = `rownd-ownerless-${randomUUID()}`;
    const owner = await createPwlOwner({ email, primary: true, extras: capacity ? [{ phoneNumber: uniquePhone() }] : [] });
    await mapAlias(owner.internalId, ownerRowndId);
    await verifyEmail(ownerRowndId, email);
    await setSnapshot(owner.internalId, verifiedProfile(ownerRowndId, { email, activity: OLD }));
    const profiles = new Map<string, RowndUser>([
      [ownerRowndId, verifiedProfile(ownerRowndId, { email, activity: OLD })],
      [ownerlessRowndId, verifiedProfile(ownerlessRowndId, { email, activity: NEW })],
    ]);
    rownd.fetchUserInfo.mockImplementation(async ({ user_id }: { user_id: string }) => profiles.get(user_id));
    const recipes = await captureRecipes([owner]);
    return { email, ownerRowndId, ownerlessRowndId, owner, profiles, recipes };
  }

  async function snapshot(ids: string[]) {
    return Promise.all(ids.map(async (id) => ({
      id, user: (await SuperTokens.getUser(id))?.toJson(),
      metadata: (await UserMetadata.getUserMetadata(id)).metadata,
      mapping: await SuperTokens.getUserIdMapping({ userId: id, userIdType: "ANY" }),
    })));
  }

  it("blocks incompatible current provider ownership before any owner-consolidation write", async () => {
    const fixture = await seedDuplicateOwners({ survivorMethods: 2, donorMethods: 1, survivorActivity: OLD, donorActivity: NEW });
    const subject = randomUUID();
    fixture.profiles.set(fixture.donor.rowndId, verifiedProfile(fixture.donor.rowndId, {
      email: fixture.email, phoneNumber: fixture.donor.phoneNumber, googleId: subject, activity: NEW,
    }));
    const provider = await ThirdParty.manuallyCreateOrUpdateUser("public", "google", subject, uniqueEmail("conflicting-provider"), false);
    if (provider.status !== "OK") throw new Error("Failed to create conflicting provider");
    await AccountLinking.createPrimaryUser(provider.recipeUserId);
    const ids = [fixture.survivor.internalId, fixture.donor.internalId, fixture.survivorRowndId, fixture.donor.rowndId, provider.recipeUserId.getAsString()];
    const before = await snapshot(ids);
    const writes = await spyOnAuthWrites();
    for (const dryRun of [true, false]) {
      const result = await expectNoWrites(writes, () => reconcileUser({ rownd_user_id: fixture.donor.rowndId, dryRun }));
      expect(result, JSON.stringify(result)).toMatchObject({ status: "BLOCKED", changed: false });
    }
    expect(await snapshot(ids)).toEqual(before);
  });

  async function expectNoopSelectors(target: string, canonicalId: string, aliases: string[], email: string) {
    const selectors: ReconcileUserInput[] = [...aliases.map((rownd_user_id) => ({ rownd_user_id })), { email }];
    for (const selector of selectors) {
      const result = await reconcileUser(selector);
      expect(result, JSON.stringify(result)).toMatchObject({ status: "OK", changed: false, actions: [],
        rownd_user_id: canonicalId, supertokens_user_id: target });
    }
  }

  it.each([false, true])("retains and promotes the same-email owner during synthetic contact consolidation (mapped history=%s)", async (mappedHistory) => {
    const fixture = await seedContactConsolidation(mappedHistory);
    const { emailOwner, phoneOwner, requestedRowndId, historicalRowndId } = fixture;
    await expectMapped(requestedRowndId, phoneOwner.internalId);
    expect((await SuperTokens.getUser(emailOwner.internalId))!.isPrimaryUser).toBe(false);
    const createProvider = vi.spyOn(ThirdParty, "manuallyCreateOrUpdateUser");

    const result = await reconcileUser({ rownd_user_id: requestedRowndId });
    expect(result, JSON.stringify(result)).toMatchObject({ status: "OK", rownd_user_id: requestedRowndId,
      supertokens_user_id: emailOwner.internalId });
    const survivor = (await SuperTokens.getUser(requestedRowndId))!;
    const methods = await recipeIdentities(survivor);
    expect(methods).toHaveLength(3);
    expect(methods.filter(({ id }) => fixture.recipes.some((recipe) => recipe.id === id))).toEqual(fixture.recipes);
    const google = survivor.loginMethods.find((method) => method.thirdParty?.id === "google")!;
    const placeholder = `st-google-${createHash("sha256").update(`google:${fixture.googleSubject}`).digest("hex").slice(0, 32)}@stfakeemail.supertokens.com`;
    expect(google).toMatchObject({ thirdParty: { id: "google", userId: fixture.googleSubject }, email: placeholder, verified: false });
    expect(createProvider).toHaveBeenCalledTimes(1);
    expect(survivor.loginMethods.find((method) => method.recipeId === "passwordless" && method.hasSameEmailAs(fixture.email)))
      .toMatchObject({ verified: true });
    expect(survivor.loginMethods.find((method) => method.hasSamePhoneNumberAs(fixture.phoneNumber))).toMatchObject({ verified: true });
    await expectGraph(emailOwner.internalId, requestedRowndId, mappedHistory ? [historicalRowndId] : [], methods);
    if (mappedHistory) {
      const historical = await SuperTokens.getUserIdMapping({ userId: historicalRowndId, userIdType: "EXTERNAL" });
      expect(historical).toMatchObject({ status: "OK", superTokensUserId: phoneOwner.internalId });
    } else expect((await SuperTokens.getUserIdMapping({ userId: historicalRowndId, userIdType: "EXTERNAL" })).status).toBe("UNKNOWN_MAPPING_ERROR");
    await expectNoopSelectors(emailOwner.internalId, requestedRowndId, [requestedRowndId], fixture.email);
    expect(createProvider).toHaveBeenCalledTimes(1);
  });

  it("keeps the established primary with more methods while making the latest phone donor the canonical external source", async () => {
    const fixture = await seedDuplicateOwners({ survivorMethods: 2, donorMethods: 1, survivorActivity: OLD, donorActivity: NEW });
    const result = await reconcileUser({ rownd_user_id: fixture.donor.rowndId });
    expect(result, JSON.stringify(result)).toMatchObject({ status: "OK", rownd_user_id: fixture.donor.rowndId,
      supertokens_user_id: fixture.survivor.internalId });
    await expectGraph(fixture.survivor.internalId, fixture.donor.rowndId, [fixture.survivorRowndId], fixture.recipes);
    await expectNoopSelectors(fixture.survivor.internalId, fixture.donor.rowndId,
      [fixture.donor.rowndId, fixture.survivorRowndId], fixture.email);
  });

  it("places an ownerless winner on the existing primary and relocates its previous alias to a real linked method", async () => {
    const fixture = await seedOwnerlessCanonical();
    const result = await reconcileUser({ rownd_user_id: fixture.ownerlessRowndId });
    expect(result, JSON.stringify(result)).toMatchObject({ status: "OK", rownd_user_id: fixture.ownerlessRowndId,
      supertokens_user_id: fixture.owner.internalId });
    await expectGraph(fixture.owner.internalId, fixture.ownerlessRowndId, [fixture.ownerRowndId], fixture.recipes);
    await expectMapped(fixture.ownerRowndId, fixture.owner.recipeIds[1]!);
    await expectNoopSelectors(fixture.owner.internalId, fixture.ownerlessRowndId,
      [fixture.ownerRowndId, fixture.ownerlessRowndId], fixture.email);
  });

  it("preserves a verified immutable email credential across alias movement when the elected Rownd email is unverified", async () => {
    const fixture = await seedDuplicateOwners({ survivorMethods: 2, donorMethods: 1, survivorActivity: OLD, donorActivity: NEW });
    fixture.profiles.get(fixture.donor.rowndId)!.verified_data = { phone_number: true, email: false };
    const result = await reconcileUser({ rownd_user_id: fixture.donor.rowndId });
    expect(result, JSON.stringify(result)).toMatchObject({ status: "OK", rownd_user_id: fixture.donor.rowndId,
      supertokens_user_id: fixture.survivor.internalId });
    await expectGraph(fixture.survivor.internalId, fixture.donor.rowndId, [fixture.survivorRowndId], fixture.recipes);
    const user = (await SuperTokens.getUser(fixture.survivor.internalId))!;
    expect(user.loginMethods.find((method) => method.hasSameEmailAs(fixture.email))).toMatchObject({ verified: true });
    await expectNoopSelectors(fixture.survivor.internalId, fixture.donor.rowndId,
      [fixture.survivorRowndId, fixture.donor.rowndId], fixture.email);
  });

  it.each([false, true])("adds a privately recorded Passwordless method to the surviving email-password primary (lost receipt response=%s)", async (lostResponse) => {
    const email = uniqueEmail("native-password");
    const native = await EmailPassword.signUp("public", email, "password123!");
    if (native.status !== "OK") throw new Error("Native email creation failed");
    await verifyEmail(native.recipeUserId.getAsString(), email);
    expect(await AccountLinking.createPrimaryUser(native.recipeUserId)).toMatchObject({ status: "OK" });
    const phoneNumber = uniquePhone();
    const phone = await createPwlOwner({ phoneNumber });
    const rowndId = `source-${randomUUID()}`;
    const profile = verifiedProfile(rowndId, { email, phoneNumber, activity: NEW });
    await mapAlias(phone.internalId, rowndId);
    await setSnapshot(phone.internalId, profile);
    rownd.fetchUserInfo.mockImplementation(async ({ user_id }) => user_id === rowndId ? profile : undefined);
    const update = UserMetadata.updateUserMetadata.bind(UserMetadata);
    let interrupted = false;
    const receiptWrite = vi.spyOn(UserMetadata, "updateUserMetadata").mockImplementation(async (...args) => {
      const result = await update(...args);
      const plan = args[1].rownd_migration_owner_consolidation as { createdRecipes?: unknown[]; reservation?: boolean } | undefined;
      if (lostResponse && !interrupted && args[0] === native.user.id && plan?.createdRecipes?.length && !plan.reservation) {
        interrupted = true;
        throw new Error("Lost creation receipt response");
      }
      return result;
    });
    if (lostResponse) {
      expect(await reconcileUser({ rownd_user_id: rowndId })).toMatchObject({ status: "ERROR", message: "Lost creation receipt response" });
      expect(interrupted).toBe(true);
      receiptWrite.mockRestore();
      await restartSDK();
    }
    const result = await reconcileUser({ rownd_user_id: rowndId });
    expect(result, JSON.stringify(result)).toMatchObject({ status: "OK", supertokens_user_id: native.user.id });
    await expectMapped(rowndId, native.user.id);
    const user = (await SuperTokens.getUser(rowndId))!;
    expect(user.loginMethods).toHaveLength(3);
    const created = user.loginMethods.find((method) => method.recipeId === "passwordless" && method.hasSameEmailAs(email))!;
    expect(created).toMatchObject({ verified: true });
    expect((await UserMetadata.getUserMetadata(native.user.id)).metadata.rownd_migration_owner_consolidation).toMatchObject({
      status: "COMPLETE", createdRecipes: [expect.objectContaining({ id: created.recipeUserId.getAsString() })],
    });
    expect(await reconcileUser({ rownd_user_id: rowndId })).toMatchObject({ status: "OK", changed: false });
    const session = await Session.createNewSessionWithoutRequestResponse("public", created.recipeUserId);
    expect(session.getUserId()).toBe(rowndId);
  });

  it("blocks alias relocation that would apply an old alias's verification to an unverified different email", async () => {
    const fixture = await seedOwnerlessCanonical(false);
    const emailB = uniqueEmail("historical-unverified");
    const native = await EmailPassword.signUp("public", emailB, "password123!");
    if (native.status !== "OK") throw new Error("Native email creation failed");
    expect(await AccountLinking.linkAccounts(native.recipeUserId, fixture.ownerRowndId)).toMatchObject({ status: "OK" });
    await verifyEmail(fixture.ownerRowndId, emailB);
    expect((await SuperTokens.getUser(native.recipeUserId.getAsString()))!.loginMethods.find((method) => method.hasSameEmailAs(emailB))).toMatchObject({ verified: false });
    const ids = [fixture.owner.internalId, native.recipeUserId.getAsString(), fixture.ownerRowndId, fixture.ownerlessRowndId];
    const before = await snapshot(ids);
    const writes = await spyOnAuthWrites();
    for (const dryRun of [true, false]) {
      const result = await expectNoWrites(writes, () => reconcileUser({ rownd_user_id: fixture.ownerlessRowndId, dryRun }));
      expect(result, JSON.stringify(result)).toMatchObject({ status: "BLOCKED", changed: false });
    }
    expect(await snapshot(ids)).toEqual(before);
  });

  it("rejects malformed completion during admin repair while allowing native sessions", async () => {
    const fixture = await seedDuplicateOwners({ survivorMethods: 2, donorMethods: 1, survivorActivity: OLD, donorActivity: NEW });
    const result = await reconcileUser({ rownd_user_id: fixture.donor.rowndId });
    expect(result, JSON.stringify(result)).toMatchObject({ status: "OK" });
    const session = await Session.createNewSessionWithoutRequestResponse("public", SuperTokens.convertToRecipeUserId(fixture.donor.rowndId));
    const checkpoint = (await UserMetadata.getUserMetadata(fixture.survivor.internalId)).metadata.rownd_migration_owner_consolidation;
    await UserMetadata.updateUserMetadata(fixture.survivor.internalId, { rownd_migration_owner_consolidation: {
      ...checkpoint, completion: { recipes: [], state: { graph: [], mappings: [], markers: [], verifications: [] } },
    } });
    await expect(Session.createNewSessionWithoutRequestResponse("public", SuperTokens.convertToRecipeUserId(fixture.survivorRowndId))).resolves.toBeDefined();
    expect(await reconcileUser({ rownd_user_id: fixture.donor.rowndId })).toMatchObject({ status: "BLOCKED" });
    expect(await Session.getSessionInformation(session.getHandle())).toBeDefined();
  });

  it("keeps completed owner-plan mapping removal blocked rather than treating it as fresh publication", async () => {
    const fixture = await seedDuplicateOwners({ survivorMethods: 2, donorMethods: 1, survivorActivity: OLD, donorActivity: NEW });
    expect(await reconcileUser({ rownd_user_id: fixture.donor.rowndId })).toMatchObject({ status: "OK" });
    await SuperTokens.deleteUserIdMapping({ userId: fixture.donor.rowndId, userIdType: "EXTERNAL", force: true });
    const writes = await spyOnAuthWrites();
    for (const dryRun of [true, false]) {
      const result = await expectNoWrites(writes, () => reconcileUser({ rownd_user_id: fixture.donor.rowndId, dryRun }));
      expect(result, JSON.stringify(result)).toMatchObject({ status: "BLOCKED", changed: false });
    }
  });

  it("reelects a newly active alias after completion while retaining the immutable primary and recipe graph", async () => {
    const fixture = await seedDuplicateOwners({ survivorMethods: 2, donorMethods: 1, survivorActivity: OLD, donorActivity: NEW });
    const first = await reconcileUser({ rownd_user_id: fixture.donor.rowndId });
    expect(first, JSON.stringify(first)).toMatchObject({ status: "OK", supertokens_user_id: fixture.survivor.internalId });
    fixture.profiles.get(fixture.survivorRowndId)!.meta = { last_active: "2022-01-01T00:00:00Z" };
    const preview = await reconcileUser({ rownd_user_id: fixture.donor.rowndId, dryRun: true });
    expect(preview, JSON.stringify(preview)).toMatchObject({ status: "PREVIEW", canReconcile: true, rownd_user_id: fixture.survivorRowndId,
      supertokens_user_id: fixture.survivor.internalId });
    const second = await reconcileUser({ rownd_user_id: fixture.donor.rowndId });
    expect(second, JSON.stringify(second)).toMatchObject({ status: "OK", rownd_user_id: fixture.survivorRowndId, supertokens_user_id: fixture.survivor.internalId });
    await expectGraph(fixture.survivor.internalId, fixture.survivorRowndId, [fixture.donor.rowndId], fixture.recipes);
  });

  it("retires the losing alias when an ownerless winner has no spare recipe", async () => {
    const fixture = await seedOwnerlessCanonical(false);
    await UserMetadata.updateUserMetadata(fixture.owner.internalId, {
      rownd_email_recipe_user_id: fixture.ownerRowndId,
      rownd_email_recipe_user_ids: { public: fixture.ownerRowndId },
    });
    const ids = [fixture.owner.internalId, fixture.ownerRowndId, fixture.ownerlessRowndId];
    const before = await snapshot(ids);
    const writes = await spyOnAuthWrites();
    const preview = await expectNoWrites(writes, () => reconcileUser({ rownd_user_id: fixture.ownerlessRowndId, dryRun: true }));
    expect(preview, JSON.stringify(preview)).toMatchObject({ status: "PREVIEW", canReconcile: true });
    expect(await snapshot(ids)).toEqual(before);
    const result = await reconcileUser({ rownd_user_id: fixture.ownerlessRowndId });
    expect(result, JSON.stringify(result)).toMatchObject({ status: "OK", supertokens_user_id: fixture.owner.internalId });
    await expectGraph(fixture.owner.internalId, fixture.ownerlessRowndId, [], fixture.recipes);
    expect((await SuperTokens.getUserIdMapping({ userId: fixture.ownerRowndId, userIdType: "EXTERNAL" })).status).toBe("UNKNOWN_MAPPING_ERROR");
    expect((await UserMetadata.getUserMetadata(fixture.ownerRowndId)).metadata).toMatchObject({
      rownd_migration_superseded: { rowndUserId: fixture.ownerlessRowndId, targetUserId: fixture.owner.internalId },
    });
    expect(await EmailVerification.isEmailVerified(SuperTokens.convertToRecipeUserId(fixture.ownerlessRowndId), fixture.email)).toBe(true);
    const retry = await reconcileUser({ rownd_user_id: fixture.ownerlessRowndId });
    expect(retry, JSON.stringify(retry)).toMatchObject({ status: "OK", changed: false, actions: [] });
    const retired = await reconcileUser({ rownd_user_id: fixture.ownerRowndId });
    expect(retired, JSON.stringify(retired)).toMatchObject({ status: "BLOCKED" });
    fixture.profiles.get(fixture.ownerRowndId)!.meta = { last_active: "2026-01-01T00:00:00Z" };
    const reclaim = await reconcileUser({ rownd_user_id: fixture.ownerlessRowndId });
    expect(reclaim, JSON.stringify(reclaim)).toMatchObject({ status: "BLOCKED" });
    await expectMapped(fixture.ownerlessRowndId, fixture.owner.internalId);
  });

  it.each(["none", "retirement", "delete", "create"])("replaces a standalone Apple mapping with an ownerless winner (lost response: %s)", async (phase) => {
    const winner = `apple-winner-${randomUUID()}`, loser = `apple-loser-${randomUUID()}`;
    const subject = randomUUID();
    const email = uniqueEmail("apple");
    const apple = await ThirdParty.manuallyCreateOrUpdateUser("public", "apple", subject, email, false);
    if (apple.status !== "OK") throw new Error(apple.status);
    const target = apple.user.id;
    expect(apple.user.isPrimaryUser).toBe(false);
    const profiles = new Map<string, RowndUser>([
      [winner, { data: { user_id: winner, apple_id: subject, email }, meta: { last_active: "2025-11-20T07:57:01.703Z" } }],
      [loser, { data: { user_id: loser, apple_id: subject, email } }],
    ]);
    rownd.fetchUserInfo.mockImplementation(async ({ user_id }) => profiles.get(user_id));
    await mapAlias(target, loser);
    await setSnapshot(target, profiles.get(loser)!);
    await UserMetadata.updateUserMetadata(loser, { applicationPreference: "preserve", original_rownd_user: profiles.get(loser)! });
    const recipes = await recipeIdentities((await SuperTokens.getUser(target))!);
    let lost = false;
    const update = UserMetadata.updateUserMetadata.bind(UserMetadata);
    vi.spyOn(UserMetadata, "updateUserMetadata").mockImplementation(async (...args) => {
      const result = await update(...args);
      if (!lost && phase === "retirement" && args[0] === loser && args[1].rownd_migration_superseded) {
        lost = true; throw new Error("Lost retirement response");
      }
      return result;
    });
    const remove = SuperTokens.deleteUserIdMapping.bind(SuperTokens);
    vi.spyOn(SuperTokens, "deleteUserIdMapping").mockImplementation(async (...args) => {
      const result = await remove(...args);
      if (!lost && phase === "delete" && args[0].userId === loser) {
        lost = true; throw new Error("Lost mapping deletion response");
      }
      return result;
    });
    const create = SuperTokens.createUserIdMapping.bind(SuperTokens);
    vi.spyOn(SuperTokens, "createUserIdMapping").mockImplementation(async (...args) => {
      const result = await create(...args);
      if (!lost && phase === "create" && args[0].externalUserId === winner) {
        lost = true; throw new Error("Lost mapping creation response");
      }
      return result;
    });
    if (phase !== "none") {
      const interrupted = await reconcileUser({ rownd_user_id: winner });
      expect(interrupted, JSON.stringify(interrupted)).toMatchObject({ status: "ERROR" });
      expect(lost).toBe(true);
    }
    const result = await reconcileUser({ rownd_user_id: winner });
    expect(result, JSON.stringify(result)).toMatchObject({ status: "OK", rownd_user_id: winner, supertokens_user_id: target });
    const completedRecipes = await recipeIdentities((await SuperTokens.getUser(target))!);
    expect(completedRecipes).toEqual(expect.arrayContaining(recipes));
    await expectGraph(target, winner, [], completedRecipes);
    expect(await SuperTokens.getUser(loser)).toBeUndefined();
    const retry = await reconcileUser({ rownd_user_id: winner });
    expect(retry, JSON.stringify(retry)).toMatchObject({ status: "OK", changed: false, actions: [] });
    const { getCombinedUserMetadata } = await import("./rownd-compatibility");
    expect(await getCombinedUserMetadata(winner)).toMatchObject({ applicationPreference: "preserve", original_rownd_user: profiles.get(winner)! });
    rownd.validateToken.mockResolvedValue({ user_id: loser });
    const response = await fetch(`${baseUrl}/auth/plugin/rownd/migrate`, { method: "POST",
      headers: { Authorization: "Bearer retired-token", "st-auth-mode": "header", rid: "session", "fdi-version": "1.18" } });
    expect(await response.json()).not.toMatchObject({ status: "OK" });
    expect(response.headers.get("st-access-token")).toBeNull();
    await expectMapped(winner, target);
  });

  it("elects the newer mapped source over an ownerless requested loser without fabricating a losing alias", async () => {
    const fixture = await seedOwnerlessCanonical();
    fixture.profiles.get(fixture.ownerlessRowndId)!.meta = { last_active: OLD };
    fixture.profiles.get(fixture.ownerRowndId)!.meta = { last_active: NEW };
    const result = await reconcileUser({ rownd_user_id: fixture.ownerlessRowndId });
    expect(result, JSON.stringify(result)).toMatchObject({ status: "OK", rownd_user_id: fixture.ownerRowndId,
      requested_rownd_user_id: fixture.ownerlessRowndId, supertokens_user_id: fixture.owner.internalId,
      election: { candidates: expect.arrayContaining([expect.objectContaining({ rownd_user_id: fixture.ownerlessRowndId })]) } });
    await expectGraph(fixture.owner.internalId, fixture.ownerRowndId, [], fixture.recipes);
    expect((await SuperTokens.getUserIdMapping({ userId: fixture.ownerlessRowndId, userIdType: "EXTERNAL" })).status).toBe("UNKNOWN_MAPPING_ERROR");
    expect(await SuperTokens.getUser(fixture.ownerlessRowndId)).toBeUndefined();
    await expectNoopSelectors(fixture.owner.internalId, fixture.ownerRowndId,
      [fixture.ownerlessRowndId, fixture.ownerRowndId], fixture.email);
  });

  it.each([
    { label: "ignores missing activity", survivorActivity: OLD, donorActivity: undefined },
    { label: "prefers canonical survivor on equal activity", survivorActivity: MID, donorActivity: MID },
    { label: "retains canonical survivor with all activity missing", survivorActivity: undefined, donorActivity: undefined },
  ])("$label", async ({ survivorActivity, donorActivity }) => {
    const fixture = await seedDuplicateOwners({ survivorMethods: 2, donorMethods: 1, survivorActivity, donorActivity });
    const result = await reconcileUser({ rownd_user_id: fixture.donor.rowndId });
    expect(result, JSON.stringify(result)).toMatchObject({ status: "OK", rownd_user_id: fixture.survivorRowndId,
      supertokens_user_id: fixture.survivor.internalId });
    await expectGraph(fixture.survivor.internalId, fixture.survivorRowndId, [fixture.donor.rowndId], fixture.recipes);
  });

  it("stays ambiguous with all activity missing and no canonical alias on the survivor", async () => {
    const fixture = await seedDuplicateOwners({ survivorMethods: 2, donorMethods: 1 });
    expect(await SuperTokens.deleteUserIdMapping({ userId: fixture.survivorRowndId, userIdType: "EXTERNAL", force: true }))
      .toMatchObject({ status: "OK" });
    const ids = [fixture.survivor.internalId, fixture.donor.internalId, fixture.survivorRowndId, fixture.donor.rowndId];
    const before = await snapshot(ids);
    const writes = await spyOnAuthWrites();
    for (const dryRun of [true, false]) {
      const result = await expectNoWrites(writes, () => reconcileUser({ rownd_user_id: fixture.donor.rowndId, dryRun }));
      expect(result, JSON.stringify(result)).toMatchObject({ status: "AMBIGUOUS", changed: false });
    }
    expect(await snapshot(ids)).toEqual(before);
  });

  it.each([1, 2])("consolidates a %s-method primary donor, detaching secondaries before demoting its primary", async (donorMethods) => {
    const fixture = await seedDuplicateOwners({ survivorMethods: 3, donorMethods, donorPrimary: true, survivorActivity: OLD, donorActivity: NEW });
    const detachOrder: string[] = [];
    const unlink = AccountLinking.unlinkAccount.bind(AccountLinking);
    vi.spyOn(AccountLinking, "unlinkAccount").mockImplementation(async (...args) => {
      const id = await immutableRecipeId(args[0].getAsString());
      if (id === fixture.donor.internalId) {
        const user = (await SuperTokens.getUser(id))!;
        expect((await recipeIdentities(user)).map(({ id }) => id)).toEqual([id]);
      }
      const result = await unlink(...args);
      expect(result.status).toBe("OK");
      detachOrder.push(id);
      return result;
    });
    const result = await reconcileUser({ rownd_user_id: fixture.donor.rowndId });
    expect(result, JSON.stringify(result)).toMatchObject({ status: "OK", rownd_user_id: fixture.donor.rowndId,
      supertokens_user_id: fixture.survivor.internalId });
    expect(detachOrder).toEqual([...fixture.donor.recipeIds.slice(1), fixture.donor.internalId]);
    await expectGraph(fixture.survivor.internalId, fixture.donor.rowndId, [fixture.survivorRowndId], fixture.recipes);
  });

  it.each([
    { owner: "survivor", secondary: false }, { owner: "survivor", secondary: true },
    { owner: "donor", secondary: false }, { owner: "donor", secondary: true },
  ])("allows preview and execution with a public session on $owner (secondary=$secondary)", async ({ owner, secondary }) => {
    const fixture = await seedDuplicateOwners({ survivorMethods: 3, donorMethods: 2, donorPrimary: true, survivorActivity: OLD, donorActivity: NEW });
    const seeded = owner === "donor" ? fixture.donor : fixture.survivor;
    const alias = owner === "donor" ? fixture.donor.rowndId : fixture.survivorRowndId;
    const recipeId = secondary ? seeded.recipeIds[1]! : alias;
    const session = await Session.createNewSessionWithoutRequestResponse("public", SuperTokens.convertToRecipeUserId(recipeId));
    expect(session.getUserId()).toBe(alias);
    const writes = await spyOnAuthWrites();
    expect(await expectNoWrites(writes, () => reconcileUser({ rownd_user_id: fixture.donor.rowndId, dryRun: true }))).toMatchObject({ status: "PREVIEW" });
    expect(await Session.getSessionInformation(session.getHandle())).toBeDefined();
    expect(await reconcileUser({ rownd_user_id: fixture.donor.rowndId })).toMatchObject({ status: "OK" });
    await expectGraph(fixture.survivor.internalId, fixture.donor.rowndId, [fixture.survivorRowndId], fixture.recipes);
  });

  it("allows an unchanged reconciliation no-op while a session is active", async () => {
    const email = uniqueEmail("noop");
    const rowndId = `rownd-noop-${randomUUID()}`;
    const owner = await createPwlOwner({ email, primary: true });
    await mapAlias(owner.internalId, rowndId);
    await verifyEmail(rowndId, email);
    await setSnapshot(owner.internalId, verifiedProfile(rowndId, { email, activity: NEW }));
    rownd.fetchUserInfo.mockResolvedValue(verifiedProfile(rowndId, { email, activity: NEW }));
    expect(await reconcileUser({ rownd_user_id: rowndId })).toMatchObject({ status: "OK" });

    const session = await Session.createNewSessionWithoutRequestResponse("public", SuperTokens.convertToRecipeUserId(rowndId));
    const writes = await spyOnAuthWrites();
    expect(await expectNoWrites(writes, () => reconcileUser({ rownd_user_id: rowndId })))
      .toMatchObject({ status: "OK", changed: false, actions: [] });
    expect(await expectNoWrites(writes, () => reconcileUser({ rownd_user_id: rowndId, dryRun: true })))
      .toMatchObject({ status: "PREVIEW", canReconcile: true, matchesSource: true, proposedActions: [] });
    expect(await Session.getSessionInformation(session.getHandle())).toBeDefined();
  });

  it("dry run plans the same survivor without any auth writes, then executes it", async () => {
    const fixture = await seedDuplicateOwners({ survivorMethods: 2, donorMethods: 1, survivorActivity: OLD, donorActivity: NEW });
    const donor = fixture.donor;
    const ids = [...fixture.recipes.map(({ id }) => id), donor.rowndId, fixture.survivorRowndId];
    const before = await snapshot(ids);
    const writes = await spyOnAuthWrites();

    const preview = await expectNoWrites(writes, () => reconcileUser({ rownd_user_id: donor.rowndId, dryRun: true }));
    expect(preview, JSON.stringify(preview)).toMatchObject({
      status: "PREVIEW", dryRun: true, changed: false, actions: [], snapshotOnly: true, canReconcile: true,
      rownd_user_id: donor.rowndId, supertokens_user_id: fixture.survivor.internalId,
      proposedActions: expect.arrayContaining([expect.objectContaining({ action: "link_method", recipeUserId: donor.internalId })]),
    });
    expect(await snapshot(ids)).toEqual(before);

    const executed = await reconcileUser({ rownd_user_id: donor.rowndId });
    expect(executed, JSON.stringify(executed)).toMatchObject({ status: "OK", rownd_user_id: preview.rownd_user_id,
      supertokens_user_id: preview.supertokens_user_id });
    await expectGraph(fixture.survivor.internalId, donor.rowndId, [fixture.survivorRowndId], fixture.recipes);
  });

  function interruptAfterCommit(phase: "detach" | "link" | "mapping delete" | "mapping create" | "promotion") {
    const committed: string[] = [];
    const interrupted = () => { throw new Error(`Lost ${phase} response`); };
    if (phase === "detach") {
      const original = AccountLinking.unlinkAccount.bind(AccountLinking);
      const spy = vi.spyOn(AccountLinking, "unlinkAccount").mockImplementationOnce(async (...args) => {
        const id = await immutableRecipeId(args[0].getAsString());
        const result = await original(...args);
        expect(result.status).toBe("OK");
        const user = (await SuperTokens.getUser(id))!;
        expect(user.isPrimaryUser).toBe(false);
        expect((await recipeIdentities(user)).map(({ id }) => id)).toEqual([id]);
        committed.push(id);
        return interrupted();
      });
      return { spy, committed };
    }
    if (phase === "link") {
      const original = AccountLinking.linkAccounts.bind(AccountLinking);
      const spy = vi.spyOn(AccountLinking, "linkAccounts").mockImplementationOnce(async (...args) => {
        const id = await immutableRecipeId(args[0].getAsString());
        const result = await original(...args);
        expect(result.status).toBe("OK");
        expect((await SuperTokens.getUser(id))?.id).toBe((await SuperTokens.getUser(args[1]))?.id);
        committed.push(id);
        return interrupted();
      });
      return { spy, committed };
    }
    if (phase === "promotion") {
      const original = AccountLinking.createPrimaryUser.bind(AccountLinking);
      const spy = vi.spyOn(AccountLinking, "createPrimaryUser").mockImplementationOnce(async (...args) => {
        const id = await immutableRecipeId(args[0].getAsString());
        const result = await original(...args);
        expect(result.status).toBe("OK");
        expect((await SuperTokens.getUser(id))?.isPrimaryUser).toBe(true);
        committed.push(id);
        return interrupted();
      });
      return { spy, committed };
    }
    if (phase === "mapping delete") {
      const original = SuperTokens.deleteUserIdMapping.bind(SuperTokens);
      const spy = vi.spyOn(SuperTokens, "deleteUserIdMapping").mockImplementationOnce(async (...args) => {
        const before = await SuperTokens.getUserIdMapping(args[0]);
        expect(before.status).toBe("OK");
        const result = await original(...args);
        expect(result.status).toBe("OK");
        expect((await SuperTokens.getUserIdMapping(args[0])).status).toBe("UNKNOWN_MAPPING_ERROR");
        committed.push(args[0].userId);
        return interrupted();
      });
      return { spy, committed };
    }
    const original = SuperTokens.createUserIdMapping.bind(SuperTokens);
    const spy = vi.spyOn(SuperTokens, "createUserIdMapping").mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      expect(result.status).toBe("OK");
      await expectMapped(args[0].externalUserId, args[0].superTokensUserId);
      committed.push(args[0].externalUserId);
      return interrupted();
    });
    return { spy, committed };
  }

  async function expectIncompleteCheckpoint(target: string) {
    const checkpoint = (await UserMetadata.getUserMetadata(target)).metadata.rownd_migration_owner_consolidation;
    expect(checkpoint).toMatchObject({ version: 2, target, status: expect.any(String) });
    expect(checkpoint).not.toMatchObject({ status: "COMPLETE" });
  }

  async function restartSDK() {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    resetST();
    await startServer();
  }

  it.each(["initial checkpoint", "token revocation", "verification token", "verification commit", "checkpoint", "completion"] as const)(
    "recovers after a committed %s response is lost during alias relocation", async (phase) => {
      const fixture = await seedOwnerlessCanonical();
      let committed = false;
      const lostResponse = () => { committed = true; throw new Error(`Lost ${phase} response`); };
      let restore: () => void;
      if (phase === "token revocation") {
        const original = EmailVerification.revokeEmailVerificationTokens.bind(EmailVerification);
        const spy = vi.spyOn(EmailVerification, "revokeEmailVerificationTokens").mockImplementationOnce(async (...args) => {
          const result = await original(...args);
          expect(result.status).toBe("OK");
          return lostResponse();
        });
        restore = () => spy.mockRestore();
      } else if (phase === "verification token") {
        const original = EmailVerification.createEmailVerificationToken.bind(EmailVerification);
        const spy = vi.spyOn(EmailVerification, "createEmailVerificationToken").mockImplementationOnce(async (...args) => {
          const result = await original(...args);
          expect(result.status).toBe("OK");
          return lostResponse();
        });
        restore = () => spy.mockRestore();
      } else if (phase === "verification commit") {
        const original = EmailVerification.verifyEmailUsingToken.bind(EmailVerification);
        const spy = vi.spyOn(EmailVerification, "verifyEmailUsingToken").mockImplementationOnce(async (...args) => {
          const result = await original(...args);
          expect(result.status).toBe("OK");
          return lostResponse();
        });
        restore = () => spy.mockRestore();
      } else {
        const original = UserMetadata.updateUserMetadata.bind(UserMetadata);
        const spy = vi.spyOn(UserMetadata, "updateUserMetadata").mockImplementation(async (...args) => {
          const result = await original(...args);
          const checkpoint = args[1].rownd_migration_owner_consolidation as { reservation?: boolean; status?: string; cursor?: number } | undefined;
          const selected = phase === "initial checkpoint" ? checkpoint?.status === "READY" && checkpoint.cursor === 0 :
            phase === "completion" ? checkpoint?.status === "COMPLETE" :
              args[0] === fixture.owner.internalId && checkpoint?.status === "READY" && (checkpoint.cursor ?? 0) > 0;
          if (!committed && selected) return lostResponse();
          return result;
        });
        restore = () => spy.mockRestore();
      }
      const first = await reconcileUser({ rownd_user_id: fixture.ownerlessRowndId });
      expect(committed, JSON.stringify(first)).toBe(true);
      expect(first, JSON.stringify(first)).toMatchObject({ status: "ERROR", message: `Lost ${phase} response`, partialProgress: true });
      restore();
      await restartSDK();
      const retry = await reconcileUser({ rownd_user_id: fixture.ownerlessRowndId });
      expect(retry, JSON.stringify(retry)).toMatchObject({ status: "OK", supertokens_user_id: fixture.owner.internalId });
      await expectGraph(fixture.owner.internalId, fixture.ownerlessRowndId, [fixture.ownerRowndId], fixture.recipes);
      expect((await SuperTokens.getUser(fixture.owner.internalId))!.loginMethods.find((method) => method.hasSameEmailAs(fixture.email))).toMatchObject({ verified: true });
    });

  it.each(["detach", "link", "mapping delete", "mapping create"] as const)("resumes after Core commits %s but its response is lost", async (phase) => {
    const fixture = await seedDuplicateOwners({
      survivorMethods: 3, donorMethods: 2, donorPrimary: true, survivorActivity: OLD, donorActivity: NEW,
    });
    const requested = fixture.donor;
    const { spy, committed } = interruptAfterCommit(phase);
    const first = await reconcileUser({ rownd_user_id: requested.rowndId });
    expect(spy, JSON.stringify(first)).toHaveBeenCalled();
    expect(committed).toHaveLength(1);
    expect(first, JSON.stringify(first)).toMatchObject({ status: "ERROR", partialProgress: true, changed: true });
    await expectIncompleteCheckpoint(fixture.survivor.internalId);
    spy.mockRestore();
    await restartSDK();

    const retry = await reconcileUser({ rownd_user_id: requested.rowndId });
    expect(retry, JSON.stringify(retry)).toMatchObject({ status: "OK", supertokens_user_id: fixture.survivor.internalId });
    await expectGraph(fixture.survivor.internalId, requested.rowndId, [fixture.survivorRowndId], fixture.recipes);
    expect((await UserMetadata.getUserMetadata(fixture.survivor.internalId)).metadata.rownd_migration_owner_consolidation)
      .toMatchObject({ status: "COMPLETE" });
    await expectNoopSelectors(fixture.survivor.internalId, requested.rowndId,
      [requested.rowndId, fixture.survivorRowndId], fixture.email);
  }, 60000);

  it("resumes after promotion committed without creating a replacement email owner", async () => {
    const fixture = await seedContactConsolidation();
    const { spy, committed } = interruptAfterCommit("promotion");
    const first = await reconcileUser({ rownd_user_id: fixture.requestedRowndId });
    expect(spy, JSON.stringify(first)).toHaveBeenCalled();
    expect(committed).toEqual([fixture.emailOwner.internalId]);
    expect(first, JSON.stringify(first)).toMatchObject({ status: "ERROR", changed: true, partialProgress: true });
    await expectIncompleteCheckpoint(fixture.emailOwner.internalId);
    spy.mockRestore();
    await restartSDK();
    const retry = await reconcileUser({ rownd_user_id: fixture.requestedRowndId });
    expect(retry, JSON.stringify(retry)).toMatchObject({ status: "OK", supertokens_user_id: fixture.emailOwner.internalId });
    const user = (await SuperTokens.getUser(fixture.requestedRowndId))!;
    const recipes = await recipeIdentities(user);
    expect(recipes).toHaveLength(3);
    expect(recipes.filter(({ id }) => fixture.recipes.some((recipe) => recipe.id === id))).toEqual(fixture.recipes);
    await expectGraph(fixture.emailOwner.internalId, fixture.requestedRowndId, [fixture.historicalRowndId], recipes);
    await expectNoopSelectors(fixture.emailOwner.internalId, fixture.requestedRowndId, [fixture.requestedRowndId], fixture.email);
  });

  it.each(["undefined", "404"])("blocks when a required consolidated Rownd source disappears (%s)", async (missing) => {
    const fixture = await seedDuplicateOwners({ survivorMethods: 3, donorMethods: 2, donorPrimary: true, survivorActivity: OLD, donorActivity: NEW });
    const requested = fixture.donor;
    const { spy, committed } = interruptAfterCommit("link");
    const interrupted = await reconcileUser({ rownd_user_id: requested.rowndId });
    expect(spy, JSON.stringify(interrupted)).toHaveBeenCalled();
    expect(committed).toHaveLength(1);
    expect(interrupted, JSON.stringify(interrupted)).toMatchObject({ status: "ERROR", changed: true, partialProgress: true });
    await expectIncompleteCheckpoint(fixture.survivor.internalId);
    spy.mockRestore();

    rownd.fetchUserInfo.mockImplementation(async ({ user_id }: { user_id: string }) => {
      if (user_id === requested.rowndId) {
        if (missing === "404") throw { response: { statusCode: 404 } };
        return undefined;
      }
      return fixture.profiles.get(user_id);
    });

    const ids = [...fixture.recipes.map(({ id }) => id), requested.rowndId, fixture.survivorRowndId];
    const before = await snapshot(ids);
    const writes = await spyOnAuthWrites();
    for (const rownd_user_id of [fixture.survivorRowndId, requested.rowndId]) for (const dryRun of [true, false]) {
      const result = await expectNoWrites(writes, () => reconcileUser({ rownd_user_id, dryRun }));
      expect(result, JSON.stringify(result)).toMatchObject({ status: "BLOCKED", changed: false,
        unresolved_owners: expect.arrayContaining([expect.objectContaining({ rownd_user_id: requested.rowndId })]) });
    }
    expect(await snapshot(ids)).toEqual(before);
  });

  it("publishes native and mocked Rownd JWT sessions through both consolidated aliases", async () => {
    const fixture = await seedDuplicateOwners({ survivorMethods: 2, donorMethods: 1, survivorActivity: OLD, donorActivity: NEW });
    const donor = fixture.donor;
    expect(await reconcileUser({ rownd_user_id: donor.rowndId })).toMatchObject({ status: "OK", supertokens_user_id: fixture.survivor.internalId });

    for (const alias of [fixture.survivorRowndId, donor.rowndId]) {
      const native = await Session.createNewSessionWithoutRequestResponse("public", SuperTokens.convertToRecipeUserId(alias));
      expect(native.getUserId()).toBe(donor.rowndId);
      expect(await immutableRecipeId(native.getRecipeUserId().getAsString())).toBe(await immutableRecipeId(alias));
      const response = await fetch(`${baseUrl}/test/native-session`, {
        method: "POST", headers: { "x-recipe-user-id": alias, "st-auth-mode": "header" },
      });
      expect({ status: response.status, body: await response.json() }).toEqual({ status: 200, body: { status: "OK" } });
      expect((await Session.getSessionWithoutRequestResponse(response.headers.get("st-access-token")!)).getUserId()).toBe(donor.rowndId);
    }

    for (const alias of [fixture.survivorRowndId, donor.rowndId]) {
      rownd.validateToken.mockResolvedValue({ user_id: alias });
      const response = await fetch(`${baseUrl}/auth/plugin/rownd/migrate`, {
        method: "POST", headers: { Authorization: "Bearer fixture-token", "st-auth-mode": "header", rid: "session", "fdi-version": "1.18" },
      });
      expect({ status: response.status, body: await response.json() }).toEqual({ status: 200, body: { status: "OK" } });
      const session = await Session.getSessionWithoutRequestResponse(response.headers.get("st-access-token")!);
      expect(session.getUserId()).toBe(donor.rowndId);
      expect(rownd.validateToken).toHaveBeenCalledWith("fixture-token");
      const profile = await fetch(`${baseUrl}/auth/plugin/rownd/user`, {
        headers: { Authorization: `Bearer ${response.headers.get("st-access-token")}`, rid: "session", "fdi-version": "1.18" },
      });
      expect(profile.status).toBe(200);
      expect(await profile.json()).toMatchObject({ status: "OK", rownd_user: donor.rowndId, data: { email: fixture.email } });
    }
    await expectGraph(fixture.survivor.internalId, donor.rowndId, [fixture.survivorRowndId], fixture.recipes);
    await expectNoopSelectors(fixture.survivor.internalId, donor.rowndId, [fixture.survivorRowndId, donor.rowndId], fixture.email);
  });
});

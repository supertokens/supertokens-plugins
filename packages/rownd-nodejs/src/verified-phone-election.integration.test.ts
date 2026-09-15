import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import SuperTokens from "supertokens-node";
import AccountLinking from "supertokens-node/recipe/accountlinking";
import Passwordless from "supertokens-node/recipe/passwordless";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import Session from "supertokens-node/recipe/session";
import EmailVerification from "supertokens-node/recipe/emailverification";
import ThirdParty from "supertokens-node/recipe/thirdparty";
import { GenericContainer, Network, Wait } from "testcontainers";
import type { StartedNetwork, StartedTestContainer } from "testcontainers";
import { setRowndClient } from "./rownd-repository";
import { fetchAdministrativeMigrationSource } from "./migration-email";
import {
  AmbiguousAdministrativeElection,
  assertAdministrativeElection,
  bindAdministrativeElection,
  inspectAdministrativeElection,
  sharesAdministrativeElectionPhone,
} from "./migration-election";
import { inspectVerifiedPhoneSurvivor } from "./migration-phone-election";
import type { RowndUser } from "./types";
import { reconcileUser } from "./reconcile-user";
import { init } from "./plugin";
import { createMissingLoginMethod } from "./supertokens-repository";

vi.mock("@rownd/node", () => ({ createInstance: () => ({ validateToken: vi.fn(), fetchUserInfo: vi.fn() }) }));

describe("standalone verified-phone source election", () => {
  let network: StartedNetwork;
  let postgres: StartedTestContainer;
  let core: StartedTestContainer;
  beforeAll(async () => {
    network = await new Network().start();
    postgres = await new GenericContainer("postgres:14")
      .withNetwork(network).withNetworkAliases("postgres")
      .withEnvironment({ POSTGRES_USER: "supertokens", POSTGRES_PASSWORD: "somepassword", POSTGRES_DB: "supertokens" })
      .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections")).start();
    core = await new GenericContainer("supertokens/supertokens-postgresql")
      .withNetwork(network)
      .withEnvironment({ POSTGRESQL_CONNECTION_URI: "postgresql://supertokens:somepassword@postgres:5432/supertokens" })
      .withExposedPorts(3567).withWaitStrategy(Wait.forHttp("/hello", 3567)).start();
    await fetch(`http://${core.getHost()}:${core.getMappedPort(3567)}/ee/license`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ licenseKey: "N2uEOdEzd1XZZ5VBSTGYaM7Ia4s8wAqRWFAxLqTYrB6GQ=vssOLo3c=PkFgcExkaXs=IA-d9UWccoNKsyUgNhOhcKtM1bjC5OLrYRpTAgN-2EbKYsQGGQRQHuUN4EO1V" }),
    });
    SuperTokens.init({
      supertokens: { connectionURI: `http://${core.getHost()}:${core.getMappedPort(3567)}` },
      appInfo: { appName: "Phone election", apiDomain: "http://localhost:3001", websiteDomain: "http://localhost:3000" },
      recipeList: [
        AccountLinking.init({ shouldDoAutomaticAccountLinking: async () => ({ shouldAutomaticallyLink: false }) }),
        UserMetadata.init(),
        Session.init(), EmailVerification.init({ mode: "OPTIONAL" }), ThirdParty.init(),
        Passwordless.init({ contactMethod: "PHONE", flowType: "USER_INPUT_CODE" }),
      ],
      experimental: { plugins: [init({ rowndAppKey: "test-key", rowndAppSecret: "test-secret" })] },
    });
  }, 120000);
  afterAll(async () => {
    setRowndClient(undefined);
    await core?.stop();
    await postgres?.stop();
    await network?.stop();
  });

  async function seed(phoneNumber = `+1555${String(Math.floor(Math.random() * 10000000)).padStart(7, "0")}`) {
    const older = randomUUID(), newer = randomUUID();
    const account = await Passwordless.signInUp({ tenantId: "public", phoneNumber });
    const id = account.recipeUserId.getAsString();
    expect((await SuperTokens.createUserIdMapping({ superTokensUserId: id, externalUserId: older })).status).toBe("OK");
    const profiles: Record<string, RowndUser> = {
      [older]: { data: { user_id: older, phone_number: phoneNumber }, verified_data: { phone_number: phoneNumber }, meta: { last_active: "2020-01-01T00:00:00Z" } },
      [newer]: { data: { user_id: newer, phone_number: phoneNumber, email: "newer@example.com", apple_id: randomUUID() }, verified_data: { phone_number: phoneNumber }, meta: { last_active: "2021-01-01T00:00:00Z" } },
    };
    await UserMetadata.updateUserMetadata(id, { original_rownd_user: profiles[older] });
    setRowndClient({ validateToken: vi.fn(), fetchUserInfo: vi.fn(async ({ user_id }) => profiles[user_id]) });
    const user = (await SuperTokens.getUser(id))!;
    const candidates = [{ rownd_user_id: older, supertokens_user_id: id }, { rownd_user_id: newer }];
    const proof = inspectVerifiedPhoneSurvivor([{ id, user }], candidates, "public");
    expect(proof).toEqual({ phoneNumber: user.loginMethods[0]!.phoneNumber, supertokensUserId: id });
    return { older, newer, phoneNumber, id, user, profiles, candidates, proof };
  }

  it("elects the ownerless newest source and pins the mapped standalone phone survivor", async () => {
    const fixture = await seed();
    const election = await inspectAdministrativeElection(fixture.candidates, { verifiedPhoneSurvivor: fixture.proof });
    expect(election.winner).toEqual({ rownd_user_id: fixture.newer, activity: "2021-01-01T00:00:00.000Z" });
    expect(election.verifiedPhoneSurvivor?.supertokensUserId).toBe(fixture.id);
    expect(await SuperTokens.getUserIdMapping({ userId: fixture.newer, userIdType: "EXTERNAL" })).toMatchObject({ status: "UNKNOWN_MAPPING_ERROR" });
    const source = (await fetchAdministrativeMigrationSource(fixture.newer, "public", {}))!;
    const owners = vi.fn(async () => {});
    bindAdministrativeElection(source, "public", election, owners);
    expect(sharesAdministrativeElectionPhone(source, fixture.profiles[fixture.older]!, fixture.profiles[fixture.newer]!)).toBe(true);
    await assertAdministrativeElection(source);
    expect(owners).toHaveBeenCalledOnce();
  });

  it.each([false, true])("reconciles an ownerless verified-phone winner, retires its donor and retries (interrupted: %s)", async (interrupt) => {
    const fixture = await seed();
    fixture.profiles[fixture.newer]!.data.email = `${randomUUID()}@example.com`;
    const preview = await reconcileUser({ rownd_user_id: fixture.newer, dryRun: true });
    expect(preview, JSON.stringify(preview)).toMatchObject({ canReconcile: true, supertokens_user_id: fixture.id });
    expect((await SuperTokens.getUserIdMapping({ userId: fixture.older, userIdType: "EXTERNAL" })).status).toBe("OK");
    if (interrupt) {
      const create = vi.spyOn(SuperTokens, "createUserIdMapping").mockRejectedValueOnce(new Error("Injected failure after donor retirement"));
      try {
        const failed = await reconcileUser({ rownd_user_id: fixture.newer });
        expect(failed, JSON.stringify(failed)).toMatchObject({ status: "ERROR", partialProgress: true });
      } finally { create.mockRestore(); }
    }
    const executed = await reconcileUser({ rownd_user_id: fixture.newer });
    expect(executed, JSON.stringify(executed)).toMatchObject({ status: "OK", supertokens_user_id: fixture.id });
    expect(await SuperTokens.getUserIdMapping({ userId: fixture.older, userIdType: "EXTERNAL" })).toMatchObject({ status: "UNKNOWN_MAPPING_ERROR" });
    expect((await UserMetadata.getUserMetadata(fixture.older)).metadata).toMatchObject({ rownd_migration_superseded: { rowndUserId: fixture.newer, targetUserId: fixture.id } });
    expect(await SuperTokens.getUserIdMapping({ userId: fixture.newer, userIdType: "EXTERNAL" })).toMatchObject({ status: "OK", superTokensUserId: fixture.id });
    const retry = await reconcileUser({ rownd_user_id: fixture.newer });
    expect(retry, JSON.stringify(retry)).toMatchObject({ status: "OK", changed: false });
  });

  it.each(["unverified", "primary", "multi-method", "multi-owner"])("excludes %s shared-phone owners from full reconciliation", async (kind) => {
    const fixture = await seed();
    if (kind === "unverified") fixture.profiles[fixture.newer]!.verified_data = {};
    if (kind === "primary" || kind === "multi-method") {
      expect((await AccountLinking.createPrimaryUser(SuperTokens.convertToRecipeUserId(fixture.older))).status).toBe("OK");
    }
    if (kind === "multi-method" || kind === "multi-owner") {
      const email = `${randomUUID()}@example.com`;
      fixture.profiles[fixture.newer]!.data.email = email;
      const extra = await Passwordless.signInUp({ tenantId: "public", email });
      if (kind === "multi-method") expect((await AccountLinking.linkAccounts(extra.recipeUserId, fixture.older)).status).toBe("OK");
    }
    for (const dryRun of [true, false]) {
      const result = await reconcileUser({ rownd_user_id: fixture.newer, dryRun });
      expect(result, JSON.stringify(result)).toMatchObject({ status: "AMBIGUOUS", changed: false, ...(dryRun ? { canReconcile: false } : {}) });
    }
    expect(await SuperTokens.getUserIdMapping({ userId: fixture.older, userIdType: "EXTERNAL" })).toMatchObject({ status: "OK", superTokensUserId: fixture.id });
  });

  it("elects the mapped phone source when it is newer than the requested ownerless source", async () => {
    const fixture = await seed();
    fixture.profiles[fixture.older]!.meta!.last_active = "2022-01-01T00:00:00Z";
    for (const dryRun of [true, false]) {
      const result = await reconcileUser({ rownd_user_id: fixture.newer, dryRun });
      expect(result, JSON.stringify(result)).toMatchObject({ status: dryRun ? "PREVIEW" : "OK", rownd_user_id: fixture.older, supertokens_user_id: fixture.id });
    }
    expect(await SuperTokens.getUserIdMapping({ userId: fixture.older, userIdType: "EXTERNAL" })).toMatchObject({ status: "OK", superTokensUserId: fixture.id });
    expect(await SuperTokens.getUserIdMapping({ userId: fixture.newer, userIdType: "EXTERNAL" })).toMatchObject({ status: "UNKNOWN_MAPPING_ERROR" });
  });

  it("rejects verified-phone drift during interrupted owner-plan recovery", async () => {
    const fixture = await seed();
    const create = vi.spyOn(SuperTokens, "createUserIdMapping").mockRejectedValueOnce(new Error("Injected interruption"));
    try { expect(await reconcileUser({ rownd_user_id: fixture.newer })).toMatchObject({ status: "ERROR", partialProgress: true }); }
    finally { create.mockRestore(); }
    fixture.profiles[fixture.older]!.verified_data = {};
    const retry = await reconcileUser({ rownd_user_id: fixture.newer });
    expect(retry, JSON.stringify(retry)).toMatchObject({ status: "AMBIGUOUS", changed: false });
    expect(await SuperTokens.getUserIdMapping({ userId: fixture.newer, userIdType: "EXTERNAL" })).toMatchObject({ status: "UNKNOWN_MAPPING_ERROR" });
  });

  it("conservatively rejects shared verified legacy Mexico phones against a canonical Core survivor without writes", async () => {
    const fixture = await seed("+5213312345681");
    expect(fixture.user.loginMethods[0]!.phoneNumber).toBe("+523312345681");
    const before = await UserMetadata.getUserMetadata(fixture.id);
    const writes = [
      vi.spyOn(Passwordless, "signInUp"), vi.spyOn(AccountLinking, "createPrimaryUser"),
      vi.spyOn(AccountLinking, "linkAccounts"), vi.spyOn(SuperTokens, "createUserIdMapping"),
      vi.spyOn(SuperTokens, "deleteUserIdMapping"), vi.spyOn(UserMetadata, "updateUserMetadata"),
    ];
    try {
      // Core phone equivalence does not authorize source election.
      for (const dryRun of [true, false]) {
        const result = await reconcileUser({ rownd_user_id: fixture.newer, dryRun });
        expect(result, JSON.stringify(result)).toMatchObject({ status: "AMBIGUOUS", changed: false });
      }
      for (const write of writes) expect(write).not.toHaveBeenCalled();
    } finally { for (const write of writes) write.mockRestore(); }
    expect(await UserMetadata.getUserMetadata(fixture.id)).toEqual(before);
    expect(await SuperTokens.getUserIdMapping({ userId: fixture.older, userIdType: "EXTERNAL" })).toMatchObject({ status: "OK", superTokensUserId: fixture.id });
    expect(await SuperTokens.getUserIdMapping({ userId: fixture.newer, userIdType: "EXTERNAL" })).toMatchObject({ status: "UNKNOWN_MAPPING_ERROR" });
  });

  it("blocks checkpoint recovery after an external owner-graph change before altering preserved mappings", async () => {
    const fixture = await seed();
    const promote = vi.spyOn(AccountLinking, "createPrimaryUser").mockRejectedValueOnce(new Error("Injected interruption before survivor promotion"));
    try {
      expect(await reconcileUser({ rownd_user_id: fixture.newer })).toMatchObject({ status: "ERROR", partialProgress: true });
    } finally { promote.mockRestore(); }
    expect((await SuperTokens.getUser(fixture.id))!.isPrimaryUser).toBe(false);
    const extra = await Passwordless.signInUp({ tenantId: "public", email: `${randomUUID()}@example.com` });
    expect((await AccountLinking.createPrimaryUser(SuperTokens.convertToRecipeUserId(fixture.older))).status).toBe("OK");
    expect((await AccountLinking.linkAccounts(extra.recipeUserId, fixture.older)).status).toBe("OK");
    const before = await UserMetadata.getUserMetadata(fixture.id);
    const writes = [
      vi.spyOn(SuperTokens, "createUserIdMapping"), vi.spyOn(SuperTokens, "deleteUserIdMapping"),
      vi.spyOn(UserMetadata, "updateUserMetadata"), vi.spyOn(AccountLinking, "linkAccounts"),
      vi.spyOn(AccountLinking, "createPrimaryUser"), vi.spyOn(Passwordless, "signInUp"),
    ];
    try {
      const retry = await reconcileUser({ rownd_user_id: fixture.newer });
      expect(retry, JSON.stringify(retry)).toMatchObject({ status: "BLOCKED", changed: false });
      for (const write of writes) expect(write).not.toHaveBeenCalled();
    } finally { for (const write of writes) write.mockRestore(); }
    expect(await UserMetadata.getUserMetadata(fixture.id)).toEqual(before);
    expect(await SuperTokens.getUserIdMapping({ userId: fixture.older, userIdType: "EXTERNAL" })).toMatchObject({ status: "OK", superTokensUserId: fixture.id });
    expect(await SuperTokens.getUserIdMapping({ userId: fixture.newer, userIdType: "EXTERNAL" })).toMatchObject({ status: "UNKNOWN_MAPPING_ERROR" });
    expect((await SuperTokens.getUser(fixture.id))!.loginMethods).toHaveLength(2);
  });

  it.each(["unverified", "verification-drift", "current-drift"])("rejects %s phone evidence", async (change) => {
    const fixture = await seed();
    const election = await inspectAdministrativeElection(fixture.candidates, { verifiedPhoneSurvivor: fixture.proof });
    const source = (await fetchAdministrativeMigrationSource(fixture.newer, "public", {}))!;
    bindAdministrativeElection(source, "public", election, async () => {});
    const profile = fixture.profiles[fixture.older]!;
    if (change === "unverified") delete profile.verified_data!.phone_number;
    else if (change === "verification-drift") profile.verified_data!.phone_number = "+15550000000";
    else profile.data.phone_number = "+15550000000";
    expect(sharesAdministrativeElectionPhone(source, profile, fixture.profiles[fixture.newer]!)).toBe(false);
    await expect(inspectAdministrativeElection(fixture.candidates, { verifiedPhoneSurvivor: fixture.proof })).rejects.toBeInstanceOf(AmbiguousAdministrativeElection);
    await expect(assertAdministrativeElection(source)).rejects.toThrow("election changed");
  });

  it("does not enable phone election without explicit survivor eligibility", async () => {
    const fixture = await seed();
    await expect(inspectAdministrativeElection(fixture.candidates)).rejects.toBeInstanceOf(AmbiguousAdministrativeElection);
    await expect(inspectAdministrativeElection(fixture.candidates, {
      verifiedPhoneSurvivor: { phoneNumber: fixture.phoneNumber, supertokensUserId: fixture.id },
    })).rejects.toBeInstanceOf(AmbiguousAdministrativeElection);
    for (const user of [
      { ...fixture.user, isPrimaryUser: true },
      { ...fixture.user, loginMethods: [...fixture.user.loginMethods, ...fixture.user.loginMethods] },
      { ...fixture.user, loginMethods: fixture.user.loginMethods.map((method) => ({ ...method, verified: false })) },
      { ...fixture.user, loginMethods: fixture.user.loginMethods.map((method) => ({ ...method, tenantIds: ["public", "other"] })) },
    ]) expect(inspectVerifiedPhoneSurvivor([{ id: fixture.id, user }], fixture.candidates, "public")).toBeUndefined();
    expect(inspectVerifiedPhoneSurvivor([{ id: fixture.id, user: fixture.user }], fixture.candidates, "other")).toBeUndefined();
    expect(inspectVerifiedPhoneSurvivor([{ id: fixture.id, user: fixture.user }], [...fixture.candidates, { rownd_user_id: "other", supertokens_user_id: "other-owner" }], "public")).toBeUndefined();
  });

  it("does not normalize phone strings or prefer an older requested source", async () => {
    const fixture = await seed();
    fixture.profiles[fixture.older]!.meta!.last_active = "2022-01-01T00:00:00Z";
    expect((await inspectAdministrativeElection(fixture.candidates, { verifiedPhoneSurvivor: fixture.proof, canonicalRowndId: fixture.newer })).winner.rownd_user_id).toBe(fixture.older);
    fixture.profiles[fixture.newer]!.verified_data!.phone_number = ` ${fixture.phoneNumber}`;
    await expect(inspectAdministrativeElection(fixture.candidates, { verifiedPhoneSurvivor: fixture.proof })).rejects.toThrow("SOURCE_PAYLOAD");
  });

  it.each([
    { mexico: false, interrupt: false }, { mexico: true, interrupt: false },
    { mexico: false, interrupt: true }, { mexico: true, interrupt: true },
  ])("executes adding a verified phone and retries ($mexico, interrupted: $interrupt)", async ({ mexico, interrupt }) => {
    const id = randomUUID(), email = `${randomUUID()}@example.com`;
    const phoneNumber = mexico ? (interrupt ? "+5213312345680" : "+5213312345679") : `+1555${String(Math.floor(Math.random() * 10000000)).padStart(7, "0")}`;
    const existing = await Passwordless.signInUp({ tenantId: "public", email });
    const target = existing.recipeUserId.getAsString();
    expect((await AccountLinking.createPrimaryUser(existing.recipeUserId)).status).toBe("OK");
    expect((await SuperTokens.createUserIdMapping({ superTokensUserId: target, externalUserId: id })).status).toBe("OK");
    const historical: RowndUser = { data: { user_id: id, email }, verified_data: { email } };
    const current: RowndUser = { data: { user_id: id, email, phone_number: phoneNumber }, verified_data: { email, phone_number: phoneNumber } };
    await UserMetadata.updateUserMetadata(target, { original_rownd_user: historical });
    setRowndClient({ validateToken: vi.fn(), fetchUserInfo: vi.fn(async () => current) });
    const preview = await reconcileUser({ rownd_user_id: id, dryRun: true });
    expect(preview, JSON.stringify(preview)).toMatchObject({ canReconcile: true });
    if (interrupt) {
      const link = vi.spyOn(AccountLinking, "linkAccounts").mockRejectedValueOnce(new Error("Injected failure after phone creation"));
      try {
        expect(await reconcileUser({ rownd_user_id: id })).toMatchObject({ status: "ERROR", partialProgress: true });
      } finally { link.mockRestore(); }
    }
    const executed = await reconcileUser({ rownd_user_id: id });
    expect(executed, JSON.stringify(executed)).toMatchObject({ status: "OK" });
    expect(await reconcileUser({ rownd_user_id: id })).toMatchObject({ status: "OK" });
    expect((await SuperTokens.getUser(id))!.loginMethods.filter((method) => method.phoneNumber === (mexico ? phoneNumber.replace(/^\+521/, "+52") : phoneNumber))).toHaveLength(1);
  });

  it("reuses Core's canonical Mexico phone instead of repeatedly trying to create the legacy form", async () => {
    const id = randomUUID();
    const phoneNumber = "+5213312345678";
    const existing = await Passwordless.signInUp({ tenantId: "public", phoneNumber });
    const target = existing.recipeUserId.getAsString();
    expect(existing.user.loginMethods[0]!.phoneNumber).toBe("+523312345678");
    expect((await AccountLinking.createPrimaryUser(existing.recipeUserId)).status).toBe("OK");
    expect((await SuperTokens.createUserIdMapping({ superTokensUserId: target, externalUserId: id })).status).toBe("OK");
    const current: RowndUser = { data: { user_id: id, phone_number: phoneNumber }, verified_data: { phone_number: phoneNumber } };
    await UserMetadata.updateUserMetadata(target, { original_rownd_user: current });
    setRowndClient({ validateToken: vi.fn(), fetchUserInfo: vi.fn(async () => current) });
    // Exercise the executor's existing-user response as well as planner discovery.
    const method = { recipeId: "passwordless" as const, phoneNumber, isVerified: true, tenantIds: ["public"], timeJoinedInMSSinceEpoch: 1 };
    expect(await createMissingLoginMethod(method, "public", target, {})).toMatchObject({ createdNewRecipeUser: false });
    const preview = await reconcileUser({ rownd_user_id: id, dryRun: true });
    expect(preview, JSON.stringify(preview)).toMatchObject({ canReconcile: true });
    expect(preview.proposedActions?.some((action) => action.action === "create_method")).toBe(false);
    for (let retry = 0; retry < 2; retry++) {
      const result = await reconcileUser({ rownd_user_id: id });
      expect(result, JSON.stringify(result)).toMatchObject({ status: "OK" });
    }
    expect((await SuperTokens.getUser(id))!.loginMethods).toHaveLength(1);
  });
});

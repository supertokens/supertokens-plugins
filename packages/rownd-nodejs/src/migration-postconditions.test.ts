import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SuperTokens from "supertokens-node";
import AccountLinking from "supertokens-node/recipe/accountlinking";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import { User } from "supertokens-node/lib/build/user";
import type { JSONObject } from "supertokens-node/types";
import { authenticateRowndMigration } from "./migration-email";
import { setRowndClient } from "./rownd-repository";
import { reconcileRowndUserWithExistingLoginMethods } from "./supertokens-repository";
import { MigrationTelemetry } from "./telemetry/migrationTelemetry";
import type { RowndTelemetryEvent, RowndUser } from "./types";

const A = "user_hgwgla2euzmwi7dcfutpfrcu";
const B = "user_u87w7uwa0nit6xg74w36pba0";
const U = "a45d4498-738e-422b-9844-9c58fd666deb";
const email = "migration-regression@example.test";

describe("migration final postconditions", () => {
  let alias: string | undefined;
  let metadata: Map<string, JSONObject>;
  let events: RowndTelemetryEvent[];
  let telemetry: MigrationTelemetry;
  let context: { rowndMigrationTelemetry: MigrationTelemetry; _default: { coreCallCache: JSONObject; core_call_cache: JSONObject } };
  let observations: Array<() => User | undefined>;
  let observedTargets: string[];
  let sourceEmail: string;

  const snapshot = (id = alias ?? U, verified = true, tenantIds = ["public"], hasMethod = true) =>
    new User({
      id, isPrimaryUser: false, emails: [email], phoneNumbers: [], thirdParty: [],
      webauthn: { credentialIds: [] }, tenantIds, timeJoined: 1,
      loginMethods: hasMethod ? [{
        recipeId: "passwordless", recipeUserId: id, email, verified, tenantIds, timeJoined: 1,
      }] : [],
    });

  beforeEach(() => {
    alias = B;
    sourceEmail = email;
    metadata = new Map([[U, { customer_data: "preserved" }]]);
    events = [];
    telemetry = new MigrationTelemetry((event) => { events.push(event); });
    context = { rowndMigrationTelemetry: telemetry, _default: { coreCallCache: {}, core_call_cache: {} } };
    observations = [];
    observedTargets = [];
    setRowndClient({
      validateToken: async () => ({ user_id: A }),
      fetchUserInfo: async ({ user_id }): Promise<RowndUser> => ({
        data: { user_id, email: user_id === A ? sourceEmail : email },
        verified_data: { email: true }, state: "enabled", auth_level: "verified",
      }),
    });
    vi.spyOn(UserMetadata, "getUserMetadata").mockImplementation(async (id) => ({
      status: "OK", metadata: structuredClone(metadata.get(id) ?? {}),
    }));
    vi.spyOn(UserMetadata, "updateUserMetadata").mockImplementation(async (id, update) => {
      const next = { ...metadata.get(id), ...structuredClone(update) };
      metadata.set(id, next);
      return { status: "OK", metadata: next };
    });
    vi.spyOn(SuperTokens, "getUserIdMapping").mockImplementation(async ({ userId, userIdType }) =>
      alias && ((userIdType === "EXTERNAL" && userId === alias) ||
        (userIdType === "SUPERTOKENS" && userId === U))
        ? { status: "OK", superTokensUserId: U, externalUserId: alias }
        : { status: "UNKNOWN_MAPPING_ERROR" });
    vi.spyOn(SuperTokens, "deleteUserIdMapping").mockImplementation(async ({ userId }) => {
      expect(userId).toBe(B);
      alias = undefined;
      return { status: "OK", didMappingExist: true };
    });
    vi.spyOn(SuperTokens, "createUserIdMapping").mockImplementation(async ({ superTokensUserId, externalUserId }) => {
      expect(superTokensUserId).toBe(U);
      expect(alias).toBeUndefined();
      alias = externalUserId;
      return { status: "OK" };
    });
    vi.spyOn(SuperTokens, "getUser").mockImplementation(async (id) => {
      if (telemetry.stage === "migration_postcondition") {
        observedTargets.push(id);
        const observation = observations.shift();
        if (observation) return observation();
      }
      return id === U || id === alias ? snapshot() : undefined;
    });
    vi.spyOn(SuperTokens, "listUsersByAccountInfo").mockImplementation(async () => [snapshot()]);
    vi.spyOn(AccountLinking, "createPrimaryUser").mockImplementation(async () => {
      throw new Error("Standalone contact must not elect a primary account");
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setRowndClient(undefined);
  });

  async function migrate() {
    const { source } = await authenticateRowndMigration("token-A", "public", context);
    return reconcileRowndUserWithExistingLoginMethods(source, "public", context);
  }

  function expectNoCompletion() {
    expect(metadata.get(U)?.rownd_migration_complete).not.toBe(true);
    expect(vi.mocked(UserMetadata.updateUserMetadata).mock.calls.some(
      ([, update]) => update.rownd_migration_complete === true,
    )).toBe(false);
    expect(events.some((event) => event.reason === "migration_metadata_written")).toBe(false);
  }

  it("retires B for A on the same standalone verified passwordless U", async () => {
    expect(await migrate()).toBe(true);
    expect(alias).toBe(A);
    expect(metadata.get(B)?.rownd_migration_superseded).toEqual({ rowndUserId: A, targetUserId: U });
    expect(metadata.get(U)).toMatchObject({ customer_data: "preserved", rownd_migration_complete: true });
    expect(observedTargets).toEqual([U]);
    expect(AccountLinking.createPrimaryUser).not.toHaveBeenCalled();
  });

  it.each(["missing_user", "unexpected_owner", "missing_method", "missing_tenant", "unverified_authenticated_email"])(
    "recovers a stale %s observation with one fresh read pinned to U", async (reason) => {
      observations.push(() => {
        context._default.coreCallCache = { stale: true };
        context._default.core_call_cache = { stale: true };
        if (reason === "missing_user") return undefined;
        if (reason === "unexpected_owner") return snapshot(B);
        if (reason === "missing_method") return snapshot(A, true, ["public"], false);
        if (reason === "missing_tenant") return snapshot(A, true, ["other"]);
        return snapshot(A, false);
      }, () => {
        expect(context._default.coreCallCache).toEqual({});
        expect(context._default.core_call_cache).toEqual({});
        return snapshot();
      });
      expect(await migrate()).toBe(true);
      expect(observedTargets).toEqual([U, U]);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ stage: "migration_postcondition", reason: `migration_postcondition_${reason}` }),
        expect.objectContaining({ reason: "migration_postcondition_recovered" }),
      ]));
      expect(metadata.get(U)?.rownd_migration_complete).toBe(true);
    },
  );

  it("keeps a genuinely missing method failed without publishing completion, then resumes partial migration", async () => {
    observations.push(() => snapshot(A, true, ["public"], false), () => snapshot(A, true, ["public"], false));
    await expect(migrate()).rejects.toThrow("postcondition failed: missing_method");
    expect(observedTargets).toEqual([U, U]);
    expect(alias).toBe(A);
    expectNoCompletion();

    telemetry.stage = "configuration";
    expect(await migrate()).toBe(true);
    expect(metadata.get(U)?.rownd_migration_complete).toBe(true);
    expect(SuperTokens.deleteUserIdMapping).toHaveBeenCalledTimes(1);
    expect(SuperTokens.createUserIdMapping).toHaveBeenCalledTimes(1);
  });

  it("rejects a changed mapping during recovery without electing another target", async () => {
    observations.push(() => { alias = B; return undefined; });
    await expect(migrate()).rejects.toThrow("mapping postcondition failed");
    expect(observedTargets).toEqual([U]);
    expectNoCompletion();
    expect(SuperTokens.createUserIdMapping).toHaveBeenCalledTimes(1);
  });

  it("publishes completion when an explicit repair resumes an incomplete migration", async () => {
    alias = A;
    const { source } = await authenticateRowndMigration("token-A", "public", context);
    expect(await reconcileRowndUserWithExistingLoginMethods(source, "public", context, {
      repairUser: snapshot(),
    })).toBe(true);
    expect(metadata.get(U)?.rownd_migration_complete).toBe(true);
    expect(observedTargets).toEqual([U]);
    expect(SuperTokens.createUserIdMapping).not.toHaveBeenCalled();
  });

  it("rejects a mapping changed during the recovered user observation", async () => {
    observations.push(() => undefined, () => {
      const user = snapshot();
      alias = B;
      return user;
    });
    await expect(migrate()).rejects.toThrow("mapping postcondition failed");
    expect(observedTargets).toEqual([U, U]);
    expectNoCompletion();
    expect(events.some((event) => event.reason === "migration_postcondition_recovered")).toBe(false);
  });

  it.each(["missing_user", "unexpected_owner", "missing_tenant", "unverified_authenticated_email"])(
    "does not suppress genuine %s failure or publish completion", async (reason) => {
      const failedObservation = () => {
        if (reason === "missing_user") return undefined;
        if (reason === "unexpected_owner") return snapshot("unrelated-user");
        if (reason === "missing_tenant") return snapshot(A, true, ["other"]);
        return snapshot(A, false);
      };
      observations.push(failedObservation, failedObservation);
      await expect(migrate()).rejects.toThrow(`postcondition failed: ${reason}`);
      expect(observedTargets).toEqual([U, U]);
      expectNoCompletion();
    },
  );

  it("requires the reverse mapping to remain bound to A during recovery", async () => {
    observations.push(() => {
      vi.mocked(SuperTokens.getUserIdMapping).mockImplementation(async ({ userIdType }) => ({
        status: "OK", superTokensUserId: U, externalUserId: userIdType === "EXTERNAL" ? A : B,
      }));
      return undefined;
    });
    await expect(migrate()).rejects.toThrow("mapping postcondition failed");
    expect(observedTargets).toEqual([U]);
    expectNoCompletion();
  });

  it("propagates Core read errors without treating them as stale observations", async () => {
    observations.push(() => { throw new Error("Core unavailable"); });
    await expect(migrate()).rejects.toThrow("Core unavailable");
    expect(observedTargets).toEqual([U]);
    expectNoCompletion();
  });

  it("rejects changed authenticated source on recovery", async () => {
    observations.push(() => { sourceEmail = "changed@example.test"; return undefined; });
    await expect(migrate()).rejects.toThrow("source identity changed");
    expect(observedTargets).toEqual([U]);
    expectNoCompletion();
  });

  it("does not publish completion when downstream canonical email publication fails", async () => {
    alias = A;
    const migrationEmail = await import("./migration-email");
    vi.spyOn(migrationEmail, "prepareCurrentRowndEmailReconciliation").mockResolvedValue({
      email, placeholderIds: [], assertFreshSource: async () => {}, assertCompatibleMethods: () => {},
      migrationSource: {
        rowndUserId: A, providerId: "google", providerUserId: "provider-subject",
        providerRecipeUserId: "provider-recipe", previousEmail: "old@example.test",
      },
    });
    vi.spyOn(migrationEmail, "checkpointCurrentRowndEmailRetirement").mockResolvedValue([]);
    vi.mocked(UserMetadata.updateUserMetadata).mockImplementation(async (id, update) => {
      // Simulate a canonical publication that did not persist in Core.
      const next = { ...metadata.get(id), ...structuredClone(update) };
      delete next.rownd_email_recipe_user_id;
      delete next.rownd_email_recipe_user_ids;
      metadata.set(id, next);
      return { status: "OK", metadata: next };
    });
    const { source } = await authenticateRowndMigration("token-A", "public", context);
    await expect(reconcileRowndUserWithExistingLoginMethods(source, "public", context, {
      repairUser: snapshot(),
    })).rejects.toThrow("canonical email publication failed");
    expectNoCompletion();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import SuperTokens from "supertokens-node";
import Passwordless from "supertokens-node/recipe/passwordless";
import Session from "supertokens-node/recipe/session";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import { User } from "supertokens-node/lib/build/user";
import { findExistingImportMethodUsers, inspectMigrationMethods } from "./supertokens-repository";
import { finishCurrentRowndEmailReconciliation, type MigrationEmailPlan } from "./migration-email";
import type { SuperTokensUserImport } from "./types";

afterEach(() => vi.restoreAllMocks());

function user(loginMethods: ConstructorParameters<typeof User>[0]["loginMethods"]) {
  return new User({ id: "primary", isPrimaryUser: true, emails: [], phoneNumbers: [], thirdParty: [],
    webauthn: { credentialIds: [] }, tenantIds: ["public"], timeJoined: 1, loginMethods });
}

describe("local discovery read boundaries", () => {
  const email = "shared@example.test";
  const source: SuperTokensUserImport = { userMetadata: {}, loginMethods: [
    ...["google", "apple"].map((provider) => ({ recipeId: "thirdparty" as const, thirdPartyId: provider,
      thirdPartyUserId: `${provider}-subject`, email, isVerified: true, isPrimary: false, tenantIds: ["public"], timeJoinedInMSSinceEpoch: 1 })),
    { recipeId: "passwordless", email, isVerified: true, isPrimary: false, tenantIds: ["public"], timeJoinedInMSSinceEpoch: 1 },
    { recipeId: "passwordless", phoneNumber: "+5213312345678", isVerified: true, isPrimary: false, tenantIds: ["public"], timeJoinedInMSSinceEpoch: 1 },
  ] };

  for (const discovery of [
    (context: object, tenant: string) => findExistingImportMethodUsers(source, tenant, context),
    (context: object, tenant: string) => inspectMigrationMethods(source, source.loginMethods, tenant, context),
  ]) {
    it("shares same-email searches only within one discovery, preserving provider and phone queries", async () => {
      const owner = user([{ recipeId: "passwordless", recipeUserId: "email", email, verified: true, tenantIds: ["public"], timeJoined: 1 }]);
      const search = vi.spyOn(SuperTokens, "listUsersByAccountInfo").mockResolvedValue([owner]);
      const context = {};
      const first = await discovery(context, "public");
      expect(first.length).toBeGreaterThan(0);
      expect(search.mock.calls.map(([tenant, query, union, ctx]) => ({ tenant, query, union, ctx }))).toEqual([
        { tenant: "public", query: { thirdParty: { id: "google", userId: "google-subject" } }, union: false, ctx: context },
        { tenant: "public", query: { email }, union: false, ctx: context },
        { tenant: "public", query: { thirdParty: { id: "apple", userId: "apple-subject" } }, union: false, ctx: context },
        { tenant: "public", query: { phoneNumber: "+5213312345678" }, union: false, ctx: context },
        { tenant: "public", query: { phoneNumber: "+523312345678" }, union: false, ctx: context },
      ]);
      search.mockResolvedValue([]);
      const second = await discovery(context, "public");
      expect(search).toHaveBeenCalledTimes(10);
      expect(second).not.toEqual(first);
      await discovery(context, "other");
      expect(search).toHaveBeenCalledTimes(15);
      expect(search.mock.calls.slice(10).every(([tenant]) => tenant === "other")).toBe(true);
    });

    it("propagates a shared search failure and retries in the next discovery", async () => {
      const search = vi.spyOn(SuperTokens, "listUsersByAccountInfo").mockRejectedValue(new Error("Core unavailable"));
      await expect(discovery({}, "public")).rejects.toThrow("Core unavailable");
      expect(search).toHaveBeenCalledTimes(5);
      search.mockResolvedValue([]);
      await discovery({}, "public");
      expect(search).toHaveBeenCalledTimes(10);
    });
  }
});

function cleanupFixture() {
  const plan: MigrationEmailPlan = {
    id: "migration-email-current", field: "email", value: "new@example.test", tenantId: "public",
    status: "COMMITTING", purpose: "UPDATE_PASSWORDLESS", created_at: "2026-01-01T00:00:00Z",
    targetCanonicalRecipeUserId: "current",
    migrationSource: { rowndUserId: "rownd", providerId: "google", providerUserId: "subject", providerRecipeUserId: "provider", previousEmail: "old@example.test" },
    retiredMethods: ["old-1", "old-2"].map((recipeUserId) => ({ recipeUserId, email: "old@example.test" })),
  };
  const owner = user([
    { recipeId: "thirdparty", recipeUserId: "provider", thirdParty: { id: "google", userId: "subject" }, email: plan.value, verified: true, tenantIds: ["public"], timeJoined: 1 },
    ...["current", "old-1", "old-2"].map((id) => ({ recipeId: "passwordless" as const, recipeUserId: id,
      email: id === "current" ? plan.value : "old@example.test", verified: true, tenantIds: ["public"], timeJoined: 1 })),
  ]);
  const metadata = {
    original_rownd_user: { data: { user_id: "rownd", email: plan.value, google_id: "subject" }, verified_data: { email: true, google_id: "subject" } },
    rownd_email_recipe_user_ids: { public: "current" }, rownd_pending_verification: [plan],
    rownd_migration_email_retirements: { public: { version: 1, planId: plan.id, tenantId: "public",
      targetRecipeUserId: "current", targetEmail: plan.value, source: plan.migrationSource, retiredMethods: plan.retiredMethods } },
  };
  const events: string[] = [];
  vi.spyOn(SuperTokens, "getUserIdMapping").mockResolvedValue({ status: "OK", superTokensUserId: "primary", externalUserId: "rownd" });
  vi.spyOn(UserMetadata, "getUserMetadata").mockImplementation(async (id) => ({ status: "OK", metadata: id === "primary" ? metadata : {} }));
  const publish = vi.spyOn(UserMetadata, "updateUserMetadata").mockResolvedValue({ status: "OK", metadata: {} });
  vi.spyOn(SuperTokens, "getUser").mockImplementation(async (id) => {
    if (id === "primary") events.push("validate");
    return id === "primary" || owner.loginMethods.some((method) => method.recipeUserId.getAsString() === id) ? owner : undefined;
  });
  vi.spyOn(Passwordless, "revokeAllCodes").mockImplementation(async () => { events.push("codes"); return { status: "OK" }; });
  vi.spyOn(Session, "revokeAllSessionsForUser").mockImplementation(async () => { events.push("sessions"); return []; });
  const removeMethod = vi.fn(async (id: string) => {
    events.push(`remove:${id}`);
    owner.loginMethods = owner.loginMethods.filter((method) => method.recipeUserId.getAsString() !== id);
  });
  return { input: { internalUserId: "primary", plan, tenantId: "public", userContext: {}, removeMethod }, metadata, events, publish };
}

describe("email cleanup validation boundaries", () => {
  it("validates once before each removal and again after cleanup", async () => {
    const { input, events, publish } = cleanupFixture();
    await finishCurrentRowndEmailReconciliation(input);
    expect(events).toEqual(["validate", "codes", "remove:old-1", "validate", "codes", "remove:old-2", "sessions", "validate"]);
    expect(publish).toHaveBeenCalledOnce();
  });

  it.each(["old-1", "old-2"])("rejects changed authorization after removing %s", async (boundary) => {
    const { input, metadata, publish } = cleanupFixture();
    const remove = input.removeMethod.getMockImplementation()!;
    input.removeMethod.mockImplementation(async (id) => {
      await remove(id);
      if (id === boundary) metadata.rownd_email_recipe_user_ids.public = "changed";
    });
    await expect(finishCurrentRowndEmailReconciliation(input)).rejects.toThrow("cleanup plan changed");
    expect(input.removeMethod).toHaveBeenCalledTimes(boundary === "old-1" ? 1 : 2);
    expect(publish).not.toHaveBeenCalled();
  });
});

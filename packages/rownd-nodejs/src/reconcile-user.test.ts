import { afterEach, describe, expect, it, vi } from "vitest";
import { reconcileUser, validateReconcileSelector, type ReconcileUserInput } from "./reconcile-user";
import { fetchAdministrativeMigrationSource, getAuthenticatedMigrationEmail, getMigrationContactEmail, assertAuthenticatedMigrationSource } from "./migration-email";
import { setRowndClient } from "./rownd-repository";
import { mapRowndUserToSuperTokens } from "./rownd-compatibility";
import type { RowndUser } from "./types";
vi.mock("./migration-mapping", () => ({ assertMigrationSourceActive: vi.fn() }));

afterEach(() => setRowndClient(undefined));

describe("admin source authorization", () => {
  it("Rownd app fields cannot publish internal consolidation or canonical ownership markers", () => {
    const injected = { rownd_migration_owner_consolidation: { status: "COMPLETE" }, rownd_migration_canonical_target: "foreign-owner",
      original_rownd_user: { data: { user_id: "foreign-source" } }, rownd_migration_complete: false };
    const profile: RowndUser = { data: { user_id: "rownd", email: "test@example.com", preference: "blue", ...injected }, meta: injected };
    const source = mapRowndUserToSuperTokens(profile, "public");
    expect(source.userMetadata).toEqual({ original_rownd_user: profile, rownd_migration_complete: true, preference: "blue" });
  });
  it.each([{}, { email: "" }, { email: "a", rownd_user_id: "b" }, { email: "a", supertokens_user_id: undefined }, { rownd_user_id: "a", dryRun: "true" }, null])("rejects invalid selector %j", (value) => {
    expect(() => validateReconcileSelector(value)).toThrow("exactly one");
  });
  it("accepts each selector with common options", () => {
    for (const value of [{ email: "a" }, { rownd_user_id: "b" }, { supertokens_user_id: "c" }]) {
      for (const dryRun of [undefined, false, true]) expect(() => validateReconcileSelector({ ...value, tenantId: "tenant", userContext: {}, dryRun })).not.toThrow();
    }
  });
  it("returns structured invalid input errors", async () => {
    // @ts-expect-error Multiple selectors are also rejected at compile time.
    const input: ReconcileUserInput = { email: "a", rownd_user_id: "b" };
    expect(await reconcileUser(input)).toMatchObject({ status: "ERROR", changed: false });
  });
  it("only grants verified server-fetched contact proof and revalidates it", async () => {
    const profile: RowndUser = { state: "enabled", auth_level: "verified", data: { user_id: "rownd", email: "test@example.com" }, verified_data: { email: true } };
    const fetchUserInfo = vi.fn().mockResolvedValue(profile);
    const validateToken = vi.fn();
    setRowndClient({ fetchUserInfo, validateToken });
    const arbitrary = mapRowndUserToSuperTokens(profile, "public");
    expect(getAuthenticatedMigrationEmail(arbitrary, "public")).toBeUndefined();
    expect(getMigrationContactEmail(arbitrary, "public")).toBeUndefined();
    const source = (await fetchAdministrativeMigrationSource("rownd", "public", {}))!;
    expect(getAuthenticatedMigrationEmail(source, "public")).toBe("test@example.com");
    expect(validateToken).not.toHaveBeenCalled();
    expect(() => getAuthenticatedMigrationEmail(source, "other")).toThrow("binding changed");
    fetchUserInfo.mockResolvedValue({ ...profile, verified_data: {} });
    await expect(assertAuthenticatedMigrationSource(source, "public")).rejects.toThrow("proof changed");
    const unverified = (await fetchAdministrativeMigrationSource("rownd", "public", {}))!;
    expect(getAuthenticatedMigrationEmail(unverified, "public")).toBeUndefined();
    expect(getMigrationContactEmail(unverified, "public")).toBe("test@example.com");
    expect(unverified.loginMethods).toMatchObject([{ email: "test@example.com", isVerified: false }]);
  });

  it.each([
    ["email", 123], ["email", "bad"], ["phone_number", {}], ["phone_number", "555"],
    ["google_id", []], ["apple_id", false], ["google_id", "   "],
  ])("rejects malformed data.%s even alongside valid identities (%j)", async (field, value) => {
    setRowndClient({ validateToken: vi.fn(), fetchUserInfo: vi.fn().mockResolvedValue({
      data: { user_id: "rownd", email: "valid@example.com", [field]: value }, verified_data: {},
    }) });
    await expect(fetchAdministrativeMigrationSource("rownd", "public", {})).rejects.toThrow(`SOURCE_PAYLOAD_INVALID: data.${field}`);
  });

  it.each([{}, { meta: null, attributes: null, verified_data: null }, { verified_data: { google_id: true } }])("preserves optional containers and anonymous compatibility: %j", async (optional) => {
    setRowndClient({ validateToken: vi.fn(), fetchUserInfo: vi.fn().mockResolvedValue({ data: { user_id: "rownd" }, ...optional }) });
    const source = (await fetchAdministrativeMigrationSource("rownd", "public", {}))!;
    expect(source.loginMethods).toMatchObject([{ recipeId: "thirdparty", thirdPartyId: "instant", thirdPartyUserId: "rownd" }]);
  });

  it("uses verified provider subjects ahead of data and accepts case-insensitive current email evidence", async () => {
    setRowndClient({ validateToken: vi.fn(), fetchUserInfo: vi.fn().mockResolvedValue({
      data: { user_id: "rownd", email: "Current@example.com", google_id: "old", apple_id: "fallback" },
      verified_data: { email: "CURRENT@EXAMPLE.COM", google_id: "current", apple_id: true },
    }) });
    const source = (await fetchAdministrativeMigrationSource("rownd", "public", {}))!;
    expect(source.loginMethods).toEqual(expect.arrayContaining([
      expect.objectContaining({ thirdPartyId: "google", thirdPartyUserId: "current" }),
      expect.objectContaining({ thirdPartyId: "apple", thirdPartyUserId: "fallback" }),
    ]));
    expect(getAuthenticatedMigrationEmail(source, "public")).toBe("current@example.com");
  });
});

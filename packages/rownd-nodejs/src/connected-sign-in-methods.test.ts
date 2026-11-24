import { beforeEach, describe, expect, it, vi } from "vitest";
import SuperTokens from "supertokens-node";
import Session from "supertokens-node/recipe/session";
import Multitenancy from "supertokens-node/recipe/multitenancy";
import { listConnectedSignInMethods, disconnectConnectedSignInMethod } from "./connected-sign-in-methods";
import { getPrimaryUserMetadata } from "./rownd-compatibility";
import { completeDisconnectedSignInMethod, getDisconnectedSignInMethods, recordDisconnectedSignInMethod } from "./disconnected-sign-in-identities";
import { assertRetainedPasswordlessAuthentication, assertRetainedPasswordlessAuthenticationFresh } from "./session-authentication";
import { RowndSignInMethodError } from "./errors";

vi.mock("supertokens-node", () => ({ default: { getUser: vi.fn(), getUserIdMapping: vi.fn(),
  deleteUser: vi.fn(), isRecipeInitialized: () => true, convertToRecipeUserId: (id: string) => ({ getAsString: () => id }) } }));
vi.mock("supertokens-node/recipe/session", () => ({ default: { revokeAllSessionsForUser: vi.fn(), getAllSessionHandlesForUser: vi.fn() } }));
vi.mock("supertokens-node/recipe/multitenancy", () => ({ default: { disassociateUserFromTenant: vi.fn(), getTenant: vi.fn() } }));
vi.mock("supertokens-node/lib/build/recipe/passwordless/recipe", () => ({ default: {
  getInstanceOrThrowError: () => ({ config: { contactMethod: "EMAIL", flowType: "MAGIC_LINK" } }),
} }));
vi.mock("./config", () => ({ isEmailSignInEnabled: () => true }));
vi.mock("./rownd-compatibility", () => ({ getPrimaryUserMetadata: vi.fn() }));
vi.mock("./disconnected-sign-in-identities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./disconnected-sign-in-identities")>(),
  completeDisconnectedSignInMethod: vi.fn(), getDisconnectedSignInMethods: vi.fn(), recordDisconnectedSignInMethod: vi.fn(),
}));
vi.mock("./session-authentication", () => ({ assertRetainedPasswordlessAuthentication: vi.fn(),
  assertRetainedPasswordlessAuthenticationFresh: vi.fn(),
  SIGN_IN_METHOD_AUTHENTICATION_MAX_AGE_MS: 600_000,
  immutableRecipeUserId: async (id: string) => id === "rownd" ? "owner" : id }));

const recipe = (id: string) => ({ getAsString: () => id });
let user: any;
let metadata: any;
let records: any[];
let input: any;

beforeEach(() => {
  vi.resetAllMocks();
  user = { id: "rownd", isPrimaryUser: true, tenantIds: ["public"], loginMethods: [
    { recipeId: "thirdparty", recipeUserId: recipe("rownd"), verified: false, tenantIds: ["public"],
      email: "old@example.com", thirdParty: { id: "google", userId: "subject" } },
    { recipeId: "passwordless", recipeUserId: recipe("email"), verified: true, tenantIds: ["public"], email: "new@example.com" },
  ] };
  metadata = { rownd_email_recipe_user_ids: { public: "email" } };
  records = [];
  input = { session: { getUserId: () => "rownd", getTenantId: () => "public", getRecipeUserId: () => recipe("email"),
    revokeSession: vi.fn() }, config: { connectedSignInMethods: { enabled: true } }, userContext: {} };
  vi.mocked(SuperTokens.getUser).mockImplementation(async () => user);
  vi.mocked(SuperTokens.getUserIdMapping).mockResolvedValue({ status: "OK", superTokensUserId: "owner", externalUserId: "rownd" } as any);
  vi.mocked(getPrimaryUserMetadata).mockImplementation(async () => metadata);
  vi.mocked(Multitenancy.getTenant).mockResolvedValue({ status: "OK", firstFactors: ["link-email"] } as any);
  vi.mocked(getDisconnectedSignInMethods).mockImplementation(async () => records);
  vi.mocked(assertRetainedPasswordlessAuthentication).mockResolvedValue(Object.freeze({ userId: "owner", tenantId: "public", recipeUserId: "email",
    email: "new@example.com", sessionHandle: "handle", authenticatedAt: Date.now(), sessionExpiresAt: Date.now() + 3600_000 }));
  vi.mocked(recordDisconnectedSignInMethod).mockImplementation(async (record, _context, beforeCommit) => {
    await beforeCommit?.();
    const existing = records.find((entry) => entry.tenantId === record.tenantId && entry.providerId === record.providerId && entry.providerUserId === record.providerUserId);
    if (!existing) records.push({ ...record, version: 1 });
  });
  vi.mocked(completeDisconnectedSignInMethod).mockImplementation(async (record) => {
    const existing = records.find((entry) => entry.tenantId === record.tenantId && entry.providerId === record.providerId && entry.providerUserId === record.providerUserId);
    if (!existing) throw new Error("Missing disconnect checkpoint");
    existing.completed = true;
  });
  vi.mocked(Multitenancy.disassociateUserFromTenant).mockImplementation(async () => {
    user.loginMethods[0].tenantIds = [];
    return { status: "OK", wasAssociated: true };
  });
  vi.mocked(SuperTokens.deleteUser).mockImplementation(async () => {
    user.loginMethods = user.loginMethods.filter((method: any) => method.recipeId !== "thirdparty");
    return { status: "OK" };
  });
  vi.mocked(Session.getAllSessionHandlesForUser).mockResolvedValue([]);
});

async function body() {
  const listed = await listConnectedSignInMethods(input);
  return { method_id: listed.methods.find((method) => method.kind === "sso")!.id,
    expected_user_id: "rownd", expected_tenant_id: "public" };
}

describe("connected sign-in method management", () => {
  it("lists real tenant methods, keeping passwordless read-only and excluding guests and synthetic emails", async () => {
    user.loginMethods.push({ recipeId: "thirdparty", recipeUserId: recipe("guest"), tenantIds: ["public"], thirdParty: { id: "instant", userId: "anon" } });
    const listed = await listConnectedSignInMethods(input);
    expect(listed).toMatchObject({ status: "OK", user_id: "rownd", tenant_id: "public",
      reauthentication: { method: "email", identifier: "new@example.com" } });
    expect(listed.methods).toHaveLength(2);
    expect(listed.methods[0]).toMatchObject({ kind: "sso", provider: "google", can_disconnect: true });
    expect(listed.methods[1]).toMatchObject({ kind: "email", can_disconnect: false, disconnect_block_reason: "SIGN_IN_METHOD_READ_ONLY" });
    const sso = listed.methods.find((method) => method.kind === "sso");
    if (!sso) throw new Error("Expected the seeded SSO method");
    expect(sso.id).not.toBe("rownd");
  });

  it("requires explicit opt-in for both operations", async () => {
    input.config = {};
    await expect(listConnectedSignInMethods(input)).rejects.toMatchObject({ httpStatus: 404 });
    await expect(disconnectConnectedSignInMethod({ ...input, body: {} })).rejects.toMatchObject({ httpStatus: 404 });
    expect(SuperTokens.getUser).not.toHaveBeenCalled();
  });

  it.each(["owner", "tenant", "missing", "foreign"])("rejects %s precondition without writes", async (failure) => {
    const request = await body();
    if (failure === "owner") request.expected_user_id = "other";
    if (failure === "tenant") request.expected_tenant_id = "other";
    if (failure === "missing") delete (request as any).expected_user_id;
    if (failure === "foreign") request.method_id = "foreign";
    await expect(disconnectConnectedSignInMethod({ ...input, body: request })).rejects.toMatchObject({ httpStatus: 409 });
    expect(recordDisconnectedSignInMethod).not.toHaveBeenCalled();
    expect(SuperTokens.deleteUser).not.toHaveBeenCalled();
  });

  it.each(["unverified", "pending", "multiple tenants", "ambiguous", "read only"])("blocks %s target", async (failure) => {
    const request = await body();
    if (failure === "unverified") user.loginMethods[1].verified = false;
    if (failure === "pending") metadata.rownd_pending_verification = [{ field: "email", tenantId: "public" }];
    if (failure === "multiple tenants") user.loginMethods[0].tenantIds.push("other");
    if (failure === "ambiguous") {
      metadata = {};
      user.loginMethods.push({ ...user.loginMethods[1], recipeUserId: recipe("extra"), email: "extra@example.com" });
    }
    if (failure === "read only") request.method_id = (await listConnectedSignInMethods(input)).methods.find((method) => method.kind === "email")!.id;
    await expect(disconnectConnectedSignInMethod({ ...input, body: request })).rejects.toMatchObject({ httpStatus: 409 });
    expect(recordDisconnectedSignInMethod).not.toHaveBeenCalled();
  });

  it("requires retained-factor proof before checkpointing", async () => {
    const request = await body();
    vi.mocked(assertRetainedPasswordlessAuthentication).mockRejectedValueOnce(new RowndSignInMethodError(
      "SIGN_IN_METHOD_REAUTHENTICATION_REQUIRED", 403, "Sign in again", { method: "email", identifier: "new@example.com" }));
    await expect(disconnectConnectedSignInMethod({ ...input, body: request })).rejects.toMatchObject({ httpStatus: 403,
      errorCode: "SIGN_IN_METHOD_REAUTHENTICATION_REQUIRED" });
    expect(recordDisconnectedSignInMethod).not.toHaveBeenCalled();
  });

  it("shows when fresh retained-email authentication expires and pre-signals missing proof", async () => {
    const proof = await assertRetainedPasswordlessAuthentication({} as any);
    const now = vi.spyOn(Date, "now").mockReturnValue(proof.authenticatedAt + 10_000);
    try {
      expect(await listConnectedSignInMethods(input)).toMatchObject({
        reauthentication_valid_until: proof.authenticatedAt + 600_000,
        reauthentication_valid_for_ms: 590_000,
      });
      now.mockReturnValue(proof.authenticatedAt + 600_000);
      const expired = await listConnectedSignInMethods(input);
      expect(expired).not.toHaveProperty("reauthentication_valid_until");
      expect(expired).not.toHaveProperty("reauthentication_valid_for_ms");
      expect(expired.methods.find(({ kind }) => kind === "sso"))
        .toMatchObject({ can_disconnect: false, disconnect_block_reason: "SIGN_IN_METHOD_REAUTHENTICATION_REQUIRED" });
    } finally {
      now.mockRestore();
    }
    vi.mocked(assertRetainedPasswordlessAuthentication).mockRejectedValueOnce(new RowndSignInMethodError(
      "SIGN_IN_METHOD_REAUTHENTICATION_REQUIRED", 403, "Sign in again"));
    const stale = await listConnectedSignInMethods(input);
    expect(stale).not.toHaveProperty("reauthentication_valid_until");
    expect(stale.methods.find(({ kind }) => kind === "sso")).toMatchObject({
      can_disconnect: false, disconnect_block_reason: "SIGN_IN_METHOD_REAUTHENTICATION_REQUIRED",
    });
  });

  it("lists both identifiers from the same passwordless recipe with distinct stable IDs", async () => {
    user.loginMethods[1].phoneNumber = "+15550100100";
    const first = await listConnectedSignInMethods(input);
    const second = await listConnectedSignInMethods(input);
    const email = first.methods.find(({ kind }) => kind === "email");
    const phone = first.methods.find(({ kind }) => kind === "phone");
    expect(email).toMatchObject({ identifier: "new@example.com", can_disconnect: false });
    expect(phone).toMatchObject({ identifier: "+15550100100", can_disconnect: false });
    expect(email?.id).not.toBe(phone?.id);
    expect(second.methods).toEqual(first.methods);
  });

  it("refuses a retained factor disabled by the tenant's first-factor policy", async () => {
    const request = await body();
    vi.mocked(Multitenancy.getTenant).mockResolvedValue({ status: "OK", firstFactors: ["otp-email"] } as any);
    await expect(disconnectConnectedSignInMethod({ ...input, body: request })).rejects.toMatchObject({ errorCode: "SIGN_IN_METHOD_RETAINED_EMAIL_REQUIRED" });
    expect(recordDisconnectedSignInMethod).not.toHaveBeenCalled();
  });

  it("checkpoints first, removes only the SSO recipe, then revokes every account session", async () => {
    expect(await disconnectConnectedSignInMethod({ ...input, body: await body() })).toEqual({ status: "OK", signed_out: true });
    expect(recordDisconnectedSignInMethod).toHaveBeenCalledWith({ userId: "owner", tenantId: "public", recipeUserId: "owner",
      providerId: "google", providerUserId: "subject" }, {}, expect.any(Function));
    expect(vi.mocked(recordDisconnectedSignInMethod).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(Session.revokeAllSessionsForUser).mock.invocationCallOrder[0]!);
    expect(vi.mocked(Session.revokeAllSessionsForUser).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(SuperTokens.deleteUser).mock.invocationCallOrder[0]!);
    expect(Multitenancy.disassociateUserFromTenant).not.toHaveBeenCalled();
    expect(SuperTokens.deleteUser).toHaveBeenCalledWith("owner", false, {});
    expect(Session.revokeAllSessionsForUser).toHaveBeenCalledWith("owner", true, undefined, {});
    expect(input.session.revokeSession).toHaveBeenCalled();
    expect(user.id).toBe("rownd");
    expect(user.loginMethods).toHaveLength(1);
    expect(records[0].completed).toBe(true);
    expect(vi.mocked(Session.getAllSessionHandlesForUser).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(completeDisconnectedSignInMethod).mock.invocationCallOrder[0]!);
  });

  it("retains intent after failed deletion and resumes after fresh email authentication", async () => {
    user.loginMethods[0].recipeUserId = recipe("secondary");
    const request = await body();
    vi.mocked(SuperTokens.deleteUser).mockRejectedValueOnce(new Error("interrupted"));
    await expect(disconnectConnectedSignInMethod({ ...input, body: request })).rejects.toThrow("interrupted");
    expect(records).toHaveLength(1);
    expect(user.loginMethods[0].tenantIds).toEqual([]);
    expect((await listConnectedSignInMethods(input)).methods.find((method) => method.kind === "sso"))
      .toMatchObject({ id: request.method_id, can_disconnect: true });
    await expect(disconnectConnectedSignInMethod({ ...input, body: request })).resolves.toEqual({ status: "OK", signed_out: true });
  });

  it.each(["revoked", "expired"])("refuses a session %s during graph reads before checkpoint commitment", async () => {
    const request = await body();
    vi.mocked(assertRetainedPasswordlessAuthentication).mockClear();
    const proof = Object.freeze({ userId: "owner", tenantId: "public", recipeUserId: "email", email: "new@example.com", sessionHandle: "handle",
      authenticatedAt: Date.now(), sessionExpiresAt: Date.now() + 3600_000 });
    vi.mocked(assertRetainedPasswordlessAuthentication).mockResolvedValueOnce(proof).mockRejectedValueOnce(
      new RowndSignInMethodError("SIGN_IN_METHOD_REAUTHENTICATION_REQUIRED", 403, "The initiating session is no longer valid."));
    await expect(disconnectConnectedSignInMethod({ ...input, body: request })).rejects.toMatchObject({ errorCode: "SIGN_IN_METHOD_REAUTHENTICATION_REQUIRED" });
    expect(recordDisconnectedSignInMethod).toHaveBeenCalled();
    expect(assertRetainedPasswordlessAuthentication).toHaveBeenCalledTimes(2);
    expect(records).toEqual([]);
    expect(Session.revokeAllSessionsForUser).not.toHaveBeenCalled();
    expect(Multitenancy.disassociateUserFromTenant).not.toHaveBeenCalled();
    expect(SuperTokens.deleteUser).not.toHaveBeenCalled();
  });

  it("rechecks validated proof freshness before deleting credentials after its own revocation", async () => {
    let revoked = false;
    vi.mocked(Session.revokeAllSessionsForUser).mockImplementation(async () => { revoked = true; return []; });
    vi.mocked(assertRetainedPasswordlessAuthenticationFresh).mockImplementation(() => {
      if (revoked) throw new RowndSignInMethodError("SIGN_IN_METHOD_REAUTHENTICATION_REQUIRED", 403, "Authentication became too old during cleanup.");
    });
    await expect(disconnectConnectedSignInMethod({ ...input, body: await body() })).rejects.toMatchObject({ errorCode: "SIGN_IN_METHOD_REAUTHENTICATION_REQUIRED" });
    expect(records).toHaveLength(1);
    expect(SuperTokens.deleteUser).not.toHaveBeenCalled();
    expect(completeDisconnectedSignInMethod).not.toHaveBeenCalled();
  });

  it("disassociates a secondary SSO recipe only after the suppression checkpoint", async () => {
    user.loginMethods[0].recipeUserId = recipe("secondary");
    await expect(disconnectConnectedSignInMethod({ ...input, body: await body() })).resolves.toMatchObject({ signed_out: true });
    expect(vi.mocked(recordDisconnectedSignInMethod).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(Multitenancy.disassociateUserFromTenant).mock.invocationCallOrder[0]!);
    expect(SuperTokens.deleteUser).toHaveBeenCalledWith("secondary", false, {});
  });

  it("resumes revocation when recipe deletion already committed", async () => {
    const request = await body();
    records.push({ version: 1, userId: "owner", tenantId: "public", recipeUserId: "owner", providerId: "google", providerUserId: "subject" });
    user.loginMethods.shift();
    await expect(disconnectConnectedSignInMethod({ ...input, body: request })).resolves.toMatchObject({ signed_out: true });
    expect(SuperTokens.deleteUser).not.toHaveBeenCalled();
    expect(Session.revokeAllSessionsForUser).toHaveBeenCalled();
  });

  it.each(["final revocation", "completion checkpoint"])("exposes deleted-recipe recovery after failed %s, then hides only the completed row", async (failure) => {
    const request = await body();
    if (failure === "final revocation") {
      let failOnce = true;
      vi.mocked(Session.revokeAllSessionsForUser).mockImplementation(async () => {
        if (failOnce && !user.loginMethods.some((method: any) => method.recipeId === "thirdparty")) {
          failOnce = false;
          throw new Error("interrupted");
        }
        return [];
      });
    } else {
      vi.mocked(completeDisconnectedSignInMethod).mockRejectedValueOnce(new Error("interrupted"));
    }
    await expect(disconnectConnectedSignInMethod({ ...input, body: request })).rejects.toThrow("interrupted");
    expect(user.loginMethods).toHaveLength(1);
    expect(records[0].completed).not.toBe(true);
    const reopened = await listConnectedSignInMethods(input);
    expect(reopened.methods.find((method) => method.id === request.method_id)).toMatchObject({ kind: "sso", provider: "google", can_disconnect: true });
    await expect(disconnectConnectedSignInMethod({ ...input, body: request })).resolves.toEqual({ status: "OK", signed_out: true });
    expect(records).toHaveLength(1);
    expect(records[0].completed).toBe(true);
    expect((await listConnectedSignInMethods(input)).methods.some((method) => method.id === request.method_id)).toBe(false);
    const revocations = vi.mocked(Session.revokeAllSessionsForUser).mock.calls.length;
    await expect(disconnectConnectedSignInMethod({ ...input, body: request })).rejects.toMatchObject({ errorCode: "SIGN_IN_METHOD_ALREADY_DISCONNECTED" });
    expect(Session.revokeAllSessionsForUser).toHaveBeenCalledTimes(revocations);
  });

  it("does not expose pending recovery from another tenant or without an enabled retained factor", async () => {
    const request = await body();
    user.loginMethods.shift();
    records.push({ version: 1, userId: "owner", tenantId: "public", recipeUserId: "owner", providerId: "google", providerUserId: "subject" });
    records.push({ version: 1, userId: "owner", tenantId: "other", recipeUserId: "other", providerId: "apple", providerUserId: "other" });
    user.loginMethods[0].verified = false;
    const listed = await listConnectedSignInMethods(input);
    expect(listed.methods.filter((method) => method.kind === "sso")).toEqual([{
      id: request.method_id, kind: "sso", provider: "google", verified: true, pending_disconnect: true, can_disconnect: false,
      disconnect_block_reason: "SIGN_IN_METHOD_RETAINED_EMAIL_REQUIRED",
    }]);
  });

  it("does not reopen monotonic completion when Core shows a live suppressed recipe", async () => {
    const request = await body();
    records.push({ version: 1, userId: "owner", tenantId: "public", recipeUserId: "owner", providerId: "google", providerUserId: "subject", completed: true });
    expect((await listConnectedSignInMethods(input)).methods.find((method) => method.id === request.method_id)).toMatchObject({
      can_disconnect: false, disconnect_block_reason: "SIGN_IN_METHOD_ALREADY_DISCONNECTED",
    });
    await expect(disconnectConnectedSignInMethod({ ...input, body: request })).rejects.toMatchObject({ errorCode: "SIGN_IN_METHOD_ALREADY_DISCONNECTED" });
    expect(records[0].completed).toBe(true);
    expect(recordDisconnectedSignInMethod).not.toHaveBeenCalled();
    expect(SuperTokens.deleteUser).not.toHaveBeenCalled();
    expect(Session.revokeAllSessionsForUser).not.toHaveBeenCalled();
  });

  it("fails closed if the retained canonical method changes after the checkpoint", async () => {
    vi.mocked(recordDisconnectedSignInMethod).mockImplementationOnce(async () => { user.loginMethods[1].email = "changed@example.com"; });
    await expect(disconnectConnectedSignInMethod({ ...input, body: await body() })).rejects.toMatchObject({ httpStatus: 409 });
    expect(Multitenancy.disassociateUserFromTenant).not.toHaveBeenCalled();
  });

  it("does not report success when account sessions remain", async () => {
    vi.mocked(Session.getAllSessionHandlesForUser).mockResolvedValueOnce(["racing-session"]);
    await expect(disconnectConnectedSignInMethod({ ...input, body: await body() })).rejects.toMatchObject({ httpStatus: 409 });
    expect(records).toHaveLength(1);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SuperTokens from "supertokens-node";
import Session from "supertokens-node/recipe/session";
import { init } from "./plugin";
import { buildRowndSessionAndAnonymousClaims } from "./supertokens-repository";
import { buildRowndSessionClaimPayload } from "./rownd-compatibility";
import {
  assertSignInMethodAuthenticationAllowed,
  assertSignInMethodLinkAllowed,
  assertSignInMethodTenantAssociationAllowed,
  getDisconnectedSignInMethods,
  DisconnectedSignInMethodError,
} from "./disconnected-sign-in-identities";

vi.mock("./disconnected-sign-in-identities", () => ({
  assertNoDisconnectedSignInMethods: vi.fn(),
  assertSignInMethodAuthenticationAllowed: vi.fn(),
  assertSignInMethodLinkAllowed: vi.fn(),
  assertSignInMethodTenantAssociationAllowed: vi.fn(),
  getDisconnectedSignInMethods: vi.fn(),
  recordDisconnectedSignInMethod: vi.fn(),
  completeDisconnectedSignInMethod: vi.fn(),
  DisconnectedSignInMethodError: class extends Error {
    constructor(readonly code: string) { super(code); }
  },
}));
vi.mock("./supertokens-repository", async (importOriginal) => {
  const original = await importOriginal<typeof import("./supertokens-repository")>();
  return { ...original, recordRowndAppVariantForUser: vi.fn(), buildRowndSessionAndAnonymousClaims: vi.fn() };
});

const recipe = { getAsString: () => "recipe" };
let overrides: any;
let session: any;
beforeEach(() => {
  vi.resetAllMocks();
  overrides = (init({ disableRowndUserMigration: true, connectedSignInMethods: { enabled: false } }) as any).overrideMap;
  session = { getUserId: () => "owner", getRecipeUserId: () => recipe, getTenantId: () => "public", getHandle: () => "handle",
    getAccessTokenPayload: () => ({}), mergeIntoAccessTokenPayload: vi.fn(), revokeSession: vi.fn() };
  vi.mocked(getDisconnectedSignInMethods).mockResolvedValue([]);
  vi.mocked(assertSignInMethodAuthenticationAllowed).mockResolvedValue({ policy: [] });
  vi.mocked(buildRowndSessionAndAnonymousClaims).mockResolvedValue({ rowndSessionClaims: buildRowndSessionClaimPayload({
    userId: "owner", user: undefined, currentPayload: { auth_level: "verified" }, authenticationOrigin: "authenticated",
  }), rowndIsAnonymousClaim: {} });
});
afterEach(() => { vi.restoreAllMocks(); });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("durable policy recipe seams", () => {
  it("rejects suppressed session creation before issuance even when management is disabled", async () => {
    vi.mocked(assertSignInMethodAuthenticationAllowed).mockRejectedValueOnce(new DisconnectedSignInMethodError("SIGN_IN_METHOD_DISCONNECTED"));
    const original = { createNewSession: vi.fn() };
    await expect(overrides.session.functions(original).createNewSession({ userId: "owner", recipeUserId: recipe, tenantId: "public", userContext: {} }))
      .rejects.toBeInstanceOf(DisconnectedSignInMethodError);
    expect(original.createNewSession).not.toHaveBeenCalled();
  });

  it.each([false, true])("rejects and revokes a suppressed JWT with checkDatabase=%s", async (checkDatabase) => {
    vi.mocked(getDisconnectedSignInMethods).mockResolvedValueOnce([{ version: 1, userId: "owner", recipeUserId: "deleted",
      providerId: "google", providerUserId: "subject", tenantId: "public" }]);
    vi.mocked(assertSignInMethodAuthenticationAllowed).mockRejectedValueOnce(new DisconnectedSignInMethodError("SIGN_IN_METHOD_DISCONNECTED"));
    const original = { getSession: vi.fn(async () => session) };
    await expect(overrides.session.functions(original).getSession({ options: { checkDatabase }, userContext: {} })).rejects.toMatchObject({ type: "UNAUTHORISED" });
    expect(session.revokeSession).toHaveBeenCalled();
  });

  it("database-checks an otherwise valid JWT on an account with disconnect policy", async () => {
    vi.mocked(getDisconnectedSignInMethods).mockResolvedValueOnce([{ version: 1, userId: "owner", recipeUserId: "deleted",
      providerId: "google", providerUserId: "subject", tenantId: "public" }]);
    const original = { getSession: vi.fn(async () => session), getSessionInformation: vi.fn(async () => undefined) };
    await expect(overrides.session.functions(original).getSession({ userContext: {} })).rejects.toMatchObject({ type: "UNAUTHORISED" });
    expect(original.getSessionInformation).toHaveBeenCalledWith({ sessionHandle: "handle", userContext: {} });
  });

  it("does not add a session-database read for users without policy", async () => {
    const original = { getSession: vi.fn(async () => session), getSessionInformation: vi.fn() };
    expect(await overrides.session.functions(original).getSession({ userContext: {} })).toBe(session);
    expect(original.getSessionInformation).not.toHaveBeenCalled();
  });

  it("rechecks refreshed credentials and revokes a suppressed result", async () => {
    vi.mocked(getDisconnectedSignInMethods).mockResolvedValueOnce([{ version: 1, userId: "owner", recipeUserId: "deleted",
      providerId: "google", providerUserId: "subject", tenantId: "public" }]);
    vi.mocked(assertSignInMethodAuthenticationAllowed).mockRejectedValueOnce(new DisconnectedSignInMethodError("SIGN_IN_METHOD_DISCONNECTED"));
    const original = { refreshSession: vi.fn(async () => session) };
    await expect(overrides.session.functions(original).refreshSession({ userContext: {} })).rejects.toMatchObject({ type: "UNAUTHORISED" });
    expect(session.revokeSession).toHaveBeenCalled();
  });

  it("blocks explicit linking and tenant reassociation before Core writes", async () => {
    vi.mocked(assertSignInMethodLinkAllowed).mockRejectedValueOnce(new DisconnectedSignInMethodError("SIGN_IN_METHOD_DISCONNECTED"));
    vi.mocked(assertSignInMethodTenantAssociationAllowed).mockRejectedValueOnce(new DisconnectedSignInMethodError("SIGN_IN_METHOD_DISCONNECTED"));
    const linking = { linkAccounts: vi.fn() };
    const tenant = { associateUserToTenant: vi.fn() };
    await expect(overrides.accountlinking.functions(linking).linkAccounts({ primaryUserId: "owner", recipeUserId: recipe, userContext: {} })).rejects.toBeDefined();
    await expect(overrides.multitenancy.functions(tenant).associateUserToTenant({ recipeUserId: recipe, tenantId: "public", userContext: {} })).rejects.toBeDefined();
    expect(linking.linkAccounts).not.toHaveBeenCalled();
    expect(tenant.associateUserToTenant).not.toHaveBeenCalled();
  });

  it("denies automatic linking before the application's permissive fallback", async () => {
    vi.mocked(getDisconnectedSignInMethods).mockResolvedValueOnce([{ version: 1, userId: "owner", recipeUserId: "deleted",
      providerId: "google", providerUserId: "subject", tenantId: "public" }]);
    const fallback = vi.fn(async () => ({ shouldAutomaticallyLink: true }));
    const config = overrides.accountlinking.config({ shouldDoAutomaticAccountLinking: fallback });
    expect(await config.shouldDoAutomaticAccountLinking({ recipeId: "thirdparty", thirdParty: { id: "google", userId: "subject" } },
      { id: "owner" }, undefined, "public", {})).toMatchObject({ shouldAutomaticallyLink: false });
    expect(fallback).not.toHaveBeenCalled();
  });

  it("rejects native SSO authentication even when the SDK would reuse a retained-email session", async () => {
    vi.mocked(getDisconnectedSignInMethods).mockResolvedValueOnce([{ version: 1, userId: "owner", recipeUserId: "deleted",
      providerId: "google", providerUserId: "subject", tenantId: "public" }]);
    const original = { signInUp: vi.fn() };
    expect(await overrides.thirdparty.functions(original).signInUp({ thirdPartyId: "google", thirdPartyUserId: "subject", session,
      tenantId: "public", userContext: {} })).toMatchObject({ status: "SIGN_IN_UP_NOT_ALLOWED" });
    expect(original.signInUp).not.toHaveBeenCalled();
  });

  it("publishes an allowed SSO response using one final policy snapshot without a following lookup", async () => {
    vi.spyOn(SuperTokens, "listUsersByAccountInfo").mockResolvedValue([]);
    const response = { setHeader: vi.fn(), removeHeader: vi.fn(), setCookie: vi.fn(), setStatusCode: vi.fn(),
      sendJSONResponse: vi.fn(), sendHTMLResponse: vi.fn() };
    const responseSpies = { ...response };
    const recipeFunctions = overrides.thirdparty.functions({ signInUp: async () => ({ status: "OK", user: { id: "owner" },
      recipeUserId: { getAsString: () => "actual-sso" } }) });
    const api = overrides.thirdparty.apis({ signInUpPOST: async (input: any) => {
      await recipeFunctions.signInUp({ thirdPartyId: "google", thirdPartyUserId: "subject", tenantId: "public",
        session: input.session, userContext: input.userContext });
      input.options.res.setHeader("st-access-token", "allowed-token", false);
      expect(responseSpies.setHeader).not.toHaveBeenCalled();
      return { status: "OK", user: { id: "owner" }, session };
    } });
    expect(await api.signInUpPOST({ provider: { id: "google" }, tenantId: "public", session,
      options: { req: { getKeyValueFromQuery: () => undefined }, res: response }, userContext: {} })).toMatchObject({ status: "OK" });
    expect(responseSpies.setHeader).toHaveBeenCalledWith("st-access-token", "allowed-token", false);
    expect(assertSignInMethodAuthenticationAllowed).toHaveBeenCalledTimes(2);
    expect(getDisconnectedSignInMethods).toHaveBeenCalledTimes(1);
  });

  it.each([
    { reused: true, revokeFails: true }, { reused: true, revokeFails: false },
    { reused: false, revokeFails: true }, { reused: false, revokeFails: false },
  ])("checks the actual SSO factor at API completion and buffers credentials (reuse=$reused, revokeFails=$revokeFails)", async ({ reused, revokeFails }) => {
    let suppressed = false;
    const recipeChecked = deferred();
    const finishPostAuth = deferred();
    const revokeEntered = deferred();
    const finishRevocation = deferred();
    vi.spyOn(SuperTokens, "listUsersByAccountInfo").mockResolvedValue([]);
    vi.mocked(assertSignInMethodAuthenticationAllowed).mockImplementation(async () => {
      if (suppressed) throw new DisconnectedSignInMethodError("SIGN_IN_METHOD_DISCONNECTED");
      return { policy: [] };
    });
    const revoke = vi.spyOn(Session, "revokeSession").mockImplementation(async () => {
      revokeEntered.resolve();
      if (revokeFails) throw new Error("Injected revocation failure");
      await finishRevocation.promise;
      return true;
    });
    const actualRecipe = { getAsString: () => "actual-sso" };
    session.getRecipeUserId = () => ({ getAsString: () => "canonical-email" });
    const response = { setHeader: vi.fn(), removeHeader: vi.fn(), setCookie: vi.fn(), setStatusCode: vi.fn(),
      sendJSONResponse: vi.fn(), sendHTMLResponse: vi.fn() };
    const responseSpies = { ...response };
    session.mergeIntoAccessTokenPayload = vi.fn(async () => response.setHeader("st-access-token", "buffered-claims", false));
    const recipeFunctions = overrides.thirdparty.functions({ signInUp: async () => ({ status: "OK", user: { id: "owner" }, recipeUserId: actualRecipe }) });
    const api = overrides.thirdparty.apis({ signInUpPOST: async (input: any) => {
      expect(await recipeFunctions.signInUp({ thirdPartyId: "google", thirdPartyUserId: "subject", tenantId: "public",
        session: input.session, userContext: input.userContext })).toMatchObject({ status: "OK" });
      recipeChecked.resolve();
      await finishPostAuth.promise;
      input.options.res.setHeader("st-access-token", "must-not-escape", false);
      input.options.res.setCookie("sAccessToken", "must-not-escape", undefined, false, true, Date.now() + 1000, "/", "lax");
      input.options.res.sendJSONResponse({ status: "OK", token: "must-not-escape" });
      return { status: "OK", user: { id: "owner" }, session };
    } });
    const result = api.signInUpPOST({ provider: { id: "google" }, tenantId: "public", session: reused ? session : undefined,
      options: { req: { getKeyValueFromQuery: () => undefined }, res: response }, userContext: {} });
    await recipeChecked.promise;
    suppressed = true;
    finishPostAuth.resolve();
    await revokeEntered.promise;
    expect(responseSpies.setHeader).not.toHaveBeenCalled();
    expect(responseSpies.setCookie).not.toHaveBeenCalled();
    expect(responseSpies.sendJSONResponse).not.toHaveBeenCalled();
    finishRevocation.resolve();
    expect(await result).toMatchObject({ status: "SIGN_IN_UP_NOT_ALLOWED" });
    expect(revoke).toHaveBeenCalledWith("handle", expect.anything());
    expect(session.mergeIntoAccessTokenPayload).toHaveBeenCalledTimes(1);
    expect(assertSignInMethodAuthenticationAllowed).toHaveBeenCalledTimes(2);
    const checks = vi.mocked(assertSignInMethodAuthenticationAllowed).mock.calls;
    const lastCheck = checks[checks.length - 1];
    expect(lastCheck?.[1].getAsString()).toBe("actual-sso");
    expect(responseSpies.setHeader).not.toHaveBeenCalled();
    expect(responseSpies.setCookie).not.toHaveBeenCalled();
    expect(responseSpies.sendJSONResponse).not.toHaveBeenCalled();
  });
});

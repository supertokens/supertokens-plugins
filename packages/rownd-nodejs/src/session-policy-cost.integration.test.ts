import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import SuperTokens from "supertokens-node";
import AccountLinking from "supertokens-node/recipe/accountlinking";
import EmailVerification from "supertokens-node/recipe/emailverification";
import Passwordless from "supertokens-node/recipe/passwordless";
import Session from "supertokens-node/recipe/session";
import ThirdParty from "supertokens-node/recipe/thirdparty";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import { CollectingResponse, PreParsedRequest, errorHandler, middleware } from "supertokens-node/framework/custom";
import { getPluginConfig } from "./config";
import { init } from "./plugin";
import { reconcileUser } from "./reconcile-user";
import {
  assertNoDisconnectedSignInMethodsAtInternalOwner,
  recordDisconnectedSignInMethod,
} from "./disconnected-sign-in-identities";
import { inspectSignInMethodPolicy, repairSignInMethodPolicy } from "./index";
import { configureConnectedSignInMethodsTestLicense, startConnectedSignInMethodsCore } from "./connected-sign-in-methods-core.test-fixture";

describe("session policy Core read deltas", { timeout: 30000 }, () => {
  let core: Awaited<ReturnType<typeof startConnectedSignInMethodsCore>> | undefined;
  const origin = "http://localhost:3001/auth";

  beforeAll(async () => {
    core = await startConnectedSignInMethodsCore("memory");
    await configureConnectedSignInMethodsTestLicense(core.connectionURI, "memory");
    SuperTokens.init({
      framework: "custom",
      supertokens: { connectionURI: core.connectionURI },
      appInfo: { appName: "Session policy", apiDomain: "http://localhost:3001", websiteDomain: "http://localhost:3000" },
      recipeList: [AccountLinking.init({ shouldDoAutomaticAccountLinking: async () => ({ shouldAutomaticallyLink: false }) }),
        Session.init(), UserMetadata.init(), EmailVerification.init({ mode: "OPTIONAL" }),
        Passwordless.init({ contactMethod: "EMAIL", flowType: "MAGIC_LINK" }),
        ThirdParty.init({ signInAndUpFeature: { providers: [{
          config: { thirdPartyId: "test-sso", authorizationEndpoint: "https://provider.invalid/authorize",
            tokenEndpoint: "https://provider.invalid/token", userInfoEndpoint: "https://provider.invalid/user",
            clients: [{ clientId: "test", clientSecret: "test" }] },
          override: (original) => {
            if (original.type !== "oauth2") throw new Error("Expected OAuth2 provider");
            return { ...original, getUserInfo: async ({ oAuthTokens }) => ({
              thirdPartyUserId: oAuthTokens.subject!, email: { id: oAuthTokens.email!, isVerified: true }, rawUserInfoFromProvider: {},
            }) };
          },
        }] } })],
      experimental: { plugins: [init({ disableRowndUserMigration: true,
        appConfig: { signInMethods: [{ method: "email" }, { method: "test-sso" }] } })] },
    });
  }, 120000);

  afterAll(async () => { await core?.stop(); });

  async function request(path: string, recipe: string, body: object) {
    const req = new PreParsedRequest({ url: `${origin}${path}`, method: "post", cookies: {}, query: {},
      headers: new Headers({ rid: recipe, "content-type": "application/json", "fdi-version": "1.18", "st-auth-mode": "header" }),
      getJSONBody: async () => body, getFormBody: async () => ({}) });
    const res = new CollectingResponse();
    const result = await middleware()(req, res);
    if (result.error) await errorHandler()(result.error, req, res, (error) => { if (error) throw error; });
    return { status: res.statusCode, body: JSON.parse(res.body ?? "null"), headers: res.headers };
  }

  async function seed() {
    const email = `${randomUUID()}@example.com`;
    const oauthEmail = `${randomUUID()}@example.com`;
    const subject = randomUUID();
    const passwordless = await Passwordless.signInUp({ tenantId: "public", email });
    const sso = await ThirdParty.manuallyCreateOrUpdateUser("public", "test-sso", subject, oauthEmail, true);
    if (sso.status !== "OK") throw new Error("SSO seed failed");
    expect(await AccountLinking.createPrimaryUser(passwordless.recipeUserId)).toMatchObject({ status: "OK" });
    expect(await AccountLinking.linkAccounts(sso.recipeUserId, passwordless.user.id)).toMatchObject({ status: "OK" });
    return { email, oauthEmail, subject, passwordless, sso, ownerId: passwordless.user.id };
  }

  async function emailSignIn(email: string) {
    const code = await Passwordless.createCode({ tenantId: "public", email });
    return () => request("/signinup/code/consume", "passwordless", { preAuthSessionId: code.preAuthSessionId, linkCode: code.linkCode });
  }

  it.each([false, true])("bounds the extra Core GETs (management enabled=%s)", async (enabled) => {
    Object.assign(getPluginConfig()!, { connectedSignInMethods: { enabled } });
    const f = await seed();
    const consume = await emailSignIn(f.email);
    const session = await Session.createNewSessionWithoutRequestResponse("public", f.passwordless.recipeUserId);
    const transport = await import("supertokens-node/lib/build/querier");
    const fetchCore = vi.spyOn(transport, "doFetch");
    const extra = async (operation: () => Promise<unknown>) => {
      fetchCore.mockClear();
      await operation();
      return fetchCore.mock.calls.filter(([, options]) => options?.method === "GET").length;
    };
    try {
      const token = session.getAccessToken();
      const counts = [
        await extra(async () => expect(await Session.getSessionWithoutRequestResponse(token, undefined, { checkDatabase: false })).toBeDefined()),
        await extra(async () => expect(await Session.getSessionWithoutRequestResponse(token, undefined, { checkDatabase: true })).toBeDefined()),
        await extra(async () => expect(await Session.refreshSessionWithoutRequestResponse(session.getAllSessionTokensDangerously().refreshToken!, true)).toBeDefined()),
        await extra(async () => expect((await consume()).body).toMatchObject({ status: "OK", user: { id: f.ownerId } })),
        await extra(async () => expect((await request("/signinup", "thirdparty", {
          thirdPartyId: "test-sso", oAuthTokens: { subject: f.subject, email: f.oauthEmail },
        })).body).toMatchObject({ status: "OK", user: { id: f.ownerId } })),
      ];
      console.info("session policy GET counts [stateless, database, refresh, passwordless, SSO]", { enabled, counts });
      // Same fixture and flows run against main (e6e11c7); the management setting does not exist there.
      const main = [0, 0, 0, 18, 17];
      const budget = [0, 0, 2, 4, 5];
      counts.forEach((count, i) => expect(count - main[i]!, `flow ${i} delta`).toBeLessThanOrEqual(budget[i]!));

      const rowndId = `rownd-${randomUUID()}`;
      expect(await SuperTokens.createUserIdMapping({ superTokensUserId: f.ownerId, externalUserId: rowndId, force: true }))
        .toMatchObject({ status: "OK" });
      const mappedSession = await Session.createNewSessionWithoutRequestResponse("public", SuperTokens.convertToRecipeUserId(rowndId));
      expect(mappedSession.getUserId()).toBe(rowndId);
      const refreshToken = mappedSession.getAllSessionTokensDangerously().refreshToken!;
      const mappedRefresh = await extra(async () => {
        expect((await Session.refreshSessionWithoutRequestResponse(refreshToken, true)).getUserId()).toBe(rowndId);
      });
      console.info("mapped session refresh Core GET count", { enabled, mappedRefresh });
      expect(mappedRefresh).toBeLessThanOrEqual(2);
    } finally {
      fetchCore.mockRestore();
    }
  });

  it("does not lock out a legacy account with dual-namespace mappings and no policy", async () => {
    Object.assign(getPluginConfig()!, { connectedSignInMethods: { enabled: false } });
    const f = await seed();
    const other = await Passwordless.signInUp({ tenantId: "public", email: `${randomUUID()}@example.com` });
    expect(await SuperTokens.createUserIdMapping({ superTokensUserId: f.ownerId, externalUserId: `rownd-${randomUUID()}`, force: true })).toMatchObject({ status: "OK" });
    expect(await SuperTokens.createUserIdMapping({ superTokensUserId: other.user.id, externalUserId: f.ownerId, force: true })).toMatchObject({ status: "OK" });
    const passwordless = await (await emailSignIn(f.email))();
    expect(passwordless.body).toMatchObject({ status: "OK" });
    const token = passwordless.headers.get("st-access-token")!;
    for (const checkDatabase of [true, false]) {
      expect(await Session.getSessionWithoutRequestResponse(token, undefined, { checkDatabase })).toBeDefined();
    }
    expect(await Session.refreshSessionWithoutRequestResponse(passwordless.headers.get("st-refresh-token")!, true)).toBeDefined();
    expect((await request("/signinup", "thirdparty", {
      thirdPartyId: "test-sso", oAuthTokens: { subject: f.subject, email: f.oauthEmail },
    })).body).toMatchObject({ status: "OK" });
    expect(await reconcileUser({ supertokens_user_id: f.ownerId })).toMatchObject({ status: "BLOCKED", message: expect.stringContaining("EXTERNAL_ALIAS_AMBIGUOUS") });
  });

  it("turns malformed policy into authentication denials without revoking on refresh", async () => {
    const f = await seed();
    const session = await Session.createNewSessionWithoutRequestResponse("public", f.passwordless.recipeUserId);
    await UserMetadata.updateUserMetadata(f.ownerId, { rownd_disconnected_sign_in_identity_invalid: true });
    const logs = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const passwordless = await (await emailSignIn(f.email))();
      expect(passwordless.body).toMatchObject({ status: "SIGN_IN_UP_NOT_ALLOWED", reason: "DISCONNECT_POLICY_INVALID" });
      expect(passwordless.headers.get("st-access-token")).toBeNull();
      const thirdParty = await request("/signinup", "thirdparty", {
        thirdPartyId: "test-sso", oAuthTokens: { subject: f.subject, email: f.oauthEmail },
      });
      expect(thirdParty.body).toMatchObject({ status: "SIGN_IN_UP_NOT_ALLOWED", reason: "DISCONNECT_POLICY_INVALID" });
      await expect(Session.refreshSessionWithoutRequestResponse(session.getAllSessionTokensDangerously().refreshToken!, true))
        .rejects.toMatchObject({ type: Session.Error.UNAUTHORISED, payload: { clearTokens: true } });
      expect(await Session.getSessionInformation(session.getHandle())).toBeDefined();
      expect(logs.mock.calls.some(([line]) => String(line).includes('"code":"DISCONNECT_POLICY_INVALID"'))).toBe(true);
    } finally {
      logs.mockRestore();
    }
  });

  it("continues stateless verification during a Core outage and does not revoke on transient refresh failure", async () => {
    const f = await seed();
    const session = await Session.createNewSessionWithoutRequestResponse("public", f.passwordless.recipeUserId);
    const token = session.getAccessToken();
    await Session.getSessionWithoutRequestResponse(token);
    const transport = await import("supertokens-node/lib/build/querier");
    const doFetch = transport.doFetch;
    const requests = vi.spyOn(transport, "doFetch").mockRejectedValue(new Error("test Core outage"));
    try {
      await expect(Session.getSessionWithoutRequestResponse(token, undefined, { checkDatabase: false })).resolves.toBeDefined();
      expect(requests).not.toHaveBeenCalled();
      requests.mockImplementation((url, options) => String(url).includes("/recipe/userid/map")
        ? Promise.reject(new Error("test Core outage")) : doFetch(url, options));
      await expect(Session.refreshSessionWithoutRequestResponse(session.getAllSessionTokensDangerously().refreshToken!, true)).rejects.toThrow("test Core outage");
      expect(requests.mock.calls.some(([url]) => String(url).includes("/session/remove"))).toBe(false);
    } finally {
      requests.mockRestore();
    }
    expect(await Session.getSessionInformation(session.getHandle())).toBeDefined();
  });

  it("denies authentication against a reassociated policy owner without writing fences and repairs explicit fences only", async () => {
    const subject = randomUUID();
    const donor = await ThirdParty.manuallyCreateOrUpdateUser("public", "test-sso", subject, `${randomUUID()}@example.com`, true);
    if (donor.status !== "OK") throw new Error("SSO seed failed");
    const destination = await seed();
    const ownerId = donor.user.id;
    const originalSession = await Session.createNewSessionWithoutRequestResponse("public", donor.recipeUserId);
    const factor = { userId: ownerId, tenantId: "public", recipeUserId: donor.recipeUserId.getAsString(),
      providerId: "test-sso", providerUserId: subject };
    await recordDisconnectedSignInMethod(factor);

    const admin = await fetch(`${core!.connectionURI}/recipe/accountlinking/user/link`, {
      method: "POST", headers: { "content-type": "application/json", "cdi-version": "5.1" },
      body: JSON.stringify({ recipeUserId: ownerId, primaryUserId: destination.ownerId }),
    });
    expect(await admin.json()).toMatchObject({ status: "OK" });
    const writes = vi.spyOn(UserMetadata, "updateUserMetadata");
    try {
      await expect(Session.getSessionWithoutRequestResponse(originalSession.getAccessToken(), undefined, { checkDatabase: false })).resolves.toBeDefined();
      await expect(Session.refreshSessionWithoutRequestResponse(originalSession.getAllSessionTokensDangerously().refreshToken!, true))
        .rejects.toMatchObject({ type: Session.Error.UNAUTHORISED });
      const signIn = await (await emailSignIn(destination.email))();
      expect(signIn.body).toMatchObject({ status: "SIGN_IN_UP_NOT_ALLOWED", reason: "DISCONNECT_OWNER_CHANGED" });
      expect(writes).not.toHaveBeenCalled();
    } finally {
      writes.mockRestore();
    }
    const inspected = await inspectSignInMethodPolicy({ userId: destination.ownerId, tenantId: "public" });
    const protectedRow = expect.objectContaining({ ownerId, reassociated: true,
      intents: [expect.objectContaining(factor)] });
    expect(inspected.rows).toContainEqual(protectedRow);
    await expect(assertNoDisconnectedSignInMethodsAtInternalOwner(ownerId, {}, destination.ownerId))
      .rejects.toMatchObject({ code: "DISCONNECT_RESTORATION_BLOCKED" });
    const adminError = await AccountLinking.linkAccounts(donor.recipeUserId, destination.ownerId).catch((error: unknown) => error);
    expect(adminError).toMatchObject({ code: "DISCONNECT_OWNER_CHANGED" });
    const adminRequest = new PreParsedRequest({
      url: `${origin}/app-admin/link`, method: "post", cookies: {}, query: {}, headers: new Headers(),
      getJSONBody: async () => ({}), getFormBody: async () => ({}),
    });
    const adminResponse = new CollectingResponse();
    await errorHandler()(adminError, adminRequest, adminResponse, (error) => { if (error) throw error; });
    expect(adminResponse.statusCode).toBe(400);
    const invalid = "rownd_disconnected_sign_in_identity_invalid";
    await UserMetadata.updateUserMetadata(destination.ownerId, { [invalid]: false });
    const repair = { userId: destination.ownerId, remove: ["fences"] as Array<"fences"> };
    const dryRun = await repairSignInMethodPolicy({ ...repair, dryRun: true });
    expect(dryRun.keys).toEqual([expect.stringContaining("owner_transition_conflict_")]);
    const applied = await repairSignInMethodPolicy({ ...repair, dryRun: false });
    expect(applied.keys).toEqual(dryRun.keys);
    expect((await UserMetadata.getUserMetadata(destination.ownerId)).metadata).toEqual({ [invalid]: false });
    await expect(repairSignInMethodPolicy({ userId: destination.ownerId, remove: ["invalid"], dryRun: false }))
      .resolves.toMatchObject({ keys: [invalid] });
    expect((await inspectSignInMethodPolicy({ userId: destination.ownerId })).rows).toContainEqual(protectedRow);
  });
});

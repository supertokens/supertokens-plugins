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
  signInIdentityHash,
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
        appConfig: { signInMethods: [{ method: "email" }, { method: "test-sso" }, { method: "anonymous" }] } })] },
    });
  }, 120000);

  afterAll(async () => { await core?.stop(); });

  async function request(path: string, recipe: string, body: object, accessToken?: string, fdiVersion = "1.18") {
    const req = new PreParsedRequest({ url: `${origin}${path}`, method: "post", cookies: {}, query: {},
      headers: new Headers({ ...(recipe ? { rid: recipe } : {}), "content-type": "application/json", "fdi-version": fdiVersion, "st-auth-mode": "header",
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) }),
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

  async function emailSignIn(email: string, accessToken?: string, explicitLink = false) {
    const code = await Passwordless.createCode({ tenantId: "public", email });
    return () => request("/signinup/code/consume", "passwordless", {
      preAuthSessionId: code.preAuthSessionId, linkCode: code.linkCode,
      ...(explicitLink ? { shouldTryLinkingWithSessionUser: true } : {}),
    }, accessToken, explicitLink ? "3.1" : "1.18");
  }

  const metadataModes = ["compatibility", "dual-write", "canonical"] as const;
  it.each(metadataModes.flatMap((metadataMode) => [false, true].map((enabled) => ({ metadataMode, enabled }))))(
    "holds main's no-policy Core budget ($metadataMode, management enabled=$enabled)", async ({ metadataMode, enabled }) => {
    const config = getPluginConfig()!;
    const previous = { metadataMode: config.metadataMode, connectedSignInMethods: config.connectedSignInMethods };
    Object.assign(config, { metadataMode, connectedSignInMethods: { enabled } });
    const f = await seed();
    const consume = await emailSignIn(f.email);
    const session = await Session.createNewSessionWithoutRequestResponse("public", f.passwordless.recipeUserId);
    const transport = await import("supertokens-node/lib/build/querier");
    const fetchCore = vi.spyOn(transport, "doFetch");
    const measure = async (operation: () => Promise<unknown>) => {
      fetchCore.mockClear();
      await operation();
      const gets = fetchCore.mock.calls.filter(([, options]) => options?.method === "GET");
      const indexReads = gets.filter(([url]) => new URL(String(url)).searchParams.get("userId")?.startsWith("rownd_dsi:")).length;
      return [gets.length - indexReads, fetchCore.mock.calls.length - gets.length, indexReads];
    };
    const google = (subject: string, email: string) => request("/signinup", "thirdparty", {
      thirdPartyId: "test-sso", oAuthTokens: { subject, email },
    });
    const canonical = metadataMode === "canonical";
    try {
      const token = session.getAccessToken();
      const counts = [
        await measure(async () => expect(await Session.getSessionWithoutRequestResponse(token, undefined, { checkDatabase: false })).toBeDefined()),
        await measure(async () => expect(await Session.getSessionWithoutRequestResponse(token, undefined, { checkDatabase: true })).toBeDefined()),
        await measure(async () => expect(await Session.refreshSessionWithoutRequestResponse(session.getAllSessionTokensDangerously().refreshToken!, true)).toBeDefined()),
        await measure(async () => expect((await consume()).body).toMatchObject({ status: "OK", user: { id: f.ownerId } })),
        await measure(async () => expect((await google(f.subject, f.oauthEmail)).body).toMatchObject({ status: "OK", user: { id: f.ownerId } })),
        await measure(async () => expect((await google(randomUUID(), `${randomUUID()}@example.com`)).body).toMatchObject({ status: "OK", createdNewRecipeUser: true })),
      ];
      // Tuples are [ordinary GETs, writes, SSO index GETs]. The first two columns match 1768970.
      expect.soft(counts).toEqual([[0, 0, 0], [0, 1, 0], [0, 1, 0], [canonical ? 15 : 18, 3, 0],
        [canonical ? 9 : 16, 3, 1], [canonical ? 9 : 15, 3, 2]]);

      const autoLinkEmail = `${randomUUID()}@example.com`;
      const autoLinkOwner = await Passwordless.signInUp({ tenantId: "public", email: autoLinkEmail });
      expect(await AccountLinking.createPrimaryUser(autoLinkOwner.recipeUserId)).toMatchObject({ status: "OK" });
      expect.soft(await measure(async () => {
        const response = await google(randomUUID(), autoLinkEmail);
        expect(response.body).toMatchObject({ status: "OK", createdNewRecipeUser: true });
        expect(response.body.user.id === autoLinkOwner.user.id).toBe(!canonical);
      })).toEqual(canonical ? [9, 3, 2] : [26, 4, 2]);

      for (const explicitLink of [false, true]) {
        const activeSession = await Session.createNewSessionWithoutRequestResponse("public", f.passwordless.recipeUserId);
        const activeToken = activeSession.getAccessToken();
        const consumeWithSession = await emailSignIn(f.email, activeToken, explicitLink);
        let refreshedToken = activeToken;
        expect.soft(await measure(async () => {
          const response = await consumeWithSession();
          expect(response.body).toMatchObject({ status: "OK", user: { id: f.ownerId } });
          refreshedToken = response.headers.get("st-access-token") ?? activeToken;
        })).toEqual([12, 2, 0]);
        expect(fetchCore.mock.calls.some(([url, options]) => options?.method === "GET" &&
          new URL(String(url)).pathname === "/recipe/session")).toBe(false);
        const retained = await Session.getSessionWithoutRequestResponse(refreshedToken);
        expect(retained.getHandle()).toBe(activeSession.getHandle());
      }

      for (const exists of [false, true]) {
        const guest = await request("/plugin/rownd/guest", "", {});
        expect(guest.body).toMatchObject({ status: "OK" });
        const upgrade = await emailSignIn(exists ? f.email : `${randomUUID()}@example.com`, guest.headers.get("st-access-token")!);
        expect.soft(await measure(async () => {
          const response = await upgrade();
          expect(response.body.status).toBe(exists && !canonical ? "SIGN_IN_UP_NOT_ALLOWED" : "OK");
        })).toEqual(exists ? [canonical ? 17 : 9, 3, 0] : canonical ? [11, 3, 0] : [12, 4, 0]);
      }

      const rowndId = `rownd-${randomUUID()}`;
      expect(await SuperTokens.createUserIdMapping({ superTokensUserId: f.ownerId, externalUserId: rowndId, force: true }))
        .toMatchObject({ status: "OK" });
      const mappedSession = await Session.createNewSessionWithoutRequestResponse("public", SuperTokens.convertToRecipeUserId(rowndId));
      expect(mappedSession.getUserId()).toBe(rowndId);
      const refreshToken = mappedSession.getAllSessionTokensDangerously().refreshToken!;
      expect.soft(await measure(async () => {
        expect((await Session.refreshSessionWithoutRequestResponse(refreshToken, true)).getUserId()).toBe(rowndId);
      })).toEqual([0, 1, 0]);
      const mappedConsume = await emailSignIn(f.email);
      expect.soft(await measure(async () => expect((await mappedConsume()).body).toMatchObject({ status: "OK", user: { id: rowndId } })))
        .toEqual([canonical ? 17 : 21, 3, 0]);
      expect.soft(await measure(async () => expect((await google(f.subject, f.oauthEmail)).body).toMatchObject({ status: "OK", user: { id: rowndId } })))
        .toEqual([canonical ? 9 : 18, 3, 1]);

      const linkPasswordless = async () => {
        const extra = await Passwordless.signInUp({ tenantId: "public", email: `${randomUUID()}@example.com` });
        return measure(async () => expect(await AccountLinking.linkAccounts(extra.recipeUserId, rowndId)).toMatchObject({ status: "OK" }));
      };
      expect.soft(await linkPasswordless()).toEqual([4, 1, 0]);
      const emailSelector = { rownd_email_recipe_user_ids: { public: rowndId } };
      await UserMetadata.updateUserMetadata(f.ownerId, emailSelector);
      await UserMetadata.updateUserMetadata(rowndId, emailSelector);
      const allowedSubject = randomUUID();
      const allowedEmail = `${randomUUID()}@example.com`;
      const allowed = await ThirdParty.manuallyCreateOrUpdateUser("public", "test-sso", allowedSubject, allowedEmail, true);
      if (allowed.status !== "OK") throw new Error("SSO seed failed");
      expect(await AccountLinking.linkAccounts(allowed.recipeUserId, rowndId)).toMatchObject({ status: "OK" });
      await recordDisconnectedSignInMethod({ userId: f.ownerId, tenantId: "public", recipeUserId: f.sso.recipeUserId.getAsString(),
        providerId: "test-sso", providerUserId: f.subject });
      const keptEmail = await emailSignIn(f.email);
      const retainedSession = await Session.createNewSessionWithoutRequestResponse("public", SuperTokens.convertToRecipeUserId(rowndId));
      const recordCounts = {
        linking: await linkPasswordless(),
        passwordless: await measure(async () => expect((await keptEmail()).body).toMatchObject({ status: "OK", user: { id: rowndId } })),
        differentSSO: await measure(async () => expect((await google(allowedSubject, allowedEmail)).body).toMatchObject({ status: "OK", user: { id: rowndId } })),
        blockedSSO: await measure(async () => expect((await google(f.subject, f.oauthEmail)).body)
          .toEqual({ status: "SIGN_IN_UP_NOT_ALLOWED", reason: "SIGN_IN_METHOD_DISCONNECTED" })),
        refresh: await measure(async () => expect(await Session.refreshSessionWithoutRequestResponse(
          retainedSession.getAllSessionTokensDangerously().refreshToken!, true,
        )).toBeDefined()),
      };
      console.info("mapped owner with a disconnect intent [ordinary GETs, writes, index GETs]", { metadataMode, enabled, recordCounts });
      expect(recordCounts).toEqual({
        linking: [4, 1, 0], passwordless: [canonical ? 33 : 34, 3, 0],
        differentSSO: [canonical ? 24 : 28, 3, 1], blockedSSO: [3, 0, 1], refresh: [0, 1, 0],
      });
    } finally {
      fetchCore.mockRestore();
      Object.assign(config, previous);
    }
  });

  it("does not publish a canonical Passwordless session if policy changes during issuance", async () => {
    const config = getPluginConfig()!;
    const previousMode = config.metadataMode;
    config.metadataMode = "canonical";
    const f = await seed();
    const existing = await Session.createNewSessionWithoutRequestResponse("public", f.passwordless.recipeUserId);
    const consume = await emailSignIn(f.email);
    const repository = await import("./supertokens-repository");
    const validateConsumedPasswordlessEmail = repository.validateConsumedPasswordlessEmail;
    const validate = vi.spyOn(repository, "validateConsumedPasswordlessEmail").mockImplementationOnce(async (input) => {
      // The SDK has minted a session, but the plugin has not released its credentials.
      expect(await Session.getAllSessionHandlesForUser(f.ownerId, true)).toHaveLength(2);
      await UserMetadata.updateUserMetadata(f.ownerId, { rownd_disconnected_sign_in_identity_invalid: true });
      return validateConsumedPasswordlessEmail(input);
    });
    try {
      const denied = await consume();
      expect(denied.body).toEqual({ status: "SIGN_IN_UP_NOT_ALLOWED", reason: "DISCONNECT_POLICY_INVALID" });
      expect(denied.headers.get("st-access-token")).toBeNull();
      expect(denied.headers.get("st-refresh-token")).toBeNull();
      expect(await Session.getAllSessionHandlesForUser(f.ownerId, true)).toEqual([existing.getHandle()]);
    } finally {
      validate.mockRestore();
      config.metadataMode = previousMode;
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

  it("denies issuance for malformed policy without changing SDK refresh", async () => {
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
      await expect(Session.refreshSessionWithoutRequestResponse(session.getAllSessionTokensDangerously().refreshToken!, true)).resolves.toBeDefined();
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
      requests.mockImplementation((url, options) => String(url).includes("/recipe/session/refresh")
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
      const signIn = await (await emailSignIn(destination.email))();
      expect(signIn.body).toMatchObject({ status: "SIGN_IN_UP_NOT_ALLOWED", reason: "DISCONNECT_OWNER_CHANGED" });
      expect(writes).not.toHaveBeenCalled();
    } finally {
      writes.mockRestore();
    }
    const inspected = await inspectSignInMethodPolicy({ userId: destination.ownerId, tenantId: "public" });
    const protectedRow = expect.objectContaining({ ownerId, reassociated: true,
      intents: [expect.objectContaining({ userId: ownerId, tenantId: "public", recipeUserId: factor.recipeUserId,
        providerId: factor.providerId, identityHash: signInIdentityHash(factor) })] });
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

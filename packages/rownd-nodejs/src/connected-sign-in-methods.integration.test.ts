import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import SuperTokens from "supertokens-node";
import AccountLinking from "supertokens-node/recipe/accountlinking";
import Passwordless from "supertokens-node/recipe/passwordless";
import ThirdParty from "supertokens-node/recipe/thirdparty";
import ThirdPartyRecipe from "supertokens-node/lib/build/recipe/thirdparty/recipe";
import Session from "supertokens-node/recipe/session";
import EmailVerification from "supertokens-node/recipe/emailverification";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import UserRoles from "supertokens-node/recipe/userroles";
import { CollectingResponse, PreParsedRequest, middleware, errorHandler } from "supertokens-node/framework/custom";
import { getUserContext } from "supertokens-node/lib/build/utils";
import Multitenancy from "supertokens-node/recipe/multitenancy";
import { init } from "./plugin";
import { getPluginConfig } from "./config";
import { getDisconnectedSignInMethods } from "./disconnected-sign-in-identities";
import { configureConnectedSignInMethodsTestLicense, startConnectedSignInMethodsCore } from "./connected-sign-in-methods-core.test-fixture";

describe("connected sign-in methods against Core", { timeout: 30000 }, () => {
  let coreFixture: Awaited<ReturnType<typeof startConnectedSignInMethodsCore>> | undefined;
  let recordedCoreGets: string[] | undefined;
  const origin = "http://localhost:3001/auth";

  beforeAll(async () => {
    coreFixture = await startConnectedSignInMethodsCore();
    const { connectionURI } = coreFixture;
    await configureConnectedSignInMethodsTestLicense(connectionURI);
    SuperTokens.init({
      framework: "custom",
      supertokens: { connectionURI, networkInterceptor: (request) => {
        // The SDK interceptor sees real outbound attempts, after its request-local cache check.
        if (request.method === "get") recordedCoreGets?.push(request.url);
        return request;
      } },
      appInfo: { appName: "Connected methods", apiDomain: "http://localhost:3001", websiteDomain: "http://localhost:3000" },
      recipeList: [AccountLinking.init({ shouldDoAutomaticAccountLinking: async () => ({ shouldAutomaticallyLink: false }) }),
        Session.init(), UserMetadata.init(), UserRoles.init(), EmailVerification.init({ mode: "OPTIONAL" }),
        Passwordless.init({ contactMethod: "EMAIL", flowType: "MAGIC_LINK" }), ThirdParty.init({ signInAndUpFeature: { providers: [{
          config: { thirdPartyId: "budget-sso", authorizationEndpoint: "https://provider.invalid/authorize",
            tokenEndpoint: "https://provider.invalid/token", userInfoEndpoint: "https://provider.invalid/user",
            clients: [{ clientId: "test", clientSecret: "test" }] },
          override: (original) => {
            if (original.type !== "oauth2") throw new Error("Expected the OAuth2 test provider");
            return { ...original, getUserInfo: async ({ oAuthTokens }: Parameters<typeof original.getUserInfo>[0]) => ({
              thirdPartyUserId: oAuthTokens.subject!, email: { id: oAuthTokens.email!, isVerified: true }, rawUserInfoFromProvider: {},
            }) };
          },
        }] } })],
      experimental: { plugins: [init({ disableRowndUserMigration: true, connectedSignInMethods: { enabled: true },
        appConfig: { signInMethods: [{ method: "email" }, { method: "google" }] } })] },
    });
  }, 120000);

  afterAll(async () => {
    await coreFixture?.stop();
  });

  async function request(url: string, options: RequestInit = {}) {
    const parsed = new URL(url);
    const req = new PreParsedRequest({
      url, method: options.method === "POST" ? "post" : "get", headers: new Headers(options.headers), cookies: {},
      query: Object.fromEntries(parsed.searchParams),
      getJSONBody: async () => typeof options.body === "string" ? JSON.parse(options.body) : {},
      getFormBody: async () => ({}),
    });
    const res = new CollectingResponse();
    const result = await middleware()(req, res);
    if (result.error) {
      await errorHandler()(result.error, req, res, (error) => { if (error) throw error; });
    } else if (!result.handled) {
      res.setStatusCode(404);
    }
    return new Response(res.body ?? null, { status: res.statusCode, headers: res.headers });
  }

  async function emailSignIn(email: string, accessToken?: string) {
    const code = await Passwordless.createCode({ tenantId: "public", email });
    const response = await request(`${origin}/signinup/code/consume`, {
      method: "POST",
      headers: { rid: "passwordless", "content-type": "application/json", "fdi-version": "1.18", "st-auth-mode": "header",
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
      body: JSON.stringify({ preAuthSessionId: code.preAuthSessionId, linkCode: code.linkCode }),
    });
    expect(await response.json()).toMatchObject({ status: "OK" });
    const token = response.headers.get("st-access-token") ?? accessToken;
    if (!token) throw new Error("Sign-in returned no access token");
    return { token, response, session: await Session.getSessionWithoutRequestResponse(token, undefined, { checkDatabase: true }) };
  }

  async function fixture() {
    const rowndId = `rownd-${randomUUID()}`;
    const subject = randomUUID();
    const oldEmail = `${randomUUID()}@old.example.com`;
    const email = `${randomUUID()}@new.example.com`;
    const provider = await ThirdParty.manuallyCreateOrUpdateUser("public", "google", subject, oldEmail, false);
    if (provider.status !== "OK") throw new Error("Provider seed failed");
    const internalId = provider.recipeUserId.getAsString();
    expect(await AccountLinking.createPrimaryUser(provider.recipeUserId)).toMatchObject({ status: "OK" });
    const passwordless = await Passwordless.signInUp({ tenantId: "public", email,
      userContext: { rowndDisableAutomaticAccountLinking: true } });
    expect(await AccountLinking.linkAccounts(passwordless.recipeUserId, internalId)).toMatchObject({ status: "OK" });
    expect(await SuperTokens.createUserIdMapping({ superTokensUserId: internalId, externalUserId: rowndId, force: true })).toMatchObject({ status: "OK" });
    await UserMetadata.updateUserMetadata(internalId, { customer_value: "preserved", rownd_migration_complete: true,
      original_rownd_user: { state: "enabled", auth_level: "verified", data: { user_id: rowndId, google_id: subject, email: oldEmail },
        verified_data: { google_id: subject, email: true } }, rownd_email_recipe_user_ids: { public: passwordless.recipeUserId.getAsString() } });
    const ssoSession = await Session.createNewSessionWithoutRequestResponse("public", SuperTokens.convertToRecipeUserId(rowndId));
    return { rowndId, internalId, subject, oldEmail, email, ssoSession, passwordless };
  }

  it("removes a mapped PRIMARY SSO anchor without changing the surviving account or canonical email", async () => {
    const f = await fixture();
    const role = `role-${randomUUID()}`;
    await UserRoles.createNewRoleOrAddPermissions(role, ["profile:read"]);
    await UserRoles.addRoleToUser("public", f.rowndId, role);
    const mapping = await SuperTokens.getUserIdMapping({ userId: f.rowndId, userIdType: "EXTERNAL" });
    const before = (await UserMetadata.getUserMetadata(f.internalId)).metadata;
    const signedIn = await emailSignIn(f.email);
    const otherSession = await Session.createNewSessionWithoutRequestResponse("public", f.passwordless.recipeUserId);
    const headers = { authorization: `Bearer ${signedIn.token}`, "st-auth-mode": "header", "content-type": "application/json" };
    const listed = await (await request(`${origin}/plugin/rownd/user/sign-in-methods`, { headers })).json() as any;
    expect(listed).toMatchObject({ status: "OK", user_id: f.rowndId, reauthentication: { method: "email", identifier: f.email } });
    const method = listed.methods.find((entry: any) => entry.kind === "sso");
    expect(method).toMatchObject({ provider: "google", can_disconnect: true });
    const response = await request(`${origin}/plugin/rownd/user/sign-in-methods/disconnect`, { method: "POST", headers,
      body: JSON.stringify({ method_id: method.id, expected_user_id: f.rowndId, expected_tenant_id: "public" }) });
    expect(await response.json()).toEqual({ status: "OK", signed_out: true });
    expect(await SuperTokens.getUserIdMapping({ userId: f.rowndId, userIdType: "EXTERNAL" })).toEqual(mapping);
    const user = await SuperTokens.getUser(f.internalId);
    expect(user?.id).toBe(f.rowndId);
    expect(user?.loginMethods).toHaveLength(1);
    expect(user?.loginMethods[0]).toMatchObject({ recipeId: "passwordless", email: f.email, verified: true });
    const after = (await UserMetadata.getUserMetadata(f.internalId)).metadata;
    for (const [key, value] of Object.entries(before)) expect(after[key]).toEqual(value);
    expect(await UserRoles.getRolesForUser("public", f.rowndId)).toMatchObject({ status: "OK", roles: [role] });
    expect(await getDisconnectedSignInMethods(f.internalId)).toMatchObject([{ providerId: "google", providerUserId: f.subject, completed: true }]);
    expect(await Session.getAllSessionHandlesForUser(f.internalId, true)).toEqual([]);
    for (const [index, old] of [f.ssoSession, signedIn.session, otherSession].entries()) {
      expect(await Session.getSessionInformation(old.getHandle()) === undefined, `session ${index} was revoked`).toBe(true);
      await expect(Session.getSessionWithoutRequestResponse(old.getAccessToken(), undefined, { checkDatabase: true })).rejects.toBeDefined();
    }
    await expect(Session.refreshSessionWithoutRequestResponse(f.ssoSession.getAllSessionTokensDangerously().refreshToken!, true)).rejects.toBeDefined();
    await expect(Session.getSessionWithoutRequestResponse(f.ssoSession.getAccessToken(), undefined, { checkDatabase: false })).resolves.toBeDefined();
    const retained = await emailSignIn(f.email);
    expect(retained.session.getUserId()).toBe(f.rowndId);
    expect(retained.session.getRecipeUserId().getAsString()).toBe(f.passwordless.recipeUserId.getAsString());
    const profile = await (await request(`${origin}/plugin/rownd/user`, {
      headers: { authorization: `Bearer ${retained.token}`, "st-auth-mode": "header" },
    })).json();
    expect(profile).toMatchObject({ status: "OK", data: { user_id: f.rowndId, email: f.email } });
    const oldSignIn = await ThirdPartyRecipe.getInstanceOrThrowError().recipeInterfaceImpl.signInUp({
      thirdPartyId: "google", thirdPartyUserId: f.subject, email: f.oldEmail, isVerified: false,
      tenantId: "public", session: undefined, shouldTryLinkingWithSessionUser: undefined,
      oAuthTokens: {}, rawUserInfoFromProvider: {}, userContext: getUserContext({}),
    });
    expect(oldSignIn).toEqual({ status: "SIGN_IN_UP_NOT_ALLOWED", reason: "SIGN_IN_METHOD_DISCONNECTED" });
    expect(await SuperTokens.listUsersByAccountInfo("public", { thirdParty: { id: "google", userId: f.subject } }, false)).toEqual([]);
    expect((await SuperTokens.getUser(f.internalId))?.loginMethods).toHaveLength(1);
  });

  it("does not mint disconnect proof when email consumption reuses an SSO-bound session", async () => {
    const f = await fixture();
    const consumed = await emailSignIn(f.email, f.ssoSession.getAccessToken());
    expect(consumed.session.getRecipeUserId().getAsString()).toBe(f.rowndId);
    const headers = { authorization: `Bearer ${consumed.token}`, "st-auth-mode": "header", "content-type": "application/json" };
    const listed = await (await request(`${origin}/plugin/rownd/user/sign-in-methods`, { headers })).json() as any;
    expect(listed).not.toHaveProperty("reauthentication_valid_until");
    expect(listed.methods.find((entry: any) => entry.kind === "sso")).toMatchObject({
      can_disconnect: false, disconnect_block_reason: "SIGN_IN_METHOD_REAUTHENTICATION_REQUIRED",
    });
    const response = await request(`${origin}/plugin/rownd/user/sign-in-methods/disconnect`, { method: "POST", headers,
      body: JSON.stringify({ method_id: listed.methods.find((entry: any) => entry.kind === "sso").id,
        expected_user_id: f.rowndId, expected_tenant_id: "public" }) });
    expect(await response.json()).toMatchObject({ status: "ERROR", code: 403, error_code: "SIGN_IN_METHOD_REAUTHENTICATION_REQUIRED" });
    expect(await getDisconnectedSignInMethods(f.internalId)).toEqual([]);
  });

  it("offers deleted-recipe cleanup after reauthentication, then completes it without clearing suppression", async () => {
    const f = await fixture();
    const signedIn = await emailSignIn(f.email);
    const headers = { authorization: `Bearer ${signedIn.token}`, "st-auth-mode": "header", "content-type": "application/json" };
    const listed = await (await request(`${origin}/plugin/rownd/user/sign-in-methods`, { headers })).json() as any;
    const method = listed.methods.find((entry: any) => entry.kind === "sso");
    const body = JSON.stringify({ method_id: method.id, expected_user_id: f.rowndId, expected_tenant_id: "public" });
    const revoke = Session.revokeAllSessionsForUser.bind(Session);
    let calls = 0;
    const failure = vi.spyOn(Session, "revokeAllSessionsForUser").mockImplementation(async (...args) => {
      if (args[0] === f.internalId && ++calls === 2) throw new Error("Injected final revocation interruption");
      return revoke(...args);
    });
    try {
      const response = await request(`${origin}/plugin/rownd/user/sign-in-methods/disconnect`, { method: "POST", headers, body });
      expect(await response.json()).toMatchObject({ status: "ERROR", code: 409, error_code: "SIGN_IN_METHOD_OPERATION_INCOMPLETE" });
    } finally {
      failure.mockRestore();
    }
    expect((await SuperTokens.getUser(f.internalId))?.loginMethods).toHaveLength(1);
    expect((await getDisconnectedSignInMethods(f.internalId))[0]?.completed).not.toBe(true);
    const reauthenticated = await emailSignIn(f.email);
    const retryHeaders = { ...headers, authorization: `Bearer ${reauthenticated.token}` };
    const reopened = await (await request(`${origin}/plugin/rownd/user/sign-in-methods`, { headers: retryHeaders })).json() as any;
    expect(reopened.methods.find((entry: any) => entry.id === method.id)).toMatchObject({
      kind: "sso", provider: "google", can_disconnect: true, pending_disconnect: true,
    });
    const retried = await request(`${origin}/plugin/rownd/user/sign-in-methods/disconnect`, { method: "POST", headers: retryHeaders, body });
    expect(await retried.json()).toEqual({ status: "OK", signed_out: true });
    expect(await getDisconnectedSignInMethods(f.internalId)).toMatchObject([{ providerId: "google", providerUserId: f.subject, completed: true }]);
    const retained = await emailSignIn(f.email);
    const retainedHeaders = { ...headers, authorization: `Bearer ${retained.token}` };
    const completed = await (await request(`${origin}/plugin/rownd/user/sign-in-methods`, { headers: retainedHeaders })).json() as any;
    expect(completed.methods.some((entry: any) => entry.id === method.id)).toBe(false);
    const repeated = await request(`${origin}/plugin/rownd/user/sign-in-methods/disconnect`, { method: "POST", headers: retainedHeaders, body });
    expect(await repeated.json()).toMatchObject({ status: "ERROR", code: 409, error_code: "SIGN_IN_METHOD_ALREADY_DISCONNECTED" });
    expect(await Session.getSessionInformation(retained.session.getHandle())).toBeDefined();
    const blocked = await ThirdPartyRecipe.getInstanceOrThrowError().recipeInterfaceImpl.signInUp({
      thirdPartyId: "google", thirdPartyUserId: f.subject, email: f.oldEmail, isVerified: false,
      tenantId: "public", session: retained.session, shouldTryLinkingWithSessionUser: true,
      oAuthTokens: {}, rawUserInfoFromProvider: {}, userContext: getUserContext({}),
    });
    expect(blocked).toMatchObject({ status: "SIGN_IN_UP_NOT_ALLOWED" });
    expect((await SuperTokens.getUser(f.internalId))?.loginMethods).toHaveLength(1);
  });

  it("keeps durable enforcement after management is switched off", async () => {
    const f = await fixture();
    const signedIn = await emailSignIn(f.email);
    const headers = { authorization: `Bearer ${signedIn.token}`, "st-auth-mode": "header", "content-type": "application/json" };
    const listed = await (await request(`${origin}/plugin/rownd/user/sign-in-methods`, { headers })).json() as any;
    const disconnected = await request(`${origin}/plugin/rownd/user/sign-in-methods/disconnect`, { method: "POST", headers,
      body: JSON.stringify({ method_id: listed.methods.find((entry: any) => entry.kind === "sso").id,
        expected_user_id: f.rowndId, expected_tenant_id: "public" }) });
    expect(await disconnected.json()).toEqual({ status: "OK", signed_out: true });
    const config = getPluginConfig()!;
    config.connectedSignInMethods = { enabled: false };
    try {
      const appConfig = await (await request(`${origin}/plugin/rownd/app-config`)).json() as any;
      expect(appConfig).not.toHaveProperty("plugin_capabilities");
      await expect(Session.createNewSessionWithoutRequestResponse("public", SuperTokens.convertToRecipeUserId(f.rowndId))).rejects.toBeDefined();
      const suppressed = await ThirdPartyRecipe.getInstanceOrThrowError().recipeInterfaceImpl.signInUp({
        thirdPartyId: "google", thirdPartyUserId: f.subject, email: f.oldEmail, isVerified: false,
        tenantId: "public", session: undefined, shouldTryLinkingWithSessionUser: undefined,
        oAuthTokens: {}, rawUserInfoFromProvider: {}, userContext: getUserContext({}),
      });
      expect(suppressed).toEqual({ status: "SIGN_IN_UP_NOT_ALLOWED", reason: "SIGN_IN_METHOD_DISCONNECTED" });
      const retained = await emailSignIn(f.email);
      const response = await request(`${origin}/plugin/rownd/user/sign-in-methods`, {
        headers: { authorization: `Bearer ${retained.token}`, "st-auth-mode": "header" },
      });
      expect(response.status).toBe(404);
      expect(await getDisconnectedSignInMethods(f.internalId)).toHaveLength(1);
    } finally {
      config.connectedSignInMethods = { enabled: true };
    }
  });

  it.each([false, true])("bounds the WHOLE returning one-method SSO flow with real policy checks (management enabled=%s)", async (enabled) => {
    const subject = randomUUID();
    const email = `${randomUUID()}@budget.example.com`;
    const seed = await ThirdParty.manuallyCreateOrUpdateUser("public", "budget-sso", subject, email, true);
    if (seed.status !== "OK") throw new Error("Returning SSO seed failed");
    expect(await AccountLinking.createPrimaryUser(seed.recipeUserId)).toMatchObject({ status: "OK" });
    const input = { method: "POST", headers: { rid: "thirdparty", "content-type": "application/json", "fdi-version": "1.18", "st-auth-mode": "header" },
      body: JSON.stringify({ thirdPartyId: "budget-sso", oAuthTokens: { subject, email } }) };
    expect(await (await request(`${origin}/signinup`, input)).json()).toMatchObject({ status: "OK" });
    const config = getPluginConfig()!;
    const previous = config.connectedSignInMethods;
    config.connectedSignInMethods = { enabled };
    // Only the external OAuth response is simulated above. Core, SDK auth,
    // account linking, session creation, claims and policy scans all run normally.
    const reads = [vi.spyOn(SuperTokens, "getUser"), vi.spyOn(SuperTokens, "getUserIdMapping"),
      vi.spyOn(SuperTokens, "listUsersByAccountInfo"), vi.spyOn(UserMetadata, "getUserMetadata"),
      vi.spyOn(Session, "getSessionInformation"), vi.spyOn(Session, "getAllSessionHandlesForUser"),
      vi.spyOn(EmailVerification, "isEmailVerified"), vi.spyOn(Multitenancy, "getTenant")];
    const coreGets: string[] = [];
    recordedCoreGets = coreGets;
    try {
      const response = await request(`${origin}/signinup`, input);
      expect(await response.json()).toMatchObject({ status: "OK", user: { id: seed.user.id } });
      expect(response.headers.get("st-access-token")).toBeTruthy();
      const sdkReads = reads.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
      console.info("Whole returning SSO read budget", { enabled, sdkReads, coreGetAttempts: coreGets.length });
      expect(sdkReads, "Whole returning SSO SDK reads").toBeLessThanOrEqual(64);
      expect(coreGets.length, "Whole returning SSO observed Core GET attempts").toBeGreaterThan(0);
      expect(coreGets.length, "Whole returning SSO Core GET attempts").toBeLessThanOrEqual(32);
    } finally {
      for (const spy of reads) spy.mockRestore();
      recordedCoreGets = undefined;
      config.connectedSignInMethods = previous;
    }
  });
});

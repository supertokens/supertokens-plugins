import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import SuperTokens from "supertokens-node";
import AccountLinking from "supertokens-node/recipe/accountlinking";
import Passwordless from "supertokens-node/recipe/passwordless";
import ThirdParty from "supertokens-node/recipe/thirdparty";
import Session from "supertokens-node/recipe/session";
import EmailVerification from "supertokens-node/recipe/emailverification";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import MultiFactorAuth from "supertokens-node/recipe/multifactorauth";
import TOTP from "supertokens-node/recipe/totp";
import { CollectingResponse, PreParsedRequest, middleware, errorHandler } from "supertokens-node/framework/custom";
import { init } from "./plugin";
import { getConnectedSignInMethodsTestFeatures, startConnectedSignInMethodsCore } from "./connected-sign-in-methods-core.test-fixture";

// Optional backend-state coverage, not MFA support or a prerequisite for Rownd's sign-in flow.
describe("connected sign-in methods optional backend security preservation against Core", { timeout: 30000 }, () => {
  let coreFixture: Awaited<ReturnType<typeof startConnectedSignInMethodsCore>> | undefined;
  let hasMfa: boolean;
  const origin = "http://localhost:3001/auth";

  beforeAll(async () => {
    coreFixture = await startConnectedSignInMethodsCore("memory");
    hasMfa = (await getConnectedSignInMethodsTestFeatures(coreFixture.connectionURI)).includes("mfa");
    SuperTokens.init({
      framework: "custom",
      supertokens: { connectionURI: coreFixture.connectionURI },
      appInfo: { appName: "Optional backend security preservation", apiDomain: "http://localhost:3001", websiteDomain: "http://localhost:3000" },
      recipeList: [AccountLinking.init({ shouldDoAutomaticAccountLinking: async () => ({ shouldAutomaticallyLink: false }) }),
        Session.init(), UserMetadata.init(), MultiFactorAuth.init(), TOTP.init(), EmailVerification.init({ mode: "OPTIONAL" }),
        Passwordless.init({ contactMethod: "EMAIL", flowType: "MAGIC_LINK" }), ThirdParty.init()],
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

  function totp(secret: string) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const bytes: number[] = [];
    let bits = 0;
    let value = 0;
    for (const char of secret.toUpperCase().replace(/=+$/, "")) {
      const digit = alphabet.indexOf(char);
      if (digit < 0) throw new Error("Invalid base32 TOTP secret");
      value = (value << 5) | digit;
      bits += 5;
      if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 255); }
    }
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
    const digest = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
    const offset = digest[digest.length - 1]! & 15;
    return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
  }

  it("preserves a verified backend TOTP device when disconnecting a mapped PRIMARY SSO anchor", async ({ skip }) => {
    if (process.env.CONNECTED_METHODS_TEST_CORE_URI && !hasMfa) return skip();
    expect(hasMfa).toBe(true);
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
    await UserMetadata.updateUserMetadata(internalId, { rownd_migration_complete: true,
      original_rownd_user: { state: "enabled", auth_level: "verified", data: { user_id: rowndId, google_id: subject, email: oldEmail },
        verified_data: { google_id: subject, email: true } }, rownd_email_recipe_user_ids: { public: passwordless.recipeUserId.getAsString() } });

    const device = await TOTP.createDevice(rowndId, email, "retained-device");
    if (device.status !== "OK") throw new Error("TOTP device creation failed");
    expect(await TOTP.verifyDevice("public", rowndId, device.deviceName, totp(device.secret))).toMatchObject({ status: "OK" });
    const devices = await TOTP.listDevices(rowndId);
    expect(devices.devices).toEqual([expect.objectContaining({ name: "retained-device", verified: true })]);

    const code = await Passwordless.createCode({ tenantId: "public", email });
    const signedIn = await request(`${origin}/signinup/code/consume`, {
      method: "POST",
      headers: { rid: "passwordless", "content-type": "application/json", "fdi-version": "1.18", "st-auth-mode": "header" },
      body: JSON.stringify({ preAuthSessionId: code.preAuthSessionId, linkCode: code.linkCode }),
    });
    expect(await signedIn.json()).toMatchObject({ status: "OK" });
    const token = signedIn.headers.get("st-access-token");
    expect(token).toBeTruthy();
    const headers = { authorization: `Bearer ${token}`, "st-auth-mode": "header", "content-type": "application/json" };
    const listed = await (await request(`${origin}/plugin/rownd/user/sign-in-methods`, { headers })).json() as any;
    const method = listed.methods.find((entry: any) => entry.kind === "sso");
    expect(method).toMatchObject({ provider: "google", can_disconnect: true });
    const disconnected = await request(`${origin}/plugin/rownd/user/sign-in-methods/disconnect`, { method: "POST", headers,
      body: JSON.stringify({ method_id: method.id, expected_user_id: rowndId, expected_tenant_id: "public" }) });
    expect(await disconnected.json()).toEqual({ status: "OK", signed_out: true });
    expect(await TOTP.listDevices(rowndId)).toEqual(devices);
  });
});

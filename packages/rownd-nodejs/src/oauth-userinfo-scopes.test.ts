import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SuperTokens from "supertokens-node";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import userInfoGET from "supertokens-node/lib/build/recipe/oauth2provider/api/userInfo";
import getOAuthAPIImplementation from "supertokens-node/lib/build/recipe/oauth2provider/api/implementation";
import OAuthRecipe from "supertokens-node/lib/build/recipe/oauth2provider/recipe";
import type { RecipeInterface } from "supertokens-node/recipe/oauth2provider/types";
import type { UserContext } from "supertokens-node/types";
import { init } from "./plugin";
import type { SuperTokensUser } from "./rownd-compatibility";
import type { RowndPluginDynamicConfig } from "./types";
import type { JsonRecord } from "./utils";

const tokenClaims = {
  app_user_id: "token-app-user",
  auth_level: "instant",
  is_verified_user: false,
  is_anonymous: true,
  anonymous_id: "token-anonymous",
  "https://auth.rownd.io/app_user_id": "token-namespaced-user",
  "https://auth.rownd.io/auth_level": "guest",
  "https://auth.rownd.io/is_verified_user": false,
  "https://auth.rownd.io/is_anonymous": true,
};

const emailClaims = { email: "rownd@example.com", email_verified: true };
const phoneClaims = { phone_number: "+15551234567", phone_number_verified: true };
const profileClaims = {
  name: "Current Family",
  given_name: "Current",
  family_name: "Family",
  updated_at: "2026-01-01T00:00:00.000Z",
};

// Runs the installed SDK handler/API and plugin wrapper, not HTTP middleware,
// cryptographic verification or Core transport. SDK boundaries are spies.
describe.each([false, true])("OAuth userinfo scopes (mapped=%s)", (mapped) => {
  const internalId = "internal-owner";
  const externalId = "rownd-owner";
  const userId = mapped ? externalId : internalId;
  let records: Map<string, JsonRecord>;
  let events: string[];

  function user(): SuperTokensUser {
    return {
      id: userId,
      isPrimaryUser: true,
      timeJoined: 1,
      tenantIds: ["public"],
      emails: ["core@example.com"],
      phoneNumbers: ["+15557654321"],
      loginMethods: [{
        recipeUserId: SuperTokens.convertToRecipeUserId(internalId),
        recipeId: "passwordless",
        email: "core@example.com",
        phoneNumber: "+15557654321",
        tenantIds: ["public"],
        verified: true,
        timeJoined: 1,
        hasSameEmailAs: (email: string) => email === "core@example.com",
        hasSamePhoneNumberAs: (phone: string) => phone === "+15557654321",
      }],
    } as unknown as SuperTokensUser;
  }

  beforeEach(() => {
    events = [];
    records = new Map([[internalId, {
      first_name: "Current",
      rownd_profile_authoritative_fields: ["first_name"],
      original_rownd_user: {
        data: {
          user_id: externalId,
          email: "rownd@example.com",
          phone_number: "+15551234567",
          first_name: "Old",
          last_name: "Family",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
        verified_data: { email: "rownd@example.com", phone_number: true },
        auth_level: "verified",
      },
    }]]);
    vi.spyOn(SuperTokens, "getUser").mockImplementation(async () => {
      events.push("user");
      return user();
    });
    vi.spyOn(SuperTokens, "getUserIdMapping").mockImplementation(async (input) => {
      events.push("mapping");
      return mapped && input.userId === externalId && input.userIdType === "EXTERNAL"
        ? { status: "OK", superTokensUserId: internalId, externalUserId: externalId, externalUserIdInfo: undefined }
        : { status: "UNKNOWN_MAPPING_ERROR" };
    });
    vi.spyOn(UserMetadata, "getUserMetadata").mockImplementation(async (id) => {
      events.push(`metadata:${id}`);
      return { status: "OK", metadata: structuredClone(records.get(id) ?? {}) };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function harness(scopes: string[]) {
    const accessTokenPayload = {
      sub: userId, scp: scopes, ...tokenClaims,
      configured_secret: "not-a-userinfo-claim",
    };
    const resolveConfig = vi.fn(async (): Promise<RowndPluginDynamicConfig> => {
      events.push("config");
      return { schema: { first_name: { display_name: "First name", type: "string", user_visible: true, include_in_session_claims: true } } };
    });
    const callback = vi.fn(async (): Promise<JsonRecord> => {
      events.push("callback");
      return { custom: "original", app_user_id: "callback-app-user" };
    });
    const originalBuilder = vi.fn<Parameters<RecipeInterface["buildUserInfo"]>, ReturnType<RecipeInterface["buildUserInfo"]>>(
      async ({ user, accessTokenPayload, scopes, tenantId, userContext }) => {
        events.push("original");
        return OAuthRecipe.prototype.getDefaultUserInfoPayload.call(
          { userInfoBuilders: [callback] } as unknown as OAuthRecipe,
          user, accessTokenPayload, scopes, tenantId, userContext,
        );
      },
    );
    const plugin = init({
      disableRowndUserMigration: true, resolveConfig,
      schema: { first_name: { display_name: "First name", type: "string", user_visible: true, include_in_session_claims: true } },
    });
    const recipeImplementation = plugin.overrideMap!.oauth2provider!.functions!({
      buildUserInfo: originalBuilder,
      buildAccessTokenPayload: vi.fn().mockResolvedValue({}),
      buildIdTokenPayload: vi.fn().mockResolvedValue({}),
    } as unknown as RecipeInterface, {} as never);
    const validateToken = vi.fn(async () => {
      events.push("verify");
      return { payload: accessTokenPayload };
    });
    const getUser = vi.fn(async ({ userId, userContext }) =>
      SuperTokens.getUser(userId, userContext));
    const stInstance = {
      getRecipeInstanceOrThrow: vi.fn(() => ({ recipeInterfaceImpl: { getUser } })),
    } as unknown as Parameters<typeof userInfoGET>[0];
    const res = {
      setHeader: vi.fn(),
      setStatusCode: vi.fn(),
      sendJSONResponse: vi.fn(),
    };
    const userContext = { requestMarker: "retained" } as unknown as UserContext;
    const options = {
      req: { getHeaderValue: () => "Bearer test-token" },
      res,
      recipeImplementation: { ...recipeImplementation, validateOAuth2AccessToken: validateToken },
    } as unknown as Parameters<typeof userInfoGET>[3];
    return {
      run: () => userInfoGET(stInstance, getOAuthAPIImplementation(stInstance), "public", options, userContext),
      payload: () => res.sendJSONResponse.mock.calls[0]?.[0] as JsonRecord,
      accessTokenPayload, resolveConfig, callback, originalBuilder, recipeImplementation,
      validateToken, getUser, res, userContext,
    };
  }

  it.each([
    { scopes: [] },
    { scopes: ["openid"] },
    { scopes: ["custom:read"] },
    { scopes: ["email:read", "phone:read", "profile:read"] },
    { scopes: ["Email", "PHONE", "Profile"] },
    { scopes: [" email", "phone ", "profile email"] },
    { scopes: ["openid", "offline_access", "custom:profile"] },
  ])("skips unused compatibility reads for $scopes", async ({ scopes }) => {
    const h = harness(scopes);
    vi.mocked(UserMetadata.getUserMetadata).mockRejectedValue(new Error("unused metadata failure"));

    await expect(h.run()).resolves.toBe(true);

    expect(h.payload()).toEqual({ sub: userId, custom: "original", ...tokenClaims });
    expect(events).toEqual(["verify", "user", "config", "original", "callback"]);
    expect(h.validateToken).toHaveBeenCalledWith({ token: "test-token", userContext: h.userContext });
    expect(h.getUser).toHaveBeenCalledWith({ userId, userContext: h.userContext });
    expect(SuperTokens.getUser).toHaveBeenCalledTimes(1);
    expect(SuperTokens.getUserIdMapping).not.toHaveBeenCalled();
    expect(UserMetadata.getUserMetadata).not.toHaveBeenCalled();
    expect(h.resolveConfig).toHaveBeenCalledTimes(1);
    expect(h.resolveConfig).toHaveBeenCalledWith({ tenantId: "public", userContext: h.userContext });
    expect(h.originalBuilder).toHaveBeenCalledTimes(1);
    expect(h.originalBuilder.mock.calls[0]![0].userContext).not.toBe(h.userContext);
    expect(h.originalBuilder.mock.calls[0]![0].userContext.requestMarker).toBe("retained");
    expect(h.callback).toHaveBeenCalledTimes(1);
    expect(h.res.setStatusCode).toHaveBeenCalledWith(200);
  });

  it("keeps callback claims when a Rownd claim is absent from the token", async () => {
    const h = harness(["custom:read"]);
    delete (h.accessTokenPayload as JsonRecord).anonymous_id;
    const callbackClaims = {
      custom: "callback", email: "callback@example.com", name: "Callback name",
      phone_number: "+15550000000", anonymous_id: "callback-anonymous",
    };
    h.callback.mockResolvedValue(callbackClaims);
    await h.run();
    expect(h.payload()).toEqual({
      sub: userId, ...tokenClaims, ...callbackClaims,
    });
    expect(SuperTokens.getUserIdMapping).not.toHaveBeenCalled();
    expect(UserMetadata.getUserMetadata).not.toHaveBeenCalled();
  });

  it.each([
    { scopes: ["email"], claims: { ...emailClaims, emails: ["core@example.com"] } },
    { scopes: ["phone"], claims: phoneClaims },
    { scopes: ["profile"], claims: profileClaims },
    { scopes: ["custom:read", "profile", "email", "phone", "phone"],
      claims: { ...emailClaims, emails: ["core@example.com"], ...phoneClaims, ...profileClaims } },
  ])("keeps relevant-scope projections for $scopes", async ({ scopes, claims }) => {
    const h = harness(scopes);
    await h.run();

    expect(h.payload()).toEqual({ sub: userId, custom: "original", ...claims, ...tokenClaims });
    expect(events.slice(0, 5)).toEqual(["verify", "user", "config", "original", "callback"]);
    expect(SuperTokens.getUser).toHaveBeenCalledTimes(1);
    expect(SuperTokens.getUserIdMapping).toHaveBeenCalledTimes(2);
    expect(vi.mocked(UserMetadata.getUserMetadata).mock.calls.map(([id]) => id).sort())
      .toEqual(mapped ? [internalId, externalId].sort() : [internalId]);
  });

  it("keeps SDK legacy phoneNumber claims without Rownd metadata reads", async () => {
    const h = harness(["openid", "phoneNumber"]);
    await h.run();

    expect(h.payload()).toEqual({
      sub: userId, custom: "original", ...tokenClaims,
      phoneNumber: "+15557654321", phoneNumber_verified: true, phoneNumbers: ["+15557654321"],
    });
    expect(SuperTokens.getUserIdMapping).not.toHaveBeenCalled();
    expect(UserMetadata.getUserMetadata).not.toHaveBeenCalled();
  });

  it("keeps both legacy and standard phone claims when both scopes are requested", async () => {
    const h = harness(["phoneNumber", "phone"]);
    await h.run();
    expect(h.payload()).toEqual({
      sub: userId, custom: "original", ...tokenClaims, ...phoneClaims,
      phoneNumber: "+15557654321", phoneNumber_verified: true, phoneNumbers: ["+15557654321"],
    });
    expect(UserMetadata.getUserMetadata).toHaveBeenCalled();
  });

  it("uses mapped alias profile inputs while retaining primary field authority", async () => {
    records.set(internalId, { first_name: "Current", rownd_profile_authoritative_fields: ["first_name"] });
    records.set(mapped ? externalId : internalId, {
      ...records.get(internalId),
      original_rownd_user: { data: { user_id: externalId, first_name: "Alias", last_name: "Alias family" } },
    });
    const h = harness(["profile"]);
    await h.run();
    expect(h.payload()).toEqual({
      sub: userId, custom: "original", ...tokenClaims,
      name: "Current Alias family", given_name: "Current", family_name: "Alias family",
    });
  });

  it("preserves Core email/phone fallbacks and verification when Rownd data is absent", async () => {
    records.clear();
    const h = harness(["email", "phone", "profile"]);
    await h.run();
    expect(h.payload()).toEqual({
      sub: userId, custom: "original", ...tokenClaims,
      email: "core@example.com", email_verified: true, emails: ["core@example.com"],
      phone_number: "+15557654321", phone_number_verified: true,
    });
  });

  it("reads relevant profile data after the original callback has changed it", async () => {
    const h = harness(["profile"]);
    h.callback.mockImplementation(async () => {
      records.get(internalId)!.first_name = "After callback";
      return { custom: "original" };
    });
    await h.run();
    expect(h.payload()).toMatchObject({ given_name: "After callback", ...tokenClaims });
  });

  it("still rejects invalid tokens before user lookup or callbacks", async () => {
    const h = harness(["openid"]);
    h.validateToken.mockRejectedValue(new Error("invalid token"));
    await h.run();
    expect(h.res.setStatusCode).toHaveBeenCalledWith(401);
    expect(h.payload()).toEqual({ message: "Invalid or expired OAuth2 access token" });
    expect(h.getUser).not.toHaveBeenCalled();
    expect(h.resolveConfig).not.toHaveBeenCalled();
    expect(h.originalBuilder).not.toHaveBeenCalled();
    expect(UserMetadata.getUserMetadata).not.toHaveBeenCalled();
  });

  it("still rejects a missing current user before callbacks or metadata", async () => {
    vi.mocked(SuperTokens.getUser).mockResolvedValue(undefined);
    const h = harness(["openid"]);
    await h.run();
    expect(h.res.setStatusCode).toHaveBeenCalledWith(401);
    expect(h.payload()).toEqual({ message: "Couldn't find any user associated with the access token" });
    expect(h.validateToken).toHaveBeenCalledTimes(1);
    expect(h.getUser).toHaveBeenCalledTimes(1);
    expect(h.resolveConfig).not.toHaveBeenCalled();
    expect(h.originalBuilder).not.toHaveBeenCalled();
    expect(SuperTokens.getUserIdMapping).not.toHaveBeenCalled();
    expect(UserMetadata.getUserMetadata).not.toHaveBeenCalled();
  });

  it("preserves config callback failure for irrelevant scopes", async () => {
    const h = harness(["openid"]);
    const failure = new Error("config failed");
    h.resolveConfig.mockRejectedValue(failure);
    await expect(h.run()).rejects.toMatchObject({ name: "RowndConfigResolutionError", cause: failure });
    expect(h.originalBuilder).not.toHaveBeenCalled();
    expect(UserMetadata.getUserMetadata).not.toHaveBeenCalled();
  });

  it("preserves original userinfo callback failure for irrelevant scopes", async () => {
    const h = harness(["openid"]);
    const failure = new Error("userinfo callback failed");
    h.callback.mockRejectedValue(failure);
    await expect(h.run()).rejects.toBe(failure);
    expect(h.resolveConfig).toHaveBeenCalledTimes(1);
    expect(h.originalBuilder).toHaveBeenCalledTimes(1);
    expect(UserMetadata.getUserMetadata).not.toHaveBeenCalled();
  });

  it("still propagates relevant-scope metadata failure after callbacks", async () => {
    const h = harness(["profile"]);
    const failure = new Error("required metadata failed");
    vi.mocked(UserMetadata.getUserMetadata).mockRejectedValue(failure);
    await expect(h.run()).rejects.toBe(failure);
    expect(events.slice(0, 5)).toEqual(["verify", "user", "config", "original", "callback"]);
    expect(h.res.sendJSONResponse).not.toHaveBeenCalled();
  });

  it.each(["buildAccessTokenPayload", "buildIdTokenPayload"] as const)(
    "%s still reads fresh metadata without standard scopes", async (builder) => {
      const h = harness(["openid"]);
      const payload = await h.recipeImplementation[builder]({
        user: user(), client: {} as never, sessionHandle: "session", scopes: ["openid"], userContext: h.userContext,
      });
      expect(payload).toMatchObject({ app_user_id: externalId, first_name: "Current" });
      expect(UserMetadata.getUserMetadata).toHaveBeenCalled();
    },
  );
});

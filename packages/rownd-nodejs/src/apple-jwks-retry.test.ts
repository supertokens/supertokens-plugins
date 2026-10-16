import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TypeProvider } from "supertokens-node/recipe/thirdparty/types";
import { withAppleJwksRetry } from "./apple-jwks-retry";

const input = {
  tenantId: "public",
  oAuthTokens: { id_token: "token" },
  userContext: {},
};
const userInfo = {
  thirdPartyUserId: "apple-user",
  rawUserInfoFromProvider: {},
};
const unavailable = () =>
  Object.assign(
    new Error("Expected 200 OK from the JSON Web Key Set HTTP response"),
    {
      code: "ERR_JOSE_GENERIC",
    },
  );

function makeProvider(): Extract<TypeProvider, { type: "oauth2" }> {
  return {
    id: "apple",
    type: "oauth2",
    config: { thirdPartyId: "apple", clientId: "app" },
    getConfigForClientType: vi.fn(),
    getAuthorisationRedirectURL: vi.fn(),
    exchangeAuthCodeForOAuthTokens: vi.fn(),
    getUserInfo: vi.fn().mockResolvedValue(userInfo),
  };
}

describe("Apple JWKS retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries verification with the same tokens, preserving provider overrides and code exchange", async () => {
    const provider = makeProvider();
    const originalGetUserInfo = provider.getUserInfo;
    vi.mocked(provider.getUserInfo)
      .mockRejectedValueOnce(unavailable())
      .mockRejectedValueOnce(unavailable());
    const wrapped = withAppleJwksRetry(provider);
    if (wrapped.type !== "oauth2") throw new Error("Expected OAuth provider");
    expect(wrapped.exchangeAuthCodeForOAuthTokens).toBe(
      provider.exchangeAuthCodeForOAuthTokens,
    );
    const result = wrapped.getUserInfo(input);
    await vi.advanceTimersByTimeAsync(199);
    expect(provider.getUserInfo).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(provider.getUserInfo).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(600);
    await expect(result).resolves.toBe(userInfo);
    expect(provider.getUserInfo).toHaveBeenCalledTimes(3);
    for (const [actualInput] of vi.mocked(provider.getUserInfo).mock.calls)
      expect(actualInput).toBe(input);
    expect(provider.exchangeAuthCodeForOAuthTokens).not.toHaveBeenCalled();
    expect(provider.getUserInfo).toBe(originalGetUserInfo);
  });

  it("rethrows the last failure after three attempts", async () => {
    const provider = makeProvider();
    const error = unavailable();
    vi.mocked(provider.getUserInfo).mockRejectedValue(error);
    const result = expect(
      withAppleJwksRetry(provider).getUserInfo(input),
    ).rejects.toBe(error);
    await vi.runAllTimersAsync();
    await result;
    expect(provider.getUserInfo).toHaveBeenCalledTimes(3);
  });

  it.each([
    "ERR_JWT_EXPIRED",
    "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
    "ERR_JWKS_NO_MATCHING_KEY",
    "ERR_JWT_CLAIM_VALIDATION_FAILED",
    "ERR_JOSE_GENERIC",
  ])("does not retry %s validation errors", async (code) => {
    const provider = makeProvider();
    const error = Object.assign(new Error("invalid token"), { code });
    vi.mocked(provider.getUserInfo).mockRejectedValue(error);
    await expect(withAppleJwksRetry(provider).getUserInfo(input)).rejects.toBe(
      error,
    );
    expect(provider.getUserInfo).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync();
    expect(provider.getUserInfo).toHaveBeenCalledTimes(1);
  });

  it.each(["ERR_JWKS_TIMEOUT", "ECONNRESET", "EAI_AGAIN"])(
    "recovers from %s",
    async (code) => {
      const provider = makeProvider();
      vi.mocked(provider.getUserInfo).mockRejectedValueOnce(
        Object.assign(new Error("fetch failed"), { code }),
      );
      const result = withAppleJwksRetry(provider).getUserInfo(input);
      await vi.runAllTimersAsync();
      await expect(result).resolves.toBe(userInfo);
      expect(provider.getUserInfo).toHaveBeenCalledTimes(2);
    },
  );

  it("leaves other providers untouched and supports Apple implementation aliases", () => {
    const provider = makeProvider();
    provider.id = "google";
    expect(withAppleJwksRetry(provider)).toBe(provider);
    provider.config.thirdPartyImplementation = "apple";
    expect(withAppleJwksRetry(provider)).not.toBe(provider);
  });
});

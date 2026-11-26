import { afterEach, expect, it, vi } from "vitest";
import SuperTokens from "supertokens-node";
import Session from "supertokens-node/recipe/session";
import type { APIOptions } from "supertokens-node/recipe/emailverification";
import type { SessionContainerInterface } from "supertokens-node/recipe/session/types";
import { logDebugMessage } from "./logger";

vi.mock("./logger", () => ({ logDebugMessage: vi.fn() }));

afterEach(() => {
  vi.doUnmock("supertokens-node/lib/build/recipe/session/cookieAndHeaders");
  vi.resetModules();
  vi.clearAllMocks();
});

it("requires the tested SuperTokens SDK to export the session response cleanup internals", async () => {
  const { default: recipe } = await import("supertokens-node/lib/build/recipe/session/recipe");
  const { clearSessionFromAllTokenTransferMethods } = await import(
    "supertokens-node/lib/build/recipe/session/cookieAndHeaders"
  );

  expect(recipe.getInstanceOrThrowError).toBeTypeOf("function");
  expect(clearSessionFromAllTokenTransferMethods).toBeTypeOf("function");
});

it("uses the configured cookie and header names even without a session", async () => {
  SuperTokens.init({
    appInfo: {
      appName: "Rownd test",
      apiDomain: "https://api.example.com",
      websiteDomain: "https://app.example.com",
    },
    recipeList: [
      Session.init({
        cookieDomain: ".example.com",
        cookieSameSite: "lax",
        cookieSecure: true,
        getCookieNameForTokenType: (_req, tokenType) => `app-${tokenType}`,
        getResponseHeaderNameForTokenType: (_req, tokenType) => `app-${tokenType}-header`,
      }),
    ],
  });
  const { clearClientSession } = await import("./email-change-session-recovery");
  const setCookie = vi.fn();
  const setHeader = vi.fn();
  await clearClientSession(
    {} as APIOptions["req"],
    { setCookie, setHeader, removeHeader: vi.fn() } as unknown as APIOptions["res"],
    {},
    undefined,
  );

  expect(setCookie).toHaveBeenCalledWith("app-access", "", ".example.com", true, true, 0, "/", "lax");
  expect(setCookie).toHaveBeenCalledWith(
    "app-refresh", "", ".example.com", true, true, 0, "/auth/session/refresh", "lax",
  );
  expect(setHeader).toHaveBeenCalledWith("app-access-header", "", false);
  expect(setHeader).toHaveBeenCalledWith("app-refresh-header", "", false);
  expect(setHeader).toHaveBeenCalledWith("front-token", "remove", false);
  expect(logDebugMessage).not.toHaveBeenCalled();
});

it.each([true, false])(
  "signals removal when the internal cleanup module is missing (session present: %s)",
  async (withSession) => {
    vi.doMock("supertokens-node/lib/build/recipe/session/cookieAndHeaders", () => {
      throw new Error("Cannot find module");
    });
    const { clearClientSession } = await import("./email-change-session-recovery");
    const revokeSession = vi.fn().mockRejectedValue(new Error("Core unavailable"));
    const setHeader = vi.fn();
    const userContext = {};
    await clearClientSession(
      {} as APIOptions["req"],
      { setHeader } as unknown as APIOptions["res"],
      userContext,
      withSession ? ({ revokeSession } as unknown as SessionContainerInterface) : undefined,
    );

    expect(revokeSession).toHaveBeenCalledTimes(withSession ? 1 : 0);
    if (withSession) expect(revokeSession).toHaveBeenCalledWith(userContext);
    expect(setHeader).toHaveBeenCalledWith("front-token", "remove", false);
    expect(setHeader).toHaveBeenCalledWith("Access-Control-Expose-Headers", "front-token", true);
    expect(logDebugMessage).toHaveBeenCalledWith(expect.stringContaining("fallback"));
  },
);

import Passwordless from "supertokens-node/recipe/passwordless";
import { afterEach, describe, expect, it, vi } from "vitest";

import { compactMagicLinkParams } from "./compact-magic-link";
import { getPluginConfig, resolvePluginConfigSnapshot } from "./config";
import { init } from "./plugin";
import { createMagicLinkWithConfirmationBypass } from "./supertokens-repository";
import type { RowndPluginConfig } from "./types";

const website = "https://hub.example.com";
const mobile = "https://mobile.example.com";
const clientDomains = { mobile };

function makePlugin(config: Partial<RowndPluginConfig>) {
  const plugin = init({
    rowndAppKey: "test-key",
    rowndAppSecret: "test-secret",
    disableRowndUserMigration: true,
    ...config,
  }) as any;
  plugin.routeHandlers({
    appInfo: {
      apiDomain: { getAsStringDangerous: () => "https://api.example.com" },
      apiBasePath: { getAsStringDangerous: () => "/auth" },
      websiteBasePath: { getAsStringDangerous: () => "/auth" },
      getOrigin: () => ({ getAsStringDangerous: () => website }),
    },
  });
  return plugin;
}

describe("compact magic links", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([undefined, false])("preserves legacy email and SMS URLs with the flag set to %s", async (compactMagicLinks) => {
    const plugin = makePlugin({ clientDomains, compactMagicLinks });
    const config = plugin.overrideMap.passwordless.config({});
    const sendEmail = vi.fn();
    const sendSms = vi.fn();
    const input = {
      urlWithLinkCode: `${website}/auth/verify?preAuthSessionId=pid&tenantId=public#code`,
      userInputCode: "123456",
      userContext: {
        rowndAppVariantId: "variant",
        rowndDisplayContext: "mobile_app",
        rowndClientDomain: "mobile",
        rowndRedirectToPath: "/profile",
        rowndOAuthLoginChallenge: "challenge",
        rowndAuthIntent: "sign_in",
        rowndReauthenticate: true,
      },
    };
    await config.emailDelivery.override({ sendEmail }).sendEmail(input);
    await config.smsDelivery.override({ sendSms }).sendSms(input);

    const legacy = `${mobile}/account/login?preAuthSessionId=pid&tenantId=public&appKey=test-key&apiDomain=https%3A%2F%2Fapi.example.com&apiBasePath=%2Fauth&passwordlessFlowType=USER_INPUT_CODE_AND_MAGIC_LINK&appVariantId=variant&displayContext=mobile_app&redirectToPath=%2Fprofile&oauthLoginChallenge=challenge&rowndAuthIntent=sign_in&rowndReauthenticate=true#code`;
    expect(sendEmail).toHaveBeenCalledWith({ ...input, urlWithLinkCode: legacy });
    expect(sendSms).toHaveBeenCalledWith({ ...input, urlWithLinkCode: legacy });
  });

  it("compacts email magic links using tenant-resolved configuration", async () => {
    const plugin = makePlugin({
      resolveConfig: async ({ tenantId }) => ({ clientDomains, compactMagicLinks: tenantId === "public" }),
    });
    const sendEmail = vi.fn();
    const delivery = plugin.overrideMap.passwordless.config({}).emailDelivery.override({ sendEmail });
    const { userContext } = await resolvePluginConfigSnapshot(getPluginConfig()!, {
      tenantId: "public",
      userContext: {
        rowndAppVariantId: "variant",
        rowndDisplayContext: "customer_web_view",
        rowndClientDomain: "mobile",
        rowndRedirectToPath: "/profile?tab=security",
        rowndOAuthLoginChallenge: "challenge",
        rowndAuthIntent: "sign_up",
        rowndReauthenticate: true,
      },
    });
    const input = {
      urlWithLinkCode: `${website}/auth/verify?preAuthSessionId=pid&tenantId=public#code`,
      userInputCode: "123456",
      userContext,
    };
    await delivery.sendEmail(input);

    expect(sendEmail).toHaveBeenCalledWith({
      ...input,
      urlWithLinkCode: `${mobile}/account/login?preAuthSessionId=pid&v=variant&d=w&c=mobile&r=%2Fprofile%3Ftab%3Dsecurity&o=challenge&f=cl&i=u&ra=1#code`,
    });
  });

  it("compacts SMS magic links, keeping a non-public tenant and a relative link's hash", async () => {
    const plugin = makePlugin({ compactMagicLinks: true });
    const sendSms = vi.fn();
    const delivery = plugin.overrideMap.passwordless.config({}).smsDelivery.override({ sendSms });
    const input = {
      urlWithLinkCode: "/auth/verify?preAuthSessionId=pid&tenantId=customer&displayContext=browser#code%2B?tail",
      userContext: { rowndDisplayContext: "mobile_app", rowndAuthIntent: "sign_in" },
    };
    await delivery.sendSms(input);

    expect(sendSms).toHaveBeenCalledWith({
      ...input,
      urlWithLinkCode: "/account/login?preAuthSessionId=pid&tenantId=customer&d=m&i=i#code%2B?tail",
    });
  });

  it.each([
    [false, `${mobile}/account/login?preAuthSessionId=pid&tenantId=public&appKey=test-key&apiDomain=https%3A%2F%2Fapi.example.com&apiBasePath=%2Fauth&displayContext=browser&redirectToPath=%2Fprofile&clientDomain=mobile&oauthLoginChallenge=challenge&bypassDeviceConfirmation=true#code`],
    [true, `${mobile}/account/login?preAuthSessionId=pid&c=mobile&r=%2Fprofile&o=challenge&bd=1#code`],
  ])("rewrites confirmation-bypass links with the resolved flag set to %s", async (compactMagicLinks, expected) => {
    makePlugin({
      compactMagicLinks: !compactMagicLinks,
      resolveConfig: async () => ({
        clientDomains,
        compactMagicLinks,
        crossDeviceConfirmationBypass: { allowedRedirectPaths: ["/profile"] },
      }),
    });
    vi.spyOn(Passwordless, "createCode").mockResolvedValue({
      status: "OK",
      preAuthSessionId: "pid",
      linkCode: "code",
      deviceId: "device",
      userInputCode: "123456",
      codeLifetime: 1000,
      codeId: "code-id",
    });
    const link = await createMagicLinkWithConfirmationBypass({
      phoneNumber: "+12025550123",
      clientDomain: "mobile",
      displayContext: "browser",
      redirectToPath: "/profile",
      userContext: { rowndOAuthLoginChallenge: "challenge" },
    });

    expect(link).toBe(expected);
  });

  it("leaves email verification links unchanged with compact magic links enabled", async () => {
    const plugin = makePlugin({ clientDomains, compactMagicLinks: true });
    const sendEmail = vi.fn();
    const delivery = plugin.overrideMap.emailverification.config({}).emailDelivery.override({ sendEmail });
    const input = {
      emailVerifyLink: `${website}/auth/verify-email?token=token&tenantId=public`,
      userContext: { rowndDisplayContext: "mobile_app" },
    };
    await delivery.sendEmail(input);

    expect(sendEmail).toHaveBeenCalledWith({
      ...input,
      emailVerifyLink: `${mobile}/account/verify-email?token=token&tenantId=public&appKey=test-key&apiDomain=https%3A%2F%2Fapi.example.com&apiBasePath=%2Fauth&displayContext=mobile_app`,
    });
  });

  it.each([
    ["USER_INPUT_CODE", "c"],
    ["MAGIC_LINK", "l"],
    ["USER_INPUT_CODE_AND_MAGIC_LINK", "cl"],
  ])("encodes passwordless flow %s without retaining a conflicting alias", (flowType, alias) => {
    const params = new URLSearchParams({ passwordlessFlowType: flowType, f: "old" });
    compactMagicLinkParams(params);
    expect(params.toString()).toBe(`f=${alias}`);
  });
});

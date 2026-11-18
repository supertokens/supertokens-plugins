import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SuperTokens from "supertokens-node";
import { init } from "./plugin";
import { resolvePluginConfigSnapshot, validateDynamicConfig } from "./config";
import { handleConnectedSignInMethods, handleGetAppConfig } from "./pluginImplementation";
import { getUserContext } from "supertokens-node/lib/build/utils";

beforeEach(() => { vi.spyOn(SuperTokens, "isRecipeInitialized").mockReturnValue(true); });
afterEach(() => { vi.restoreAllMocks(); });

describe("connected sign-in methods opt-in", () => {
  it("defaults to off and supports explicit static opt-in", () => {
    expect(() => init({ disableRowndUserMigration: true })).not.toThrow();
    expect(() => init({ disableRowndUserMigration: true, connectedSignInMethods: { enabled: true } })).not.toThrow();
  });

  it.each([null, true, {}, { enabled: "true" }, { enabled: null }])("rejects malformed setting %j", (value) => {
    expect(() => validateDynamicConfig({ connectedSignInMethods: value } as any)).toThrow();
  });

  it("allows a dynamic tenant setting to disable a static opt-in", async () => {
    const config: any = { connectedSignInMethods: { enabled: true }, emailChange: { maxSessionAgeSeconds: 600 },
      resolveConfig: async () => ({ connectedSignInMethods: { enabled: false } }) };
    const resolved = await resolvePluginConfigSnapshot(config, { tenantId: "public", userContext: {} });
    expect(resolved.config.connectedSignInMethods).toEqual({ enabled: false });
  });

  it("inherits static opt-in when dynamic config omits it", async () => {
    const config: any = { connectedSignInMethods: { enabled: true }, emailChange: { maxSessionAgeSeconds: 600 }, resolveConfig: async () => ({}) };
    const resolved = await resolvePluginConfigSnapshot(config, { tenantId: "public", userContext: {} });
    expect(resolved.config.connectedSignInMethods).toEqual({ enabled: true });
    expect((await resolvePluginConfigSnapshot({ emailChange: { maxSessionAgeSeconds: 600 } } as any,
      { tenantId: "public", userContext: {} })).config.connectedSignInMethods).toEqual({ enabled: false });
  });

  it.each([false, true])("never caches app config when connected methods enabled=%s", async (enabled) => {
    const response = { setHeader: vi.fn() };
    const config: any = { connectedSignInMethods: { enabled }, emailChange: { maxSessionAgeSeconds: 600 },
      appConfig: { capabilities: { connected_sign_in_methods: { version: 99 } } } };
    const result = await handleGetAppConfig({ pluginConfig: config, stConfig: { appInfo: { appName: "test" } }, telemetryClient: {} } as any)(
      { getKeyValueFromQuery: () => undefined } as any, response as any, undefined, getUserContext({}));
    expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store", false);
    if (enabled) expect(result).toHaveProperty("plugin_capabilities.connected_sign_in_methods.version", 1);
    else expect(result).not.toHaveProperty("plugin_capabilities");
  });

  it("marks disabled management responses no-store too", async () => {
    const response = { setHeader: vi.fn() };
    const result = await handleConnectedSignInMethods({ pluginConfig: { connectedSignInMethods: { enabled: false } } } as any)(
      { getKeyValueFromQuery: () => undefined } as any, response as any, { getTenantId: () => "public" } as any, getUserContext({}));
    expect(result).toMatchObject({ status: "ERROR", code: 404 });
    expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store", false);
  });

  it.each(["session", "usermetadata", "passwordless", "accountlinking", "multitenancy"])("omits capability and returns 404 when %s is missing", async (missing) => {
    vi.mocked(SuperTokens.isRecipeInitialized).mockImplementation((recipe) => recipe !== missing);
    const response = { setHeader: vi.fn() };
    const deps: any = { pluginConfig: { connectedSignInMethods: { enabled: true } }, stConfig: { appInfo: { appName: "test" } } };
    const req: any = { getKeyValueFromQuery: () => undefined };
    const context = getUserContext({});
    expect(await handleGetAppConfig(deps)(req, response as any, undefined, context)).not.toHaveProperty("plugin_capabilities");
    expect(await handleConnectedSignInMethods(deps)(req, response as any, { getTenantId: () => "public" } as any, context))
      .toMatchObject({ status: "ERROR", code: 404, error_code: "SIGN_IN_METHODS_UNAVAILABLE" });
  });
});

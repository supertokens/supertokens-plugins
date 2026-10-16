import { afterEach, expect, it, vi } from "vitest";
import ThirdParty from "supertokens-node/recipe/thirdparty";
import Session from "supertokens-node/recipe/session";
import { handleGuestLogin } from "./pluginImplementation";
import type { RowndPluginNormalisedConfig, RowndSignInMethod } from "./types";

vi.mock("./supertokens-repository", async (importOriginal) => ({
  ...await importOriginal<typeof import("./supertokens-repository")>(),
  recordRowndAppVariantForUser: vi.fn(),
}));

afterEach(() => vi.restoreAllMocks());

const cases: {
  name: string;
  methods?: RowndSignInMethod[];
  variantMethods?: RowndSignInMethod[];
  variant?: boolean;
  authLevel?: "guest" | "instant";
  allowed: boolean;
}[] = [
  { name: "missing methods reject default guest", allowed: false },
  { name: "missing methods reject instant", authLevel: "instant", allowed: false },
  { name: "other methods reject guest", methods: [{ method: "email" }], allowed: false },
  { name: "anonymous defaults to guest", methods: [{ method: "anonymous" }], allowed: true },
  { name: "explicit guest permits guest", methods: [{ method: "anonymous", type: "guest" }], authLevel: "guest", allowed: true },
  { name: "guest rejects instant", methods: [{ method: "anonymous" }], authLevel: "instant", allowed: false },
  { name: "instant rejects default guest", methods: [{ method: "anonymous", type: "instant" }], allowed: false },
  { name: "instant permits instant", methods: [{ method: "anonymous", type: "instant" }], authLevel: "instant", allowed: true },
  { name: "variant inherits methods", methods: [{ method: "anonymous" }], variant: true, allowed: true },
  { name: "empty variant methods disable guest", methods: [{ method: "anonymous" }], variantMethods: [], variant: true, allowed: false },
  { name: "variant enables instant", variantMethods: [{ method: "anonymous", type: "instant" }], variant: true, authLevel: "instant", allowed: true },
  { name: "variant mode overrides base", methods: [{ method: "anonymous" }], variantMethods: [{ method: "anonymous", type: "instant" }], variant: true, allowed: false },
];

it.each(cases.flatMap((testCase) => [
  { ...testCase, dynamic: false },
  { ...testCase, dynamic: true },
]))("$name (dynamic: $dynamic)", async ({ methods, variantMethods, variant, authLevel, allowed, dynamic }) => {
  const createUser = vi.spyOn(ThirdParty, "manuallyCreateOrUpdateUser").mockResolvedValue({
    status: "OK",
    createdNewRecipeUser: true,
    recipeUserId: { getAsString: () => "recipe-user" },
    user: { id: "user" },
  } as Awaited<ReturnType<typeof ThirdParty.manuallyCreateOrUpdateUser>>);
  const createSession = vi.spyOn(Session, "createNewSession").mockResolvedValue(
    {} as Awaited<ReturnType<typeof Session.createNewSession>>,
  );
  const config: RowndPluginNormalisedConfig = {
    rowndAppKey: "test-key",
    rowndAppSecret: "test-secret",
    appConfig: { signInMethods: methods },
    ...(variant ? { subBrands: { variant: { signInMethods: variantMethods } } } : {}),
  };
  const resolveConfig = vi.fn(async () => ({
    appConfig: config.appConfig,
    subBrands: config.subBrands,
  }));
  const handler = handleGuestLogin({
    pluginConfig: dynamic ? {
      rowndAppKey: config.rowndAppKey,
      rowndAppSecret: config.rowndAppSecret,
      resolveConfig,
    } : config,
    stConfig: {} as Parameters<typeof handleGuestLogin>[0]["stConfig"],
    telemetryClient: { recordSuccess: vi.fn(), recordError: vi.fn() },
  });
  const request = {
    getKeyValueFromQuery: (key: string) => key === "tenantId" ? "tenant-a" : key === "app_variant_id" && variant ? "variant" : undefined,
    getJSONBody: async () => ({ auth_level: authLevel }),
  } as Parameters<typeof handler>[0];
  const result = await handler(request, {} as Parameters<typeof handler>[1], undefined, {});

  expect(result.status).toBe(allowed ? "OK" : "ERROR");
  expect(createUser).toHaveBeenCalledTimes(allowed ? 1 : 0);
  expect(createSession).toHaveBeenCalledTimes(allowed ? 1 : 0);
  if (dynamic) {
    expect(resolveConfig).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "tenant-a" }));
  }
  if (!allowed) {
    expect(result).toMatchObject({ message: expect.stringContaining("sign-in is not enabled") });
  }
});

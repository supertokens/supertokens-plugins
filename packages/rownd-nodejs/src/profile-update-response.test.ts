import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SuperTokens from "supertokens-node";
import { resolvePluginConfigSnapshot } from "./config";
import { RowndConfigResolutionError, RowndEmailChangeError } from "./errors";
import { handleUpdateUser } from "./pluginImplementation";
import { getUserById, startPendingEmailVerification, updateUserData } from "./supertokens-repository";
import type { RowndPluginNormalisedConfig } from "./types";

vi.mock("./supertokens-repository", async (importOriginal) => ({
  ...await importOriginal<typeof import("./supertokens-repository")>(),
  getUserById: vi.fn(),
  startPendingEmailVerification: vi.fn(),
  updateUserData: vi.fn(),
}));

type Handler = ReturnType<typeof handleUpdateUser>;
type Profile = Awaited<ReturnType<typeof getUserById>>;

function profile(userId: string): Profile {
  return {
    rownd_user: `rownd-${userId}`,
    data: { user_id: userId, email: "before@example.com", first_name: userId },
    state: "enabled",
    auth_level: "verified",
    meta: { last_sign_in: null, last_active: null, last_sign_in_method: null },
    verified_data: {},
    redacted: [],
    groups: [],
  };
}

function setup(config: Partial<RowndPluginNormalisedConfig> = {}) {
  const pluginConfig: RowndPluginNormalisedConfig = {
    rowndAppKey: "test-key",
    rowndAppSecret: "test-secret",
    disableRowndUserMigration: false,
    appConfig: { signInMethods: [{ method: "email" }] },
    emailChange: { maxSessionAgeSeconds: null },
    ...config,
  };
  const handler = handleUpdateUser({
    pluginConfig,
    stConfig: {} as Parameters<typeof handleUpdateUser>[0]["stConfig"],
    telemetryClient: { recordEvent: vi.fn(), recordSuccess: vi.fn(), recordError: vi.fn() },
  });
  const recipeUserId = SuperTokens.convertToRecipeUserId("recipe-owner");
  const session = {
    getUserId: vi.fn(() => "session-owner"),
    getTenantId: vi.fn(() => "tenant-a"),
    getRecipeUserId: vi.fn(() => recipeUserId),
    getHandle: vi.fn(() => "session-handle"),
    getTimeCreated: vi.fn(async () => Date.now()),
  };
  const userContext = { caller: "preserved" } as unknown as Parameters<Handler>[3];
  const request = (body: unknown, variant?: string) => ({
    getJSONBody: async () => body,
    getKeyValueFromQuery: (key: string) => key === "app_variant_id" ? variant : undefined,
    getHeaderValue: () => undefined,
  }) as unknown as Parameters<Handler>[0];
  const invoke = (body: unknown, variant?: string) => handler(
    request(body, variant),
    {} as Parameters<Handler>[1],
    session as unknown as Parameters<Handler>[2],
    userContext,
  );
  return { invoke, session, recipeUserId, userContext, pluginConfig };
}

describe("profile update response ownership", () => {
  let current: Profile;
  let updated: Profile;
  let pending: Profile;

  beforeEach(() => {
    vi.resetAllMocks();
    current = profile("current-profile-owner");
    updated = profile("updated-profile-owner");
    pending = profile("pending-profile-owner");
    vi.mocked(getUserById).mockResolvedValue(current);
    vi.mocked(updateUserData).mockResolvedValue(updated);
    vi.mocked(startPendingEmailVerification).mockResolvedValue(pending);
    vi.spyOn(SuperTokens, "isRecipeInitialized").mockReturnValue(true);
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it.each([{}, { data: {} }])("reads once without writing for empty input %j", async (body) => {
    const { invoke } = setup();
    const result = await invoke(body);
    expect(result).toEqual({ status: "OK", ...current });
    if (result.status !== "OK") throw new Error("Expected successful profile update");
    expect(result.data).toBe(current.data);
    expect(result.meta).toBe(current.meta);
    expect(getUserById).toHaveBeenCalledTimes(1);
    expect(getUserById).toHaveBeenCalledWith("session-owner", "tenant-a", expect.anything());
    expect(updateUserData).not.toHaveBeenCalled();
    expect(startPendingEmailVerification).not.toHaveBeenCalled();
  });

  it.each(["After", null, {}])("returns the mutation profile without another read for %j", async (value) => {
    const { invoke } = setup();
    const result = await invoke({ data: { first_name: value } });
    expect(result).toEqual({ status: "OK", ...updated });
    if (result.status !== "OK") throw new Error("Expected successful profile update");
    expect(result.data).toBe(updated.data);
    expect(result.meta).toBe(updated.meta);
    expect(result.meta).toEqual({ last_sign_in: null, last_active: null, last_sign_in_method: null });
    expect(updateUserData).toHaveBeenCalledTimes(1);
    expect(updateUserData).toHaveBeenCalledWith("session-owner", { first_name: value }, "tenant-a", expect.anything(), {
      preserveResponseSelector: true,
    });
    expect(getUserById).not.toHaveBeenCalled();
    expect(startPendingEmailVerification).not.toHaveBeenCalled();
  });

  it("passes one resolved config snapshot and derived context to the mutation", async () => {
    const dynamic = {
      schema: { custom: { display_name: "Custom", type: "string", user_visible: true, owned_by: "user" } },
      subBrands: { variant: { variant: { id: "variant" } } },
    };
    const resolveConfig = vi.fn(async () => dynamic);
    const { invoke, userContext, pluginConfig } = setup({ schema: {}, resolveConfig });
    await invoke({ data: { custom: null }, context: { rowndDisplayContext: "browser" } }, "variant");
    expect(resolveConfig).toHaveBeenCalledTimes(1);
    expect(resolveConfig).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "tenant-a", userContext }));
    const context = vi.mocked(updateUserData).mock.calls[0]![3]!;
    expect(context).toMatchObject({ caller: "preserved", rowndAppVariantId: "variant", rowndDisplayContext: "browser" });
    const snapshot = await resolvePluginConfigSnapshot(pluginConfig, {
      tenantId: "tenant-a", userContext: context,
    });
    expect(snapshot.config.schema).toEqual(dynamic.schema);
    expect(snapshot.config.subBrands).toEqual(dynamic.subBrands);
    expect(resolveConfig).toHaveBeenCalledTimes(1);
    expect(userContext).toEqual({ caller: "preserved" });
    expect(getUserById).not.toHaveBeenCalled();
  });

  it.each([false, true])("preserves email-first ordering (mixed: %s)", async (mixed) => {
    const { invoke, recipeUserId } = setup();
    const result = await invoke({ data: { email: "after@example.com", ...(mixed ? { first_name: "After" } : {}) } });
    const expected = mixed ? updated : pending;
    expect(result).toEqual({ status: "OK", ...expected, email_verification_pending: true });
    if (result.status !== "OK") throw new Error("Expected successful profile update");
    expect(result.data).toBe(expected.data);
    expect(result.meta).toBe(expected.meta);
    expect(getUserById).toHaveBeenCalledTimes(1);
    expect(startPendingEmailVerification).toHaveBeenCalledTimes(1);
    expect(startPendingEmailVerification).toHaveBeenCalledWith(expect.objectContaining({
      userId: "session-owner", tenantId: "tenant-a", recipeUserId,
      initiatingSessionHandle: "session-handle", email: "after@example.com",
      pendingVerificationId: expect.any(String),
    }));
    const readOrder = vi.mocked(getUserById).mock.invocationCallOrder[0]!;
    const emailOrder = vi.mocked(startPendingEmailVerification).mock.invocationCallOrder[0]!;
    expect(readOrder).toBeLessThan(emailOrder);
    expect(updateUserData).toHaveBeenCalledTimes(mixed ? 1 : 0);
    if (mixed) {
      expect(updateUserData).toHaveBeenCalledWith("session-owner", { first_name: "After" }, "tenant-a", expect.anything());
      expect(emailOrder).toBeLessThan(vi.mocked(updateUserData).mock.invocationCallOrder[0]!);
      expect(vi.mocked(updateUserData).mock.calls[0]![3]).toBe(vi.mocked(startPendingEmailVerification).mock.calls[0]![0].userContext);
    }
  });

  it("keeps unchanged email handling without changed-email session checks", async () => {
    vi.mocked(SuperTokens.isRecipeInitialized).mockReturnValue(false);
    const { invoke } = setup({ appConfig: { signInMethods: [] } });
    const result = await invoke({ data: { email: " BEFORE@EXAMPLE.COM " } });
    expect(result).toEqual({ status: "OK", ...pending, email_verification_pending: false });
    expect(startPendingEmailVerification).toHaveBeenCalledTimes(1);
    expect(getUserById).toHaveBeenCalledTimes(1);
    expect(updateUserData).not.toHaveBeenCalled();
  });

  it("rejects fields using resolved permissions before any read or write", async () => {
    const { invoke } = setup({ resolveConfig: async () => ({ schema: { first_name: { display_name: "First name", type: "string", user_visible: true, read_only: true } } }) });
    expect(await invoke({ data: { first_name: "After" } })).toEqual({ status: "ERROR", code: 403, message: "field is not writable: first_name" });
    expect(getUserById).not.toHaveBeenCalled();
    expect(updateUserData).not.toHaveBeenCalled();
    expect(startPendingEmailVerification).not.toHaveBeenCalled();
  });

  it("propagates config resolution failure without repository work", async () => {
    const { invoke } = setup({ resolveConfig: async () => { throw new Error("config unavailable"); } });
    await expect(invoke({ data: { first_name: "After" } })).rejects.toBeInstanceOf(RowndConfigResolutionError);
    expect(getUserById).not.toHaveBeenCalled();
    expect(updateUserData).not.toHaveBeenCalled();
  });

  it.each([null, "", " ", 42])("keeps invalid-email errors for %j", async (email) => {
    const { invoke } = setup();
    expect(await invoke({ data: { email, first_name: "After" } })).toEqual({ status: "ERROR", code: 400, message: "email must be a non-empty string" });
    expect(getUserById).not.toHaveBeenCalled();
    expect(updateUserData).not.toHaveBeenCalled();
    expect(startPendingEmailVerification).not.toHaveBeenCalled();
  });

  it("honors resolved email configuration before either mixed mutation", async () => {
    const { invoke } = setup({ resolveConfig: async () => ({ appConfig: { signInMethods: [] } }) });
    expect(await invoke({ data: { email: "after@example.com", first_name: "After" } })).toEqual({ status: "ERROR", code: 403, message: "email sign-in is not enabled" });
    expect(getUserById).toHaveBeenCalledTimes(1);
    expect(startPendingEmailVerification).not.toHaveBeenCalled();
    expect(updateUserData).not.toHaveBeenCalled();
  });

  it.each([false, true])("does not write custom fields after email failure (typed: %s)", async (typed) => {
    const error = typed ? new RowndEmailChangeError("CONFLICT", 409, "email conflict") : new Error("delivery failed");
    vi.mocked(startPendingEmailVerification).mockRejectedValue(error);
    const { invoke } = setup();
    const result = invoke({ data: { email: "after@example.com", first_name: "After" } });
    if (typed) {
      expect(await result).toEqual({ status: "ERROR", code: 409, message: "email conflict" });
    } else {
      await expect(result).rejects.toBe(error);
    }
    expect(getUserById).toHaveBeenCalledTimes(1);
    expect(updateUserData).not.toHaveBeenCalled();
  });

  it("preserves typed mixed-patch errors after successful email initiation", async () => {
    vi.mocked(updateUserData).mockRejectedValue(new RowndEmailChangeError("AMBIGUOUS", 409, "ambiguous owner"));
    const { invoke } = setup();
    expect(await invoke({ data: { email: "after@example.com", first_name: "After" } })).toEqual({ status: "ERROR", code: 409, message: "ambiguous owner" });
    expect(startPendingEmailVerification).toHaveBeenCalledTimes(1);
    expect(getUserById).toHaveBeenCalledTimes(1);
  });

  it("propagates non-email mutation failure without a response read", async () => {
    const error = new Error("write failed");
    vi.mocked(updateUserData).mockRejectedValue(error);
    const { invoke } = setup();
    await expect(invoke({ data: { first_name: "After" } })).rejects.toBe(error);
    expect(updateUserData).toHaveBeenCalledTimes(1);
    expect(getUserById).not.toHaveBeenCalled();
  });

  it.each([{}, { data: { email: "after@example.com", first_name: "After" } }])("propagates profile read failure before mutation for %j", async (body) => {
    const error = new Error("user disappeared");
    vi.mocked(getUserById).mockRejectedValue(error);
    const { invoke } = setup();
    await expect(invoke(body)).rejects.toBe(error);
    expect(getUserById).toHaveBeenCalledTimes(1);
    expect(updateUserData).not.toHaveBeenCalled();
    expect(startPendingEmailVerification).not.toHaveBeenCalled();
  });
});

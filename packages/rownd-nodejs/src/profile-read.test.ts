import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SuperTokens from "supertokens-node";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import Session from "supertokens-node/recipe/session";
import { getUserById, assembleUserProfile } from "./supertokens-repository";
import type { RowndTelemetryEvent } from "./types";

describe("profile read budgets and activity contracts", () => {
  const recipeUserId = SuperTokens.convertToRecipeUserId("owner");
  const user = {
    id: "owner", isPrimaryUser: false, timeJoined: 1000, tenantIds: ["public", "other"],
    emails: ["owner@example.com"], phoneNumbers: [],
    loginMethods: [{ recipeUserId, recipeId: "passwordless", email: "owner@example.com",
      verified: true, timeJoined: 1000, tenantIds: ["public", "other"] }],
  } as NonNullable<Awaited<ReturnType<typeof SuperTokens.getUser>>>;
  let events: RowndTelemetryEvent[];
  const recordEvent = (event: RowndTelemetryEvent) => { events.push(event); };
  const info = (timeCreated: number) => ({ recipeUserId, timeCreated }) as NonNullable<Awaited<ReturnType<typeof Session.getSessionInformation>>>;
  const expectCountsMatchSdk = (event: RowndTelemetryEvent) => expect(event.sdkCalls).toEqual({
    user: vi.mocked(SuperTokens.getUser).mock.calls.length,
    mapping: vi.mocked(SuperTokens.getUserIdMapping).mock.calls.length,
    metadata: vi.mocked(UserMetadata.getUserMetadata).mock.calls.length,
    sessionList: vi.mocked(Session.getAllSessionHandlesForUser).mock.calls.length,
    sessionDetail: vi.mocked(Session.getSessionInformation).mock.calls.length,
  });

  beforeEach(() => {
    events = [];
    vi.spyOn(SuperTokens, "getUser").mockResolvedValue(user);
    vi.spyOn(SuperTokens, "getUserIdMapping").mockResolvedValue({ status: "UNKNOWN_MAPPING_ERROR" });
    vi.spyOn(UserMetadata, "getUserMetadata").mockResolvedValue({ status: "OK", metadata: { first_name: "Example" } });
    vi.spyOn(Session, "getAllSessionHandlesForUser").mockResolvedValue([]);
    vi.spyOn(Session, "getSessionInformation").mockResolvedValue(info(2000));
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([1, 5, 20])("retains the legacy 5 + N budget with %s sessions", async (count) => {
    vi.mocked(Session.getAllSessionHandlesForUser).mockResolvedValue(Array.from({ length: count }, (_, i) => String(i)));
    const profile = await getUserById("owner", "public", {}, { recordEvent });
    expect(profile.meta.last_active).toBe(new Date(2000).toISOString());
    expect(events[0]?.sdkCalls).toEqual({ user: 1, mapping: 2, metadata: 1, sessionList: 1, sessionDetail: count });
    expectCountsMatchSdk(events[0]!);
  });

  it.each([1, 5, 20])("uses four calls and zero session reads with %s sessions in lightweight-v1", async (count) => {
    vi.mocked(Session.getAllSessionHandlesForUser).mockResolvedValue(Array.from({ length: count }, (_, i) => String(i)));
    vi.mocked(UserMetadata.getUserMetadata).mockResolvedValue({ status: "OK", metadata: {
      last_sign_in: "stale", last_active: "stale", last_sign_in_method: "stale",
    } });
    const profile = await getUserById("owner", "other", {}, { mode: "lightweight-v1", recordEvent });
    expect(profile.meta).not.toHaveProperty("last_sign_in");
    expect(profile.meta).not.toHaveProperty("last_active");
    expect(profile.meta).not.toHaveProperty("last_sign_in_method");
    expect(profile.meta.created).toBe(new Date(1000).toISOString());
    expect(events[0]?.sdkCalls).toEqual({ user: 1, mapping: 2, metadata: 1, sessionList: 0, sessionDetail: 0 });
    expect(Session.getAllSessionHandlesForUser).not.toHaveBeenCalled();
    expect(Session.getSessionInformation).not.toHaveBeenCalled();
    expectCountsMatchSdk(events[0]!);
  });

  it("counts mapped and linked records separately, preserves precedence", async () => {
    vi.mocked(SuperTokens.getUser).mockResolvedValue({ ...user, id: "alias", loginMethods: [
      ...user.loginMethods, { ...user.loginMethods[0]!, recipeUserId: SuperTokens.convertToRecipeUserId("linked") },
    ] });
    vi.mocked(SuperTokens.getUserIdMapping).mockImplementation(async ({ userIdType }) => userIdType === "EXTERNAL"
      ? { status: "OK", superTokensUserId: "owner", externalUserId: "alias" } : { status: "UNKNOWN_MAPPING_ERROR" });
    vi.mocked(UserMetadata.getUserMetadata).mockImplementation(async (id) => ({ status: "OK", metadata:
      id === "owner" ? { first_name: "Canonical" } : { first_name: "Alias", custom: id } }));
    const result = await getUserById("alias", "public", {}, { mode: "lightweight-v1", recordEvent });
    expect(result.data.first_name).toBe("Canonical");
    expect(events[0]?.sdkCalls).toEqual({ user: 1, mapping: 2, metadata: 3, sessionList: 0, sessionDetail: 0 });
    expectCountsMatchSdk(events[0]!);
  });

  it("does not perform the external fallback when internal mapping succeeds", async () => {
    vi.mocked(SuperTokens.getUserIdMapping).mockResolvedValue({ status: "OK", superTokensUserId: "owner", externalUserId: "alias" });
    await getUserById("owner", "public", {}, { mode: "lightweight-v1", recordEvent });
    expect(events[0]?.sdkCalls).toEqual({ user: 1, mapping: 1, metadata: 2, sessionList: 0, sessionDetail: 0 });
    expect(SuperTokens.getUserIdMapping).toHaveBeenCalledWith(expect.objectContaining({ userIdType: "SUPERTOKENS" }));
    expectCountsMatchSdk(events[0]!);
  });

  it("keeps overlapping reads isolated even with the same caller context", async () => {
    const context = {};
    const profiles = await Promise.all(["public", "other"].map((tenant) =>
      getUserById("owner", tenant, context, { mode: "lightweight-v1", recordEvent })));
    expect(profiles[0]).toEqual(profiles[1]);
    expect(SuperTokens.getUser).toHaveBeenCalledTimes(2);
    expect(UserMetadata.getUserMetadata).toHaveBeenCalledTimes(2);
    expect(events).toHaveLength(2);
    expect(events[0]?.requestId).not.toBe(events[1]?.requestId);
    expect(events.every((event) => event.sdkCalls?.metadata === 1)).toBe(true);
  });

  it("reads fresh metadata after a write with the same user and caller context", async () => {
    let metadata = { first_name: "Before" };
    vi.mocked(UserMetadata.getUserMetadata).mockImplementation(async () => ({ status: "OK", metadata }));
    vi.spyOn(UserMetadata, "updateUserMetadata").mockImplementation(async (_id, patch) => {
      metadata = { ...metadata, ...patch };
      return { status: "OK", metadata };
    });
    const context = {};
    const options = { mode: "lightweight-v1" as const, recordEvent };
    expect((await getUserById("owner", "public", context, options)).data.first_name).toBe("Before");
    await UserMetadata.updateUserMetadata("owner", { first_name: "After" }, context);
    expect((await getUserById("owner", "public", context, options)).data.first_name).toBe("After");
    expect(UserMetadata.getUserMetadata).toHaveBeenCalledTimes(2);
    expect(events[0]?.requestId).not.toBe(events[1]?.requestId);
  });

  it("retains legacy account-creation fallback when all sessions disappeared", async () => {
    vi.mocked(Session.getAllSessionHandlesForUser).mockResolvedValue(["revoked", "expired"]);
    vi.mocked(Session.getSessionInformation).mockResolvedValue(undefined);
    const profile = await getUserById("owner");
    expect(profile.meta).toMatchObject({ last_sign_in: new Date(1000).toISOString(), last_active: new Date(1000).toISOString() });
  });

  it("reuses retired-alias raw reads only within one assembly", async () => {
    vi.mocked(SuperTokens.getUser).mockImplementation(async (id) => id === "retired" ? undefined : user);
    vi.mocked(UserMetadata.getUserMetadata).mockImplementation(async (id) => ({ status: "OK", metadata:
      id === "retired" ? { rownd_migration_target: "owner", first_name: "Alias" } : {} }));
    const context = {};
    await getUserById("retired", "public", context, { mode: "lightweight-v1", recordEvent });
    expect(events[0]?.sdkCalls).toEqual({ user: 2, mapping: 2, metadata: 2, sessionList: 0, sessionDetail: 0 });
    expect(vi.mocked(UserMetadata.getUserMetadata).mock.calls.map(([id]) => id)).toEqual(["retired", "owner"]);
    vi.mocked(UserMetadata.getUserMetadata).mockResolvedValue({ status: "OK", metadata: { first_name: "Updated" } });
    expect((await getUserById("owner", "public", context, { mode: "lightweight-v1", recordEvent })).data.first_name).toBe("Updated");
    expect(events[1]?.requestId).not.toBe(events[0]?.requestId);
    expect(context).toEqual({});
    const sdkContext = vi.mocked(SuperTokens.getUser).mock.calls[0]?.[1];
    expect(sdkContext?.rowndProfileOperationId).toBe(events[0]?.requestId);
  });

  it("bounds detail concurrency to four and selects newest surviving session", async () => {
    vi.mocked(Session.getAllSessionHandlesForUser).mockResolvedValue(Array.from({ length: 20 }, (_, i) => String(i)));
    let active = 0;
    let peak = 0;
    vi.mocked(Session.getSessionInformation).mockImplementation(async (handle) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return handle === "19" ? undefined : info(2000 + Number(handle));
    });
    const profile = await getUserById("owner", "other", {}, { recordEvent });
    expect(peak).toBe(4);
    expect(profile.meta.last_sign_in).toBe(new Date(2018).toISOString());
    expect(Session.getAllSessionHandlesForUser).toHaveBeenCalledWith("owner", true, "other", expect.anything());
  });

  it("stops scheduling after a detail failure and records the failed operation", async () => {
    vi.mocked(Session.getAllSessionHandlesForUser).mockResolvedValue(Array.from({ length: 20 }, (_, i) => String(i)));
    vi.mocked(Session.getSessionInformation).mockRejectedValue(new Error("Core unavailable"));
    await expect(getUserById("owner", "public", {}, { recordEvent })).rejects.toThrow("Core unavailable");
    expect(Session.getSessionInformation).toHaveBeenCalledTimes(4);
    expect(events[0]).toMatchObject({ outcome: "error", sdkCalls: { sessionDetail: 4 } });
    expectCountsMatchSdk(events[0]!);
  });

  it("drains pending detail reads after a staggered failure without scheduling more", async () => {
    vi.mocked(Session.getAllSessionHandlesForUser).mockResolvedValue(Array.from({ length: 20 }, (_, i) => String(i)));
    const pending = new Map<string, { resolve: (value: ReturnType<typeof info>) => void; reject: (error: Error) => void }>();
    vi.mocked(Session.getSessionInformation).mockImplementation((handle) => new Promise((resolve, reject) => {
      pending.set(handle, { resolve, reject });
    }));
    const result = getUserById("owner", "public", {}, { recordEvent });
    const rejected = expect(result).rejects.toThrow("detail failed");
    await vi.waitFor(() => expect(pending.size).toBe(4));
    pending.get("0")!.reject(new Error("detail failed"));
    // Let the failure reach the worker while its siblings remain in flight.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toHaveLength(0);
    pending.get("1")!.resolve(info(2000));
    pending.get("2")!.resolve(info(2000));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pending.size).toBe(4);
    expect(events).toHaveLength(0);
    pending.get("3")!.resolve(info(2000));
    await rejected;
    expect(events).toHaveLength(1);
    expectCountsMatchSdk(events[0]!);
  });

  it("breaks timestamp ties by original handle order rather than completion order", async () => {
    const phoneRecipe = SuperTokens.convertToRecipeUserId("phone");
    vi.mocked(SuperTokens.getUser).mockResolvedValue({ ...user, loginMethods: [...user.loginMethods,
      { ...user.loginMethods[0]!, recipeUserId: phoneRecipe, email: undefined, phoneNumber: "+15555550100" } ] });
    vi.mocked(Session.getAllSessionHandlesForUser).mockResolvedValue(["first", "second"]);
    let resolveFirst!: (value: ReturnType<typeof info>) => void;
    vi.mocked(Session.getSessionInformation).mockImplementation((handle) => handle === "first"
      ? new Promise((resolve) => { resolveFirst = resolve; })
      : Promise.resolve({ ...info(2000), recipeUserId: phoneRecipe }));
    const result = getUserById("owner", "public", {}, { recordEvent });
    await vi.waitFor(() => expect(Session.getSessionInformation).toHaveBeenCalledTimes(2));
    resolveFirst(info(2000));
    expect((await result).meta.last_sign_in_method).toBe("email");
    expectCountsMatchSdk(events[0]!);
  });

  it("does not hide missing users or telemetry failures", async () => {
    vi.mocked(SuperTokens.getUser).mockResolvedValue(undefined);
    await expect(getUserById("missing", "public", {}, { mode: "lightweight-v1", recordEvent })).rejects.toThrow();
    expect(events[0]).toMatchObject({ outcome: "error", sdkCalls: { user: 1, metadata: 1 } });
    vi.mocked(SuperTokens.getUser).mockResolvedValue(user);
    await expect(getUserById("owner", "public", {}, { mode: "lightweight-v1", recordEvent: () => { throw Error("sink"); } })).resolves.toHaveProperty("data");
  });

  it("assembles identical non-activity fields without SDK reads or input mutation", () => {
    const metadata = Object.freeze({ first_name: "Canonical", rownd_profile_authoritative_fields: ["last_name"] });
    const legacy = assembleUserProfile("owner", "public", user, metadata, undefined, "legacy", info(2000));
    const lightweight = assembleUserProfile("owner", "public", user, metadata, undefined, "lightweight-v1");
    delete legacy.meta.last_sign_in;
    delete legacy.meta.last_active;
    delete legacy.meta.last_sign_in_method;
    expect(lightweight).toEqual(legacy);
    expect(SuperTokens.getUser).not.toHaveBeenCalled();
    expect(UserMetadata.getUserMetadata).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRowndClient } from "./rownd-client";
import { fetchOptionalRowndUserInfo, findRowndUserIdsByEmail, setRowndClient, withFreshRowndReads } from "./rownd-repository";

const sdk = vi.hoisted(() => ({ validateToken: vi.fn(), fetchUserInfo: vi.fn() }));
vi.mock("@rownd/node", () => ({ createInstance: () => sdk }));
const http = vi.fn<typeof fetch>();
const config = { appId: "app-scoped", appKey: "sensitive-key", appSecret: "sensitive-secret" };
const result = (ids: string[], total = ids.length) => Response.json({ total_results: total, results: ids.map((id) => ({ data: { user_id: id } })) });

beforeEach(() => { vi.resetAllMocks(); vi.stubGlobal("fetch", http); });
afterEach(() => { vi.unstubAllGlobals(); setRowndClient(undefined); });

describe("app-scoped Rownd administrative adapter", () => {
  it("uses the documented lookup filter, headers, and all pages including an inclusive cursor boundary", async () => {
    const client = createRowndClient(config);
    http.mockResolvedValueOnce(result(["user_a", "user_b"], 3)).mockResolvedValueOnce(result(["user_b", "user_c"], 3));
    expect(await client.findUserIdsByEmail!({ email: "a+tag@example.com" })).toEqual(["user_a", "user_b", "user_c"]);
    expect(http).toHaveBeenCalledTimes(2);
    const first = new URL(String(http.mock.calls[0]![0]));
    expect(first.origin + first.pathname).toBe("https://api.rownd.io/applications/app-scoped/users/data");
    expect(Object.fromEntries(first.searchParams)).toEqual({ lookup_filter: "a+tag@example.com", include_duplicates: "true", page_size: "100", sort: "asc" });
    expect(new URL(String(http.mock.calls[1]![0])).searchParams.get("after")).toBe("user_b");
    expect(http.mock.calls[0]![1]).toMatchObject({ redirect: "error", headers: {
      "x-rownd-app-key": config.appKey, "x-rownd-app-secret": config.appSecret, accept: "application/json",
    } });
    expect(first.href).not.toContain(config.appKey);
    expect(first.href).not.toContain(config.appSecret);
  });

  it.each([
    { total_results: 1, results: [{ data: {} }] },
    { total_results: "1", results: [{ data: { user_id: "a" } }] },
    { total_results: -1, results: [] },
    { total_results: 0, results: [{ data: { user_id: "a" } }] },
    { total_results: 1, results: [{ data: { user_id: ".." } }] },
    { total_results: 1, results: [{ rownd_user: "a" }] },
    { total_results: 1, results: Array.from({ length: 101 }, () => ({ data: { user_id: "a" } })) },
  ])("rejects malformed search page %#", async (body) => {
    http.mockResolvedValueOnce(Response.json(body));
    await expect(createRowndClient(config).findUserIdsByEmail!({ email: "a@example.com" })).rejects.toThrow("ROWND_EMAIL_SEARCH_INVALID_RESPONSE");
  });

  it.each(["empty", "repeated", "changed-total"])("rejects %s pagination rather than electing a partial result", async (kind) => {
    http.mockResolvedValueOnce(result(["a"], 2)).mockResolvedValueOnce(result(kind === "empty" ? [] : ["a"], kind === "changed-total" ? 3 : 2));
    await expect(createRowndClient(config).findUserIdsByEmail!({ email: "a@example.com" })).rejects.toThrow(kind === "changed-total" ? "ROWND_EMAIL_SEARCH_CHANGED" : "ROWND_EMAIL_SEARCH_INCOMPLETE");
  });

  it("deduplicates custom-client IDs and rejects malformed IDs before by-ID reads", async () => {
    const search = vi.fn(async () => ["b", "a", "a"]);
    setRowndClient({ ...sdk, findUserIdsByEmail: search });
    expect(await findRowndUserIdsByEmail("a@example.com")).toEqual(["a", "b"]);
    search.mockResolvedValueOnce(["valid", " invalid"]);
    await expect(findRowndUserIdsByEmail("a@example.com")).rejects.toThrow("ROWND_EMAIL_SEARCH_INVALID_RESPONSE");
    expect(sdk.fetchUserInfo).not.toHaveBeenCalled();
  });

  it("keeps uncached administrative reads isolated from concurrent legacy SDK reads", async () => {
    const client = createRowndClient(config);
    setRowndClient(client);
    sdk.fetchUserInfo.mockResolvedValue({ data: { user_id: "user_a", email: "cached@example.com" } });
    http.mockImplementation(async () => Response.json({ state: "enabled", data: { user_id: "user_a", email: "current@example.com" } }));
    const [fresh, cached] = await Promise.all([
      withFreshRowndReads(async () => { await Promise.resolve(); return fetchOptionalRowndUserInfo("user_a"); }),
      fetchOptionalRowndUserInfo("user_a"),
    ]);
    expect(fresh?.data.email).toBe("current@example.com");
    expect(cached?.data.email).toBe("cached@example.com");
    await withFreshRowndReads(() => fetchOptionalRowndUserInfo("user_a"));
    expect(http).toHaveBeenCalledTimes(2);
    expect(http.mock.calls[0]![0]).toBe("https://api.rownd.io/applications/app-scoped/users/user_a/data");
    expect(sdk.fetchUserInfo).toHaveBeenCalledTimes(1);
    expect(sdk.fetchUserInfo).toHaveBeenCalledWith({ user_id: "user_a", app_id: config.appId });
  });

  it("requires app scope for discovery and preserves legacy custom clients", async () => {
    const client = createRowndClient({ appKey: config.appKey, appSecret: config.appSecret });
    expect(client.findUserIdsByEmail).toBeUndefined();
    setRowndClient(client);
    await expect(findRowndUserIdsByEmail("a@example.com")).rejects.toThrow("ROWND_EMAIL_SEARCH_UNSUPPORTED");
    sdk.fetchUserInfo.mockResolvedValue({ data: { user_id: "legacy" } });
    expect(await withFreshRowndReads(() => fetchOptionalRowndUserInfo("legacy"))).toEqual({ data: { user_id: "legacy" } });
    expect(http).not.toHaveBeenCalled();
  });

  it("does not expose transport error content or response bodies", async () => {
    const client = createRowndClient(config);
    http.mockRejectedValueOnce(new Error(`failed ${config.appSecret} ${config.appKey}`));
    await expect(client.findUserIdsByEmail!({ email: "a@example.com" })).rejects.toThrow(/^Rownd administrative lookup request failed$/);
    http.mockResolvedValueOnce(new Response(config.appSecret, { status: 403 }));
    await expect(client.findUserIdsByEmail!({ email: "a@example.com" })).rejects.toThrow(/^Rownd administrative lookup failed \(HTTP 403\)$/);
    http.mockResolvedValueOnce(new Response(config.appKey));
    await expect(client.findUserIdsByEmail!({ email: "a@example.com" })).rejects.toThrow(/^Invalid Rownd administrative lookup response$/);
  });

  it("distinguishes an empty verified lookup from by-ID 404 and rejects different app scope", async () => {
    const client = createRowndClient(config);
    http.mockResolvedValueOnce(result([]));
    expect(await client.findUserIdsByEmail!({ email: "a@example.com" })).toEqual([]);
    http.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(await client.fetchFreshUserInfo!({ user_id: "a" })).toBeUndefined();
    await expect(client.fetchFreshUserInfo!({ user_id: "a", app_id: "foreign" })).rejects.toThrow("scope");
    await expect(client.findUserIdsByEmail!({ email: "a@example.com,b@example.com" })).rejects.toThrow("lookup value");
    expect(http).toHaveBeenCalledTimes(2);
  });
});

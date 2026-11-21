import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SuperTokens from "supertokens-node";
import type { User } from "supertokens-node/types";
import { handleUpdateUser } from "./pluginImplementation";
import { getUserById } from "./supertokens-repository";

vi.mock("./supertokens-repository", async (importOriginal) => ({
  ...await importOriginal<typeof import("./supertokens-repository")>(),
  getUserById: vi.fn(),
}));

const context = { caller: "profile-owner-test" };
const mismatch = { status: "ERROR", code: 409, error_code: "EMAIL_CHANGE_ACCOUNT_MISMATCH",
  message: "Sign in to the account where you started this change." };

const lookup = (userId: string, userIdType: "SUPERTOKENS" | "EXTERNAL") =>
  [{ userId, userIdType, userContext: context }];

function setup(users: Record<string, string> = {}, aliases: Record<string, string> = {}) {
  const getUser = vi.spyOn(SuperTokens, "getUser").mockImplementation(async (id) =>
    users[id] ? { id: users[id] } as User : undefined);
  const mapping = vi.spyOn(SuperTokens, "getUserIdMapping").mockImplementation(async ({ userId, userIdType }) => {
    const externalId = userIdType === "EXTERNAL" ? userId : Object.keys(aliases).find((id) => aliases[id] === userId);
    return externalId && aliases[externalId]
      ? { status: "OK", superTokensUserId: aliases[externalId], externalUserId: externalId }
      : { status: "UNKNOWN_MAPPING_ERROR" };
  });
  const handler = handleUpdateUser({
    pluginConfig: { rowndAppKey: "key", rowndAppSecret: "secret" },
    stConfig: {} as Parameters<typeof handleUpdateUser>[0]["stConfig"],
    telemetryClient: { recordEvent: vi.fn(), recordSuccess: vi.fn(), recordError: vi.fn() },
  });
  type Handler = Parameters<typeof handler>;
  const session = { getUserId: () => "session-owner", getTenantId: () => "tenant-a" } as Handler[2];
  const invoke = (bodyContext: Record<string, unknown>, requestedTenant?: string) => handler({
    getJSONBody: async () => ({ data: {}, context: bodyContext }),
    getKeyValueFromQuery: (key: string) => key === "tenantId" ? requestedTenant : undefined,
    getHeaderValue: () => undefined,
  } as unknown as Handler[0], {} as Handler[1], session, context);
  return { invoke, getUser, mapping };
}

beforeEach(() => {
  vi.mocked(getUserById).mockReset().mockResolvedValue({} as Awaited<ReturnType<typeof getUserById>>);
});
afterEach(() => vi.restoreAllMocks());

it("compares the same primary returned for internal and external inputs without mapping reads", async () => {
  const { invoke, getUser, mapping } = setup({ "session-owner": "canonical", "expected-alias": "canonical" });
  expect(await invoke({ rowndExpectedUserId: "expected-alias", rowndExpectedTenantId: "tenant-a" })).toEqual({ status: "OK" });
  expect(getUser.mock.calls).toEqual([["session-owner", context], ["expected-alias", context]]);
  expect(mapping).not.toHaveBeenCalled();
  expect(getUserById).toHaveBeenCalledTimes(1);
});

it("reuses a successful read when both inputs are identical", async () => {
  const { invoke, getUser, mapping } = setup({ "session-owner": "canonical" });
  expect(await invoke({ rowndExpectedUserId: "session-owner" })).toEqual({ status: "OK" });
  expect(getUser.mock.calls).toEqual([["session-owner", context]]);
  expect(mapping).not.toHaveBeenCalled();
});

it("checks SUPERTOKENS before EXTERNAL for each differing SDK owner ID", async () => {
  const { invoke, getUser, mapping } = setup({ "session-owner": "canonical", expected: "other" });
  expect(await invoke({ rowndExpectedUserId: "expected" })).toEqual(mismatch);
  expect(getUser).toHaveBeenCalledTimes(2);
  expect(mapping.mock.calls).toEqual([
    lookup("canonical", "SUPERTOKENS"), lookup("canonical", "EXTERNAL"),
    lookup("other", "SUPERTOKENS"), lookup("other", "EXTERNAL"),
  ]);
  expect(getUserById).not.toHaveBeenCalled();
});

it.each([false, true])("preserves precedence for overlapping forced aliases (separate owners: %s)", async (separate) => {
  const { invoke, getUser, mapping } = setup(
    { "session-owner": "external", "another-internal": "internal" },
    { external: "internal", internal: "another-internal", ...(separate ? { "other-alias": "external" } : {}) },
  );
  expect(await invoke({ rowndExpectedUserId: "another-internal" })).toEqual(separate ? mismatch : { status: "OK" });
  expect(getUser).toHaveBeenCalledTimes(2);
  expect(mapping.mock.calls).toEqual([
    lookup("external", "SUPERTOKENS"),
    ...(separate ? [] : [lookup("external", "EXTERNAL")]),
    lookup("internal", "SUPERTOKENS"),
  ]);
  expect(getUserById).toHaveBeenCalledTimes(separate ? 0 : 1);
});

it.each([
  { name: "missing session owner", users: { expected: "other" } as Record<string, string>, expected: "expected", reads: 1 },
  { name: "missing expected owner", users: { "session-owner": "canonical" }, expected: "expected", reads: 2 },
  { name: "empty expected ID", users: { "session-owner": "canonical" }, expected: "", reads: 1 },
  { name: "invalid expected ID", users: { "session-owner": "canonical" }, expected: 42, reads: 1 },
])("rejects a $name", async ({ users, expected, reads }) => {
  const { invoke, getUser, mapping } = setup(users);
  expect(await invoke({ rowndExpectedUserId: expected })).toEqual(mismatch);
  expect(getUser).toHaveBeenCalledTimes(reads);
  expect(mapping).not.toHaveBeenCalled();
  expect(getUserById).not.toHaveBeenCalled();
});

it.each([
  { expectedTenant: "tenant-b", requestedTenant: undefined },
  { expectedTenant: 42, requestedTenant: undefined },
  { expectedTenant: "tenant-a", requestedTenant: "tenant-b" },
])("rejects tenant mismatch without a second user read (%j)", async ({ expectedTenant, requestedTenant }) => {
  const { invoke, getUser, mapping } = setup({ "session-owner": "canonical", expected: "canonical" });
  expect(await invoke({ rowndExpectedUserId: "expected", rowndExpectedTenantId: expectedTenant }, requestedTenant)).toEqual(mismatch);
  expect(getUser.mock.calls).toEqual([["session-owner", context]]);
  expect(mapping).not.toHaveBeenCalled();
  expect(getUserById).not.toHaveBeenCalled();
});

it("skips owner validation when no expectation is supplied", async () => {
  const { invoke, getUser, mapping } = setup();
  expect(await invoke({}, "tenant-a")).toEqual({ status: "OK" });
  expect(getUser).not.toHaveBeenCalled();
  expect(mapping).not.toHaveBeenCalled();
});

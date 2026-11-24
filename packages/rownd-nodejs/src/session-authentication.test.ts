import { afterEach, describe, expect, it, vi } from "vitest";
import SuperTokens from "supertokens-node";
import type { User } from "supertokens-node/types";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import { SESSION_AUTHENTICATION_KEY, sessionAuthenticationOrigin, withProvenSessionAuthentication } from "./session-authentication";

const context = { caller: "session-test" };

function method(id: string, provider?: string): User["loginMethods"][number] {
  return {
    recipeUserId: SuperTokens.convertToRecipeUserId(id),
    thirdParty: provider ? { id: provider, userId: id } : undefined,
  } as User["loginMethods"][number];
}

function setup(loginMethods: User["loginMethods"], aliases: Record<string, string> = {}) {
  const user = { id: "owner-alias", loginMethods } as User;
  const mapping = vi.spyOn(SuperTokens, "getUserIdMapping").mockImplementation(async ({ userId }) => {
    const internalId = aliases[userId];
    return internalId
      ? { status: "OK", superTokensUserId: internalId, externalUserId: userId }
      : { status: "UNKNOWN_MAPPING_ERROR" };
  });
  const metadata = vi.spyOn(UserMetadata, "getUserMetadata").mockResolvedValue({ status: "OK", metadata: {} });
  const expectReads = (creating: boolean, ids: string[]) => {
    const reads = creating ? ids : [user.id, ...ids];
    expect(mapping.mock.calls).toEqual(reads.map((userId) => [{ userId, userIdType: "EXTERNAL", userContext: context }]));
    expect(metadata).toHaveBeenCalledTimes(creating ? 0 : 1);
    if (!creating) expect(metadata).toHaveBeenCalledWith(aliases[user.id] ?? user.id, context);
  };
  return { user, mapping, metadata, expectReads };
}

afterEach(() => vi.restoreAllMocks());

describe.each([true, false])("session authentication origin (creating: %s)", (creating) => {
  it.each([
    { name: "first exact instant", methods: [method("session", "instant"), method("other")], origin: "instant" },
    { name: "later exact credential", methods: [method("other"), method("session")], origin: "authenticated" },
    { name: "exact instant after a guest", methods: [method("other", "guest"), method("session", "instant")], origin: "instant" },
    { name: "only a guest", methods: [method("session", "guest")], origin: undefined },
  ])("avoids recipe mapping reads for $name", async ({ methods, origin }) => {
    const { user, expectReads } = setup(methods, { "owner-alias": "internal-owner" });
    expect(await sessionAuthenticationOrigin(user, "session", {}, context, creating)).toBe(origin);
    expectReads(creating, []);
  });

  it("checks the prefix before a later exact match with a competing origin", async () => {
    const { user, expectReads } = setup([method("other"), method("session", "instant"), method("unused")]);
    expect(await sessionAuthenticationOrigin(user, "session", {}, context, creating)).toBe("instant");
    expectReads(creating, ["session", "other"]);
  });

  it("keeps an earlier mapped instant origin ahead of an exact credential match", async () => {
    const { user, expectReads } = setup([method("earlier-alias", "instant"), method("session")], { "earlier-alias": "session" });
    expect(await sessionAuthenticationOrigin(user, "session", {}, context, creating)).toBe("instant");
    expectReads(creating, ["session", "earlier-alias"]);
  });

  it("normalizes the session ID too when it is an external alias", async () => {
    const { user, expectReads } = setup([method("internal"), method("session", "instant")], { session: "internal" });
    expect(await sessionAuthenticationOrigin(user, "session", {}, context, creating)).toBe("authenticated");
    expectReads(creating, ["session", "internal"]);
  });

  it("stops at the first mapped match, before reading a later competing method", async () => {
    const { user, expectReads } = setup(
      [method("internal"), method("unused", "instant"), method("session")],
      { session: "internal" },
    );
    expect(await sessionAuthenticationOrigin(user, "session", {}, context, creating)).toBe("authenticated");
    expectReads(creating, ["session", "internal"]);
  });

  it("finds a historical mapped credential after an exact guest match", async () => {
    const { user, expectReads } = setup([method("session", "guest"), method("historical")], { historical: "session" });
    expect(await sessionAuthenticationOrigin(user, "session", {}, context, creating)).toBe("authenticated");
    expectReads(creating, ["session", "historical"]);
  });

  it("returns no origin for an unmatched session", async () => {
    const { user, expectReads } = setup([method("other"), method("instant", "instant")]);
    expect(await sessionAuthenticationOrigin(user, "session", {}, context, creating)).toBeUndefined();
    expectReads(creating, ["session", "other", "instant"]);
  });
});

it("keeps the proven creation and existing session bindings ahead of inference", async () => {
  const { user, mapping, metadata } = setup([method("session", "guest")]);
  await expect(withProvenSessionAuthentication(() => sessionAuthenticationOrigin(user, "session", {}, context, true)))
    .resolves.toBe("authenticated");
  await expect(sessionAuthenticationOrigin(user, "session", { [SESSION_AUTHENTICATION_KEY]: "instant" }, context))
    .resolves.toBe("instant");
  expect(mapping).not.toHaveBeenCalled();
  expect(metadata).not.toHaveBeenCalled();
});

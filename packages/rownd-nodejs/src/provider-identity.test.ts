import { describe, expect, it } from "vitest";
import { resolveRowndProviderSubject } from "./provider-identity";
import { mapRowndUserToSuperTokens } from "./rownd-compatibility";
import { prepareCurrentRowndEmailReconciliation } from "./migration-email";
import type { RowndUser } from "./types";
import type { SuperTokensUser } from "./rownd-compatibility";
import { LoginMethod } from "supertokens-node/lib/build/user";

describe.each(["google", "apple"])("Rownd %s identity", (provider) => {
  it.each([undefined, false, true, "", "   ", 123])("falls back from non-subject verification %j", (verified) => {
    const profile = { data: { user_id: "rownd", [`${provider}_id`]: "data-subject" },
      verified_data: { [`${provider}_id`]: verified } } as RowndUser;
    expect(resolveRowndProviderSubject(profile, provider)).toBe("data-subject");
    expect(mapRowndUserToSuperTokens(profile, "public").loginMethods[0]).toMatchObject({
      recipeId: "thirdparty", thirdPartyId: provider, thirdPartyUserId: "data-subject",
    });
  });

  it("uses verified subject consistently for imports, including its placeholder", () => {
    const profile: RowndUser = { data: { user_id: "rownd", [`${provider}_id`]: "old" },
      verified_data: { [`${provider}_id`]: "verified" } };
    const expected: RowndUser = { data: { user_id: "rownd", [`${provider}_id`]: "verified" } };
    expect(resolveRowndProviderSubject(profile, provider)).toBe("verified");
    expect(mapRowndUserToSuperTokens(profile).loginMethods).toEqual(mapRowndUserToSuperTokens(expected).loginMethods);
  });

  it.each([undefined, "", "  ", false, 123])("does not manufacture a provider subject from invalid data %j", (data) => {
    const profile = { data: { user_id: "rownd", [`${provider}_id`]: data }, verified_data: {} } as RowndUser;
    expect(resolveRowndProviderSubject(profile, provider)).toBeUndefined();
    expect(mapRowndUserToSuperTokens(profile).loginMethods.some((method) =>
      method.recipeId === "thirdparty" && method.thirdPartyId === provider)).toBe(false);
  });

  it("does not turn a contradictory historical provider into an email change", async () => {
    const profile: RowndUser = { data: { user_id: "rownd", email: "same@example.com", [`${provider}_id`]: "old" },
      verified_data: { [`${provider}_id`]: "verified", email: true } };
    const source = mapRowndUserToSuperTokens(profile, "public");
    const loginMethods = [
      new LoginMethod({ recipeId: "thirdparty", recipeUserId: "historical", tenantIds: ["public"],
        thirdParty: { id: provider, userId: "old" }, verified: false, timeJoined: 0 }),
      new LoginMethod({ recipeId: "passwordless", recipeUserId: "contact", tenantIds: ["public"],
        email: "same@example.com", verified: true, timeJoined: 0 }),
    ];
    await expect(prepareCurrentRowndEmailReconciliation(source, { loginMethods } as unknown as SuperTokensUser,
      { original_rownd_user: profile }, "public")).resolves.toBeUndefined();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SuperTokens from "supertokens-node";
import Session from "supertokens-node/recipe/session";
import { assertRetainedPasswordlessAuthentication, assertRetainedPasswordlessAuthenticationFresh, passwordlessSessionReceipt } from "./session-authentication";

vi.mock("./rownd-compatibility", () => ({ getRawUserMetadata: vi.fn() }));
vi.mock("./migration-consolidation", () => ({ assertCompletedPlan: vi.fn() }));
vi.mock("./migration-owner-plan", () => ({ readOwnerPlanCheckpoint: vi.fn(), ambiguousOwnerSessionAliases: vi.fn() }));

const recipe = (id: string) => SuperTokens.convertToRecipeUserId(id);
let user: any;
let session: any;
let data: any;
let proof: any;
let live: boolean;
let sessionExpiry: number;
let databaseUserId: string;
let payload: Record<string, unknown>;

function issueReceipt(recipeUserId = "canonical", email = "new@example.com") {
  const receipt = passwordlessSessionReceipt({ user, combinedMetadata: { rownd_email_recipe_user_ids: { public: "canonical" } } },
    session.getRecipeUserId().getAsString(), "public", { recipeUserId, email, authenticatedAt: Date.now() });
  if (receipt) {
    Object.assign(data, receipt.sessionDataInDatabase);
    Object.assign(payload, receipt.accessTokenPayload);
  }
  return receipt;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-17T10:00:00Z"));
  data = { application_value: "preserved" };
  payload = { auth_level: "verified", rownd_session_authentication: "authenticated" };
  live = true;
  sessionExpiry = Date.now() + 3600_000;
  databaseUserId = "rownd";
  user = { id: "rownd", isPrimaryUser: true, loginMethods: [
    { recipeId: "passwordless", recipeUserId: recipe("canonical"), email: "new@example.com", verified: true, tenantIds: ["public"] },
    { recipeId: "thirdparty", recipeUserId: recipe("sso"), email: "old@example.com", verified: true, tenantIds: ["public"], thirdParty: { id: "google", userId: "subject" } },
  ] };
  vi.spyOn(SuperTokens, "getUser").mockImplementation(async () => user);
  vi.spyOn(SuperTokens, "getUserIdMapping").mockResolvedValue({ status: "UNKNOWN_MAPPING_ERROR" });
  session = { getUserId: () => "rownd", getTenantId: () => "public", getRecipeUserId: () => recipe("canonical"), getHandle: () => "handle",
    getAccessTokenPayload: () => payload };
  proof = { session, userId: "owner", tenantId: "public", recipeUserId: "canonical", email: "new@example.com", userContext: {} };
  vi.spyOn(Session, "getSessionInformation").mockImplementation(async () => live ? {
    userId: databaseUserId, recipeUserId: session.getRecipeUserId(), tenantId: "public", sessionHandle: "handle",
    sessionDataInDatabase: data, expiry: sessionExpiry, timeCreated: Date.now(), customClaimsInAccessTokenPayload: {},
  } : undefined);
});

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("server-side retained Passwordless authentication receipt", () => {
  it("records actual canonical code consumption in session data, not access-token claims", async () => {
    issueReceipt();
    expect(data).toMatchObject({ application_value: "preserved", rownd_passwordless_authentication_receipt: {
      version: 2, userId: "rownd", recipeUserId: "canonical", tenantId: "public", binding: expect.any(String), authenticatedAt: Date.now(),
    } });
    expect(session.getAccessTokenPayload()).not.toHaveProperty("rownd_passwordless_authentication_receipt");
    await expect(assertRetainedPasswordlessAuthentication(proof)).resolves.toMatchObject({ userId: "owner", recipeUserId: "canonical" });
  });

  it("does not infer the consumed factor from the attached canonical email", async () => {
    session.getRecipeUserId = () => recipe("sso");
    expect(issueReceipt()).toBeUndefined();
    expect(issueReceipt("sso", "old@example.com")).toBeUndefined();
    await expect(assertRetainedPasswordlessAuthentication(proof)).rejects.toMatchObject({ errorCode: "SIGN_IN_METHOD_REAUTHENTICATION_REQUIRED" });
  });

  it("accepts the internal database owner ID paired with the container's mapped alias", async () => {
    vi.mocked(SuperTokens.getUserIdMapping).mockImplementation(async ({ userId, userIdType }) =>
      userId === "rownd" && userIdType === "EXTERNAL"
        ? { status: "OK", superTokensUserId: "owner", externalUserId: "rownd", externalUserIdInfo: undefined }
        : { status: "UNKNOWN_MAPPING_ERROR" });
    databaseUserId = "owner";
    issueReceipt();
    await expect(assertRetainedPasswordlessAuthentication(proof)).resolves.toMatchObject({
      userId: "owner", recipeUserId: "canonical", sessionHandle: "handle",
    });
  });

  it.each(["other-owner", "sso", "unmapped-alias"])("rejects database owner %s outside the explicit container mapping", async (id) => {
    vi.mocked(SuperTokens.getUserIdMapping).mockImplementation(async ({ userId, userIdType }) =>
      userId === "rownd" && userIdType === "EXTERNAL"
        ? { status: "OK", superTokensUserId: "owner", externalUserId: "rownd", externalUserIdInfo: undefined }
        : { status: "UNKNOWN_MAPPING_ERROR" });
    issueReceipt();
    databaseUserId = id;
    await expect(assertRetainedPasswordlessAuthentication(proof)).rejects.toMatchObject({ errorCode: "SIGN_IN_METHOD_REAUTHENTICATION_REQUIRED" });
  });

  it("does not infer a container mapping from shared primary ownership", async () => {
    issueReceipt();
    databaseUserId = "owner";
    await expect(assertRetainedPasswordlessAuthentication(proof)).rejects.toMatchObject({ errorCode: "SIGN_IN_METHOD_REAUTHENTICATION_REQUIRED" });
  });

  it("reads session liveness after resolving the container's mapped alias", async () => {
    issueReceipt();
    databaseUserId = "owner";
    vi.mocked(SuperTokens.getUserIdMapping).mockImplementation(async ({ userId, userIdType }) => {
      if (userId === "rownd" && userIdType === "EXTERNAL") {
        live = false;
        return { status: "OK", superTokensUserId: "owner", externalUserId: "rownd", externalUserIdInfo: undefined };
      }
      return { status: "UNKNOWN_MAPPING_ERROR" };
    });
    await expect(assertRetainedPasswordlessAuthentication(proof)).rejects.toMatchObject({ errorCode: "SIGN_IN_METHOD_REAUTHENTICATION_REQUIRED" });
    expect(live).toBe(false);
    expect(Math.max(...vi.mocked(Session.getSessionInformation).mock.invocationCallOrder))
      .toBeGreaterThan(Math.max(...vi.mocked(SuperTokens.getUserIdMapping).mock.invocationCallOrder));
  });

  it("refuses noncanonical or unverified consumed passwordless methods", async () => {
    user.loginMethods.push({ ...user.loginMethods[0], recipeUserId: recipe("other") });
    session.getRecipeUserId = () => recipe("other");
    expect(issueReceipt("other")).toBeUndefined();
    user.loginMethods[0].verified = false;
    session.getRecipeUserId = () => recipe("canonical");
    expect(issueReceipt()).toBeUndefined();
  });

  it("does not treat recent creation or migrated authenticated claims as a receipt", async () => {
    session.getTimeCreated = async () => Date.now();
    await expect(assertRetainedPasswordlessAuthentication(proof)).rejects.toMatchObject({ httpStatus: 403,
      reauthentication: { method: "email", identifier: "new@example.com" } });
  });

  it("does not attest a new email written to the same recipe after code consumption", async () => {
    user.loginMethods[0].email = "changed@example.com";
    expect(issueReceipt()).toBeUndefined();
  });

  it.each(["expired", "future", "owner", "tenant", "recipe", "email", "binding", "session recipe", "session tenant"])("rejects %s receipt binding", async (change) => {
    issueReceipt();
    const receipt = data.rownd_passwordless_authentication_receipt;
    if (change === "expired") vi.setSystemTime(Date.now() + 600_001);
    if (change === "future") receipt.authenticatedAt += 1;
    if (change === "owner") receipt.userId = "other";
    if (change === "tenant") receipt.tenantId = "other";
    if (change === "recipe") receipt.recipeUserId = "other";
    if (change === "email") receipt.email = "other@example.com";
    if (change === "binding") receipt.binding = "other";
    if (change === "session recipe") session.getRecipeUserId = () => recipe("sso");
    if (change === "session tenant") session.getTenantId = () => "other";
    await expect(assertRetainedPasswordlessAuthentication(proof)).rejects.toMatchObject({ errorCode: "SIGN_IN_METHOD_REAUTHENTICATION_REQUIRED" });
  });

  it("accepts an older receipt only for its original handle", async () => {
    data.rownd_passwordless_authentication_receipt = { version: 1, userId: "owner", tenantId: "public",
      recipeUserId: "canonical", email: "new@example.com", sessionHandle: "handle", authenticatedAt: Date.now() };
    await expect(assertRetainedPasswordlessAuthentication(proof)).resolves.toBeDefined();
    data.rownd_passwordless_authentication_receipt.sessionHandle = "other";
    await expect(assertRetainedPasswordlessAuthentication(proof)).rejects.toMatchObject({ errorCode: "SIGN_IN_METHOD_REAUTHENTICATION_REQUIRED" });
  });

  it("expires proof at the 600-second freshness limit", async () => {
    issueReceipt();
    vi.setSystemTime(Date.now() + 600_000);
    await expect(assertRetainedPasswordlessAuthentication(proof)).rejects.toMatchObject({ errorCode: "SIGN_IN_METHOD_REAUTHENTICATION_REQUIRED" });
  });

  it.each(["revoked", "expired"])("rejects an initiating session that was %s while graph work was awaited", async (change) => {
    issueReceipt();
    await assertRetainedPasswordlessAuthentication(proof);
    if (change === "revoked") live = false;
    else sessionExpiry = Date.now();
    await expect(assertRetainedPasswordlessAuthentication(proof)).rejects.toMatchObject({ errorCode: "SIGN_IN_METHOD_REAUTHENTICATION_REQUIRED" });
  });

  it("keeps immutable validated proof for freshness checks after intentional revocation", async () => {
    issueReceipt();
    const validated = await assertRetainedPasswordlessAuthentication(proof);
    expect(Object.isFrozen(validated)).toBe(true);
    const reads = vi.mocked(Session.getSessionInformation).mock.calls.length;
    live = false;
    data.rownd_passwordless_authentication_receipt.authenticatedAt = Date.now() + 1000;
    expect(() => assertRetainedPasswordlessAuthenticationFresh(validated)).not.toThrow();
    expect(Session.getSessionInformation).toHaveBeenCalledTimes(reads);
    vi.setSystemTime(Date.now() + 600_001);
    expect(() => assertRetainedPasswordlessAuthenticationFresh(validated)).toThrow();
  });
});

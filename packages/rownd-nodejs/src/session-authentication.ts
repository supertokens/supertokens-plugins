import SuperTokens from "supertokens-node";
import Session from "supertokens-node/recipe/session";
import { EmailVerificationClaim } from "supertokens-node/recipe/emailverification";
import { RowndEmailChangeError, RowndSignInMethodError } from "./errors";
import { AsyncLocalStorage } from "node:async_hooks";
import type { User } from "supertokens-node/types";
import type { JsonRecord } from "./utils";
import { clearSuperTokensCoreCallCache, isRecord } from "./utils";
import type { SessionContainerInterface } from "supertokens-node/recipe/session/types";
import { getInternalPrimaryUserId, getPrimaryUserMetadata, getRawUserMetadata } from "./rownd-compatibility";
import { resolveCanonicalEmailForTenant } from "./canonical-email";
import { readOwnerPlanCheckpoint, ambiguousOwnerSessionAliases } from "./migration-owner-plan";
import { assertCompletedPlan } from "./migration-consolidation";

export const SESSION_AUTHENTICATION_KEY = "rownd_session_authentication";
const PASSWORDLESS_AUTHENTICATION_RECEIPT = "rownd_passwordless_authentication_receipt";
export const SIGN_IN_METHOD_AUTHENTICATION_MAX_AGE_MS = 600_000;

export type ValidatedPasswordlessAuthentication = Readonly<{
  userId: string;
  tenantId: string;
  recipeUserId: string;
  sessionHandle: string;
  email: string;
  authenticatedAt: number;
  sessionExpiresAt: number;
}>;

function retainedAuthenticationRequired(email: string): never {
  throw new RowndSignInMethodError("SIGN_IN_METHOD_REAUTHENTICATION_REQUIRED", 403,
    "Sign out and sign in with the retained email before disconnecting this method.", { method: "email", identifier: email });
}

export function assertRetainedPasswordlessAuthenticationFresh(proof: ValidatedPasswordlessAuthentication) {
  const now = Date.now();
  if (!Number.isFinite(proof.authenticatedAt) || proof.authenticatedAt > now ||
    now - proof.authenticatedAt >= SIGN_IN_METHOD_AUTHENTICATION_MAX_AGE_MS ||
    !Number.isFinite(proof.sessionExpiresAt) || proof.sessionExpiresAt <= now) retainedAuthenticationRequired(proof.email);
}

export async function immutableRecipeUserId(id: string, userContext: JsonRecord): Promise<string> {
  const mapping = await SuperTokens.getUserIdMapping({ userId: id, userIdType: "EXTERNAL", userContext });
  return mapping.status === "OK" ? mapping.superTokensUserId : id;
}

// Only the successful code-consumption path calls this. Session creation and
// migration can select a Passwordless recipe without proving its possession.
export async function recordPasswordlessAuthentication(
  session: SessionContainerInterface,
  authenticatedRecipeUserId: string,
  tenantId: string,
  userContext: JsonRecord,
  authenticatedEmail: string,
  authenticatedAt = Date.now(),
) {
  const owner = await getInternalPrimaryUserId(session.getUserId(userContext), userContext);
  const recipe = await immutableRecipeUserId(authenticatedRecipeUserId, userContext);
  const user = await SuperTokens.getUser(session.getUserId(userContext), userContext);
  const method = user?.loginMethods.find((entry) => entry.recipeId === "passwordless" &&
    entry.recipeUserId.getAsString() === authenticatedRecipeUserId && entry.tenantIds.includes(tenantId));
  if (!owner || !user || !method?.verified || !method.email || method.email.trim().toLowerCase() !== authenticatedEmail.trim().toLowerCase() ||
    session.getTenantId(userContext) !== tenantId ||
    await immutableRecipeUserId(session.getRecipeUserId(userContext).getAsString(), userContext) !== recipe) return;
  const canonical = resolveCanonicalEmailForTenant({ user, metadata: await getPrimaryUserMetadata(user.id, userContext), tenantId, passwordlessOnly: true });
  if (canonical.status !== "SELECTED" || canonical.recipeUserIds.length !== 1 ||
    canonical.recipeUserIds[0] !== authenticatedRecipeUserId) return;
  const data = await session.getSessionDataFromDatabase(userContext);
  await session.updateSessionDataInDatabase({
    ...(isRecord(data) ? data : {}),
    [PASSWORDLESS_AUTHENTICATION_RECEIPT]: {
      version: 1, userId: owner, tenantId, recipeUserId: recipe,
      email: authenticatedEmail.trim().toLowerCase(),
      sessionHandle: session.getHandle(userContext), authenticatedAt,
    },
  }, userContext);
}

export async function assertRetainedPasswordlessAuthentication(input: {
  session: SessionContainerInterface;
  userId: string;
  tenantId: string;
  recipeUserId: string;
  email: string;
  userContext: JsonRecord;
}) {
  const { session, userId, tenantId, recipeUserId, email, userContext } = input;
  clearSuperTokensCoreCallCache(userContext);
  const liveRecipeUserId = await immutableRecipeUserId(session.getRecipeUserId(userContext).getAsString(), userContext);
  const sessionUserId = session.getUserId(userContext);
  const immutableSessionUserId = await immutableRecipeUserId(sessionUserId, userContext);
  const owner = await getInternalPrimaryUserId(sessionUserId, userContext);
  // Read the database last: creation time and a still-valid stateless JWT cannot
  // prove that the initiating session survived the preceding graph reads.
  const information = await Session.getSessionInformation(session.getHandle(userContext), userContext);
  const data = information?.sessionDataInDatabase;
  const receipt = isRecord(data) ? data[PASSWORDLESS_AUTHENTICATION_RECEIPT] : undefined;
  // Core may return the internal primary ID while the container exposes its mapped alias.
  if (!information || (information.userId !== sessionUserId && information.userId !== immutableSessionUserId) || information.tenantId !== tenantId ||
    information.sessionHandle !== session.getHandle(userContext) ||
    information.recipeUserId.getAsString() !== session.getRecipeUserId(userContext).getAsString() || owner !== userId ||
    !isRecord(receipt) || receipt.version !== 1 || receipt.userId !== userId || receipt.tenantId !== tenantId ||
    receipt.recipeUserId !== recipeUserId || receipt.email !== email.trim().toLowerCase() || receipt.sessionHandle !== session.getHandle(userContext) ||
    typeof receipt.authenticatedAt !== "number" || session.getTenantId(userContext) !== tenantId || liveRecipeUserId !== recipeUserId) {
    retainedAuthenticationRequired(email);
  }
  const proof: ValidatedPasswordlessAuthentication = Object.freeze({ userId, tenantId, recipeUserId, email,
    sessionHandle: information.sessionHandle, authenticatedAt: receipt.authenticatedAt, sessionExpiresAt: information.expiry });
  assertRetainedPasswordlessAuthenticationFresh(proof);
  return proof;
}

export async function assertEmailChangeSessionClaims(handle: string, userContext: JsonRecord) {
  const result = await Session.validateClaimsForSessionHandle(handle, (validators) => validators.filter((validator) =>
    !("claim" in validator) || validator.claim.key !== EmailVerificationClaim.key), userContext);
  if (result.status !== "OK" || result.invalidClaims.length) {
    throw new RowndEmailChangeError("CONFLICT", 403, "Session requirements are not satisfied.");
  }
}
const provenAuthentication = new AsyncLocalStorage<boolean>();

// Credential-success paths can attest authentication when account linking keeps
// the session on the instant recipe. Metadata updates cannot mint this binding.
export async function withProvenSessionAuthentication<T>(action: () => Promise<T>) {
  return provenAuthentication.run(true, action);
}

export async function sessionAuthenticationOrigin(user: User | undefined, recipeUserId: string | undefined,
  payload: JsonRecord, context: JsonRecord, creating = false): Promise<"instant" | "authenticated" | undefined> {
  if (creating && provenAuthentication.getStore()) return "authenticated";
  if (!creating && payload[SESSION_AUTHENTICATION_KEY] === "authenticated") return "authenticated";
  if (!creating && (payload[SESSION_AUTHENTICATION_KEY] === "instant" || payload.auth_level === "instant")) return "instant";
  if (!user || !recipeUserId) return payload.auth_level === "instant" ? "instant" : undefined;
  const immutable = async (id: string) => {
    const mapping = await SuperTokens.getUserIdMapping({ userId: id, userIdType: "EXTERNAL", userContext: context });
    return mapping.status === "OK" ? mapping.superTokensUserId : id;
  };
  if (!creating) {
    const target = await immutable(user.id);
    const plan = readOwnerPlanCheckpoint(await getRawUserMetadata(target, context));
    if (plan && ambiguousOwnerSessionAliases(plan).includes(recipeUserId)) {
      await assertCompletedPlan(plan, context);
      // Old servers could issue verified claims for an instant-origin session.
      // A relocated alias cannot distinguish that session from real sign-in.
      // Require fresh authentication for these unmarked, ambiguous bindings.
      return "instant";
    }
  }
  const origin = (method: User["loginMethods"][number]) => {
    if (method.thirdParty?.id === "instant") return "instant";
    if (method.thirdParty?.id !== "guest") return "authenticated";
  };
  const exactIndex = user.loginMethods.findIndex((method) =>
    method.thirdParty?.id !== "guest" && method.recipeUserId.getAsString() === recipeUserId);
  const exactOrigin = exactIndex < 0 ? undefined : origin(user.loginMethods[exactIndex]!);
  let end = exactIndex < 0 ? user.loginMethods.length : exactIndex;
  // Forced mappings can make an earlier method match too. Check through the
  // last method that could disagree with the exact match, in the original order.
  if (exactOrigin) {
    while (end > 0) {
      const candidate = origin(user.loginMethods[end - 1]!);
      if (candidate && candidate !== exactOrigin) break;
      end--;
    }
  }
  let recipe: string | undefined;
  for (let i = 0; i < end; i++) {
    const method = user.loginMethods[i]!;
    const candidate = origin(method);
    if (!candidate) continue;
    recipe ??= await immutable(recipeUserId);
    if (await immutable(method.recipeUserId.getAsString()) === recipe) return candidate;
  }
  return exactOrigin;
}

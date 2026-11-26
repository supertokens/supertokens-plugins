import SuperTokens from "supertokens-node";
import Session from "supertokens-node/recipe/session";
import { EmailVerificationClaim } from "supertokens-node/recipe/emailverification";
import { RowndEmailChangeError, RowndSignInMethodError } from "./errors";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { User } from "supertokens-node/types";
import type { JsonRecord } from "./utils";
import { clearSuperTokensCoreCallCache, isRecord } from "./utils";
import type { SessionContainerInterface } from "supertokens-node/recipe/session/types";
import { getRawUserMetadata, type RowndMetadata } from "./rownd-compatibility";
import { resolveCanonicalEmailForTenant } from "./canonical-email";
import { readOwnerPlanCheckpoint, ambiguousOwnerSessionAliases } from "./migration-owner-plan";
import { assertCompletedPlan } from "./migration-consolidation";

export const SESSION_AUTHENTICATION_KEY = "rownd_session_authentication";
const PASSWORDLESS_AUTHENTICATION_RECEIPT = "rownd_passwordless_authentication_receipt";
const PASSWORDLESS_RECEIPT_BINDING = "rownd_passwordless_binding";
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

// Core assigns the handle after creation. Bind the database proof to an opaque
// value in the signed token instead of updating the newly created session.
export function passwordlessSessionReceipt(
  inspection: { user?: User; combinedMetadata: RowndMetadata },
  sessionRecipeId: string,
  tenantId: string,
  { recipeUserId, email, authenticatedAt }: { recipeUserId: string; email: string; authenticatedAt: number },
) {
  const { user, combinedMetadata } = inspection;
  if (!user || sessionRecipeId !== recipeUserId) return undefined;
  const normalizedEmail = email.trim().toLowerCase();
  const method = user?.loginMethods.find((entry) => entry.recipeId === "passwordless" &&
    entry.recipeUserId.getAsString() === recipeUserId && entry.tenantIds.includes(tenantId));
  if (!method?.verified || method.email?.trim().toLowerCase() !== normalizedEmail) return undefined;
  const canonical = resolveCanonicalEmailForTenant({ user, metadata: combinedMetadata, tenantId, passwordlessOnly: true });
  if (canonical.status !== "SELECTED" || canonical.recipeUserIds.length !== 1 || canonical.recipeUserIds[0] !== recipeUserId) return undefined;
  const binding = randomUUID();
  return {
    accessTokenPayload: { [PASSWORDLESS_RECEIPT_BINDING]: binding },
    sessionDataInDatabase: { [PASSWORDLESS_AUTHENTICATION_RECEIPT]: {
      version: 2, userId: user.id, tenantId, recipeUserId, email: normalizedEmail, authenticatedAt,
      binding,
    } },
  };
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
  const owner = await SuperTokens.getUser(sessionUserId, userContext);
  const expectedOwner = userId === sessionUserId ? owner : await SuperTokens.getUser(userId, userContext);
  // Read the database last: creation time and a still-valid stateless JWT cannot
  // prove that the initiating session survived the preceding graph reads.
  const information = await Session.getSessionInformation(session.getHandle(userContext), userContext);
  const data = information?.sessionDataInDatabase;
  const receipt = isRecord(data) ? data[PASSWORDLESS_AUTHENTICATION_RECEIPT] : undefined;
  // Core may return the internal primary ID while the container exposes its mapped alias.
  if (!information || (information.userId !== sessionUserId && information.userId !== immutableSessionUserId) || information.tenantId !== tenantId ||
    information.sessionHandle !== session.getHandle(userContext) ||
    information.recipeUserId.getAsString() !== session.getRecipeUserId(userContext).getAsString() ||
    !owner || owner.id !== expectedOwner?.id ||
    !isRecord(receipt) || receipt.tenantId !== tenantId || receipt.email !== email.trim().toLowerCase() ||
    !(receipt.version === 1
      ? receipt.userId === userId && receipt.recipeUserId === recipeUserId && receipt.sessionHandle === session.getHandle(userContext)
      : receipt.version === 2 && receipt.userId === owner.id && receipt.recipeUserId === session.getRecipeUserId(userContext).getAsString() &&
        typeof receipt.binding === "string" && receipt.binding === session.getAccessTokenPayload()[PASSWORDLESS_RECEIPT_BINDING]) ||
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

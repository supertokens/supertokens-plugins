import supertokens from "supertokens-node";
import Session from "supertokens-node/recipe/session";
import SessionRecipe from "supertokens-node/lib/build/recipe/session/recipe";
import { clearSessionFromAllTokenTransferMethods } from "supertokens-node/lib/build/recipe/session/cookieAndHeaders";
import type { SessionContainerInterface } from "supertokens-node/recipe/session/types";
import type { UserContext } from "supertokens-node/types";
import type { RowndEmailChangeSessionsRevokedError } from "./errors";
import { logDebugMessage } from "./logger";
import { validateConsumedPasswordlessEmail } from "./supertokens-repository";
import { clearSuperTokensCoreCallCache } from "./utils";

export const EMAIL_CHANGE_COMPLETION_FAILED_ERROR =
  "email change could not be completed; try again";
export const EMAIL_CHANGE_REPLACEMENT_SESSION_FAILED_ERROR =
  "email change completed; sign in again with the verified email";

type SessionRequest = Parameters<typeof Session.createNewSession>[0];
type SessionResponse = Parameters<typeof Session.createNewSession>[1];

// The callers have already revoked the sessions in Core, so only the response
// needs changing. SessionContainer.revokeSession clears tokens only after its own
// Core call succeeds, which would leave the client holding a dead session when
// that call fails. This is the SDK's own helper for clearing tokens on an error.
export function clearClientSession(
  req: SessionRequest,
  res: SessionResponse,
  userContext: UserContext,
) {
  clearSessionFromAllTokenTransferMethods(
    SessionRecipe.getInstanceOrThrowError().config,
    res,
    req,
    userContext,
  );
}

// Completion revokes the initiating session as its single-use lock, so a
// failure afterwards would leave the client holding a dead session. When the
// identity graph was rolled back, re-issue a session for the original recipe
// user, provided passwordless sign-in would still accept it. Otherwise clear the
// client's tokens so it re-authenticates now instead of being silently signed
// out on its next refresh.
export async function restoreSessionAfterFailedEmailChange(input: {
  error: RowndEmailChangeSessionsRevokedError;
  session: SessionContainerInterface | undefined;
  req: SessionRequest;
  res: SessionResponse;
  userContext: UserContext;
}): Promise<void> {
  const { error } = input;
  const outcome = await restoreOriginalSession(input);
  logDebugMessage(
    `email_change_session_recovery step=${error.step} userId=${error.userId} recipeUserId=${error.recoverableRecipeUserId ?? "none"} outcome=${outcome}`,
  );
  if (outcome !== "restored") {
    clearClientSession(input.req, input.res, input.userContext);
  }
}

async function restoreOriginalSession(
  input: Parameters<typeof restoreSessionAfterFailedEmailChange>[0],
): Promise<
  | "restored"
  | "no-session"
  | "not-recoverable"
  | "identity-changed"
  | "credential-not-authorized"
  | "failed"
> {
  const { error, session, userContext } = input;
  const recoverableRecipeUserId = error.recoverableRecipeUserId;
  if (!session) return "no-session";
  if (!recoverableRecipeUserId) return "not-recoverable";
  const tenantId = session.getTenantId(userContext);
  try {
    clearSuperTokensCoreCallCache(userContext);
    const owner = await supertokens.getUser(recoverableRecipeUserId, userContext);
    const method = owner?.loginMethods.find(
      (candidate) =>
        candidate.recipeUserId.getAsString() === recoverableRecipeUserId &&
        candidate.tenantIds.includes(tenantId),
    );
    if (!owner || owner.id !== error.userId || !method) {
      return "identity-changed";
    }
    if (method.recipeId === "passwordless" && method.email !== undefined) {
      const authorization = await validateConsumedPasswordlessEmail({
        userId: owner.id,
        email: method.email,
        tenantId,
        createdNewRecipeUser: false,
        recipeUserId: recoverableRecipeUserId,
        userContext,
      });
      if (authorization.status !== "ALLOW") return "credential-not-authorized";
    }
    await Session.createNewSession(
      input.req,
      input.res,
      tenantId,
      method.recipeUserId,
      {},
      {},
      userContext,
    );
  } catch {
    return "failed";
  }
  return "restored";
}

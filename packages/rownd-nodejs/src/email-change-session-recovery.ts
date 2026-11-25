import supertokens from "supertokens-node";
import Session from "supertokens-node/recipe/session";
import type { SessionContainerInterface } from "supertokens-node/recipe/session/types";
import type { UserContext } from "supertokens-node/types";
import type { RowndEmailChangeSessionsRevokedError } from "./errors";
import { logDebugMessage } from "./logger";
import { clearSuperTokensCoreCallCache } from "./utils";

export const EMAIL_CHANGE_COMPLETION_FAILED_ERROR =
  "email change could not be completed; try again";

type SessionRequest = Parameters<typeof Session.createNewSession>[0];
type SessionResponse = Parameters<typeof Session.createNewSession>[1];

// Completion revokes the initiating session as its single-use lock, so a
// failure afterwards would leave the client holding a dead session. When the
// identity graph was rolled back, re-issue a session for the original recipe
// user. Otherwise clear the client's tokens so it re-authenticates now instead
// of being silently signed out on its next refresh.
export async function restoreSessionAfterFailedEmailChange(input: {
  error: RowndEmailChangeSessionsRevokedError;
  session: SessionContainerInterface | undefined;
  req: SessionRequest;
  res: SessionResponse;
  userContext: UserContext;
}): Promise<"RESTORED" | "CLEARED"> {
  const { error, session, userContext } = input;
  if (!session) return "CLEARED";
  const log = (outcome: string) =>
    logDebugMessage(
      `email_change_session_recovery step=${error.step} userId=${error.userId} recipeUserId=${error.recoverableRecipeUserId ?? "none"} outcome=${outcome}`,
    );
  const clear = async (outcome: string) => {
    log(outcome);
    await Promise.allSettled([session.revokeSession(userContext)]);
    return "CLEARED" as const;
  };

  if (!error.recoverableRecipeUserId) return clear("not-recoverable");
  const tenantId = session.getTenantId(userContext);
  clearSuperTokensCoreCallCache(userContext);
  let owner;
  try {
    owner = await supertokens.getUser(error.recoverableRecipeUserId, userContext);
  } catch {
    return clear("identity-lookup-failed");
  }
  const method = owner?.loginMethods.find(
    (candidate) =>
      candidate.recipeUserId.getAsString() === error.recoverableRecipeUserId &&
      candidate.tenantIds.includes(tenantId),
  );
  if (!owner || owner.id !== error.userId || !method) {
    return clear("identity-changed");
  }
  try {
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
    return clear("session-creation-failed");
  }
  log("restored");
  return "RESTORED";
}

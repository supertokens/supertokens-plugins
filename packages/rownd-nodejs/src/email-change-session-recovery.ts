import supertokens from "supertokens-node";
import Session from "supertokens-node/recipe/session";
import type { APIOptions } from "supertokens-node/recipe/emailverification";
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

type SessionRequest = APIOptions["req"];
type SessionResponse = APIOptions["res"];

type ClearSessionFromResponse = (
  req: SessionRequest,
  res: SessionResponse,
  userContext: UserContext,
) => void;

let responseClearer: Promise<ClearSessionFromResponse | undefined> | undefined;

async function resolveResponseClearer(): Promise<ClearSessionFromResponse | undefined> {
  try {
    const [recipeModule, { clearSessionFromAllTokenTransferMethods }] = await Promise.all([
      import("supertokens-node/lib/build/recipe/session/recipe"),
      import("supertokens-node/lib/build/recipe/session/cookieAndHeaders"),
    ]);
    // Native ESM wraps the SDK's CommonJS default export in module.exports.
    const recipeExport = recipeModule.default as
      | typeof recipeModule.default
      | { default: typeof recipeModule.default }
      | undefined;
    const recipe = recipeExport && "default" in recipeExport ? recipeExport.default : recipeExport;
    if (
      typeof recipe?.getInstanceOrThrowError !== "function" ||
      typeof clearSessionFromAllTokenTransferMethods !== "function"
    ) return undefined;

    return (req, res, userContext) => clearSessionFromAllTokenTransferMethods(
      recipe.getInstanceOrThrowError().config,
      res,
      req,
      userContext,
    );
  } catch {
    return undefined;
  }
}

export async function clearClientSession(
  req: SessionRequest,
  res: SessionResponse,
  userContext: UserContext,
  session: SessionContainerInterface | undefined,
): Promise<void> {
  try {
    try {
      // The sessions were revoked in Core. Clear both transfer methods using the
      // app's cookie config, without relying on another Core call to succeed.
      const clearResponse = await (responseClearer ??= resolveResponseClearer());
      if (clearResponse) {
        clearResponse(req, res, userContext);
        return;
      }
    } catch {
      // The internal helper may also become incompatible at invocation time.
    }

    logDebugMessage("email_change_session_cleanup using public session fallback");
    try {
      await session?.revokeSession(userContext);
    } catch {
      // Revoke is best-effort; the response still signals removal below.
    }
  } finally {
    res.setHeader("front-token", "remove", false);
    res.setHeader("Access-Control-Expose-Headers", "front-token", true);
  }
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
    await clearClientSession(input.req, input.res, input.userContext, input.session);
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

import SuperTokens from "supertokens-node";
import { AsyncLocalStorage } from "node:async_hooks";
import type { User } from "supertokens-node/types";
import type { JsonRecord } from "./utils";
import { getRawUserMetadata } from "./rownd-compatibility";
import { readOwnerPlanCheckpoint, ambiguousOwnerSessionAliases } from "./migration-owner-plan";
import { assertCompletedPlan } from "./migration-consolidation";

export const SESSION_AUTHENTICATION_KEY = "rownd_session_authentication";
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
  const recipe = await immutable(recipeUserId);
  for (const method of user.loginMethods) {
    if (await immutable(method.recipeUserId.getAsString()) !== recipe) continue;
    if (method.thirdParty?.id === "instant") return "instant";
    if (method.thirdParty?.id !== "guest") return "authenticated";
  }
  return undefined;
}

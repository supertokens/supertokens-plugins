import { createHash } from "node:crypto";
import SuperTokens from "supertokens-node";
import Multitenancy from "supertokens-node/recipe/multitenancy";
import Session from "supertokens-node/recipe/session";
import PasswordlessRecipe from "supertokens-node/lib/build/recipe/passwordless/recipe";
import type { SessionContainerInterface } from "supertokens-node/recipe/session/types";
import { isEmailSignInEnabled } from "./config";
import { isSyntheticEmail, resolveCanonicalEmailForTenant } from "./canonical-email";
import { getPrimaryUserMetadata, type SuperTokensLoginMethod } from "./rownd-compatibility";
import { completeDisconnectedSignInMethod, getDisconnectedSignInMethods, recordDisconnectedSignInMethod } from "./disconnected-sign-in-identities";
import { assertRetainedPasswordlessAuthentication, assertRetainedPasswordlessAuthenticationFresh, immutableRecipeUserId } from "./session-authentication";
import { RowndSignInMethodError } from "./errors";
import type { RowndPluginNormalisedConfig } from "./types";
import { clearSuperTokensCoreCallCache, isRecord, type JsonRecord } from "./utils";

export type ConnectedSignInMethod = {
  id: string;
  kind: "email" | "phone" | "sso";
  provider?: string;
  identifier?: string;
  verified: boolean;
  can_disconnect: boolean;
  disconnect_block_reason?: string;
};

type Input = {
  session: SessionContainerInterface;
  config: RowndPluginNormalisedConfig;
  appVariantId?: string;
  userContext: JsonRecord;
};

function conflict(message = "The account changed. Reload your sign-in methods before retrying."): never {
  throw new RowndSignInMethodError("SIGN_IN_METHOD_ACCOUNT_CHANGED", 409, message);
}

function methodId(owner: string, tenant: string, identity: string[]) {
  return createHash("sha256").update(JSON.stringify([owner, tenant, ...identity])).digest("hex");
}

function isRealSSO(method: SuperTokensLoginMethod) {
  return method.recipeId === "thirdparty" && !!method.thirdParty &&
    !["guest", "instant"].includes(method.thirdParty.id);
}

export function connectedSignInMethodsAreAvailable(config: RowndPluginNormalisedConfig) {
  return config.connectedSignInMethods?.enabled === true &&
    ["session", "usermetadata", "passwordless", "accountlinking", "multitenancy"].every((recipe) => SuperTokens.isRecipeInitialized(recipe));
}

export function assertConnectedSignInMethodsEnabled(config: RowndPluginNormalisedConfig) {
  if (!connectedSignInMethodsAreAvailable(config)) {
    throw new RowndSignInMethodError("SIGN_IN_METHODS_UNAVAILABLE", 404, "Connected sign-in methods are not available.");
  }
}

async function retainedEmailIsEnabled(input: Input, tenantId: string) {
  if (!isEmailSignInEnabled(input.config, input.appVariantId) || !SuperTokens.isRecipeInitialized("passwordless")) return false;
  const { contactMethod, flowType } = PasswordlessRecipe.getInstanceOrThrowError().config;
  if (contactMethod === "PHONE") return false;
  const tenant = await Multitenancy.getTenant(tenantId, input.userContext);
  if (!tenant) return false;
  const factors = flowType === "MAGIC_LINK" ? ["link-email"] : flowType === "USER_INPUT_CODE" ? ["otp-email"] : ["link-email", "otp-email"];
  return tenant.firstFactors === undefined || tenant.firstFactors.some((factor) => factors.includes(factor));
}

async function readState(input: Input) {
  const { session, userContext } = input;
  clearSuperTokensCoreCallCache(userContext);
  const user = await SuperTokens.getUser(session.getUserId(userContext), userContext);
  if (!user) conflict();
  const owner = await immutableRecipeUserId(user.id, userContext);
  const mapping = await SuperTokens.getUserIdMapping({ userId: owner, userIdType: "SUPERTOKENS", userContext });
  if (mapping.status === "OK" && (mapping.superTokensUserId !== owner || mapping.externalUserId !== user.id)) conflict();
  const metadata = await getPrimaryUserMetadata(user.id, userContext, session.getTenantId(userContext));
  const tenantId = session.getTenantId(userContext);
  const canonical = resolveCanonicalEmailForTenant({ user, metadata, tenantId, passwordlessOnly: true });
  const canonicalMethods = canonical.status === "SELECTED" && canonical.recipeUserIds.length === 1
    ? user.loginMethods.filter((method) => canonical.recipeUserIds.includes(method.recipeUserId.getAsString()) &&
      method.recipeId === "passwordless" && method.verified && method.tenantIds.includes(tenantId) &&
      !!method.email && !isSyntheticEmail(method.email)) : [];
  const pending = metadata.rownd_pending_verification;
  const pendingEmail = pending !== undefined && (!Array.isArray(pending) || pending.some((entry) =>
    !isRecord(entry) || ((entry.tenantId ?? "public") === tenantId && entry.field === "email")));
  const retained = canonicalMethods.length === 1 && await retainedEmailIsEnabled(input, tenantId)
    ? canonicalMethods[0] : undefined;
  const retainedRecipe = retained ? await immutableRecipeUserId(retained.recipeUserId.getAsString(), userContext) : undefined;
  const records = await getDisconnectedSignInMethods(owner, userContext);
  return { user, owner, mapping, tenantId, retained, retainedRecipe, pendingEmail, records };
}

type State = Awaited<ReturnType<typeof readState>>;

function blockReason(state: State, method: SuperTokensLoginMethod) {
  if (!isRealSSO(method)) return "SIGN_IN_METHOD_READ_ONLY";
  if (state.records.some((record) => record.tenantId === state.tenantId && record.providerId === method.thirdParty!.id &&
    record.providerUserId === method.thirdParty!.userId && record.completed === true)) return "SIGN_IN_METHOD_ALREADY_DISCONNECTED";
  if (!isPendingDisconnect(state, method) && (method.tenantIds.length !== 1 || method.tenantIds[0] !== state.tenantId)) {
    return "SIGN_IN_METHOD_MULTIPLE_TENANTS";
  }
  return retainedFactorBlockReason(state);
}

function retainedFactorBlockReason(state: State) {
  if (state.pendingEmail) return "SIGN_IN_METHOD_EMAIL_CHANGE_PENDING";
  if (!state.retained || !state.user.isPrimaryUser) return "SIGN_IN_METHOD_RETAINED_EMAIL_REQUIRED";
  return undefined;
}

function isPendingDisconnect(state: State, method: SuperTokensLoginMethod) {
  return isRealSSO(method) && method.tenantIds.length === 0 && state.records.some((record) => record.tenantId === state.tenantId &&
    record.providerId === method.thirdParty!.id && record.providerUserId === method.thirdParty!.userId);
}

function idForMethod(state: State, method: SuperTokensLoginMethod) {
  return methodId(state.owner, state.tenantId, isRealSSO(method)
    ? ["thirdparty", method.thirdParty!.id, method.thirdParty!.userId]
    : [method.recipeId, method.recipeUserId.getAsString()]);
}

function reauthentication(state: State): { method: "email"; identifier: string } | null {
  return state.retained?.email ? { method: "email", identifier: state.retained.email } : null;
}

export async function listConnectedSignInMethods(input: Input) {
  assertConnectedSignInMethodsEnabled(input.config);
  const state = await readState(input);
  const methods = state.user.loginMethods.flatMap<ConnectedSignInMethod>((method) => {
    if (!method.tenantIds.includes(state.tenantId) && !isPendingDisconnect(state, method)) return [];
    const reason = blockReason(state, method);
    const base = { id: idForMethod(state, method), verified: method.verified, can_disconnect: reason === undefined,
      ...(reason ? { disconnect_block_reason: reason } : {}) };
    if (isRealSSO(method)) return [{ ...base, kind: "sso" as const, provider: method.thirdParty!.id,
      ...(method.email && !isSyntheticEmail(method.email) ? { identifier: method.email } : {}) }];
    if (method.recipeId === "passwordless" && method.phoneNumber) return [{ ...base, kind: "phone" as const, identifier: method.phoneNumber }];
    if (["passwordless", "emailpassword"].includes(method.recipeId) && method.email && !isSyntheticEmail(method.email)) {
      return [{ ...base, kind: "email" as const, identifier: method.email }];
    }
    return [];
  });
  for (const record of state.records) {
    if (record.tenantId !== state.tenantId || record.completed === true) continue;
    const id = methodId(state.owner, state.tenantId, ["thirdparty", record.providerId, record.providerUserId]);
    if (methods.some((method) => method.id === id)) continue;
    const live = state.user.loginMethods.find((method) => isRealSSO(method) &&
      method.thirdParty!.id === record.providerId && method.thirdParty!.userId === record.providerUserId);
    const reason = live ? blockReason(state, live) : retainedFactorBlockReason(state);
    // A deleted recipe can still owe revocation or final verification. Only
    // unfinished checkpoints become recovery rows; permanent suppression stays.
    methods.push({ id, kind: "sso", provider: record.providerId, verified: false, can_disconnect: reason === undefined,
      ...(reason ? { disconnect_block_reason: reason } : {}) });
  }
  return { status: "OK" as const, user_id: state.user.id, tenant_id: state.tenantId, methods,
    reauthentication: reauthentication(state) };
}

export async function disconnectConnectedSignInMethod(input: Input & { body: unknown }) {
  assertConnectedSignInMethodsEnabled(input.config);
  const { body, session, userContext } = input;
  if (!isRecord(body) || [body.method_id, body.expected_user_id, body.expected_tenant_id].some((value) =>
    typeof value !== "string" || !value)) {
    throw new RowndSignInMethodError("SIGN_IN_METHOD_INVALID_REQUEST", 409, "Method and expected account and tenant are required.");
  }
  const state = await readState(input);
  if (body.expected_user_id !== state.user.id || body.expected_tenant_id !== state.tenantId) conflict();
  const selected = state.user.loginMethods.find((method) => (method.tenantIds.includes(state.tenantId) || isPendingDisconnect(state, method)) &&
    idForMethod(state, method) === body.method_id);
  const checkpoint = state.records.find((record) => record.tenantId === state.tenantId &&
    methodId(state.owner, state.tenantId, ["thirdparty", record.providerId, record.providerUserId]) === body.method_id);
  if (!selected && !checkpoint) {
    throw new RowndSignInMethodError("SIGN_IN_METHOD_NOT_FOUND", 409, "This sign-in method does not belong to the current account.");
  }
  if (checkpoint?.completed === true) {
    throw new RowndSignInMethodError("SIGN_IN_METHOD_ALREADY_DISCONNECTED", 409, "This sign-in method was already disconnected.");
  }
  const reason = selected ? blockReason(state, selected) : retainedFactorBlockReason(state);
  if (reason) throw new RowndSignInMethodError(reason, 409, "This sign-in method cannot be disconnected.");
  if (!state.retained?.email || !state.retainedRecipe) conflict();
  const retainedEmail = state.retained.email;
  const sdkUserId = state.user.id;
  const mappingSnapshot = JSON.stringify(state.mapping);
  const proofInput = { session, userId: state.owner, tenantId: state.tenantId,
    recipeUserId: state.retainedRecipe, email: retainedEmail, userContext };
  let proof = await assertRetainedPasswordlessAuthentication(proofInput);
  const target = {
    userId: state.owner, tenantId: state.tenantId,
    recipeUserId: checkpoint?.recipeUserId ?? await immutableRecipeUserId(selected!.recipeUserId.getAsString(), userContext),
    providerId: checkpoint?.providerId ?? selected!.thirdParty!.id,
    providerUserId: checkpoint?.providerUserId ?? selected!.thirdParty!.userId,
  };
  const verify = async () => {
    const fresh = await readState(input);
    if (fresh.owner !== state.owner || fresh.user.id !== sdkUserId || !fresh.user.isPrimaryUser ||
      JSON.stringify(fresh.mapping) !== mappingSnapshot || fresh.retainedRecipe !== state.retainedRecipe ||
      fresh.retained?.email !== retainedEmail || fresh.pendingEmail) conflict();
    const matching = fresh.user.loginMethods.filter((method) => isRealSSO(method) &&
      method.thirdParty!.id === target.providerId && method.thirdParty!.userId === target.providerUserId);
    if (matching.length > 1) conflict();
    const method = matching[0];
    if (method && (method.tenantIds.some((tenant) => tenant !== state.tenantId) ||
      await immutableRecipeUserId(method.recipeUserId.getAsString(), userContext) !== target.recipeUserId)) conflict();
    const targetOwner = await SuperTokens.getUser(target.recipeUserId, userContext);
    if (targetOwner && await immutableRecipeUserId(targetOwner.id, userContext) !== state.owner) conflict();
    return method;
  };
  await verify();
  // Intent precedes every destructive call and is never rolled back, including
  // when Core commits a write but the caller loses its response.
  await recordDisconnectedSignInMethod(target, userContext, async () => {
    await verify();
    proof = await assertRetainedPasswordlessAuthentication(proofInput);
  });
  // Some SDK authentication flows reuse a retained-factor session. Revoke the
  // whole account now as well as on completion so partial failures cannot keep it.
  assertRetainedPasswordlessAuthenticationFresh(proof);
  await Session.revokeAllSessionsForUser(state.owner, true, undefined, userContext);
  let method = await verify();
  if (target.recipeUserId !== state.owner) {
    if (method?.tenantIds.includes(state.tenantId)) {
      assertRetainedPasswordlessAuthenticationFresh(proof);
      const removed = await Multitenancy.disassociateUserFromTenant(state.tenantId, method.recipeUserId, userContext);
      if (removed.status !== "OK") conflict("Credential tenant removal did not complete; retry after signing in with email.");
    }
    method = await verify();
    if (method?.tenantIds.includes(state.tenantId)) conflict("Credential tenant removal is incomplete.");
  }
  if (method) {
    // Disassociating a primary anchor also deletes the account's tenant roles
    // and TOTP. Recipe-only deletion preserves them, its ID and mapping while
    // the verified canonical Passwordless credential remains attached.
    assertRetainedPasswordlessAuthenticationFresh(proof);
    await SuperTokens.deleteUser(target.recipeUserId, false, userContext);
  }
  if (await verify()) conflict("Credential removal is incomplete.");
  assertRetainedPasswordlessAuthenticationFresh(proof);
  await Session.revokeAllSessionsForUser(state.owner, true, undefined, userContext);
  await session.revokeSession(userContext);
  if ((await Session.getAllSessionHandlesForUser(state.owner, true, undefined, userContext)).length) {
    conflict("Account session revocation is incomplete; retry after signing in with email.");
  }
  if (await verify()) conflict("Credential removal is incomplete.");
  await completeDisconnectedSignInMethod(target, userContext);
  return { status: "OK" as const, signed_out: true as const };
}

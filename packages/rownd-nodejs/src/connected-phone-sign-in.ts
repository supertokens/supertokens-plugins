import SuperTokens from "supertokens-node";
import AccountLinking from "supertokens-node/recipe/accountlinking";
import Multitenancy from "supertokens-node/recipe/multitenancy";
import MultitenancyRecipe from "supertokens-node/lib/build/recipe/multitenancy/recipe";
import Passwordless from "supertokens-node/recipe/passwordless";
import PasswordlessRecipe from "supertokens-node/lib/build/recipe/passwordless/recipe";
import { getUserContext } from "supertokens-node/lib/build/utils";
import Session from "supertokens-node/recipe/session";
import type { SessionContainerInterface } from "supertokens-node/recipe/session/types";
import type { User } from "supertokens-node/types";
import { RowndSignInMethodError } from "./errors";
import { isSyntheticEmail } from "./canonical-email";
import { immutableRecipeUserId, sessionAuthenticationOrigin } from "./session-authentication";
import type { RowndPluginNormalisedConfig } from "./types";
import { clearSuperTokensCoreCallCache, createDerivedUserContext, isRecord, type JsonRecord } from "./utils";

const PENDING_PHONE = "rownd_pending_phone_sign_in";
const RESEND_DELAY_MS = 30_000;
const MAX_AGE_MS = 600_000;
const PHONE_ENROLLMENT_LINK = Symbol("rownd phone enrollment link");

type Input = {
  session: SessionContainerInterface;
  config: RowndPluginNormalisedConfig;
  appVariantId?: string;
  userContext: JsonRecord;
};

function restart(): never {
  throw new RowndSignInMethodError("PHONE_ENROLLMENT_RESTART", 409, "Request a new code to add your phone number.");
}

function unavailable(): never {
  throw new RowndSignInMethodError("PHONE_ENROLLMENT_UNAVAILABLE", 409, "Phone sign-in can't be added to this account.");
}

function numberUnavailable(): never {
  throw new RowndSignInMethodError("PHONE_ENROLLMENT_NUMBER_UNAVAILABLE", 409, "This number can't be added. Try another number.");
}

function binding(input: Input, owner: string) {
  const { session, userContext } = input;
  return {
    owner,
    userId: session.getUserId(userContext),
    recipeUserId: session.getRecipeUserId(userContext).getAsString(),
    tenantId: session.getTenantId(userContext),
    sessionHandle: session.getHandle(userContext),
    variant: input.appVariantId ?? null,
  };
}

export async function phoneEnrollmentIsAvailable(input: Input, user: User) {
  const tenantId = input.session.getTenantId(input.userContext);
  const base = input.config.appConfig;
  const variant = input.appVariantId ? input.config.subBrands?.[input.appVariantId] : undefined;
  const methods = variant?.signInMethods ?? base?.signInMethods;
  const showAdd = variant?.profile?.addSignInMethodsButton?.enabled ?? base?.profile?.addSignInMethodsButton?.enabled;
  if (showAdd === false ||
    !methods?.some(({ method }) => method === "phone") ||
    user.loginMethods.some((method) => method.phoneNumber && method.recipeId === "passwordless" && method.tenantIds.includes(tenantId))) return false;
  const passwordless = PasswordlessRecipe.getInstanceOrThrowError().config;
  if (passwordless.contactMethod === "EMAIL" || passwordless.flowType === "MAGIC_LINK") return false;
  const sessionMethod = user.loginMethods.find((method) => method.tenantIds.includes(tenantId) &&
    method.recipeUserId.getAsString() === input.session.getRecipeUserId(input.userContext).getAsString());
  if (!sessionMethod?.verified || !sessionMethod.email || isSyntheticEmail(sessionMethod.email) ||
    !["passwordless", "emailpassword"].includes(sessionMethod.recipeId)) return false;
  const tenant = await Multitenancy.getTenant(tenantId, input.userContext);
  const firstFactors = tenant?.firstFactors ?? MultitenancyRecipe.getInstanceOrThrowError().staticFirstFactors;
  if (!tenant || (firstFactors && !firstFactors.includes("otp-phone") &&
    !(passwordless.flowType === "USER_INPUT_CODE_AND_MAGIC_LINK" && firstFactors.includes("link-phone")))) return false;
  return await sessionAuthenticationOrigin(user, sessionMethod.recipeUserId.getAsString(),
    input.session.getAccessTokenPayload(input.userContext), input.userContext) === "authenticated";
}

async function currentOwner(input: Input, body: unknown) {
  const { session, userContext } = input;
  clearSuperTokensCoreCallCache(userContext);
  if (!isRecord(body) || body.expected_user_id !== session.getUserId(userContext) ||
    body.expected_tenant_id !== session.getTenantId(userContext)) restart();
  const user = await SuperTokens.getUser(session.getUserId(userContext), userContext);
  if (!user || user.id !== body.expected_user_id || !(await phoneEnrollmentIsAvailable(input, user))) unavailable();
  const owner = await immutableRecipeUserId(user.id, userContext);
  return { user, scope: binding(input, owner) };
}

async function liveSession(input: Input, scope: ReturnType<typeof binding>) {
  const { userContext } = input;
  const internalRecipeId = await immutableRecipeUserId(scope.recipeUserId, userContext);
  clearSuperTokensCoreCallCache(userContext);
  const result = await Session.getSessionInformation(scope.sessionHandle, userContext);
  if (!result || result.expiry <= Date.now() || result.tenantId !== scope.tenantId ||
    (result.userId !== scope.userId && result.userId !== scope.owner) ||
    ![scope.recipeUserId, internalRecipeId].includes(result.recipeUserId.getAsString())) restart();
  return result.sessionDataInDatabase;
}

function readChallenge(data: unknown, scope: ReturnType<typeof binding>) {
  const pending = isRecord(data) ? data[PENDING_PHONE] : undefined;
  if (!isRecord(pending) || !Object.entries(scope).every(([key, value]) => pending[key] === value) ||
    typeof pending.expiresAt !== "number" || pending.expiresAt <= Date.now() || typeof pending.sentAt !== "number" ||
    typeof pending.preAuthSessionId !== "string" || typeof pending.deviceId !== "string" ||
    typeof pending.phoneNumber !== "string") return;
  return { sentAt: pending.sentAt, preAuthSessionId: pending.preAuthSessionId,
    deviceId: pending.deviceId, phoneNumber: pending.phoneNumber };
}

export function checkPhoneEnrollmentLink(userContext: JsonRecord, owner: string, candidate: string) {
  const check = Reflect.get(userContext, PHONE_ENROLLMENT_LINK) as
    ((owner: string, candidate: string) => Promise<void>) | undefined;
  return check?.(owner, candidate);
}

async function assertNumberAvailable(input: Input, tenantId: string, phoneNumber: string, newRecipeUserId?: string) {
  clearSuperTokensCoreCallCache(input.userContext);
  const owners = await SuperTokens.listUsersByAccountInfo(tenantId, { phoneNumber }, false, input.userContext);
  if (owners.some((owner) => owner.id !== newRecipeUserId)) numberUnavailable();
}

export async function startPhoneEnrollment(input: Input, body: unknown) {
  const { scope } = await currentOwner(input, body);
  const phoneNumber = isRecord(body) ? body.phone_number : undefined;
  const { tenantId } = scope;
  const { config } = PasswordlessRecipe.getInstanceOrThrowError();
  if (typeof phoneNumber !== "string" || !/^\+[1-9]\d{6,14}$/.test(phoneNumber) || config.contactMethod === "EMAIL" ||
    await config.validatePhoneNumber(phoneNumber, tenantId) !== undefined) {
    throw new RowndSignInMethodError("PHONE_ENROLLMENT_INVALID_NUMBER", 409, "Enter a valid phone number in international format.");
  }
  await assertNumberAvailable(input, tenantId, phoneNumber);
  const accountInfo = { recipeId: "passwordless" as const, phoneNumber };
  if (!await AccountLinking.isSignUpAllowed(tenantId, accountInfo, true, input.session, input.userContext)) unavailable();
  const checkCooldown = (data: unknown) => {
    const prior = readChallenge(data, scope);
    if (prior && Date.now() - prior.sentAt < RESEND_DELAY_MS) {
      throw new RowndSignInMethodError("PHONE_ENROLLMENT_WAIT", 409, "Wait 30 seconds before requesting another code.");
    }
  };
  checkCooldown(await liveSession(input, scope));
  const code = await Passwordless.createCode({ tenantId, phoneNumber, userContext: input.userContext,
    userInputCode: await config.getCustomUserInputCode?.(tenantId, getUserContext(input.userContext)) });
  const data = await liveSession(input, scope);
  checkCooldown(data);
  const sentAt = Date.now();
  await input.session.updateSessionDataInDatabase({
    ...(isRecord(data) ? data : {}),
    [PENDING_PHONE]: { ...scope, phoneNumber, sentAt, expiresAt: Math.min(code.timeCreated + code.codeLifetime, sentAt + MAX_AGE_MS),
      deviceId: code.deviceId, preAuthSessionId: code.preAuthSessionId },
  }, input.userContext);
  await Passwordless.sendSms({ type: "PASSWORDLESS_LOGIN", tenantId, phoneNumber, isFirstFactor: false,
    userInputCode: code.userInputCode, codeLifetime: code.codeLifetime, preAuthSessionId: code.preAuthSessionId,
    userContext: input.userContext });
  return { status: "OK" as const, challenge_id: code.preAuthSessionId };
}

export async function verifyPhoneEnrollment(input: Input, body: unknown) {
  const { user, scope } = await currentOwner(input, body);
  if (!isRecord(body) || typeof body.challenge_id !== "string" || typeof body.code !== "string" ||
    body.code.length === 0 || body.code.length > 128) restart();
  const { tenantId, userId, owner } = scope;
  const pending = readChallenge(await liveSession(input, scope), scope);
  if (!pending || pending.preAuthSessionId !== body.challenge_id) restart();
  const { phoneNumber, preAuthSessionId, deviceId } = pending;
  const requireChallenge = async () => {
    if (readChallenge(await liveSession(input, scope), scope)?.preAuthSessionId !== preAuthSessionId) restart();
  };
  await assertNumberAvailable(input, tenantId, phoneNumber);
  await requireChallenge();

  // Consume the exact SDK challenge without the normal sign-in/session path.
  // Only a newly created recipe user can be a candidate for explicit linking.
  const result = await Passwordless.consumeCode({ tenantId, preAuthSessionId, deviceId, userInputCode: body.code,
    userContext: createDerivedUserContext(input.userContext, { rowndDisableAutomaticAccountLinking: true }) });
  if (result.status === "INCORRECT_USER_INPUT_CODE_ERROR") {
    throw new RowndSignInMethodError("PHONE_ENROLLMENT_INCORRECT_CODE", 409, "That code is incorrect. Try again.");
  }
  if (result.status !== "OK") restart();
  if (!result.createdNewRecipeUser || result.consumedDevice.phoneNumber !== phoneNumber ||
    result.consumedDevice.preAuthSessionId !== preAuthSessionId || result.consumedDevice.email !== undefined) numberUnavailable();

  const candidate = result.recipeUserId.getAsString();
  const refreshed = await currentOwner(input, body);
  if (refreshed.scope.owner !== owner || refreshed.user.id !== user.id) restart();
  if (!refreshed.user.isPrimaryUser) {
    const promoted = await AccountLinking.createPrimaryUser(input.session.getRecipeUserId(input.userContext), input.userContext);
    if (promoted.status !== "OK" || promoted.user.id !== userId) unavailable();
  }
  const linkContext = createDerivedUserContext(input.userContext, {
    [PHONE_ENROLLMENT_LINK]: async (target: string, recipe: string) => {
      if (target !== owner || recipe !== candidate || (await currentOwner(input, body)).scope.owner !== owner) restart();
      await assertNumberAvailable(input, tenantId, phoneNumber, candidate);
      const fresh = await SuperTokens.getUser(candidate, input.userContext);
      const method = fresh?.loginMethods[0];
      if (!fresh || fresh.id !== candidate || fresh.isPrimaryUser || fresh.loginMethods.length !== 1 ||
        method?.recipeId !== "passwordless" || !method.verified || method.email !== undefined ||
        method.phoneNumber !== phoneNumber || method.tenantIds.length !== 1 || method.tenantIds[0] !== tenantId) numberUnavailable();
      await requireChallenge();
    },
  });
  const linked = await AccountLinking.linkAccounts(result.recipeUserId, owner, linkContext);
  if (linked.status !== "OK" || linked.user.id !== userId ||
    !linked.user.loginMethods.some((method) => method.recipeId === "passwordless" && method.recipeUserId.getAsString() === candidate &&
      method.verified && method.phoneNumber === phoneNumber && method.tenantIds.includes(tenantId))) numberUnavailable();
  return { status: "OK" as const, user_id: userId, tenant_id: tenantId };
}

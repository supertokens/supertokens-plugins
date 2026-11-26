import { SuperTokensPlugin, type PluginRouteHandler, type User, type UserContext } from "supertokens-node/types";
import {
  EmailVerificationClaim,
  type APIInterface as EmailVerificationAPIInterface,
} from "supertokens-node/recipe/emailverification";
import type {
  APIInterface as OAuth2ProviderAPIInterface,
  RecipeInterface as OAuth2ProviderRecipeInterface,
} from "supertokens-node/recipe/oauth2provider/types";
import type { APIInterface as PasswordlessAPIInterface } from "supertokens-node/recipe/passwordless";
import Session from "supertokens-node/recipe/session";
import type AccountLinking from "supertokens-node/recipe/accountlinking";
import type { APIInterface as ThirdPartyAPIInterface } from "supertokens-node/recipe/thirdparty";
import type {
  SessionContainerInterface,
  VerifySessionOptions,
} from "supertokens-node/recipe/session/types";
import { createPluginInitFunction } from "@shared/js";
import { withRequestHandler } from "@shared/nodejs";
import { createRowndClient } from "./rownd-client";
import supertokens from "supertokens-node";
import {
  HANDLE_BASE_PATH,
  HUB_VERIFY_EMAIL_PAGE_PATH,
  HUB_LOGIN_PAGE_PATH,
  PENDING_EMAIL_VERIFICATION_QUERY_PARAM,
  PLUGIN_ID,
  PLUGIN_SDK_VERSION,
  ROWND_JWT_CLAIMS,
} from "./constants";
import { RowndPluginConfig, RowndPluginNormalisedConfig } from "./types";
import { enableDebugLogs, logDebugMessage } from "./logger";
import { createClient } from "./telemetry/createTelemetryClient";
import {
  assertRowndAppVariantIsConfigured,
  isExplicitSignUpFlowEnabled,
  isEmailSignInEnabled,
  getConfigForUserContext,
  resolvePluginConfigSnapshot,
  setPluginConfig,
  setSuperTokensConfig,
  validateDynamicConfig,
} from "./config";
import { RowndEmailChangeError, RowndPasswordlessCleanupError, RowndSignInMethodError } from "./errors";
import {
  assertSignInIdentityNotIndexed,
  assertIdentityAllowedByOwner,
  assertNotRetiredPrimaryRecipe,
  deleteUserAndSignInMethodPolicy,
  assertSignInMethodLinkAllowed,
  assertSignInMethodTenantAssociationAllowed,
  checkSignInMethodAuthentication,
  readPolicyGate,
  realProvider,
  DisconnectedSignInMethodError,
} from "./disconnected-sign-in-identities";
import { logSignInMethodPolicy, signInMethodPolicyFailureLevel } from "./sign-in-method-policy-log";
import {
  applyRowndOAuthResourceParams,
  buildRowndOAuthPayload,
  buildRowndOAuthUserInfo,
  normalizeRowndOAuthScopes,
  doesRowndAccountInfoExist,
  findHistoricalEmailOwner,
  passwordlessHistoryOwner,
  linkHistoricalPasswordlessUser,
  type HistoricalPasswordlessScope,
  type PasswordlessAuthSnapshot,
  type PolicyPresence,
  shouldLinkRowndAccounts,
} from "./rownd-compatibility";
import { setRowndClient, setRowndTokenValidator } from "./rownd-repository";
import { createRowndTokenValidator } from "./rownd-token-validator";
import {
  buildRowndSessionAndAnonymousClaims,
  completePendingEmailVerification,
  deleteRejectedConsumedPasswordlessUser,
  addPendingEmailVerificationMarker,
  getPendingEmailVerificationIdFromUserContext,
  prepareEmailForPasswordlessAuth,
  recordRowndAppVariantForUser,
  resolvePendingEmailVerificationToken,
  validateConsumedPasswordlessEmail,
} from "./supertokens-repository";
import {
  getRequestedAppVariantIdFromRequest,
  getRequestedClientDomainFromRequest,
  getRequestedDisplayContextFromRequest,
  getRequestedOAuthLoginChallengeFromRequest,
  getRequestedRedirectToPathFromRequest,
  rewriteLinkToBaseUrl,
  rewriteLinkPath,
  createDerivedUserContext,
} from "./utils";
import {
  handleDeleteUser,
  handleConnectedSignInMethods,
  handleGetAppConfig,
  handleGetUser,
  handleGetUserField,
  handleGetUserMeta,
  handleGuestLogin,
  handleMigrationRequest,
  handleSignOut,
  handleUpdateUser,
  handleUpdateUserField,
  handleUpdateUserMeta,
  handleValidatePasswordlessConfirmationBypass,
} from "./pluginImplementation";

import { passwordlessSessionReceipt, withProvenSessionAuthentication } from "./session-authentication";
import { withAppleJwksRetry } from "./apple-jwks-retry";

const DISABLED_MIGRATION_ROWND_APP_KEY = "migration-disabled";
const PENDING_EMAIL_VERIFICATION_SESSION_ERROR =
  "email change verification requires the initiating session";
const INACTIVE_PASSWORDLESS_EMAIL_REASON = "No existing account found";
const THIRD_PARTY_AUTHENTICATION = Symbol("rownd.thirdPartyAuthentication");
const PASSWORDLESS_ISSUANCE = Symbol("rownd.passwordlessIssuance");
const PASSWORDLESS_LINK_CANDIDATE = Symbol("rownd.passwordlessLinkCandidate");
type PasswordlessIssuance = {
  consumed?: { recipeUserId: string; email: string; authenticatedAt: number };
  session?: SessionContainerInterface;
  linkingSession?: SessionContainerInterface;
  candidates?: PasswordlessAuthSnapshot["inspections"];
};
type ThirdPartyAuthenticationOperation = {
  actual?: { user: User; recipeUserId: string; tenantId: string; providerId: string; providerUserId: string };
  sessions: Set<SessionContainerInterface>;
};

function thirdPartyAuthenticationOperation(context: Record<string, any>) {
  return Reflect.get(context, THIRD_PARTY_AUTHENTICATION) as ThirdPartyAuthenticationOperation | undefined;
}

function logPolicyDenial(error: DisconnectedSignInMethodError, step: string, ownerId?: string) {
  logSignInMethodPolicy(signInMethodPolicyFailureLevel(error.code), "rownd_disconnect_auth_denied", {
    code: error.code, step, ownerId: error.ownerId ?? ownerId,
  });
}

function policyFailure(error: DisconnectedSignInMethodError, step: string, ownerId?: string) {
  logPolicyDenial(error, step, ownerId);
  return { status: "SIGN_IN_UP_NOT_ALLOWED" as const, reason: error.code };
}

function unauthorizedPolicy(error: DisconnectedSignInMethodError) {
  return new Session.Error({ type: Session.Error.UNAUTHORISED, message: error.code, payload: { clearTokens: true } });
}

function bufferAuthenticationResponse(res: Parameters<PluginRouteHandler["handler"]>[1]) {
  const writes: Array<() => void> = [];
  const original = { setHeader: res.setHeader, removeHeader: res.removeHeader, setCookie: res.setCookie,
    setStatusCode: res.setStatusCode, sendJSONResponse: res.sendJSONResponse, sendHTMLResponse: res.sendHTMLResponse };
  // A reused session is already bound to this response, not to a cloned one.
  // Intercept its writes too, including those caused by SDK post-auth updates.
  res.setHeader = (...args) => { writes.push(() => original.setHeader.apply(res, args)); };
  res.removeHeader = (...args) => { writes.push(() => original.removeHeader.apply(res, args)); };
  res.setCookie = (...args) => { writes.push(() => original.setCookie.apply(res, args)); };
  res.setStatusCode = (...args) => { writes.push(() => original.setStatusCode.apply(res, args)); };
  res.sendJSONResponse = (...args) => { writes.push(() => original.sendJSONResponse.apply(res, args)); };
  res.sendHTMLResponse = (...args) => { writes.push(() => original.sendHTMLResponse.apply(res, args)); };
  const restore = () => Object.assign(res, original);
  return { restore, publish: () => { restore(); for (const write of writes) write(); } };
}

async function withBufferedPasswordlessIssuance<T extends { status: string }>(
  issuance: PasswordlessIssuance,
  response: Parameters<PluginRouteHandler["handler"]>[1],
  context: UserContext,
  authenticate: () => Promise<T>,
) {
  const buffered = bufferAuthenticationResponse(response);
  try {
    const result = await authenticate();
    if (result.status === "OK") buffered.publish();
    else if (issuance.session) await Promise.allSettled([issuance.session.revokeSession(context)]);
    return result;
  } catch (error) {
    const session = issuance.session;
    if (session) await Promise.allSettled([session.revokeSession(context)]);
    if (error instanceof DisconnectedSignInMethodError) return policyFailure(error, "passwordless", session?.getUserId(context));
    throw error;
  } finally {
    buffered.restore();
  }
}

async function refreshRowndSessionClaims(input: {
  session: SessionContainerInterface;
  userSnapshot: User;
  appVariantId?: string;
  userContext: UserContext;
  provenAuthentication: boolean;
  beforeUpdatingPayload?: (presence: PolicyPresence) => Promise<void>;
}) {
  const currentPayload = input.session.getAccessTokenPayload();
  const buildClaims = () => buildRowndSessionAndAnonymousClaims(
    input.userSnapshot.id,
    currentPayload,
    input.appVariantId,
    input.userContext,
    input.session.getRecipeUserId(input.userContext).getAsString(),
    input.provenAuthentication,
    { userSnapshot: input.userSnapshot },
  );
  const { rowndSessionClaims, rowndIsAnonymousClaim, inspection } = await (input.provenAuthentication
    ? withProvenSessionAuthentication(buildClaims) : buildClaims());
  await input.beforeUpdatingPayload?.(inspection);
  delete rowndSessionClaims.aud;
  await input.session.mergeIntoAccessTokenPayload(
    {
      ...rowndSessionClaims,
      ...rowndIsAnonymousClaim,
      [ROWND_JWT_CLAIMS.IsAnonymous]:
        rowndSessionClaims[ROWND_JWT_CLAIMS.IsAnonymous] ?? null,
      anonymous_id: rowndSessionClaims.anonymous_id ?? null,
    },
    input.userContext,
  );
}

function getRowndPasswordlessRequestContextValues(
  req: Parameters<typeof getRequestedDisplayContextFromRequest>[0],
  pluginConfig: RowndPluginNormalisedConfig,
) {
  const displayContext = getRequestedDisplayContextFromRequest(req);
  const redirectToPath = getRequestedRedirectToPathFromRequest(req);
  const clientDomain = getRequestedClientDomainFromRequest(req);
  const appVariantId = getRequestedAppVariantIdFromRequest(req);
  const oauthLoginChallenge = getRequestedOAuthLoginChallengeFromRequest(req);
  assertRowndAppVariantIsConfigured(pluginConfig, appVariantId);
  return {
    rowndDisplayContext: displayContext,
    rowndRedirectToPath: redirectToPath,
    rowndClientDomain: clientDomain,
    rowndAppVariantId: appVariantId,
    rowndOAuthLoginChallenge: oauthLoginChallenge,
    rowndReauthenticate: req.getKeyValueFromQuery("rownd_reauthenticate") === "true",
  };
}

const verifyRowndUserSessionOptions: VerifySessionOptions = {
  sessionRequired: true,
  checkDatabase: true,
  overrideGlobalClaimValidators: (validators) =>
    validators.filter((validator) => {
      return (
        !("claim" in validator) ||
        validator.claim.key !== EmailVerificationClaim.key
      );
    }),
};

const verifyRowndUserWriteSessionOptions: VerifySessionOptions = {
  ...verifyRowndUserSessionOptions,
  checkDatabase: true,
};

export const init: (config: RowndPluginConfig) => SuperTokensPlugin =
  createPluginInitFunction<
    SuperTokensPlugin,
    RowndPluginConfig,
    {},
    RowndPluginNormalisedConfig
  >(
    (pluginConfig) => {
      const rowndClient =
        !pluginConfig.disableRowndUserMigration && pluginConfig.rowndAppSecret
          ? createRowndClient({
            appKey: pluginConfig.rowndAppKey,
            appSecret: pluginConfig.rowndAppSecret,
            appId: pluginConfig.rowndAppId,
          })
          : undefined;
      const telemetryClient = createClient(pluginConfig.telemetry);
      let hubBootstrapParams: Record<string, string> | undefined;
      let accountLinkingDecision: NonNullable<NonNullable<Parameters<typeof AccountLinking.init>[0]>["shouldDoAutomaticAccountLinking"]> =
        async () => ({ shouldAutomaticallyLink: false });

      const addHubBootstrapParams = <T extends Record<string, any>>(
        input: T,
        linkKey: keyof T,
        targetPath: string,
        additionalParams: Record<string, string> = {},
      ) => {
        const resolvedPluginConfig =
          getConfigForUserContext(input?.userContext) ?? pluginConfig;
        const appVariantId = input?.userContext?.rowndAppVariantId as
          string | undefined;
        const displayContext = input?.userContext?.rowndDisplayContext as
          string | undefined;
        const redirectToPath = input?.userContext?.rowndRedirectToPath as
          string | undefined;
        const clientDomain = input?.userContext?.rowndClientDomain as
          string | undefined;
        const oauthLoginChallenge = input?.userContext
          ?.rowndOAuthLoginChallenge as string | undefined;
        const authIntent = input?.userContext?.rowndAuthIntent as
          | "sign_in"
          | "sign_up"
          | undefined;
        const clientDomainKey =
          clientDomain ??
          (displayContext === "mobile_app" ? "mobile" : "browser");
        const clientBaseUrl =
          resolvedPluginConfig.clientDomains?.[clientDomainKey];
        const bootstrapParams = {
          appKey: pluginConfig.rowndAppKey,
          ...(hubBootstrapParams ?? {}),
          ...(input.userInputCode
            ? { passwordlessFlowType: "USER_INPUT_CODE_AND_MAGIC_LINK" }
            : {}),
          ...(typeof appVariantId === "string" ? { appVariantId } : {}),
          ...(typeof displayContext === "string" ? { displayContext } : {}),
          ...(typeof redirectToPath === "string" ? { redirectToPath } : {}),
          ...(typeof oauthLoginChallenge === "string"
            ? { oauthLoginChallenge }
            : {}),
          ...(authIntent === "sign_in" || authIntent === "sign_up"
            ? { rowndAuthIntent: authIntent }
            : {}),
          ...(input?.userContext?.rowndReauthenticate === true
            ? { rowndReauthenticate: "true" }
            : {}),
          ...additionalParams,
        };

        if (!input[linkKey]) {
          return input;
        }

        const rewrittenLink = clientBaseUrl
          ? rewriteLinkToBaseUrl(
            input[linkKey],
            targetPath,
            clientBaseUrl,
            bootstrapParams,
          )
          : rewriteLinkPath(input[linkKey], targetPath, bootstrapParams);

        return {
          ...input,
          [linkKey]: rewrittenLink,
        };
      };

      setRowndClient(rowndClient);
      setRowndTokenValidator(!pluginConfig.disableRowndUserMigration
        ? createRowndTokenValidator({
          audience: pluginConfig.rowndJwtAudience!,
          jwksUrl: pluginConfig.jwksUrl,
        }) : undefined);
      setPluginConfig(pluginConfig);

      if (pluginConfig.enableDebugLogs) {
        enableDebugLogs();
      }

      logDebugMessage("Rownd plugin init complete");

      return {
        id: PLUGIN_ID,
        compatibleSDKVersions: PLUGIN_SDK_VERSION,
        init: async () => {
          if (pluginConfig.disableRowndUserMigration) {
            console.warn(
              "RowndMigrationPlugin: Rownd user and session migration is disabled.",
            );
          }
          if (!supertokens.isRecipeInitialized("session")) {
            console.warn(
              "RowndMigrationPlugin: Session recipe is not initialized. Session migration will fail.",
            );
          }
          if (!supertokens.isRecipeInitialized("thirdparty")) {
            console.warn(
              "RowndMigrationPlugin: ThirdParty recipe is not initialized. Guest login will fail.",
            );
          }
          if (!supertokens.isRecipeInitialized("emailverification")) {
            console.warn(
              "RowndMigrationPlugin: EmailVerification recipe is not initialized. Verified email profile updates will fail.",
            );
          }
          if (
            isEmailSignInEnabled(pluginConfig) &&
            !supertokens.isRecipeInitialized("passwordless")
          ) {
            console.warn(
              "RowndMigrationPlugin: Passwordless recipe is not initialized. Email profile updates will fail.",
            );
          }
        },
        routeHandlers(stConfig) {
          setSuperTokensConfig(stConfig);
          const apiBasePath =
            stConfig.appInfo.apiBasePath.getAsStringDangerous();
          hubBootstrapParams = {
            apiDomain: stConfig.appInfo.apiDomain.getAsStringDangerous(),
            apiBasePath,
          };
          const routeHandlerDeps = {
            pluginConfig,
            stConfig,
            telemetryClient,
          };

          return {
            status: "OK" as const,
            routeHandlers: [
              {
                path: `${apiBasePath}${HANDLE_BASE_PATH}/app-config`,
                method: "get" as const,
                handler: withRequestHandler(
                  handleGetAppConfig(routeHandlerDeps),
                ),
              },
              {
                path: `${apiBasePath}${HANDLE_BASE_PATH}/guest`,
                method: "post" as const,
                handler: withRequestHandler(handleGuestLogin(routeHandlerDeps)),
              },
              ...(!pluginConfig.disableRowndUserMigration
                ? [
                  {
                    path: `${apiBasePath}${HANDLE_BASE_PATH}/migrate`,
                    method: "post" as const,
                    handler: handleMigrationRequest(routeHandlerDeps),
                  },
                ]
                : []),
              {
                path: `${apiBasePath}/plugin/passwordless-cross-device-confirmation/validate`,
                method: "post" as const,
                handler: withRequestHandler(
                  handleValidatePasswordlessConfirmationBypass(
                    routeHandlerDeps,
                  ),
                ),
              },
              ...(!pluginConfig.disableRowndUserMigration
                ? [
                  {
                    path: `${apiBasePath}/plugin/migrate-session`,
                    method: "post" as const,
                    handler: handleMigrationRequest(routeHandlerDeps),
                  },
                ]
                : []),
              {
                path: `${apiBasePath}${HANDLE_BASE_PATH}/signout`,
                method: "post" as const,
                verifySessionOptions: {
                  sessionRequired: true,
                  checkDatabase: true,
                },
                handler: withRequestHandler(handleSignOut()),
              },
              {
                path: `${apiBasePath}${HANDLE_BASE_PATH}/user`,
                method: "get" as const,
                verifySessionOptions: verifyRowndUserSessionOptions,
                handler: withRequestHandler(handleGetUser(routeHandlerDeps)),
              },
              {
                path: `${apiBasePath}${HANDLE_BASE_PATH}/user/sign-in-methods`,
                method: "get" as const,
                verifySessionOptions: verifyRowndUserWriteSessionOptions,
                handler: withRequestHandler(handleConnectedSignInMethods(routeHandlerDeps)),
              },
              {
                path: `${apiBasePath}${HANDLE_BASE_PATH}/user/sign-in-methods/disconnect`,
                method: "post" as const,
                verifySessionOptions: verifyRowndUserWriteSessionOptions,
                handler: withRequestHandler(handleConnectedSignInMethods(routeHandlerDeps, true)),
              },
              {
                path: `${apiBasePath}${HANDLE_BASE_PATH}/user`,
                method: "put" as const,
                verifySessionOptions: verifyRowndUserWriteSessionOptions,
                handler: withRequestHandler(handleUpdateUser(routeHandlerDeps)),
              },
              {
                path: `${apiBasePath}${HANDLE_BASE_PATH}/user`,
                method: "delete" as const,
                verifySessionOptions: {
                  sessionRequired: true,
                  checkDatabase: true,
                },
                handler: withRequestHandler(handleDeleteUser()),
              },
              {
                path: `${apiBasePath}${HANDLE_BASE_PATH}/user/meta`,
                method: "get" as const,
                verifySessionOptions: {
                  sessionRequired: true,
                  checkDatabase: true,
                },
                handler: withRequestHandler(handleGetUserMeta()),
              },
              {
                path: `${apiBasePath}${HANDLE_BASE_PATH}/user/meta`,
                method: "put" as const,
                verifySessionOptions: {
                  sessionRequired: true,
                  checkDatabase: true,
                },
                handler: withRequestHandler(handleUpdateUserMeta()),
              },
              {
                path: `${apiBasePath}${HANDLE_BASE_PATH}/user/field`,
                method: "get" as const,
                verifySessionOptions: verifyRowndUserSessionOptions,
                handler: withRequestHandler(
                  handleGetUserField(routeHandlerDeps),
                ),
              },
              {
                path: `${apiBasePath}${HANDLE_BASE_PATH}/user/field`,
                method: "put" as const,
                verifySessionOptions: verifyRowndUserWriteSessionOptions,
                handler: withRequestHandler(
                  handleUpdateUserField(routeHandlerDeps),
                ),
              },
            ],
          };
        },
        overrideMap: {
          oauth2provider: {
            recipeInitRequired: false,
            functions: (
              originalImplementation: OAuth2ProviderRecipeInterface,
            ) => ({
              ...originalImplementation,
              getRequestedScopes: async (input) => {
                const scopes =
                  await originalImplementation.getRequestedScopes(input);
                return normalizeRowndOAuthScopes(scopes);
              },
              buildAccessTokenPayload: async (input) => {
                const payload =
                  await originalImplementation.buildAccessTokenPayload(input);
                return buildRowndOAuthPayload({
                  user: input.user,
                  client: input.client,
                  scopes: input.scopes,
                  currentPayload: payload,
                  userContext: input.userContext,
                });
              },
              buildIdTokenPayload: async (input) => {
                const payload =
                  await originalImplementation.buildIdTokenPayload(input);
                return buildRowndOAuthPayload({
                  user: input.user,
                  client: input.client,
                  scopes: input.scopes,
                  currentPayload: payload,
                  userContext: input.userContext,
                });
              },
              buildUserInfo: async (input) => {
                const resolved = await resolvePluginConfigSnapshot(
                  pluginConfig,
                  {
                    tenantId: input.tenantId,
                    userContext: input.userContext,
                  },
                );
                const payload = await originalImplementation.buildUserInfo({
                  ...input,
                  userContext: resolved.userContext,
                });
                return buildRowndOAuthUserInfo({
                  user: input.user,
                  accessTokenPayload: input.accessTokenPayload,
                  scopes: input.scopes,
                  currentPayload: payload,
                  userContext: resolved.userContext,
                });
              },
            }),
            apis: (originalImplementation: OAuth2ProviderAPIInterface) => ({
              ...originalImplementation,
              authGET: async (input) => {
                if (originalImplementation.authGET === undefined) {
                  throw new Error("OAuth2Provider authGET is unavailable");
                }

                const resolved = await resolvePluginConfigSnapshot(
                  pluginConfig,
                  {
                    request: input.options.req,
                    userContext: input.userContext,
                  },
                );
                const audience = applyRowndOAuthResourceParams({
                  params: input.params,
                  userContext: resolved.userContext,
                });
                const operationContext = createDerivedUserContext(
                  resolved.userContext,
                  { rowndOAuthAudience: audience },
                );
                return originalImplementation.authGET({
                  ...input,
                  userContext: operationContext,
                });
              },
              tokenPOST: async (input) => {
                if (originalImplementation.tokenPOST === undefined) {
                  throw new Error("OAuth2Provider tokenPOST is unavailable");
                }

                const resolved = await resolvePluginConfigSnapshot(
                  pluginConfig,
                  {
                    request: input.options.req,
                    userContext: input.userContext,
                  },
                );
                const audience = applyRowndOAuthResourceParams({
                  params: input.body,
                  userContext: resolved.userContext,
                });
                const operationContext = createDerivedUserContext(
                  resolved.userContext,
                  { rowndOAuthAudience: audience },
                );
                return originalImplementation.tokenPOST({
                  ...input,
                  userContext: operationContext,
                });
              },
            }),
          },
          passwordless: {
            config: (config) => {
              const originalEmailDeliveryOverride =
                config.emailDelivery?.override;
              const originalSmsDeliveryOverride = config.smsDelivery?.override;

              return {
                ...config,
                emailDelivery: {
                  ...config.emailDelivery,
                  override: (originalImplementation, builder) => {
                    const implementation = originalEmailDeliveryOverride
                      ? originalEmailDeliveryOverride(
                        originalImplementation,
                        builder,
                      )
                      : originalImplementation;

                    return {
                      ...implementation,
                      sendEmail: async function (input) {
                        return implementation.sendEmail(
                          addHubBootstrapParams(
                            input,
                            "urlWithLinkCode",
                            HUB_LOGIN_PAGE_PATH,
                          ),
                        );
                      },
                    };
                  },
                },
                smsDelivery: {
                  ...config.smsDelivery,
                  override: (originalImplementation, builder) => {
                    const implementation = originalSmsDeliveryOverride
                      ? originalSmsDeliveryOverride(
                        originalImplementation,
                        builder,
                      )
                      : originalImplementation;

                    return {
                      ...implementation,
                      sendSms: async function (input) {
                        return implementation.sendSms(
                          addHubBootstrapParams(
                            input,
                            "urlWithLinkCode",
                            HUB_LOGIN_PAGE_PATH,
                          ),
                        );
                      },
                    };
                  },
                },
              };
            },
            apis: (originalImplementation: PasswordlessAPIInterface) => ({
              ...originalImplementation,
              createCodePOST: async (
                input: Parameters<
                  NonNullable<PasswordlessAPIInterface["createCodePOST"]>
                >[0],
              ) => {
                if (originalImplementation.createCodePOST === undefined) {
                  throw new Error("Passwordless createCodePOST is unavailable");
                }

                const appVariantId = getRequestedAppVariantIdFromRequest(
                  input.options.req,
                );
                const resolved = await resolvePluginConfigSnapshot(
                  pluginConfig,
                  {
                    tenantId: input.tenantId,
                    request: input.options.req,
                    userContext: input.userContext,
                  },
                );
                assertRowndAppVariantIsConfigured(
                  resolved.config,
                  appVariantId,
                );
                const body = await input.options.req.getJSONBody();
                const hasIntent =
                  body !== null && typeof body === "object" && "intent" in body;
                const intent = hasIntent
                  ? (body as { intent?: unknown }).intent
                  : undefined;
                const explicitFlowEnabled = isExplicitSignUpFlowEnabled(
                  resolved.config,
                  appVariantId,
                );
                if (
                  hasIntent &&
                  intent !== "sign_in" &&
                  intent !== "sign_up"
                ) {
                  return {
                    status: "GENERAL_ERROR" as const,
                    message: "intent must be sign_in or sign_up",
                  };
                }
                const usesExplicitAuthIntent =
                  (intent === "sign_in" || intent === "sign_up") &&
                  explicitFlowEnabled;
                let authSnapshot: PasswordlessAuthSnapshot | undefined;
                let useHistoricalSignIn = false;
                if ("email" in input) {
                  let preparation: Awaited<
                    ReturnType<typeof prepareEmailForPasswordlessAuth>
                  >;
                  try {
                    preparation = await prepareEmailForPasswordlessAuth({
                      email: input.email,
                      tenantId: input.tenantId,
                      reconcileTarget: usesExplicitAuthIntent,
                      userContext: resolved.userContext,
                    });
                    authSnapshot = "snapshot" in preparation ? preparation.snapshot : undefined;
                    if (input.session) {
                      useHistoricalSignIn = !!(await findHistoricalEmailOwner({
                        snapshot: authSnapshot,
                        requireNewPasswordless: true,
                        email: input.email,
                        tenantId: input.tenantId,
                        session: input.session,
                        userContext: resolved.userContext,
                      }));
                    }
                  } catch (error) {
                    logDebugMessage(
                      `Explicit passwordless email preparation failed. Error: ${error instanceof Error ? error.message : String(error)}`,
                    );
                    return {
                      status: "GENERAL_ERROR" as const,
                      message:
                        "Account email reconciliation failed; please retry.",
                    };
                  }
                  if (preparation.status === "REJECT_CLEANUP_METHOD") {
                    return {
                      status: "SIGN_IN_UP_NOT_ALLOWED" as const,
                      reason: INACTIVE_PASSWORDLESS_EMAIL_REASON,
                    };
                  }
                }
                if (usesExplicitAuthIntent && intent === "sign_in") {
                  if (
                    !(await doesRowndAccountInfoExist({
                      snapshot: authSnapshot,
                      tenantId: input.tenantId,
                      ...("email" in input
                        ? { email: input.email }
                        : { phoneNumber: input.phoneNumber }),
                      userContext: resolved.userContext,
                    }))
                  ) {
                    return {
                      status: "SIGN_IN_UP_NOT_ALLOWED" as const,
                      reason: "No existing account found",
                    };
                  }
                }

                const operationContext = createDerivedUserContext(
                  resolved.userContext,
                  {
                    ...getRowndPasswordlessRequestContextValues(
                      input.options.req,
                      resolved.config,
                    ),
                    ...(usesExplicitAuthIntent
                      ? { rowndAuthIntent: intent }
                      : {}),
                  },
                );
                return originalImplementation.createCodePOST({
                  ...input,
                  ...(useHistoricalSignIn ? { session: undefined, shouldTryLinkingWithSessionUser: false } : {}),
                  userContext: operationContext,
                });
              },
              resendCodePOST: async (
                input: Parameters<
                  NonNullable<PasswordlessAPIInterface["resendCodePOST"]>
                >[0],
              ) => {
                if (originalImplementation.resendCodePOST === undefined) {
                  throw new Error("Passwordless resendCodePOST is unavailable");
                }

                const resolved = await resolvePluginConfigSnapshot(
                  pluginConfig,
                  {
                    tenantId: input.tenantId,
                    request: input.options.req,
                    userContext: input.userContext,
                  },
                );
                const requestContextValues =
                  getRowndPasswordlessRequestContextValues(
                    input.options.req,
                    resolved.config,
                  );
                const body = await input.options.req.getJSONBody();
                const hasIntent =
                  body !== null && typeof body === "object" && "intent" in body;
                const requestedIntent = hasIntent
                  ? (body as { intent?: unknown }).intent
                  : undefined;
                if (
                  hasIntent &&
                  requestedIntent !== "sign_in" &&
                  requestedIntent !== "sign_up"
                ) {
                  return {
                    status: "GENERAL_ERROR" as const,
                    message: "intent must be sign_in or sign_up",
                  };
                }
                const explicitIntent =
                  isExplicitSignUpFlowEnabled(
                    resolved.config,
                    getRequestedAppVariantIdFromRequest(input.options.req),
                  ) &&
                  (requestedIntent === "sign_in" ||
                    requestedIntent === "sign_up")
                    ? requestedIntent
                    : undefined;
                let useHistoricalSignIn = false;
                try {
                  const [deviceById, deviceByPreAuthSessionId] =
                    await Promise.all([
                      input.options.recipeImplementation.listCodesByDeviceId({
                        deviceId: input.deviceId,
                        tenantId: input.tenantId,
                        userContext: resolved.userContext,
                      }),
                      input.options.recipeImplementation.listCodesByPreAuthSessionId(
                        {
                          preAuthSessionId: input.preAuthSessionId,
                          tenantId: input.tenantId,
                          userContext: resolved.userContext,
                        },
                      ),
                    ]);
                  const hasEmail =
                    typeof deviceById?.email === "string" &&
                    deviceById.email.length > 0;
                  const hasPhoneNumber =
                    typeof deviceById?.phoneNumber === "string" &&
                    deviceById.phoneNumber.length > 0;
                  if (
                    !deviceById ||
                    !deviceByPreAuthSessionId ||
                    deviceById.preAuthSessionId !== input.preAuthSessionId ||
                    deviceByPreAuthSessionId.preAuthSessionId !==
                      input.preAuthSessionId ||
                    deviceByPreAuthSessionId.email !== deviceById.email ||
                    deviceByPreAuthSessionId.phoneNumber !==
                      deviceById.phoneNumber ||
                    hasEmail === hasPhoneNumber
                  ) {
                    throw new Error(
                      "Passwordless resend device state is invalid",
                    );
                  }
                  if (hasEmail) {
                    const preparation = await prepareEmailForPasswordlessAuth({
                      email: deviceById.email!,
                      tenantId: input.tenantId,
                      reconcileTarget: false,
                      userContext: resolved.userContext,
                    });
                    if (preparation.status === "REJECT_CLEANUP_METHOD") {
                      const revocation =
                        await input.options.recipeImplementation.revokeCode({
                          preAuthSessionId: input.preAuthSessionId,
                          tenantId: input.tenantId,
                          userContext: resolved.userContext,
                        });
                      if (revocation.status !== "OK") {
                        throw new Error(
                          "Passwordless resend device revocation failed",
                        );
                      }
                      return { status: "RESTART_FLOW_ERROR" as const };
                    }
                    if (input.session) {
                      useHistoricalSignIn = !!(await findHistoricalEmailOwner({
                        snapshot: "snapshot" in preparation ? preparation.snapshot : undefined,
                        requireNewPasswordless: true,
                        email: deviceById.email!,
                        tenantId: input.tenantId,
                        session: input.session,
                        userContext: resolved.userContext,
                      }));
                    }
                  }
                } catch (error) {
                  logDebugMessage(
                    `Passwordless resend authorization failed. Error: ${error instanceof Error ? error.message : String(error)}`,
                  );
                  return {
                    status: "GENERAL_ERROR" as const,
                    message: "Unable to resend passwordless code.",
                  };
                }
                const operationContext = createDerivedUserContext(
                  resolved.userContext,
                  {
                    ...requestContextValues,
                    ...(explicitIntent
                      ? { rowndAuthIntent: explicitIntent }
                      : {}),
                  },
                );
                return originalImplementation.resendCodePOST({
                  ...input,
                  ...(useHistoricalSignIn ? { session: undefined, shouldTryLinkingWithSessionUser: false } : {}),
                  userContext: operationContext,
                });
              },
              consumeCodePOST: async (
                input: Parameters<
                  NonNullable<PasswordlessAPIInterface["consumeCodePOST"]>
                >[0],
              ) => {
                const consumeCodePOST = originalImplementation.consumeCodePOST?.bind(originalImplementation);
                if (consumeCodePOST === undefined) {
                  throw new Error(
                    "Passwordless consumeCodePOST is unavailable",
                  );
                }

                const appVariantId = getRequestedAppVariantIdFromRequest(
                  input.options.req,
                );
                const resolved = await resolvePluginConfigSnapshot(
                  pluginConfig,
                  {
                    tenantId: input.tenantId,
                    request: input.options.req,
                    userContext: input.userContext,
                  },
                );
                assertRowndAppVariantIsConfigured(
                  resolved.config,
                  appVariantId,
                );
                const body = await input.options.req.getJSONBody();
                const hasIntent =
                  body !== null && typeof body === "object" && "intent" in body;
                const requestedIntent = hasIntent
                  ? (body as { intent?: unknown }).intent
                  : undefined;
                const explicitFlowEnabled = isExplicitSignUpFlowEnabled(
                  resolved.config,
                  appVariantId,
                );
                if (
                  hasIntent &&
                  requestedIntent !== "sign_in" &&
                  requestedIntent !== "sign_up"
                ) {
                  return {
                    status: "GENERAL_ERROR" as const,
                    message: "intent must be sign_in or sign_up",
                  };
                }
                const explicitIntent =
                  explicitFlowEnabled &&
                  (requestedIntent === "sign_in" ||
                    requestedIntent === "sign_up")
                    ? requestedIntent
                    : undefined;
                let consumedEmail: string | undefined;
                const issuance: PasswordlessIssuance = {};
                let authSnapshot: PasswordlessAuthSnapshot | undefined;
                try {
                  const device =
                    await input.options.recipeImplementation.listCodesByPreAuthSessionId(
                      {
                        preAuthSessionId: input.preAuthSessionId,
                        tenantId: input.tenantId,
                        userContext: resolved.userContext,
                      },
                    );
                  if (device?.email) {
                    consumedEmail = device.email;
                    const preparation = await prepareEmailForPasswordlessAuth({
                      email: device.email,
                      tenantId: input.tenantId,
                      reconcileTarget: false,
                      userContext: resolved.userContext,
                    });
                    authSnapshot = "snapshot" in preparation ? preparation.snapshot : undefined;
                    issuance.candidates = authSnapshot?.inspections;
                    if (preparation.status === "REJECT_CLEANUP_METHOD") {
                      return {
                        status: "SIGN_IN_UP_NOT_ALLOWED" as const,
                        reason: INACTIVE_PASSWORDLESS_EMAIL_REASON,
                      };
                    }
                  }
                } catch (error) {
                  logDebugMessage(
                    `Passwordless consume authorization failed. Error: ${error instanceof Error ? error.message : String(error)}`,
                  );
                  return {
                    status: "GENERAL_ERROR" as const,
                    message: "Unable to complete passwordless authentication.",
                  };
                }
                const operationContext = createDerivedUserContext(
                  resolved.userContext,
                  { rowndAppVariantId: appVariantId },
                );
                let session = input.shouldTryLinkingWithSessionUser === false ? undefined : input.session;
                const sessionOwner = session && authSnapshot?.inspections.get(session.getUserId(operationContext));
                if (session && sessionOwner) {
                  const recipe = session.getRecipeUserId(operationContext);
                  try {
                    await checkSignInMethodAuthentication(session.getUserId(operationContext), recipe, input.tenantId,
                      operationContext, { presence: sessionOwner });
                  } catch (error) {
                    if (!(error instanceof DisconnectedSignInMethodError)) throw error;
                    if (input.shouldTryLinkingWithSessionUser === true || error.code !== "SIGN_IN_METHOD_DISCONNECTED") {
                      return policyFailure(error, "passwordless_existing_session", session.getUserId(operationContext));
                    }
                    // A retained-email sign-in is independent of an incidental retired SSO token.
                    session = undefined;
                  }
                }
                const historicalOwner = consumedEmail
                  ? await findHistoricalEmailOwner({
                    snapshot: authSnapshot,
                    requireNewPasswordless: true,
                    email: consumedEmail,
                    tenantId: input.tenantId,
                    session,
                    userContext: operationContext,
                  })
                  : undefined;
                const historicalScope: HistoricalPasswordlessScope | undefined = historicalOwner && consumedEmail ? {
                  userId: historicalOwner.id,
                  email: consumedEmail.trim().toLowerCase(),
                  tenantId: input.tenantId,
                  ownerRecipeUserIds: historicalOwner.loginMethods.map((method) => method.recipeUserId.getAsString()),
                } : undefined;
                issuance.linkingSession = historicalScope ? undefined : session;
                const consumeContext = createDerivedUserContext(operationContext, {
                  [passwordlessHistoryOwner]: historicalScope,
                  [PASSWORDLESS_ISSUANCE]: issuance,
                });
                return withBufferedPasswordlessIssuance(issuance, input.options.res, consumeContext, async () => {
                  const response = await consumeCodePOST({
                    ...input,
                    // Authenticate the historical owner instead of upgrading the incidental guest session.
                    ...(historicalScope ? { session: undefined, shouldTryLinkingWithSessionUser: false } : { session }),
                    userContext: consumeContext,
                    options: historicalScope ? {
                      ...input.options,
                      recipeImplementation: {
                        ...input.options.recipeImplementation,
                        consumeCode: async (consumeInput) => {
                          if (consumeInput.tenantId !== historicalScope.tenantId || consumeInput.session ||
                          consumeInput.preAuthSessionId !== input.preAuthSessionId || historicalScope.recipeUserId ||
                          historicalScope.denied) {
                            historicalScope.denied = true;
                            return { status: "RESTART_FLOW_ERROR" as const };
                          }
                          const result = await input.options.recipeImplementation.consumeCode({
                            ...consumeInput, userContext: createDerivedUserContext(consumeContext, {
                              [PASSWORDLESS_LINK_CANDIDATE]: issuance,
                            }),
                          });
                          if (result.status !== "OK") return result;
                          if (result.consumedDevice?.email) issuance.consumed = {
                            recipeUserId: result.recipeUserId.getAsString(), email: result.consumedDevice.email, authenticatedAt: Date.now(),
                          };
                          historicalScope.recipeUserId = result.recipeUserId.getAsString();
                          const cleanup = async () => {
                            if (result.createdNewRecipeUser) {
                              await deleteRejectedConsumedPasswordlessUser({
                                userId: result.recipeUserId.getAsString(),
                                recipeUserId: result.recipeUserId.getAsString(),
                                email: historicalScope.email,
                                tenantId: historicalScope.tenantId,
                                onlyIfStillStandalone: true,
                                userContext: consumeContext,
                              });
                            }
                          };
                          let user;
                          try {
                            user = await linkHistoricalPasswordlessUser(
                              historicalScope, accountLinkingDecision, createDerivedUserContext(consumeContext, {
                                [PASSWORDLESS_LINK_CANDIDATE]: issuance,
                              }),
                            );
                          } catch (error) {
                            historicalScope.denied = true;
                            try {
                              await cleanup();
                            } catch (cleanupError) {
                              throw new RowndPasswordlessCleanupError(error, cleanupError);
                            }
                            throw error;
                          }
                          if (!user) {
                            await cleanup();
                            return { status: "RESTART_FLOW_ERROR" as const };
                          }
                          return { ...result, user };
                        },
                      },
                    } : {
                      ...input.options,
                      recipeImplementation: {
                        ...input.options.recipeImplementation,
                        consumeCode: async (consumeInput) => {
                          const result = await input.options.recipeImplementation.consumeCode({
                            ...consumeInput, userContext: createDerivedUserContext(consumeInput.userContext, {
                              [PASSWORDLESS_LINK_CANDIDATE]: issuance,
                            }),
                          });
                          if (result.status === "OK" && result.consumedDevice?.email) issuance.consumed = {
                            recipeUserId: result.recipeUserId.getAsString(), email: result.consumedDevice.email, authenticatedAt: Date.now(),
                          };
                          return result;
                        },
                      },
                    },
                  }).catch((error: unknown) => {
                    if (error instanceof DisconnectedSignInMethodError) {
                      return policyFailure(error, "passwordless", input.session?.getUserId(consumeContext));
                    }
                    throw error;
                  });

                  if (historicalScope && (historicalScope.denied || (response.status === "OK" &&
                  response.session.getUserId(consumeContext) !== historicalScope.userId))) {
                    historicalScope.denied = true;
                    if (response.status === "OK") await response.session.revokeSession(consumeContext);
                    return { status: "SIGN_IN_UP_NOT_ALLOWED" as const, reason: INACTIVE_PASSWORDLESS_EMAIL_REASON };
                  }
                  if (response.status === "OK") {
                    if (consumedEmail) {
                      if (issuance.session && response.session.getHandle(consumeContext) !== issuance.session.getHandle(consumeContext)) {
                        throw new DisconnectedSignInMethodError("DISCONNECT_OWNER_CHANGED");
                      }
                      try {
                        const disposition =
                        await validateConsumedPasswordlessEmail({
                          userId: response.user.id,
                          email: consumedEmail,
                          tenantId: input.tenantId,
                          intent: explicitIntent,
                          createdNewRecipeUser: response.createdNewRecipeUser,
                          recipeUserId: response.session.getRecipeUserId(consumeContext).getAsString(),
                          userContext: consumeContext,
                        });
                        if (disposition.status !== "ALLOW") {
                          if (!issuance.session) await response.session.revokeSession(operationContext);
                          if (disposition.status === "REJECT_AND_DELETE") {
                            await deleteRejectedConsumedPasswordlessUser({
                              userId: response.user.id,
                              recipeUserId: disposition.recipeUserId,
                              email: consumedEmail,
                              tenantId: input.tenantId,
                              userContext: operationContext,
                            });
                          }
                          return {
                            status: "SIGN_IN_UP_NOT_ALLOWED" as const,
                            reason: INACTIVE_PASSWORDLESS_EMAIL_REASON,
                          };
                        }
                      } catch (error) {
                        if (error instanceof DisconnectedSignInMethodError) throw error;
                        if (!issuance.session) await response.session.revokeSession(operationContext);
                        logDebugMessage(
                          `Passwordless consumed identity validation failed. Error: ${error instanceof Error ? error.message : String(error)}`,
                        );
                        return {
                          status: "GENERAL_ERROR" as const,
                          message:
                          "Unable to complete passwordless authentication.",
                        };
                      }
                    }
                    await recordRowndAppVariantForUser(
                      response.user.id,
                      appVariantId,
                      operationContext,
                      input.tenantId,
                      { userSnapshot: response.user },
                    );

                    await refreshRowndSessionClaims({
                      session: response.session,
                      userSnapshot: response.user,
                      appVariantId,
                      userContext: operationContext,
                      provenAuthentication: true,
                      beforeUpdatingPayload: (presence) => checkSignInMethodAuthentication(
                        response.user.id, response.session.getRecipeUserId(operationContext),
                        input.tenantId, operationContext, { presence },
                      ).then(() => undefined),
                    });
                  }

                  return response;
                });
              },
            }),
          },
          thirdparty: {
            functions: (originalImplementation) => ({
              ...originalImplementation,
              signInUp: async (input) => {
                let ownerId = input.session?.getUserId(input.userContext);
                try {
                  if (!["instant", "guest"].includes(input.thirdPartyId)) {
                    const identity = { tenantId: input.tenantId, providerId: input.thirdPartyId, providerUserId: input.thirdPartyUserId };
                    await assertSignInIdentityNotIndexed(identity, input.userContext);
                    if (ownerId) {
                      const { policy } = await readPolicyGate(ownerId, input.userContext);
                      if (policy) assertIdentityAllowedByOwner(identity, policy.identities, ownerId);
                    }
                  }
                  const result = await originalImplementation.signInUp(input);
                  if (result.status === "OK") {
                    ownerId = result.user.id;
                    if (result.createdNewRecipeUser && !["instant", "guest"].includes(input.thirdPartyId)) {
                      await assertSignInIdentityNotIndexed({ tenantId: input.tenantId,
                        providerId: input.thirdPartyId, providerUserId: input.thirdPartyUserId }, input.userContext);
                    }
                    const operation = thirdPartyAuthenticationOperation(input.userContext);
                    if (operation) {
                      if (operation.actual) throw new RowndSignInMethodError("SIGN_IN_METHOD_AUTHENTICATION_UNPROVEN", 403, "The authenticated sign-in method changed.");
                      operation.actual = Object.freeze({ user: result.user, recipeUserId: result.recipeUserId.getAsString(),
                        tenantId: input.tenantId, providerId: input.thirdPartyId, providerUserId: input.thirdPartyUserId });
                    } else {
                      await checkSignInMethodAuthentication(ownerId, result.recipeUserId, input.tenantId, input.userContext,
                        { user: result.user });
                    }
                  }
                  return result;
                } catch (error) {
                  if (error instanceof DisconnectedSignInMethodError) return policyFailure(error, "thirdparty", ownerId);
                  throw error;
                }
              },
            }),
            apis: (originalImplementation: ThirdPartyAPIInterface) => ({
              ...originalImplementation,
              signInUpPOST: async (
                input: Parameters<
                  NonNullable<ThirdPartyAPIInterface["signInUpPOST"]>
                >[0],
              ) => {
                if (originalImplementation.signInUpPOST === undefined) {
                  throw new Error("ThirdParty signInUpPOST is unavailable");
                }

                const appVariantId = getRequestedAppVariantIdFromRequest(
                  input.options.req,
                );
                const resolved = await resolvePluginConfigSnapshot(
                  pluginConfig,
                  {
                    tenantId: input.tenantId,
                    request: input.options.req,
                    userContext: input.userContext,
                  },
                );
                assertRowndAppVariantIsConfigured(
                  resolved.config,
                  appVariantId,
                );
                const authentication: ThirdPartyAuthenticationOperation = { sessions: new Set() };
                const operationContext = createDerivedUserContext(
                  resolved.userContext,
                  { rowndAppVariantId: appVariantId, [THIRD_PARTY_AUTHENTICATION]: authentication },
                );
                const buffered = bufferAuthenticationResponse(input.options.res);
                let response;
                try {
                  let provider = withAppleJwksRetry(input.provider);
                  if (input.session && input.shouldTryLinkingWithSessionUser !== false && provider.type === "oauth2") {
                    const oauthProvider = provider;
                    provider = { ...oauthProvider, getUserInfo: async (providerInput: Parameters<typeof oauthProvider.getUserInfo>[0]) => {
                      const userInfo = await oauthProvider.getUserInfo(providerInput);
                      // SDK linking preflight can otherwise replace the policy denial
                      // with a generic link or verification error.
                      await assertSignInIdentityNotIndexed({ tenantId: input.tenantId,
                        providerId: oauthProvider.id, providerUserId: userInfo.thirdPartyUserId }, operationContext);
                      return userInfo;
                    } };
                  }
                  response = await originalImplementation.signInUpPOST({
                    ...input,
                    // Retry verification only: an OAuth authorization code may already be consumed.
                    provider,
                    userContext: operationContext,
                  });
                  if (response.status === "OK") {
                    const authenticatedResponse = response;
                    const actual = authentication.actual;
                    if ((!actual && !["instant", "guest"].includes(input.provider.id)) || (actual &&
                      (actual.tenantId !== input.tenantId || actual.providerId !== input.provider.id ||
                        actual.user.id !== authenticatedResponse.user.id || authenticatedResponse.session.getUserId(operationContext) !== authenticatedResponse.user.id ||
                        authenticatedResponse.session.getTenantId(operationContext) !== input.tenantId))) {
                      throw new RowndSignInMethodError("SIGN_IN_METHOD_AUTHENTICATION_UNPROVEN", 403, "The authenticated sign-in method could not be confirmed.");
                    }
                    await recordRowndAppVariantForUser(response.user.id, appVariantId, operationContext, input.tenantId,
                      { userSnapshot: response.user });
                    await refreshRowndSessionClaims({ session: response.session, userSnapshot: response.user, appVariantId,
                      userContext: operationContext, provenAuthentication: realProvider(input.provider.id),
                      beforeUpdatingPayload: async (presence) => {
                        if (!actual) return;
                        const recipe = supertokens.convertToRecipeUserId(actual.recipeUserId);
                        const { method, gate } = await checkSignInMethodAuthentication(actual.user.id, recipe, input.tenantId,
                          operationContext, { presence });
                        if ((gate.policy?.methods.length && !method) || (method && (method.recipeId !== "thirdparty" ||
                          method.thirdParty?.id !== actual.providerId || method.thirdParty.userId !== actual.providerUserId))) {
                          throw new RowndSignInMethodError("SIGN_IN_METHOD_AUTHENTICATION_UNPROVEN", 403, "The authenticated sign-in method changed.");
                        }
                        const sessionRecipe = authenticatedResponse.session.getRecipeUserId(operationContext);
                        if (sessionRecipe.getAsString() !== actual.recipeUserId) {
                          await checkSignInMethodAuthentication(actual.user.id, sessionRecipe, input.tenantId, operationContext, { presence });
                        }
                      } });
                  } else if (authentication.sessions.size) {
                    // A custom SDK override can fail after creating a buffered session.
                    await Promise.allSettled([...authentication.sessions].map((session) =>
                      Session.revokeSession(session.getHandle(operationContext), operationContext)));
                    return response;
                  }
                  buffered.publish();
                  return response;
                } catch (error) {
                  if (response?.status === "OK" && response.session.getHandle(operationContext) !== input.session?.getHandle(operationContext)) {
                    authentication.sessions.add(response.session);
                  }
                  await Promise.allSettled([...authentication.sessions].map((session) => Session.revokeSession(session.getHandle(operationContext), operationContext)));
                  if (error instanceof DisconnectedSignInMethodError) return policyFailure(error, "thirdparty_post", authentication.actual?.user.id);
                  if (error instanceof RowndSignInMethodError) return { status: "SIGN_IN_UP_NOT_ALLOWED" as const, reason: error.errorCode };
                  throw error;
                } finally {
                  buffered.restore();
                }
              },
            }),
          },
          accountlinking: {
            recipeInitRequired: true,
            functions: (originalImplementation) => ({
              ...originalImplementation,
              deleteUser: (input) => deleteUserAndSignInMethodPolicy(input, (request) => originalImplementation.deleteUser(request)),
              linkAccounts: async (input) => {
                try {
                  const passwordless = Reflect.get(input.userContext, PASSWORDLESS_LINK_CANDIDATE) as PasswordlessIssuance | undefined;
                  if (passwordless) {
                    // The consume recipe links its Passwordless candidate; Core won't reparent an existing primary.
                    for (const [id, presence] of passwordless.candidates ?? []) {
                      if (presence.user?.loginMethods.some((method) =>
                        method.recipeUserId.getAsString() === input.recipeUserId.getAsString()) &&
                        (await readPolicyGate(id, input.userContext, { presence })).policy && id !== input.primaryUserId) {
                        throw new DisconnectedSignInMethodError("DISCONNECT_RESTORATION_BLOCKED");
                      }
                    }
                    const session = passwordless.linkingSession;
                    if (session?.getUserId(input.userContext) === input.primaryUserId) {
                      // The SDK has already read this graph while deciding whether to link.
                      const user = await supertokens.getUser(input.primaryUserId, input.userContext);
                      const recipe = session.getRecipeUserId(input.userContext);
                      const method = user?.loginMethods.find((entry) => entry.recipeUserId.getAsString() === recipe.getAsString());
                      if (!method || realProvider(method.thirdParty?.id)) {
                        await checkSignInMethodAuthentication(input.primaryUserId, recipe, session.getTenantId(input.userContext),
                          input.userContext, { user });
                      }
                    }
                    return originalImplementation.linkAccounts(input);
                  }
                  const recheck = await assertSignInMethodLinkAllowed(input.primaryUserId, input.recipeUserId, input.userContext);
                  const result = await originalImplementation.linkAccounts(input);
                  if (recheck && result.status === "OK") {
                    await assertSignInMethodLinkAllowed(input.primaryUserId, input.recipeUserId, input.userContext);
                  }
                  return result;
                } catch (error) {
                  if (error instanceof DisconnectedSignInMethodError) logPolicyDenial(error, "link_accounts", input.primaryUserId);
                  throw error;
                }
              },
            }),
            config: (config) => {
              const originalShouldDoAutomaticAccountLinking =
                config.shouldDoAutomaticAccountLinking;

              return {
                ...config,
                shouldDoAutomaticAccountLinking: accountLinkingDecision = async (...input) => {
                  if (pluginConfig.metadataMode === "canonical") {
                    return { shouldAutomaticallyLink: false };
                  }

                  if (input[4]?.rowndDisableAutomaticAccountLinking === true) {
                    return {
                      shouldAutomaticallyLink: false,
                      shouldRequireVerification: false,
                    };
                  }
                  const candidate = input[0]?.thirdParty;
                  if (candidate && realProvider(candidate.id)) {
                    const ownerId = input[1]?.id ?? input[2]?.getUserId(input[4]);
                    if (ownerId) {
                      try {
                        const { policy } = await readPolicyGate(ownerId, input[4], { user: input[1] });
                        if (policy) assertIdentityAllowedByOwner({ tenantId: input[3], providerId: candidate.id,
                          providerUserId: candidate.userId }, policy.identities, ownerId);
                      } catch (error) {
                        if (error instanceof DisconnectedSignInMethodError) logPolicyDenial(error, "automatic_link", ownerId);
                        if (error instanceof DisconnectedSignInMethodError && error.code === "SIGN_IN_METHOD_DISCONNECTED") {
                          return { shouldAutomaticallyLink: false, shouldRequireVerification: false };
                        }
                        throw error;
                      }
                    }
                  }
                  const rowndLinkingDecision =
                    await shouldLinkRowndAccounts(input);
                  if (rowndLinkingDecision) {
                    if ("historicalEmail" in rowndLinkingDecision && originalShouldDoAutomaticAccountLinking) {
                      const originalDecision = await originalShouldDoAutomaticAccountLinking(...input);
                      if (!originalDecision.shouldAutomaticallyLink) return originalDecision;
                    }
                    return rowndLinkingDecision;
                  }

                  if (originalShouldDoAutomaticAccountLinking) {
                    return originalShouldDoAutomaticAccountLinking(...input);
                  }

                  return {
                    shouldAutomaticallyLink: false,
                    shouldRequireVerification: false,
                  };
                },
              };
            },
          },
          session: {
            recipeInitRequired: true,
            functions: (originalImplementation) => ({
              ...originalImplementation,
              createNewSession: async (input) => {
                const authentication = thirdPartyAuthenticationOperation(input.userContext);
                const passwordlessIssuance = Reflect.get(input.userContext, PASSWORDLESS_ISSUANCE) as PasswordlessIssuance | undefined;
                if (passwordlessIssuance?.session) throw new DisconnectedSignInMethodError("DISCONNECT_OWNER_CHANGED");
                const resolved = await resolvePluginConfigSnapshot(
                  pluginConfig,
                  {
                    tenantId: input.tenantId,
                    userContext: input.userContext,
                  },
                );
                const appVariantId =
                  typeof resolved.userContext.rowndAppVariantId === "string"
                    ? resolved.userContext.rowndAppVariantId
                    : undefined;
                const { rowndSessionClaims, rowndIsAnonymousClaim, inspection } =
                  await buildRowndSessionAndAnonymousClaims(
                    input.userId,
                    input.accessTokenPayload,
                    appVariantId,
                    resolved.userContext,
                    input.recipeUserId.getAsString(),
                    true,
                  );
                try {
                  const { gate } = await checkSignInMethodAuthentication(input.userId, input.recipeUserId,
                    input.tenantId, resolved.userContext, { presence: inspection });
                  if (input.userContext.rowndMigrationRequestId && gate.policy) {
                    throw new DisconnectedSignInMethodError("DISCONNECT_RESTORATION_BLOCKED");
                  }
                } catch (error) {
                  if (!(error instanceof DisconnectedSignInMethodError) || authentication || passwordlessIssuance ||
                    input.userContext.rowndMigrationRequestId) throw error;
                  logPolicyDenial(error, "create_session", input.userId);
                  throw unauthorizedPolicy(error);
                }
                const consumed = passwordlessIssuance?.consumed;
                const receipt = resolved.config.connectedSignInMethods?.enabled && consumed
                  ? passwordlessSessionReceipt(inspection, input.recipeUserId.getAsString(), input.tenantId, consumed) : undefined;
                const session = await originalImplementation.createNewSession({
                  ...input,
                  accessTokenPayload: { ...input.accessTokenPayload, ...rowndSessionClaims, ...rowndIsAnonymousClaim, ...receipt?.accessTokenPayload },
                  sessionDataInDatabase: { ...input.sessionDataInDatabase, ...receipt?.sessionDataInDatabase },
                  userContext: resolved.userContext,
                });
                authentication?.sessions.add(session);
                if (passwordlessIssuance) passwordlessIssuance.session = session;
                return session;
              },
            }),
          },
          multitenancy: {
            functions: (originalImplementation) => ({
              ...originalImplementation,
              associateUserToTenant: async (input) => {
                try {
                  await assertSignInMethodTenantAssociationAllowed(input.recipeUserId, input.tenantId, input.userContext);
                  const result = await originalImplementation.associateUserToTenant(input);
                  if (result.status === "OK") {
                    await assertSignInMethodTenantAssociationAllowed(input.recipeUserId, input.tenantId, input.userContext);
                  }
                  return result;
                } catch (error) {
                  if (error instanceof DisconnectedSignInMethodError) logPolicyDenial(error, "associate_tenant", input.recipeUserId.getAsString());
                  throw error;
                }
              },
            }),
          },
          emailverification: {
            recipeInitRequired: true,
            config: (config) => {
              const originalEmailDeliveryOverride =
                config.emailDelivery?.override;

              return {
                ...config,
                getEmailForRecipeUserId: async (recipeUserId, userContext) => {
                  const supplied = await config.getEmailForRecipeUserId?.(recipeUserId, userContext);
                  if (supplied && supplied.status !== "UNKNOWN_USER_ID_ERROR") return supplied;
                  const id = recipeUserId.getAsString();
                  const user = await supertokens.getUser(id, userContext);
                  // EmailVerification builds its claim before the SDK session hook.
                  // Recognize the retired anchor without lending it another factor's email.
                  if (user && !user.loginMethods.some((method) => method.recipeUserId.getAsString() === id)) {
                    try {
                      await assertNotRetiredPrimaryRecipe(id, user, userContext);
                    } catch (error) {
                      if (!(error instanceof DisconnectedSignInMethodError) || error.code !== "SIGN_IN_METHOD_DISCONNECTED") throw error;
                      logPolicyDenial(error, "email_verification_recipe", user.id);
                      throw unauthorizedPolicy(error);
                    }
                  }
                  return { status: "UNKNOWN_USER_ID_ERROR" as const };
                },
                emailDelivery: {
                  ...config.emailDelivery,
                  override: (originalImplementation, builder) => {
                    const implementation = originalEmailDeliveryOverride
                      ? originalEmailDeliveryOverride(
                        originalImplementation,
                        builder,
                      )
                      : originalImplementation;

                    return {
                      ...implementation,
                      sendEmail: async (input) => {
                        const pendingVerificationId =
                          getPendingEmailVerificationIdFromUserContext(
                            input.userContext,
                          );
                        const deliveryInput = pendingVerificationId
                          ? {
                            ...input,
                            emailVerifyLink:
                                addPendingEmailVerificationMarker({
                                  pendingVerificationId,
                                  emailVerifyLink: input.emailVerifyLink,
                                }),
                          }
                          : input;
                        return implementation.sendEmail({
                          ...addHubBootstrapParams(
                            deliveryInput,
                            "emailVerifyLink",
                            HUB_VERIFY_EMAIL_PAGE_PATH,
                            pendingVerificationId
                              ? {
                                [PENDING_EMAIL_VERIFICATION_QUERY_PARAM]:
                                    pendingVerificationId,
                              }
                              : {},
                          ),
                        });
                      },
                    };
                  },
                },
              };
            },
            apis: (originalImplementation: EmailVerificationAPIInterface) => ({
              ...originalImplementation,
              verifyEmailPOST: async (
                input: Parameters<
                  NonNullable<EmailVerificationAPIInterface["verifyEmailPOST"]>
                >[0],
              ) => {
                if (originalImplementation.verifyEmailPOST === undefined) {
                  throw new Error(
                    "EmailVerification verifyEmailPOST is unavailable",
                  );
                }

                const pendingVerificationId =
                  input.options.req.getKeyValueFromQuery(
                    PENDING_EMAIL_VERIFICATION_QUERY_PARAM,
                  );
                const pendingToken = await resolvePendingEmailVerificationToken(
                  {
                    token: input.token,
                    queryPendingVerificationId: pendingVerificationId,
                    tenantId: input.tenantId,
                    session: input.session,
                    userContext: input.userContext,
                  },
                );
                if (pendingToken.status === "INVALID_PENDING") {
                  return {
                    status: "GENERAL_ERROR" as const,
                    message: PENDING_EMAIL_VERIFICATION_SESSION_ERROR,
                  };
                }

                const response = await originalImplementation.verifyEmailPOST(
                  pendingToken.status === "OK"
                    ? { ...input, token: pendingToken.coreToken }
                    : input,
                );
                if (response.status === "OK" && pendingToken.status === "OK") {
                  let verificationResult;
                  try {
                    verificationResult = await completePendingEmailVerification(
                      {
                        recipeUserId: response.user.recipeUserId,
                        email: response.user.email,
                        tenantId: input.tenantId,
                        sessionHandle: input.session?.getHandle(),
                        pendingVerificationId:
                          pendingToken.pendingVerificationId,
                        pendingUserId: pendingToken.userId,
                        userContext: input.userContext,
                      },
                    );
                  } catch (error) {
                    if (error instanceof RowndEmailChangeError) {
                      return {
                        status: "GENERAL_ERROR" as const,
                        message: error.message,
                      };
                    }
                    throw error;
                  }

                  const session = input.session;
                  const shouldReplaceSession =
                    session &&
                    verificationResult &&
                    session.getHandle() ===
                      verificationResult.initiatingSessionHandle;

                  if (shouldReplaceSession && verificationResult) {
                    try {
                      response.newSession = await Session.createNewSession(
                        input.options.req,
                        input.options.res,
                        session.getTenantId(input.userContext),
                        verificationResult.recipeUserId,
                        {},
                        {},
                        input.userContext,
                      );
                    } catch (error) {
                      await Session.revokeAllSessionsForUser(
                        verificationResult.userId,
                        true,
                        undefined,
                        input.userContext,
                      );
                      throw error;
                    }
                  }
                }

                return response;
              },
            }),
          },
        },
      };
    },
    () => ({}),
    (config: RowndPluginConfig) => {
      if (config.metadataMode !== undefined && !["compatibility", "dual-write", "canonical"].includes(config.metadataMode)) {
        throw new Error("metadataMode must be compatibility, dual-write or canonical in plugin config");
      }
      // Migration writes alias records canonical mode never reads. Dual-write republishes
      // each migrated owner's presentation instead (see canonical-republish.ts).
      if (config.metadataMode === "canonical" && config.disableRowndUserMigration !== true) {
        throw new Error(`${config.metadataMode} metadata mode requires Rownd user migration to be disabled`);
      }
      const telemetryProvider = (
        config.telemetry as { provider?: unknown } | undefined
      )?.provider;
      if (
        telemetryProvider !== undefined &&
        telemetryProvider !== "opentelemetry" &&
        telemetryProvider !== "axiom" &&
        telemetryProvider !== "custom"
      ) {
        throw new Error("Unknown telemetry provider in plugin config");
      }
      if (
        config?.disableRowndUserMigration !== undefined &&
        typeof config.disableRowndUserMigration !== "boolean"
      ) {
        throw new Error(
          "disableRowndUserMigration must be a boolean in plugin config",
        );
      }
      if ((config.rowndAppKey && !config.rowndAppSecret) ||
          (!config.rowndAppKey && config.rowndAppSecret)) {
        throw new Error("rowndAppKey and rowndAppSecret must be configured together");
      }
      if (config.telemetry?.provider === "axiom") {
        if (!config.telemetry.token || !config.telemetry.dataset) {
          throw new Error(
            "Missing telemetry axiom token or dataset in plugin config",
          );
        }
      }
      if (config.telemetry?.provider === "custom") {
        if (typeof config.telemetry.factory !== "function") {
          throw new Error(
            "Missing telemetry custom factory function in plugin config",
          );
        }
      }
      validateDynamicConfig(config);
      if (config.rowndAppId !== undefined && (typeof config.rowndAppId !== "string" || !config.rowndAppId.trim() || config.rowndAppId.trim() !== config.rowndAppId)) {
        throw new Error("rowndAppId must be a non-empty app ID in plugin config");
      }
      const audience = config.rowndJwtAudience ?? (config.rowndAppId || config.appConfig?.id
        ? `app:${config.rowndAppId ?? config.appConfig?.id}` : undefined);
      if (config.rowndJwtAudience && config.rowndAppId && config.rowndJwtAudience !== `app:${config.rowndAppId}`) {
        throw new Error("rowndJwtAudience must match rowndAppId when both are configured");
      }
      if (!config.disableRowndUserMigration && (typeof audience !== "string" || !/^app:[^\s:]+$/.test(audience))) {
        throw new Error("Migration requires rowndJwtAudience, rowndAppId, or appConfig.id to bind Rownd tokens to this application");
      }
      if (config.jwksUrl !== undefined && (typeof config.jwksUrl !== "string" || !config.jwksUrl.trim())) {
        throw new Error("jwksUrl must be a non-empty URL in plugin config");
      }
      return {
        metadataMode: config.metadataMode ?? "compatibility",
        rowndAppKey: config.rowndAppKey ?? DISABLED_MIGRATION_ROWND_APP_KEY,
        rowndAppId: config.rowndAppId,
        rowndAppSecret: config.rowndAppSecret,
        rowndJwtAudience: audience,
        jwksUrl: config.jwksUrl,
        disableRowndUserMigration: config.disableRowndUserMigration === true,
        enableDebugLogs: config.enableDebugLogs,
        clientDomains: config.clientDomains,
        crossDeviceConfirmationBypass: config.crossDeviceConfirmationBypass,
        telemetry: config.telemetry,
        schema: config.schema,
        appConfig: config.appConfig,
        subBrands: config.subBrands,
        connectedSignInMethods: { enabled: config.connectedSignInMethods?.enabled === true },
        emailChange: {
          maxSessionAgeSeconds: config.emailChange?.maxSessionAgeSeconds === undefined
            ? 600 : config.emailChange.maxSessionAgeSeconds,
        },
        resolveConfig: config.resolveConfig,
      };
    },
  );

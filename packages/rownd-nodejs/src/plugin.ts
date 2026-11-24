import { SuperTokensPlugin, type PluginRouteHandler, type UserContext } from "supertokens-node/types";
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
  assertSignInMethodLinkAllowed,
  assertSignInMethodTenantAssociationAllowed,
  checkSignInMethodAuthentication,
  readPolicyGate,
  DisconnectedSignInMethodError,
} from "./disconnected-sign-in-identities";
import { logSignInMethodPolicy } from "./sign-in-method-policy-log";
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

import { recordPasswordlessAuthentication, withProvenSessionAuthentication } from "./session-authentication";
import { withAppleJwksRetry } from "./apple-jwks-retry";

const DISABLED_MIGRATION_ROWND_APP_KEY = "migration-disabled";
const PENDING_EMAIL_VERIFICATION_SESSION_ERROR =
  "email change verification requires the initiating session";
const INACTIVE_PASSWORDLESS_EMAIL_REASON = "No existing account found";
const THIRD_PARTY_AUTHENTICATION = Symbol("rownd.thirdPartyAuthentication");
type ThirdPartyAuthenticationOperation = {
  actual?: { userId: string; recipeUserId: string; tenantId: string; providerId: string; providerUserId: string };
  gate?: Awaited<ReturnType<typeof readPolicyGate>>;
  sessions: Set<SessionContainerInterface>;
};

function thirdPartyAuthenticationOperation(context: Record<string, any>) {
  return Reflect.get(context, THIRD_PARTY_AUTHENTICATION) as ThirdPartyAuthenticationOperation | undefined;
}

function policyFailure(error: DisconnectedSignInMethodError, step: string, ownerId?: string) {
  logSignInMethodPolicy("error", "rownd_disconnect_auth_denied", { code: error.code, step, ownerId: error.ownerId ?? ownerId });
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

async function refreshRowndSessionClaims(input: {
  session: SessionContainerInterface;
  userId: string;
  appVariantId?: string;
  userContext: UserContext;
  provenAuthentication: boolean;
  beforeUpdatingPayload?: () => Promise<void>;
}) {
  const currentPayload = input.session.getAccessTokenPayload();
  const buildClaims = () => buildRowndSessionAndAnonymousClaims(
    input.userId,
    currentPayload,
    input.appVariantId,
    input.userContext,
    input.session.getRecipeUserId(input.userContext).getAsString(),
    input.provenAuthentication,
  );
  const { rowndSessionClaims, rowndIsAnonymousClaim } = await (input.provenAuthentication
    ? withProvenSessionAuthentication(buildClaims) : buildClaims());
  await input.beforeUpdatingPayload?.();
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
                if (originalImplementation.consumeCodePOST === undefined) {
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
                const passwordlessAuthentication: { value?: { recipeUserId: string; email: string; authenticatedAt: number } } = {};
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
                const historicalOwner = consumedEmail
                  ? await findHistoricalEmailOwner({
                    snapshot: authSnapshot,
                    requireNewPasswordless: true,
                    email: consumedEmail,
                    tenantId: input.tenantId,
                    session: input.session,
                    userContext: operationContext,
                  })
                  : undefined;
                const historicalScope: HistoricalPasswordlessScope | undefined = historicalOwner && consumedEmail ? {
                  userId: historicalOwner.id,
                  email: consumedEmail.trim().toLowerCase(),
                  tenantId: input.tenantId,
                  ownerRecipeUserIds: historicalOwner.loginMethods.map((method) => method.recipeUserId.getAsString()),
                } : undefined;
                const consumeContext = createDerivedUserContext(operationContext, {
                  [passwordlessHistoryOwner]: historicalScope,
                });
                if (input.session && !historicalScope) {
                  const id = input.session.getUserId(consumeContext);
                  try {
                    await checkSignInMethodAuthentication(id, input.session.getRecipeUserId(consumeContext), input.tenantId, consumeContext);
                  } catch (error) {
                    if (error instanceof DisconnectedSignInMethodError) return policyFailure(error, "passwordless_existing_session", id);
                    throw error;
                  }
                }
                const response = await originalImplementation.consumeCodePOST({
                  ...input,
                  // Authenticate the historical owner instead of upgrading the incidental guest session.
                  ...(historicalScope ? { session: undefined, shouldTryLinkingWithSessionUser: false } : {}),
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
                          ...consumeInput, userContext: consumeContext,
                        });
                        if (result.status !== "OK") return result;
                        if (result.consumedDevice?.email) passwordlessAuthentication.value = {
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
                            historicalScope, accountLinkingDecision, consumeContext,
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
                        const result = await input.options.recipeImplementation.consumeCode(consumeInput);
                        if (result.status === "OK" && result.consumedDevice?.email) passwordlessAuthentication.value = {
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
                        await response.session.revokeSession(operationContext);
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
                      await response.session.revokeSession(operationContext);
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
                  );

                  await refreshRowndSessionClaims({
                    session: response.session,
                    userId: response.user.id,
                    appVariantId,
                    userContext: operationContext,
                    provenAuthentication: true,
                    beforeUpdatingPayload: async () => {
                      const consumed = passwordlessAuthentication.value;
                      if (consumed && resolved.config.connectedSignInMethods?.enabled === true) {
                        await recordPasswordlessAuthentication(response.session, consumed.recipeUserId,
                          input.tenantId, operationContext, consumed.email, consumed.authenticatedAt);
                      }
                    },
                  });
                }

                return response;
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
                      const { policy } = await readPolicyGate(ownerId, input.userContext, { scope: "signin" });
                      if (policy?.identities.some((entry) => entry.tenantId === identity.tenantId &&
                        entry.providerId === identity.providerId && entry.providerUserId === identity.providerUserId)) {
                        throw new DisconnectedSignInMethodError("SIGN_IN_METHOD_DISCONNECTED");
                      }
                    }
                  }
                  const result = await originalImplementation.signInUp(input);
                  if (result.status === "OK") {
                    ownerId = result.user.id;
                    if (result.createdNewRecipeUser && !["instant", "guest"].includes(input.thirdPartyId)) {
                      await assertSignInIdentityNotIndexed({ tenantId: input.tenantId,
                        providerId: input.thirdPartyId, providerUserId: input.thirdPartyUserId }, input.userContext);
                    }
                    const { gate } = await checkSignInMethodAuthentication(ownerId, result.recipeUserId, input.tenantId, input.userContext,
                      { scope: "signin", user: result.user });
                    const operation = thirdPartyAuthenticationOperation(input.userContext);
                    if (operation) {
                      if (operation.actual) throw new RowndSignInMethodError("SIGN_IN_METHOD_AUTHENTICATION_UNPROVEN", 403, "The authenticated sign-in method changed.");
                      operation.gate = gate;
                      operation.actual = Object.freeze({ userId: ownerId, recipeUserId: result.recipeUserId.getAsString(),
                        tenantId: input.tenantId, providerId: input.thirdPartyId, providerUserId: input.thirdPartyUserId });
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
                  response = await originalImplementation.signInUpPOST({
                    ...input,
                    // Retry verification only: an OAuth authorization code may already be consumed.
                    provider: withAppleJwksRetry(input.provider),
                    userContext: operationContext,
                  });
                  if (response.status === "OK") {
                    const authenticatedResponse = response;
                    const actual = authentication.actual;
                    if ((!actual && !["instant", "guest"].includes(input.provider.id)) || (actual &&
                      (actual.tenantId !== input.tenantId || actual.providerId !== input.provider.id ||
                        actual.userId !== authenticatedResponse.user.id || authenticatedResponse.session.getUserId(operationContext) !== authenticatedResponse.user.id ||
                        authenticatedResponse.session.getTenantId(operationContext) !== input.tenantId))) {
                      throw new RowndSignInMethodError("SIGN_IN_METHOD_AUTHENTICATION_UNPROVEN", 403, "The authenticated sign-in method could not be confirmed.");
                    }
                    await recordRowndAppVariantForUser(response.user.id, appVariantId, operationContext, input.tenantId);
                    await refreshRowndSessionClaims({ session: response.session, userId: response.user.id, appVariantId,
                      userContext: operationContext, provenAuthentication: !["instant", "guest"].includes(input.provider.id) });
                    if (actual) {
                      const { method, gate } = await checkSignInMethodAuthentication(actual.userId,
                        supertokens.convertToRecipeUserId(actual.recipeUserId), input.tenantId, operationContext,
                        { scope: "signin", previous: authentication.gate });
                      if ((gate.policy?.methods.length && !method) || (method && (method.recipeId !== "thirdparty" ||
                        method.thirdParty?.id !== actual.providerId || method.thirdParty.userId !== actual.providerUserId))) {
                        throw new RowndSignInMethodError("SIGN_IN_METHOD_AUTHENTICATION_UNPROVEN", 403, "The authenticated sign-in method changed.");
                      }
                    }
                  }
                  buffered.publish();
                  return response;
                } catch (error) {
                  if (response?.status === "OK" && response.session.getHandle(operationContext) !== input.session?.getHandle(operationContext)) {
                    authentication.sessions.add(response.session);
                  }
                  await Promise.allSettled([...authentication.sessions].map((session) => Session.revokeSession(session.getHandle(operationContext), operationContext)));
                  if (error instanceof DisconnectedSignInMethodError) return policyFailure(error, "thirdparty_post", authentication.actual?.userId);
                  if (error instanceof RowndSignInMethodError) return { status: "SIGN_IN_UP_NOT_ALLOWED" as const, reason: error.message };
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
              linkAccounts: async (input) => {
                try {
                  await assertSignInMethodLinkAllowed(input.primaryUserId, input.recipeUserId, input.userContext);
                  const result = await originalImplementation.linkAccounts(input);
                  if (result.status === "OK") {
                    await assertSignInMethodLinkAllowed(input.primaryUserId, input.recipeUserId, input.userContext);
                  }
                  return result;
                } catch (error) {
                  if (error instanceof DisconnectedSignInMethodError) policyFailure(error, "link_accounts", input.primaryUserId);
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
                  if (input[4]?.rowndDisableAutomaticAccountLinking === true) {
                    return {
                      shouldAutomaticallyLink: false,
                      shouldRequireVerification: false,
                    };
                  }
                  const candidate = input[0]?.thirdParty;
                  if (candidate) {
                    const ownerId = input[1]?.id ?? input[2]?.getUserId(input[4]);
                    if (ownerId) {
                      try {
                        const { policy } = await readPolicyGate(ownerId, input[4], { scope: "signin", user: input[1] });
                        if (policy?.identities.some((entry) => entry.tenantId === input[3] &&
                          entry.providerId === candidate.id && entry.providerUserId === candidate.userId)) {
                          policyFailure(new DisconnectedSignInMethodError("SIGN_IN_METHOD_DISCONNECTED"), "automatic_link", ownerId);
                          return { shouldAutomaticallyLink: false, shouldRequireVerification: false };
                        }
                      } catch (error) {
                        if (error instanceof DisconnectedSignInMethodError) policyFailure(error, "automatic_link", ownerId);
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
                const initialGate = authentication?.gate?.reference === input.userId &&
                  authentication.actual?.recipeUserId === input.recipeUserId.getAsString() ? authentication.gate : undefined;
                const check = async (userId: string, recipeId: typeof input.recipeUserId, tenantId: string,
                  context: typeof input.userContext, previous = initialGate, reuse = false) => {
                  try {
                    const gate = reuse && previous ? previous : (await checkSignInMethodAuthentication(userId, recipeId,
                      tenantId, context, { scope: "signin", previous })).gate;
                    if (input.userContext.rowndMigrationRequestId && gate.policy) {
                      throw new DisconnectedSignInMethodError("DISCONNECT_RESTORATION_BLOCKED");
                    }
                    return gate;
                  } catch (error) {
                    if (!(error instanceof DisconnectedSignInMethodError)) throw error;
                    if (authentication || Reflect.has(context, passwordlessHistoryOwner)) throw error;
                    policyFailure(error, "create_session", userId);
                    throw unauthorizedPolicy(error);
                  }
                };
                const gate = await check(input.userId, input.recipeUserId, input.tenantId, input.userContext, initialGate, true);
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
                const { rowndSessionClaims, rowndIsAnonymousClaim } =
                  await buildRowndSessionAndAnonymousClaims(
                    input.userId,
                    input.accessTokenPayload,
                    appVariantId,
                    resolved.userContext,
                    input.recipeUserId.getAsString(),
                    true,
                  );
                input.accessTokenPayload = {
                  ...input.accessTokenPayload,
                  ...rowndSessionClaims,
                  ...rowndIsAnonymousClaim,
                };

                const session = await originalImplementation.createNewSession({
                  ...input,
                  userContext: resolved.userContext,
                });
                authentication?.sessions.add(session);
                try {
                  await check(session.getUserId(resolved.userContext), session.getRecipeUserId(resolved.userContext),
                    session.getTenantId(resolved.userContext), resolved.userContext, gate);
                } catch (error) {
                  await Promise.allSettled([session.revokeSession(resolved.userContext)]);
                  throw error;
                }
                return session;
              },
              refreshSession: async (input) => {
                const session = await originalImplementation.refreshSession(input);
                const userId = session.getUserId(input.userContext);
                try {
                  await checkSignInMethodAuthentication(userId, session.getRecipeUserId(input.userContext),
                    session.getTenantId(input.userContext), input.userContext, { scope: "session" });
                } catch (error) {
                  if (!(error instanceof DisconnectedSignInMethodError)) throw error;
                  policyFailure(error, "refresh", userId);
                  if (error.code === "SIGN_IN_METHOD_DISCONNECTED") {
                    await Promise.allSettled([session.revokeSession(input.userContext)]);
                  }
                  throw unauthorizedPolicy(error);
                }
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
                  if (error instanceof DisconnectedSignInMethodError) policyFailure(error, "associate_tenant", input.recipeUserId.getAsString());
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

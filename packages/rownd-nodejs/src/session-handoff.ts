import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import SuperTokens from "supertokens-node";
import Session, { type SessionInformation } from "supertokens-node/recipe/session";
import type { SessionContainerInterface } from "supertokens-node/recipe/session/types";
import type { PluginRouteHandler, SuperTokensPublicConfig } from "supertokens-node/types";
import { withRequestHandler } from "@shared/nodejs";
import { z } from "zod";
import { bufferSessionResponse } from "./buffer-session-response";
import {
  getPluginConfig,
  getPluginTelemetryRecorder,
  getSuperTokensConfig,
  resolveConfirmationBypassTarget,
  resolvePluginConfigSnapshot,
} from "./config";
import { HUB_LOGIN_PAGE_PATH, PLUGIN_VERSION } from "./constants";
import { RowndSessionHandoffError } from "./errors";
import { logDebugMessage } from "./logger";
import type { RowndRouteHandlerDeps } from "./pluginImplementation";
import { buildRowndAudience } from "./rownd-compatibility";
import {
  isAnonymousSessionUser,
  readSessionAuthenticationOrigin,
  sessionAuthenticationOrigin,
  withSessionHandoffAuthentication,
} from "./session-authentication";
import {
  isSessionHandoffCarrier,
  SESSION_HANDOFF_KIND,
  withSessionHandoffCarrier,
} from "./session-handoff-carrier";
import type { RowndTelemetryClient, RowndTelemetryEvent } from "./types";
import {
  clearSuperTokensCoreCallCache,
  createDerivedUserContext,
  getAppInfoString,
  getErrorMessage,
  getJsonBody,
  getMagicLinkBootstrapParams,
  isRecord,
  rewriteLinkToBaseUrl,
  type JsonRecord,
} from "./utils";

type Request = Parameters<PluginRouteHandler["handler"]>[0];

export type CreateSessionHandoffLinkInput = {
  session: SessionContainerInterface;
  redirectToPath: string;
  clientDomain?: string;
  appVariantId?: string;
  displayContext?: "browser" | "mobile_app" | "customer_web_view";
  tenantId?: string;
  request?: Request;
  userContext?: JsonRecord;
};

const TTL_MS = 120_000;
const INVALID_LINK_MESSAGE = "Invalid or expired handoff link";
const TOKEN_PATTERN = /^([A-Za-z0-9_-]{1,256})\.([A-Za-z0-9_-]{43})$/;

const targetBody = z.object({
  clientDomain: z.string().min(1).optional(),
  redirectToPath: z.string().min(1).optional(),
  appVariantId: z.string().min(1).optional(),
});

const carrierData = z.object({
  kind: z.literal(SESSION_HANDOFF_KIND),
  version: z.literal(1),
  secretHash: z.string().regex(/^[a-f0-9]{64}$/),
  userId: z.string().min(1),
  recipeUserId: z.string().min(1),
  tenantId: z.string().min(1),
  sourceSessionHandle: z.string().min(1),
  redirectToPath: z.string().min(1),
  clientDomain: z.string().min(1),
  appVariantId: z.string().min(1).optional(),
  displayContext: z.enum(["browser", "mobile_app", "customer_web_view"]).optional(),
  expiresAt: z.number().int(),
});

type CarrierData = z.infer<typeof carrierData>;
type SessionIdentity = Pick<CarrierData, "userId" | "recipeUserId" | "tenantId" | "sourceSessionHandle">;
type RejectReason = "invalid_body" | "invalid_token" | "missing_carrier" | "not_carrier" | "invalid_carrier" |
  "wrong_secret" | "expired" | "invalid_target" | "target_mismatch" | "invalid_source" | "replay" | "internal_error";
type MintRejectReason = RowndSessionHandoffError["reason"] | "internal_error";

class HandoffRejected extends Error {
  constructor(readonly reason: RejectReason) {
    super(INVALID_LINK_MESSAGE);
  }
}

function emit(
  record: RowndTelemetryClient["recordEvent"] | undefined,
  startedAt: number,
  handoffEvent: NonNullable<RowndTelemetryEvent["handoffEvent"]>,
  reason?: RejectReason | MintRejectReason,
) {
  const details = {
    operation: "session_handoff" as const,
    eventType: "terminal" as const,
    durationMs: Date.now() - startedAt,
    pluginVersion: PLUGIN_VERSION,
    handoffEvent,
    reason,
  };
  if (reason) {
    logDebugMessage(`Session handoff rejected: ${reason}`);
    record?.({ ...details, outcome: "error", error: {
      message: handoffEvent === "mint_reject" ? "Session handoff link could not be created" : INVALID_LINK_MESSAGE,
    } });
  } else {
    record?.({ ...details, outcome: "success" });
  }
}

function hashSecret(secret: string) {
  return createHash("sha256").update(secret).digest();
}

async function matchesIdentity(info: SessionInformation, identity: SessionIdentity, userContext: JsonRecord) {
  if (info.tenantId !== identity.tenantId) return false;
  // Session information can expose literal Core IDs while SDK sessions expose external IDs.
  const matchesId = async (coreId: string, sdkId: string) => {
    if (coreId === sdkId) return true;
    const mapping = await SuperTokens.getUserIdMapping({ userId: sdkId, userIdType: "EXTERNAL", userContext });
    return mapping.status === "OK" && mapping.superTokensUserId === coreId;
  };
  return await matchesId(info.userId, identity.userId) &&
    await matchesId(info.recipeUserId.getAsString(), identity.recipeUserId);
}

async function checkSource(identity: SessionIdentity, context: JsonRecord) {
  clearSuperTokensCoreCallCache(context);
  const source = await Session.getSessionInformation(identity.sourceSessionHandle, context);
  if (!source || source.expiry <= Date.now() || isSessionHandoffCarrier(source) || !await matchesIdentity(source, identity, context)) {
    throw new RowndSessionHandoffError("inactive_source");
  }
  const user = await SuperTokens.getUser(identity.userId, context);
  const method = user?.loginMethods.find((method) => method.recipeUserId.getAsString() === identity.recipeUserId &&
    method.tenantIds.includes(identity.tenantId));
  if (!user || user.id !== identity.userId || !method) throw new RowndSessionHandoffError("inactive_source");
  const origin = await sessionAuthenticationOrigin(user, identity.recipeUserId, source.customClaimsInAccessTokenPayload, context);
  if (origin === "handoff") throw new RowndSessionHandoffError("handoff_source");
  if (isAnonymousSessionUser(user, origin)) throw new RowndSessionHandoffError("anonymous_source");
  return method.recipeUserId;
}

async function resolveTarget(
  config: NonNullable<ReturnType<typeof getPluginConfig>>,
  stConfig: SuperTokensPublicConfig,
  target: z.infer<typeof targetBody>,
  tenantId: string,
  request: Request | undefined,
  userContext: JsonRecord,
) {
  const resolved = await resolvePluginConfigSnapshot(config, { tenantId, request, userContext });
  let normalized: ReturnType<typeof resolveConfirmationBypassTarget>;
  try {
    normalized = resolveConfirmationBypassTarget({
      ...target, pluginConfig: resolved.config, stConfig, request, userContext: resolved.userContext,
    });
  } catch (error) {
    throw new RowndSessionHandoffError("invalid_target", getErrorMessage(error));
  }
  if (!normalized.clientDomain.startsWith("https://")) throw new RowndSessionHandoffError("insecure_client_domain");
  return { ...resolved, ...normalized };
}

async function pruneCarriers(identity: SessionIdentity, carrier: SessionContainerInterface, context: JsonRecord) {
  clearSuperTokensCoreCallCache(context);
  const handle = carrier.getHandle(context);
  const info = await Session.getSessionInformation(handle, context);
  if (!info || !await matchesIdentity(info, identity, context)) throw new HandoffRejected("invalid_carrier");
  const handles = await Session.getAllSessionHandlesForUser(identity.userId, true, undefined, context);
  let superseded = false;
  const stale: string[] = [];
  let nextIndex = 0;
  let failure: { error: unknown } | undefined;
  await Promise.all(Array.from({ length: Math.min(4, handles.length) }, async () => {
    while (!failure && nextIndex < handles.length) {
      const other = handles[nextIndex++]!;
      if (other === handle) continue;
      try {
        const infoToCheck = await Session.getSessionInformation(other, context);
        if (!infoToCheck || !isSessionHandoffCarrier(infoToCheck)) continue;
        const result = carrierData.safeParse(infoToCheck.sessionDataInDatabase);
        if (!result.success) continue;
        if (result.data.expiresAt <= Date.now()) {
          stale.push(other);
        } else if (result.data.sourceSessionHandle === identity.sourceSessionHandle) {
          // A stable ordering makes concurrent mints converge on one carrier across processes.
          if (infoToCheck.timeCreated > info.timeCreated || (infoToCheck.timeCreated === info.timeCreated && other > handle)) {
            superseded = true;
          } else {
            stale.push(other);
          }
        }
      } catch (error) {
        failure ??= { error };
      }
    }
  }));
  if (failure) throw failure.error;
  if (stale.length) await Session.revokeMultipleSessions(stale, context);
  if (superseded) throw new Error("Session handoff link was superseded");
}

export async function createSessionHandoffLink(input: CreateSessionHandoffLinkInput): Promise<string> {
  const startedAt = Date.now();
  const record = getPluginTelemetryRecorder();
  try {
    const link = await mintSessionHandoffLink(input);
    emit(record, startedAt, "mint");
    return link;
  } catch (error) {
    emit(record, startedAt, "mint_reject", error instanceof RowndSessionHandoffError ? error.reason : "internal_error");
    throw error;
  }
}

async function mintSessionHandoffLink(input: CreateSessionHandoffLinkInput): Promise<string> {
  const stConfig = getSuperTokensConfig();
  if (!stConfig) throw new Error("SuperTokens config is not initialized");
  const config = getPluginConfig();
  if (!config) throw new Error("Rownd plugin config is not initialized");

  const { session, request, appVariantId, displayContext } = input;
  const context = input.userContext ?? {};
  const identity = {
    sourceSessionHandle: session.getHandle(context),
    userId: session.getUserId(context),
    recipeUserId: session.getRecipeUserId(context).getAsString(),
    tenantId: session.getTenantId(context),
  };
  if (input.tenantId !== undefined && input.tenantId !== identity.tenantId) {
    throw new RowndSessionHandoffError("tenant_mismatch");
  }
  const presentedOrigin = readSessionAuthenticationOrigin(session.getAccessTokenPayload(context));
  if (presentedOrigin === "instant") throw new RowndSessionHandoffError("anonymous_source");
  if (presentedOrigin === "handoff") throw new RowndSessionHandoffError("handoff_source");
  const parsedTarget = targetBody.safeParse(input);
  if (!parsedTarget.success) throw new RowndSessionHandoffError("invalid_target");
  const target = await resolveTarget(config, stConfig, parsedTarget.data, identity.tenantId, request, context);
  const { clientDomain, redirectToPath, userContext } = target;
  const recipeUserId = await checkSource(identity, userContext);
  const bootstrap = getMagicLinkBootstrapParams({
    appKey: target.config.rowndAppKey,
    apiDomain: getAppInfoString(stConfig.appInfo.apiDomain),
    apiBasePath: getAppInfoString(stConfig.appInfo.apiBasePath),
    appVariantId,
    displayContext,
    redirectToPath,
    clientDomainKey: input.clientDomain,
  });
  const secret = randomBytes(32).toString("base64url");
  const data: CarrierData = {
    kind: SESSION_HANDOFF_KIND, version: 1, secretHash: hashSecret(secret).toString("hex"),
    ...identity, clientDomain, redirectToPath, appVariantId, displayContext, expiresAt: Date.now() + TTL_MS,
  };
  const carrier = await withSessionHandoffCarrier(() => Session.createNewSessionWithoutRequestResponse(
    identity.tenantId, recipeUserId, {}, data, undefined, userContext,
  ));
  const handle = carrier.getHandle(userContext);
  try {
    await pruneCarriers(identity, carrier, userContext);
    await checkSource(identity, userContext);
    return rewriteLinkToBaseUrl(`#${handle}.${secret}`, HUB_LOGIN_PAGE_PATH, clientDomain, {
      rownd_handoff: "1", ...bootstrap,
    });
  } catch (error) {
    await Promise.allSettled([Session.revokeSession(handle, userContext)]);
    throw error;
  }
}

export function handleSessionHandoffConsume(deps: RowndRouteHandlerDeps): PluginRouteHandler["handler"] {
  return async (req, res, _session, userContext) => {
    const startedAt = Date.now();
    let token = "";
    let secret: string | undefined;
    res.setHeader("Cache-Control", "no-store", false);
    const consume = withRequestHandler(async () => {
      const body = await getJsonBody(req).catch(() => { throw new HandoffRejected("invalid_body"); });
      token = isRecord(body) && typeof body.token === "string" ? body.token : "";
      const [, handle, tokenSecret] = TOKEN_PATTERN.exec(token) ?? [];
      secret = tokenSecret;
      if (!handle || !secret || Buffer.from(secret, "base64url").toString("base64url") !== secret) {
        throw new HandoffRejected("invalid_token");
      }
      const info = await Session.getSessionInformation(handle, userContext);
      if (!info) throw new HandoffRejected("missing_carrier");
      if (!isSessionHandoffCarrier(info)) throw new HandoffRejected("not_carrier");
      let revokeOnFailure = true;
      try {
        const parsed = carrierData.safeParse(info.sessionDataInDatabase);
        if (!parsed.success) throw new HandoffRejected("invalid_carrier");
        const data = parsed.data;
        if (!timingSafeEqual(hashSecret(secret), Buffer.from(data.secretHash, "hex"))) {
          throw new HandoffRejected("wrong_secret");
        }
        if (Math.min(info.expiry, data.expiresAt) <= Date.now()) throw new HandoffRejected("expired");
        if (!await matchesIdentity(info, data, userContext)) throw new HandoffRejected("invalid_carrier");
        const bodyTarget = targetBody.safeParse(body);
        if (!bodyTarget.success) throw new HandoffRejected("invalid_body");
        const target = await resolveTarget(deps.pluginConfig, deps.stConfig, bodyTarget.data, data.tenantId, req, userContext)
          .catch((error: unknown) => {
            if (error instanceof RowndSessionHandoffError) throw new HandoffRejected("invalid_target");
            throw error;
          });
        if (target.clientDomain !== data.clientDomain || target.redirectToPath !== data.redirectToPath ||
            bodyTarget.data.appVariantId !== data.appVariantId) {
          throw new HandoffRejected("target_mismatch");
        }
        const context = createDerivedUserContext(target.userContext, { rowndAppVariantId: data.appVariantId });
        const recipeUserId = await checkSource(data, context);
        if (data.expiresAt <= Date.now()) throw new HandoffRejected("expired");
        // Core's revoke result is the single-use gate across concurrent callers.
        const revoked = await Session.revokeSession(handle, context);
        revokeOnFailure = false;
        if (!revoked) throw new HandoffRejected("replay");

        const buffered = bufferSessionResponse(res);
        const created = await withSessionHandoffAuthentication(() => Session.createNewSession(
          req, buffered.response, data.tenantId, recipeUserId, buildRowndAudience({}, data.appVariantId, target.config), {}, context,
        ));
        try {
          if (created.getUserId(context) !== data.userId || created.getTenantId(context) !== data.tenantId ||
              created.getRecipeUserId(context).getAsString() !== data.recipeUserId ||
              readSessionAuthenticationOrigin(created.getAccessTokenPayload(context)) !== "handoff") {
            throw new HandoffRejected("invalid_source");
          }
          await checkSource(data, context);
        } catch (error) {
          await Session.revokeSession(created.getHandle(context), context);
          throw error;
        }
        buffered.flush();
        emit(deps.telemetryClient.recordEvent, startedAt, "consume_ok");
        return { status: "OK", redirectToPath: data.redirectToPath };
      } finally {
        if (revokeOnFailure) await Session.revokeSession(handle, userContext);
      }
    });
    try {
      return await consume(req, res, undefined, userContext);
    } catch (error) {
      const reason = error instanceof HandoffRejected ? error.reason
        : error instanceof RowndSessionHandoffError ? "invalid_source" : "internal_error";
      if (reason === "internal_error") {
        let details = error instanceof Error ? `${error.name}: ${error.message}` : "Unexpected non-Error exception";
        for (const credential of [token, secret]) {
          if (credential) details = details.split(credential).join("[redacted]");
        }
        logDebugMessage(`Session handoff consume failed: ${details}`);
      }
      emit(deps.telemetryClient.recordEvent, startedAt, reason === "replay" ? "replay" : "reject", reason);
      res.setStatusCode(401);
      res.sendJSONResponse({ status: "ERROR", message: INVALID_LINK_MESSAGE });
      return null;
    }
  };
}

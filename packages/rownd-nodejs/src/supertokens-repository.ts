import { reconciliationSuperTokens as SuperTokens, reconciliationAccountLinking as AccountLinking, reconciliationEmailVerification as EmailVerification, reconciliationUserMetadata as UserMetadata, reconciliationPasswordless as Passwordless, reconciliationThirdParty as ThirdParty, reconciliationMultitenancy as MultiTenancy } from "./reconciliation-sdk";
import { classifyMethodOwner, resolveMethodInspection, selectMigrationMethods, planMethods, methodPlanAllows, type MethodRecipe, type MethodSnapshot, type MethodPlan } from "./migration-method-plan";
import { recordAdministrativeMethodCreation } from "./migration-method-receipts";
import { invalidateReconciliationReads } from "./reconciliation-reads";
import { migrationPhoneAccountInfos, sameCorePhoneNumber } from "./migration-phone-identity";
import { backfillAdministrativeMetadata } from "./migration-admin-metadata";
import { getAdministrativeRepairMetadata, prepareAdministrativeCanonicalEmail } from "./migration-admin-email";
import { RowndMigrationPolicyError } from "./errors";
import { sessionAuthenticationOrigin } from "./session-authentication";
import { assertMigrationPostconditions, assertMigrationOwnerGraph, reconcileAdministrativeEmailVerification } from "./migration-postconditions";
import { assertCurrentRowndProviders, checkpointProviderIntroduction, finishProviderIntroductions, prepareRowndProviderRetirement, recoverProviderRevocations, type ProviderIntroduction } from "./migration-provider";
import { finishAdministrativeProviderIntroductions, inspectAdministrativeProviderIntroductions } from "./migration-admin-provider";
import { migrationTelemetry } from "./telemetry/migrationTelemetry";
import {
  assertAuthenticatedMigrationSource,
  getAuthenticatedMigrationEmail,
  getMigrationContactEmail,
  isAdministrativeMigration,
  checkpointCurrentRowndEmailRetirement,
  finishCurrentRowndEmailReconciliation,
  isCurrentRowndEmailReconciliationPlan,
  prepareCurrentRowndEmailReconciliation,
  validateCurrentRowndEmailReconciliation,
  type MigrationEmailPlan,
} from "./migration-email";
import {
  assertMigrationMapping,
  assertMigrationSourceActive,
  getMigrationTarget,
  retireDuplicateMapping,
} from "./migration-mapping";
import Session from "supertokens-node/recipe/session";
import { BooleanClaim } from "supertokens-node/recipe/session/claims";
import type { SessionContainerInterface } from "supertokens-node/recipe/session/types";
import type {
  JSONObject,
  SuperTokensPublicConfig,
  UserContext,
} from "supertokens-node/types";

import {
  DEFAULT_ROWND_SCHEMA,
  GUEST_AUTH_METHOD_ID,
  INSTANT_AUTH_METHOD_ID,
  PASSWORDLESS_BYPASS_DEVICE_CONFIRMATION_PARAM,
  PENDING_EMAIL_VERIFICATION_QUERY_PARAM,
  PUBLIC_TENANT_ID,
} from "./constants";
import { RowndEmailChangeError, RowndPluginError } from "./errors";
import { logDebugMessage } from "./logger";
import { resolveEmailForAuthentication } from "./canonical-email";
import {
  assertRowndAppVariantIsConfigured,
  getConfigForUserContext,
  getPluginConfig,
  getSuperTokensConfig,
  resolvePluginConfigSnapshot,
} from "./config";
import type { SuperTokensUserImport } from "./types";
import { fetchOptionalRowndUserInfo } from "./rownd-repository";
import {
  buildRowndSessionClaimPayload,
  getEffectiveAuthLevel,
  getAnonymousId,
  getThirdPartyId,
  getThirdPartyUserId,
  isIdentityField,
  isInternalMetadataField,
  isSuperTokensFakeEmail,
  mapMethod,
  mapRowndUserToSuperTokens,
  type RowndCompatUserResponse,
  type RowndMetadata,
  type RowndPendingVerification,
  getCombinedUserMetadata,
  getRawUserMetadata,
  mergeMissingValues,
  inspectLinkedUserMetadata,
  hasHistoricalEmailEligibility,
  type PasswordlessAuthSnapshot,
  getHistoricalPasswordlessScope,
  validateHistoricalPasswordlessOwner,
  updatePrimaryUserMetadata,
} from "./rownd-compatibility";
import {
  assertAllowedBypassRedirectPath,
  clearSuperTokensCoreCallCache,
  getErrorMessage,
  getStringList,
  getAppInfoString,
  getMagicLinkBootstrapParams,
  getWebsiteDomain,
  isJsonRecord,
  isRecord,
  normalizeRedirectToPathForClientDomain,
  resolveAllowedClientDomain,
  rewriteMagicLink,
  createDerivedUserContext,
  type JsonRecord,
} from "./utils";

type BypassDisplayContext = "browser" | "mobile_app" | "customer_web_view";

class BulkImportError extends Error {
  constructor(
    readonly status: number,
    readonly responseText: string,
  ) {
    super(
      `Bulk import failed with status ${status}: ${responseText}`,
    );
  }
}

export function isBulkImportDuplicateIdentityError(error: unknown) {
  if (!(error instanceof BulkImportError) || error.status !== 400) {
    return false;
  }

  try {
    const body: unknown = JSON.parse(error.responseText);
    return (
      isRecord(body) &&
      Array.isArray(body.errors) &&
      body.errors.length > 0 &&
      body.errors.every(
        (entry) => typeof entry === "string" && entry.startsWith("E006:"),
      )
    );
  } catch {
    return false;
  }
}

export type CreateMagicLinkWithConfirmationBypassInput = {
  email?: string;
  phoneNumber?: string;
  tenantId?: string;
  request?: any;
  session?: SessionContainerInterface;
  userContext?: Record<string, any>;
  redirectToPath?: string;
  clientDomain?: string;
  displayContext?: BypassDisplayContext;
  appVariantId?: string;
};

export async function importUser(
  stUser: SuperTokensUserImport,
  config: NonNullable<SuperTokensPublicConfig["supertokens"]>,
): Promise<{
  id: string;
  loginMethods: Array<{
    recipeUserId: string;
  }>;
}> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.apiKey) {
    headers["api-key"] = config.apiKey;
  }

  const response = await fetch(`${config.connectionURI}/bulk-import/import`, {
    method: "POST",
    headers,
    body: JSON.stringify(stUser),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new BulkImportError(response.status, errorText);
  }

  const importResponse = (await response.json()) as {
    status: string;
    message?: string;
    user?: {
      id: string;
      loginMethods: Array<{
        recipeUserId: string;
      }>;
    };
  };

  if (importResponse.status !== "OK" || !importResponse.user) {
    throw new Error(
      `Bulk import failed: ${importResponse.message || "Missing user in response"}`,
    );
  }

  return importResponse.user;
}

type SuperTokensUser = NonNullable<
  Awaited<ReturnType<typeof SuperTokens.getUser>>
>;
type SuperTokensLoginMethod = SuperTokensUser["loginMethods"][number];
type ImportLoginMethod = SuperTokensUserImport["loginMethods"][number];
const PENDING_EMAIL_VERIFICATION_USER_CONTEXT_KEY = Symbol(
  "rowndPendingEmailVerificationId",
);

export function getPendingEmailVerificationIdFromUserContext(
  userContext: Record<string, any>,
) {
  const pendingVerificationId = Reflect.get(
    userContext,
    PENDING_EMAIL_VERIFICATION_USER_CONTEXT_KEY,
  ) as unknown;
  return typeof pendingVerificationId === "string"
    ? pendingVerificationId
    : undefined;
}

export function matchesImportLoginMethod(
  loginMethod: SuperTokensLoginMethod,
  importMethod: ImportLoginMethod,
) {
  if (loginMethod.recipeId !== importMethod.recipeId) {
    return false;
  }

  if (importMethod.recipeId === "thirdparty") {
    return loginMethod.hasSameThirdPartyInfoAs({
      id: importMethod.thirdPartyId,
      userId: importMethod.thirdPartyUserId,
    });
  }

  if (importMethod.recipeId === "passwordless") {
    return importMethod.email
      ? loginMethod.hasSameEmailAs(importMethod.email)
      : sameCorePhoneNumber(loginMethod.phoneNumber, importMethod.phoneNumber);
  }

  return loginMethod.hasSameEmailAs(importMethod.email);
}

function getImportMethodAccountInfos(importMethod: ImportLoginMethod) {
  if (importMethod.recipeId === "thirdparty") {
    return [
      {
        thirdParty: {
          id: importMethod.thirdPartyId,
          userId: importMethod.thirdPartyUserId,
        },
      },
      { email: importMethod.email },
    ];
  }

  if (importMethod.recipeId === "emailpassword") {
    return [{ email: importMethod.email }];
  }

  return importMethod.email
    ? [{ email: importMethod.email }]
    : migrationPhoneAccountInfos(importMethod.phoneNumber!);
}

function ownsImportAccountInfo(
  user: SuperTokensUser,
  loginMethod: SuperTokensLoginMethod,
  importMethod: ImportLoginMethod,
) {
  if (matchesImportLoginMethod(loginMethod, importMethod)) {
    return true;
  }
  if (!user.isPrimaryUser) {
    return false;
  }

  if (importMethod.recipeId === "thirdparty") {
    return loginMethod.hasSameEmailAs(importMethod.email);
  }
  if (importMethod.recipeId === "passwordless" && !importMethod.email) {
    return sameCorePhoneNumber(loginMethod.phoneNumber, importMethod.phoneNumber);
  }
  return loginMethod.hasSameEmailAs(importMethod.email);
}

type ImportAccountInfoReader = (tenantId: string, accountInfo: Parameters<typeof SuperTokens.listUsersByAccountInfo>[1]) => ReturnType<typeof SuperTokens.listUsersByAccountInfo>;

function createImportAccountInfoReader(userContext: JsonRecord): ImportAccountInfoReader {
  // Each discovery owns its promises; later passes must observe intervening mutations.
  const searches = new Map<string, ReturnType<ImportAccountInfoReader>>();
  return (tenantId, accountInfo) => {
    const key = JSON.stringify([tenantId, accountInfo]);
    let result = searches.get(key);
    if (!result) {
      result = SuperTokens.listUsersByAccountInfo(tenantId, accountInfo, false, userContext);
      searches.set(key, result);
    }
    return result;
  };
}

async function inspectImportMethod(
  importMethod: ImportLoginMethod,
  tenantId: string,
  userContext: JsonRecord,
  readAccountInfo: ImportAccountInfoReader = (tenant, accountInfo) => SuperTokens.listUsersByAccountInfo(tenant, accountInfo, false, userContext),
) {
  const users = new Map(
    (
      await Promise.all(
        getImportMethodAccountInfos(importMethod).map((accountInfo) =>
          readAccountInfo(tenantId, accountInfo),
        ),
      )
    )
      .flat()
      .map((user) => [user.id, user] as const),
  );

  const owners = [...users.values()].flatMap((user) =>
    user.loginMethods
      .filter(
        (method) =>
          method.tenantIds.includes(tenantId) &&
          ownsImportAccountInfo(user, method, importMethod),
      )
      .map((loginMethod) => ({ user, loginMethod })),
  );
  const exactOwners = new Set(owners.filter(({ loginMethod }) => matchesImportLoginMethod(loginMethod, importMethod)).map(({ user }) => user.id));
  if (exactOwners.size > 1) throw new RowndMigrationPolicyError("PROVIDER_IDENTITY_SPLIT: exact login identity has multiple owners");
  const resolved = resolveMethodInspection({ method: importMethod, owners: owners.map(({ user, loginMethod }) => normalizeMethod(user, loginMethod)), incidentalOwners: [] });
  const match = owners.find(({ loginMethod }) => loginMethod.recipeUserId.getAsString() === resolved.match?.id);
  const reconciliationMatch = owners.find(({ loginMethod }) => loginMethod.recipeUserId.getAsString() === resolved.reconciliationMatch?.id);

  return { importMethod, owners, match, reconciliationMatch };
}

export async function findExistingImportMethodUsers(source: SuperTokensUserImport, tenantId: string, userContext: JsonRecord) {
  const readAccountInfo = createImportAccountInfoReader(userContext);
  const inspections = await Promise.all(source.loginMethods.map((method) => inspectImportMethod(method, tenantId, userContext, readAccountInfo)));
  return [...new Map(inspections.flatMap(({ importMethod, owners }) => owners
    .filter(({ loginMethod }) => matchesImportLoginMethod(loginMethod, importMethod))
    .map(({ user }) => [user.id, user] as const))).values()];
}

export async function inspectMigrationMethods(source: SuperTokensUserImport, methods: ImportLoginMethod[], tenantId: string, userContext: JsonRecord) {
  const authenticatedEmail = getMigrationContactEmail(source, tenantId);
  const readAccountInfo = createImportAccountInfoReader(userContext);
  return Promise.all(methods.map(async (method) => {
    const inspection = await inspectImportMethod(method, tenantId, userContext, readAccountInfo);
    if (method.recipeId !== "passwordless" || authenticatedEmail === undefined ||
        method.email?.toLowerCase() !== authenticatedEmail) return { ...inspection, incidentalEmailOwners: [] };
    // Contact proof does not authorize incidental same-email provider accounts.
    return { ...inspection,
      owners: inspection.owners.filter(({ loginMethod }) => matchesImportLoginMethod(loginMethod, method)),
      incidentalEmailOwners: inspection.owners.filter(({ loginMethod }) => !matchesImportLoginMethod(loginMethod, method)),
      reconciliationMatch: inspection.match,
    };
  }));
}

export function classifyMigrationForeignOwner(owner: { importMethod: ImportLoginMethod; loginMethod: SuperTokensLoginMethod; user: SuperTokensUser },
  preferredUser: SuperTokensUser | undefined, authenticatedEmail: string | undefined, tenantId: string) {
  return classifyMethodOwner(normalizeMethod(owner.user, owner.loginMethod), owner.importMethod,
    preferredUser?.loginMethods.some((method) => method.tenantIds.includes(tenantId)) === true, authenticatedEmail, tenantId);
}

function normalizeMethod(user: SuperTokensUser, method: SuperTokensLoginMethod): MethodRecipe {
  return { id: method.recipeUserId.getAsString(), owner: user.id, primary: user.isPrimaryUser, ownerMethodCount: user.loginMethods.length,
    recipeId: method.recipeId, tenantIds: [...method.tenantIds], verified: method.verified, email: method.email, phoneNumber: method.phoneNumber,
    thirdParty: method.thirdParty ? { ...method.thirdParty } : undefined };
}

export async function discoverMethodSnapshot(input: {
  source: SuperTokensUserImport; tenantId: string; userContext: JsonRecord; preferred?: SuperTokensUser;
  inspections: Awaited<ReturnType<typeof inspectMigrationMethods>>; currentEmailRepair?: boolean; plannedOwnerIds?: Set<string>;
}): Promise<MethodSnapshot> {
  const { source, tenantId, userContext, preferred, inspections } = input;
  const ids = new Map<string, string>();
  const verification = new Map<string, boolean>();
  const verifiedEmail = getAuthenticatedMigrationEmail(source, tenantId);
  for (const user of [preferred, ...inspections.flatMap((entry) => [...entry.owners, ...entry.incidentalEmailOwners].map(({ user }) => user))]) {
    if (!user) continue;
    for (const id of [user.id, ...user.loginMethods.map((method) => method.recipeUserId.getAsString())]) {
      if (!ids.has(id)) ids.set(id, await resolveSuperTokensUserId(id, userContext));
    }
    if (isAdministrativeMigration(source, tenantId) && verifiedEmail !== undefined) for (const method of user.loginMethods) {
      const key = method.recipeUserId.getAsString();
      if (method.tenantIds.includes(tenantId) && method.hasSameEmailAs(verifiedEmail) && !verification.has(key)) {
        verification.set(key, await EmailVerification.isEmailVerified(method.recipeUserId, verifiedEmail, userContext));
      }
    }
  }
  const target = preferred && ids.get(preferred.id)!;
  const projectOwner = (id: string) => target && (input.plannedOwnerIds?.has(id) || input.plannedOwnerIds?.has(ids.get(id)!)) ? target : ids.get(id)!;
  const normalize = ({ user, loginMethod }: { user: SuperTokensUser; loginMethod: SuperTokensLoginMethod }) => ({ ...normalizeMethod(user, loginMethod),
    id: ids.get(loginMethod.recipeUserId.getAsString())!, owner: projectOwner(user.id), verified: verification.get(loginMethod.recipeUserId.getAsString()) ?? loginMethod.verified });
  return { tenantId, administrative: isAdministrativeMigration(source, tenantId), contactEmail: getMigrationContactEmail(source, tenantId), verifiedEmail: getAuthenticatedMigrationEmail(source, tenantId), sourceMethods: source.loginMethods,
    preferred: preferred ? { id: target!, primary: preferred.isPrimaryUser, recipes: preferred.loginMethods.map((loginMethod) => normalize({ user: preferred, loginMethod })) } : undefined,
    currentEmailRepair: input.currentEmailRepair === true,
    recipes: [...new Map([preferred, ...inspections.flatMap((entry) => entry.owners.map(({ user }) => user))].filter((user): user is SuperTokensUser => user !== undefined)
      .flatMap((user) => user.loginMethods.map((loginMethod) => { const recipe = normalize({ user, loginMethod }); return [recipe.id, recipe] as const; }))).values()],
    inspections: inspections.map((entry) => ({ method: entry.importMethod, owners: entry.owners.map(normalize), match: entry.match && normalize(entry.match),
      reconciliationMatch: entry.reconciliationMatch && normalize(entry.reconciliationMatch), incidentalOwners: entry.incidentalEmailOwners.map(({ user }) => projectOwner(user.id)) })) };
}

export function getMigrationImportMethods(source: SuperTokensUserImport, tenantId: string, repairUser: SuperTokensUser | undefined,
  canonicalEmailId: string | undefined, hasPendingEmail: boolean | undefined) {
  return selectMigrationMethods({ methods: source.loginMethods, tenantId, canonicalEmailId, pendingEmail: hasPendingEmail === true,
    administrative: isAdministrativeMigration(source, tenantId), verifiedEmail: getAuthenticatedMigrationEmail(source, tenantId),
    repairRecipes: repairUser?.loginMethods.map((method) => normalizeMethod(repairUser, method)) });
}

export async function createMissingLoginMethod(
  importMethod: ImportLoginMethod,
  tenantId: string,
  primaryUserId: string,
  userContext: JsonRecord,
  source?: SuperTokensUserImport,
  strategy?: "IMPORT_UNVERIFIED" | "SIGN_IN_UP",
) {
  const operationContext = createDerivedUserContext(userContext, {
    rowndDisableAutomaticAccountLinking: true,
  });
  if (importMethod.recipeId === "thirdparty") {
    const result = await ThirdParty.manuallyCreateOrUpdateUser(
      tenantId,
      importMethod.thirdPartyId,
      importMethod.thirdPartyUserId,
      importMethod.email,
      importMethod.isVerified,
      undefined,
      operationContext,
    );
    if (result.status !== "OK") {
      throw new Error(
        `Failed to create migrated third-party login method: ${result.status}`,
      );
    }
    if (result.createdNewRecipeUser) {
      migrationTelemetry(userContext)?.emit("transition", "login_method_created");
    }
    if (
      !result.createdNewRecipeUser &&
      !(await sdkUserIdMatchesInternalTarget(
        result.user.id,
        primaryUserId,
        operationContext,
      ))
    ) {
      throw new RowndMigrationPolicyError(
        "Migrated third-party login method belongs to another SuperTokens user",
      );
    }
    return {
      recipeUserId: result.recipeUserId,
      createdNewRecipeUser: result.createdNewRecipeUser,
    };
  }

  if (importMethod.recipeId === "passwordless") {
    if (importMethod.email && source && (strategy === "IMPORT_UNVERIFIED" || strategy === undefined && isAdministrativeMigration(source, tenantId) && getAuthenticatedMigrationEmail(source, tenantId) === undefined)) {
      await assertAuthenticatedMigrationSource(source, tenantId);
      const core = getSuperTokensConfig()?.supertokens;
      if (!core) throw new Error("SuperTokens Core configuration is missing");
      // Passwordless.signInUp verifies new emails. Import creates an unverified
      // credential atomically before the existing engine links it.
      const imported = await importUser({ userMetadata: {}, loginMethods: [{ ...importMethod, isPrimary: false, isVerified: false, tenantIds: [tenantId] }] }, core);
      if (imported.loginMethods.length !== 1 || !imported.loginMethods[0]?.recipeUserId) throw new Error("Unverified email import returned no recipe ID");
      clearSuperTokensCoreCallCache(userContext);
      return { recipeUserId: SuperTokens.convertToRecipeUserId(imported.loginMethods[0].recipeUserId), createdNewRecipeUser: true };
    }
    const result = importMethod.email
      ? await Passwordless.signInUp({
        tenantId,
        email: importMethod.email,
        userContext: operationContext,
      })
      : await Passwordless.signInUp({
        tenantId,
        phoneNumber: importMethod.phoneNumber!,
        userContext: operationContext,
      });

    if (result.createdNewRecipeUser) {
      migrationTelemetry(userContext)?.emit("transition", "login_method_created");
    }
    if (
      !result.createdNewRecipeUser &&
      !(await existingPasswordlessMethodMatchesInternalTarget(
        result.recipeUserId,
        importMethod,
        tenantId,
        primaryUserId,
        operationContext,
      ))
    ) {
      throw new RowndMigrationPolicyError(
        "Migrated passwordless login method belongs to another SuperTokens user",
      );
    }

    return {
      recipeUserId: result.recipeUserId,
      createdNewRecipeUser: result.createdNewRecipeUser,
    };
  }

  throw new Error(
    `Cannot reconcile unsupported login method: ${importMethod.recipeId}`,
  );
}

export async function ensurePrimaryUser(
  user: SuperTokensUser,
  recipeUserId: SuperTokensLoginMethod["recipeUserId"],
  superTokensUserId: string,
  userContext: JsonRecord,
) {
  if (user.isPrimaryUser) {
    return superTokensUserId;
  }

  const result = await AccountLinking.createPrimaryUser(
    recipeUserId,
    userContext,
  );
  if (result.status === "OK") {
    return superTokensUserId;
  }
  if (
    result.status === "RECIPE_USER_ID_ALREADY_LINKED_WITH_PRIMARY_USER_ID_ERROR"
  ) {
    if (
      await sdkUserIdMatchesInternalTarget(
        result.primaryUserId,
        superTokensUserId,
        userContext,
      )
    ) {
      return superTokensUserId;
    }
  }

  throw new RowndMigrationPolicyError(
    "A migrated login method belongs to a different primary user",
  );
}

async function resolveSuperTokensUserId(
  userId: string,
  userContext: JsonRecord,
) {
  const mapping = await SuperTokens.getUserIdMapping({
    userId,
    userIdType: "EXTERNAL",
    userContext,
  });
  return mapping.status === "OK" ? mapping.superTokensUserId : userId;
}

async function freshlyResolveSdkUserIdToInternal(
  sdkUserId: string,
  userContext: JsonRecord,
) {
  clearSuperTokensCoreCallCache(userContext);
  return resolveSuperTokensUserId(sdkUserId, userContext);
}

async function sdkUserIdMatchesInternalTarget(
  sdkUserId: string,
  expectedInternalUserId: string,
  userContext: JsonRecord,
) {
  if (sdkUserId === expectedInternalUserId) {
    return true;
  }

  return (
    (await freshlyResolveSdkUserIdToInternal(sdkUserId, userContext)) ===
    expectedInternalUserId
  );
}

async function existingPasswordlessMethodMatchesInternalTarget(
  recipeUserId: SuperTokensLoginMethod["recipeUserId"],
  importMethod: Extract<ImportLoginMethod, { recipeId: "passwordless" }>,
  tenantId: string,
  expectedInternalUserId: string,
  userContext: JsonRecord,
) {
  // Another migration may have linked this recipe after signInUp took its snapshot.
  clearSuperTokensCoreCallCache(userContext);
  const user = await SuperTokens.getUser(recipeUserId.getAsString(), userContext);
  if (
    !user?.isPrimaryUser ||
    !user.loginMethods.some(
      (method) =>
        method.recipeUserId.getAsString() === recipeUserId.getAsString() &&
        method.tenantIds.includes(tenantId) &&
        matchesImportLoginMethod(method, importMethod),
    )
  ) {
    return false;
  }

  return sdkUserIdMatchesInternalTarget(
    user.id,
    expectedInternalUserId,
    userContext,
  );
}

async function assertUserIsNotMappedToAnotherRowndUser(
  superTokensUserId: string,
  rowndUserId: string,
  userContext: JsonRecord,
) {
  const mapping = await SuperTokens.getUserIdMapping({
    userId: superTokensUserId,
    userIdType: "SUPERTOKENS",
    userContext,
  });
  if (mapping.status === "OK" && mapping.externalUserId !== rowndUserId) {
    throw new RowndMigrationPolicyError(
      "A migrated login method is already mapped to another Rownd user",
    );
  }
}

async function assertRowndUserIdCanBeMapped(
  superTokensUserId: string,
  rowndUserId: string,
  userContext: JsonRecord,
) {
  const externalMapping = await SuperTokens.getUserIdMapping({
    userId: rowndUserId,
    userIdType: "EXTERNAL",
    userContext,
  });
  if (externalMapping.status === "OK") {
    if (externalMapping.superTokensUserId !== superTokensUserId) {
      throw new RowndMigrationPolicyError(
        "The Rownd user ID is already mapped to another SuperTokens user",
      );
    }
    return true;
  }

  const internalMapping = await SuperTokens.getUserIdMapping({
    userId: superTokensUserId,
    userIdType: "SUPERTOKENS",
    userContext,
  });
  if (
    internalMapping.status === "OK" &&
    internalMapping.externalUserId !== rowndUserId
  ) {
    throw new RowndMigrationPolicyError(
      "The SuperTokens user is already mapped to another external user ID",
    );
  }
  if (internalMapping.status === "OK") {
    return true;
  }

  return false;
}

export async function createRowndUserIdMapping(
  superTokensUserId: string,
  rowndUserId: string,
  userContext: JsonRecord,
  force = false,
) {
  const result = await SuperTokens.createUserIdMapping({
    superTokensUserId,
    externalUserId: rowndUserId,
    force,
    userContext,
  });
  if (result.status === "USER_ID_MAPPING_ALREADY_EXISTS_ERROR") {
    // A preflight UNKNOWN_MAPPING_ERROR may still be cached after a sibling creates the mapping.
    clearSuperTokensCoreCallCache(userContext);
    const existingMapping = await SuperTokens.getUserIdMapping({
      userId: rowndUserId,
      userIdType: "EXTERNAL",
      userContext,
    });
    if (
      existingMapping.status === "OK" &&
      existingMapping.superTokensUserId === superTokensUserId
    ) {
      return false;
    }
  }
  if (result.status !== "OK") {
    const message = `Failed to map migrated Rownd user ID: ${result.status}`;
    if (result.status === "USER_ID_MAPPING_ALREADY_EXISTS_ERROR" || result.status === "UNKNOWN_SUPERTOKENS_USER_ID_ERROR") {
      throw new RowndMigrationPolicyError(message);
    }
    throw new Error(message);
  }
  return true;
}

export async function reconcileRowndUserWithExistingLoginMethods(
  stUser: SuperTokensUserImport,
  tenantId: string,
  userContext: JsonRecord,
  options?: { repairUser?: SuperTokensUser; expectedInternalUserId?: string; onTargetSelected?: (id: string) => void; methodPlan?: MethodPlan },
) {
  let lastError: unknown;
  const targetBinding: { internalUserId?: string; retryMapping?: boolean; introduced: ProviderIntroduction[] } = { internalUserId: options?.expectedInternalUserId, introduced: [] };
  if (stUser.externalUserId) {
    const mapping = await SuperTokens.getUserIdMapping({ userId: stUser.externalUserId, userIdType: "EXTERNAL", userContext });
    if (mapping.status === "OK") {
      if (targetBinding.internalUserId !== undefined && mapping.superTokensUserId !== targetBinding.internalUserId) {
        throw new RowndMigrationPolicyError("Failed to map migrated Rownd user ID: the reconciliation target changed");
      }
      targetBinding.internalUserId = mapping.superTokensUserId;
      options?.onTargetSelected?.(mapping.superTokensUserId);
      await assertAuthenticatedMigrationSource(stUser, tenantId);
      await recoverProviderRevocations(mapping.superTokensUserId, stUser.externalUserId, tenantId, userContext);
      if (isAdministrativeMigration(stUser, tenantId)) {
        const owner = await SuperTokens.getUser(mapping.superTokensUserId, userContext);
        if (!owner) throw new RowndMigrationPolicyError("MAPPING_TARGET_MISSING: reconciliation target does not exist");
        await assertMigrationOwnerGraph(owner, tenantId, userContext);
      }
      if (isAdministrativeMigration(stUser, tenantId)) await assertAuthenticatedMigrationSource(stUser, tenantId);
      if (isAdministrativeMigration(stUser, tenantId)) {
        await inspectAdministrativeProviderIntroductions(stUser, tenantId, mapping.superTokensUserId, userContext);
      } else {
        await finishProviderIntroductions(mapping.superTokensUserId, stUser.externalUserId, userContext, true);
      }
    }
  }
  if (isAdministrativeMigration(stUser, tenantId)) {
    // Administrative repair discovers current identities even for completed mappings.
    for (const method of stUser.loginMethods) await inspectImportMethod(method, tenantId, userContext);
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    clearSuperTokensCoreCallCache(userContext);
    try {
      const result = await reconcileRowndUserOnce(
        stUser, tenantId, userContext, targetBinding, options,
      );
      if (targetBinding.internalUserId) {
        await assertCurrentRowndProviders(stUser, tenantId);
        if (isAdministrativeMigration(stUser, tenantId)) await assertAuthenticatedMigrationSource(stUser, tenantId);
        if (isAdministrativeMigration(stUser, tenantId)) await finishAdministrativeProviderIntroductions(stUser, tenantId, targetBinding.internalUserId, userContext);
        else await finishProviderIntroductions(targetBinding.internalUserId, stUser.externalUserId!, userContext, false, targetBinding.introduced);
      }
      return result;
    } catch (error) {
      try {
        if (isAdministrativeMigration(stUser, tenantId)) await assertAuthenticatedMigrationSource(stUser, tenantId);
        if (targetBinding.internalUserId && !isAdministrativeMigration(stUser, tenantId)) {
          await finishProviderIntroductions(targetBinding.internalUserId, stUser.externalUserId!, userContext, true, targetBinding.introduced);
        }
      } catch (recoveryError) {
        // Recovery must remain authorized, but its observation failure must not
        // hide the operation that originally failed.
        throw isAdministrativeMigration(stUser, tenantId) ? error : recoveryError;
      }
      targetBinding.introduced = [];
      lastError = error;
      if (!targetBinding.retryMapping) throw error;
    }
  }
  throw lastError;
}

async function reconcileRowndUserOnce(
  stUser: SuperTokensUserImport,
  tenantId: string,
  userContext: JsonRecord,
  targetBinding: { internalUserId?: string; retryMapping?: boolean; introduced: ProviderIntroduction[] },
  options?: { repairUser?: SuperTokensUser; expectedInternalUserId?: string; onTargetSelected?: (id: string) => void; methodPlan?: MethodPlan },
) {
  if (!stUser.externalUserId) {
    throw new Error("Migrated Rownd user has no external user ID");
  }
  targetBinding.retryMapping = false;
  const authenticatedEmail = getMigrationContactEmail(stUser, tenantId);
  await assertAuthenticatedMigrationSource(stUser, tenantId);

  const requestedMetadata = await assertMigrationSourceActive(
    stUser.externalUserId, userContext,
  );
  const externalMapping = await SuperTokens.getUserIdMapping({
    userId: stUser.externalUserId,
    userIdType: "EXTERNAL",
    userContext,
  });
  const pinnedId = externalMapping.status === "OK"
    ? externalMapping.superTokensUserId
    : getMigrationTarget(requestedMetadata);
  const mappedUser = await SuperTokens.getUser(
    pinnedId ?? stUser.externalUserId, userContext,
  );
  if (pinnedId !== undefined && !mappedUser) throw new RowndMigrationPolicyError("MAPPING_TARGET_MISSING: reconciliation target does not exist");
  const currentUser = mappedUser ?? options?.repairUser;
  if (currentUser && isAdministrativeMigration(stUser, tenantId)) await assertMigrationOwnerGraph(currentUser, tenantId, userContext);
  const currentOwner = currentUser ? await resolveSuperTokensUserId(currentUser.id, userContext) : undefined;
  if (targetBinding.internalUserId !== undefined &&
      ((pinnedId !== undefined && pinnedId !== targetBinding.internalUserId) ||
       (currentOwner !== undefined && currentOwner !== targetBinding.internalUserId))) {
    throw new RowndMigrationPolicyError("Failed to map migrated Rownd user ID: the reconciliation target changed");
  }
  if (currentOwner !== undefined) {
    targetBinding.internalUserId = currentOwner;
    options?.onTargetSelected?.(currentOwner);
  }
  // Bulk import stored migration state under the Rownd alias. Only that exact,
  // token-bound alias may supply missing state; primary metadata stays authoritative.
  const repairMetadata = currentUser
    ? await getAdministrativeRepairMetadata(currentUser.id, stUser.externalUserId, userContext)
    : undefined;
  const originalRowndUserId = repairMetadata?.original_rownd_user?.data?.user_id;
  if (mappedUser && pinnedId === undefined && originalRowndUserId !== stUser.externalUserId &&
      !mappedUser.loginMethods.some((method) => stUser.loginMethods.some(
        (expected) => matchesImportLoginMethod(method, expected),
      ))) {
    throw new RowndMigrationPolicyError("Rownd user ID collides with an unrelated internal account");
  }
  const repairUser = currentUser &&
    (options?.repairUser || repairMetadata?.rownd_migration_complete === true ||
      repairMetadata?.rownd_migration_complete === false && originalRowndUserId === stUser.externalUserId) &&
    (originalRowndUserId === undefined || originalRowndUserId === stUser.externalUserId)
    ? currentUser : undefined;
  const canonicalEmailId = repairMetadata
    ? getCanonicalEmailRecipeUserId(repairMetadata, tenantId)
    : undefined;
  const administrativeCanonicalEmail = currentUser && repairMetadata && currentOwner
    ? await prepareAdministrativeCanonicalEmail(stUser, currentUser, repairMetadata, currentOwner, tenantId, userContext) : undefined;
  const finishEmailReconciliation = async (internalUserId: string, plan: RowndPendingVerification) => {
    await assertMigrationMapping(internalUserId, stUser.externalUserId!, userContext);
    await finishCurrentRowndEmailReconciliation({
      internalUserId, plan, tenantId, userContext,
      removeMethod: (recipeUserId, scopedTenantId, sdkUserId) =>
        removePasswordlessMethodFromTenant(recipeUserId, scopedTenantId, sdkUserId, true, userContext),
    });
  };
  const migrationEmailPlan = repairMetadata && getCommittingEmailPlansForTenant(repairMetadata, tenantId).find(
    isCurrentRowndEmailReconciliationPlan,
  );
  const hasPendingEmail = repairMetadata && getPendingVerifications(repairMetadata).some(
    (verification) => verification.field === "email" &&
      (verification.tenantId ?? PUBLIC_TENANT_ID) === tenantId,
  );
  const currentEmailReconciliation = repairUser && repairMetadata && !canonicalEmailId && !hasPendingEmail && !administrativeCanonicalEmail?.changesCanonical
    ? await prepareCurrentRowndEmailReconciliation(stUser, repairUser, repairMetadata, tenantId)
    : undefined;
  const finishProviderRetirement = repairUser && repairMetadata
    ? await prepareRowndProviderRetirement({
      source: stUser, user: repairUser, metadata: repairMetadata,
      internalUserId: currentOwner!, tenantId, userContext,
    }) : undefined;
  // Rownd provider subjects remain authoritative during migration.
  const importMethods = getMigrationImportMethods(stUser, tenantId, repairUser, canonicalEmailId, hasPendingEmail);
  if (!isAdministrativeMigration(stUser, tenantId) && repairUser && repairMetadata?.rownd_migration_complete === true &&
      importMethods.length === 0 && !migrationEmailPlan && !currentEmailReconciliation && !finishProviderRetirement && !administrativeCanonicalEmail?.changesCanonical) {
    const internalId = currentOwner!;
    await assertMigrationMapping(internalId, stUser.externalUserId, userContext);
    await reconcileAdministrativeEmailVerification({ internalUserId: internalId, source: stUser, tenantId, userContext });
    await backfillAdministrativeMetadata({ source: stUser, tenantId, internalUserId: internalId, userContext });
    return true;
  }

  clearSuperTokensCoreCallCache(userContext);
  const resolvedUserIds = new Map<string, Promise<string>>();
  const resolveUserId = (userId: string) => {
    let resolved = resolvedUserIds.get(userId);
    if (!resolved) {
      resolved = resolveSuperTokensUserId(userId, userContext);
      resolvedUserIds.set(userId, resolved);
    }
    return resolved;
  };

  const inspections = await inspectMigrationMethods(stUser, importMethods, tenantId, userContext);
  if (isAdministrativeMigration(stUser, tenantId)) {
    for (const user of new Map(inspections.flatMap(({ owners }) => owners.map(({ user }) => [user.id, user] as const))).values()) {
      await assertMigrationOwnerGraph(user, tenantId, userContext);
    }
  }
  const preferredUser = mappedUser ?? repairUser;
  const methodSnapshot = await discoverMethodSnapshot({ source: stUser, tenantId, userContext, preferred: preferredUser, inspections,
    currentEmailRepair: currentEmailReconciliation !== undefined });
  const methodPlan = planMethods(methodSnapshot);
  if (methodPlan.status === "BLOCKED") throw new RowndMigrationPolicyError(methodPlan.reason);
  if (options?.methodPlan && !methodPlanAllows(options.methodPlan, methodPlan)) throw new RowndMigrationPolicyError("Method reconciliation assumptions changed; rediscover before retrying");
  if (!methodPlan.target) return false;
  const thirdPartyMatches = inspections.flatMap(({ importMethod, match }) =>
    importMethod.recipeId === "thirdparty" && match ? [match] : [],
  );
  const targetUser = preferredUser ?? (await SuperTokens.getUser(methodPlan.target.id, userContext))!;
  let targetMethod: SuperTokensLoginMethod | undefined;
  for (const method of targetUser?.loginMethods ?? []) if (await resolveUserId(method.recipeUserId.getAsString()) === methodPlan.target.recipe.id) targetMethod = method;
  if (!targetUser || !targetMethod) throw new RowndMigrationPolicyError("Planned migration target disappeared");
  const target = { user: targetUser, loginMethod: targetMethod };
  const targetSuperTokensUserId = await resolveUserId(target.user.id);
  if (targetBinding.internalUserId !== undefined &&
      targetBinding.internalUserId !== targetSuperTokensUserId) {
    throw new RowndMigrationPolicyError(
      "Failed to map migrated Rownd user ID: the reconciliation target changed",
    );
  }
  targetBinding.internalUserId = targetSuperTokensUserId;
  options?.onTargetSelected?.(targetSuperTokensUserId);
  const inspectedOwners = await Promise.all(
    inspections.flatMap(({ importMethod, owners }) =>
      owners.map(async ({ user, loginMethod }) => ({
        importMethod,
        user,
        loginMethod,
        superTokensUserId: await resolveUserId(user.id),
      })),
    ),
  );
  const foreignOwners = inspectedOwners.filter(
    ({ superTokensUserId }) => superTokensUserId !== targetSuperTokensUserId,
  );
  const classifyOwner = (owner: typeof foreignOwners[number]) => classifyMigrationForeignOwner(owner, preferredUser, authenticatedEmail, tenantId);
  const isExactProviderOwner = (owner: typeof foreignOwners[number]) => classifyOwner(owner).provider;
  const isExactPhoneOwner = (owner: typeof foreignOwners[number]) => classifyOwner(owner).phone;
  const canLinkProviderEmailOwners =
    (thirdPartyMatches.length > 0 ||
      repairUser?.loginMethods.some(
        (method) =>
          method.recipeId === "thirdparty" &&
          method.tenantIds.includes(tenantId),
      )) &&
    inspectedOwners
      .filter(({ importMethod }) => importMethod.recipeId === "thirdparty")
      .every(
        (owner) =>
          owner.superTokensUserId === targetSuperTokensUserId ||
          isExactProviderOwner(owner),
      );
  const canonicalPhoneAnchor = preferredUser?.loginMethods.find(
    (method) => method.recipeId === "passwordless" &&
      method.phoneNumber !== undefined && method.tenantIds.includes(tenantId) &&
      stUser.loginMethods.some((expected) =>
        expected.recipeId === "passwordless" && expected.email === undefined &&
        matchesImportLoginMethod(method, expected)),
  );
  const isExactVerifiedEmailOwner = (owner: typeof foreignOwners[number]) => classifyOwner(owner).verifiedEmail;
  const isAuthenticatedContactOwner = (owner: typeof foreignOwners[number]) => classifyOwner(owner).authenticatedContact;
  const phoneOwners = foreignOwners.filter(isExactPhoneOwner);
  const phoneAnchoredEmailOwners = canonicalPhoneAnchor && !canLinkProviderEmailOwners
    ? foreignOwners.filter(isExactVerifiedEmailOwner) : [];
  const currentProfileOwners = [...phoneOwners, ...phoneAnchoredEmailOwners];
  if (currentEmailReconciliation) {
    for (const owner of foreignOwners.filter(({ importMethod }) =>
      importMethod.recipeId === "passwordless" && importMethod.email !== undefined)) {
      if (!isAuthenticatedContactOwner(owner)) {
        await assertUserIsNotMappedToAnotherRowndUser(owner.superTokensUserId, stUser.externalUserId, userContext);
      }
    }
  }
  if (currentProfileOwners.length > 0) {
    // Legacy phone proof remains separate from authenticated contact ownership.
    const freshSource = await fetchOptionalRowndUserInfo(stUser.externalUserId);
    if (!freshSource || freshSource.data?.user_id !== stUser.externalUserId ||
        phoneOwners.some(({ importMethod }) =>
          importMethod.recipeId !== "passwordless" ||
          freshSource.data.phone_number !== importMethod.phoneNumber)) {
      throw new RowndMigrationPolicyError("Requested Rownd phone identity changed before linking");
    }
    if (phoneAnchoredEmailOwners.length > 0) {
      const freshMethods = mapRowndUserToSuperTokens(freshSource, tenantId).loginMethods;
      if (freshSource.data.phone_number !== canonicalPhoneAnchor?.phoneNumber ||
          phoneAnchoredEmailOwners.some(({ loginMethod }) => !freshMethods.some(
            (method) => method.recipeId === "passwordless" && method.email !== undefined &&
              (method.isVerified || authenticatedEmail === method.email.toLowerCase()) && loginMethod.hasSameEmailAs(method.email),
          ))) {
        throw new RowndMigrationPolicyError("Requested Rownd phone-anchored email identity changed before linking");
      }
    }
    for (const owner of currentProfileOwners) {
      if (!isAuthenticatedContactOwner(owner)) {
        await assertUserIsNotMappedToAnotherRowndUser(
          owner.superTokensUserId, stUser.externalUserId, userContext,
        );
      }
    }
  }
  clearSuperTokensCoreCallCache(userContext);
  const freshMethods = planMethods(await discoverMethodSnapshot({ source: stUser, tenantId, userContext,
    preferred: preferredUser ? await SuperTokens.getUser(targetSuperTokensUserId, userContext) : undefined,
    inspections: await inspectMigrationMethods(stUser, importMethods, tenantId, userContext), currentEmailRepair: currentEmailReconciliation !== undefined }));
  if (freshMethods.status === "BLOCKED" || !methodPlanAllows(methodPlan, freshMethods)) throw new RowndMigrationPolicyError("Method reconciliation assumptions changed before execution");
  const completionInvalidated = repairUser !== undefined && repairMetadata?.rownd_migration_complete === true &&
    (freshMethods.actions.length > 0 || migrationEmailPlan !== undefined || currentEmailReconciliation !== undefined || finishProviderRetirement !== undefined || administrativeCanonicalEmail?.changesCanonical === true);
  if (completionInvalidated) {
    // A committed link can precede the more detailed retirement checkpoint.
    // Keep retries out of the completed-login fast path across that crash window.
    await assertMigrationMapping(targetSuperTokensUserId, stUser.externalUserId, userContext);
    await UserMetadata.updateUserMetadata(targetSuperTokensUserId, { rownd_migration_complete: false }, userContext);
  }
  if (repairUser && migrationEmailPlan) await finishEmailReconciliation(currentOwner!, migrationEmailPlan);
  for (const foreignOwner of foreignOwners) {
    targetBinding.retryMapping = true;
    await retireDuplicateMapping({
      source: stUser,
      ownerInternalId: foreignOwner.superTokensUserId,
      targetInternalId: targetSuperTokensUserId,
      tenantId,
      userContext,
    });
    await assertUserIsNotMappedToAnotherRowndUser(
      foreignOwner.superTokensUserId,
      stUser.externalUserId,
      userContext,
    );
    targetBinding.retryMapping = false;
  }
  let mappingAlreadyExists = targetSuperTokensUserId === stUser.externalUserId;
  const telemetry = migrationTelemetry(userContext);
  if (telemetry) {
    telemetry.superTokensUserId = targetSuperTokensUserId;
    telemetry.stage = "id_mapping";
  }
  if (!mappingAlreadyExists) {
    targetBinding.retryMapping = true;
    await retireDuplicateMapping({
      source: stUser,
      ownerInternalId: targetSuperTokensUserId,
      targetInternalId: targetSuperTokensUserId,
      tenantId,
      userContext,
    });
    clearSuperTokensCoreCallCache(userContext);
    mappingAlreadyExists = await assertRowndUserIdCanBeMapped(
      targetSuperTokensUserId,
      stUser.externalUserId,
      userContext,
    );
    if (!mappingAlreadyExists) {
      await createRowndUserIdMapping(
        targetSuperTokensUserId,
        stUser.externalUserId,
        userContext,
        getMigrationTarget(await getRawUserMetadata(stUser.externalUserId, userContext)) === targetSuperTokensUserId,
      );
      telemetry?.emit("transition", "id_mapping_completed");
    }
  }
  targetBinding.retryMapping = false;
  await assertMigrationMapping(
    targetSuperTokensUserId, stUser.externalUserId, userContext,
  );
  const primaryUserId = targetSuperTokensUserId;
  const createdRecipes = new Map<string, string>();
  for (const action of freshMethods.actions) {
    await assertAuthenticatedMigrationSource(stUser, tenantId);
    await assertMigrationMapping(primaryUserId, stUser.externalUserId, userContext);
    if (action.kind === "IMPORT_USER") throw new RowndMigrationPolicyError("Import action cannot execute against an existing target");
    if (action.kind === "VERIFY_ADMIN_EMAIL") continue;
    if (action.kind === "ENSURE_PRIMARY") {
      if (action.target !== primaryUserId || action.recipe.kind !== "existing") throw new RowndMigrationPolicyError("Planned primary target changed");
      if (telemetry) telemetry.stage = "primary_user";
      await ensurePrimaryUser(target.user, SuperTokens.convertToRecipeUserId(action.recipe.id), action.target, userContext);
      telemetry?.emit("transition", "primary_user_ensured");
      continue;
    }
    if (action.kind === "CREATE_THIRDPARTY" || action.kind === "CREATE_PASSWORDLESS") {
      if (telemetry) telemetry.stage = "login_method_creation";
      const creation = await createMissingLoginMethod(action.method, tenantId, primaryUserId, userContext, stUser,
        action.kind === "CREATE_PASSWORDLESS" ? action.strategy : undefined);
      const id = creation.recipeUserId.getAsString();
      createdRecipes.set(action.recipe.key, id);
      if (creation.createdNewRecipeUser) await recordAdministrativeMethodCreation(stUser, id);
      if (creation.createdNewRecipeUser && action.kind === "CREATE_THIRDPARTY") {
        await checkpointProviderIntroduction({ source: stUser, internalUserId: primaryUserId, recipeUserId: id, tenantId,
          provider: action.method.thirdPartyId, subject: action.method.thirdPartyUserId, created: true, userContext, introduced: targetBinding.introduced });
      }
      continue;
    }
    const id = action.recipe.kind === "existing" ? action.recipe.id : createdRecipes.get(action.recipe.key);
    if (!id) throw new RowndMigrationPolicyError("Planned method recipe is unresolved");
    const recipeUserId = SuperTokens.convertToRecipeUserId(id);
    if (action.kind === "LINK") {
      if (action.target !== primaryUserId) throw new RowndMigrationPolicyError("Planned link target changed");
      if (telemetry) telemetry.stage = "account_linking";
      await assertUserIsNotMappedToAnotherRowndUser(id, stUser.externalUserId, userContext);
      clearSuperTokensCoreCallCache(userContext);
      const beforeLink = await SuperTokens.getUser(id, userContext);
      const alreadyLinked = beforeLink ? await sdkUserIdMatchesInternalTarget(beforeLink.id, primaryUserId, userContext) : false;
      if (!beforeLink || (!alreadyLinked &&
          (beforeLink.isPrimaryUser || !beforeLink.loginMethods.some((method) =>
            method.recipeUserId.getAsString() === id && method.tenantIds.includes(tenantId) && matchesImportLoginMethod(method, action.method))))) {
        throw new RowndMigrationPolicyError("Migrated login method ownership changed before linking");
      }
      if (alreadyLinked) continue;
      if (action.recipe.kind === "existing" && action.expectedOwner !== await resolveUserId(beforeLink.id)) throw new RowndMigrationPolicyError("Planned donor owner changed");
      if (action.recipe.kind === "existing" && action.method.recipeId === "thirdparty") {
        await checkpointProviderIntroduction({ source: stUser, internalUserId: primaryUserId, recipeUserId: id, tenantId,
          provider: action.method.thirdPartyId, subject: action.method.thirdPartyUserId, created: false, userContext, introduced: targetBinding.introduced });
      }
      if (action.method.recipeId === "thirdparty") await assertCurrentRowndProviders(stUser, tenantId);
      await assertAuthenticatedMigrationSource(stUser, tenantId);
      const linkResult = await AccountLinking.linkAccounts(recipeUserId, primaryUserId, userContext);
      clearSuperTokensCoreCallCache(userContext);
      const freshOwner = await SuperTokens.getUser(id, userContext);
      if (!freshOwner || !await sdkUserIdMatchesInternalTarget(freshOwner.id, primaryUserId, userContext)) {
        throw new Error(`Failed to link migrated login method: ${linkResult.status}`);
      }
      telemetry?.emit("transition", "account_link_completed", "success", undefined, { recipeUserId: id, recipeId: action.method.recipeId });
      continue;
    }
    if (telemetry) telemetry.stage = "email_verification";
    // Linking needs pinned internal IDs; verification uses Core's current alias.
    // The old donor alias may have been retired or replaced during reconciliation.
    const verificationMapping = await SuperTokens.getUserIdMapping({ userId: id, userIdType: "SUPERTOKENS", userContext });
    const verificationRecipeUserId = verificationMapping?.status === "OK"
      ? SuperTokens.convertToRecipeUserId(verificationMapping.externalUserId) : recipeUserId;
    const verificationOwner = await SuperTokens.getUser(id, userContext);
    const verificationMethod = verificationOwner?.loginMethods.find((method) => method.recipeUserId.getAsString() === verificationRecipeUserId.getAsString() &&
      method.recipeId === "passwordless" && method.tenantIds.includes(tenantId) && method.hasSameEmailAs(action.email));
    if (!verificationOwner || !await sdkUserIdMatchesInternalTarget(verificationOwner.id, primaryUserId, userContext) || !verificationMethod) {
      throw new RowndMigrationPolicyError("Planned verification identity changed");
    }
    // Core's fresh login method already carries verification state. Reading it
    // must not require the optional EmailVerification recipe to be initialized.
    const verified = verificationMethod.verified;
    if (!action.verified && verified) {
      await EmailVerification.unverifyEmail(
        verificationRecipeUserId,
        action.email,
        userContext,
      );
    } else if (action.verified && !verified) {
      const tokenResult = await EmailVerification.createEmailVerificationToken(
        tenantId,
        verificationRecipeUserId,
        action.email,
        userContext,
      );
      if (tokenResult.status === "OK") {
        const verificationResult =
          await EmailVerification.verifyEmailUsingToken(
            tenantId,
            tokenResult.token,
            false,
            userContext,
          );
        if (verificationResult.status !== "OK") {
          throw new Error("Failed to verify migrated email method");
        }
      }
    }
  }
  await finishProviderRetirement?.();
  await administrativeCanonicalEmail?.publish();
  for (const action of freshMethods.actions) if (action.kind === "VERIFY_ADMIN_EMAIL") {
    if (action.target !== primaryUserId || action.email !== getAuthenticatedMigrationEmail(stUser, tenantId)) throw new RowndMigrationPolicyError("Planned email verification authority changed");
    await reconcileAdministrativeEmailVerification({ internalUserId: primaryUserId, source: stUser, tenantId, userContext });
  }
  await assertMigrationPostconditions({
    internalUserId: primaryUserId, source: stUser, importMethods, tenantId,
    authenticatedEmail: getAuthenticatedMigrationEmail(stUser, tenantId), userContext, matchesMethod: matchesImportLoginMethod,
  });

  if (currentEmailReconciliation) {
    await currentEmailReconciliation.assertFreshSource();
    clearSuperTokensCoreCallCache(userContext);
    const linkedUser = await SuperTokens.getUser(primaryUserId, userContext);
    const canonicalMethod = linkedUser?.loginMethods.find((method) =>
      method.recipeId === "passwordless" && method.verified &&
      method.tenantIds.includes(tenantId) && method.hasSameEmailAs(currentEmailReconciliation.email));
    if (!linkedUser || !canonicalMethod ||
        !(await sdkUserIdMatchesInternalTarget(linkedUser.id, primaryUserId, userContext))) {
      throw new Error("Current Rownd email ownership postcondition failed");
    }
    const latestMetadata = {
      ...repairMetadata,
      ...await getRawUserMetadata(stUser.externalUserId, userContext),
      ...await getRawUserMetadata(primaryUserId, userContext),
    } as RowndMetadata;
    if (getCanonicalEmailRecipeUserId(latestMetadata, tenantId) ||
        getPendingVerifications(latestMetadata).some((verification) => verification.field === "email" &&
          (verification.tenantId ?? PUBLIC_TENANT_ID) === tenantId)) {
      throw new Error("Canonical email state changed during migration reconciliation");
    }
    const canonicalRecipeUserId = canonicalMethod.recipeUserId.getAsString();
    currentEmailReconciliation.assertCompatibleMethods(linkedUser);
    const retiredMethods = linkedUser.loginMethods.filter((method) =>
      method.recipeId === "passwordless" && method.email !== undefined &&
      method.tenantIds.includes(tenantId) && method.recipeUserId.getAsString() !== canonicalRecipeUserId &&
      !currentEmailReconciliation.placeholderIds.includes(method.recipeUserId.getAsString()));
    const plan: MigrationEmailPlan = {
      id: `migration-email-${canonicalRecipeUserId}`,
      field: "email", value: currentEmailReconciliation.email, tenantId,
      created_at: new Date().toISOString(), purpose: "UPDATE_PASSWORDLESS", status: "COMMITTING",
      targetCanonicalRecipeUserId: canonicalRecipeUserId,
      migrationSource: currentEmailReconciliation.migrationSource,
      retiredMethods: retiredMethods.map((method) => ({
        recipeUserId: method.recipeUserId.getAsString(), email: normalizeEmail(method.email!),
      })),
    };
    const retirementCheckpoints = await checkpointCurrentRowndEmailRetirement({
      internalUserId: primaryUserId, plan, tenantId, userContext,
    });
    const canonicalMetadata = buildVerifiedEmailMetadata(
      latestMetadata, linkedUser.id, currentEmailReconciliation.email, canonicalRecipeUserId, tenantId,
    );
    // Completion is published separately after retirement and publication checks.
    delete canonicalMetadata.rownd_migration_complete;
    // Publish only after Core proves ownership. A failed write leaves the snapshot
    // intact, so the next migration can resume even when linking already succeeded.
    await UserMetadata.updateUserMetadata(primaryUserId, {
      ...(isAdministrativeMigration(stUser, tenantId) ? {
        original_rownd_user: canonicalMetadata.original_rownd_user,
        rownd_email_recipe_user_id: canonicalMetadata.rownd_email_recipe_user_id,
        rownd_email_recipe_user_ids: canonicalMetadata.rownd_email_recipe_user_ids,
      } : canonicalMetadata),
      rownd_migration_email_retirements: retirementCheckpoints,
      rownd_pending_verification: [
        ...getPendingVerifications(latestMetadata),
        ...(retiredMethods.length > 0 ? [plan] : []),
      ],
    }, userContext);
    if (retiredMethods.length > 0) {
      await finishEmailReconciliation(primaryUserId, plan);
    }
    clearSuperTokensCoreCallCache(userContext);
    const publishedMetadata = await getRawUserMetadata(primaryUserId, userContext);
    if (getCanonicalEmailRecipeUserId(publishedMetadata, tenantId) !== canonicalRecipeUserId) {
      throw new Error("Current Rownd canonical email publication failed");
    }
  }

  if (!repairUser || repairMetadata?.rownd_migration_complete !== true || currentEmailReconciliation || completionInvalidated) {
    // Read after email reconciliation so its canonical state and retirement
    // checkpoints cannot be overwritten by the pre-migration metadata snapshot.
    await assertMigrationMapping(primaryUserId, stUser.externalUserId, userContext);
    if (telemetry) telemetry.stage = "migration_metadata";
    const currentMetadata = await getRawUserMetadata(primaryUserId, userContext);
    const administrativeProfile = isAdministrativeMigration(stUser, tenantId) ? await assertAuthenticatedMigrationSource(stUser, tenantId) : undefined;
    await UserMetadata.updateUserMetadata(primaryUserId, {
      ...(!repairUser ? administrativeProfile ? { original_rownd_user: administrativeProfile } : {
        ...mergeMissingValues(currentMetadata, stUser.userMetadata),
        original_rownd_user: stUser.userMetadata.original_rownd_user,
      } : {}),
      rownd_migration_complete: true,
    }, userContext);
    telemetry?.emit("transition", "migration_metadata_written");
  }

  await backfillAdministrativeMetadata({ source: stUser, tenantId, internalUserId: primaryUserId, userContext });

  return true;
}

export async function recordRowndAppVariantForUser(
  userId: string,
  appVariantId?: string,
  userContext?: JsonRecord,
  tenantId?: string,
) {
  if (!appVariantId) {
    return;
  }

  const pluginConfig = getConfigForUserContext(userContext);
  if (!pluginConfig) {
    throw new Error("Rownd plugin config is not initialized");
  }
  assertRowndAppVariantIsConfigured(pluginConfig, appVariantId);

  const operationContext = userContext ?? {};
  const inspection = await inspectLinkedUserMetadata(userId, operationContext);
  const metadataUserId =
    inspection.rowndMetadataSourceUserId ?? inspection.primaryUserId;
  clearSuperTokensCoreCallCache(operationContext);
  const metadata = await getRawUserMetadata(metadataUserId, operationContext);
  const originalRowndUser: JsonRecord = isJsonRecord(
    metadata.original_rownd_user,
  )
    ? metadata.original_rownd_user
    : {};
  const attributes: JsonRecord = isJsonRecord(originalRowndUser.attributes)
    ? originalRowndUser.attributes
    : {};
  // Keep the shipped account-wide array for public/tenantless callers; explicit tenants must never reinterpret it.
  const tenantKey =
    tenantId !== undefined && tenantId !== PUBLIC_TENANT_ID
      ? tenantId
      : undefined;
  const variantsByTenant = isRecord(attributes["rownd:app_variants_by_tenant"])
    ? attributes["rownd:app_variants_by_tenant"]
    : {};
  const hasTenantVariants =
    tenantKey !== undefined &&
    Object.prototype.hasOwnProperty.call(variantsByTenant, tenantKey);
  const appVariants = getStringList(
    tenantKey !== undefined
      ? hasTenantVariants || pluginConfig.resolveConfig
        ? variantsByTenant[tenantKey]
        : attributes["rownd:app_variants"]
      : attributes["rownd:app_variants"],
  );

  if (appVariants.includes(appVariantId)) {
    return;
  }

  await UserMetadata.updateUserMetadata(
    metadataUserId,
    {
      original_rownd_user: {
        ...originalRowndUser,
        data: isJsonRecord(originalRowndUser.data)
          ? originalRowndUser.data
          : { user_id: userId },
        verified_data: isJsonRecord(originalRowndUser.verified_data)
          ? originalRowndUser.verified_data
          : {},
        attributes: {
          ...attributes,
          ...(tenantKey !== undefined
            ? {
              "rownd:app_variants_by_tenant": {
                ...variantsByTenant,
                [tenantKey]: [...appVariants, appVariantId],
              },
            }
            : {
              "rownd:app_variants": [...appVariants, appVariantId],
            }),
        },
      },
    },
    operationContext,
  );
  migrationTelemetry(operationContext)?.emit(
    "transition",
    "app_variant_metadata_written",
  );
}

export const RowndIsAnonymousClaim = new BooleanClaim({
  key: "is_anonymous",
  fetchValue: async (
    userId,
    recipeUserId,
    _tenantId,
    payload,
    userContext,
  ) => {
    const user = await SuperTokens.getUser(userId, userContext);
    const origin = await sessionAuthenticationOrigin(user, recipeUserId.getAsString(), payload ?? {}, userContext);
    const effectiveAuthLevel = origin === "instant" ? "instant" : getEffectiveAuthLevel(user);
    return [GUEST_AUTH_METHOD_ID, INSTANT_AUTH_METHOD_ID].includes(
      effectiveAuthLevel,
    );
  },
});

export async function buildRowndSessionClaims(
  userId: string,
  currentPayload: JsonRecord = {},
  appVariantId?: string,
  userContext?: JsonRecord,
) {
  const inspection = await inspectLinkedUserMetadata(userId, userContext);
  const user = inspection.user;
  const metadata = user ? inspection.combinedMetadata : undefined;

  return buildRowndSessionClaimPayload({
    userId,
    user,
    metadata,
    currentPayload,
    appVariantId,
    pluginConfig: getConfigForUserContext(userContext),
  });
}

export async function buildRowndSessionAndAnonymousClaims(
  userId: string,
  currentPayload: JsonRecord,
  appVariantId: string | undefined,
  userContext: UserContext,
  recipeUserId?: string,
  creating = false,
) {
  const inspection = await inspectLinkedUserMetadata(userId, userContext);
  const user = inspection.user;
  const rowndSessionClaims = buildRowndSessionClaimPayload({
    userId,
    user,
    metadata: user ? inspection.combinedMetadata : undefined,
    currentPayload,
    appVariantId,
    pluginConfig: getConfigForUserContext(userContext),
    authenticationOrigin: await sessionAuthenticationOrigin(user, recipeUserId, currentPayload, userContext, creating),
  });
  const isAnonymous = [GUEST_AUTH_METHOD_ID, INSTANT_AUTH_METHOD_ID].includes(
    rowndSessionClaims.auth_level,
  );
  return {
    rowndSessionClaims,
    rowndIsAnonymousClaim: RowndIsAnonymousClaim.addToPayload_internal(
      {},
      isAnonymous,
      userContext,
    ),
  };
}

export async function createMagicLinkWithConfirmationBypass(
  input: CreateMagicLinkWithConfirmationBypassInput,
) {
  const hasEmail = typeof input.email === "string" && input.email.length > 0;
  const hasPhoneNumber =
    typeof input.phoneNumber === "string" && input.phoneNumber.length > 0;

  if (hasEmail === hasPhoneNumber) {
    throw new Error("Exactly one of email or phoneNumber is required");
  }

  const stConfig = getSuperTokensConfig();
  if (!stConfig) {
    throw new Error("SuperTokens config is not initialized");
  }

  const staticPluginConfig = getPluginConfig();
  if (!staticPluginConfig) {
    throw new Error("Rownd plugin config is not initialized");
  }

  const tenantId = input.tenantId ?? PUBLIC_TENANT_ID;
  const resolved = await resolvePluginConfigSnapshot(staticPluginConfig, {
    tenantId,
    request: input.request,
    userContext: input.userContext ?? {},
  });
  const pluginConfig = resolved.config;
  const appVariantId = input.appVariantId;
  assertRowndAppVariantIsConfigured(pluginConfig, appVariantId);

  const clientDomain = resolveAllowedClientDomain({
    clientDomain: input.clientDomain,
    pluginConfig,
    stConfig,
    request: input.request,
    userContext: resolved.userContext,
  });
  const redirectToPath = normalizeRedirectToPathForClientDomain(
    input.redirectToPath,
    clientDomain,
  );
  assertAllowedBypassRedirectPath(pluginConfig, redirectToPath);

  const operationContext = createDerivedUserContext(resolved.userContext, {
    rowndDisplayContext: input.displayContext,
    rowndRedirectToPath: redirectToPath,
    rowndClientDomain: input.clientDomain,
    rowndAppVariantId: appVariantId,
  });
  if (hasEmail) {
    const preparation = await prepareEmailForPasswordlessAuth({
      email: input.email!,
      tenantId,
      reconcileTarget: false,
      userContext: operationContext,
    });
    if (preparation.status !== "ALLOW") {
      throw new Error("No existing account found");
    }
  }
  const codeInfo = hasEmail
    ? await Passwordless.createCode({
      email: input.email!,
      tenantId,
      session: input.session,
      userContext: operationContext,
    })
    : await Passwordless.createCode({
      phoneNumber: input.phoneNumber!,
      tenantId,
      session: input.session,
      userContext: operationContext,
    });

  if (codeInfo.status !== "OK") {
    throw new Error("Failed to create magic link");
  }

  const magicLink = `${getWebsiteDomain({
    stConfig,
    request: input.request,
    userContext: operationContext,
  })}${getAppInfoString(stConfig.appInfo.websiteBasePath)}/verify?preAuthSessionId=${encodeURIComponent(
    codeInfo.preAuthSessionId,
  )}&tenantId=${encodeURIComponent(tenantId)}#${encodeURIComponent(codeInfo.linkCode)}`;
  const oauthLoginChallenge = (operationContext as Record<string, unknown>)
    .rowndOAuthLoginChallenge;
  const rewrittenUrl = new URL(
    rewriteMagicLink({
      magicLink,
      clientDomain,
      bootstrapParams: getMagicLinkBootstrapParams({
        appKey: pluginConfig.rowndAppKey,
        apiDomain: getAppInfoString(stConfig.appInfo.apiDomain),
        apiBasePath: getAppInfoString(stConfig.appInfo.apiBasePath),
        appVariantId,
        displayContext: input.displayContext,
        redirectToPath,
        clientDomainKey: input.clientDomain,
        oauthLoginChallenge:
          typeof oauthLoginChallenge === "string"
            ? oauthLoginChallenge
            : undefined,
      }),
    }),
  );

  rewrittenUrl.searchParams.set(
    PASSWORDLESS_BYPASS_DEVICE_CONFIRMATION_PARAM,
    "true",
  );

  return rewrittenUrl.toString();
}

export async function getUserMetadata(
  userId: string,
  userContext?: Record<string, any>,
): Promise<RowndMetadata> {
  return getCombinedUserMetadata(userId, userContext);
}

export function getPendingVerifications(
  metadata: RowndMetadata,
): RowndPendingVerification[] {
  const pendingVerification = metadata.rownd_pending_verification;

  if (Array.isArray(pendingVerification)) {
    return pendingVerification.filter(isPendingVerification);
  }

  return [];
}

function isPendingVerification(
  value: unknown,
): value is RowndPendingVerification {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.field === "string" &&
    typeof value.value === "string" &&
    typeof value.created_at === "string"
  );
}

export async function getUserById(
  userId: string,
  tenantId: string = PUBLIC_TENANT_ID,
  userContext?: JsonRecord,
): Promise<RowndCompatUserResponse> {
  const inspection = await inspectLinkedUserMetadata(userId, userContext);
  const metadata = inspection.combinedMetadata;
  const stUser = inspection.user;

  if (!stUser) {
    throw new RowndPluginError("ROWND_USER_NOT_FOUND");
  }

  const originalRowndUser = metadata.original_rownd_user;
  const rowndUser = originalRowndUser?.data?.user_id || userId;
  const state = originalRowndUser?.state || "enabled";
  const dataFieldKeys = new Set<string>();

  const data: JsonRecord = {
    user_id: userId,
  };

  for (const [key, value] of Object.entries(originalRowndUser?.data || {})) {
    if (!isIdentityField(key)) {
      data[key] = value;
      dataFieldKeys.add(key);
    }
  }

  const schema =
    getConfigForUserContext(userContext)?.schema || DEFAULT_ROWND_SCHEMA;
  for (const key of Object.keys(schema)) {
    dataFieldKeys.add(key);
    if (
      !isInternalMetadataField(key) &&
      !isIdentityField(key) &&
      metadata[key] !== undefined
    ) {
      data[key] = metadata[key];
    }
  }

  const originalVerifiedData = (originalRowndUser?.verified_data ||
    {}) as JsonRecord;
  const verifiedData: JsonRecord = Object.fromEntries(
    Object.entries(originalVerifiedData).filter(([key]) => key !== "email"),
  );

  const tenantLoginMethods = stUser.loginMethods
    .filter((method) => method.tenantIds.includes(tenantId))
    .sort(
      (a, b) =>
        a.timeJoined - b.timeJoined ||
        a.recipeUserId
          .getAsString()
          .localeCompare(b.recipeUserId.getAsString()),
    );
  const canonicalEmailRecipeUserId = getCanonicalEmailRecipeUserId(
    metadata,
    tenantId,
  );
  const canonicalEmailMethod = tenantLoginMethods.find(
    (method) =>
      method.recipeUserId.getAsString() === canonicalEmailRecipeUserId &&
      method.email &&
      !isSuperTokensFakeEmail(method.email),
  );
  if (canonicalEmailMethod?.email) {
    data.email = canonicalEmailMethod.email;
    if (canonicalEmailMethod.verified) {
      verifiedData.email = canonicalEmailMethod.email;
    }
  }

  for (const method of tenantLoginMethods) {
    if (method.recipeId === "passwordless") {
      if (method.email && !isSuperTokensFakeEmail(method.email)) {
        if (verifiedData.email === undefined && method.verified) {
          verifiedData.email = method.email;
        }
        if (data.email === undefined) data.email = method.email;
      }
      if (method.phoneNumber) {
        verifiedData.phone_number = method.phoneNumber;
        if (data.phone_number === undefined)
          data.phone_number = method.phoneNumber;
      }
    } else if (method.recipeId === "thirdparty") {
      const thirdPartyId = getThirdPartyId(method);
      const thirdPartyUserId = getThirdPartyUserId(method);
      if (
        method.verified &&
        method.email &&
        !isSuperTokensFakeEmail(method.email) &&
        verifiedData.email === undefined
      ) {
        verifiedData.email = method.email;
      }
      if (
        method.email &&
        !isSuperTokensFakeEmail(method.email) &&
        data.email === undefined
      ) {
        data.email = method.email;
      }
      if (thirdPartyId === "google" && thirdPartyUserId) {
        data.google_id = thirdPartyUserId;
        verifiedData.google_id = thirdPartyUserId;
      }
      if (thirdPartyId === "apple" && thirdPartyUserId) {
        data.apple_id = thirdPartyUserId;
        verifiedData.apple_id = thirdPartyUserId;
      }
    } else if (method.recipeId === "emailpassword") {
      if (
        method.email &&
        !isSuperTokensFakeEmail(method.email) &&
        data.email === undefined
      ) {
        data.email = method.email;
      }
    }
  }

  if (verifiedData.email === true && typeof data.email === "string") {
    verifiedData.email = data.email;
  }
  if (
    verifiedData.phone_number === true &&
    typeof data.phone_number === "string"
  ) {
    verifiedData.phone_number = data.phone_number;
  }

  const tenantUser = {
    ...stUser,
    loginMethods: tenantLoginMethods,
  };
  const anonymousId = getAnonymousId(stUser.id, tenantUser, metadata);
  if (anonymousId && data.anonymous_id === undefined) {
    data.anonymous_id = anonymousId;
  }

  const authLevel = getEffectiveAuthLevel(
    tenantUser,
    originalRowndUser?.auth_level,
    verifiedData,
  );

  for (const [key, field] of Object.entries(schema)) {
    if (data[key] === undefined && field.type === "string") {
      data[key] = "";
    }
  }

  const sortedByJoined = [...tenantLoginMethods].sort(
    (a, b) => a.timeJoined - b.timeJoined,
  );
  const latestSessionInfo = await getLatestSessionInfo(
    stUser.id,
    tenantId,
    userContext,
  );
  const firstMethod = sortedByJoined[0];
  const latestSessionRecipeUserId =
    latestSessionInfo?.recipeUserId.getAsString();
  const lastMethod = latestSessionRecipeUserId
    ? stUser.loginMethods.find(
      (method) =>
        method.recipeUserId.getAsString() === latestSessionRecipeUserId,
    )
    : [...tenantLoginMethods].sort((a, b) => b.timeJoined - a.timeJoined)[0];
  const lastSignInAt = latestSessionInfo?.timeCreated ?? stUser.timeJoined;

  const metadataMeta = Object.fromEntries(
    Object.entries(metadata).filter(
      ([key]) => !isInternalMetadataField(key) && !dataFieldKeys.has(key),
    ),
  );

  const meta = {
    ...metadataMeta,
    created: new Date(stUser.timeJoined).toISOString(),
    first_sign_in: new Date(stUser.timeJoined).toISOString(),
    last_sign_in: new Date(lastSignInAt).toISOString(),
    last_active: new Date(lastSignInAt).toISOString(),
    first_sign_in_method: firstMethod ? mapMethod(firstMethod) : "email",
    last_sign_in_method: lastMethod ? mapMethod(lastMethod) : "email",
  };
  const attributes = {
    ...((originalRowndUser?.attributes || {}) as JsonRecord),
  };
  const pluginConfig = getConfigForUserContext(userContext);
  const variantsByTenant = isRecord(attributes["rownd:app_variants_by_tenant"])
    ? attributes["rownd:app_variants_by_tenant"]
    : {};
  delete attributes["rownd:app_variants_by_tenant"];
  if (tenantId !== PUBLIC_TENANT_ID) {
    const configuredVariants = new Set(
      Object.keys(pluginConfig?.subBrands ?? {}),
    );
    const hasTenantVariants = Object.prototype.hasOwnProperty.call(
      variantsByTenant,
      tenantId,
    );
    if (hasTenantVariants || pluginConfig?.resolveConfig) {
      attributes["rownd:app_variants"] = getStringList(
        variantsByTenant[tenantId],
      ).filter((variantId) => configuredVariants.has(variantId));
    }
  } else if (pluginConfig?.resolveConfig) {
    const configuredVariants = new Set(
      Object.keys(pluginConfig.subBrands ?? {}),
    );
    attributes["rownd:app_variants"] = getStringList(
      attributes["rownd:app_variants"],
    ).filter((variantId) => configuredVariants.has(variantId));
  }

  return {
    rownd_user: rowndUser,
    data,
    meta,
    verified_data: verifiedData,
    state,
    auth_level: authLevel,
    redacted: [],
    groups: (originalRowndUser?.groups || []) as JSONObject[],
    attributes,
  };
}

async function getLatestSessionInfo(
  userId: string,
  tenantId: string,
  userContext?: JsonRecord,
) {
  const sessionHandles = await Session.getAllSessionHandlesForUser(
    userId,
    true,
    tenantId,
    userContext,
  );
  const sessionInfos = await Promise.all(
    sessionHandles.map((sessionHandle) =>
      Session.getSessionInformation(sessionHandle, userContext),
    ),
  );

  let latestSessionInfo: (typeof sessionInfos)[number];
  for (const sessionInfo of sessionInfos) {
    if (
      sessionInfo &&
      (!latestSessionInfo ||
        sessionInfo.timeCreated > latestSessionInfo.timeCreated)
    ) {
      latestSessionInfo = sessionInfo;
    }
  }

  return latestSessionInfo;
}

export async function updateUserData(
  userId: string,
  inputData: JsonRecord,
  tenantId: string = PUBLIC_TENANT_ID,
  userContext?: JsonRecord,
) {
  const { primaryUserId } = await updatePrimaryUserMetadata(
    userId,
    inputData,
    userContext,
  );
  return getUserById(primaryUserId, tenantId, userContext);
}

export function addPendingEmailVerificationMarker(input: {
  pendingVerificationId: string;
  emailVerifyLink: string;
}) {
  const verificationUrl = new URL(input.emailVerifyLink);
  if (!verificationUrl.searchParams.get("token")) {
    throw new Error("Pending email verification link has no Core token");
  }
  verificationUrl.searchParams.set(
    PENDING_EMAIL_VERIFICATION_QUERY_PARAM,
    input.pendingVerificationId,
  );
  return verificationUrl.toString();
}

export async function resolvePendingEmailVerificationToken(input: {
  token: string;
  queryPendingVerificationId?: string;
  tenantId: string;
  session?: SessionContainerInterface;
  userContext?: Record<string, any>;
}) {
  if (input.queryPendingVerificationId === undefined) {
    return { status: "NOT_PENDING" } as const;
  }
  if (!input.session) {
    return { status: "INVALID_PENDING" } as const;
  }

  const sessionHandle = input.session.getHandle(input.userContext);
  const sessionUserId = input.session.getUserId(input.userContext);
  const sessionTenantId = input.session.getTenantId(input.userContext);
  if (sessionTenantId !== input.tenantId) {
    return { status: "INVALID_PENDING" } as const;
  }

  const sessionInformation = await Session.getSessionInformation(
    sessionHandle,
    input.userContext,
  );
  if (
    !sessionInformation ||
    sessionInformation.sessionHandle !== sessionHandle ||
    sessionInformation.userId !== sessionUserId ||
    sessionInformation.tenantId !== sessionTenantId
  ) {
    return { status: "INVALID_PENDING" } as const;
  }

  const metadata = await getRawUserMetadata(sessionUserId, input.userContext);
  const pendingVerification = getPendingVerifications(metadata).find(
    (verification) =>
      verification.id === input.queryPendingVerificationId &&
      verification.field === "email" &&
      verification.status === "PENDING" &&
      verification.initiatingSessionHandle === sessionHandle &&
      (verification.tenantId ?? PUBLIC_TENANT_ID) === input.tenantId &&
      (verification.purpose === "UPDATE_PASSWORDLESS" ||
        verification.purpose === "ADD_PASSWORDLESS"),
  );
  if (!pendingVerification) {
    return { status: "INVALID_PENDING" } as const;
  }

  return {
    status: "OK" as const,
    coreToken: input.token,
    pendingVerificationId: input.queryPendingVerificationId,
    userId: sessionUserId,
  };
}

export async function startPendingEmailVerification(input: {
  userId: string;
  recipeUserId: Parameters<
    typeof EmailVerification.sendEmailVerificationEmail
  >[2];
  email: string;
  tenantId: string;
  pendingVerificationId: string;
  initiatingSessionHandle: string;
  userContext?: JsonRecord;
}) {
  const userContext = input.userContext ?? {};
  let user = await SuperTokens.getUser(input.userId, input.userContext);
  if (!user) {
    throw new RowndPluginError("ROWND_USER_NOT_FOUND");
  }
  let metadata = await getRawUserMetadata(user.id, input.userContext);

  const committingVerifications = getCommittingEmailPlansForTenant(
    metadata,
    input.tenantId,
  );
  if (committingVerifications.length > 0) {
    try {
      const committingVerification = committingVerifications[0];
      if (committingVerifications.length !== 1 || !committingVerification) {
        throw new Error("multiple committing email changes found");
      }
      await reconcileCommittingEmailVerification({
        userId: user.id,
        pendingVerification: committingVerification,
        userContext: input.userContext,
      });
    } catch (error) {
      logDebugMessage(
        `Email change reconciliation failed for user ${user.id}. Error: ${getErrorMessage(error)}`,
      );
      throw emailReconciliationRequired();
    }
    user = await SuperTokens.getUser(input.userId, input.userContext);
    if (!user) {
      throw new RowndPluginError("ROWND_USER_NOT_FOUND");
    }
    metadata = await getRawUserMetadata(user.id, input.userContext);
    const refreshedInitiatingLoginMethod = user.loginMethods.find(
      (method) =>
        method.recipeUserId.getAsString() ===
          input.recipeUserId.getAsString() &&
        method.tenantIds.includes(input.tenantId),
    );
    if (!refreshedInitiatingLoginMethod) {
      await Promise.allSettled([
        Session.revokeSession(input.initiatingSessionHandle, input.userContext),
      ]);
      throw new RowndEmailChangeError(
        "CONFLICT",
        409,
        "email change sign-in method was removed; sign in again",
      );
    }
  }

  const normalizedEmail = normalizeEmail(input.email);
  if (!normalizedEmail) {
    throw new RowndEmailChangeError(
      "INVALID_EMAIL",
      400,
      "email must be a non-empty string",
    );
  }

  const passwordlessMethod = findCanonicalPasswordlessMethod(
    user,
    metadata,
    input.tenantId,
  );
  const initiatingLoginMethod = user.loginMethods.find(
    (method) =>
      method.recipeUserId.getAsString() === input.recipeUserId.getAsString() &&
      method.tenantIds.includes(input.tenantId),
  );
  const canAddPasswordless =
    !passwordlessMethod &&
    initiatingLoginMethod !== undefined &&
    canRetainMethodWhenAddingEmail(initiatingLoginMethod) &&
    user.loginMethods
      .filter((method) => method.tenantIds.includes(input.tenantId))
      .every(canRetainMethodWhenAddingEmail);
  if (!passwordlessMethod && !canAddPasswordless) {
    throw new RowndEmailChangeError(
      "CONFLICT",
      409,
      "the account has no passwordless sign-in method",
    );
  }

  const currentEmail = (
    await getUserById(input.userId, input.tenantId, input.userContext)
  ).data.email;
  const pendingVerifications = getPendingVerifications(metadata);
  const pendingEmailVerifications = pendingVerifications.filter(
    (pendingVerification) =>
      pendingVerification.field === "email" &&
      (pendingVerification.tenantId ?? PUBLIC_TENANT_ID) === input.tenantId,
  );
  if (
    typeof currentEmail === "string" &&
    normalizeEmail(currentEmail) === normalizedEmail
  ) {
    for (const pendingVerification of pendingEmailVerifications) {
      await revokePendingEmailVerificationTokens(
        user,
        pendingVerification,
        input.recipeUserId,
        input.userContext,
      );
    }

    const currentPasswordlessMethod = user.loginMethods.find(
      (method) =>
        method.recipeId === "passwordless" &&
        method.tenantIds.includes(input.tenantId) &&
        method.verified &&
        method.email &&
        normalizeEmail(method.email) === normalizedEmail,
    );
    const updatedMetadata = currentPasswordlessMethod
      ? buildVerifiedEmailMetadata(
        metadata,
        input.userId,
        normalizedEmail,
        currentPasswordlessMethod.recipeUserId.getAsString(),
        input.tenantId,
      )
      : {
        ...metadata,
        rownd_pending_verification: pendingVerifications.filter(
          (pendingVerification) =>
            pendingVerification.field !== "email" ||
              (pendingVerification.tenantId ?? PUBLIC_TENANT_ID) !==
                input.tenantId,
        ),
      };
    if (pendingEmailVerifications.length > 0 || currentPasswordlessMethod) {
      await updatePrimaryUserMetadata(
        input.userId,
        updatedMetadata,
        input.userContext,
      );
    }

    return getUserById(input.userId, input.tenantId, input.userContext);
  }

  await assertEmailAvailableForUser(
    normalizedEmail,
    user.id,
    input.userContext,
  );

  const purpose = passwordlessMethod
    ? "UPDATE_PASSWORDLESS"
    : "ADD_PASSWORDLESS";
  const verificationRecipeUserId =
    passwordlessMethod?.recipeUserId ?? input.recipeUserId;
  for (const pendingVerification of pendingEmailVerifications) {
    await revokePendingEmailVerificationTokens(
      user,
      pendingVerification,
      input.recipeUserId,
      input.userContext,
    );
  }

  const pendingVerification: RowndPendingVerification = {
    id: input.pendingVerificationId,
    field: "email",
    value: input.email,
    created_at: new Date().toISOString(),
    tenantId: input.tenantId,
    purpose,
    initiatingSessionHandle: input.initiatingSessionHandle,
    verificationRecipeUserId: verificationRecipeUserId.getAsString(),
    status: "PENDING",
  };

  await updatePrimaryUserMetadata(
    input.userId,
    {
      ...metadata,
      rownd_pending_verification: [
        ...pendingVerifications.filter(
          (pendingVerification) =>
            pendingVerification.field !== "email" ||
            (pendingVerification.tenantId ?? PUBLIC_TENANT_ID) !==
              input.tenantId,
        ),
        pendingVerification,
      ],
    },
    input.userContext,
  );

  try {
    await EmailVerification.revokeEmailVerificationTokens(
      input.tenantId,
      verificationRecipeUserId,
      normalizedEmail,
      input.userContext,
    );
    await EmailVerification.unverifyEmail(
      verificationRecipeUserId,
      normalizedEmail,
      input.userContext,
    );
    const operationContext = createDerivedUserContext(userContext, {
      [PENDING_EMAIL_VERIFICATION_USER_CONTEXT_KEY]:
        input.pendingVerificationId,
    });
    const response = await EmailVerification.sendEmailVerificationEmail(
      input.tenantId,
      input.userId,
      verificationRecipeUserId,
      normalizedEmail,
      operationContext,
    );

    if (response.status !== "OK") {
      throw new Error("A fresh email verification could not be created");
    }
  } catch (error) {
    await EmailVerification.revokeEmailVerificationTokens(
      input.tenantId,
      verificationRecipeUserId,
      normalizedEmail,
      input.userContext,
    );
    await removePendingEmailVerification(
      input.userId,
      input.pendingVerificationId,
      input.tenantId,
      input.userContext,
    );
    throw error;
  }

  return getUserById(input.userId, input.tenantId, input.userContext);
}

export async function completePendingEmailVerification(input: {
  recipeUserId: Parameters<typeof AccountLinking.createPrimaryUser>[0];
  email: string;
  tenantId?: string;
  sessionHandle?: string;
  pendingVerificationId?: string;
  pendingUserId?: string;
  userContext?: JsonRecord;
}): Promise<
  | {
      userId: string;
      recipeUserId: Parameters<typeof AccountLinking.createPrimaryUser>[0];
      initiatingSessionHandle: string;
      replaceSession: true;
    }
  | undefined
> {
  const tenantId = input.tenantId ?? PUBLIC_TENANT_ID;
  const userContext = input.userContext ?? {};
  let user = await SuperTokens.getUser(
    input.recipeUserId.getAsString(),
    input.userContext,
  );
  const userId = user?.id ?? input.recipeUserId.getAsString();
  if (input.pendingUserId && userId !== input.pendingUserId) {
    if (input.pendingVerificationId) {
      await removePendingEmailVerification(
        input.pendingUserId,
        input.pendingVerificationId,
        tenantId,
        input.userContext,
      );
    }
    throw new RowndEmailChangeError(
      "CONFLICT",
      409,
      "email change session is no longer active; start the email change again",
    );
  }
  const metadata = await getRawUserMetadata(userId, input.userContext);
  const pendingVerifications = getPendingVerifications(metadata);
  const normalizedEmail = normalizeEmail(input.email);
  const pendingVerification = pendingVerifications.find(
    (pendingVerification) =>
      (!input.pendingVerificationId ||
        pendingVerification.id === input.pendingVerificationId) &&
      isMatchingPendingEmailVerification(
        pendingVerification,
        normalizedEmail,
        tenantId,
      ) &&
      (!pendingVerification.verificationRecipeUserId ||
        pendingVerification.verificationRecipeUserId ===
          input.recipeUserId.getAsString()),
  );

  if (!pendingVerification) {
    if (input.pendingVerificationId) {
      try {
        await EmailVerification.unverifyEmail(
          input.recipeUserId,
          normalizedEmail,
          input.userContext,
        );
      } finally {
        await removePendingEmailVerification(
          userId,
          input.pendingVerificationId,
          tenantId,
          input.userContext,
        );
      }
      throw new RowndEmailChangeError(
        "CONFLICT",
        409,
        "email change session is no longer active; start the email change again",
      );
    }
    return;
  }

  if (
    pendingVerification.purpose !== "UPDATE_PASSWORDLESS" &&
    pendingVerification.purpose !== "ADD_PASSWORDLESS"
  ) {
    return rejectInactivePendingEmailVerification(
      userId,
      pendingVerification,
      input.recipeUserId,
      normalizedEmail,
      input.userContext,
    );
  }

  const initiatingSessionHandle = pendingVerification.initiatingSessionHandle;
  if (
    (pendingVerification.status ?? "PENDING") !== "PENDING" ||
    !initiatingSessionHandle ||
    initiatingSessionHandle !== input.sessionHandle
  ) {
    return rejectInactivePendingEmailVerification(
      userId,
      pendingVerification,
      input.recipeUserId,
      normalizedEmail,
      input.userContext,
    );
  }

  let rollbackCredentialChange: (() => Promise<void>) | undefined;
  let destructiveCleanupStarted = false;
  try {
    await assertEmailAvailableForUser(
      normalizedEmail,
      userId,
      input.userContext,
    );

    const initiatingSession = await Session.getSessionInformation(
      initiatingSessionHandle,
      input.userContext,
    );
    if (
      !initiatingSession ||
      initiatingSession.userId !== userId ||
      initiatingSession.tenantId !== tenantId
    ) {
      return rejectInactivePendingEmailVerification(
        userId,
        pendingVerification,
        input.recipeUserId,
        normalizedEmail,
        input.userContext,
      );
    }
    const currentUser = await SuperTokens.getUser(userId, input.userContext);
    const initiatingLoginMethod = currentUser?.loginMethods.find(
      (method) =>
        method.recipeUserId.getAsString() ===
          initiatingSession.recipeUserId.getAsString() &&
        method.tenantIds.includes(tenantId),
    );
    if (!currentUser || !initiatingLoginMethod) {
      return rejectInactivePendingEmailVerification(
        userId,
        pendingVerification,
        input.recipeUserId,
        normalizedEmail,
        input.userContext,
      );
    }
    const passwordlessMethod = findPendingPasswordlessMethod(
      currentUser,
      pendingVerification,
      tenantId,
    );
    const canAddPasswordless =
      pendingVerification.purpose === "ADD_PASSWORDLESS" &&
      currentUser.loginMethods
        .filter((method) => method.tenantIds.includes(tenantId))
        .every(canRetainMethodWhenAddingEmail) &&
      canRetainMethodWhenAddingEmail(initiatingLoginMethod) &&
      pendingVerification.verificationRecipeUserId ===
        initiatingLoginMethod.recipeUserId.getAsString();
    if (
      (pendingVerification.purpose === "UPDATE_PASSWORDLESS" &&
        !passwordlessMethod) ||
      (pendingVerification.purpose === "ADD_PASSWORDLESS" &&
        !canAddPasswordless)
    ) {
      return rejectInactivePendingEmailVerification(
        userId,
        pendingVerification,
        input.recipeUserId,
        normalizedEmail,
        input.userContext,
      );
    }

    if (
      !(await Session.revokeSession(initiatingSessionHandle, input.userContext))
    ) {
      return rejectInactivePendingEmailVerification(
        userId,
        pendingVerification,
        input.recipeUserId,
        normalizedEmail,
        input.userContext,
      );
    }
    user = currentUser;
    const initiatingRecipeUserId = initiatingLoginMethod.recipeUserId;
    await Session.revokeAllSessionsForUser(
      userId,
      true,
      undefined,
      input.userContext,
    );
    const committingMetadata = await getRawUserMetadata(
      userId,
      input.userContext,
    );
    const committingVerification = getPendingVerifications(
      committingMetadata,
    ).find(
      (verification) =>
        verification.id === pendingVerification.id &&
        (verification.tenantId ?? PUBLIC_TENANT_ID) === tenantId,
    );
    if (
      committingVerification?.id !== pendingVerification.id ||
      (committingVerification.status ?? "PENDING") !== "PENDING"
    ) {
      return rejectInactivePendingEmailVerification(
        userId,
        pendingVerification,
        input.recipeUserId,
        normalizedEmail,
        input.userContext,
      );
    }

    const operationContext = createDerivedUserContext(userContext, {
      rowndDisableAutomaticAccountLinking: true,
    });
    const passwordlessUser = await Passwordless.signInUp({
      email: normalizedEmail,
      tenantId,
      userContext: operationContext,
    });
    if (passwordlessUser.status !== "OK") {
      throw emailOwnershipConflict();
    }
    await assertVerifiedPasswordlessTarget({
      recipeUserId: passwordlessUser.recipeUserId.getAsString(),
      email: normalizedEmail,
      tenantId,
      userContext: input.userContext,
    });
    const targetMethodBeforeSignInUp = currentUser.loginMethods.find(
      (method) =>
        method.recipeUserId.getAsString() ===
        passwordlessUser.recipeUserId.getAsString(),
    );
    const reusesLinkedMethod =
      !passwordlessUser.createdNewRecipeUser &&
      passwordlessUser.user.id === userId &&
      passwordlessUser.user.loginMethods.some(
        (method) =>
          method.recipeUserId.getAsString() ===
            passwordlessUser.recipeUserId.getAsString() &&
          method.tenantIds.includes(tenantId),
      );
    if (!passwordlessUser.createdNewRecipeUser && !reusesLinkedMethod) {
      throw emailOwnershipConflict();
    }
    if (passwordlessUser.createdNewRecipeUser) {
      rollbackCredentialChange = async () => {
        await SuperTokens.deleteUser(
          passwordlessUser.recipeUserId.getAsString(),
          false,
          input.userContext,
        );
      };
      await assertEmailAvailableForUser(
        normalizedEmail,
        [userId, passwordlessUser.user.id],
        input.userContext,
      );
      const primaryUserId = await ensureStablePrimaryUser(
        currentUser,
        initiatingRecipeUserId,
        input.userContext,
      );
      if (primaryUserId !== userId) {
        throw new RowndEmailChangeError(
          "CONFLICT",
          409,
          "the account changed before email verification completed",
        );
      }
      const linkResult = await AccountLinking.linkAccounts(
        passwordlessUser.recipeUserId,
        primaryUserId,
        input.userContext,
      );
      if (linkResult.status !== "OK") {
        throw emailOwnershipConflict();
      }
    } else if (
      targetMethodBeforeSignInUp &&
      !targetMethodBeforeSignInUp.tenantIds.includes(tenantId)
    ) {
      rollbackCredentialChange = async () => {
        const result = await MultiTenancy.disassociateUserFromTenant(
          tenantId,
          passwordlessUser.recipeUserId,
          input.userContext,
        );
        if (result.status !== "OK") {
          throw new Error(
            `Failed to roll back target email tenant association: ${result.status}`,
          );
        }
      };
    }
    await assertEmailAvailableForUser(
      normalizedEmail,
      userId,
      input.userContext,
    );
    const canonicalEmailRecipeUserId =
      passwordlessUser.recipeUserId.getAsString();
    const linkedUser = await SuperTokens.getUser(userId, input.userContext);
    await assertVerifiedPasswordlessTarget({
      recipeUserId: canonicalEmailRecipeUserId,
      email: normalizedEmail,
      tenantId,
      expectedUserId: userId,
      userContext: input.userContext,
    });
    if (!linkedUser) {
      throw new Error("verified email target owner is missing");
    }
    const replacedEmailMethods = linkedUser.loginMethods.filter(
      (method) =>
        method.recipeId === "passwordless" &&
        method.email !== undefined &&
        method.tenantIds.includes(tenantId) &&
        method.recipeUserId.getAsString() !== canonicalEmailRecipeUserId,
    );

    const committingPlan: RowndPendingVerification = {
      ...pendingVerification,
      status: "COMMITTING",
      targetCanonicalRecipeUserId: canonicalEmailRecipeUserId,
      retiredMethods: [
        ...new Map(
          replacedEmailMethods.map((method) => [
            method.recipeUserId.getAsString(),
            {
              recipeUserId: method.recipeUserId.getAsString(),
              email: normalizeEmail(method.email!),
            },
          ]),
        ).values(),
      ],
    };
    await publishEmailReplacementPlan(
      userId,
      committingPlan,
      input.userContext,
    );
    destructiveCleanupStarted = true;
    await reconcileCommittingEmailVerification({
      userId,
      pendingVerification: committingPlan,
      userContext: input.userContext,
    });
    return {
      userId,
      recipeUserId: passwordlessUser.recipeUserId,
      initiatingSessionHandle,
      replaceSession: true,
    };
  } catch (error) {
    if (destructiveCleanupStarted) {
      await Promise.allSettled([
        Session.revokeAllSessionsForUser(
          userId,
          true,
          undefined,
          input.userContext,
        ),
      ]);
      logDebugMessage(
        `Email change cleanup incomplete for user ${userId}; reconciliation required. Error: ${getErrorMessage(error)}`,
      );
      throw new RowndEmailChangeError(
        "CONFLICT",
        409,
        "email change cleanup incomplete; account reconciliation is required",
      );
    }
    let rollbackError: unknown;
    if (rollbackCredentialChange) {
      try {
        await rollbackCredentialChange();
      } catch (caughtRollbackError) {
        rollbackError = caughtRollbackError;
      }
    }
    if (rollbackError !== undefined) {
      logDebugMessage(
        `Email change rollback failed for user ${userId}; reconciliation required. Error: ${getErrorMessage(rollbackError)}`,
      );
      throw new RowndEmailChangeError(
        "CONFLICT",
        409,
        "email change rollback failed; account reconciliation is required",
      );
    }
    await Promise.allSettled([
      cleanupPendingEmailVerification(
        userId,
        pendingVerification,
        input.recipeUserId,
        normalizedEmail,
        input.userContext,
      ),
    ]);
    throw error;
  }
}

function isMatchingPendingEmailVerification(
  verification: RowndPendingVerification,
  email: string,
  tenantId: string,
) {
  return (
    verification.field === "email" &&
    normalizeEmail(verification.value) === email &&
    (verification.tenantId ?? PUBLIC_TENANT_ID) === tenantId
  );
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function isRealThirdPartyMethod(method: SuperTokensLoginMethod) {
  return (
    method.recipeId === "thirdparty" &&
    method.thirdParty?.id !== GUEST_AUTH_METHOD_ID &&
    method.thirdParty?.id !== INSTANT_AUTH_METHOD_ID
  );
}

function canRetainMethodWhenAddingEmail(method: SuperTokensLoginMethod) {
  return (
    isRealThirdPartyMethod(method) ||
    (method.recipeId === "passwordless" &&
      method.phoneNumber !== undefined &&
      method.email === undefined)
  );
}

async function removePasswordlessMethodFromTenant(
  recipeUserId: string,
  tenantId: string,
  expectedPrimaryUserId: string,
  deleteOrphanedMethod: boolean,
  userContext?: Record<string, any>,
) {
  const user = await SuperTokens.getUser(recipeUserId, userContext);
  if (!user) return;
  const method = user.loginMethods.find(
    (candidate) => candidate.recipeUserId.getAsString() === recipeUserId,
  );
  if (!method) return;
  if (!method.tenantIds.includes(tenantId)) {
    if (method.tenantIds.length > 0 || !deleteOrphanedMethod) return;
    if (
      user.id !== expectedPrimaryUserId ||
      method.recipeId !== "passwordless" ||
      !method.email
    ) {
      throw new Error("Replaced email method no longer belongs to the account");
    }
    await SuperTokens.deleteUser(recipeUserId, false, userContext);
    return;
  }
  if (
    user.id !== expectedPrimaryUserId ||
    method.recipeId !== "passwordless" ||
    !method.email
  ) {
    throw new Error("Replaced email method no longer belongs to the account");
  }

  const result = await MultiTenancy.disassociateUserFromTenant(
    tenantId,
    method.recipeUserId,
    userContext,
  );
  if (result.status !== "OK") {
    throw new Error(
      `Failed to remove replaced email method from tenant: ${result.status}`,
    );
  }

  const refreshedOwner = await SuperTokens.getUser(recipeUserId, userContext);
  if (!refreshedOwner) return;
  const refreshedMethod = refreshedOwner.loginMethods.find(
    (candidate) => candidate.recipeUserId.getAsString() === recipeUserId,
  );
  if (!refreshedMethod) return;
  if (
    refreshedOwner.id !== expectedPrimaryUserId ||
    refreshedMethod.recipeId !== "passwordless" ||
    !refreshedMethod.email ||
    refreshedMethod.tenantIds.includes(tenantId)
  ) {
    throw new Error("Replaced email method changed during tenant removal");
  }
  if (refreshedMethod.tenantIds.length > 0 || !deleteOrphanedMethod) return;

  await SuperTokens.deleteUser(recipeUserId, false, userContext);
}

async function ensureStablePrimaryUser(
  user: SuperTokensUser,
  anchor: SuperTokensLoginMethod["recipeUserId"],
  userContext?: Record<string, any>,
) {
  if (user.isPrimaryUser) {
    return user.id;
  }

  const primaryResult = await AccountLinking.createPrimaryUser(
    anchor,
    userContext,
  );
  if (primaryResult.status === "OK") {
    return primaryResult.user.id;
  }
  if (
    primaryResult.status ===
    "RECIPE_USER_ID_ALREADY_LINKED_WITH_PRIMARY_USER_ID_ERROR"
  ) {
    return primaryResult.primaryUserId;
  }
  throw emailOwnershipConflict();
}

function getVerificationRecipeUserIds(
  user: SuperTokensUser,
  verification: RowndPendingVerification,
  fallback: SuperTokensLoginMethod["recipeUserId"],
) {
  const exactRecipeUserId = user.loginMethods.find(
    (method) =>
      method.recipeUserId.getAsString() ===
      verification.verificationRecipeUserId,
  )?.recipeUserId;
  if (exactRecipeUserId) {
    return [exactRecipeUserId];
  }

  return [
    ...new Map(
      [...user.loginMethods.map((method) => method.recipeUserId), fallback].map(
        (recipeUserId) => [recipeUserId.getAsString(), recipeUserId],
      ),
    ).values(),
  ];
}

async function revokePendingEmailVerificationTokens(
  user: SuperTokensUser,
  verification: RowndPendingVerification,
  fallback: SuperTokensLoginMethod["recipeUserId"],
  userContext?: Record<string, any>,
) {
  await Promise.all(
    getVerificationRecipeUserIds(user, verification, fallback).map(
      (recipeUserId) =>
        EmailVerification.revokeEmailVerificationTokens(
          verification.tenantId ?? PUBLIC_TENANT_ID,
          recipeUserId,
          verification.value,
          userContext,
        ),
    ),
  );
}

async function assertEmailAvailableForUser(
  email: string,
  allowedUserIds: string | string[],
  userContext?: Record<string, any>,
) {
  const allowedIds = new Set(
    Array.isArray(allowedUserIds) ? allowedUserIds : [allowedUserIds],
  );
  const tenants = await MultiTenancy.listAllTenants(userContext);
  const tenantIds = [
    ...new Set([
      PUBLIC_TENANT_ID,
      ...tenants.tenants.map((tenant) => tenant.tenantId),
    ]),
  ];
  const users = await Promise.all(
    tenantIds.map((tenantId) =>
      SuperTokens.listUsersByAccountInfo(
        tenantId,
        { email },
        false,
        userContext,
      ),
    ),
  );

  if (users.flat().some((owner) => !allowedIds.has(owner.id))) {
    throw emailOwnershipConflict();
  }
}

async function assertVerifiedPasswordlessTarget(input: {
  recipeUserId: string;
  email: string;
  tenantId: string;
  expectedUserId?: string;
  userContext?: Record<string, any>;
}) {
  const owner = await SuperTokens.getUser(input.recipeUserId, input.userContext);
  const method = owner?.loginMethods.find(
    (candidate) =>
      candidate.recipeUserId.getAsString() === input.recipeUserId,
  );
  if (
    !owner ||
    (input.expectedUserId !== undefined && owner.id !== input.expectedUserId) ||
    !method ||
    method.recipeId !== "passwordless" ||
    !method.verified ||
    !method.tenantIds.includes(input.tenantId) ||
    normalizeEmail(method.email ?? "") !== normalizeEmail(input.email)
  ) {
    throw new Error("verified email target is invalid");
  }
}

function emailOwnershipConflict() {
  return new RowndEmailChangeError(
    "CONFLICT",
    409,
    "email cannot be used for this account",
  );
}

function findPendingPasswordlessMethod(
  user: SuperTokensUser | undefined,
  pendingVerification: RowndPendingVerification,
  tenantId: string,
) {
  if (!user) return undefined;

  if (
    pendingVerification.purpose !== "UPDATE_PASSWORDLESS" ||
    !pendingVerification.verificationRecipeUserId
  )
    return undefined;
  const passwordlessMethod = user.loginMethods.find(
    (method) =>
      method.recipeId === "passwordless" &&
      method.recipeUserId.getAsString() ===
        pendingVerification.verificationRecipeUserId,
  );
  return passwordlessMethod?.tenantIds.includes(tenantId) &&
    passwordlessMethod.recipeUserId.getAsString() ===
      pendingVerification.verificationRecipeUserId
    ? passwordlessMethod
    : undefined;
}

function findCanonicalPasswordlessMethod(
  user: SuperTokensUser,
  metadata: RowndMetadata,
  tenantId: string,
) {
  const passwordlessMethods = user.loginMethods.filter(
    (method) =>
      method.recipeId === "passwordless" &&
      method.email !== undefined &&
      method.tenantIds.includes(tenantId),
  );
  const canonicalEmailRecipeUserId = getCanonicalEmailRecipeUserId(
    metadata,
    tenantId,
  );
  if (canonicalEmailRecipeUserId) {
    const canonicalMethod = passwordlessMethods.find(
      (method) =>
        method.recipeUserId.getAsString() === canonicalEmailRecipeUserId,
    );
    if (!canonicalMethod) {
      throw new RowndEmailChangeError(
        "CONFLICT",
        409,
        "the canonical email sign-in method is invalid",
      );
    }
    return canonicalMethod;
  }
  if (passwordlessMethods.length > 1) {
    throw new RowndEmailChangeError(
      "AMBIGUOUS",
      409,
      "the account has multiple email sign-in methods without a canonical method",
    );
  }
  return passwordlessMethods[0];
}

export function getCanonicalEmailRecipeUserId(
  metadata: RowndMetadata,
  tenantId: string,
) {
  return (
    metadata.rownd_email_recipe_user_ids?.[tenantId] ??
    (metadata.rownd_email_recipe_user_ids === undefined
      ? metadata.rownd_email_recipe_user_id
      : undefined)
  );
}

async function removePendingEmailVerification(
  userId: string,
  pendingVerificationId: string,
  tenantId: string,
  userContext?: Record<string, any>,
) {
  const metadata = await getRawUserMetadata(userId, userContext);
  await updatePrimaryUserMetadata(
    userId,
    {
      rownd_pending_verification: getPendingVerifications(metadata).filter(
        (verification) =>
          verification.id !== pendingVerificationId ||
          (verification.tenantId ?? PUBLIC_TENANT_ID) !== tenantId,
      ),
    },
    userContext,
  );
}

async function publishEmailReplacementPlan(
  userId: string,
  plan: RowndPendingVerification,
  userContext?: Record<string, any>,
) {
  const metadata = await getRawUserMetadata(userId, userContext);
  let found = false;
  const pendingVerifications = getPendingVerifications(metadata).map(
    (verification) => {
      if (
        verification.id !== plan.id ||
        (verification.tenantId ?? PUBLIC_TENANT_ID) !==
          (plan.tenantId ?? PUBLIC_TENANT_ID)
      ) {
        return verification;
      }
      found = true;
      return plan;
    },
  );
  if (!found || !plan.targetCanonicalRecipeUserId) {
    throw new Error("pending email reconciliation state is missing");
  }

  await updatePrimaryUserMetadata(
    userId,
    {
      ...buildVerifiedEmailMetadata(
        metadata,
        userId,
        normalizeEmail(plan.value),
        plan.targetCanonicalRecipeUserId,
        plan.tenantId ?? PUBLIC_TENANT_ID,
      ),
      rownd_pending_verification: pendingVerifications,
    },
    userContext,
  );
}

async function updateEmailReplacementPlan(
  userId: string,
  plan: RowndPendingVerification,
  userContext?: Record<string, any>,
) {
  const metadata = await getRawUserMetadata(userId, userContext);
  let found = false;
  const pendingVerifications = getPendingVerifications(metadata).map(
    (verification) => {
      if (
        verification.id !== plan.id ||
        (verification.tenantId ?? PUBLIC_TENANT_ID) !==
          (plan.tenantId ?? PUBLIC_TENANT_ID)
      ) {
        return verification;
      }
      found = true;
      return plan;
    },
  );
  if (!found) {
    throw new Error("pending email reconciliation state is missing");
  }
  await updatePrimaryUserMetadata(
    userId,
    { rownd_pending_verification: pendingVerifications },
    userContext,
  );
}

function getCommittingEmailPlansForTenant(
  metadata: RowndMetadata,
  tenantId: string,
) {
  const pendingVerifications = metadata.rownd_pending_verification;
  if (pendingVerifications === undefined) return [];
  if (!Array.isArray(pendingVerifications)) {
    throw new Error("pending email reconciliation state is invalid");
  }

  const tenantVerifications = pendingVerifications.filter(
    (verification) =>
      isRecord(verification) &&
      (verification.tenantId ?? PUBLIC_TENANT_ID) === tenantId,
  );
  const committingPlans = tenantVerifications.flatMap((verification) => {
    const isCommittingLike =
      isRecord(verification) &&
      (verification.status === "COMMITTING" ||
        "targetCanonicalRecipeUserId" in verification ||
        "retiredMethods" in verification);
    if (!isCommittingLike) return [];
    if (
      !isPendingVerification(verification) ||
      verification.field !== "email" ||
      verification.status !== "COMMITTING" ||
      (verification.tenantId !== undefined &&
        (typeof verification.tenantId !== "string" ||
          !verification.tenantId)) ||
      (verification.purpose !== "UPDATE_PASSWORDLESS" &&
        verification.purpose !== "ADD_PASSWORDLESS") ||
      !normalizeEmail(verification.value) ||
      typeof verification.targetCanonicalRecipeUserId !== "string" ||
      !verification.targetCanonicalRecipeUserId ||
      !Array.isArray(verification.retiredMethods) ||
      verification.retiredMethods.some(
        (method) =>
          !isRecord(method) ||
          typeof method.recipeUserId !== "string" ||
          !method.recipeUserId ||
          typeof method.email !== "string" ||
          !normalizeEmail(method.email) ||
          method.recipeUserId === verification.targetCanonicalRecipeUserId,
      ) ||
      new Set(verification.retiredMethods.map((method) => method.recipeUserId))
        .size !== verification.retiredMethods.length
    ) {
      throw new Error("pending email reconciliation state is invalid");
    }
    return [verification];
  });

  return committingPlans;
}

async function validateCommittingEmailVerificationPlan(input: {
  userId: string;
  pendingVerificationId: string;
  tenantId: string;
  expectedTargetRecipeUserId: string;
  expectedEmail: string;
  userContext?: Record<string, any>;
}) {
  const metadata = await getRawUserMetadata(input.userId, input.userContext);
  const committingEmailPlans = getCommittingEmailPlansForTenant(
    metadata,
    input.tenantId,
  );
  const pendingVerification = committingEmailPlans.find(
    (verification) => verification.id === input.pendingVerificationId,
  );
  const tenantId = pendingVerification?.tenantId ?? PUBLIC_TENANT_ID;
  const targetRecipeUserId = pendingVerification?.targetCanonicalRecipeUserId;
  const retiredMethods = pendingVerification?.retiredMethods;
  const normalizedEmail = pendingVerification
    ? normalizeEmail(pendingVerification.value)
    : "";
  if (
    !pendingVerification ||
    tenantId !== input.tenantId ||
    committingEmailPlans.length !== 1 ||
    pendingVerification.field !== "email" ||
    pendingVerification.status !== "COMMITTING" ||
    !normalizedEmail ||
    !targetRecipeUserId ||
    targetRecipeUserId !== input.expectedTargetRecipeUserId ||
    normalizedEmail !== normalizeEmail(input.expectedEmail) ||
    !Array.isArray(retiredMethods)
  ) {
    throw new Error("pending email reconciliation state is invalid");
  }

  const user = await SuperTokens.getUser(input.userId, input.userContext);
  const targetOwner = await SuperTokens.getUser(
    targetRecipeUserId,
    input.userContext,
  );
  const targetMethod = user?.loginMethods.find(
    (method) => method.recipeUserId.getAsString() === targetRecipeUserId,
  );
  if (
    !user ||
    user.id !== input.userId ||
    !targetOwner ||
    targetOwner.id !== input.userId ||
    !targetMethod ||
    targetMethod.recipeId !== "passwordless" ||
    !targetMethod.verified ||
    !targetMethod.tenantIds.includes(tenantId) ||
    !targetMethod.email ||
    normalizeEmail(targetMethod.email) !== normalizedEmail
  ) {
    throw new Error("pending email reconciliation target is invalid");
  }

  for (const retiredMethod of retiredMethods) {
    const owner = await SuperTokens.getUser(
      retiredMethod.recipeUserId,
      input.userContext,
    );
    if (!owner) continue;
    const method = owner.loginMethods.find(
      (candidate) =>
        candidate.recipeUserId.getAsString() === retiredMethod.recipeUserId,
    );
    if (!method || !method.tenantIds.includes(tenantId)) continue;
    if (
      owner.id !== input.userId ||
      method.recipeId !== "passwordless" ||
      !method.email ||
      normalizeEmail(method.email) !== normalizeEmail(retiredMethod.email)
    ) {
      throw new Error("pending email reconciliation cleanup method is invalid");
    }
  }

  return {
    pendingVerification,
    tenantId,
    targetRecipeUserId,
    retiredMethods,
    normalizedEmail,
    user,
  };
}

async function reconcileCommittingEmailVerification(input: {
  userId: string;
  pendingVerification: RowndPendingVerification;
  userContext?: Record<string, any>;
}) {
  let {
    pendingVerification,
    tenantId,
    targetRecipeUserId,
    retiredMethods,
    normalizedEmail,
    user,
  } = await validateCommittingEmailVerificationPlan({
    userId: input.userId,
    pendingVerificationId: input.pendingVerification.id,
    tenantId: input.pendingVerification.tenantId ?? PUBLIC_TENANT_ID,
    expectedTargetRecipeUserId:
      input.pendingVerification.targetCanonicalRecipeUserId ?? "",
    expectedEmail: input.pendingVerification.value,
    userContext: input.userContext,
  });

  const completeRetiredMethods = [
    ...new Map(
      [
        ...retiredMethods,
        ...user.loginMethods
          .filter(
            (method) =>
              method.recipeId === "passwordless" &&
              method.email !== undefined &&
              method.tenantIds.includes(tenantId) &&
              method.recipeUserId.getAsString() !== targetRecipeUserId,
          )
          .map((method) => ({
            recipeUserId: method.recipeUserId.getAsString(),
            email: normalizeEmail(method.email!),
          })),
      ].map((method) => [method.recipeUserId, method]),
    ).values(),
  ];
  if (
    JSON.stringify(completeRetiredMethods) !== JSON.stringify(retiredMethods)
  ) {
    pendingVerification = {
      ...pendingVerification,
      retiredMethods: completeRetiredMethods,
    };
    await updateEmailReplacementPlan(
      input.userId,
      pendingVerification,
      input.userContext,
    );
    retiredMethods = completeRetiredMethods;
  }

  for (const { email } of retiredMethods) {
    const revocation = await Passwordless.revokeAllCodes({
      email,
      tenantId,
      userContext: input.userContext,
    });
    if (revocation.status !== "OK") {
      throw new Error("Failed to revoke replaced email passwordless codes");
    }
  }

  for (const { recipeUserId } of retiredMethods) {
    await removePasswordlessMethodFromTenant(
      recipeUserId,
      tenantId,
      input.userId,
      true,
      input.userContext,
    );
  }
  await Session.revokeAllSessionsForUser(
    input.userId,
    true,
    undefined,
    input.userContext,
  );

  const finalMetadata = await getRawUserMetadata(
    input.userId,
    input.userContext,
  );
  const finalCommittingPlans = getCommittingEmailPlansForTenant(
    finalMetadata,
    tenantId,
  );
  const finalPendingVerification = finalCommittingPlans.find(
    (verification) => verification.id === pendingVerification.id,
  );
  if (
    finalCommittingPlans.length !== 1 ||
    finalPendingVerification?.status !== "COMMITTING" ||
    (finalPendingVerification.tenantId ?? PUBLIC_TENANT_ID) !== tenantId ||
    normalizeEmail(finalPendingVerification.value) !== normalizedEmail ||
    finalPendingVerification.targetCanonicalRecipeUserId !==
      targetRecipeUserId ||
    JSON.stringify(finalPendingVerification.retiredMethods) !==
      JSON.stringify(retiredMethods)
  ) {
    throw new Error("pending email reconciliation state changed");
  }

  const finalTargetOwner = await SuperTokens.getUser(
    targetRecipeUserId,
    input.userContext,
  );
  const finalTargetMethod = finalTargetOwner?.loginMethods.find(
    (method) => method.recipeUserId.getAsString() === targetRecipeUserId,
  );
  if (
    !finalTargetOwner ||
    finalTargetOwner.id !== input.userId ||
    !finalTargetMethod ||
    finalTargetMethod.recipeId !== "passwordless" ||
    !finalTargetMethod.verified ||
    !finalTargetMethod.tenantIds.includes(tenantId) ||
    normalizeEmail(finalTargetMethod.email ?? "") !== normalizedEmail
  ) {
    throw new Error("pending email reconciliation target changed");
  }
  if (
    finalTargetOwner.loginMethods.some(
      (method) =>
        method.recipeId === "passwordless" &&
        method.email !== undefined &&
        method.tenantIds.includes(tenantId) &&
        method.recipeUserId.getAsString() !== targetRecipeUserId,
    )
  ) {
    throw new Error("pending email reconciliation cleanup is incomplete");
  }

  await updatePrimaryUserMetadata(
    input.userId,
    buildVerifiedEmailMetadata(
      finalMetadata,
      input.userId,
      normalizedEmail,
      targetRecipeUserId,
      tenantId,
      undefined,
      pendingVerification.id,
    ),
    input.userContext,
  );
}

export async function prepareEmailForPasswordlessAuth(input: {
  email: string;
  tenantId: string;
  reconcileTarget: boolean;
  userContext?: Record<string, any>;
}) {
  const normalizedEmail = normalizeEmail(input.email);
  if (!normalizedEmail) return { status: "ALLOW" } as const;
  if (isSuperTokensFakeEmail(normalizedEmail)) {
    return { status: "REJECT_CLEANUP_METHOD" } as const;
  }

  const users = await SuperTokens.listUsersByAccountInfo(
    input.tenantId,
    { email: input.email },
    true,
    input.userContext,
  );
  const matchingPlans: Array<
    | {
        userId: string;
        pendingVerification: RowndPendingVerification;
        disposition: "TARGET";
        migrationInternalUserId?: string;
      }
    | { userId: string; disposition: "CLEANUP" }
  > = [];
  const snapshot: PasswordlessAuthSnapshot = { users, inspections: new Map() };

  for (const user of users) {
    const listedMatchingMethods = user.loginMethods.filter(
      (method) =>
        method.recipeId === "passwordless" &&
        method.tenantIds.includes(input.tenantId) &&
        normalizeEmail(method.email ?? "") === normalizedEmail,
    );
    if (listedMatchingMethods.length === 0) continue;

    const inspection = await inspectLinkedUserMetadata(user.id, input.userContext, user);
    snapshot.inspections.set(user.id, inspection);
    const metadata = inspection.combinedMetadata;
    const committingPlans = getCommittingEmailPlansForTenant(
      metadata,
      input.tenantId,
    );
    if (committingPlans.length > 1) {
      throw new Error("multiple email reconciliation plans found");
    }
    const committingPlan = committingPlans[0];
    if (!committingPlan) {
      const canonical = resolveEmailForAuthentication({
        user,
        metadata,
        email: normalizedEmail,
        tenantId: input.tenantId,
        passwordlessOnly: true,
      });
      if (canonical.status === "AMBIGUOUS") {
        throw new Error(
          "multiple passwordless email methods found without a canonical method",
        );
      }
      if (canonical.status === "INVALID_CANONICAL") {
        throw new Error("canonical passwordless email method is invalid");
      }
      if (
        canonical.status === "SELECTED" &&
        listedMatchingMethods.some(
          (method) =>
            !canonical.recipeUserIds.includes(method.recipeUserId.getAsString()),
        )
      ) {
        matchingPlans.push({
          userId: user.id,
          disposition: "CLEANUP",
        });
      }
      continue;
    }

    const migrationPlan = isCurrentRowndEmailReconciliationPlan(committingPlan);
    const validatedPlan = migrationPlan
      ? await validateCurrentRowndEmailReconciliation({
        internalUserId: inspection.primaryUserId,
        plan: committingPlan,
        tenantId: input.tenantId,
        userContext: input.userContext ?? {},
      })
      : await validateCommittingEmailVerificationPlan({
        userId: user.id,
        pendingVerificationId: committingPlan.id,
        tenantId: input.tenantId,
        expectedTargetRecipeUserId:
          committingPlan.targetCanonicalRecipeUserId ?? "",
        expectedEmail: committingPlan.value,
        userContext: input.userContext,
      });
    const matchingRecipeUserIds = validatedPlan.user.loginMethods
      .filter(
        (method) =>
          method.recipeId === "passwordless" &&
          method.tenantIds.includes(input.tenantId) &&
          normalizeEmail(method.email ?? "") === normalizedEmail,
      )
      .map((method) => method.recipeUserId.getAsString());
    if (matchingRecipeUserIds.length === 0) {
      throw new Error("passwordless auth method changed during preparation");
    }

    const retiredRecipeUserIds = new Set(
      validatedPlan.retiredMethods.map((method) => method.recipeUserId),
    );
    const matchesCleanupMethod = matchingRecipeUserIds.some((recipeUserId) =>
      retiredRecipeUserIds.has(recipeUserId),
    );
    const matchesTargetMethod = matchingRecipeUserIds.includes(
      validatedPlan.targetRecipeUserId,
    );
    if (matchesCleanupMethod) {
      matchingPlans.push({
        userId: user.id,
        disposition: "CLEANUP",
      });
    } else if (
      matchesTargetMethod &&
      validatedPlan.normalizedEmail === normalizedEmail
    ) {
      matchingPlans.push({
        userId: user.id,
        pendingVerification: validatedPlan.pendingVerification,
        disposition: "TARGET",
        ...(migrationPlan ? { migrationInternalUserId: inspection.primaryUserId } : {}),
      });
    }
  }

  if (matchingPlans.length === 0) return { status: "ALLOW", snapshot } as const;
  if (matchingPlans.length > 1) {
    throw new Error("multiple matching email reconciliation accounts found");
  }
  const matchingPlan = matchingPlans[0];
  if (!matchingPlan) return { status: "ALLOW" } as const;
  if (matchingPlan.disposition === "CLEANUP") {
    return { status: "REJECT_CLEANUP_METHOD" } as const;
  }

  if (input.reconcileTarget) {
    if (matchingPlan.migrationInternalUserId !== undefined) {
      await finishCurrentRowndEmailReconciliation({
        internalUserId: matchingPlan.migrationInternalUserId,
        plan: matchingPlan.pendingVerification,
        tenantId: input.tenantId,
        userContext: input.userContext ?? {},
        removeMethod: (recipeUserId, tenantId, sdkUserId) =>
          removePasswordlessMethodFromTenant(recipeUserId, tenantId, sdkUserId, true, input.userContext),
      });
    } else {
      await reconcileCommittingEmailVerification({
        userId: matchingPlan.userId,
        pendingVerification: matchingPlan.pendingVerification,
        userContext: input.userContext,
      });
    }
  }
  return { status: "ALLOW" } as const;
}

export async function validateConsumedPasswordlessEmail(input: {
  userId: string;
  email: string;
  tenantId: string;
  intent?: "sign_in" | "sign_up";
  createdNewRecipeUser: boolean;
  recipeUserId?: string;
  userContext?: Record<string, any>;
}) {
  clearSuperTokensCoreCallCache(input.userContext ?? {});
  invalidateReconciliationReads();
  const historicalScope = getHistoricalPasswordlessScope(input.userContext);
  let historicalOwner: Awaited<ReturnType<typeof validateHistoricalPasswordlessOwner>>;
  if (historicalScope) {
    if (input.userId !== historicalScope.userId || input.tenantId !== historicalScope.tenantId ||
      input.recipeUserId !== historicalScope.recipeUserId ||
      normalizeEmail(input.email) !== historicalScope.email ||
      !(historicalOwner = await validateHistoricalPasswordlessOwner(historicalScope, input.userContext, true))) {
      historicalScope.denied = true;
      return { status: "REJECT" } as const;
    }
  }
  if (isSuperTokensFakeEmail(input.email)) return { status: "REJECT" } as const;
  const owner = historicalOwner ?? await SuperTokens.getUser(input.userId, input.userContext);
  if (!owner || owner.id !== input.userId) {
    return { status: "REJECT" } as const;
  }
  const matchingMethods = owner.loginMethods.filter(
    (candidate) =>
      candidate.recipeId === "passwordless" &&
      candidate.tenantIds.includes(input.tenantId) &&
      normalizeEmail(candidate.email ?? "") === normalizeEmail(input.email),
  );
  const method = matchingMethods[0];
  if (matchingMethods.length !== 1 || !method) {
    return { status: "REJECT" } as const;
  }
  const recipeUserId = method.recipeUserId.getAsString();

  if (input.createdNewRecipeUser) {
    if (owner.id !== recipeUserId) {
      const isLinkedToVerifiedMatchingEmailMethod = owner.loginMethods.some(
        (candidate) =>
          candidate.recipeUserId.getAsString() !== recipeUserId &&
          candidate.tenantIds.includes(input.tenantId) &&
          candidate.verified &&
          normalizeEmail(candidate.email ?? "") === normalizeEmail(input.email),
      );
      if (
        input.intent === "sign_in" &&
        !isLinkedToVerifiedMatchingEmailMethod &&
        !historicalOwner &&
        !(await hasHistoricalEmailEligibility({
          ...owner,
          loginMethods: owner.loginMethods.filter((candidate) =>
            candidate.recipeUserId.getAsString() !== recipeUserId),
        }, input.email, input.tenantId, input.userContext))
      ) {
        return { status: "REJECT" } as const;
      }
      return { status: "ALLOW" } as const;
    }
    const isStandaloneMethod =
      input.intent !== "sign_in" && owner.loginMethods.length === 1;
    return isStandaloneMethod
      ? ({ status: "ALLOW" } as const)
      : ({ status: "REJECT_AND_DELETE", recipeUserId } as const);
  }

  const metadata = (
    await inspectLinkedUserMetadata(owner.id, input.userContext, owner)
  ).combinedMetadata;
  const committingPlans = getCommittingEmailPlansForTenant(
    metadata,
    input.tenantId,
  );
  if (committingPlans.length > 1) {
    throw new Error("multiple email reconciliation plans found");
  }
  const committingTarget = committingPlans[0]?.targetCanonicalRecipeUserId;
  if (committingTarget) {
    return committingTarget === recipeUserId
      ? ({ status: "ALLOW" } as const)
      : ({ status: "REJECT" } as const);
  }

  const canonical = resolveEmailForAuthentication({
    user: owner,
    metadata,
    email: input.email,
    tenantId: input.tenantId,
    passwordlessOnly: true,
  });
  return canonical.status === "SELECTED" &&
    canonical.recipeUserIds.includes(recipeUserId)
    ? ({ status: "ALLOW" } as const)
    : ({ status: "REJECT" } as const);
}

export async function deleteRejectedConsumedPasswordlessUser(input: {
  userId: string;
  recipeUserId: string;
  tenantId: string;
  email: string;
  onlyIfStillStandalone?: boolean;
  userContext?: Record<string, any>;
}) {
  // A throwing callback may have linked or promoted this user through another client.
  clearSuperTokensCoreCallCache(input.userContext ?? {});
  invalidateReconciliationReads();
  const owner = await SuperTokens.getUser(input.recipeUserId, input.userContext);
  const method = owner?.loginMethods[0];
  if (
    !owner ||
    owner.id !== input.userId ||
    owner.id !== input.recipeUserId ||
    (input.onlyIfStillStandalone && owner.isPrimaryUser) ||
    owner.loginMethods.length !== 1 ||
    method?.recipeUserId.getAsString() !== input.recipeUserId ||
    method.recipeId !== "passwordless" ||
    method.tenantIds.length !== 1 ||
    method.tenantIds[0] !== input.tenantId ||
    normalizeEmail(method.email ?? "") !== normalizeEmail(input.email)
  ) {
    if (input.onlyIfStillStandalone) return;
    throw new Error("refusing to delete non-standalone consumed user");
  }
  await SuperTokens.deleteUser(input.recipeUserId, false, input.userContext);
}

function emailReconciliationRequired() {
  return new RowndEmailChangeError(
    "CONFLICT",
    409,
    "email change cleanup incomplete; account reconciliation is required",
  );
}

async function rejectInactivePendingEmailVerification(
  userId: string,
  pendingVerification: RowndPendingVerification,
  recipeUserId: SuperTokensLoginMethod["recipeUserId"],
  email: string,
  userContext?: Record<string, any>,
): Promise<never> {
  await cleanupPendingEmailVerification(
    userId,
    pendingVerification,
    recipeUserId,
    email,
    userContext,
  );
  throw new RowndEmailChangeError(
    "CONFLICT",
    409,
    "email change session is no longer active; start the email change again",
  );
}

async function cleanupPendingEmailVerification(
  userId: string,
  pendingVerification: RowndPendingVerification,
  recipeUserId: SuperTokensLoginMethod["recipeUserId"],
  email: string,
  userContext?: Record<string, any>,
) {
  await EmailVerification.unverifyEmail(recipeUserId, email, userContext);
  await removePendingEmailVerification(
    userId,
    pendingVerification.id,
    pendingVerification.tenantId ?? PUBLIC_TENANT_ID,
    userContext,
  );
}

function buildVerifiedEmailMetadata(
  metadata: RowndMetadata,
  userId: string,
  email: string,
  canonicalEmailRecipeUserId: string,
  tenantId: string,
  fallbackOriginalRowndUser?: RowndMetadata["original_rownd_user"],
  completedPendingVerificationId?: string,
): RowndMetadata {
  const compatibilityUser = metadata.original_rownd_user ??
    fallbackOriginalRowndUser ?? {
    state: "enabled",
    auth_level: "verified",
    data: { user_id: userId },
    verified_data: {},
    groups: [],
    meta: {},
  };

  return {
    ...metadata,
    original_rownd_user: {
      ...compatibilityUser,
      data: {
        ...compatibilityUser.data,
        user_id: compatibilityUser.data.user_id ?? userId,
        email,
      },
      verified_data: {
        ...compatibilityUser.verified_data,
        email,
      },
    },
    rownd_email_recipe_user_id: canonicalEmailRecipeUserId,
    rownd_email_recipe_user_ids: {
      ...metadata.rownd_email_recipe_user_ids,
      [tenantId]: canonicalEmailRecipeUserId,
    },
    rownd_pending_verification: getPendingVerifications(metadata).filter(
      (verification) =>
        completedPendingVerificationId
          ? !(
            verification.field === "email" &&
              verification.id === completedPendingVerificationId &&
              (verification.tenantId ?? PUBLIC_TENANT_ID) === tenantId
          )
          : verification.field !== "email" ||
            (verification.tenantId ?? PUBLIC_TENANT_ID) !== tenantId,
    ),
  };
}

export async function updateUserMetadata(
  userId: string,
  inputMeta: JsonRecord,
  userContext?: JsonRecord,
) {
  const { primaryUserId } = await updatePrimaryUserMetadata(
    userId,
    inputMeta,
    userContext,
  );
  const updatedMetadata = await getCombinedUserMetadata(
    primaryUserId,
    userContext,
  );

  return {
    id: primaryUserId,
    meta: Object.fromEntries(
      Object.entries(updatedMetadata).filter(
        ([key]) => !isInternalMetadataField(key),
      ),
    ) as JsonRecord,
  };
}

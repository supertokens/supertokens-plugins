import { isDeepStrictEqual } from "node:util";
import {
  reconciliationSuperTokens as SuperTokens,
  reconciliationUserMetadata as UserMetadata,
} from "./reconciliation-sdk";
import { RowndMigrationPolicyError } from "./errors";
import {
  assertAuthenticatedMigrationSource,
  isAdministrativeMigration,
} from "./migration-email";
import { assertMigrationOwnerGraph } from "./migration-postconditions";
import { assertSelectorNamespace } from "./migration-mapping";
import {
  clearSuperTokensCoreCallCache,
  isRecord,
  type JsonRecord,
} from "./utils";
import type { SuperTokensUserImport } from "./types";
import type { ProviderIntroduction } from "./migration-provider";

const introductionIndex = "rownd_migration_provider_introductions";
const introductionRecord = "rownd_migration_provider_introduction";

async function metadata(id: string, context: JsonRecord) {
  return (await UserMetadata.getUserMetadata(id, context)).metadata;
}

async function immutable(id: string, context: JsonRecord) {
  await assertSelectorNamespace(id, context);
  const mapping = await SuperTokens.getUserIdMapping({
    userId: id,
    userIdType: "EXTERNAL",
    userContext: context,
  });
  return mapping.status === "OK" ? mapping.superTokensUserId : id;
}

async function inspectIntroductions(
  source: SuperTokensUserImport,
  tenantId: string,
  target: string,
  context: JsonRecord,
  requireLinked: boolean,
) {
  await assertAuthenticatedMigrationSource(source, tenantId);
  clearSuperTokensCoreCallCache(context);
  const targetUser = await SuperTokens.getUser(target, context);
  if (!targetUser || (await immutable(targetUser.id, context)) !== target)
    throw new RowndMigrationPolicyError("Administrative donor disappeared");
  await assertMigrationOwnerGraph(targetUser, tenantId, context);
  const literals = new Set([target, targetUser.id]);
  for (const method of targetUser.loginMethods) {
    const id = await immutable(method.recipeUserId.getAsString(), context);
    literals.add(id);
    const mapping = await SuperTokens.getUserIdMapping({
      userId: id,
      userIdType: "SUPERTOKENS",
      userContext: context,
    });
    if (mapping.status === "OK") literals.add(mapping.externalUserId);
  }
  const entries = new Map<string, ProviderIntroduction>();
  const snapshots = new Map<string, JsonRecord>();
  for (const id of literals) {
    const raw = await metadata(id, context);
    const values: JsonRecord = {};
    const pending: unknown[] = [];
    if (raw[introductionIndex] !== undefined) {
      if (!Array.isArray(raw[introductionIndex]))
        throw new RowndMigrationPolicyError(
          "Invalid administrative provider introduction index",
        );
      values[introductionIndex] = raw[introductionIndex];
      pending.push(...raw[introductionIndex]);
    }
    if (raw[introductionRecord] !== undefined) {
      values[introductionRecord] = raw[introductionRecord];
      pending.push(raw[introductionRecord]);
    }
    snapshots.set(id, values);
    for (const entry of pending) {
      if (
        !isRecord(entry) ||
        entry.rowndUserId !== source.externalUserId ||
        entry.internalUserId !== target ||
        entry.tenantId !== tenantId ||
        typeof entry.recipeUserId !== "string" ||
        !entry.recipeUserId ||
        typeof entry.created !== "boolean" ||
        !["google", "apple"].includes(String(entry.provider)) ||
        typeof entry.subject !== "string" ||
        !entry.subject ||
        !source.loginMethods.some(
          (method) =>
            method.recipeId === "thirdparty" &&
            method.thirdPartyId === entry.provider &&
            method.thirdPartyUserId === entry.subject,
        )
      ) {
        throw new RowndMigrationPolicyError(
          "Administrative provider introduction is not bound to the current source",
        );
      }
      const previous = entries.get(entry.recipeUserId);
      if (previous && !isDeepStrictEqual(previous, entry))
        throw new RowndMigrationPolicyError(
          "Administrative provider introduction checkpoints disagree",
        );
      entries.set(entry.recipeUserId, entry as ProviderIntroduction);
      literals.add(entry.recipeUserId);
    }
  }
  if (!entries.size) return { entries: [], snapshots };
  const mapping = await SuperTokens.getUserIdMapping({
    userId: source.externalUserId!,
    userIdType: "EXTERNAL",
    userContext: context,
  });
  if (
    mapping.status === "OK"
      ? mapping.superTokensUserId !== target
      : source.externalUserId !== target
  ) {
    throw new RowndMigrationPolicyError(
      "Administrative provider introduction recipient changed",
    );
  }
  for (const entry of entries.values()) {
    const user = await SuperTokens.getUser(entry.recipeUserId, context);
    const owner = user && (await immutable(user.id, context));
    const method =
      user &&
      (
        await Promise.all(
          user.loginMethods.map(async (method) => ({
            method,
            id: await immutable(method.recipeUserId.getAsString(), context),
          })),
        )
      ).find(({ id }) => id === entry.recipeUserId)?.method;
    if (
      !user ||
      !method?.tenantIds.includes(tenantId) ||
      !method.hasSameThirdPartyInfoAs({
        id: entry.provider,
        userId: entry.subject,
      }) ||
      (owner !== target &&
        (requireLinked || user.isPrimaryUser || user.loginMethods.length !== 1))
    ) {
      throw new RowndMigrationPolicyError(
        "Administrative provider introduction ownership is not recoverable",
      );
    }
    const donorMapping = await SuperTokens.getUserIdMapping({
      userId: entry.recipeUserId,
      userIdType: "SUPERTOKENS",
      userContext: context,
    });
    if (owner !== target && donorMapping.status === "OK")
      throw new RowndMigrationPolicyError(
        "Administrative provider introduction has a foreign mapping",
      );
    await assertSelectorNamespace(entry.recipeUserId, context);
  }
  return { entries: [...entries.values()], snapshots };
}

export async function inspectAdministrativeProviderIntroductions(
  source: SuperTokensUserImport,
  tenantId: string,
  target: string,
  context: JsonRecord,
) {
  if (!isAdministrativeMigration(source, tenantId)) return [];
  return (await inspectIntroductions(source, tenantId, target, context, false))
    .entries;
}

export async function finishAdministrativeProviderIntroductions(
  source: SuperTokensUserImport,
  tenantId: string,
  target: string,
  context: JsonRecord,
) {
  if (!isAdministrativeMigration(source, tenantId)) return;
  const initial = await inspectIntroductions(
    source,
    tenantId,
    target,
    context,
    true,
  );
  if (!initial.entries.length) return;
  const assertFresh = async () => {
    await inspectIntroductions(source, tenantId, target, context, true);
    for (const [id, expected] of initial.snapshots) {
      const current = await metadata(id, context);
      if (
        ![introductionIndex, introductionRecord].every((field) =>
          isDeepStrictEqual(current[field], expected[field]),
        )
      ) {
        throw new RowndMigrationPolicyError(
          "Administrative provider introduction changed during recovery",
        );
      }
    }
  };
  // Keep discovery indexes until all per-recipe records have been acknowledged.
  for (const field of [introductionRecord, introductionIndex])
    for (const [id, expected] of initial.snapshots) {
      if (
        expected[field] === undefined ||
        (Array.isArray(expected[field]) && expected[field].length === 0)
      )
        continue;
      await assertFresh();
      const replacement = field === introductionIndex ? [] : null;
      await UserMetadata.updateUserMetadata(
        id,
        { [field]: replacement },
        context,
      );
      if (replacement === null) delete expected[field];
      else expected[field] = replacement;
      await assertFresh();
    }
}

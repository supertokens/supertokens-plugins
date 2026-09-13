import SuperTokens from "supertokens-node";
import { assertAuthenticatedMigrationSource } from "./migration-email";
import { assertMigrationMapping } from "./migration-mapping";
import { migrationTelemetry } from "./telemetry/migrationTelemetry";
import type { SuperTokensUserImport } from "./types";
import { clearSuperTokensCoreCallCache, type JsonRecord } from "./utils";

type User = NonNullable<Awaited<ReturnType<typeof SuperTokens.getUser>>>;
type ImportMethod = SuperTokensUserImport["loginMethods"][number];
type Failure = "missing_user" | "unexpected_owner" | "missing_method" |
  "missing_tenant" | "unverified_authenticated_email";

export async function assertMigrationPostconditions(input: {
  internalUserId: string;
  source: SuperTokensUserImport;
  importMethods: ImportMethod[];
  tenantId: string;
  authenticatedEmail?: string;
  userContext: JsonRecord;
  matchesMethod: (existing: User["loginMethods"][number], expected: ImportMethod) => boolean;
}) {
  const { internalUserId, source, importMethods, tenantId, authenticatedEmail, userContext, matchesMethod } = input;
  const telemetry = migrationTelemetry(userContext);
  if (telemetry) telemetry.stage = "migration_postcondition";

  const observe = (user: User | undefined): Failure | undefined => {
    if (!user) return "missing_user";
    // Mapping validation proves the current alias. A retired SDK alias is not
    // ownership proof, even when an earlier snapshot resolved it to this target.
    if (user.id !== internalUserId && user.id !== source.externalUserId) return "unexpected_owner";
    for (const expected of importMethods) {
      const matches = user.loginMethods.filter((method) => matchesMethod(method, expected));
      if (matches.length === 0) return "missing_method";
      const scoped = matches.filter((method) => method.tenantIds.includes(tenantId));
      if (scoped.length === 0) return "missing_tenant";
      if (expected.recipeId === "passwordless" && authenticatedEmail !== undefined &&
          expected.email?.toLowerCase() === authenticatedEmail && !scoped.some((method) => method.verified)) {
        return "unverified_authenticated_email";
      }
    }
    return undefined;
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      clearSuperTokensCoreCallCache(userContext);
      await assertAuthenticatedMigrationSource(source, tenantId);
    }
    await assertMigrationMapping(internalUserId, source.externalUserId!, userContext);
    const failure = observe(await SuperTokens.getUser(internalUserId, userContext));
    if (failure === undefined) {
      if (attempt > 0) {
        await assertMigrationMapping(internalUserId, source.externalUserId!, userContext);
        telemetry?.emit("transition", "migration_postcondition_recovered");
      }
      return;
    }
    const error = new Error(`Migrated login method postcondition failed: ${failure}`);
    telemetry?.emit("transition", `migration_postcondition_${failure}`, "error", error);
    if (attempt === 1) throw error;
  }
}

import { type RowndUser } from "../src/types";
import { type RowndOidcClient } from "./setupCoreInstance";

export const PUBLIC_TENANT_ID = "public";

function unique(values: Array<string | undefined | null>) {
  return [...new Set(values.filter((value): value is string => !!value))];
}

export function getTenantIdsForRowndUser(rowndUser: RowndUser): string[] {
  const appVariants = rowndUser.attributes?.["rownd:app_variants"];
  const tenantIds = Array.isArray(appVariants)
    ? unique(appVariants)
    : appVariants
      ? [appVariants]
      : [];

  return unique([PUBLIC_TENANT_ID, ...tenantIds]);
}

export function getTenantIdsForOidcClients(
  oidcClients: RowndOidcClient[],
): string[] {
  const tenantIds = oidcClients.flatMap((client) =>
    (client.credentials ?? [])
      .map((credential) => credential.app_variant_id)
      .filter((tenantId): tenantId is string => !!tenantId),
  );

  return unique(tenantIds);
}

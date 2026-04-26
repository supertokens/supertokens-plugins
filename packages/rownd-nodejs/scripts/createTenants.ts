import { z } from "zod";
import {
  loadConfig,
  formatZodError,
  fetchWithRetry,
  type BulkMigrateConfig,
} from "./bulkMigrate";

export async function provisionSuperTokensInfrastructure(
  config: BulkMigrateConfig,
  oidcClients: RowndOidcClient[],
) {
  const generatedTenantIds: string[] = ["public"];

  for (const client of oidcClients) {
    const tenantId = client.id;
    generatedTenantIds.push(tenantId);

    console.log(`Provisioning SuperTokens Tenant: ${tenantId}`);
    const tenantHeaders: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (config.supertokens.apiKey) {
      tenantHeaders["api-key"] = config.supertokens.apiKey;
    }

    const tenantRes = await fetchWithRetry({
      url: new URL(
        `/recipe/multitenancy/tenant/v2`,
        config.supertokens.connectionURI,
      ).toString(),
      requestInit: {
        method: "PUT",
        headers: tenantHeaders,
        body: JSON.stringify({ tenantId }),
      },
      retryConfig: config.retry,
      operation: `Create SuperTokens tenant ${tenantId}`,
    });

    if (!tenantRes.ok) {
      throw new Error(
        `Failed to create tenant ${tenantId}: ${tenantRes.status} ${await tenantRes.text()}`,
      );
    }

    console.log(
      `Provisioning SuperTokens OAuth2 Client for Tenant: ${tenantId}`,
    );
    const credentials = client.credentials?.[0];
    const oauthRes = await fetchWithRetry({
      url: new URL(
        `/${tenantId}/recipe/oauth2/client`,
        config.supertokens.connectionURI,
      ).toString(),
      requestInit: {
        method: "POST",
        headers: tenantHeaders,
        body: JSON.stringify({
          clientName: client.name || "Rownd Client",
          clientId: credentials?.client_id || client.id,
          clientSecret: credentials?.secret,
          redirectUris: client.config.redirect_uris || [],
          postLogoutRedirectUris: client.config.post_logout_uris || [],
          scope: client.config.allowed_scopes?.join(" "),
          responseTypes: ["code", "token", "id_token"],
          grantTypes: [
            "authorization_code",
            "refresh_token",
            "client_credentials",
            "implicit",
          ],
          tokenEndpointAuthMethod: "client_secret_post",
        }),
      },
      retryConfig: config.retry,
      operation: `Create OAuth2 Client for tenant ${tenantId}`,
    });

    if (!oauthRes.ok) {
      const errorText = await oauthRes.text();
      // Skip if client already exists (SuperTokens core might return 400 or specific error)
      if (
        !errorText.includes("already exists") &&
        !errorText.includes("Duplicate")
      ) {
        throw new Error(
          `Failed to create OAuth2 Client for tenant ${tenantId}: ${oauthRes.status} ${errorText}`,
        );
      }
    }
  }

  return generatedTenantIds;
}

const RowndOidcClientSchema = z.object({
  id: z.string(),
  name: z.string(),
  config: z.object({
    redirect_uris: z.array(z.string()).optional(),
    post_logout_uris: z.array(z.string()).optional(),
    allowed_scopes: z.array(z.string()).optional(),
  }),
  credentials: z
    .array(
      z.object({
        client_id: z.string(),
        secret: z.string().optional(),
      }),
    )
    .optional(),
});

export type RowndOidcClient = z.infer<typeof RowndOidcClientSchema>;

export async function fetchRowndOidcClients(
  config: BulkMigrateConfig,
): Promise<RowndOidcClient[]> {
  const url = new URL(
    `/applications/${config.rownd.appId}/oidc-clients`,
    "https://api.rownd.io",
  );

  const response = await fetchWithRetry({
    url: url.toString(),
    requestInit: {
      headers: {
        "x-rownd-app-key": config.rownd.appKey,
        "x-rownd-app-secret": config.rownd.appSecret,
      },
    },
    retryConfig: config.retry,
    operation: "Fetching Rownd OIDC clients",
  });

  if (!response.ok) {
    throw new Error(
      `Rownd API error: ${response.status} ${await response.text()}`,
    );
  }

  const page = z
    .object({ results: z.array(RowndOidcClientSchema) })
    .parse(await response.json());
  return page.results;
}

export async function runCli() {
  const config = await loadConfig();
  const oidcClients = await fetchRowndOidcClients(config);
  await provisionSuperTokensInfrastructure(config, oidcClients);
  console.log("Successfully provisioned SuperTokens infrastructure.");
}

runCli().catch((error: unknown) => {
  if (error instanceof z.ZodError) {
    console.error(formatZodError(error));
  } else {
    console.error(
      error instanceof Error ? error.message : "Provisioning failed",
    );
  }
  process.exitCode = 1;
});

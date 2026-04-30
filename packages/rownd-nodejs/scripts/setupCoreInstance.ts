import { z } from "zod";
import {
  loadConfig,
  formatZodError,
  type BulkMigrateConfig,
} from "./scriptUtils";
import { getTenantIdsForOidcClients } from "./rowndTenantMapping";

export async function provisionSuperTokensInfrastructure(
  config: BulkMigrateConfig,
  oidcClients: RowndOidcClient[],
) {
  const generatedTenantIds = getTenantIdsForOidcClients(oidcClients);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.supertokens.apiKey) {
    headers["api-key"] = config.supertokens.apiKey;
  }

  for (const oidcClient of oidcClients) {
    for (const credential of oidcClient.credentials ?? []) {
      console.log(
        `Provisioning SuperTokens OAuth2 Client: ${credential.client_id}`,
      );

      const oauthRes = await fetch(
        new URL(
          `/recipe/oauth/clients`,
          config.supertokens.connectionURI,
        ).toString(),
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            clientName:
              oidcClient.name || credential.client_id || "Rownd Client",
            clientId: credential.client_id,
            clientSecret: credential.secret,
            redirectUris: oidcClient.config.redirect_uris || [],
            postLogoutRedirectUris: oidcClient.config.post_logout_uris || [],
            scope: oidcClient.config.allowed_scopes?.join(" "),
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
      );

      if (!oauthRes.ok) {
        const errorText = await oauthRes.text();
        if (
          !errorText.includes("already exists") &&
          !errorText.includes("Duplicate")
        ) {
          throw new Error(
            `Failed to create OAuth2 Client ${credential.client_id}: ${oauthRes.status} ${errorText}`,
          );
        }
      }
    }
  }

  for (const tenantId of generatedTenantIds) {
    console.log(`Provisioning SuperTokens Tenant: ${tenantId}`);

    const tenantRes = await fetch(
      new URL(
        `/recipe/multitenancy/tenant/v2`,
        config.supertokens.connectionURI,
      ).toString(),
      {
        method: "PUT",
        headers,
        body: JSON.stringify({ tenantId }),
      },
    );

    if (!tenantRes.ok) {
      throw new Error(
        `Failed to create tenant ${tenantId}: ${tenantRes.status} ${await tenantRes.text()}`,
      );
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
        app_variant_id: z.string().optional(),
      }),
    )
    .optional(),
});

export type RowndOidcClient = z.infer<typeof RowndOidcClientSchema>;

export async function fetchRowndOidcClients(
  config: BulkMigrateConfig,
): Promise<RowndOidcClient[]> {
  const url = new URL(
    `/api/applications/${config.rownd.appId}/oidc-clients`,
    "https://app.rownd.io",
  );

  const response = await fetch(url.toString(), {
    headers: {
      "x-rownd-app-key": config.rownd.appKey,
      "x-rownd-app-secret": config.rownd.appSecret,
    },
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

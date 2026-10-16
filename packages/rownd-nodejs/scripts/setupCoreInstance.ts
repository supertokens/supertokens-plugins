import { z } from "zod";
import {
  loadConfig,
  formatZodError,
  hasHelpArg,
  parseRequiredConfigArg,
  type BulkMigrateConfig,
} from "./scriptUtils";

function printHelp() {
  console.log(`Usage: rownd-nodejs setup-core --config <path>

Options:
  -c, --config <path>  Path to the bulk migration config file
  -h, --help           Show this help message`);
}

export async function provisionSuperTokensInfrastructure(
  config: BulkMigrateConfig,
  oidcClients: RowndOidcClient[],
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.supertokens.apiKey) {
    headers["api-key"] = config.supertokens.apiKey;
  }

  const provisionedClientIds = new Set<string>();

  for (const oidcClient of oidcClients) {
    const credentials = oidcClient.credentials ?? [];
    for (const credential of credentials) {
      await createSuperTokensOAuthClient({
        config,
        headers,
        oidcClient,
        clientId: credential.client_id,
        clientSecret: resolveOidcClientSecret(
          config,
          credential.client_id,
          credential.secret,
        ),
        appVariantId: credential.app_variant_id,
        provisionedClientIds,
      });
    }

    if (config.rownd.provisionOidcClientIdAliases && credentials.length > 0) {
      const firstCredential = credentials[0];
      if (!firstCredential) {
        continue;
      }

      const firstCredentialSecret = resolveOidcClientSecret(
        config,
        firstCredential.client_id,
        firstCredential.secret,
      );
      const aliasSecret = resolveOidcClientSecret(
        config,
        oidcClient.id,
        firstCredentialSecret,
      );

      await createSuperTokensOAuthClient({
        config,
        headers,
        oidcClient,
        clientId: oidcClient.id,
        clientSecret: aliasSecret,
        isOidcClientIdAlias: true,
        provisionedClientIds,
      });
    }
  }
}

function resolveOidcClientSecret(
  config: BulkMigrateConfig,
  clientId: string,
  apiSecret?: string,
) {
  const secret = config.rownd.oidcClientSecrets?.[clientId] ?? apiSecret;
  if (!secret) {
    throw new Error(
      `Missing plaintext secret for Rownd OIDC client ${clientId}. Add rownd.oidcClientSecrets.${clientId} to the config.`,
    );
  }

  if (secret.startsWith("$argon2")) {
    throw new Error(
      `Rownd returned a hashed secret for OIDC client ${clientId}. Add the plaintext secret under rownd.oidcClientSecrets.${clientId}.`,
    );
  }

  return secret;
}

async function createSuperTokensOAuthClient(input: {
  config: BulkMigrateConfig;
  headers: Record<string, string>;
  oidcClient: RowndOidcClient;
  clientId: string;
  clientSecret: string;
  appVariantId?: string;
  isOidcClientIdAlias?: boolean;
  provisionedClientIds: Set<string>;
}) {
  if (input.provisionedClientIds.has(input.clientId)) {
    return;
  }
  input.provisionedClientIds.add(input.clientId);

  console.log(`Provisioning SuperTokens OAuth2 Client: ${input.clientId}`);

  const grantTypes = [
    "authorization_code",
    "refresh_token",
    "client_credentials",
    "implicit",
  ];
  if (input.oidcClient.config.device_flow_enabled) {
    grantTypes.push("urn:ietf:params:oauth:grant-type:device_code");
  }

  const oauthRes = await fetch(
    new URL(
      "/recipe/oauth/clients",
      input.config.supertokens.connectionURI,
    ).toString(),
    {
      method: "POST",
      headers: input.headers,
      body: JSON.stringify({
        clientName: input.oidcClient.name || input.clientId || "Rownd Client",
        clientId: input.clientId,
        clientSecret: input.clientSecret,
        redirectUris: input.oidcClient.config.redirect_uris || [],
        postLogoutRedirectUris: input.oidcClient.config.post_logout_uris || [],
        scope: input.oidcClient.config.allowed_scopes?.join(" "),
        responseTypes: ["code", "token", "id_token"],
        grantTypes,
        tokenEndpointAuthMethod:
          input.oidcClient.config.token_endpoint_auth_method ??
          "client_secret_basic",
        audience: [`app:${input.config.rownd.appId}`],
        metadata: {
          rowndOidcClientId: input.oidcClient.id,
          rowndAppVariantId: input.appVariantId || undefined,
          rowndAllowedScopes: input.oidcClient.config.allowed_scopes || [],
          rowndApplicationType: input.oidcClient.config.application_type,
          rowndIsPkceRequired: input.oidcClient.config.is_pkce_required,
          rowndIsPkceSupported: input.oidcClient.config.is_pkce_supported,
          rowndDeviceFlowEnabled: input.oidcClient.config.device_flow_enabled,
          rowndIsOidcClientIdAlias: input.isOidcClientIdAlias || undefined,
        },
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
        `Failed to create OAuth2 Client ${input.clientId}: ${oauthRes.status} ${errorText}`,
      );
    }
  }
}

const RowndOidcClientSchema = z.object({
  id: z.string(),
  name: z.string(),
  config: z.object({
    redirect_uris: z.array(z.string()).optional(),
    post_logout_uris: z.array(z.string()).optional(),
    allowed_scopes: z.array(z.string()).optional(),
    token_endpoint_auth_method: z
      .enum(["client_secret_basic", "client_secret_post", "none"])
      .optional(),
    application_type: z.enum(["web", "native"]).optional(),
    is_pkce_required: z.boolean().optional(),
    is_pkce_supported: z.boolean().optional(),
    device_flow_enabled: z.boolean().optional(),
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
  const args = process.argv.slice(2);
  if (hasHelpArg(args)) {
    printHelp();
    return;
  }

  const config = await loadConfig(parseRequiredConfigArg(args));
  const oidcClients = await fetchRowndOidcClients(config);
  await provisionSuperTokensInfrastructure(config, oidcClients);
  console.log("Successfully provisioned SuperTokens infrastructure.");
}

if (require.main === module) {
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
}

import * as fs from "node:fs/promises";
import { dirname, resolve } from "node:path";

const BULK_MIGRATE_CONFIG_TEMPLATE = `# Optional maximum number of users to process. Leave unset to process everything.
# limit: 100

checkpoint:
  # File used to persist migration progress so a later run can resume.
  file: ./rownd-migration-checkpoint.json
  # When true, continue from the saved checkpoint instead of starting over.
  resume: false

retry:
  # Number of attempts for retryable HTTP failures such as 429 and 5xx.
  maxAttempts: 5
  # Base backoff delay in milliseconds before exponential retry waits.
  initialDelayMs: 500

rownd:
  appId: <APP_ID>
  appKey: <APP_KEY>
  appSecret: <APP_SECRET>
  # Required when using generate-plugin-config --include-sub-brands.
  # bearerToken: <ROWND_API_BEARER_TOKEN>
  # Number of Rownd users to request per page.
  pageSize: 100
  # Rownd stores existing OIDC credential secrets hashed. Provide plaintext
  # values here when migrating OIDC clients. Keys can be credential client IDs
  # (key_...) and OIDC client configuration IDs (oc_...).
  oidcClientSecrets: {}
  # oidcClientSecrets:
  #   key_123: ras_plaintext_secret
  #   oc_123: ras_plaintext_secret_for_oidc_client_id_alias
  # Rownd accepts the OIDC client configuration ID (oc_...) as a client_id in
  # addition to each linked credential client_id (key_...).
  provisionOidcClientIdAliases: true

supertokens:
  connectionURI: <CONNECTION_URI>
  apiKey: <API_KEY>
  # Tenant that receives every imported login method.
  tenantId: public
  # Number of users to send to SuperTokens per bulk import request.
  batchSize: 500
`;

type InitConfigOptions = {
  type: string;
  output: string;
  force: boolean;
};

function printHelp() {
  console.log(`Usage: rownd-nodejs init-config --output <path> [options]

Options:
  --type <type>      Config template type. Only "bulk-migrate" is supported.
  -o, --output <path>  Destination path for the config file
  --force            Overwrite the destination if it already exists
  -h, --help         Show this help message`);
}

function parseArgs(): InitConfigOptions | undefined {
  const args = process.argv.slice(2);
  const options: InitConfigOptions = {
    type: "bulk-migrate",
    output: "",
    force: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      printHelp();
      return undefined;
    }

    if (arg === "--type") {
      const value = args[i + 1];
      if (!value) {
        throw new Error("Missing value for --type");
      }
      options.type = value;
      i += 1;
    } else if (arg === "--output" || arg === "-o") {
      const value = args[i + 1];
      if (!value) {
        throw new Error(`Missing value for ${arg}`);
      }
      options.output = value;
      i += 1;
    } else if (arg === "--force") {
      options.force = true;
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (options.type !== "bulk-migrate") {
    throw new Error('Only "bulk-migrate" config templates are supported.');
  }

  if (!options.output) {
    throw new Error("Missing required --output <path>");
  }

  return options;
}

async function fileExists(path: string) {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function run() {
  const options = parseArgs();
  if (!options) {
    return;
  }

  const outputPath = resolve(options.output);
  if (!options.force && (await fileExists(outputPath))) {
    throw new Error(
      `${outputPath} already exists. Use --force to overwrite it.`,
    );
  }

  await fs.mkdir(dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, BULK_MIGRATE_CONFIG_TEMPLATE, {
    encoding: "utf8",
    flag: options.force ? "w" : "wx",
    mode: 0o600,
  });

  console.log(`Wrote bulk migration config template to ${outputPath}`);
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

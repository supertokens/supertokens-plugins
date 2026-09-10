const { execFileSync } = require("node:child_process");
const { parseArgs } = require("node:util");

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      email: { type: "string" },
      tenant: { type: "string" },
      token: { type: "string" },
      profile: { type: "string", default: "st-admin" },
      region: { type: "string", default: "us-east-2" },
      environment: { type: "string", default: "production" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(
      "Usage: node scripts/diagnose.cjs --email <email> --tenant <tenantId> [--token <token>] [--profile st-admin] [--region us-east-2] [--environment production]",
    );
    return;
  }
  if (
    !values.email ||
    !values.tenant ||
    !/^[a-zA-Z0-9_-]+$/.test(values.tenant)
  ) {
    throw new Error("Supply --email and a valid --tenant.");
  }
  if (!["development", "production"].includes(values.environment)) {
    throw new Error("Environment must be development or production.");
  }

  let token = values.token;
  if (token === undefined) {
    const parameterName = `/managed-backend-api/${values.environment}/tenants/${values.tenant}/squadup-token`;
    let parameter;
    try {
      const output = execFileSync(
        "aws",
        [
          "ssm",
          "get-parameter",
          "--name",
          parameterName,
          "--with-decryption",
          "--region",
          values.region,
          "--profile",
          values.profile,
          "--query",
          "Parameter",
          "--output",
          "json",
          "--no-cli-pager",
        ],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 30_000,
        },
      );
      parameter = JSON.parse(output);
    } catch (error) {
      throw new Error(
        "Could not read SSM parameter. Check AWS CLI installation, profile login, parameter path, region, and SSM/KMS permissions.",
        { cause: error },
      );
    }
    if (
      parameter?.Type !== "SecureString" ||
      typeof parameter.Value !== "string" ||
      !parameter.Value.trim()
    ) {
      throw new Error(
        "SSM parameter must contain a nonempty SecureString token.",
      );
    }
    console.log(
      `Loaded parameter ${parameterName} from ${values.region}; token withheld.`,
    );
    token = parameter.Value;
  } else {
    if (!token.trim()) throw new Error("Token must not be empty.");
    console.log("Using supplied token; AWS lookup skipped and token withheld.");
  }

  const supertokensModule = require("supertokens-node");
  const supertokens = supertokensModule.default ?? supertokensModule;
  const { init } = require("../dist/index.js");
  const originalGetUser = supertokens.getUser;
  const originalFetch = globalThis.fetch;
  // Only session/email resolution is a local fixture. The token and SquadUp HTTP request are real.
  supertokens.getUser = async () => ({
    loginMethods: [
      {
        recipeId: "passwordless",
        email: values.email,
        tenantIds: [values.tenant],
      },
    ],
  });
  globalThis.fetch = async (input, options) => {
    const response = await originalFetch(input, {
      ...options,
      signal: AbortSignal.timeout(30_000),
    });
    console.log(`SquadUp HTTP status: ${response.status}`);
    return response;
  };

  try {
    const plugin = init({ apiKey: token, enableDebugLogs: true });
    const routes = plugin.routeHandlers({
      appInfo: { apiBasePath: { getAsStringDangerous: () => "/auth" } },
    });
    if (routes.status !== "OK")
      throw new Error("Plugin route initialization failed.");
    const route = routes.routeHandlers.find(
      (handler) => handler.path === "/auth/plugin/squadup/tickets",
    );
    if (!route) throw new Error("Plugin tickets route not found.");
    await route.handler(
      { getKeyValueFromQuery: () => undefined },
      {
        setStatusCode: (status) => {
          console.log(`Plugin HTTP status: ${status}`);
          if (status >= 400) process.exitCode = 1;
        },
        sendJSONResponse: (body) => {
          // Never print the response object: successful responses contain ticket credentials.
          console.log(
            `Plugin result: ${body.status === "OK" ? "OK" : "ERROR"}`,
          );
          if (body.status === "OK")
            console.log(`Event count: ${body.events.length}`);
        },
      },
      {
        getUserId: () => "local-diagnostic-user",
        getTenantId: () => values.tenant,
      },
      {},
    );
  } finally {
    supertokens.getUser = originalGetUser;
    globalThis.fetch = originalFetch;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

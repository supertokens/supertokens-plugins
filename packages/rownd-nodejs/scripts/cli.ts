import { spawn } from "node:child_process";
import { join } from "node:path";

const COMMANDS: Record<string, string> = {
  "profile": "adminCli.js",
  "profiles": "adminCli.js",
  "reconcile-user": "adminCli.js",
  "reconcile-csv": "adminCli.js",
  "init-config": "initConfig.js",
  "bulk-migrate": "bulkMigrate.js",
  "bulk-import-monitor": "bulkImportMonitor.js",
  "bulk-import-failures": "bulkImportFailures.js",
  "bulk-import-validate": "bulkImportValidate.js",
  "setup-core": "setupCoreInstance.js",
  "generate-plugin-config": "generateAppConfig.js",
};

function printHelp() {
  console.log(`Usage: rownd-nodejs <command> [options]

Commands:
  profiles                 Add, list, show or remove a local admin profile
  reconcile-user           Reconcile a live Rownd user with SuperTokens
  reconcile-csv            Reconcile Rownd IDs from a CSV file
  init-config              Write a bulk migration config template
  bulk-migrate             Stage Rownd users for SuperTokens bulk import
  bulk-import-monitor      Monitor staged user import progress
  bulk-import-failures     Export failed staged users
  bulk-import-validate     Validate that a bulk import completed
  setup-core               Provision SuperTokens infrastructure from Rownd OIDC clients
  generate-plugin-config   Generate Rownd plugin configuration from Rownd app config

Run a command with --help for command-specific options.`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  const script = COMMANDS[command];
  if (!script) {
    console.error("Unknown command; run with --help");
    printHelp();
    process.exitCode = 1;
    return;
  }

  const child = spawn(process.execPath, [join(__dirname, script),
    ...(["profile", "profiles", "reconcile-user", "reconcile-csv"].includes(command) ? [command] : []), ...args], {
    stdio: "inherit",
  });

  await new Promise<void>((resolve) => {
    child.on("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }

      process.exitCode = code ?? 1;
      resolve();
    });
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

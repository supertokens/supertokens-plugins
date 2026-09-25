import { spawn } from "node:child_process";
import { join } from "node:path";

const COMMANDS: Record<string, string> = {
  "init-config": "initConfig.js",
  "bulk-migrate": "bulkMigrate.js",
  "setup-core": "setupCoreInstance.js",
  "generate-plugin-config": "generateAppConfig.js",
};

function printHelp() {
  console.log(`Usage: rownd-nodejs <command> [options]

Commands:
  init-config              Write a bulk migration config template
  bulk-migrate             Stage Rownd users for SuperTokens bulk import
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
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exitCode = 1;
    return;
  }

  const child = spawn(process.execPath, [join(__dirname, script), ...args], {
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

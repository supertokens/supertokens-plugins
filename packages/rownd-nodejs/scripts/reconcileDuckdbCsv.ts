import { runAdmin } from "./admin";
import { CliValidationError } from "./cliError";

const args = process.argv.slice(2);
if (!args.includes("--help") && !args.some((arg) => arg === "--duckdb" || arg.startsWith("--duckdb="))) {
  console.error("--duckdb is required for snapshot reconciliation");
  process.exitCode = 1;
} else {
  runAdmin(["reconcile-csv", ...args]).then((code) => { process.exitCode = code; }).catch((error: unknown) => {
    console.error(error instanceof CliValidationError ? error.message : "Snapshot reconciliation failed. Check profile configuration and service availability.");
    process.exitCode = 1;
  });
}

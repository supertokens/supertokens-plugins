import { runAdmin } from "./admin";
import { CliValidationError } from "./cliError";

runAdmin(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error: unknown) => {
  console.error(error instanceof CliValidationError ? error.message : "Admin command failed. Check profile configuration and service availability.");
  process.exitCode = 1;
});

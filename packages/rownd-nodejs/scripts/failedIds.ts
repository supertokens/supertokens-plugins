import { open } from "node:fs/promises";
import { CliValidationError } from "./cliError";

export type ReconcileFailure = { status: string; error_code: string; error_message: string };

export async function createFailedIdsFile(path: string) {
  const file = await open(path, "wx", 0o600).catch(() => {
    throw new CliValidationError("Cannot create --failed-file; choose a new file in an existing writable directory");
  });
  try { await file.writeFile("rownd_user_id,status,error_code,error_message\n"); } catch {
    await file.close();
    throw new CliValidationError("Cannot write --failed-file");
  }
  let pending = Promise.resolve();
  return {
    append(id: string, failure: ReconcileFailure) {
      // A single write queue prevents concurrent completions from interleaving CSV records.
      pending = pending.then(async () => {
        const fields = [id, failure.status, failure.error_code, failure.error_message];
        await file.writeFile(`${fields.map((field) => `"${field.replace(/"/g, "\"\"")}"`).join(",")}\n`);
      });
      return pending.catch(() => { throw new CliValidationError("Cannot write --failed-file; batch stopped scheduling new users"); });
    },
    async close() { await file.close(); },
  };
}

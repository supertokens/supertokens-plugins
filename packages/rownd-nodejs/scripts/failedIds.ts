import { open } from "node:fs/promises";
import { CliValidationError } from "./cliError";

export async function createFailedIdsFile(path: string) {
  const file = await open(path, "wx", 0o600).catch(() => {
    throw new CliValidationError("Cannot create --failed-file; choose a new file in an existing writable directory");
  });
  try { await file.writeFile("rownd_user_id\n"); } catch {
    await file.close();
    throw new CliValidationError("Cannot write --failed-file");
  }
  let pending = Promise.resolve();
  return {
    append(id: string) {
      // A single write queue prevents concurrent completions from interleaving CSV records.
      pending = pending.then(async () => {
        await file.writeFile(`"${id.replace(/"/g, "\"\"")}"\n`);
      });
      return pending.catch(() => { throw new CliValidationError("Cannot write --failed-file; batch stopped scheduling new users"); });
    },
    async close() { await file.close(); },
  };
}

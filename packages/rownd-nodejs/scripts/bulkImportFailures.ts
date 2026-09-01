import * as fs from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

import { getAllStagedUsers } from "./bulkImportApi";
import {
  assertManifestMatchesConfig,
  defaultManifestPath,
  hashIdentifier,
  loadManifest,
} from "./bulkImportManifest";
import { parseBulkImportCliArgs } from "./bulkImportCliArgs";
import { formatZodError, hasHelpArg, loadConfig } from "./scriptUtils";

function printHelp() {
  console.log(`Usage: rownd-nodejs bulk-import-failures --config <path> --output <path> [options]

Options:
  -c, --config <path>  Path to the bulk migration config file
  --manifest <path>    Manifest path (defaults to <checkpoint>.manifest.json)
  --output <path>      Write failed users as NDJSON
  -h, --help           Show this help message`);
}

export function sanitizeImportError(message: string) {
  return message
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<email>")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "<phone>");
}

export async function collectBulkImportFailures(input: {
  configFile: string;
  manifestFile?: string;
}) {
  const config = await loadConfig(input.configFile);
  const manifest = await loadManifest(
    input.manifestFile ?? defaultManifestPath(config.checkpoint.file),
  );
  assertManifestMatchesConfig(manifest, config);
  const runIds = new Set(manifest.stagedExternalUserIdHashes);
  const failedUsers = await getAllStagedUsers(config, "FAILED");

  return failedUsers.flatMap((user) => {
    const externalUserId = user.raw_data.externalUserId;
    if (typeof externalUserId !== "string") return [];
    const externalUserIdHash = hashIdentifier(externalUserId);
    if (!runIds.has(externalUserIdHash)) return [];

    return [
      {
        stagedRecordId: user.id,
        externalUserIdHash,
        errors: user.error_msg.map(sanitizeImportError),
        createdAt: user.created_at,
        updatedAt: user.updated_at,
      },
    ];
  });
}

export async function runCli() {
  const args = process.argv.slice(2);
  if (hasHelpArg(args)) {
    printHelp();
    return;
  }
  const parsed = parseBulkImportCliArgs(args, {
    valueFlags: ["--config", "-c", "--manifest", "--output"],
  });
  const outputFile = parsed.requiredPath("--output");
  const failures = await collectBulkImportFailures({
    configFile: parsed.path("--config") ?? parsed.requiredPath("-c"),
    manifestFile: parsed.path("--manifest"),
  });
  await fs.mkdir(dirname(outputFile), { recursive: true });
  await fs.writeFile(
    outputFile,
    failures.map((failure) => JSON.stringify(failure)).join("\n") +
      (failures.length ? "\n" : ""),
    { encoding: "utf8", mode: 0o600 },
  );
  console.log(`Wrote ${failures.length} failed imports to ${outputFile}`);
  process.exitCode = failures.length > 0 ? 2 : 0;
}

if (require.main === module) {
  runCli().catch((error: unknown) => {
    console.error(
      error instanceof z.ZodError
        ? formatZodError(error)
        : error instanceof Error
          ? error.message
          : "Failed to retrieve bulk import failures",
    );
    process.exitCode = 1;
  });
}

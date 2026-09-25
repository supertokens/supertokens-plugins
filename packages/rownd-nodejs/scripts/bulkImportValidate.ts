import * as fs from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

import { getBulkImportProgress } from "./bulkImportApi";
import {
  assertManifestMatchesConfig,
  defaultManifestPath,
  loadManifest,
} from "./bulkImportManifest";
import { parseBulkImportCliArgs } from "./bulkImportCliArgs";
import { formatZodError, hasHelpArg, loadConfig } from "./scriptUtils";

function printHelp() {
  console.log(`Usage: rownd-nodejs bulk-import-validate --config <path> --output <path> [options]

Options:
  -c, --config <path>  Path to the bulk migration config file
  --manifest <path>    Manifest path (defaults to <checkpoint>.manifest.json)
  --output <path>      Write the final JSON validation report
  -h, --help           Show this help message`);
}

export function buildValidationReport(input: {
  manifest: Awaited<ReturnType<typeof loadManifest>>;
  progress: Awaited<ReturnType<typeof getBulkImportProgress>>;
}) {
  const staged = input.manifest.stagedExternalUserIdHashes.length;
  const mappingFailures =
    input.manifest.mappingFailureExternalUserIdHashes.length;
  const stagedIds = new Set(input.manifest.stagedExternalUserIdHashes);
  const failedIds = new Set(input.manifest.mappingFailureExternalUserIdHashes);
  const inferredImported = Math.max(staged - input.progress.staged, 0);
  const checks = {
    stagingFinished: input.manifest.completedStagingAt !== undefined,
    noMappingFailures: mappingFailures === 0,
    noStagedUsersRemaining:
      input.progress.staged === 0 &&
      input.progress.new === 0 &&
      input.progress.processing === 0 &&
      input.progress.failed === 0,
    allSourceUsersAccountedFor:
      input.manifest.sourceUsersRead === stagedIds.size + failedIds.size,
    resultSetsAreDisjoint: [...failedIds].every((id) => !stagedIds.has(id)),
  };

  return {
    generatedAt: new Date().toISOString(),
    runId: input.manifest.runId,
    sourceUsersRead: input.manifest.sourceUsersRead,
    successfullyStaged: staged,
    mappingFailures,
    ...input.progress,
    inferredImported,
    checks,
    status: Object.values(checks).every(Boolean) ? "COMPLETE" : "INCOMPLETE",
  };
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
  const config = await loadConfig(
    parsed.path("--config") ?? parsed.requiredPath("-c"),
  );
  const manifest = await loadManifest(
    parsed.path("--manifest") ?? defaultManifestPath(config.checkpoint.file),
  );
  assertManifestMatchesConfig(manifest, config);
  const report = buildValidationReport({
    manifest,
    progress: await getBulkImportProgress(config),
  });
  const outputFile = parsed.requiredPath("--output");
  await fs.mkdir(dirname(outputFile), { recursive: true });
  await fs.writeFile(outputFile, JSON.stringify(report, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.status === "COMPLETE" ? 0 : 2;
}

if (require.main === module) {
  runCli().catch((error: unknown) => {
    console.error(
      error instanceof z.ZodError
        ? formatZodError(error)
        : error instanceof Error
          ? error.message
          : "Bulk import validation failed",
    );
    process.exitCode = 1;
  });
}

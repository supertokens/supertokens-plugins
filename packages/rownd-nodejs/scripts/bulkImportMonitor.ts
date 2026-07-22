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

type MonitorOptions = {
  configFile: string;
  manifestFile?: string;
  outputFile?: string;
  intervalMs: number;
  stalledAfterMs: number;
  wait: boolean;
};

function printHelp() {
  console.log(`Usage: rownd-nodejs bulk-import-monitor --config <path> [options]

Options:
  -c, --config <path>       Path to the bulk migration config file
  --manifest <path>         Manifest path (defaults to <checkpoint>.manifest.json)
  --output <path>           Append structured progress events as NDJSON
  --interval <seconds>      Poll interval when using --wait (default: 30)
  --stalled-after <seconds> Fail after no progress for this duration (default: 900)
  --wait                    Poll until complete, failed, or stalled
  -h, --help                Show this help message`);
}

function positiveNumber(value: string | undefined, flag: string) {
  const parsed = Number(value);
  if (!value || !Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive number.`);
  }
  return parsed;
}

function parseArgs(args: string[]): MonitorOptions {
  const parsed = parseBulkImportCliArgs(args, {
    valueFlags: [
      "--config",
      "-c",
      "--manifest",
      "--output",
      "--interval",
      "--stalled-after",
    ],
    booleanFlags: ["--wait"],
  });
  const options: MonitorOptions = {
    configFile: parsed.path("--config") ?? parsed.requiredPath("-c"),
    intervalMs: 30_000,
    stalledAfterMs: 900_000,
    wait: parsed.has("--wait"),
  };
  options.manifestFile = parsed.path("--manifest");
  options.outputFile = parsed.path("--output");
  if (parsed.value("--interval")) {
    options.intervalMs =
      positiveNumber(parsed.value("--interval"), "--interval") * 1000;
  }
  if (parsed.value("--stalled-after")) {
    options.stalledAfterMs =
      positiveNumber(parsed.value("--stalled-after"), "--stalled-after") * 1000;
  }

  return options;
}

export function buildProgressSnapshot(
  progress: Awaited<ReturnType<typeof getBulkImportProgress>>,
  successfullyStaged: number,
  stagingFinished = true,
) {
  return {
    timestamp: new Date().toISOString(),
    ...progress,
    successfullyStaged,
    inferredImported: Math.max(successfullyStaged - progress.staged, 0),
    stagingFinished,
  };
}

function isOnlyFailedRemaining(
  snapshot: ReturnType<typeof buildProgressSnapshot>,
) {
  return (
    snapshot.stagingFinished &&
    snapshot.failed > 0 &&
    snapshot.new === 0 &&
    snapshot.processing === 0
  );
}

async function recordSnapshot(
  snapshot: ReturnType<typeof buildProgressSnapshot>,
  outputFile?: string,
) {
  console.log(JSON.stringify(snapshot));
  if (!outputFile) return;
  await fs.mkdir(dirname(outputFile), { recursive: true });
  await fs.appendFile(outputFile, `${JSON.stringify(snapshot)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function monitorBulkImport(options: MonitorOptions) {
  const config = await loadConfig(options.configFile);
  const manifestFile =
    options.manifestFile ?? defaultManifestPath(config.checkpoint.file);
  let lastState: string | undefined;
  let lastProgressAt = Date.now();

  for (;;) {
    const manifest = await loadManifest(manifestFile);
    assertManifestMatchesConfig(manifest, config);
    const snapshot = buildProgressSnapshot(
      await getBulkImportProgress(config),
      manifest.stagedExternalUserIdHashes.length,
      manifest.completedStagingAt !== undefined,
    );
    await recordSnapshot(snapshot, options.outputFile);

    if (
      snapshot.staged === 0 &&
      snapshot.new === 0 &&
      snapshot.processing === 0 &&
      snapshot.failed === 0 &&
      snapshot.stagingFinished
    ) {
      return 0;
    }
    if (isOnlyFailedRemaining(snapshot)) return 2;
    if (!options.wait) return snapshot.failed > 0 ? 2 : 0;

    const currentState = JSON.stringify({
      staged: snapshot.staged,
      new: snapshot.new,
      processing: snapshot.processing,
      failed: snapshot.failed,
      successfullyStaged: snapshot.successfullyStaged,
      stagingFinished: snapshot.stagingFinished,
    });
    if (lastState === undefined || currentState !== lastState) {
      lastProgressAt = Date.now();
    } else if (Date.now() - lastProgressAt >= options.stalledAfterMs) {
      return 3;
    }
    lastState = currentState;
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
  }
}

export async function runCli() {
  const args = process.argv.slice(2);
  if (hasHelpArg(args)) {
    printHelp();
    return;
  }
  process.exitCode = await monitorBulkImport(parseArgs(args));
}

if (require.main === module) {
  runCli().catch((error: unknown) => {
    console.error(
      error instanceof z.ZodError
        ? formatZodError(error)
        : error instanceof Error
          ? error.message
          : "Bulk import monitoring failed",
    );
    process.exitCode = 1;
  });
}

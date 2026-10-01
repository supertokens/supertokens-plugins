import * as fs from "node:fs/promises";
import { z } from "zod";

import { type RowndUser, type SuperTokensUserImport } from "../src/types";
import { mapRowndUserToSuperTokens } from "../src/rownd-compatibility";
import {
  loadConfig,
  formatZodError,
  fetchRowndUsersPage,
  fetchWithRetry,
  hasHelpArg,
  parseRequiredConfigArg,
  type BulkMigrateConfig,
  type RetryConfig,
  type SuperTokensTargetConfig,
} from "./scriptUtils";

function printHelp() {
  console.log(`Usage: rownd-nodejs bulk-migrate --config <path>

Options:
  -c, --config <path>  Path to the bulk migration config file
  -h, --help           Show this help message`);
}

type Checkpoint = {
  cursor?: string;
  importedCount?: number;
  updatedAt: string;
};

type FailedMapping = {
  user: RowndUser;
  error: string;
};

const CheckpointSchema = z.object({
  cursor: z.string().optional(),
  importedCount: z.number().int().nonnegative().optional(),
  updatedAt: z.string(),
});

async function loadCheckpoint(checkpointFile: string) {
  try {
    const checkpoint = await fs.readFile(checkpointFile, "utf8");
    return CheckpointSchema.parse(JSON.parse(checkpoint));
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function saveCheckpoint(checkpointFile: string, checkpoint: Checkpoint) {
  const tempFile = `${checkpointFile}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(checkpoint, null, 2), "utf8");
  await fs.rename(tempFile, checkpointFile);
}

function getFailedMappingsFilePath(checkpointFile: string) {
  return `${checkpointFile}.failed-mappings.json`;
}

async function loadFailedMappings(filePath: string): Promise<FailedMapping[]> {
  try {
    const contents = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(contents) as unknown;

    if (!Array.isArray(parsed)) {
      throw new Error("Failed mappings file must contain a JSON array.");
    }

    return parsed as FailedMapping[];
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function appendFailedMappings(
  filePath: string,
  failedMappings: FailedMapping[],
) {
  if (failedMappings.length === 0) {
    return;
  }

  const existingMappings = await loadFailedMappings(filePath);
  const tempFile = `${filePath}.tmp`;
  await fs.writeFile(
    tempFile,
    JSON.stringify([...existingMappings, ...failedMappings], null, 2),
    "utf8",
  );
  await fs.rename(tempFile, filePath);
}

export async function stageUsersForImport(config: {
  users: SuperTokensUserImport[];
  supertokens: Pick<SuperTokensTargetConfig, "connectionURI" | "apiKey">;
  retry: RetryConfig;
}) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (config.supertokens.apiKey) {
    headers["api-key"] = config.supertokens.apiKey;
  }

  const response = await fetchWithRetry({
    url: new URL(
      "/bulk-import/users",
      config.supertokens.connectionURI,
    ).toString(),
    requestInit: {
      method: "POST",
      headers,
      body: JSON.stringify({ users: config.users }),
    },
    retryConfig: config.retry,
    operation: "Importing users into SuperTokens",
  });

  if (!response.ok) {
    throw new Error(
      `SuperTokens bulk import error: ${response.status} ${await response.text()}`,
    );
  }
}

async function importUsersBatch(
  config: BulkMigrateConfig,
  users: Array<{ rowndUserId: string; user: SuperTokensUserImport }>,
  totalImportedBeforeBatch: number,
) {
  for (
    let index = 0;
    index < users.length;
    index += config.supertokens.batchSize
  ) {
    const batch = users.slice(index, index + config.supertokens.batchSize);
    console.log(
      `Importing batch ${Math.floor(totalImportedBeforeBatch / config.supertokens.batchSize) + 1} (${batch.length} users)`,
    );
    await stageUsersForImport({
      users: batch.map((entry) => entry.user),
      supertokens: config.supertokens,
      retry: config.retry,
    });
  }
}

export async function migrateRowndUsersToSuperTokens(
  config: BulkMigrateConfig,
) {
  const checkpoint = config.checkpoint.resume
    ? await loadCheckpoint(config.checkpoint.file)
    : null;
  const failedMappingsFile = getFailedMappingsFilePath(config.checkpoint.file);
  let cursor = checkpoint?.cursor;
  let totalProcessed = 0;
  let totalImported = checkpoint?.importedCount ?? 0;
  let totalSkipped = 0;

  if (config.checkpoint.resume) {
    console.log(
      checkpoint
        ? `Resuming migration from cursor ${checkpoint.cursor ?? "<start>"}`
        : "No checkpoint found. Starting a fresh migration.",
    );
  }

  while (totalProcessed < config.limit) {
    const remaining = Number.isFinite(config.limit)
      ? Math.max(config.limit - totalProcessed, 0)
      : config.rownd.pageSize;
    const requestedPageSize = Number.isFinite(config.limit)
      ? Math.min(config.rownd.pageSize, remaining)
      : config.rownd.pageSize;

    if (requestedPageSize === 0) {
      break;
    }

    console.log(
      `Fetching page ${Math.floor(totalProcessed / config.rownd.pageSize) + 1}`,
    );
    const pageUsers = await fetchRowndUsersPage(
      config,
      cursor,
      requestedPageSize,
    );

    if (pageUsers.length === 0) {
      break;
    }

    const mappedUsers: Array<{
      rowndUserId: string;
      user: SuperTokensUserImport;
    }> = [];
    const failedMappings: FailedMapping[] = [];

    for (const { rowndUser, rowndUserId } of pageUsers) {
      try {
        mappedUsers.push({
          rowndUserId,
          user: mapRowndUserToSuperTokens(rowndUser),
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown mapping error";
        failedMappings.push({
          user: rowndUser,
          error: errorMessage,
        });
        console.warn(
          `Skipping Rownd user ${rowndUserId}: ${errorMessage}. Saved to ${failedMappingsFile}`,
        );
      }
    }

    await appendFailedMappings(failedMappingsFile, failedMappings);
    totalSkipped += failedMappings.length;

    await importUsersBatch(config, mappedUsers, totalImported);

    totalProcessed += pageUsers.length;
    totalImported += mappedUsers.length;
    cursor = pageUsers[pageUsers.length - 1]?.rowndUserId;

    await saveCheckpoint(config.checkpoint.file, {
      cursor,
      importedCount: totalImported,
      updatedAt: new Date().toISOString(),
    });

    console.log(`Processed ${totalProcessed} users so far`);
    console.log(`Imported ${totalImported} users so far`);

    if (pageUsers.length < requestedPageSize) {
      break;
    }
  }

  return {
    totalProcessed,
    totalImported,
    totalSkipped,
    cursor,
  };
}

export async function runCli() {
  const args = process.argv.slice(2);
  if (hasHelpArg(args)) {
    printHelp();
    return;
  }

  const config = await loadConfig(parseRequiredConfigArg(args));
  const result = await migrateRowndUsersToSuperTokens(config);
  console.log(`Migrated ${result.totalImported} users`);
  if (result.totalSkipped > 0) {
    console.warn(
      `Skipped ${result.totalSkipped} users. Details saved to ${getFailedMappingsFilePath(config.checkpoint.file)}`,
    );
  }
}

if (require.main === module) {
  runCli().catch((error: unknown) => {
    if (error instanceof z.ZodError) {
      console.error(formatZodError(error));
    } else {
      console.error(
        error instanceof Error ? error.message : "Bulk migration failed",
      );
    }
    process.exitCode = 1;
  });
}

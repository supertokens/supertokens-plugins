import fs from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { type RowndUser, type SuperTokensUserImport } from "../src/types";
import { mapRowndUserToSuperTokens } from "../src/pluginImplementation";

const DEFAULT_CONFIG_FILE_NAME = "config.yaml";
const SCRIPT_DIR = __dirname;
const DEFAULT_CONFIG_FILE_PATH = resolve(SCRIPT_DIR, DEFAULT_CONFIG_FILE_NAME);

export type RetryConfig = {
  maxAttempts: number;
  initialDelayMs: number;
};

export type CheckpointConfig = {
  file: string;
  resume: boolean;
};

export type RowndSourceConfig = {
  appId: string;
  appKey: string;
  appSecret: string;
  pageSize: number;
};

export type SuperTokensTargetConfig = {
  connectionURI: string;
  apiKey?: string;
  batchSize: number;
};

export type BulkMigrateConfig = {
  limit: number;
  checkpoint: CheckpointConfig;
  retry: RetryConfig;
  rownd: RowndSourceConfig;
  supertokens: SuperTokensTargetConfig;
};

type Checkpoint = {
  cursor?: string;
  importedCount?: number;
  updatedAt: string;
};

const ConfigSchema = z.object({
  limit: z.preprocess(
    (value) => (value === undefined ? Number.POSITIVE_INFINITY : value),
    z.union([z.literal(Number.POSITIVE_INFINITY), z.number().int().positive()]),
  ),
  checkpoint: z.object({
    file: z.string(),
    resume: z.boolean().default(false),
  }),
  retry: z.object({
    maxAttempts: z.number().int().positive(),
    initialDelayMs: z.number().int().positive(),
  }),
  rownd: z.object({
    appId: z.string(),
    appKey: z.string(),
    appSecret: z.string(),
    pageSize: z.number().int().positive(),
  }),
  supertokens: z.object({
    connectionURI: z.string(),
    apiKey: z.string().optional(),
    batchSize: z.number().int().positive(),
  }),
});

const RowndUserSchema = z.looseObject({
  state: z.string().optional(),
  auth_level: z.string().optional(),
  data: z.looseObject({
    user_id: z.string(),
    email: z.string().optional(),
    phone_number: z.string().optional(),
    google_id: z.string().optional(),
    apple_id: z.string().optional(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
  }),
  verified_data: z.record(z.string(), z.unknown()).optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  groups: z.array(z.string()).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

const RowndUsersPageSchema = z
  .object({
    results: z.array(RowndUserSchema).optional(),
    data: z.array(RowndUserSchema).optional(),
  })
  .superRefine((value, context) => {
    if (!value.results && !value.data) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Rownd API response is missing a results/data array.",
      });
    }
  });

const CheckpointSchema = z.object({
  cursor: z.string().optional(),
  importedCount: z.number().int().nonnegative().optional(),
  updatedAt: z.string(),
});

function formatIssuePath(path: Array<string | number>) {
  if (path.length === 0) {
    return "<root>";
  }

  return path
    .map((segment, index) => {
      if (typeof segment === "number") {
        return `[${segment}]`;
      }

      return index === 0 ? segment : `.${segment}`;
    })
    .join("");
}

export function formatZodError(error: z.ZodError) {
  return error.issues
    .map(
      (issue) =>
        `${formatIssuePath(issue.path.filter((segment): segment is string | number => typeof segment === "string" || typeof segment === "number"))}: ${issue.message}`,
    )
    .join("\n");
}

export function parseConfig(
  rawConfig: unknown,
  configDir: string = SCRIPT_DIR,
): BulkMigrateConfig {
  const parsed = ConfigSchema.parse(rawConfig);
  const checkpointFile = isAbsolute(parsed.checkpoint.file)
    ? parsed.checkpoint.file
    : resolve(configDir, parsed.checkpoint.file);

  return {
    limit: parsed.limit,
    checkpoint: {
      file: checkpointFile,
      resume: parsed.checkpoint.resume,
    },
    retry: parsed.retry,
    rownd: parsed.rownd,
    supertokens: parsed.supertokens,
  };
}

export async function loadConfig(
  configFilePath: string = DEFAULT_CONFIG_FILE_PATH,
) {
  const configFile = await fs.readFile(configFilePath, "utf8");

  return parseConfig(parseYaml(configFile), dirname(configFilePath));
}

function isRetryableStatus(status: number) {
  return status === 429 || status >= 500;
}

async function fetchWithRetry({
  url,
  requestInit,
  retryConfig,
  operation,
}: {
  url: string;
  requestInit?: RequestInit;
  retryConfig: RetryConfig;
  operation: string;
}) {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, requestInit);
      if (
        response.ok ||
        !isRetryableStatus(response.status) ||
        attempt === retryConfig.maxAttempts
      ) {
        return response;
      }

      const responseText = await response.text();
      lastError = new Error(
        `${operation} failed with ${response.status}${responseText ? ` ${responseText}` : ""}`,
      );
    } catch (error) {
      if (attempt === retryConfig.maxAttempts) {
        throw error;
      }

      lastError =
        error instanceof Error ? error : new Error(`${operation} failed`);
    }

    const delayMs = Math.round(
      retryConfig.initialDelayMs * 2 ** (attempt - 1) * (1 + Math.random() * 0.2),
    );
    console.log(
      `${operation} attempt ${attempt} failed. Retrying in ${delayMs}ms.`,
    );

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw lastError ?? new Error(`${operation} failed`);
}

function parseRowndUser(rawUser: unknown) {
  const parsed = RowndUserSchema.parse(rawUser);
  const rowndUserId = (parsed.data.user_id ||
    parsed.user_id ||
    parsed.app_user_id) as string | undefined;

  if (!rowndUserId) {
    throw new Error(
      "Rownd user is missing a stable user id. Cannot continue pagination safely.",
    );
  }

  const rowndUser: RowndUser = {
    state: parsed.state ?? "",
    auth_level: parsed.auth_level ?? "",
    data: parsed.data as RowndUser["data"],
    verified_data: (parsed.verified_data ?? {}) as RowndUser["verified_data"],
    attributes: parsed.attributes as RowndUser["attributes"],
    groups: parsed.groups,
    meta: parsed.meta as RowndUser["meta"],
  };

  return { rowndUser, rowndUserId };
}

async function fetchRowndUsersPage(
  config: BulkMigrateConfig,
  cursor?: string,
  pageSize?: number,
) {
  const url = new URL(
    `/applications/${config.rownd.appId}/users/data`,
    "https://api.rownd.io",
  );

  if (cursor) {
    url.searchParams.set("after", cursor);
  }

  url.searchParams.set("include_duplicates", "true");
  url.searchParams.set("page_size", String(pageSize ?? config.rownd.pageSize));

  const response = await fetchWithRetry({
    url: url.toString(),
    requestInit: {
      headers: {
        "x-rownd-app-key": config.rownd.appKey,
        "x-rownd-app-secret": config.rownd.appSecret,
      },
    },
    retryConfig: config.retry,
    operation: "Fetching Rownd users",
  });

  if (!response.ok) {
    throw new Error(
      `Rownd API error: ${response.status} ${await response.text()}`,
    );
  }

  const page = RowndUsersPageSchema.parse(await response.json());
  return (page.results ?? page.data ?? []).map(parseRowndUser);
}

async function loadCheckpoint(checkpointFile: string) {
  try {
    const checkpoint = await fs.readFile(checkpointFile, "utf8");
    return CheckpointSchema.parse(JSON.parse(checkpoint));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
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
  let cursor = checkpoint?.cursor;
  let totalProcessed = 0;
  let totalImported = checkpoint?.importedCount ?? 0;

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

    const mappedUsers = pageUsers.map(({ rowndUser, rowndUserId }) => ({
      rowndUserId,
      user: mapRowndUserToSuperTokens(rowndUser),
    }));

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
    cursor,
  };
}

export async function runCli() {
  const result = await migrateRowndUsersToSuperTokens(await loadConfig());
  console.log(`Migrated ${result.totalImported} users`);
}

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

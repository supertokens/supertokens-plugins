import { z } from "zod";

import {
  fetchWithRetry,
  type RetryConfig,
  type SuperTokensTargetConfig,
} from "./scriptUtils";

export const BULK_IMPORT_STATUSES = ["NEW", "PROCESSING", "FAILED"] as const;
export type BulkImportStatus = (typeof BULK_IMPORT_STATUSES)[number];

type CoreConfig = {
  supertokens: Pick<SuperTokensTargetConfig, "connectionURI" | "apiKey">;
  retry: RetryConfig;
};

const CountResponseSchema = z.object({
  status: z.literal("OK"),
  count: z.coerce.number().int().nonnegative(),
});

const StagedUserSchema = z.object({
  id: z.string(),
  raw_data: z.record(z.string(), z.unknown()),
  status: z.enum(BULK_IMPORT_STATUSES),
  error_msg: z.array(z.string()).default([]),
  created_at: z.string(),
  updated_at: z.string(),
});

const StagedUsersResponseSchema = z.object({
  users: z.array(StagedUserSchema),
  nextPaginationToken: z.string().nullish(),
});

export type StagedBulkImportUser = z.infer<typeof StagedUserSchema>;

function buildHeaders(apiKey?: string) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
  };
  if (apiKey) headers["api-key"] = apiKey;
  return headers;
}

async function getJson(config: CoreConfig, url: URL, operation: string) {
  const response = await fetchWithRetry({
    url: url.toString(),
    requestInit: { headers: buildHeaders(config.supertokens.apiKey) },
    retryConfig: config.retry,
    operation,
  });
  if (!response.ok) {
    throw new Error(`${operation} failed with status ${response.status}`);
  }
  return response.json();
}

export async function countStagedUsers(
  config: CoreConfig,
  status?: BulkImportStatus,
) {
  const url = new URL(
    "/bulk-import/users/count",
    config.supertokens.connectionURI,
  );
  if (status) url.searchParams.set("status", status);

  const body = await getJson(
    config,
    url,
    `Counting ${status ?? "all"} staged users`,
  );
  return CountResponseSchema.parse(body).count;
}

export async function getStagedUsersPage(
  config: CoreConfig,
  options: {
    status?: BulkImportStatus;
    limit?: number;
    paginationToken?: string;
  } = {},
) {
  const url = new URL("/bulk-import/users", config.supertokens.connectionURI);
  if (options.status) url.searchParams.set("status", options.status);
  url.searchParams.set("limit", String(options.limit ?? 100));
  if (options.paginationToken) {
    url.searchParams.set("paginationToken", options.paginationToken);
  }

  const body = await getJson(
    config,
    url,
    `Getting ${options.status ?? "all"} staged users`,
  );
  return StagedUsersResponseSchema.parse(body);
}

export async function getAllStagedUsers(
  config: CoreConfig,
  status?: BulkImportStatus,
) {
  const users: StagedBulkImportUser[] = [];
  let paginationToken: string | undefined;

  do {
    const page = await getStagedUsersPage(config, {
      status,
      limit: 100,
      paginationToken,
    });
    users.push(...page.users);
    paginationToken = page.nextPaginationToken ?? undefined;
  } while (paginationToken);

  return users;
}

export async function getBulkImportProgress(config: CoreConfig) {
  const [newUsers, processing, failed] = await Promise.all([
    countStagedUsers(config, "NEW"),
    countStagedUsers(config, "PROCESSING"),
    countStagedUsers(config, "FAILED"),
  ]);
  const staged = await countStagedUsers(config);

  return { staged, new: newUsers, processing, failed };
}

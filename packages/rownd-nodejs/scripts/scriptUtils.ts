import * as fs from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { type RowndUser } from "../src/types";

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

export type ThirdPartyProviderConfig = {
  thirdPartyId: string;
  name?: string;
  clients: {
    clientType?: string;
    clientId: string;
    clientSecret?: string;
    scope?: string[];
  }[];
};

export type BulkMigrateConfig = {
  limit: number;
  checkpoint: CheckpointConfig;
  retry: RetryConfig;
  rownd: RowndSourceConfig;
  supertokens: SuperTokensTargetConfig;
  thirdPartyProviders?: ThirdPartyProviderConfig[];
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
  thirdPartyProviders: z
    .array(
      z.object({
        thirdPartyId: z.string(),
        name: z.string().optional(),
        clients: z.array(
          z.object({
            clientType: z.string().optional(),
            clientId: z.string(),
            clientSecret: z.string().optional(),
            scope: z.array(z.string()).optional(),
          }),
        ),
      }),
    )
    .optional(),
});

const RowndUserRecordSchema = z.looseObject({
  user_id: z.string().optional(),
  rownd_user: z.string().optional(),
  subject: z.string().optional(),
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
  verified_data: z.record(z.string(), z.unknown()).default({}),
  attributes: z.record(z.string(), z.array(z.string())).optional(),
  groups: z.array(z.unknown()).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
  connection_map: z.record(z.string(), z.unknown()).optional(),
});

const RowndUserListItemSchema = z.object({
  data: RowndUserRecordSchema,
});

const RowndUsersPageSchema = z
  .object({
    results: z.array(RowndUserRecordSchema).optional(),
    data: z.array(RowndUserListItemSchema).optional(),
    total_results: z.number().optional(),
  })
  .superRefine((value, context) => {
    if (!value.results && !value.data) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Rownd API response is missing a results/data array.",
      });
    }
  });

type RowndUserRecord = z.infer<typeof RowndUserRecordSchema>;

export function formatIssuePath(path: Array<string | number>) {
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
    thirdPartyProviders: parsed.thirdPartyProviders,
  };
}

export async function loadConfig(
  configFilePath: string = DEFAULT_CONFIG_FILE_PATH,
) {
  const configFile = await fs.readFile(configFilePath, "utf8");

  return parseConfig(parseYaml(configFile), dirname(configFilePath));
}

function parseRowndUser(parsed: RowndUserRecord) {
  const rowndUserId = parsed.data.user_id;

  const rowndUser: RowndUser = {
    state: parsed.state ?? "",
    auth_level: parsed.auth_level ?? "",
    data: {
      ...parsed.data,
      user_id: rowndUserId,
    },
    verified_data: (parsed.verified_data ?? {}) as RowndUser["verified_data"],
    attributes: parsed.attributes as RowndUser["attributes"],
    groups: parsed.groups,
    meta: parsed.meta as RowndUser["meta"],
  };

  return { rowndUser, rowndUserId };
}

export async function fetchRowndUsersPage(
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
  const users = page.data?.map((entry) => entry.data) ?? page.results ?? [];
  return users.map(parseRowndUser);
}

function isRetryableStatus(status: number) {
  return status === 429 || status >= 500;
}

export async function fetchWithRetry({
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
      retryConfig.initialDelayMs *
        2 ** (attempt - 1) *
        (1 + Math.random() * 0.2),
    );
    console.log(
      `${operation} attempt ${attempt} failed. Retrying in ${delayMs}ms.`,
    );

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw lastError ?? new Error(`${operation} failed`);
}

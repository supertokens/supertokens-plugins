type CoreInstanceConfig = {
  label: string;
  connectionURI: string;
  apiKey?: string;
};

type UsersResponse = {
  status: string;
  users: Array<{
    id: string;
  }>;
  nextPaginationToken?: string;
};

type UserCountResponse = {
  status?: string;
  count: number | string;
};

const BATCH_SIZE = 500;

const SOURCE_CORE: CoreInstanceConfig = {
  label: "source",
  connectionURI: "<SOURCE_CONNECTION_URI>",
  apiKey: "<SOURCE_API_KEY>",
};

const TARGET_CORE: CoreInstanceConfig = {
  label: "target",
  connectionURI: "<TARGET_CONNECTION_URI>",
  apiKey: "<TARGET_API_KEY>",
};

async function fetchUserCount(
  core: CoreInstanceConfig,
): Promise<number | undefined> {
  const url = new URL("/public/users/count", core.connectionURI);
  url.searchParams.set("includeAllTenants", "true");

  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: core.apiKey ? { "api-key": core.apiKey } : undefined,
    });

    if (!response.ok) {
      return undefined;
    }

    const data = (await response.json()) as UserCountResponse;
    return Number(data.count);
  } catch {
    return undefined;
  }
}

async function fetchAllUserIds(
  core: CoreInstanceConfig,
  batchSize: number,
): Promise<Set<string>> {
  const userIds = new Set<string>();
  let paginationToken: string | undefined;

  while (true) {
    const url = new URL("/users", core.connectionURI);
    url.searchParams.set("limit", String(batchSize));

    if (paginationToken) {
      url.searchParams.set("paginationToken", paginationToken);
    }

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: core.apiKey ? { "api-key": core.apiKey } : undefined,
    });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch users from ${core.label}: ${response.status} ${await response.text()}`,
      );
    }

    const data = (await response.json()) as UsersResponse;

    console.log(data);
    if (data.status !== "OK") {
      throw new Error(`Unexpected users response from ${core.label}`);
    }

    for (const user of data.users) {
      userIds.add(user.id);
    }

    console.log(`Fetched ${userIds.size} users from ${core.label}...`);

    if (!data.nextPaginationToken || data.users.length === 0) {
      return userIds;
    }

    paginationToken = data.nextPaginationToken;
  }
}

function getMissingUserIds(from: Set<string>, other: Set<string>): string[] {
  return Array.from(from)
    .filter((userId) => !other.has(userId))
    .sort();
}

function printUserIdSection(title: string, userIds: string[]) {
  console.log(`\n${title} (${userIds.length})`);

  if (userIds.length === 0) {
    console.log("  none");
    return;
  }

  for (const userId of userIds) {
    console.log(`  ${userId}`);
  }
}

async function runCli() {
  const sourceCount = await fetchUserCount(SOURCE_CORE);
  const targetCount = await fetchUserCount(TARGET_CORE);

  if (sourceCount !== undefined) {
    console.log(`${SOURCE_CORE.label} reported ${sourceCount} total users.`);
  }

  if (targetCount !== undefined) {
    console.log(`${TARGET_CORE.label} reported ${targetCount} total users.`);
  }

  const sourceUserIds = await fetchAllUserIds(SOURCE_CORE, BATCH_SIZE);
  const targetUserIds = await fetchAllUserIds(TARGET_CORE, BATCH_SIZE);

  const onlyInSource = getMissingUserIds(sourceUserIds, targetUserIds);
  const onlyInTarget = getMissingUserIds(targetUserIds, sourceUserIds);

  console.log("\nSummary");
  console.log(`  ${SOURCE_CORE.label}: ${sourceUserIds.size} fetched users`);
  console.log(`  ${TARGET_CORE.label}: ${targetUserIds.size} fetched users`);

  printUserIdSection(`Only in ${SOURCE_CORE.label}`, onlyInSource);
  printUserIdSection(`Only in ${TARGET_CORE.label}`, onlyInTarget);
}

runCli().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "User diff failed");
  process.exitCode = 1;
});

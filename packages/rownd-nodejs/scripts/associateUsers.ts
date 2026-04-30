import { z } from "zod";
import {
  loadConfig,
  formatZodError,
  fetchRowndUsersPage,
} from "./scriptUtils";
import { getTenantIdsForRowndUser, PUBLIC_TENANT_ID } from "./rowndTenantMapping";

const SuperTokensUserSchema = z.object({
  id: z.string(),
  loginMethods: z.array(
    z.object({
      recipeUserId: z.string(),
    }),
  ),
});

async function getSuperTokensUser(
  connectionURI: string,
  apiKey: string | undefined,
  rowndUserId: string,
) {
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers["api-key"] = apiKey;
  }

  const url = new URL("/user/id", connectionURI);
  url.searchParams.set("userId", rowndUserId);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers,
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch SuperTokens user ${rowndUserId}: ${response.status} ${await response.text()}`,
    );
  }

  const parsed = z
    .object({
      status: z.string(),
      user: SuperTokensUserSchema.optional(),
    })
    .parse(await response.json());

  if (parsed.status === "UNKNOWN_USER_ID_ERROR" || !parsed.user) {
    return undefined;
  }

  return parsed.user;
}

async function associateUsers() {
  const config = await loadConfig();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.supertokens.apiKey) {
    headers["api-key"] = config.supertokens.apiKey;
  }

  let cursor: string | undefined = undefined;
  let totalProcessed = 0;
  let totalAssociated = 0;
  let totalSkipped = 0;

  console.log("Starting retroactive tenant association from Rownd user memberships.");

  while (true) {
    const pageUsers = await fetchRowndUsersPage(config, cursor, config.rownd.pageSize);

    if (pageUsers.length === 0) {
      break;
    }

    for (const { rowndUser, rowndUserId } of pageUsers) {
      const tenantIds = getTenantIdsForRowndUser(rowndUser).filter(
        (tenantId) => tenantId !== PUBLIC_TENANT_ID,
      );

      totalProcessed++;

      if (tenantIds.length === 0) {
        continue;
      }

      const superTokensUser = await getSuperTokensUser(
        config.supertokens.connectionURI,
        config.supertokens.apiKey,
        rowndUserId,
      );

      if (!superTokensUser) {
        totalSkipped++;
        console.warn(
          `Skipping Rownd user ${rowndUserId}: user not found in SuperTokens.`,
        );
        continue;
      }

      for (const loginMethod of superTokensUser.loginMethods) {
        for (const tenantId of tenantIds) {
          const associateUrl = new URL(
            `/${tenantId}/recipe/multitenancy/tenant/user`,
            config.supertokens.connectionURI,
          );

          const associateRes = await fetch(associateUrl.toString(), {
            method: "POST",
            headers,
            body: JSON.stringify({
              recipeUserId: loginMethod.recipeUserId,
            }),
          });

          const resData = (await associateRes.json()) as { status?: string };
          if (
            resData.status === "OK" ||
            resData.status === "ASSOCIATION_ALREADY_EXISTS_ERROR"
          ) {
            if (resData.status === "OK") {
              totalAssociated++;
            }
          } else {
            console.warn(
              `Failed to associate user ${rowndUserId} (${loginMethod.recipeUserId}) to tenant ${tenantId}: ${resData.status || associateRes.status}`,
            );
          }
        }
      }
    }

    console.log(`Processed ${totalProcessed} Rownd users...`);

    if (pageUsers.length < config.rownd.pageSize) {
      break;
    }

    cursor = pageUsers[pageUsers.length - 1]?.rowndUserId;
  }

  console.log(
    `Finished retroactive association. Processed ${totalProcessed} users, created ${totalAssociated} tenant associations, skipped ${totalSkipped} users missing in SuperTokens.`,
  );
}

associateUsers().catch((error: unknown) => {
  if (error instanceof z.ZodError) {
    console.error(formatZodError(error));
  } else {
    console.error(
      error instanceof Error ? error.message : "Retroactive association failed",
    );
  }
  process.exitCode = 1;
});

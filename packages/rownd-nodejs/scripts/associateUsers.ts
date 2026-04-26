import { z } from "zod";
import { loadConfig, formatZodError, fetchWithRetry } from "./bulkMigrate";

async function associateUsers() {
  const config = await loadConfig();

  console.log("Fetching Rownd OIDC clients...");
  const oidcClients = await fetchRowndOidcClients(config);

  const targetTenants = oidcClients.map((client) => client.id);

  if (targetTenants.length === 0) {
    console.log("No non-public tenants to associate users with.");
    return;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.supertokens.apiKey) {
    headers["api-key"] = config.supertokens.apiKey;
  }

  let paginationToken: string | undefined = undefined;
  let totalProcessed = 0;
  let totalAssociated = 0;

  console.log(
    `Starting retroactive association to tenants: ${targetTenants.join(", ")}`,
  );

  while (true) {
    const url = new URL("/users", config.supertokens.connectionURI);
    url.searchParams.set("limit", String(config.supertokens.batchSize));
    if (paginationToken) {
      url.searchParams.set("paginationToken", paginationToken);
    }

    const response = await fetchWithRetry({
      url: url.toString(),
      requestInit: {
        method: "GET",
        headers,
      },
      retryConfig: config.retry,
      operation: "Fetch users for association",
    });

    if (!response) {
      throw new Error("Failed to fetch SuperTokens users");
    }

    const data = (await response.json()) as {
      status: string;
      users: Array<{
        user: { id: string; loginMethods: Array<{ recipeUserId: string }> };
      }>;
      nextPaginationToken?: string;
    };

    if (data.status !== "OK" || !data.users || data.users.length === 0) {
      break;
    }

    const users = data.users.map((u) => u.user);

    for (const user of users) {
      // we must use the recipe user ID to associate. In imported users, they usually have exactly one
      // login method, so we will try to associate each login method's recipe user id to the tenant.
      for (const loginMethod of user.loginMethods) {
        for (const tenantId of targetTenants) {
          const associateUrl = new URL(
            `/${tenantId}/recipe/multitenancy/tenant/user`,
            config.supertokens.connectionURI,
          );

          const associateRes = await fetchWithRetry({
            url: associateUrl.toString(),
            requestInit: {
              method: "POST",
              headers,
              body: JSON.stringify({
                recipeUserId: loginMethod.recipeUserId,
              }),
            },
            retryConfig: config.retry,
            operation: `Associate user ${user.id} to tenant ${tenantId}`,
          });

          const resData = (await associateRes.json()) as any;
          if (
            resData.status === "OK" ||
            resData.status === "ASSOCIATION_ALREADY_EXISTS_ERROR"
          ) {
            if (resData.status === "OK") totalAssociated++;
          } else {
            console.warn(
              `Failed to associate user ${user.id} (${loginMethod.recipeUserId}) to tenant ${tenantId}: ${resData.status || associateRes.status}`,
            );
          }
        }
      }
      totalProcessed++;
    }

    console.log(`Processed ${totalProcessed} users...`);

    if (!data.nextPaginationToken) {
      break;
    }
    paginationToken = data.nextPaginationToken;
  }

  console.log(
    `Finished retroactive association. Processed ${totalProcessed} users, created ${totalAssociated} tenant associations.`,
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

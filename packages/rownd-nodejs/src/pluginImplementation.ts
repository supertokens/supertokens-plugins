import { BaseRequest } from "supertokens-node/lib/build/framework/request";
import supertokens from "supertokens-node";
import { RowndUser, SuperTokensUserImport, IRowndClient } from "./types";
import { SuperTokensPublicConfig } from "supertokens-node/types";

let rowndClient: IRowndClient | undefined;

export function setRowndClient(client: IRowndClient) {
  rowndClient = client;
}

export function getRowndClient() {
  if (!rowndClient) {
    throw new Error("Rownd client not initialized");
  }
  return rowndClient;
}

export async function parseRequest(req: BaseRequest): Promise<{
  token: string;
  tenantId: string;
}> {
  const authHeader = req.getHeaderValue("authorization");
  if (!authHeader) {
    throw new Error("Missing authorization header");
  }

  const token = authHeader.replace(/^Bearer /i, "");
  if (!token) {
    throw new Error("Invalid token");
  }

  let tenantId = "public";

  try {
    const body = (await req.getJSONBody()) as
      | {
          tenantId?: string;
          userMetadata?: Record<string, unknown>;
          roles?: string[];
        }
      | undefined;
    if (body?.tenantId) {
      tenantId = body.tenantId;
    }
  } catch (error) {}

  return {
    token,
    tenantId,
  };
}

export function mapRowndUserToSuperTokens(
  rowndUser: RowndUser,
): SuperTokensUserImport {
  const loginMethods: SuperTokensUserImport["loginMethods"] = [];
  if (rowndUser.data.google_id) {
    loginMethods.push({
      recipeId: "thirdparty",
      thirdParty: {
        id: "google",
        userId: rowndUser.data.google_id,
      },
      email: rowndUser.data.email || "",
      isVerified: !!rowndUser.verified_data.google_id,
    });
  }

  if (rowndUser.data.apple_id) {
    loginMethods.push({
      recipeId: "thirdparty",
      thirdParty: {
        id: "apple",
        userId: rowndUser.data.apple_id,
      },
      email: rowndUser.data.email || "",
      isVerified: !!rowndUser.verified_data.apple_id,
    });
  }

  if (rowndUser.data.phone_number && loginMethods.length === 0) {
    loginMethods.push({
      recipeId: "passwordless",
      phoneNumber: rowndUser.data.phone_number,
      isVerified: !!rowndUser.verified_data.phone_number,
    });
  }

  if (loginMethods.length === 0 && rowndUser.data.email) {
    loginMethods.push({
      recipeId: "passwordless",
      email: rowndUser.data.email,
      isVerified: !!rowndUser.verified_data.email,
    });
  }

  if (loginMethods.length === 0) {
    throw new Error("No valid login methods found in Rownd user data");
  }

  const userMetadata = {
    ...rowndUser.data,
    rownd_migrated: true,
    rownd_user_id: rowndUser.app_user_id,
  };

  return {
    externalUserId: rowndUser.app_user_id,
    loginMethods,
    userMetadata,
  };
}

export async function importUser(
  stUser: SuperTokensUserImport,
  config: NonNullable<SuperTokensPublicConfig["supertokens"]>,
) {
  const coreUrl = `${config.connectionURI}/bulk-import/users`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "cdi-version": "2.21",
  };

  if (config.apiKey) {
    headers["api-key"] = config.apiKey;
  }

  const response = await fetch(coreUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ users: [stUser] }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Bulk import failed with status ${response.status}: ${errorText}`,
    );
  }

  const importResponse = (await response.json()) as {
    status: string;
    message?: string;
  };

  if (importResponse.status !== "OK") {
    throw new Error(
      `Bulk import failed: ${importResponse.message || "Unknown error"}`,
    );
  }
}

export async function findSuperTokensUserIdByRowndUserId(
  rowndUserId: string,
): Promise<string | undefined> {
  const mapping = await supertokens.getUserIdMapping({
    userId: rowndUserId,
    userIdType: "EXTERNAL",
  });
  if (mapping.status === "OK") {
    return mapping.superTokensUserId;
  }
  return undefined;
}

export async function validateRowndToken(token: string): Promise<string> {
  const client = getRowndClient();
  const tokenInfo = await client.validateToken(token);
  return tokenInfo.user_id;
}

export async function fetchRowndUserInfo(userId: string): Promise<RowndUser> {
  const client = getRowndClient();
  const rowndUser = await client.fetchUserInfo({ user_id: userId });
  return rowndUser as RowndUser;
}

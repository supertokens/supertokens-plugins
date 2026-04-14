import { BaseRequest } from "supertokens-node/lib/build/framework/request";
import supertokens from "supertokens-node";
import { RowndUser, SuperTokensUserImport, IRowndClient } from "./types";
import { RowndPluginError } from "./errors";
import type {
  JSONObject,
  SuperTokensPublicConfig,
} from "supertokens-node/types";

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
    throw new RowndPluginError("MISSING_AUTHORIZATION_HEADER");
  }

  const token = authHeader.replace(/^Bearer /i, "");
  if (!token) {
    throw new RowndPluginError("INVALID_TOKEN");
  }

  let tenantId = "public";

  try {
    const body = (await req.getJSONBody()) as
      | {
          tenantId?: string;
        }
      | undefined;
    if (body?.tenantId) {
      tenantId = body.tenantId;
    }
  } catch {
    // ignore parse errors
  }

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
      thirdPartyId: "google",
      thirdPartyUserId: rowndUser.data.google_id,
      email: rowndUser.data.email || "",
      isVerified: !!rowndUser.verified_data.google_id,
    });
  }

  if (rowndUser.data.apple_id) {
    loginMethods.push({
      recipeId: "thirdparty",
      thirdPartyId: "apple",
      thirdPartyUserId: rowndUser.data.apple_id,
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

  const userMetadata: JSONObject = {
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
): Promise<string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.apiKey) {
    headers["api-key"] = config.apiKey;
  }

  const response = await fetch(`${config.connectionURI}/bulk-import/import`, {
    method: "POST",
    headers,
    body: JSON.stringify(stUser),
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

  if (!stUser.externalUserId) {
    throw new Error("Imported user is missing externalUserId");
  }

  const importedUserId = await findSuperTokensUserIdByRowndUserId(
    stUser.externalUserId,
  );

  if (!importedUserId) {
    throw new Error("Imported user not found after import");
  }

  return importedUserId;
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
  if (!rowndUser) {
    throw new RowndPluginError("ROWND_USER_NOT_FOUND");
  }
  return rowndUser;
}

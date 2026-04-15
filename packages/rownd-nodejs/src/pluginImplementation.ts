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
}> {
  const authHeader = req.getHeaderValue("authorization");
  if (!authHeader) {
    throw new RowndPluginError("MISSING_AUTHORIZATION_HEADER");
  }

  const token = authHeader.replace(/^Bearer /i, "");
  if (!token) {
    throw new RowndPluginError("INVALID_TOKEN");
  }

  return {
    token,
  };
}

export function mapRowndUserToSuperTokens(
  rowndUser: RowndUser,
): SuperTokensUserImport {
  const loginMethods: SuperTokensUserImport["loginMethods"] = [];
  const rowndUserData = rowndUser.data || {};
  const rowndUserVerifiedData = rowndUser.verified_data || {};
  if (!rowndUserData.user_id) {
    throw new Error("Rownd user has no app_user_id");
  }

  if (rowndUserData.google_id) {
    loginMethods.push({
      recipeId: "thirdparty",
      thirdPartyId: "google",
      thirdPartyUserId: rowndUser.data.google_id as string,
      email: rowndUser.data.email || "",
      isVerified: !!rowndUserVerifiedData.google_id,
    });
  }

  if (rowndUserData.apple_id) {
    loginMethods.push({
      recipeId: "thirdparty",
      thirdPartyId: "apple",
      thirdPartyUserId: rowndUser.data.apple_id as string,
      email: rowndUser.data.email || "",
      isVerified: !!rowndUserVerifiedData.apple_id,
    });
  }

  if (rowndUserData.phone_number) {
    loginMethods.push({
      recipeId: "passwordless",
      phoneNumber: rowndUser.data.phone_number,
      isVerified: !!rowndUserVerifiedData.phone_number,
    });
  }

  if (rowndUserData.email && loginMethods.length === 0) {
    loginMethods.push({
      recipeId: "passwordless",
      email: rowndUser.data.email,
      isVerified: !!rowndUserVerifiedData.email,
    });
  }

  if (loginMethods.length === 0) {
    throw new Error("No valid login methods found in Rownd user data");
  }

  const rowndUserMeta = rowndUser.meta || {};
  const rowndUserAttributes = rowndUser.attributes || {};

  const userMetadata: JSONObject = {
    data: {
      ...rowndUserData,
    },
    meta: {
      ...rowndUserMeta,
    },
    verified_data: {
      ...rowndUserVerifiedData,
    },
    attributes: {
      ...rowndUserAttributes,
    },
    rownd_migrated: true,
    rownd_user_id: rowndUserData.user_id,
  };

  return {
    externalUserId: rowndUserData.user_id,
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

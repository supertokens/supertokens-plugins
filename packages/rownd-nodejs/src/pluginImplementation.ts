import { BaseRequest } from "supertokens-node/lib/build/framework/request";
import SuperTokens from "supertokens-node";
import UserMetadata from "supertokens-node/recipe/usermetadata";
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
    throw new Error("Rownd user has no user_id");
  }

  if (rowndUserData.google_id) {
    if (!rowndUserData.email) {
      throw new Error("Rownd Google user is missing email");
    }

    loginMethods.push({
      recipeId: "thirdparty",
      thirdPartyId: "google",
      thirdPartyUserId: rowndUserData.google_id,
      email: rowndUserData.email,
      isVerified: !!rowndUserVerifiedData.google_id,
    });
  }

  if (rowndUserData.apple_id) {
    if (!rowndUserData.email) {
      throw new Error("Rownd Apple user is missing email");
    }

    loginMethods.push({
      recipeId: "thirdparty",
      thirdPartyId: "apple",
      thirdPartyUserId: rowndUserData.apple_id,
      email: rowndUserData.email,
      isVerified: !!rowndUserVerifiedData.apple_id,
    });
  }

  if (rowndUserData.phone_number) {
    loginMethods.push({
      recipeId: "passwordless",
      phoneNumber: rowndUserData.phone_number,
      isVerified: !!rowndUserVerifiedData.phone_number,
    });
  }

  if (rowndUserData.email && loginMethods.length === 0) {
    loginMethods.push({
      recipeId: "passwordless",
      email: rowndUserData.email,
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
): Promise<{
  id: string;
  loginMethods: Array<{
    recipeUserId: string;
  }>;
}> {
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
    user?: {
      id: string;
      loginMethods: Array<{
        recipeUserId: string;
      }>;
    };
  };

  if (importResponse.status !== "OK" || !importResponse.user) {
    throw new Error(
      `Bulk import failed: ${importResponse.message || "Missing user in response"}`,
    );
  }

  return importResponse.user;
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

type RowndMetadata = {
  data: Record<string, any>;
  meta: Record<string, any>;
  verified_data: Record<string, any>;
  attributes: Record<string, any>;
  rownd_migrated?: boolean;
  rownd_user_id?: string;
};

export type RowndCompatUserResponse = {
  data: Record<string, any>;
  meta: Record<string, any>;
  verified_data: Record<string, any>;
  redacted: string[];
  groups: any[];
  attributes?: Record<string, any>;
};

export async function getRowndStyleMetadata(userId: string): Promise<RowndMetadata> {
  const metadata = await UserMetadata.getUserMetadata(userId);
  const rowndMetadata = (metadata.metadata || {}) as Partial<RowndMetadata>;

  return {
    data: rowndMetadata.data || {},
    meta: rowndMetadata.meta || {},
    verified_data: rowndMetadata.verified_data || {},
    attributes: rowndMetadata.attributes || {},
    rownd_migrated: rowndMetadata.rownd_migrated,
    rownd_user_id: rowndMetadata.rownd_user_id,
  };
}

export async function buildRowndStyleUserResponse(
  userId: string,
): Promise<RowndCompatUserResponse> {
  const metadata = await getRowndStyleMetadata(userId);
  const stUser = await SuperTokens.getUser(userId);
  const loginMethod = stUser?.loginMethods[0];

  const data = {
    user_id: userId,
    ...metadata.data,
  };

  if (data.email === undefined && loginMethod && "email" in loginMethod && loginMethod.email) {
    data.email = loginMethod.email;
  }

  if (data.phone_number === undefined && loginMethod && "phoneNumber" in loginMethod && loginMethod.phoneNumber) {
    data.phone_number = loginMethod.phoneNumber;
  }

  const verifiedData = {
    ...metadata.verified_data,
  };

  if (verifiedData.email === true && typeof data.email === "string") {
    verifiedData.email = data.email;
  }

  if (verifiedData.phone_number === true && typeof data.phone_number === "string") {
    verifiedData.phone_number = data.phone_number;
  }

  if (loginMethod && "email" in loginMethod && loginMethod.email && loginMethod.verified === true && verifiedData.email === undefined) {
    verifiedData.email = loginMethod.email;
  }

  if (
    loginMethod &&
    "phoneNumber" in loginMethod &&
    loginMethod.phoneNumber &&
    loginMethod.verified === true &&
    verifiedData.phone_number === undefined
  ) {
    verifiedData.phone_number = loginMethod.phoneNumber;
  }

  return {
    data,
    meta: metadata.meta,
    verified_data: verifiedData,
    redacted: [],
    groups: [],
    attributes: metadata.attributes,
  };
}

export async function updateRowndUserData(
  userId: string,
  inputData: Record<string, any>,
) {
  const metadata = await getRowndStyleMetadata(userId);
  const updatedMetadata: JSONObject = {
    ...metadata,
    data: {
      ...metadata.data,
      ...inputData,
      user_id: userId,
    },
  };

  await UserMetadata.updateUserMetadata(userId, updatedMetadata);
  return buildRowndStyleUserResponse(userId);
}

export async function updateRowndUserMetadata(
  userId: string,
  inputMeta: Record<string, any>,
) {
  const metadata = await getRowndStyleMetadata(userId);
  const updatedMetadata: JSONObject = {
    ...metadata,
    meta: {
      ...metadata.meta,
      ...inputMeta,
    },
  };

  await UserMetadata.updateUserMetadata(userId, updatedMetadata);

  return {
    id: userId,
    meta: (updatedMetadata.meta || {}) as Record<string, any>,
  };
}

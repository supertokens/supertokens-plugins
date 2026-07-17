import { RowndPluginError } from "./errors";
import type { IRowndClient, RowndUser } from "./types";

let rowndClient: IRowndClient | undefined;

export function setRowndClient(client: IRowndClient | undefined) {
  rowndClient = client;
}

export function getRowndClient() {
  if (!rowndClient) {
    throw new Error("Rownd client not initialized");
  }
  return rowndClient;
}

export async function validateRowndToken(token: string): Promise<string> {
  const client = getRowndClient();
  const tokenInfo = await client.validateToken(token);
  return tokenInfo.user_id;
}

export async function fetchRowndUserInfo(userId: string): Promise<RowndUser> {
  const rowndUser = await fetchOptionalRowndUserInfo(userId);
  if (!rowndUser) {
    throw new RowndPluginError("ROWND_USER_NOT_FOUND");
  }
  return rowndUser;
}

export async function fetchOptionalRowndUserInfo(
  userId: string,
): Promise<RowndUser | undefined> {
  const client = getRowndClient();
  return client.fetchUserInfo({ user_id: userId });
}

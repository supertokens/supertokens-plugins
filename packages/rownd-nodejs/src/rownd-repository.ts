import { RowndMigrationPolicyError, RowndPluginError } from "./errors";
import { AsyncLocalStorage } from "node:async_hooks";
import { hasReconciliationReads, reconciliationRead } from "./reconciliation-reads";
import type { IRowndClient, RowndUser } from "./types";
import type { createRowndTokenValidator } from "./rownd-token-validator";

let rowndClient: IRowndClient | undefined;
let rowndTokenValidator: ReturnType<typeof createRowndTokenValidator> | undefined;
const freshReads = new AsyncLocalStorage<boolean>();

export function withFreshRowndReads<T>(action: () => Promise<T>) {
  return freshReads.run(true, action);
}

export function setRowndClient(client: IRowndClient | undefined) {
  rowndClient = client;
  if (client === undefined) rowndTokenValidator = undefined;
}

export function setRowndTokenValidator(validator: ReturnType<typeof createRowndTokenValidator> | undefined) {
  rowndTokenValidator = validator;
}

export function getRowndClient() {
  if (!rowndClient) {
    throw new Error("Rownd client not initialized");
  }
  return rowndClient;
}

export async function validateRowndToken(token: string): Promise<string> {
  const tokenInfo = await (rowndTokenValidator ?? getRowndClient().validateToken)(token);
  if (typeof tokenInfo?.user_id !== "string" || !tokenInfo.user_id || tokenInfo.user_id.trim() !== tokenInfo.user_id ||
    [...tokenInfo.user_id].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
    tokenInfo.user_id === "." || tokenInfo.user_id === "..") throw new Error("Invalid Rownd token user ID");
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
  return reconciliationRead("rownd", userId, async () => {
    const profile = await (freshReads.getStore() && client.fetchFreshUserInfo
      ? client.fetchFreshUserInfo({ user_id: userId }) : client.fetchUserInfo({ user_id: userId }));
    return hasReconciliationReads() ? structuredClone(profile) : profile;
  });
}

export async function findRowndUserIdsByEmail(email: string): Promise<string[]> {
  const client = getRowndClient();
  if (!client.findUserIdsByEmail) throw new RowndMigrationPolicyError("ROWND_EMAIL_SEARCH_UNSUPPORTED: configure an app-scoped Rownd email search client");
  const ids: unknown = await client.findUserIdsByEmail({ email });
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !id || id.trim() !== id ||
    [...id].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || id === "." || id === "..")) {
    throw new RowndMigrationPolicyError("ROWND_EMAIL_SEARCH_INVALID_RESPONSE");
  }
  return [...new Set(ids as string[])].sort();
}

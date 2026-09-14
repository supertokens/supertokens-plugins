import { createInstance } from "@rownd/node";
import { RowndMigrationPolicyError } from "./errors";
import { isRecord } from "./utils";
import type { IRowndClient, RowndUser } from "./types";

const api = "https://api.rownd.io";
const pageSize = 100;

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value &&
    ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) && value !== "." && value !== "..";
}

export function createRowndClient(config: { appKey: string; appSecret: string; appId?: string }): IRowndClient {
  const sdk = createInstance({ app_key: config.appKey, app_secret: config.appSecret });
  const client: IRowndClient = {
    validateToken: (token) => sdk.validateToken(token),
    fetchUserInfo: (opts) => sdk.fetchUserInfo({ ...opts, ...(config.appId ? { app_id: config.appId } : {}) }),
  };
  if (config.appId === undefined) return client;
  if (!validId(config.appId)) throw new RowndMigrationPolicyError("Invalid Rownd app ID");
  const path = `${api}/applications/${encodeURIComponent(config.appId)}/users`;
  const request = async (url: string, missingAllowed = false): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetch(url, { headers: { "x-rownd-app-key": config.appKey, "x-rownd-app-secret": config.appSecret, accept: "application/json" },
        redirect: "error", signal: AbortSignal.timeout(10000) });
    } catch { throw new Error("Rownd administrative lookup request failed"); }
    if (response.status === 404 && missingAllowed) return undefined;
    if (!response.ok) throw new Error(`Rownd administrative lookup failed (HTTP ${response.status})`);
    try { return await response.json(); } catch { throw new Error("Invalid Rownd administrative lookup response"); }
  };
  client.fetchFreshUserInfo = async ({ user_id, app_id }) => {
    if (!validId(user_id) || (app_id !== undefined && app_id !== config.appId)) throw new RowndMigrationPolicyError("Invalid Rownd administrative lookup scope");
    return await request(`${path}/${encodeURIComponent(user_id)}/data`, true) as RowndUser | undefined;
  };
  client.findUserIdsByEmail = async ({ email }) => {
    if (!validId(email) || /[,\s]/.test(email)) throw new RowndMigrationPolicyError("Invalid Rownd email lookup value");
    const ids = new Set<string>();
    const cursors = new Set<string>();
    let total: number | undefined;
    let after: string | undefined;
    for (let page = 0; page < 1000; page++) {
      const url = new URL(`${path}/data`);
      url.search = new URLSearchParams({ lookup_filter: email, include_duplicates: "true", page_size: String(pageSize), sort: "asc", ...(after ? { after } : {}) }).toString();
      const body = await request(url.href);
      if (!isRecord(body) || !Number.isSafeInteger(body.total_results) || (body.total_results as number) < 0 || !Array.isArray(body.results) || body.results.length > pageSize) {
        throw new RowndMigrationPolicyError("ROWND_EMAIL_SEARCH_INVALID_RESPONSE");
      }
      const count = body.total_results as number;
      if (total !== undefined && count !== total) throw new RowndMigrationPolicyError("ROWND_EMAIL_SEARCH_CHANGED: retry discovery");
      total = count;
      const before = ids.size;
      for (const entry of body.results) {
        if (!isRecord(entry) || !isRecord(entry.data) || !validId(entry.data.user_id)) throw new RowndMigrationPolicyError("ROWND_EMAIL_SEARCH_INVALID_RESPONSE");
        ids.add(entry.data.user_id);
      }
      if (ids.size > total) throw new RowndMigrationPolicyError("ROWND_EMAIL_SEARCH_INVALID_RESPONSE");
      if (ids.size === total) return [...ids].sort();
      const last: unknown = body.results.at(-1)?.data?.user_id;
      if (ids.size === before || !validId(last) || cursors.has(last)) throw new RowndMigrationPolicyError("ROWND_EMAIL_SEARCH_INCOMPLETE: pagination did not advance");
      cursors.add(last);
      after = last;
    }
    throw new RowndMigrationPolicyError("ROWND_EMAIL_SEARCH_INCOMPLETE: pagination limit reached");
  };
  return client;
}

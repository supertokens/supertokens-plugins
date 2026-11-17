import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { z } from "zod";

import type { BulkMigrateConfig } from "./scriptUtils";

const ManifestSchema = z.object({
  version: z.literal(1),
  runId: z.string(),
  startedAt: z.string(),
  updatedAt: z.string(),
  completedStagingAt: z.string().optional(),
  rowndAppIdHash: z.string(),
  targetHash: z.string(),
  tenantId: z.string(),
  sourceUsersRead: z.number().int().nonnegative(),
  stagedExternalUserIdHashes: z.array(z.string()),
  mappingFailureExternalUserIdHashes: z.array(z.string()),
});

export type BulkImportManifest = z.infer<typeof ManifestSchema>;

export function hashIdentifier(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function defaultManifestPath(checkpointFile: string) {
  return `${checkpointFile}.manifest.json`;
}

export function createManifest(config: BulkMigrateConfig): BulkImportManifest {
  const now = new Date().toISOString();
  return {
    version: 1,
    runId: randomUUID(),
    startedAt: now,
    updatedAt: now,
    rowndAppIdHash: hashIdentifier(config.rownd.appId),
    targetHash: hashIdentifier(config.supertokens.connectionURI),
    tenantId: config.supertokens.tenantId,
    sourceUsersRead: 0,
    stagedExternalUserIdHashes: [],
    mappingFailureExternalUserIdHashes: [],
  };
}

export async function loadManifest(path: string) {
  return ManifestSchema.parse(JSON.parse(await fs.readFile(path, "utf8")));
}

export async function saveManifest(path: string, manifest: BulkImportManifest) {
  const tempFile = `${path}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(manifest, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(tempFile, path);
}

export function addManifestIds(
  manifest: BulkImportManifest,
  field: "stagedExternalUserIdHashes" | "mappingFailureExternalUserIdHashes",
  ids: string[],
) {
  manifest[field] = [
    ...new Set([...manifest[field], ...ids.map(hashIdentifier)]),
  ];
  manifest.updatedAt = new Date().toISOString();
}

export function assertManifestMatchesConfig(
  manifest: BulkImportManifest,
  config: BulkMigrateConfig,
) {
  if (manifest.rowndAppIdHash !== hashIdentifier(config.rownd.appId)) {
    throw new Error("Manifest Rownd app does not match the configured app.");
  }
  if (
    manifest.targetHash !== hashIdentifier(config.supertokens.connectionURI)
  ) {
    throw new Error(
      "Manifest target does not match the configured SuperTokens Core.",
    );
  }
  if (manifest.tenantId !== config.supertokens.tenantId) {
    throw new Error("Manifest tenant does not match the configured tenant.");
  }
}

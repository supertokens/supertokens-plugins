import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SuperTokens from "supertokens-node";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import { assertMigrationMapping, resolveMigrationMapping } from "./migration-mapping";
import type { JsonRecord } from "./utils";

describe("migration mapping resolution", () => {
  let metadata: JsonRecord;
  const mapping = {
    status: "OK" as const,
    superTokensUserId: "internal",
    externalUserId: "rownd",
    externalUserIdInfo: undefined,
  };

  beforeEach(() => {
    metadata = { rownd_migration_canonical_target: "internal" };
    vi.spyOn(UserMetadata, "getUserMetadata").mockImplementation(async () => ({
      status: "OK", metadata,
    }));
    vi.spyOn(SuperTokens, "getUserIdMapping").mockResolvedValue(mapping);
  });

  afterEach(() => vi.restoreAllMocks());

  it("returns literal source metadata and resolves each mapping direction once", async () => {
    const userContext = {};
    await expect(resolveMigrationMapping("rownd", userContext)).resolves.toEqual({
      internalUserId: "internal", metadata,
    });
    expect(UserMetadata.getUserMetadata).toHaveBeenCalledTimes(1);
    expect(UserMetadata.getUserMetadata).toHaveBeenCalledWith("rownd", userContext);
    expect(SuperTokens.getUserIdMapping).toHaveBeenCalledTimes(2);
    expect(SuperTokens.getUserIdMapping).toHaveBeenNthCalledWith(1, {
      userId: "rownd", userIdType: "EXTERNAL", userContext,
    });
    expect(SuperTokens.getUserIdMapping).toHaveBeenNthCalledWith(2, {
      userId: "internal", userIdType: "SUPERTOKENS", userContext,
    });
  });

  it("accepts identical internal and external IDs without mappings", async () => {
    metadata = {};
    vi.mocked(SuperTokens.getUserIdMapping).mockResolvedValue({ status: "UNKNOWN_MAPPING_ERROR" });
    await expect(resolveMigrationMapping("rownd", {})).resolves.toEqual({ internalUserId: "rownd", metadata });
    await expect(assertMigrationMapping("rownd", "rownd", {})).resolves.toBeUndefined();
  });

  it("rejects an internal mapping when the external mapping is absent", async () => {
    metadata = {};
    vi.mocked(SuperTokens.getUserIdMapping).mockResolvedValueOnce({ status: "UNKNOWN_MAPPING_ERROR" });
    await expect(resolveMigrationMapping("rownd", {})).rejects.toThrow("mapping postcondition failed");
  });

  it("rejects a reverse mapping pointing to another source", async () => {
    vi.mocked(SuperTokens.getUserIdMapping).mockResolvedValueOnce(mapping)
      .mockResolvedValueOnce({ ...mapping, externalUserId: "other" });
    await expect(resolveMigrationMapping("rownd", {})).rejects.toThrow("mapping postcondition failed");
  });

  it("rejects a conflicting canonical target", async () => {
    metadata.rownd_migration_canonical_target = "other";
    await expect(resolveMigrationMapping("rownd", {})).rejects.toThrow("canonical reconciliation target changed");
  });

  it("rejects a retired source without its canonical mapping", async () => {
    metadata.rownd_migration_superseded = { rowndUserId: "winner" };
    vi.mocked(SuperTokens.getUserIdMapping).mockResolvedValue({ status: "UNKNOWN_MAPPING_ERROR" });
    await expect(resolveMigrationMapping("rownd", {})).rejects.toThrow("has been superseded");
  });

  it("retains a canonical owner despite a provisional retirement marker", async () => {
    metadata.rownd_migration_superseded = { rowndUserId: "loser" };
    await expect(resolveMigrationMapping("rownd", {})).resolves.toEqual({ internalUserId: "internal", metadata });
  });

  it("still rejects a changed owner for callers asserting a fixed target", async () => {
    metadata = {};
    await expect(assertMigrationMapping("previous", "rownd", {})).rejects.toThrow("mapping postcondition failed");
  });
});

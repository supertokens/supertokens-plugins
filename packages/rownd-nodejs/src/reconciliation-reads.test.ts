import { afterEach, describe, expect, it, vi } from "vitest";
import SuperTokens from "supertokens-node";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import { reconciliationSuperTokens as core, reconciliationUserMetadata as metadata } from "./reconciliation-sdk";
import { invalidateReconciliationReads, reconciliationRead, withReconciliationReads } from "./reconciliation-reads";

afterEach(() => vi.restoreAllMocks());

describe("invocation reconciliation reads", () => {
  it("deduplicates concurrent latency-injected reads and starts each retry fresh", async () => {
    const load = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return { revision: load.mock.calls.length };
    });
    await Promise.all(Array.from({ length: 50 }, () => reconciliationRead("rownd", "source", load)));
    expect(load).toHaveBeenCalledTimes(50);
    load.mockClear();
    await withReconciliationReads(async () => {
      const values = await Promise.all(Array.from({ length: 50 }, () => reconciliationRead("rownd", "source", load)));
      expect(values.every((value) => value === values[0])).toBe(true);
      expect(load).toHaveBeenCalledTimes(1);
      invalidateReconciliationReads("rownd", "source");
      expect(await reconciliationRead("rownd", "source", load)).toEqual({ revision: 2 });
    });
    await withReconciliationReads(() => reconciliationRead("rownd", "source", load));
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("evicts failures without deleting a newer in-flight replacement", async () => {
    let reject!: (error: Error) => void;
    await withReconciliationReads(async () => {
      const failed = reconciliationRead("user", "owner", () => new Promise((_, no) => { reject = no; }));
      await Promise.resolve();
      invalidateReconciliationReads("user", "owner");
      const replacement = reconciliationRead("user", "owner", async () => "new");
      reject(new Error("lost response"));
      await expect(failed).rejects.toThrow("lost response");
      expect(await reconciliationRead("user", "owner", async () => "wrong")).toBe(await replacement);
    });
    await withReconciliationReads(async () => {
      const load = vi.fn().mockRejectedValueOnce(new Error("retry")).mockResolvedValueOnce("recovered");
      await expect(reconciliationRead("user", "owner", load)).rejects.toThrow("retry");
      expect(await reconciliationRead("user", "owner", load)).toBe("recovered");
      expect(load).toHaveBeenCalledTimes(2);
    });
  });

  it("isolates overlapping invocations", async () => {
    const values = await Promise.all(["a", "b"].map((value) => withReconciliationReads(async () => {
      await Promise.resolve();
      return reconciliationRead("metadata", "same-owner", async () => value);
    })));
    expect(values).toEqual(["a", "b"]);
  });

  it("checkpoint writes only invalidate literal owner metadata, never the discovered graph", async () => {
    const userRead = vi.spyOn(SuperTokens, "getUser").mockResolvedValue(undefined);
    const searchRead = vi.spyOn(SuperTokens, "listUsersByAccountInfo").mockResolvedValue([]);
    const metadataRead = vi.spyOn(UserMetadata, "getUserMetadata").mockResolvedValue({ status: "OK", metadata: {} });
    vi.spyOn(UserMetadata, "updateUserMetadata").mockResolvedValue({ status: "OK", metadata: {} });
    await withReconciliationReads(async () => {
      for (let cursor = 0; cursor < 5; cursor++) {
        await core.getUser("owner");
        await core.listUsersByAccountInfo("public", { email: "test@example.com" }, false);
        await metadata.getUserMetadata("donor");
        await metadata.getUserMetadata("owner");
        await metadata.updateUserMetadata("owner", { checkpoint: { cursor } });
      }
      expect(userRead).toHaveBeenCalledTimes(1);
      expect(searchRead).toHaveBeenCalledTimes(1);
      expect(metadataRead.mock.calls.filter(([id]) => id === "donor")).toHaveLength(1);
      expect(metadataRead.mock.calls.filter(([id]) => id === "owner")).toHaveLength(5);
      invalidateReconciliationReads();
      await core.getUser("owner");
      expect(userRead).toHaveBeenCalledTimes(2);
    });
  });

  it("mapping publication refreshes both mapping directions and externalized user/search responses", async () => {
    const mapping = vi.spyOn(SuperTokens, "getUserIdMapping").mockResolvedValue({ status: "UNKNOWN_MAPPING_ERROR" });
    const user = vi.spyOn(SuperTokens, "getUser").mockResolvedValue(undefined);
    const search = vi.spyOn(SuperTokens, "listUsersByAccountInfo").mockResolvedValue([]);
    vi.spyOn(SuperTokens, "createUserIdMapping").mockResolvedValue({ status: "OK" });
    await withReconciliationReads(async () => {
      const observe = async () => {
        await core.getUserIdMapping({ userId: "alias", userIdType: "EXTERNAL" });
        await core.getUserIdMapping({ userId: "owner", userIdType: "SUPERTOKENS" });
        await core.getUser("owner");
        await core.listUsersByAccountInfo("public", { thirdParty: { id: "google", userId: "subject" } }, false);
      };
      await observe();
      await observe();
      expect(mapping).toHaveBeenCalledTimes(2);
      await core.createUserIdMapping({ superTokensUserId: "owner", externalUserId: "alias" });
      await observe();
      expect(mapping).toHaveBeenCalledTimes(4);
      expect(user).toHaveBeenCalledTimes(2);
      expect(search).toHaveBeenCalledTimes(2);
    });
  });
});

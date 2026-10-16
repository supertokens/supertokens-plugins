import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SuperTokens from "supertokens-node";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import {
  getCombinedUserMetadata,
  getRawUserMetadata,
} from "./rownd-compatibility";
import { reconciliationUserMetadata } from "./reconciliation-sdk";
import { withReconciliationReads } from "./reconciliation-reads";
import type { JsonRecord } from "./utils";

describe("metadata alias references", () => {
  const alias = "user_nzw9i02l0k3mr3xynxdkt8zy";
  const owner = "0fc52e5d-359b-420b-80a4-9862906f2ad3";
  let records: Map<string, JsonRecord>;
  beforeEach(() => {
    records = new Map([
      [
        alias,
        {
          rownd_migration_target: owner,
          custom: { aliasOnly: true, shared: "alias" },
          rownd_migration_complete: false,
        },
      ],
      [
        owner,
        {
          original_rownd_user: {
            data: { user_id: "canonical", first_name: "Rownd name" },
          },
          first_name: "Rownd name",
          custom: { ownerOnly: true, shared: "owner" },
          rownd_migration_complete: true,
        },
      ],
    ]);
    const user = {
      id: "canonical",
      isPrimaryUser: true,
      loginMethods: [],
    } as unknown as NonNullable<
      Awaited<ReturnType<typeof SuperTokens.getUser>>
    >;
    vi.spyOn(SuperTokens, "getUser").mockImplementation(async (id) =>
      id === owner || id === "canonical" ? user : undefined,
    );
    vi.spyOn(SuperTokens, "getUserIdMapping").mockImplementation(
      async ({ userId, userIdType }) =>
        userId === (userIdType === "EXTERNAL" ? "canonical" : owner)
          ? {
              status: "OK",
              superTokensUserId: owner,
              externalUserId: "canonical",
            }
          : { status: "UNKNOWN_MAPPING_ERROR" },
    );
    vi.spyOn(UserMetadata, "getUserMetadata").mockImplementation(
      async (id) => ({
        status: "OK",
        metadata: structuredClone(records.get(id) ?? {}),
      }),
    );
    vi.spyOn(UserMetadata, "updateUserMetadata").mockImplementation(
      async (id, patch) => {
        const metadata = { ...records.get(id), ...patch };
        records.set(id, metadata);
        return { status: "OK", metadata };
      },
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it("resolves the reported pointer-only alias without modifying literal metadata", async () => {
    records.set(alias, { rownd_migration_target: owner });
    expect(await getCombinedUserMetadata(alias)).toEqual(records.get(owner));
    expect(await getRawUserMetadata(alias)).toEqual({
      rownd_migration_target: owner,
    });
    expect(UserMetadata.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("preserves alias custom fields, owner precedence, and literal migration state", async () => {
    expect(await getCombinedUserMetadata(alias)).toEqual({
      ...records.get(owner),
      custom: { ownerOnly: true, aliasOnly: true, shared: "owner" },
    });
    expect(await getRawUserMetadata(alias)).toEqual(records.get(alias));
    expect(UserMetadata.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("includes mapped aliases even when absent from the exposed recipe IDs", async () => {
    records.set("canonical", {
      aliasCustom: "preserved",
      rownd_migration_target: owner,
    });
    expect(await getCombinedUserMetadata("canonical")).toMatchObject({
      aliasCustom: "preserved",
      first_name: "Rownd name",
    });
  });

  it("keeps the canonical owner snapshot rather than the retired alias profile", async () => {
    records.set(alias, {
      ...records.get(alias),
      original_rownd_user: {
        data: { user_id: alias, first_name: "Old name", retiredOnly: true },
      },
    });
    expect((await getCombinedUserMetadata(alias)).original_rownd_user).toEqual(
      records.get(owner)!.original_rownd_user,
    );
    expect((await getRawUserMetadata(alias)).original_rownd_user).toEqual(
      records.get(alias)!.original_rownd_user,
    );
  });

  it("follows canonical references and retains intermediate custom data", async () => {
    records.set(alias, {
      rownd_migration_target: "missing",
      rownd_migration_canonical_target: "middle",
    });
    records.set("middle", {
      rownd_migration_target: owner,
      middleCustom: true,
    });
    expect(await getCombinedUserMetadata(alias)).toEqual({
      ...records.get(owner),
      middleCustom: true,
    });
  });

  it.each(["missing", "cycle"])(
    "leaves an incomplete %s reference literal",
    async (kind) => {
      records.set(alias, {
        rownd_migration_target: "middle",
        custom: "preserved",
      });
      records.set("middle", {
        rownd_migration_target: kind === "cycle" ? alias : "missing",
        unrelated: true,
      });
      expect(await getCombinedUserMetadata(alias)).toEqual(records.get(alias));
      expect(UserMetadata.updateUserMetadata).not.toHaveBeenCalled();
    },
  );

  it("refreshes every alias view after owner writes in the same invocation", async () => {
    records.set("other", { rownd_migration_target: owner });
    await withReconciliationReads(async () => {
      expect((await getCombinedUserMetadata(alias)).first_name).toBe(
        "Rownd name",
      );
      expect((await getCombinedUserMetadata("other")).first_name).toBe(
        "Rownd name",
      );
      await reconciliationUserMetadata.updateUserMetadata(owner, {
        first_name: "Updated",
      });
      expect((await getCombinedUserMetadata(alias)).first_name).toBe("Updated");
      expect((await getCombinedUserMetadata("other")).first_name).toBe(
        "Updated",
      );
      expect(await getRawUserMetadata(alias)).toEqual(records.get(alias));
    });
  });
});

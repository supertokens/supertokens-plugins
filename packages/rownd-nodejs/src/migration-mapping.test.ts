import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SuperTokens from "supertokens-node";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import { assertMigrationSourceActive } from "./migration-mapping";
import { mapRowndUserToSuperTokens } from "./rownd-compatibility";
import { setRowndClient } from "./rownd-repository";
import { reconcileRowndUserWithExistingLoginMethods } from "./supertokens-repository";
import type { JsonRecord } from "./utils";

describe("durable duplicate mapping recovery", () => {
  const internalId = "internal-provider-account";
  const profile = (userId: string) => ({
    data: { user_id: userId, google_id: "google-subject" },
  });
  const source = mapRowndUserToSuperTokens(profile("A"));
  let externalId: string | undefined;
  let metadata: Map<string, JsonRecord>;

  beforeEach(() => {
    externalId = "B";
    metadata = new Map([
      [
        internalId,
        { internalPreference: "keep", sharedPreference: "internal" },
      ],
      ["B", { externalPreference: "keep", sharedPreference: "external" }],
    ]);
    const user = () =>
      ({
        id: externalId ?? internalId,
        isPrimaryUser: true,
        loginMethods: [
          {
            recipeId: "thirdparty",
            recipeUserId: SuperTokens.convertToRecipeUserId(internalId),
            tenantIds: ["public"],
            thirdParty: { id: "google", userId: "google-subject" },
            verified: false,
            hasSameThirdPartyInfoAs: (value: { id: string; userId: string }) =>
              value.id === "google" && value.userId === "google-subject",
            hasSameEmailAs: () => false,
          },
        ],
      }) as unknown as NonNullable<
        Awaited<ReturnType<typeof SuperTokens.getUser>>
      >;
    vi.spyOn(SuperTokens, "getUser").mockImplementation(async (id) =>
      id === internalId || id === externalId ? user() : undefined,
    );
    vi.spyOn(SuperTokens, "listUsersByAccountInfo").mockImplementation(
      async () => [user()],
    );
    vi.spyOn(SuperTokens, "getUserIdMapping").mockImplementation(
      async ({ userId, userIdType }) =>
        externalId !== undefined &&
        (userIdType === "EXTERNAL"
          ? userId === externalId
          : userId === internalId)
          ? {
              status: "OK",
              superTokensUserId: internalId,
              externalUserId: externalId,
              externalUserIdInfo: undefined,
            }
          : { status: "UNKNOWN_MAPPING_ERROR" },
    );
    vi.spyOn(SuperTokens, "deleteUserIdMapping").mockImplementation(
      async ({ userId, userIdType }) => {
        expect(userIdType).toBe("EXTERNAL");
        expect(userId).toBe("B");
        expect(metadata.get("B")?.rownd_migration_superseded).toEqual({
          rowndUserId: "A",
          targetUserId: internalId,
        });
        const didMappingExist = externalId === userId;
        if (didMappingExist) externalId = undefined;
        return { status: "OK", didMappingExist };
      },
    );
    vi.spyOn(SuperTokens, "createUserIdMapping").mockImplementation(
      async ({ externalUserId }) => {
        if (externalId !== undefined)
          return {
            status: "USER_ID_MAPPING_ALREADY_EXISTS_ERROR",
            doesExternalUserIdExist: false,
            doesSuperTokensUserIdExist: true,
          };
        externalId = externalUserId;
        return { status: "OK" };
      },
    );
    vi.spyOn(UserMetadata, "getUserMetadata").mockImplementation(
      async (id) => ({
        status: "OK",
        metadata: { ...metadata.get(id) },
      }),
    );
    vi.spyOn(UserMetadata, "updateUserMetadata").mockImplementation(
      async (id, update) => {
        metadata.set(id, { ...metadata.get(id), ...update });
        return { status: "OK", metadata: { ...metadata.get(id) } };
      },
    );
    setRowndClient({
      validateToken: async () => ({ user_id: "A" }),
      fetchUserInfo: async ({ user_id }) => profile(user_id),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setRowndClient(undefined);
  });

  it.each([
    "before deletion",
    "after deletion",
    "before creation",
    "after creation",
  ])(
    "resumes across a new request after a failure %s and never re-admits B",
    async (failure) => {
      const deleteMapping = vi
        .mocked(SuperTokens.deleteUserIdMapping)
        .getMockImplementation()!;
      const createMapping = vi
        .mocked(SuperTokens.createUserIdMapping)
        .getMockImplementation()!;
      if (failure.includes("deletion")) {
        vi.spyOn(SuperTokens, "deleteUserIdMapping").mockImplementation(
          async (input) => {
            if (failure === "after deletion") await deleteMapping(input);
            throw new Error("Core connection lost");
          },
        );
      } else {
        vi.spyOn(SuperTokens, "createUserIdMapping").mockImplementation(
          async (input) => {
            if (failure === "after creation") await createMapping(input);
            throw new Error("Core connection lost");
          },
        );
      }
      const first = await reconcileRowndUserWithExistingLoginMethods(
        source,
        "public",
        {},
      ).catch(() => false);
      if (failure === "before deletion" || failure === "before creation")
        expect(first).toBe(false);
      await expect(assertMigrationSourceActive("B", {})).rejects.toThrow(
        "superseded",
      );
      vi.spyOn(SuperTokens, "deleteUserIdMapping").mockImplementation(
        deleteMapping,
      );
      vi.spyOn(SuperTokens, "createUserIdMapping").mockImplementation(
        createMapping,
      );
      await expect(
        reconcileRowndUserWithExistingLoginMethods(source, "public", {}),
      ).resolves.toBe(true);
      expect(externalId).toBe("A");
      expect(metadata.get(internalId)).toMatchObject({
        internalPreference: "keep",
        externalPreference: "keep",
        sharedPreference: "internal",
      });
      await expect(assertMigrationSourceActive("B", {})).rejects.toThrow(
        "superseded",
      );
    },
  );

  it("does not retire a mapping when the fresh duplicate profile lacks exact provider proof", async () => {
    setRowndClient({
      validateToken: async () => ({ user_id: "A" }),
      fetchUserInfo: async ({ user_id }) => ({
        data: {
          user_id,
          google_id: user_id === "B" ? "another-subject" : "google-subject",
        },
      }),
    });
    await expect(
      reconcileRowndUserWithExistingLoginMethods(source, "public", {}),
    ).rejects.toThrow("exact provider");
    expect(externalId).toBe("B");
    expect(SuperTokens.deleteUserIdMapping).not.toHaveBeenCalled();
    expect(UserMetadata.updateUserMetadata).not.toHaveBeenCalled();
  });

  it.each(["legacy", "canonical"])("retains an elected %s owner despite stale markers, without resurrecting it after retirement", async (record) => {
    metadata.set("B", {
      rownd_migration_target: record === "legacy" ? internalId : "stale-target",
      ...(record === "canonical" ? { rownd_migration_canonical_target: internalId } : {}),
      rownd_migration_superseded: { rowndUserId: "A", targetUserId: internalId },
    });
    await expect(assertMigrationSourceActive("B", {})).resolves.toEqual(metadata.get("B"));
    expect(UserMetadata.updateUserMetadata).not.toHaveBeenCalled();

    externalId = undefined;
    await expect(assertMigrationSourceActive("B", {})).rejects.toThrow("superseded");
    externalId = "A";
    await expect(assertMigrationSourceActive("B", {})).rejects.toThrow("superseded");
  });

  it("does not let a stale tombstone bypass contradictory reverse mapping", async () => {
    metadata.set("B", {
      rownd_migration_canonical_target: internalId,
      rownd_migration_superseded: { rowndUserId: "A", targetUserId: internalId },
    });
    const getMapping = vi.mocked(SuperTokens.getUserIdMapping).getMockImplementation()!;
    vi.spyOn(SuperTokens, "getUserIdMapping").mockImplementation(async (input) => {
      const result = await getMapping(input);
      return input.userIdType === "SUPERTOKENS" && result.status === "OK"
        ? { ...result, externalUserId: "A" } : result;
    });
    await expect(assertMigrationSourceActive("B", {})).rejects.toThrow("superseded");
  });

  it("rejects an external ID collision with an unrelated native account", async () => {
    const getUser = vi.mocked(SuperTokens.getUser).getMockImplementation()!;
    vi.spyOn(SuperTokens, "getUser").mockImplementation(async (id, context) => {
      const owner = await getUser(internalId, context);
      return id === "A" ? { ...owner!, id: "A", loginMethods: [] } : getUser(id, context);
    });
    await expect(reconcileRowndUserWithExistingLoginMethods(source, "public", {}))
      .rejects.toThrow("collides with an unrelated internal account");
    expect(SuperTokens.deleteUserIdMapping).not.toHaveBeenCalled();
    expect(UserMetadata.updateUserMetadata).not.toHaveBeenCalled();
  });
});

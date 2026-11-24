import { afterEach, describe, expect, it, vi } from "vitest";
import SuperTokens from "supertokens-node";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import { getPluginConfig, setPluginConfig } from "./config";
import {
  buildConfiguredSessionClaims,
  buildRowndSessionClaimPayload,
  getCanonicalPresentationMetadata,
  getAuthoritativeProfileFields,
  inspectLinkedUserMetadata,
  inspectUserPresentationMetadata,
  ROWND_PROFILE_AUTHORITY_PREFIX,
  type RowndMetadata,
  type SuperTokensUser,
} from "./rownd-compatibility";
import { assembleUserProfile } from "./supertokens-repository";
import type { RowndPluginNormalisedConfig } from "./types";

const ownerId = "literal-owner";
const externalId = "selected-rownd-owner";
const method = (id: string, email: string, tenantIds: string[], timeJoined: number) => ({
  recipeUserId: SuperTokens.convertToRecipeUserId(id), recipeId: "passwordless",
  email, verified: true, tenantIds, timeJoined,
});
const config = {
  metadataMode: "compatibility",
  schema: {
    first_name: { type: "string", include_in_session_claims: true },
    custom: { type: "object", include_in_session_claims: true, session_claim_name: "custom_claim" },
    deleted: { type: "string", include_in_session_claims: true },
    unfilled: { type: "string" },
    nullable: { type: "string", include_in_session_claims: true },
    rownd_pending_verification: { include_in_session_claims: true },
  },
  subBrands: { blue: {}, green: {} },
} as unknown as RowndPluginNormalisedConfig;

describe("offline canonical publication preserves compatibility projections", () => {
  const initialConfig = getPluginConfig();
  afterEach(() => {
    vi.restoreAllMocks();
    setPluginConfig(initialConfig!);
  });

  const cases = [false, true].flatMap((mapped) =>
    ["public", "other"].flatMap((tenantId) =>
      ["original", "deleted", "nested replacement", "tenant selectors", "empty selector authority", "literal null", "missing"]
        .flatMap((fixture) => (fixture === "deleted" || fixture === "nested replacement"
          ? ["legacy", "markers", "mixed"] : ["legacy"])
          .map((authority) => ({ mapped, tenantId, fixture, authority })))));

  it.each(cases)("matches the compatibility oracle: $fixture, authority=$authority, mapped=$mapped, tenant=$tenantId", async ({ mapped, tenantId, fixture, authority }) => {
    const publicId = mapped ? externalId : ownerId;
    const user = {
      id: publicId, isPrimaryUser: true, timeJoined: 1000, tenantIds: ["public", "other"],
      emails: ["old@example.com", "selected@example.com", "other@example.com"], phoneNumbers: [],
      loginMethods: [
        method(ownerId, "old@example.com", ["public"], 1000),
        method("public-recipe", "selected@example.com", ["public"], 2000),
        method("other-recipe", "other@example.com", ["other"], 3000),
      ],
    } as unknown as SuperTokensUser;
    const selectedOriginal = {
      data: { user_id: publicId, first_name: "Original name", custom: { original: true }, deleted: "Snapshot value" },
      state: "disabled", auth_level: "verified", verified_data: { custom: true },
      groups: [{ id: "selected-group" }],
      attributes: { custom_attribute: "selected", "rownd:app_variants": ["blue"],
        "rownd:app_variants_by_tenant": { other: ["green", "unconfigured"] } },
      meta: { original_only: "not a live overlay" },
    };
    const primary: RowndMetadata = {
      first_name: "Live name", custom: { live: true }, overlay_only: "owner overlay",
      deleted: "Live value", rownd_migration_complete: true,
      rownd_pending_verification: [{ id: "never publish operational authority", field: "email",
        value: "pending@example.com", created_at: "2026-01-01T00:00:00.000Z" }],
      original_rownd_user: mapped ? { data: { user_id: "wrong-source", first_name: "Wrong source" },
        state: "enabled", auth_level: "verified", verified_data: {}, groups: [{ id: "wrong-group" }] } : selectedOriginal,
    };
    const alias: RowndMetadata = {
      original_rownd_user: selectedOriginal,
      first_name: "Alias name", custom: { alias: true }, alias_only: "alias overlay", deleted: "Alias value",
      rownd_email_recipe_user_ids: { public: "public-recipe", other: "other-recipe" },
    };
    if (fixture === "deleted") {
      delete primary.first_name;
      delete primary.deleted;
      primary.rownd_profile_authoritative_fields = ["first_name", "deleted"];
    }
    if (fixture === "nested replacement") {
      primary.custom = { replacement: { nested_null: null } };
      primary.rownd_profile_authoritative_fields = ["custom"];
    }
    if (fixture === "literal null") primary.nullable = null;
    if (fixture === "tenant selectors") primary.rownd_email_recipe_user_ids = {
      public: "public-recipe", other: "other-recipe",
    };
    if (fixture === "empty selector authority") {
      primary.rownd_email_recipe_user_ids = {};
      primary.rownd_email_recipe_user_id = "public-recipe";
    }
    const records = new Map<string, RowndMetadata>([
      [ownerId, primary], [externalId, alias],
      ["public-recipe", { linked_custom: "linked overlay", custom: { linked: true } }],
      ["other-recipe", {}],
    ]);
    const getUser = vi.spyOn(SuperTokens, "getUser").mockResolvedValue(user);
    const getMapping = vi.spyOn(SuperTokens, "getUserIdMapping").mockImplementation(async ({ userIdType }) =>
      mapped && userIdType === "EXTERNAL"
        ? { status: "OK", superTokensUserId: ownerId, externalUserId: externalId, externalUserIdInfo: undefined }
        : { status: "UNKNOWN_MAPPING_ERROR" });
    const getMetadata = vi.spyOn(UserMetadata, "getUserMetadata").mockImplementation(async (id) => ({
      status: "OK", metadata: structuredClone(records.get(id) ?? {}),
    }));
    setPluginConfig(config);
    const oracle = await inspectLinkedUserMetadata(publicId);
    const expected = assembleUserProfile(publicId, tenantId, user, oracle.combinedMetadata, config, "profile");
    const expectedClaims = buildConfiguredSessionClaims(oracle.combinedMetadata, config);
    const expectedSession = buildRowndSessionClaimPayload({
      userId: publicId, user, metadata: oracle.combinedMetadata, pluginConfig: config,
      appVariantId: "blue", authenticationOrigin: "authenticated",
    });
    const before = structuredClone(oracle.combinedMetadata);
    vi.clearAllMocks();

    const published = getCanonicalPresentationMetadata(oracle.combinedMetadata);
    expect(oracle.combinedMetadata).toEqual(before);
    expect(getCanonicalPresentationMetadata(published)).toEqual(published);
    const expectedAuthority = getAuthoritativeProfileFields(oracle.combinedMetadata);
    if (authority !== "legacy") {
      // Only the canonical projection may consume markers; the compatibility oracle always uses the legacy array.
      delete published.rownd_profile_authoritative_fields;
      for (const [index, field] of expectedAuthority.entries()) {
        if (authority === "mixed" && index === 0) published.rownd_profile_authoritative_fields = [field];
        else published[`${ROWND_PROFILE_AUTHORITY_PREFIX}${field}`] = true;
      }
    }
    const canonicalConfig = { ...config, metadataMode: "canonical" } as const;
    setPluginConfig(canonicalConfig);
    expect(getAuthoritativeProfileFields(published)).toEqual(expectedAuthority);
    expect(published).not.toHaveProperty("rownd_pending_verification");
    expect(published).not.toHaveProperty("rownd_migration_complete");
    expect(published.original_rownd_user).not.toHaveProperty("meta");
    expect(published.original_rownd_user?.state).toBe("disabled");
    expect(published.original_rownd_user?.groups).toEqual([{ id: "selected-group" }]);
    expect(assembleUserProfile(publicId, tenantId, user, published, canonicalConfig, "profile")).toEqual(expected);
    expect(buildConfiguredSessionClaims(published, canonicalConfig)).toEqual(expectedClaims);
    expect(buildRowndSessionClaimPayload({ userId: publicId, user, metadata: published, pluginConfig: canonicalConfig,
      appVariantId: "blue", authenticationOrigin: "authenticated" })).toEqual(expectedSession);
    expect(getUser).not.toHaveBeenCalled();
    expect(getMapping).not.toHaveBeenCalled();
    expect(getMetadata).not.toHaveBeenCalled();

    expect(expected.rownd_user).toBe(publicId);
    expect(expected.data.user_id).toBe(publicId);
    expect(expected.data.first_name).toBe(fixture === "deleted" ? undefined : "Live name");
    expect(expected.data.unfilled).toBe("");
    for (const projected of [expected.data, expected.meta, expectedClaims, expectedSession]) {
      expect(Object.keys(projected).some((key) => key.startsWith(ROWND_PROFILE_AUTHORITY_PREFIX) ||
        key === "rownd_profile_authoritative_fields")).toBe(false);
    }
    if (fixture === "literal null") {
      expect(published).toHaveProperty("nullable", null);
      expect(expected.data.nullable).toBeNull();
      expect(expectedClaims).toHaveProperty("nullable", null);
    } else {
      expect(published).not.toHaveProperty("nullable");
      expect(expected.data.nullable).toBe("");
      expect(expectedClaims).not.toHaveProperty("nullable");
    }
    expect(expected.meta.overlay_only).toBe("owner overlay");
    expect(expected.meta.linked_custom).toBe("linked overlay");
    expect(expected.attributes?.["rownd:app_variants"]).toEqual(tenantId === "public" ? ["blue"] : ["green"]);
    if (fixture === "deleted") {
      expect(expected.data).not.toHaveProperty("deleted");
      expect(expectedClaims).not.toHaveProperty("deleted");
      expect(expectedClaims).not.toHaveProperty("first_name");
    } else expect(expectedClaims.first_name).toBe("Original name");
    if (fixture === "nested replacement") {
      expect(expected.data.custom).toEqual({ replacement: { nested_null: null } });
      expect(expectedClaims.custom_claim).toEqual({ replacement: { nested_null: null } });
    } else expect(expectedClaims.custom_claim).toEqual({ original: true });
    if (tenantId === "public") {
      expect(expected.data.email).toBe(fixture === "tenant selectors" ||
        (mapped && fixture !== "empty selector authority") ? "selected@example.com" : "old@example.com");
    } else expect(expected.data.email).toBe("other@example.com");

    records.set(publicId, published);
    const canonical = await inspectUserPresentationMetadata(publicId);
    expect(canonical.combinedMetadata).toEqual(published);
    expect(getUser).toHaveBeenCalledTimes(1);
    expect(getMapping).not.toHaveBeenCalled();
    expect(getMetadata).toHaveBeenCalledTimes(1);
    expect(getMetadata).toHaveBeenCalledWith(publicId, undefined);
  });
});

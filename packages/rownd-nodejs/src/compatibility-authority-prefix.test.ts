import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SuperTokens from "supertokens-node";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import { getPluginConfig, setPluginConfig } from "./config";
import { init } from "./plugin";
import {
  handleGetUserMeta,
  handleUpdateUser,
  handleUpdateUserField,
  handleUpdateUserMeta,
} from "./pluginImplementation";
import {
  buildConfiguredSessionClaims,
  buildRowndOAuthPayload,
  buildRowndOAuthUserInfo,
  buildRowndUserMetadata,
  getAuthoritativeProfileFields,
  getRowndProfileData,
  inspectUserPresentationMetadata,
  mergeMissingProfileMetadata,
  ROWND_APP_VARIANTS_KEY,
  ROWND_PROFILE_AUTHORITY_PREFIX,
  type RowndMetadata,
  type SuperTokensUser,
} from "./rownd-compatibility";
import { getUserById } from "./supertokens-repository";
import type { JsonRecord, JsonValue } from "./utils";

const marker = `${ROWND_PROFILE_AUTHORITY_PREFIX}first_name`;
const aliasMarker = `${ROWND_PROFILE_AUTHORITY_PREFIX}last_name`;
const absentField = `${ROWND_PROFILE_AUTHORITY_PREFIX}absent`;
const original = {
  data: { user_id: "legacy", first_name: "Original", last_name: "Family" },
  state: "enabled", auth_level: "verified", verified_data: {},
};
const user = {
  id: "owner", isPrimaryUser: true, timeJoined: 1000,
  tenantIds: ["public"], emails: [], phoneNumbers: [],
  loginMethods: [{
    recipeId: "passwordless", recipeUserId: SuperTokens.convertToRecipeUserId("alias"),
    timeJoined: 1000, tenantIds: ["public"], verified: true,
  }],
} as unknown as SuperTokensUser;
const initialConfig = getPluginConfig();
const schema = {
  [marker]: { display_name: "Legacy toggle", type: "boolean", user_visible: true, include_in_session_claims: true },
  [absentField]: { display_name: "Legacy text", type: "string", user_visible: true },
  [ROWND_APP_VARIANTS_KEY]: { display_name: "Legacy variants", type: "object", user_visible: true, include_in_session_claims: true },
};

type Handler = ReturnType<typeof handleGetUserMeta>;
function request(body: JsonRecord = {}, field?: string): Parameters<Handler>[0] {
  return {
    getJSONBody: async () => body,
    getHeaderValue: () => undefined,
    getKeyValueFromQuery: (key: string) => key === "field" ? field : undefined,
  } as unknown as Parameters<Handler>[0];
}
const response = {} as Parameters<Handler>[1];
const userContext = {} as Parameters<Handler>[3];
const session = {
  getUserId: () => user.id,
  getTenantId: () => "public",
} as Parameters<Handler>[2];

describe("legacy public metadata with canonical-looking keys", () => {
  beforeEach(() => {
    init({ disableRowndUserMigration: true, schema });
    const records = new Map<string, RowndMetadata>([
      [user.id, { original_rownd_user: original, [marker]: true,
        [ROWND_APP_VARIANTS_KEY]: { public: ["legacy-public"], app: "owner" } }],
      ["alias", { [aliasMarker]: true, [ROWND_APP_VARIANTS_KEY]: { alias: "linked" },
        rownd_profile_authoritative_fields: ["first_name", "last_name"] }],
    ]);
    vi.spyOn(SuperTokens, "getUser").mockResolvedValue(user);
    vi.spyOn(SuperTokens, "getUserIdMapping").mockResolvedValue({ status: "UNKNOWN_MAPPING_ERROR" });
    vi.spyOn(UserMetadata, "getUserMetadata").mockImplementation(async (id) => ({
      status: "OK", metadata: structuredClone(records.get(id) ?? {}),
    }));
    vi.spyOn(UserMetadata, "updateUserMetadata").mockImplementation(async (id, patch) => {
      const metadata = { ...records.get(id), ...patch };
      records.set(id, metadata);
      return { status: "OK", metadata };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setPluginConfig(initialConfig!);
  });

  it("matches the baseline profile, meta, configured claims and OAuth projections", async () => {
    const { combinedMetadata } = await inspectUserPresentationMetadata(user.id);
    expect(getAuthoritativeProfileFields(combinedMetadata)).toEqual([]);
    const profile = await getUserById(user.id);
    expect(profile.data).toEqual({
      user_id: "owner", first_name: "Original", last_name: "Family",
      "rownd_profile_authority:first_name": true,
      "rownd_profile_authority:absent": "",
      rownd_app_variants: { public: ["legacy-public"], app: "owner", alias: "linked" },
    });
    expect(profile.meta).toEqual({
      "rownd_profile_authority:last_name": true,
      created: "1970-01-01T00:00:01.000Z", first_sign_in: "1970-01-01T00:00:01.000Z",
      first_sign_in_method: "email", last_sign_in: null, last_active: null, last_sign_in_method: null,
    });
    expect(profile.attributes).toEqual({});
    const claims = {
      "rownd_profile_authority:first_name": true,
      rownd_app_variants: { public: ["legacy-public"], app: "owner", alias: "linked" },
    };
    expect(await handleGetUserMeta()(request(), response, session, userContext)).toEqual({
      status: "OK", id: "owner", meta: { ...claims, "rownd_profile_authority:last_name": true },
    });
    expect(buildConfiguredSessionClaims(combinedMetadata)).toEqual(claims);
    const oauthClaims = {
      name: "Original Family", given_name: "Original", family_name: "Family",
      app_user_id: "legacy", auth_level: "verified", is_verified_user: true,
      "https://auth.rownd.io/app_user_id": "legacy", "https://auth.rownd.io/auth_level": "verified",
      "https://auth.rownd.io/is_verified_user": true,
    };
    const payload = await buildRowndOAuthPayload({ user, scopes: ["profile"] });
    expect(payload).toEqual({ ...oauthClaims, ...claims });
    expect(await buildRowndOAuthUserInfo({ user, scopes: ["profile"], accessTokenPayload: payload }))
      .toEqual(oauthClaims);
  });

  it("imports and merges both public keys while honoring only the legacy authority array", () => {
    const imported = {
      ...original,
      data: { ...original.data, [marker]: true, [ROWND_APP_VARIANTS_KEY]: { source: "data" } },
      meta: { [aliasMarker]: true, [ROWND_APP_VARIANTS_KEY]: { source: "meta" } },
    };
    expect(buildRowndUserMetadata(imported)).toEqual({
      first_name: "Original", last_name: "Family",
      "rownd_profile_authority:first_name": true, "rownd_profile_authority:last_name": true,
      rownd_app_variants: { source: "data" }, original_rownd_user: imported, rownd_migration_complete: true,
    });
    const primary = { rownd_profile_authoritative_fields: ["deleted", "deleted"], [marker]: true };
    expect(getAuthoritativeProfileFields(primary)).toEqual(["deleted", "deleted"]);
    expect(mergeMissingProfileMetadata(primary, {
      [aliasMarker]: true, [ROWND_APP_VARIANTS_KEY]: { source: "alias" },
      first_name: "Imported", deleted: "Stale", rownd_profile_authoritative_fields: ["first_name"],
    })).toEqual({
      rownd_profile_authoritative_fields: ["deleted", "deleted"], "rownd_profile_authority:first_name": true,
      "rownd_profile_authority:last_name": true, rownd_app_variants: { source: "alias" }, first_name: "Imported",
    });
  });

  it("keeps the baseline authority lookup when the field is not an own property", () => {
    const metadata: RowndMetadata = Object.assign(Object.create({ first_name: "Inherited" }), {
      original_rownd_user: original, rownd_profile_authoritative_fields: ["first_name"],
    });
    expect(getRowndProfileData(metadata)).toEqual({ user_id: "legacy", first_name: "Inherited", last_name: "Family" });
    init({ disableRowndUserMigration: true, metadataMode: "canonical" });
    expect(getRowndProfileData(metadata)).toEqual({ user_id: "legacy", last_name: "Family" });
  });

  const reservedPatches: [string, JsonValue][] = [[marker, true], [ROWND_APP_VARIANTS_KEY, { public: ["app"] }]];
  const cases = (["full", "field", "meta"] as const).flatMap((route) =>
    reservedPatches.flatMap(([field, value]) => (["canonical", "compatibility"] as const)
      .map((metadataMode) => ({ route, field, value, metadataMode }))));

  it.each(cases)("$route PUT for '$field' in $metadataMode mode", async ({ route, field, value, metadataMode }) => {
    init({ disableRowndUserMigration: true, metadataMode, schema });
    const deps: Parameters<typeof handleUpdateUser>[0] = {
      pluginConfig: getPluginConfig()!,
      stConfig: {} as Parameters<typeof handleUpdateUser>[0]["stConfig"],
      telemetryClient: { recordEvent: vi.fn(), recordSuccess: vi.fn(), recordError: vi.fn() },
    };
    const handler = route === "full" ? handleUpdateUser(deps)
      : route === "field" ? handleUpdateUserField(deps) : handleUpdateUserMeta();
    const patch = { [field]: value };
    const body = route === "full"
      ? { data: metadataMode === "canonical" ? { email: "new@example.com", ...patch } : patch }
      : route === "field" ? { value } : { meta: patch };
    const result = await handler(request(body, field), response, session, userContext);
    if (metadataMode === "canonical") {
      expect(result).toEqual({ status: "ERROR", code: 403, message: `field is not writable: ${field}` });
      expect(UserMetadata.updateUserMetadata).not.toHaveBeenCalled();
    } else {
      expect(result.status).toBe("OK");
      expect(UserMetadata.updateUserMetadata).toHaveBeenCalledTimes(1);
      expect(UserMetadata.updateUserMetadata).toHaveBeenCalledWith(user.id,
        { ...patch, rownd_profile_authoritative_fields: [field] }, expect.any(Object));
    }
  });

  it.each(["full", "field"] as const)("canonical %s PUT rejects internal fields even when configured as writable", async (route) => {
    init({ disableRowndUserMigration: true, metadataMode: "canonical",
      schema: { ...schema, original_rownd_user: { display_name: "Internal", type: "object", user_visible: true } } });
    const deps: Parameters<typeof handleUpdateUser>[0] = {
      pluginConfig: getPluginConfig()!,
      stConfig: {} as Parameters<typeof handleUpdateUser>[0]["stConfig"],
      telemetryClient: { recordEvent: vi.fn(), recordSuccess: vi.fn(), recordError: vi.fn() },
    };
    const value = { data: { email: "forged@example.com" } };
    const result = route === "full"
      ? await handleUpdateUser(deps)(request({ data: { original_rownd_user: value } }), response, session, userContext)
      : await handleUpdateUserField(deps)(request({ value }, "original_rownd_user"), response, session, userContext);
    expect(result).toEqual({ status: "ERROR", code: 403, message: "field is not writable: original_rownd_user" });
    expect(UserMetadata.updateUserMetadata).not.toHaveBeenCalled();
  });

  it.each(["canonical", "compatibility"] as const)("%s full PUT does not let an empty field name skip later checks", async (metadataMode) => {
    init({ disableRowndUserMigration: true, metadataMode, schema });
    const deps: Parameters<typeof handleUpdateUser>[0] = {
      pluginConfig: getPluginConfig()!,
      stConfig: {} as Parameters<typeof handleUpdateUser>[0]["stConfig"],
      telemetryClient: { recordEvent: vi.fn(), recordSuccess: vi.fn(), recordError: vi.fn() },
    };
    const result = await handleUpdateUser(deps)(
      request({ data: { "": "x", original_rownd_user: { data: {} } } }), response, session, userContext);
    expect(result).toEqual({ status: "ERROR", code: 403, message: "field is not writable: " });
    expect(UserMetadata.updateUserMetadata).not.toHaveBeenCalled();
  });
});

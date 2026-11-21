import { describe, expect, it } from "vitest";
import type { SuperTokensPublicConfig } from "supertokens-node/types";
import { buildRowndAppConfig } from "./config";
import { canUpdateUserDataField } from "./rownd-compatibility";
import type { RowndCustomContent, RowndPluginNormalisedConfig } from "./types";

const superTokensConfig: SuperTokensPublicConfig = {
  appInfo: {
    appName: "Test app",
    apiDomain: "http://localhost:3000",
    websiteDomain: "http://localhost:3001",
  },
  recipeList: [],
};

function buildCustomContent(customContent?: RowndCustomContent) {
  const config: RowndPluginNormalisedConfig = {
    rowndAppKey: "app-key",
    disableRowndUserMigration: true,
    emailChange: { maxSessionAgeSeconds: 600 },
    appConfig: { customContent },
  };
  return buildRowndAppConfig(config, superTokensConfig)!.app.config.hub
    .custom_content;
}

describe("profile modal custom content", () => {
  it("keeps profile overrides absent when omitted", () => {
    expect(buildCustomContent()).not.toHaveProperty("profile_modal");
  });

  it.each(["My profile", ""])(
    "preserves the existing title %j without a conflict override",
    (title) => {
      expect(buildCustomContent({ profileModal: { title } }).profile_modal)
        .toEqual({ title });
    },
  );

  it.each([
    "Please use another email address.",
    "  Try <strong>another</strong> email: {{email}}.\nContact support.  ",
  ])("serializes custom conflict copy unchanged: %j", (emailConflictMessage) => {
    const content = buildCustomContent({
      profileModal: { title: "My profile", emailConflictMessage },
    });
    expect(content.profile_modal).toEqual({
      title: "My profile",
      email_conflict_message: emailConflictMessage,
    });
  });

  it("allows a conflict override without a title", () => {
    expect(buildCustomContent({
      profileModal: { emailConflictMessage: "Try another email." },
    }).profile_modal).toEqual({ email_conflict_message: "Try another email." });
  });

  it("omits an empty conflict override so the Hub can use its default", () => {
    expect(buildCustomContent({
      profileModal: { title: "My profile", emailConflictMessage: "" },
    }).profile_modal).toEqual({ title: "My profile" });
  });
});

describe("synthesized sign-in schema fields", () => {
  function buildConfig(schema?: RowndPluginNormalisedConfig["schema"]): RowndPluginNormalisedConfig {
    return {
      rowndAppKey: "app-key",
      disableRowndUserMigration: true,
      emailChange: { maxSessionAgeSeconds: 600 },
      schema,
      appConfig: { signInMethods: [{ method: "phone" }] },
    };
  }

  it("marks a synthesized phone_number read-only because the plugin rejects writes to it", () => {
    const config = buildConfig();
    const phoneField = buildRowndAppConfig(config, superTokensConfig)!.app.schema.phone_number;

    expect(phoneField).toMatchObject({ user_visible: true, read_only: true });
    expect(canUpdateUserDataField("phone_number", config)).toBe(false);
  });

  it("serializes an explicitly configured phone_number field unchanged", () => {
    const config = buildConfig({
      phone_number: { display_name: "Mobile", type: "string", user_visible: true },
    });

    expect(buildRowndAppConfig(config, superTokensConfig)!.app.schema.phone_number)
      .toMatchObject({ display_name: "Mobile", read_only: false });
    expect(canUpdateUserDataField("phone_number", config)).toBe(true);
  });
});

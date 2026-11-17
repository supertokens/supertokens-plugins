import { describe, expect, it } from "vitest";
import { convertRowndConfigToPluginConfig } from "./generateAppConfig";

function convertProfileModal(profileModal?: Record<string, unknown>) {
  return convertRowndConfigToPluginConfig({
    config: { hub: { custom_content: { profile_modal: profileModal } } },
  }, { appKey: "app-key", appSecret: "app-secret" }).appConfig!.customContent!;
}

describe("profile modal custom content import", () => {
  it("keeps profile overrides absent when omitted", () => {
    expect(convertProfileModal()).not.toHaveProperty("profileModal");
  });

  it.each(["My profile", ""])(
    "preserves the existing title %j without a conflict override",
    (title) => {
      expect(convertProfileModal({ title }).profileModal).toEqual({ title });
    },
  );

  it.each([
    "Please use another email address.",
    "  Try <strong>another</strong> email: {{email}}.\nContact support.  ",
    "",
  ])("imports custom conflict copy unchanged: %j", (emailConflictMessage) => {
    expect(convertProfileModal({
      title: "My profile", email_conflict_message: emailConflictMessage,
    }).profileModal).toEqual({ title: "My profile", emailConflictMessage });
  });

  it("imports a conflict override without a title", () => {
    expect(convertProfileModal({
      email_conflict_message: "Try another email.",
    }).profileModal).toEqual({ emailConflictMessage: "Try another email." });
  });

  it("ignores a non-string conflict override", () => {
    expect(convertProfileModal({
      title: "My profile", email_conflict_message: 42,
    }).profileModal).toEqual({ title: "My profile" });
  });
});

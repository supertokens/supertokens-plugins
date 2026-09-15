import { describe, expect, it } from "vitest";
import { checkpointEmailPointer, hasCheckpointEmailHistory } from "./migration-owner-email";
import type { OwnerPlanCheckpoint } from "./migration-owner-plan";
import type { SuperTokensUserImport } from "./types";

function fixture() {
  const plan: OwnerPlanCheckpoint = {
    version: 2, id: "plan", sourceId: "winner", target: "target", status: "APPLYING", cursor: 0,
    candidates: [{ rownd_user_id: "old", supertokens_user_id: "target" }, { rownd_user_id: "winner" }], absentAliases: [],
    recipes: [{ id: "target", identity: "provider", verified: false }, { id: "email", identity: "passwordless", email: "old@example.com", verified: false }],
    aliases: [{ id: "old", from: "email", to: "target" }],
    operations: [{ kind: "delete_mapping", id: "email", alias: "old" }],
    initial: { graph: [{ id: "target", owner: "target", primary: true }, { id: "email", owner: "target", primary: true }],
      mappings: [{ id: "target" }, { id: "email", alias: "old" }], verifications: [],
      markers: [{ id: "target", values: { original_rownd_user: {
        data: { user_id: "old", email: "old@example.com", google_id: "subject" },
        verified_data: { email: "old@example.com", google_id: "subject" },
      } } }] },
  };
  const source = { externalUserId: "winner", loginMethods: [{ recipeId: "thirdparty", thirdPartyId: "google", thirdPartyUserId: "subject" }] } as SuperTokensUserImport;
  return { plan, source };
}

describe("checkpoint email provenance", () => {
  it("resolves a recorded alias at the delete-response gap but not before its operation", () => {
    const { plan } = fixture();
    expect(checkpointEmailPointer(plan, "old")).toBe("email");
    plan.operations.unshift({ kind: "promote", id: "target" });
    expect(checkpointEmailPointer(plan, "old")).toBeUndefined();
    plan.cursor = 1;
    expect(checkpointEmailPointer(plan, "old")).toBe("email");
    expect(checkpointEmailPointer(plan, "unrecorded")).toBeUndefined();
    plan.operations[1] = { kind: "delete_mapping", id: "other", alias: "old" };
    expect(checkpointEmailPointer(plan, "old")).toBeUndefined();
  });

  it("requires exact historical address, snapshot verification, provider identity and initial ownership", () => {
    const { plan, source } = fixture();
    expect(hasCheckpointEmailHistory(plan, source, "email", "old@example.com")).toBe(true);
    expect(hasCheckpointEmailHistory(plan, source, "email", "o.ld@example.com")).toBe(false);
    expect(hasCheckpointEmailHistory(plan, source, "other", "old@example.com")).toBe(false);
    const snapshot = plan.initial.markers[0]!.values.original_rownd_user as { verified_data: { email: string; google_id: string } };
    snapshot.verified_data.email = "other@example.com";
    expect(hasCheckpointEmailHistory(plan, source, "email", "old@example.com")).toBe(false);
    snapshot.verified_data.email = "old@example.com";
    snapshot.verified_data.google_id = "other-subject";
    expect(hasCheckpointEmailHistory(plan, source, "email", "old@example.com")).toBe(false);
    snapshot.verified_data.google_id = "subject";
    plan.initial.graph[1]!.owner = "other-owner";
    expect(hasCheckpointEmailHistory(plan, source, "email", "old@example.com")).toBe(false);
  });
});

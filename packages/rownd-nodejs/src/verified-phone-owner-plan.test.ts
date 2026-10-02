import { expect, it } from "vitest";
import { inspectCheckpointVerifiedPhoneSurvivor } from "./migration-phone-election";
import { ownerStateAt, planOwnerOperations, type OwnerPlanCheckpoint } from "./migration-owner-plan";

function fixture(): OwnerPlanCheckpoint {
  return {
    version: 2, id: "plan", sourceId: "newer", target: "phone-owner", cursor: 0, status: "READY",
    candidates: [{ rownd_user_id: "newer" }, { rownd_user_id: "older", supertokens_user_id: "phone-owner" }],
    absentAliases: ["newer"],
    recipes: [{ id: "phone-owner", verified: true, identity: JSON.stringify(["passwordless", null, "+15551234567", null, ["public"], 1, null]) }],
    aliases: [{ id: "newer", to: "phone-owner" }],
    retiredAliases: [{ id: "older", from: "phone-owner" }],
    initial: {
      graph: [{ id: "phone-owner", owner: "phone-owner", primary: false }],
      mappings: [{ id: "phone-owner", alias: "older" }],
      markers: ["phone-owner", "older", "newer"].map((id) => ({ id, values: {} })),
      verifications: [],
    },
    operations: [],
  };
}

it("plans ownerless phone winner publication with displaced-alias retirement and resumable standalone proof", () => {
  const plan = fixture();
  const result = planOwnerOperations({ ...plan, profile: { data: { user_id: "newer", phone_number: "+15551234567" }, verified_data: { phone_number: "+15551234567" } } });
  expect(result.status).toBe("PLAN");
  if (result.status !== "PLAN") throw new Error("Missing owner plan");
  plan.operations = result.actions;
  const deletion = plan.operations.findIndex((operation) => operation.kind === "delete_mapping");
  const publication = plan.operations.findIndex((operation) => operation.kind === "create_mapping");
  expect(deletion).toBeGreaterThan(0);
  expect(publication).toBeGreaterThan(deletion);
  for (let cursor = 1; cursor <= plan.operations.length; cursor++) {
    const resumed = { ...plan, cursor, status: "APPLYING" as const };
    expect(inspectCheckpointVerifiedPhoneSurvivor(resumed, "public")).toEqual({ phoneNumber: "+15551234567", supertokensUserId: "phone-owner" });
  }
  const final = ownerStateAt(plan, plan.operations.length);
  expect(final.graph).toEqual([{ id: "phone-owner", owner: "phone-owner", primary: true }]);
  expect(final.mappings).toEqual([{ id: "phone-owner", alias: "newer" }]);
  expect(final.markers.find((entry) => entry.id === "older")?.values).toMatchObject({ rownd_migration_superseded: { rowndUserId: "newer", targetUserId: "phone-owner" } });
});

it("cannot use a primary, multi-method, unverified, or cross-tenant checkpoint baseline for phone election", () => {
  const primary = fixture();
  primary.initial.graph[0]!.primary = true;
  const multi = fixture();
  multi.initial.graph.push({ id: "other", owner: "phone-owner", primary: false });
  const unverified = fixture();
  unverified.recipes[0]!.verified = false;
  for (const plan of [primary, multi, unverified])
    expect(inspectCheckpointVerifiedPhoneSurvivor(plan, "public")).toBeUndefined();
  expect(inspectCheckpointVerifiedPhoneSurvivor(fixture(), "other")).toBeUndefined();
});

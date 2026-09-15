import { describe, expect, it } from "vitest";
import { methodPlanAllows, planMethods, type ImportMethod, type MethodRecipe, type MethodSnapshot } from "./migration-method-plan";

const email: ImportMethod = { recipeId: "passwordless", email: "a@example.test", isVerified: false, tenantIds: ["public"], isPrimary: false };
const google: ImportMethod = { recipeId: "thirdparty", thirdPartyId: "google", thirdPartyUserId: "subject", email: "provider@example.test", isVerified: false, tenantIds: ["public"], isPrimary: false };
const target: MethodRecipe = { id: "target", owner: "target", primary: true, ownerMethodCount: 1, recipeId: "passwordless", email: "a@example.test", verified: false, tenantIds: ["public"] };
function snapshot(): MethodSnapshot {
  return { tenantId: "public", administrative: true, contactEmail: "a@example.test", sourceMethods: [email, google],
    preferred: { id: "target", primary: true, recipes: [target] }, currentEmailRepair: false, recipes: [target],
    inspections: [{ method: google, owners: [], incidentalOwners: [] }] };
}

describe("pure method reconciliation planning", () => {
  it.each(["verified", "unverified", "primary", "multiple methods", "multiple tenants", "different tenant"])(
    "checks administrative phone ownership before electing a %s contact", (kind) => {
      const phone: ImportMethod = { recipeId: "passwordless", phoneNumber: "+12025550101", isVerified: kind !== "unverified" };
      const recipe: MethodRecipe = { ...target, email: undefined, phoneNumber: phone.phoneNumber,
        primary: kind === "primary", ownerMethodCount: kind === "multiple methods" ? 2 : 1,
        tenantIds: kind === "multiple tenants" ? ["public", "other"] : kind === "different tenant" ? ["other"] : ["public"] };
      const plan = planMethods({ ...snapshot(), preferred: undefined, contactEmail: undefined, sourceMethods: [phone], recipes: [recipe],
        inspections: [{ method: phone, owners: [recipe], incidentalOwners: [] }] });
      expect(plan).toMatchObject(kind === "verified" ? { status: "PLAN", target: { id: recipe.owner } } : { status: "BLOCKED", code: "CONTACT_ELECTION" });
    },
  );

  it("plans creation followed by a symbolic link, without changing the discovery snapshot", () => {
    const input = snapshot();
    const before = structuredClone(input);
    const plan = planMethods(input);
    expect(plan).toMatchObject({ status: "PLAN", actions: [
      { kind: "CREATE_THIRDPARTY", recipe: { kind: "created", key: "method:0" }, method: google },
      { kind: "LINK", recipe: { kind: "created", key: "method:0" }, target: "target", method: google },
    ] });
    expect(input).toEqual(before);
    expect(planMethods(input)).toEqual(plan);
  });

  it("uses atomic unverified import for an administrative passwordless create", () => {
    const input = snapshot();
    input.inspections = [{ method: email, owners: [], incidentalOwners: [] }];
    expect(planMethods(input)).toMatchObject({ actions: [{ kind: "CREATE_PASSWORDLESS", strategy: "IMPORT_UNVERIFIED" }, { kind: "LINK" }] });
    input.verifiedEmail = "a@example.test";
    expect(planMethods(input)).toMatchObject({ actions: [{ kind: "CREATE_PASSWORDLESS", strategy: "SIGN_IN_UP" }, { kind: "LINK" }, { kind: "VERIFY_ADMIN_EMAIL", email: "a@example.test" }] });
  });

  it("links an exact standalone provider rather than creating another credential", () => {
    const input = snapshot();
    const recipe = { ...target, id: "provider", owner: "provider", primary: false, recipeId: "thirdparty", thirdParty: { id: "google", userId: "subject" } };
    input.inspections = [{ method: google, owners: [recipe], match: recipe, reconciliationMatch: recipe, incidentalOwners: [] }];
    expect(planMethods(input)).toMatchObject({ actions: [{ kind: "LINK", recipe: { kind: "existing", id: "provider" }, expectedOwner: "provider", target: "target" }] });
    recipe.primary = true;
    expect(planMethods(input)).toMatchObject({ status: "BLOCKED", code: "FOREIGN_OWNER_NOT_ELIGIBLE" });
  });

  it("blocks a discoverable incompatible owner even when another method could be created", () => {
    const input = snapshot();
    input.inspections.push({ method: email, owners: [{ ...target, id: "foreign", owner: "foreign" }], incidentalOwners: [] });
    expect(planMethods(input)).toMatchObject({ status: "BLOCKED", code: "FOREIGN_OWNER_NOT_ELIGIBLE" });
  });

  it("blocks incidental contact conflicts before any creation is planned", () => {
    const input = snapshot();
    input.inspections[0]!.incidentalOwners.push("foreign-primary");
    expect(planMethods(input)).toMatchObject({ status: "BLOCKED", code: "INCIDENTAL_CONTACT_CONFLICT" });
  });

  it("does not invent unsupported email-password creation for an existing target", () => {
    const input = snapshot();
    input.inspections = [{ method: { ...email, recipeId: "emailpassword", email: "a@example.test", passwordHash: "hash" }, owners: [], incidentalOwners: [] }];
    expect(planMethods(input)).toMatchObject({ status: "BLOCKED", code: "UNSUPPORTED_METHOD_CREATION" });
  });

  it("does not allow executor rediscovery to select a different policy", () => {
    const planned = planMethods(snapshot());
    const changed = snapshot();
    changed.inspections.push({ method: email, owners: [], incidentalOwners: [] });
    expect(methodPlanAllows(planned, planMethods(changed))).toBe(false);
    expect(methodPlanAllows(planned, planned)).toBe(true);
  });

  it("returns NOOP for an existing primary with no method work", () => {
    expect(planMethods({ ...snapshot(), inspections: [] })).toMatchObject({ status: "NOOP", actions: [] });
  });

  it("retains verified email linking through an existing exact phone anchor", () => {
    const phone: ImportMethod = { recipeId: "passwordless", phoneNumber: "+12025550101", isVerified: true };
    const phoneRecipe = { ...target, email: undefined, phoneNumber: phone.phoneNumber };
    const donor = { ...target, id: "email", owner: "email", primary: false, verified: true };
    const verifiedEmail = { ...email, isVerified: true };
    const input: MethodSnapshot = { ...snapshot(), administrative: false, contactEmail: undefined, sourceMethods: [phone, verifiedEmail],
      preferred: { id: "target", primary: true, recipes: [phoneRecipe] }, recipes: [phoneRecipe, donor],
      inspections: [{ method: verifiedEmail, owners: [donor], match: donor, reconciliationMatch: donor, incidentalOwners: [] }] };
    expect(planMethods(input)).toMatchObject({ status: "PLAN", actions: [
      { kind: "LINK", recipe: { kind: "existing", id: "email" } },
      { kind: "SET_EMAIL_VERIFICATION", recipe: { kind: "existing", id: "email" }, verified: true },
    ] });
    input.preferred!.recipes = [target];
    expect(planMethods(input)).toMatchObject({ status: "BLOCKED" });
  });

  it("selects the exact provider before a contact match when there is no ID-bound owner", () => {
    const provider = { ...target, id: "provider", owner: "provider", primary: false, recipeId: "thirdparty", thirdParty: { id: "google", userId: "subject" } };
    const donor = { ...target, id: "email", owner: "email", primary: false };
    const input: MethodSnapshot = { ...snapshot(), preferred: undefined, recipes: [provider, donor], inspections: [
      { method: email, owners: [donor], match: donor, reconciliationMatch: donor, incidentalOwners: [] },
      { method: google, owners: [provider], match: provider, reconciliationMatch: provider, incidentalOwners: [] },
    ] };
    expect(planMethods(input)).toMatchObject({ status: "PLAN", target: { id: "provider" }, actions: [
      { kind: "ENSURE_PRIMARY", target: "provider" }, { kind: "LINK", target: "provider", recipe: { id: "email" } },
    ] });
  });
});

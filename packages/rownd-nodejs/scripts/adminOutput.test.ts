import { expect, it } from "vitest";
import { formatReconcileResult } from "./adminOutput";
import { profileSchema, type Profile } from "./profiles";

it("does not expose escaped secrets or arbitrary transport messages", () => {
  const profile: Profile = { rownd: { appId: "app", appKey: 'key"\\quoted', appSecret: 'secret\\"value' },
    supertokens: { connectionURI: "http://localhost:3567", apiKey: 'core"\\key', tenantId: "public" } };
  const message = JSON.stringify({ headers: profile, url: "http://user:encoded%22password@localhost" });
  const output = formatReconcileResult({ status: "ERROR", changed: false, actions: [profile.rownd.appSecret], message }, profile);
  const parsed = JSON.parse(output);
  expect(parsed.actions).toEqual(["***"]);
  expect(parsed.message).toBe("Reconciliation failed; check profile configuration and service availability");
  for (const secret of ["encoded", "quoted", "value", "headers", "core"]) expect(output).not.toContain(secret);
});

it.each(["http://user:password@localhost:3567", "https://user:pass%22word@localhost", "ftp://localhost"])("rejects unsupported or credential-bearing connection URI %s", (connectionURI) => {
  expect(profileSchema.safeParse({ rownd: { appId: "app", appKey: "key", appSecret: "secret" }, supertokens: { connectionURI } }).success).toBe(false);
});

it("keeps unknown change state without exposing the final observation error", () => {
  const profile: Profile = { rownd: { appId: "app", appKey: "key", appSecret: "secret" },
    supertokens: { connectionURI: "http://localhost:3567", tenantId: "public" } };
  const output = formatReconcileResult({ status: "ERROR", changed: null, actions: [], partialProgress: true,
    message: "Mutation failed", observationError: "Request headers contained an unrelated-private-token" }, profile);
  expect(JSON.parse(output)).toMatchObject({
    status: "ERROR", changed: null, partialProgress: true, observationError: "Final state could not be observed",
  });
  expect(output).not.toContain("unrelated-private-token");
});

it("preserves allowlisted policy and observation diagnostics, redacted before JSON encoding", () => {
  const profile: Profile = { rownd: { appId: "app", appKey: "target", appSecret: "secret" },
    supertokens: { connectionURI: "http://localhost:3567", tenantId: "public" } };
  expect(JSON.parse(formatReconcileResult({ status: "BLOCKED", changed: null, actions: [],
    message: "SOURCE_PAYLOAD_INVALID: data.email, verified_data.google_id",
    observationError: "The reconciliation target changed" }, profile))).toMatchObject({
    message: "SOURCE_PAYLOAD_INVALID: data.email, verified_data.google_id", observationError: "The reconciliation *** changed",
  });
});

it("formats PREVIEW separately and redacts secrets inside nested proposed actions", () => {
  const profile: Profile = { rownd: { appId: "app", appKey: 'key"\\quoted', appSecret: 'secret\\"value' },
    supertokens: { connectionURI: "http://localhost:3567", apiKey: "core-private-key", tenantId: "public" } };
  const output = formatReconcileResult({ status: "PREVIEW", changed: false, actions: [], dryRun: true, canReconcile: false,
    snapshotOnly: true, matchesSource: false, blockers: [], requiresExecutionProof: [{ code: "PROVIDER_RETIREMENT_PROOF_REQUIRED" }],
    proposedActions: [{ action: "review_provider_retirement", conditional: true, recipeUserId: profile.rownd.appKey,
      email: encodeURIComponent(profile.rownd.appSecret) }], message: "request headers contained unknown-secret-token" }, profile);
  expect(JSON.parse(output)).toMatchObject({ status: "PREVIEW", dryRun: true, canReconcile: false,
    proposedActions: [{ recipeUserId: "***", email: "***", conditional: true }] });
  for (const secret of ["quoted", "value", "unknown-secret-token", "headers"]) expect(output).not.toContain(secret);
});

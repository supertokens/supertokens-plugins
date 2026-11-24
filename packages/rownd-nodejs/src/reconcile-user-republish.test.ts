import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPluginConfig, setPluginConfig } from "./config";
import { init } from "./plugin";
import type { ReconcileUserResult } from "./reconcile-user";
import type { RowndMetadataMode } from "./types";

const fixture = vi.hoisted(() => ({ result: undefined as unknown, republish: vi.fn() }));

vi.mock("./reconciliation-reads", async (importOriginal) => ({
  ...await importOriginal<typeof import("./reconciliation-reads")>(),
  withReconciliationReads: async () => fixture.result,
}));
vi.mock("./canonical-republish", () => ({ republishAfterMigration: fixture.republish }));

const { reconcileUser } = await import("./reconcile-user");
const initialConfig = getPluginConfig();

describe("administrative reconciliation in dual-write mode", () => {
  function configure(metadataMode: RowndMetadataMode) {
    init({ metadataMode, rowndAppId: "app" });
  }

  beforeEach(() => {
    fixture.republish.mockReset().mockResolvedValue({ status: "UNCHANGED" });
  });

  afterEach(() => {
    setPluginConfig(initialConfig!);
  });

  const result = (overrides: Partial<ReconcileUserResult>): ReconcileUserResult =>
    ({ status: "OK", changed: true, actions: [], rownd_user_id: "rownd-owner", ...overrides });

  it.each([
    { name: "a changed owner", result: result({}), republished: true },
    { name: "an owner of unknown change", result: result({ changed: null }), republished: true },
    { name: "a blocked run with partial progress", result: result({ status: "BLOCKED", changed: false, partialProgress: true }), republished: true },
    { name: "an unchanged owner", result: result({ changed: false }), republished: false },
    { name: "a run without a resolved owner", result: result({ rownd_user_id: undefined }), republished: false },
  ])("republishes $name only when owner state may have changed", async ({ result: outcome, republished }) => {
    configure("dual-write");
    fixture.result = outcome;
    expect(await reconcileUser({ rownd_user_id: "rownd-owner" })).toBe(outcome);
    expect(fixture.republish).toHaveBeenCalledTimes(republished ? 1 : 0);
    if (republished) expect(fixture.republish).toHaveBeenCalledWith(expect.objectContaining({ userId: "rownd-owner" }));
  });

  it("never republishes a dry run", async () => {
    configure("dual-write");
    fixture.result = result({});
    await reconcileUser({ rownd_user_id: "rownd-owner", dryRun: true });
    expect(fixture.republish).not.toHaveBeenCalled();
  });

  it("leaves compatibility mode unchanged", async () => {
    configure("compatibility");
    fixture.result = result({});
    await reconcileUser({ rownd_user_id: "rownd-owner" });
    expect(fixture.republish).not.toHaveBeenCalled();
  });
});

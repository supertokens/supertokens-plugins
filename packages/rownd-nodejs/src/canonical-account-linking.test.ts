import { afterEach, expect, it, vi } from "vitest";
import { getPluginConfig, setPluginConfig } from "./config";
import { init } from "./plugin";
import { shouldLinkRowndAccounts } from "./rownd-compatibility";
import type { RowndPluginConfig } from "./types";

vi.mock("./rownd-compatibility", async (importOriginal) => ({
  ...await importOriginal<typeof import("./rownd-compatibility")>(),
  shouldLinkRowndAccounts: vi.fn(),
}));

const initialConfig = getPluginConfig();
const rowndDecision = vi.mocked(shouldLinkRowndAccounts);

afterEach(() => {
  rowndDecision.mockReset();
  setPluginConfig(initialConfig!);
});

function configureLinking(metadataMode?: RowndPluginConfig["metadataMode"]) {
  const appDecision = vi.fn(async () => ({
    shouldAutomaticallyLink: true as const,
    shouldRequireVerification: true,
  }));
  const plugin = init({ disableRowndUserMigration: true, metadataMode });
  const { shouldDoAutomaticAccountLinking } = plugin.overrideMap!.accountlinking!.config!({
    shouldDoAutomaticAccountLinking: appDecision,
  });
  const input: Parameters<NonNullable<typeof shouldDoAutomaticAccountLinking>> = [
    { recipeId: "passwordless", email: "test@example.com" },
    undefined,
    undefined,
    "public",
    {} as Parameters<NonNullable<typeof shouldDoAutomaticAccountLinking>>[4],
  ];
  return { decide: () => shouldDoAutomaticAccountLinking!(...input), appDecision, input };
}

it("denies automatic linking in canonical mode before Rownd or the app decides", async () => {
  rowndDecision.mockResolvedValue(undefined);
  const { decide, appDecision } = configureLinking("canonical");

  await expect(decide()).resolves.toEqual({ shouldAutomaticallyLink: false });
  expect(rowndDecision).not.toHaveBeenCalled();
  expect(appDecision).not.toHaveBeenCalled();
});

it("defers to the app in default compatibility mode when Rownd has no decision", async () => {
  rowndDecision.mockResolvedValue(undefined);
  const { decide, appDecision, input } = configureLinking();

  await expect(decide()).resolves.toEqual({
    shouldAutomaticallyLink: true,
    shouldRequireVerification: true,
  });
  expect(rowndDecision.mock.calls).toEqual([[input]]);
  expect(appDecision.mock.calls).toEqual([input]);
});

it("keeps the Rownd decision ahead of the app in compatibility mode", async () => {
  const result = { shouldAutomaticallyLink: true, shouldRequireVerification: false };
  rowndDecision.mockResolvedValue(result);
  const { decide, appDecision } = configureLinking("compatibility");

  await expect(decide()).resolves.toEqual(result);
  expect(appDecision).not.toHaveBeenCalled();
});

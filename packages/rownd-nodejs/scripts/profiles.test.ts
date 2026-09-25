import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { maskProfile, readProfiles, writeProfiles, type Profile } from "./profiles";
import { runAdmin } from "./admin";
import type { ProfileQuestion } from "./profilePrompt";

const directories: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
const profile: Profile = { rownd: { appId: "app", appKey: "secret-key", appSecret: "secret-value" }, supertokens: { connectionURI: "http://localhost:3567", apiKey: "core-secret", tenantId: "public" } };

it("atomically round-trips owner-only profiles and masks secrets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rownd-profiles-")); directories.push(dir);
  const path = join(dir, "config", "profiles.json");
  expect(await readProfiles(path)).toEqual({});
  await writeProfiles({ stardust: profile }, path);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect((await stat(join(dir, "config"))).mode & 0o777).toBe(0o700);
  expect(await readProfiles(path)).toEqual({ stardust: profile });
  const output = JSON.stringify(maskProfile(profile));
  for (const secret of ["secret-key", "secret-value", "core-secret"]) expect(output).not.toContain(secret);
  await writeProfiles({}, path);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({});
});

it("runs profile add/list/show/remove and validates selectors before configuration", async () => {
  const home = await mkdtemp(join(tmpdir(), "rownd-cli-")); directories.push(home); vi.stubEnv("HOME", home);
  const output = vi.fn();
  await expect(runAdmin(["reconcile-user", "--email", "a", "--rownd-user-id", "b"], output)).rejects.toThrow("exactly one");
  await runAdmin(["profile", "add", "stardust", "--app-id", "app", "--app-key", "secret-key", "--app-secret", "secret-value", "--connection-uri", "http://localhost:3567"], output);
  await runAdmin(["profile", "list"], output);
  expect(output).toHaveBeenLastCalledWith(["stardust"]);
  await runAdmin(["profile", "show", "stardust"], output);
  expect(JSON.stringify(output.mock.calls)).not.toContain("secret-value");
  await runAdmin(["profile", "remove", "stardust"], output);
  await runAdmin(["profile", "list"], output);
  expect(output).toHaveBeenLastCalledWith([]);
});

it("prompts for plural profiles add, masks credentials and supports named show/remove", async () => {
  const home = await mkdtemp(join(tmpdir(), "rownd-cli-")); directories.push(home); vi.stubEnv("HOME", home);
  const answers = ["app", "secret-key", "secret-value", "http://localhost:3567", "", "public"];
  const prompt = vi.fn(async (_question: ProfileQuestion) => answers.shift()!);
  const output = vi.fn();
  await runAdmin(["profiles", "add", "--profile", "stardust"], output, prompt);
  expect(prompt.mock.calls.map(([question]) => Boolean(question.secret))).toEqual([false, true, true, true, true, false]);
  expect(prompt.mock.calls[5]![0]).toMatchObject({ defaultValue: "public" });
  await runAdmin(["profiles", "list"], output, prompt);
  expect(output).toHaveBeenLastCalledWith(["stardust"]);
  await runAdmin(["profiles", "show", "--profile", "stardust"], output, prompt);
  for (const secret of ["secret-key", "secret-value", "password"]) expect(JSON.stringify(output.mock.calls)).not.toContain(secret);
  await runAdmin(["profiles", "remove", "--profile", "stardust"], output, prompt);
  expect(await readProfiles()).toEqual({});
  const cancel = async () => { throw new Error("cancelled"); };
  await expect(runAdmin(["profiles", "add", "--profile", "cancelled"], output, cancel)).rejects.toThrow("cancelled");
  expect(await readProfiles()).toEqual({});
});

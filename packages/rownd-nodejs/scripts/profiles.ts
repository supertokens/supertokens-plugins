import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

export const profileSchema = z.object({
  rownd: z.object({ appId: z.string().min(1), appKey: z.string().min(1), appSecret: z.string().min(1) }).strict(),
  supertokens: z.object({ connectionURI: z.url().refine((value) => {
    const uri = new URL(value);
    return ["http:", "https:"].includes(uri.protocol) && !uri.username && !uri.password;
  }), apiKey: z.string().min(1).optional(), tenantId: z.string().min(1).default("public") }).strict(),
}).strict();
export type Profile = z.infer<typeof profileSchema>;
const storeSchema = z.record(z.string(), profileSchema);
export const defaultProfilesPath = () => join(homedir(), ".config", "rownd-nodejs", "profiles.json");

export async function readProfiles(path = defaultProfilesPath(), options: { readOnly?: boolean } = {}) {
  try {
    if (!options.readOnly) {
      await chmod(dirname(path), 0o700);
      await chmod(path, 0o600);
    }
    return storeSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return {} as Record<string, Profile>;
    throw new Error("Unable to read profiles: invalid configuration or permissions");
  }
}

export async function writeProfiles(profiles: Record<string, Profile>, path = defaultProfilesPath()) {
  const value = storeSchema.parse(profiles);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await file.sync();
    await file.close();
    await rename(temporary, path);
  } finally {
    await file.close();
    await unlink(temporary).catch((error: { code?: string }) => { if (error.code !== "ENOENT") throw error; });
  }
}

export function maskProfile(profile: Profile) {
  const uri = new URL(profile.supertokens.connectionURI);
  if (uri.username) uri.username = "***";
  if (uri.password) uri.password = "***";
  uri.search = "";
  uri.hash = "";
  return { rownd: { ...profile.rownd, appKey: "***", appSecret: "***" },
    supertokens: { ...profile.supertokens, connectionURI: uri.toString(), ...(profile.supertokens.apiKey ? { apiKey: "***" } : {}) } };
}

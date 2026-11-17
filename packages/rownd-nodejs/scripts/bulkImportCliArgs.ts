import { resolve } from "node:path";

export function parseBulkImportCliArgs(
  args: string[],
  options: { valueFlags: string[]; booleanFlags?: string[] },
) {
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  const valueFlags = new Set(options.valueFlags);
  const booleanFlags = new Set(options.booleanFlags ?? []);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (valueFlags.has(arg)) {
      if (values.has(arg)) throw new Error(`${arg} may only be provided once.`);
      const value = args[++index];
      if (!value || value.startsWith("-")) {
        throw new Error(`Missing value for ${arg}.`);
      }
      values.set(arg, value);
    } else if (booleanFlags.has(arg)) {
      if (booleans.has(arg))
        throw new Error(`${arg} may only be provided once.`);
      booleans.add(arg);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return {
    has: (flag: string) => booleans.has(flag),
    value: (flag: string) => values.get(flag),
    path: (flag: string) => {
      const value = values.get(flag);
      return value ? resolve(value) : undefined;
    },
    requiredPath: (flag: string) => {
      const value = values.get(flag);
      if (!value) throw new Error(`Missing required ${flag} <path>.`);
      return resolve(value);
    },
  };
}

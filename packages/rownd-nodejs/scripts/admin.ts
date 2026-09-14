import { parseArgs } from "node:util";
import SuperTokens from "supertokens-node";
import AccountLinking from "supertokens-node/recipe/accountlinking";
import Passwordless from "supertokens-node/recipe/passwordless";
import EmailVerification from "supertokens-node/recipe/emailverification";
import Session from "supertokens-node/recipe/session";
import ThirdParty from "supertokens-node/recipe/thirdparty";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import { init } from "../src/plugin";
import { reconcileUser, validateReconcileSelector, type ReconcileUserInput } from "../src/reconcile-user";
import { maskProfile, profileSchema, readProfiles, writeProfiles } from "./profiles";
import { promptProfileValue, type ProfilePrompt } from "./profilePrompt";
import { CliValidationError } from "./cliError";
import { formatReconcileResult } from "./adminOutput";
import { readRowndCsv, reconcileCsv } from "./reconcileCsv";
import { createFailedIdsFile } from "./failedIds";
import { formatReconcileProgress } from "./reconcileProgress";

export async function runAdmin(args: string[], output: (value: unknown) => void = console.log, prompt: ProfilePrompt = promptProfileValue) {
  const { values, positionals } = (() => {
    try {
      return parseArgs({ args, allowPositionals: true, options: {
        profile: { type: "string" }, "rownd-user-id": { type: "string" }, email: { type: "string" },
        "supertokens-user-id": { type: "string" }, "app-id": { type: "string" }, "app-key": { type: "string" },
        "app-secret": { type: "string" }, "connection-uri": { type: "string" }, "api-key": { type: "string" },
        "tenant-id": { type: "string" }, "dry-run": { type: "boolean" }, help: { type: "boolean" },
        file: { type: "string" }, "id-column": { type: "string" },
        concurrency: { type: "string" }, "failed-file": { type: "string" },
      } });
    } catch { throw new CliValidationError("Invalid command arguments; run with --help"); }
  })();
  if (values.help) {
    output("profiles add --profile NAME (interactive; credential entry is masked)\nprofiles list\nprofiles show|remove --profile NAME\nNoninteractive add: --app-id ID --app-key KEY --app-secret SECRET --connection-uri URI [--api-key KEY] [--tenant-id public]\nreconcile-user --profile NAME (--rownd-user-id ID | --email EMAIL | --supertokens-user-id ID) [--dry-run]\nDry run returns a read-only PREVIEW; exit 0 only when canReconcile is true. Execution must revalidate the snapshot.");
    output("reconcile-csv --profile NAME --file users.csv [--id-column rownd_user_id] [--concurrency 1] [--failed-file failed.csv] [--dry-run]\nCSV requires a header. IDs are deduplicated; JSON lines contain results in completion order and a summary. Progress and average users/s are logged to stderr every second. The optional failure CSV must be a new file. Any unsuccessful result exits nonzero.");
    return 0;
  }
  const [command, operation, positionalName] = positionals;
  if (command !== "reconcile-csv" && (values.concurrency !== undefined || values["failed-file"] !== undefined)) {
    throw new CliValidationError("--concurrency and --failed-file are only supported by reconcile-csv");
  }
  if (command === "profile" || command === "profiles") {
    if (values["dry-run"]) throw new CliValidationError("--dry-run is only supported by reconciliation commands");
    if (values.file !== undefined || values["id-column"] !== undefined) throw new CliValidationError("--file and --id-column are only supported by reconcile-csv");
    if (values.profile && positionalName && values.profile !== positionalName) throw new CliValidationError("Conflicting profile names");
    const name = values.profile ?? positionalName;
    const profiles = await readProfiles();
    if (operation === "list") { output(Object.keys(profiles).sort()); return 0; }
    if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) throw new CliValidationError("A profile name is required (letters, digits, hyphens, underscores)");
    if (operation === "add") {
      if (Object.prototype.hasOwnProperty.call(profiles, name)) throw new CliValidationError("Profile already exists");
      const interactive = ["app-id", "app-key", "app-secret", "connection-uri"].some((key) => values[key as keyof typeof values] === undefined);
      const appId = values["app-id"] ?? await prompt({ label: "Rownd app ID" });
      const appKey = values["app-key"] ?? await prompt({ label: "Rownd app key", secret: true });
      const appSecret = values["app-secret"] ?? await prompt({ label: "Rownd app secret", secret: true });
      const connectionURI = values["connection-uri"] ?? await prompt({ label: "SuperTokens connection URI", secret: true });
      const apiKey = values["api-key"] ?? (interactive ? await prompt({ label: "SuperTokens API key (optional)", secret: true }) : undefined);
      const tenantId = values["tenant-id"] ?? (interactive ? await prompt({ label: "Tenant ID", defaultValue: "public" }) : "public");
      const parsed = profileSchema.safeParse({ rownd: { appId, appKey, appSecret },
        supertokens: { connectionURI, apiKey: apiKey || undefined, tenantId } });
      if (!parsed.success) throw new CliValidationError("Profile requires app-id, app-key, app-secret and an HTTP(S) connection-uri without embedded credentials; use api-key for Core authentication");
      profiles[name] = parsed.data;
      await writeProfiles(profiles);
      output(maskProfile(parsed.data));
      return 0;
    }
    if (!Object.prototype.hasOwnProperty.call(profiles, name)) throw new CliValidationError("Profile not found");
    if (operation === "show") output(maskProfile(profiles[name]!));
    else if (operation === "remove") { delete profiles[name]; await writeProfiles(profiles); output({ removed: name }); } else throw new CliValidationError("Unknown profile operation");
    return 0;
  }
  if (command !== "reconcile-user" && command !== "reconcile-csv") throw new CliValidationError("Unknown admin command");
  if (positionals.length !== 1) throw new CliValidationError("Unexpected positional argument; run with --help");
  const input = { ...(values["rownd-user-id"] !== undefined ? { rownd_user_id: values["rownd-user-id"] } : {}),
    ...(values.email !== undefined ? { email: values.email } : {}),
    ...(values["supertokens-user-id"] !== undefined ? { supertokens_user_id: values["supertokens-user-id"] } : {}) };
  const concurrency = values.concurrency === undefined ? 1 : Number(values.concurrency);
  if (command === "reconcile-csv") {
    if (Object.keys(input).length) throw new CliValidationError("reconcile-csv reads selectors from CSV; do not supply a user selector");
    if (!values.file?.trim()) throw new CliValidationError("--file is required");
    if (values["id-column"] !== undefined && !values["id-column"].trim()) throw new CliValidationError("--id-column must be non-empty");
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || (values.concurrency !== undefined && !/^\d+$/.test(values.concurrency))) {
      throw new CliValidationError("--concurrency must be a positive integer");
    }
    if (values["failed-file"] !== undefined && !values["failed-file"].trim()) throw new CliValidationError("--failed-file must be non-empty");
  } else {
    if (values.file !== undefined || values["id-column"] !== undefined) throw new CliValidationError("--file and --id-column are only supported by reconcile-csv");
    try { validateReconcileSelector(input); } catch { throw new CliValidationError("Provide exactly one non-empty --rownd-user-id, --email, or --supertokens-user-id selector"); }
  }
  if (!values.profile) throw new CliValidationError("--profile is required");
  // Validate the entire input before initializing clients or reconciling any user.
  const csv = command === "reconcile-csv" ? await readRowndCsv(values.file!, values["id-column"]?.trim()) : undefined;
  const profiles = await readProfiles(undefined, { readOnly: values["dry-run"] === true });
  const profile = Object.prototype.hasOwnProperty.call(profiles, values.profile) ? profiles[values.profile] : undefined;
  if (!profile) throw new CliValidationError("Profile not found");
  const failures = values["failed-file"] !== undefined ? await createFailedIdsFile(values["failed-file"]) : undefined;
  try {
    SuperTokens.init({ supertokens: profile.supertokens,
      appInfo: { appName: "Rownd reconciliation", apiDomain: "http://localhost", websiteDomain: "http://localhost" },
      recipeList: [AccountLinking.init({ shouldDoAutomaticAccountLinking: async () => ({ shouldAutomaticallyLink: false }) }),
        Session.init(), UserMetadata.init(), EmailVerification.init({ mode: "OPTIONAL" }),
        Passwordless.init({ contactMethod: "EMAIL_OR_PHONE", flowType: "MAGIC_LINK" }), ThirdParty.init()],
      experimental: { plugins: [init({ rowndAppKey: profile.rownd.appKey, rowndAppSecret: profile.rownd.appSecret, rowndAppId: profile.rownd.appId })] },
    });
    if (csv) return await reconcileCsv({ ...csv, profile, dryRun: values["dry-run"] ?? false, concurrency,
      recordFailure: failures ? (id) => failures.append(id) : undefined,
      onProgress: (progress) => console.error(formatReconcileProgress(progress)) }, output);
    const result = await reconcileUser({ ...input, tenantId: profile.supertokens.tenantId, dryRun: values["dry-run"] ?? false,
      onProgress: ({ stage, action }) => console.error(`[reconcile] ${stage}${action ? ` ${action}` : ""}`) } as ReconcileUserInput);
    output(formatReconcileResult(result, profile));
    return result.status === "OK" || (result.status === "PREVIEW" && result.canReconcile === true) ? 0 : 1;
  } finally {
    await failures?.close();
  }
}

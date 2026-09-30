import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { RowndMigrationPolicyError } from "../src/errors";
import { assertRowndSourcePayload } from "../src/migration-email";
import type { IRowndClient, RowndUser } from "../src/types";
import { CliValidationError } from "./cliError";

export async function openDuckdbRowndClient(file: string, requestedRunId?: string) {
  let instance: DuckDBInstance;
  try {
    instance = await DuckDBInstance.create(file, { access_mode: "READ_ONLY" });
  } catch {
    throw new CliValidationError("Cannot open DuckDB read-only; check --duckdb, file permissions, and close any DataGrip or other write connection");
  }
  let connection: DuckDBConnection | undefined;
  try {
    connection = await instance.connect();
    const runs = await connection.runAndReadAll(requestedRunId === undefined
      ? "SELECT id FROM migration_runs LIMIT 2"
      : "SELECT id FROM migration_runs WHERE id = ? LIMIT 2", requestedRunId === undefined ? undefined : [requestedRunId]);
    const rows = runs.getRows();
    if (rows.length === 0) throw new CliValidationError("No matching migration run in DuckDB; check --run-id");
    if (rows.length !== 1) throw new CliValidationError("DuckDB contains multiple migration runs; select one with --run-id");
    const runId = rows[0]![0];
    if (typeof runId !== "string" || !runId) throw new CliValidationError("DuckDB migration run ID is invalid");
    await connection.run("SELECT source_key, source_payload FROM migration_entries WHERE run_id = ? LIMIT 0", [runId]);
    const db = connection;
    let pending: Promise<unknown> = Promise.resolve();
    let closed = false;
    const fetchUserInfo: IRowndClient["fetchUserInfo"] = ({ user_id }) => {
      if (closed) return Promise.reject(new Error("DuckDB source is closed"));
      // Serialize local queries so concurrent reconciliations share one connection safely.
      const lookup = pending.then(async () => {
        let payloads;
        try {
          payloads = (await db.runAndReadAll(
            "SELECT source_payload FROM migration_entries WHERE run_id = ? AND source_key = ? LIMIT 2",
            [runId, user_id],
          )).getRows();
        } catch {
          throw new RowndMigrationPolicyError("SNAPSHOT_READ_FAILED: cannot read the DuckDB source");
        }
        if (!payloads.length) throw new RowndMigrationPolicyError("SOURCE_NOT_IN_SNAPSHOT: required Rownd user is missing from the selected migration run");
        if (payloads.length !== 1) throw new RowndMigrationPolicyError("SNAPSHOT_SOURCE_AMBIGUOUS: multiple rows match the source key");
        let profile: RowndUser;
        try {
          const payload = payloads[0]![0];
          if (typeof payload !== "string") throw new Error("Invalid payload");
          profile = JSON.parse(payload);
        } catch {
          throw new RowndMigrationPolicyError("SNAPSHOT_PAYLOAD_INVALID: source_payload must contain a Rownd profile JSON object");
        }
        assertRowndSourcePayload(profile);
        if (profile.data.user_id !== user_id) throw new RowndMigrationPolicyError("SOURCE_ID_MISMATCH: snapshot profile does not match the source key");
        return profile;
      });
      pending = lookup.catch(() => undefined);
      return lookup;
    };
    const client: IRowndClient = {
      fetchUserInfo,
      fetchFreshUserInfo: fetchUserInfo,
      validateToken: async () => { throw new Error("DuckDB reconciliation does not support token validation"); },
    };
    return { client, runId, close: async () => {
      if (closed) return;
      closed = true;
      await pending;
      db.closeSync();
      instance.closeSync();
    } };
  } catch (error) {
    connection?.closeSync();
    instance.closeSync();
    if (error instanceof CliValidationError) throw error;
    throw new CliValidationError("Invalid DuckDB migration schema; expected migration_runs and migration_entries with source_payload");
  }
}

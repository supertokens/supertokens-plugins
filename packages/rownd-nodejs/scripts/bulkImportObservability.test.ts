import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BulkImportManifest } from "./bulkImportManifest";

const fetchWithRetry = vi.hoisted(() => vi.fn());

vi.mock("./scriptUtils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./scriptUtils")>()),
  fetchWithRetry,
}));

import { countStagedUsers, getAllStagedUsers } from "./bulkImportApi";
import { sanitizeImportError } from "./bulkImportFailures";
import { buildProgressSnapshot } from "./bulkImportMonitor";
import { buildValidationReport } from "./bulkImportValidate";
import { parseBulkImportCliArgs } from "./bulkImportCliArgs";

const config = {
  supertokens: {
    connectionURI: "https://core.example.com/base/path",
    apiKey: "core-secret",
  },
  retry: { maxAttempts: 3, initialDelayMs: 10 },
};

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function stagedUser(id: string) {
  return {
    id,
    raw_data: { externalUserId: `external-${id}` },
    status: "FAILED" as const,
    error_msg: [],
    created_at: "2026-07-22T10:00:00.000Z",
    updated_at: "2026-07-22T10:01:00.000Z",
  };
}

function manifest(
  overrides: Partial<BulkImportManifest> = {},
): BulkImportManifest {
  return {
    version: 1,
    runId: "run-123",
    startedAt: "2026-07-22T09:00:00.000Z",
    updatedAt: "2026-07-22T10:00:00.000Z",
    completedStagingAt: "2026-07-22T10:00:00.000Z",
    rowndAppIdHash: "app-hash",
    targetHash: "target-hash",
    tenantId: "public",
    sourceUsersRead: 2,
    stagedExternalUserIdHashes: ["user-1-hash", "user-2-hash"],
    mappingFailureExternalUserIdHashes: [],
    ...overrides,
  };
}

describe("bulk import observability", () => {
  beforeEach(() => {
    fetchWithRetry.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("parses numeric-string counts and sends the status query with the API key", async () => {
    fetchWithRetry.mockResolvedValue(
      jsonResponse({ status: "OK", count: "17" }),
    );

    const count = await countStagedUsers(config, "PROCESSING");

    expect(count).toBe(17);
    expect(fetchWithRetry).toHaveBeenCalledOnce();
    const request = fetchWithRetry.mock.calls[0][0];
    const url = new URL(request.url);
    expect(url.pathname).toBe("/bulk-import/users/count");
    expect(url.searchParams.get("status")).toBe("PROCESSING");
    expect(request.requestInit.headers).toEqual({
      "Content-Type": "application/json; charset=utf-8",
      "api-key": "core-secret",
    });
  });

  it("retrieves every staged-user page using the returned pagination token", async () => {
    fetchWithRetry
      .mockResolvedValueOnce(
        jsonResponse({
          users: [stagedUser("first")],
          nextPaginationToken: "next page/token",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          users: [stagedUser("second")],
          nextPaginationToken: null,
        }),
      );

    const users = await getAllStagedUsers(config, "FAILED");

    expect(users.map(({ id }) => id)).toEqual(["first", "second"]);
    expect(fetchWithRetry).toHaveBeenCalledTimes(2);
    const firstUrl = new URL(fetchWithRetry.mock.calls[0][0].url);
    const secondUrl = new URL(fetchWithRetry.mock.calls[1][0].url);
    expect(firstUrl.pathname).toBe("/bulk-import/users");
    expect(firstUrl.searchParams.get("status")).toBe("FAILED");
    expect(firstUrl.searchParams.get("limit")).toBe("100");
    expect(firstUrl.searchParams.has("paginationToken")).toBe(false);
    expect(secondUrl.searchParams.get("paginationToken")).toBe(
      "next page/token",
    );
  });

  it("redacts email addresses and phone numbers without changing safe context", () => {
    expect(
      sanitizeImportError(
        "User Alice.Example+old@Example.COM has phone +1 (415) 555-2671; record import-42 failed",
      ),
    ).toBe("User <email> has phone <phone>; record import-42 failed");
  });

  it("infers imported users from the staged total and never returns a negative count", () => {
    expect(
      buildProgressSnapshot(
        { staged: 3, new: 1, processing: 1, failed: 1 },
        10,
      ),
    ).toEqual({
      timestamp: "2026-07-22T12:00:00.000Z",
      staged: 3,
      new: 1,
      processing: 1,
      failed: 1,
      successfullyStaged: 10,
      inferredImported: 7,
      stagingFinished: true,
    });
    expect(
      buildProgressSnapshot({ staged: 4, new: 4, processing: 0, failed: 0 }, 2)
        .inferredImported,
    ).toBe(0);
  });

  it("builds a complete report when staging finished and every source user is imported", () => {
    const report = buildValidationReport({
      manifest: manifest(),
      progress: { staged: 0, new: 0, processing: 0, failed: 0 },
    });

    expect(report).toMatchObject({
      generatedAt: "2026-07-22T12:00:00.000Z",
      runId: "run-123",
      sourceUsersRead: 2,
      successfullyStaged: 2,
      mappingFailures: 0,
      inferredImported: 2,
      checks: {
        stagingFinished: true,
        noMappingFailures: true,
        noStagedUsersRemaining: true,
        allSourceUsersAccountedFor: true,
      },
      status: "COMPLETE",
    });
  });

  it("builds an incomplete report exposing each failed validation check", () => {
    const report = buildValidationReport({
      manifest: manifest({
        completedStagingAt: undefined,
        sourceUsersRead: 5,
        stagedExternalUserIdHashes: ["user-1-hash", "user-2-hash"],
        mappingFailureExternalUserIdHashes: ["user-3-hash"],
      }),
      progress: { staged: 2, new: 1, processing: 0, failed: 1 },
    });

    expect(report).toMatchObject({
      sourceUsersRead: 5,
      successfullyStaged: 2,
      mappingFailures: 1,
      staged: 2,
      inferredImported: 0,
      checks: {
        stagingFinished: false,
        noMappingFailures: false,
        noStagedUsersRemaining: false,
        allSourceUsersAccountedFor: false,
      },
      status: "INCOMPLETE",
    });
  });

  it("rejects missing CLI values and unknown arguments", () => {
    expect(() =>
      parseBulkImportCliArgs(["--manifest", "--wait"], {
        valueFlags: ["--manifest"],
        booleanFlags: ["--wait"],
      }),
    ).toThrow("Missing value for --manifest");
    expect(() =>
      parseBulkImportCliArgs(["--unknown"], { valueFlags: [] }),
    ).toThrow("Unknown argument: --unknown");
  });

  it("does not validate a contradictory zero-total status snapshot", () => {
    const report = buildValidationReport({
      manifest: manifest(),
      progress: { staged: 0, new: 0, processing: 1, failed: 0 },
    });

    expect(report.checks.noStagedUsersRemaining).toBe(false);
    expect(report.status).toBe("INCOMPLETE");
  });
});

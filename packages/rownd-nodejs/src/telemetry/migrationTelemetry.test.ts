import { afterEach, describe, expect, it, vi } from "vitest";
import { logDebugMessage } from "../logger";
import { createClient } from "./createTelemetryClient";
import { MigrationTelemetry } from "./migrationTelemetry";

vi.mock("../logger", () => ({ logDebugMessage: vi.fn() }));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("migration diagnostics", () => {
  it("logs correlated events without a provider and times each stage independently", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const telemetry = new MigrationTelemetry(createClient(undefined).recordEvent);
    telemetry.recipeId = "thirdparty";
    telemetry.recipeUserId = "session-method";
    vi.setSystemTime(1100);
    telemetry.stage = "account_linking";
    vi.setSystemTime(1125);
    telemetry.emit("transition", "account_link_completed", "success", undefined, {
      recipeId: "passwordless",
      recipeUserId: "linked-method",
    });
    telemetry.stage = "session_creation";
    vi.setSystemTime(1150);
    const error = Object.assign(new TypeError("Session storage unavailable"), {
      request: { token: "private-token", profile: { email: "private@example.com" } },
    });
    telemetry.emit("terminal", "stage_failed", "error", error);
    const events = vi.mocked(logDebugMessage).mock.calls.map(([message]) => JSON.parse(message));
    expect(events[0]).toMatchObject({
      stage: "account_linking", durationMs: 125, stageDurationMs: 25,
      recipeId: "passwordless", recipeUserId: "linked-method",
    });
    expect(events[1]).toMatchObject({
      requestId: events[0].requestId,
      stage: "session_creation", durationMs: 150, stageDurationMs: 25,
      recipeId: "thirdparty", recipeUserId: "session-method",
      error: { name: "TypeError", message: "Session storage unavailable" },
    });
    expect(events[1].error).toEqual({ name: "TypeError", message: "Session storage unavailable" });
    expect(JSON.stringify(events)).not.toMatch(/private-token|private@example.com|stack/);
  });

  it("does not serialize arbitrary thrown values", () => {
    const record = vi.fn();
    new MigrationTelemetry(record).emit("terminal", "stage_failed", "error", {
      token: "private-token",
    });
    expect(record.mock.calls[0][0].error).toEqual({ message: "Unknown error" });
  });
});

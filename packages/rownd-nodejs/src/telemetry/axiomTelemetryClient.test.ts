import { afterEach, describe, expect, it, vi } from "vitest";
import { AxiomTelemetryClient } from "./axiomTelemetryClient";
import { createClient } from "./createTelemetryClient";

afterEach(() => vi.unstubAllGlobals());

describe("Axiom telemetry transport", () => {
  it("rejects unsuccessful ingestion and bounds requests with an abort signal", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 429 });
    vi.stubGlobal("fetch", fetchMock);
    await expect(new AxiomTelemetryClient("token", "dataset").recordEvent({ outcome: "success", durationMs: 1 })).rejects.toThrow("429");
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("isolates rejected transport promises from callers", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const client = createClient({ provider: "axiom", token: "token", dataset: "dataset" });
    expect(client.recordEvent({ outcome: "success", durationMs: 1 })).toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));
  });
});

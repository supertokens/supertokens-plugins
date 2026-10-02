import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { promptProfileValue } from "./profilePrompt";

function terminal() {
  const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode: vi.fn() });
  input.pause();
  const output = new PassThrough();
  let written = "";
  output.on("data", (chunk) => { written += chunk.toString(); });
  return { input, output, written: () => written };
}

it("masks secret input, supports backspace and restores terminal state", async () => {
  const io = terminal();
  const answer = promptProfileValue({ label: "Connection URI", secret: true }, io.input, io.output);
  io.input.emit("keypress", "credential", {});
  io.input.emit("keypress", undefined, { name: "backspace" });
  io.input.emit("keypress", "s", {});
  io.input.emit("keypress", "\r", { name: "return" });
  expect(await answer).toBe("credentias");
  expect(io.written()).not.toContain("credential");
  expect(io.written()).toContain("**********");
  expect(io.input.setRawMode.mock.calls).toEqual([[true], [false]]);
  expect(io.input.isPaused()).toBe(true);
  expect(io.input.listenerCount("keypress")).toBe(0);
});

it("uses defaults and rejects cancellation and non-TTY input without hanging", async () => {
  const io = terminal();
  const answer = promptProfileValue({ label: "Tenant", defaultValue: "public" }, io.input, io.output);
  io.input.emit("keypress", "\r", { name: "return" });
  expect(await answer).toBe("public");
  const cancelled = promptProfileValue({ label: "Secret", secret: true }, io.input, io.output);
  io.input.emit("keypress", undefined, { name: "c", ctrl: true });
  await expect(cancelled).rejects.toThrow("cancelled");
  expect(io.input.listenerCount("keypress")).toBe(0);
  await expect(promptProfileValue({ label: "Secret" }, new PassThrough(), io.output)).rejects.toThrow("requires a terminal");
});

it("pauses initially idle stdin after completion so the CLI can exit", async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode: vi.fn() });
  expect(input.readableFlowing).toBeNull();
  const answer = promptProfileValue({ label: "Tenant", defaultValue: "public" }, input, new PassThrough());
  input.emit("keypress", "\r", { name: "return" });
  expect(await answer).toBe("public");
  expect(input.isPaused()).toBe(true);
});

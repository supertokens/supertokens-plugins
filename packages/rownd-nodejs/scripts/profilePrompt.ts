import { emitKeypressEvents } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { CliValidationError } from "./cliError";

export type ProfileQuestion = { label: string; secret?: boolean; defaultValue?: string };
export type ProfilePrompt = (question: ProfileQuestion) => Promise<string>;
type PromptInput = Readable & { isTTY?: boolean; isRaw?: boolean; setRawMode?: (mode: boolean) => unknown };

export function promptProfileValue(
  question: ProfileQuestion,
  input: PromptInput = process.stdin,
  output: Writable = process.stdout,
): Promise<string> {
  if (!input.isTTY || !input.setRawMode) {
    return Promise.reject(new CliValidationError("Interactive profile setup requires a terminal; supply all required profile flags for noninteractive use"));
  }
  emitKeypressEvents(input);
  const wasRaw = input.isRaw ?? false;
  const wasFlowing = input.readableFlowing === true;
  output.write(`${question.label}${question.defaultValue ? ` [${question.defaultValue}]` : ""}: `);
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      input.removeListener("keypress", onKey);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
      input.setRawMode!(wasRaw);
      if (!wasFlowing) input.pause();
      output.write("\n");
      if (error) reject(error);
      else resolve(value || question.defaultValue || "");
    };
    const onEnd = () => finish(new Error("Profile input ended"));
    const onError = () => finish(new Error("Unable to read profile input"));
    const onKey = (text: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean }) => {
      if (key.ctrl && (key.name === "c" || key.name === "d")) return finish(new CliValidationError("Profile setup cancelled"));
      if (key.name === "return" || key.name === "enter") return finish();
      if (key.name === "backspace") {
        if (value.length) { value = Array.from(value).slice(0, -1).join(""); output.write("\b \b"); }
        return;
      }
      if (key.ctrl || key.meta || !text || Array.from(text).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return;
      value += text;
      output.write(question.secret ? "*".repeat(Array.from(text).length) : text);
    };
    input.on("keypress", onKey);
    input.once("end", onEnd);
    input.once("error", onError);
    input.setRawMode!(true);
    input.resume();
  });
}

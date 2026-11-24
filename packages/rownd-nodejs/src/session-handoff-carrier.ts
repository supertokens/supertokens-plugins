import { AsyncLocalStorage } from "node:async_hooks";
import type { SessionInformation } from "supertokens-node/recipe/session";
import { isRecord } from "./utils";

export const SESSION_HANDOFF_KIND = "rownd_session_handoff";
export const SESSION_HANDOFF_CARRIER_CLAIM = "rownd_session_handoff_carrier";

const creatingCarrier = new AsyncLocalStorage<boolean>();

export function withSessionHandoffCarrier<T>(action: () => Promise<T>) {
  return creatingCarrier.run(true, action);
}

export function isCreatingSessionHandoffCarrier() {
  return creatingCarrier.getStore() === true;
}

export function isSessionHandoffCarrier(info: SessionInformation) {
  const data: unknown = info.sessionDataInDatabase;
  return isRecord(data) && data.kind === SESSION_HANDOFF_KIND;
}

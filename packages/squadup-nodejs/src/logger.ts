import { buildLogger } from "@shared/nodejs";
import { PLUGIN_ID, PLUGIN_SDK_VERSION } from "./constants";

export const { logDebugMessage, enableDebugLogs } = buildLogger(
  PLUGIN_ID,
  PLUGIN_SDK_VERSION,
);

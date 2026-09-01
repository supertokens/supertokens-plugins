export * from "./plugin";
import { init } from "./plugin";
export { init };
export default { init };
export * from "./types";
export * from "./constants";
export * from "./errors";
export {
  createMagicLinkWithConfirmationBypass,
} from "./supertokens-repository";
export type {
  CreateMagicLinkWithConfirmationBypassInput,
} from "./supertokens-repository";
export { setRowndClient, getRowndClient } from "./rownd-repository";

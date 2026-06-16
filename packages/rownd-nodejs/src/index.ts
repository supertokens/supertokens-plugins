export * from "./plugin";
import { init } from "./plugin";
export { init };
export default { init };
export * from "./types";
export * from "./constants";
export * from "./errors";
export {
  createMagicLinkWithConfirmationBypass,
  verifyPasswordlessConfirmationBypass,
} from "./supertokens-repository";
export type {
  CreateMagicLinkWithConfirmationBypassInput,
  VerifyPasswordlessConfirmationBypassInput,
} from "./supertokens-repository";
export { setRowndClient, getRowndClient } from "./rownd-repository";

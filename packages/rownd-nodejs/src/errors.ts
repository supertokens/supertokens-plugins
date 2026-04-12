export const ROWND_PLUGIN_ERROR_MESSAGES = {
  MISSING_AUTHORIZATION_HEADER: "Missing authorization header",
  INVALID_TOKEN: "Invalid token",
} as const;

export type RowndPluginErrorType = keyof typeof ROWND_PLUGIN_ERROR_MESSAGES;

export class RowndPluginError extends Error {
  constructor(type: RowndPluginErrorType) {
    super(ROWND_PLUGIN_ERROR_MESSAGES[type]);
  }
}

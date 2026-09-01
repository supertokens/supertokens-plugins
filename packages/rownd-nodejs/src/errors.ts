export const ROWND_PLUGIN_ERROR_MESSAGES = {
  MISSING_AUTHORIZATION_HEADER: "Missing authorization header",
  INVALID_TOKEN: "Invalid token",
  ROWND_USER_NOT_FOUND: "User not found in Rownd",
} as const;

export type RowndPluginErrorType = keyof typeof ROWND_PLUGIN_ERROR_MESSAGES;

export class RowndPluginError extends Error {
  constructor(type: RowndPluginErrorType) {
    super(ROWND_PLUGIN_ERROR_MESSAGES[type]);
  }
}

export class RowndEmailChangeError extends Error {
  constructor(
    public readonly code: "CONFLICT" | "AMBIGUOUS" | "INVALID_EMAIL",
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
  }
}

export class RowndConfigResolutionError extends Error {
  readonly cause!: unknown;

  constructor(cause: unknown) {
    super("Rownd configuration could not be resolved");
    this.name = "RowndConfigResolutionError";
    Object.defineProperty(this, "cause", { enumerable: false, value: cause });
  }
}

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

export class RowndLegacyUserNotFoundError extends Error {
  readonly code = "LEGACY_USER_NOT_FOUND" as const;

  constructor() {
    super("Your previous session could not be restored. Please sign in again.");
    this.name = "RowndLegacyUserNotFoundError";
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

// Email change completion revokes every session for the user before it commits.
// Callers must not assume the client still holds a usable session after this error.
export class RowndEmailChangeSessionsRevokedError extends Error {
  readonly sessionsRevoked = true as const;

  constructor(
    public readonly cause: unknown,
    public readonly userId: string,
    public readonly step: string,
    // Set only when the identity graph was restored, so a session for this
    // recipe user grants exactly what the revoked initiating session granted.
    public readonly recoverableRecipeUserId: string | undefined,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "RowndEmailChangeSessionsRevokedError";
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

export class RowndPasswordlessCleanupError extends Error {
  constructor(
    public readonly cause: unknown,
    public readonly cleanupError: unknown,
  ) {
    super("Historical passwordless linking and cleanup failed");
    this.name = "RowndPasswordlessCleanupError";
  }
}

// Explicit invariant failures are policy blocks; unknown errors remain operational.
export class RowndMigrationPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RowndMigrationPolicyError";
  }
}

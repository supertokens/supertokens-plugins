import type { JSONObject } from "supertokens-node/types";

export interface RowndPluginConfig {
  rowndAppKey: string;
  rowndAppSecret: string;
  enableDebugLogs?: boolean;
  telemetry?: RowndTelemetryConfig;
}

export type RowndTelemetryOperation = "migrate-user" | "migrate-session";

export type RowndTelemetryEvent =
  | {
      outcome: "success";
      operation: RowndTelemetryOperation;
      durationMs: number;
      tenantId?: string;
      rowndUserId?: string;
      superTokensUserId?: string;
    }
  | {
      outcome: "error";
      operation: RowndTelemetryOperation;
      durationMs: number;
      tenantId?: string;
      rowndUserId?: string;
      superTokensUserId?: string;
      error: {
        message: string;
        name?: string;
      };
    };

export interface RowndTelemetryClient {
  recordEvent: (event: RowndTelemetryEvent) => Promise<void> | void;
}

export type RowndTelemetryConfig =
  | {
      provider: "opentelemetry";
    }
  | {
      provider: "axiom";
      token: string;
      dataset: string;
      url?: string;
    }
  | {
      provider: "custom";
      factory: () => RowndTelemetryClient;
    };

export interface RowndUser {
  app_user_id: string;
  data: {
    user_id: string;
    email?: string;
    phone_number?: string;
    google_id?: string;
    apple_id?: string;
    first_name?: string;
    last_name?: string;
  };
  verified_data: {
    email?: string;
    phone_number?: string;
    google_id?: string;
    apple_id?: string;
  };
  groups?: string[];
  meta?: {
    created?: string;
    modified?: string;
    first_sign_in?: string;
    last_sign_in?: string;
  };
}

export interface MigrationResponse {
  status: "OK" | "ERROR";
  message?: string;
}

export interface RowndPluginNormalisedConfig {
  rowndAppKey: string;
  rowndAppSecret: string;
  enableDebugLogs?: boolean;
  telemetry?: RowndTelemetryConfig;
}

export interface SuperTokensUserImport {
  externalUserId: string;
  timeJoined?: number;
  userMetadata: JSONObject;
  loginMethods: (
    | {
        recipeId: "emailpassword";
        email: string;
        passwordHash: string;
        isVerified: boolean;
      }
    | {
        recipeId: "thirdparty";
        thirdPartyId: string;
        thirdPartyUserId: string;
        email: string;
        isVerified: boolean;
      }
    | {
        recipeId: "passwordless";
        email?: string;
        phoneNumber?: string;
        isVerified: boolean;
      }
  )[];
}

export interface IRowndClient {
  validateToken: (token: string) => Promise<{
    user_id: string;
  }>;
  fetchUserInfo: (opts: {
    user_id: string;
    app_id?: string;
  }) => Promise<RowndUser | undefined>;
}

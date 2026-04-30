import type { JSONObject } from "supertokens-node/types";
import type { RowndSchema } from "./schema";

export interface RowndPluginConfig {
  rowndAppKey: string;
  rowndAppSecret: string;
  enableDebugLogs?: boolean;
  telemetry?: RowndTelemetryConfig;
  // Optional frontend/profile schema override used by Rownd compatibility surfaces.
  // If omitted, the plugin can fall back to DEFAULT_ROWND_SCHEMA.
  schema?: RowndSchema;
}

export type RowndTelemetryEvent =
  | {
      outcome: "success";
      durationMs: number;
      tenantId?: string;
      rowndUserId?: string;
      superTokensUserId?: string;
    }
  | {
      outcome: "error";
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
  state: string;
  auth_level: string;
  data: {
    user_id: string;
    email?: string;
    phone_number?: string;
    google_id?: string;
    apple_id?: string;
    first_name?: string;
    last_name?: string;
  };
  attributes?: Record<string, string | string[]>;
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
  schema?: RowndSchema;
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
        tenantIds?: string[];
      }
    | {
        recipeId: "thirdparty";
        thirdPartyId: string;
        thirdPartyUserId: string;
        email: string;
        isVerified: boolean;
        tenantIds?: string[];
      }
    | {
        recipeId: "passwordless";
        email?: string;
        phoneNumber?: string;
        isVerified: boolean;
        tenantIds?: string[];
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

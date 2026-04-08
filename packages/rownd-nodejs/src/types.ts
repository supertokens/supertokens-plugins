export interface RowndPluginConfig {
  rowndAppKey: string;
  rowndAppSecret: string;
  telemetry?: {
    token: string;
    dataset: string;
  };
}

export interface RowndUser {
  app_user_id: string;
  data: Record<string, unknown>;
  verified_data: Record<string, unknown>;
}

export interface MigrationResponse {
  status: "OK" | "ERROR";
  message?: string;
}

export interface RowndPluginNormalisedConfig {
  rowndAppKey: string;
  rowndAppSecret: string;
  telemetry?: {
    token: string;
    dataset: string;
  };
}

export interface IRowndClient {
  validateToken: (
    token: string,
  ) => Promise<{
    decoded_token: unknown;
    user_id: string;
    access_token: string;
  }>;
  fetchUserInfo: (opts: {
    user_id: string;
    app_id?: string;
  }) => Promise<RowndUser>;
}

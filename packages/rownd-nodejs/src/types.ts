import type { JSONObject } from "supertokens-node/types";

export type RowndSignInMethod =
  | { method: "email" }
  | { method: "phone" }
  | {
      method: "apple";
      clientId?: string;
    }
  | {
      method: "google";
      clientId?: string;
      iosClientId?: string;
      scopes?: string[];
      oneTap?: {
        browser?: {
          autoPrompt?: boolean;
          delay?: number;
        };
        mobileApp?: {
          autoPrompt?: boolean;
          delay?: number;
        };
      };
    }
  | {
      method: "anonymous";
      displayName?: string;
      iconLightUrl?: string;
      iconDarkUrl?: string;
    }
  // Custom OAuth2 providers
  | {
      method: string;
      displayName?: string;
      iconLightUrl?: string;
      iconDarkUrl?: string;
      [key: string]: unknown;
    };

export type RowndBranding = {
  primaryColor?: string;
  primaryColorDarkMode?: string;
  logo?: string;
  logoDarkMode?: string;
  roundedCorners?: boolean;
  containerBorderRadius?: number;
  placement?: string;
  visualSwoops?: boolean;
  blurBackground?: boolean;
  darkMode?: "auto" | "light" | "dark";
  showAppIcon?: boolean;
  customStyles?: { content: string }[];
};

export type RowndLegal = {
  companyName?: string;
  privacyPolicyUrl?: string;
  termsConditionsUrl?: string;
  supportEmail?: string;
};

export type RowndAuthConfig = {
  rememberSignInMethod?: boolean;
  useExplicitSignUpFlow?: boolean;
  primarySignUpMethod?: string;
  preferredMethod?: string;
  order?: {
    default?: { type: "button" | "input"; name: string; hidden?: boolean }[];
    ios?: { type: "button" | "input"; name: string; hidden?: boolean }[];
    android?: { type: "button" | "input"; name: string; hidden?: boolean }[];
  };
  additionalFields?: {
    name: string;
    type: string;
    label: string;
    placeholder?: string;
    options: { value: string; label: string }[];
  }[];
};

export type RowndProfileConfig = {
  accountInformation?: {
    methods?: Record<string, { enabled?: boolean }>;
  };
  personalInformation?: { enabled?: boolean };
  preferences?: { enabled?: boolean };
  signOutButton?: { enabled?: boolean };
  deleteAccountButton?: { enabled?: boolean };
};

export type RowndCustomContent = {
  signInModal?: {
    title?: string;
    subtitle?: string;
    signInTitle?: string;
    signUpTitle?: string;
    signInSubtitle?: string;
    signUpSubtitle?: string;
  };
  profileModal?: { title?: string };
  signInFailureModal?: { failureMessage?: string };
};

export type RowndAppConfigInput = {
  id?: string;
  name?: string;
  icon?: string;
  branding?: RowndBranding;
  legal?: RowndLegal;
  customContent?: RowndCustomContent;
  profile?: RowndProfileConfig;
  auth?: RowndAuthConfig;
  signInMethods?: RowndSignInMethod[];
};

export interface RowndPluginConfig {
  rowndAppKey: string;
  rowndAppSecret: string;
  enableDebugLogs?: boolean;
  telemetry?: RowndTelemetryConfig;
  // Optional field schema override. If omitted, DEFAULT_ROWND_SCHEMA is used.
  schema?: RowndSchema;
  // Optional app configuration served by GET /plugin/rownd/app-config.
  appConfig?: RowndAppConfigInput;
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

export type RowndUser = JSONObject & {
  state: string;
  auth_level: string;
  data: JSONObject & {
    user_id: string;
    email?: string;
    phone_number?: string;
    google_id?: string;
    apple_id?: string;
    first_name?: string;
    last_name?: string;
  };
  attributes?: JSONObject;
  verified_data: JSONObject & {
    email?: string | boolean;
    phone_number?: string | boolean;
    google_id?: string | boolean;
    apple_id?: string | boolean;
  };
  groups?: JSONObject[];
  meta?: JSONObject;
};

export type RowndUserMetadata = {
  original_rownd_user?: RowndUser;
  rownd_pending_verification?: {
    id: string;
    field: "email";
    value: string;
    created_at: string;
  } | null;
  [key: string]: unknown;
};

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
  appConfig?: RowndAppConfigInput;
}

export interface SuperTokensUserImport {
  externalUserId?: string;
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

export type RowndSchemaField = {
  display_name: string;
  type: string;
  user_visible: boolean;
  owned_by?: string;
  read_only?: boolean;
  show_empty?: boolean;
};

export type RowndSchema = Record<string, RowndSchemaField>;

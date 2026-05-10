import type { JSONObject } from "supertokens-node/types";
import type { RowndSchema } from "./schema";

export type RowndSignInMethods = {
  google?: {
    iosClientId?: string;
    oneTap?: {
      browser?: {
        autoPrompt?: boolean;
        delay?: number;
      };
    };
  };
  anonymous?: {
    enabled: boolean;
    displayName?: string;
    iconLightUrl?: string;
    iconDarkUrl?: string;
  };
  // Custom OAuth2 providers: key = provider ID (hub prefixes with oauth2_ automatically)
  [customProvider: string]: Record<string, any> | undefined;
};

export type RowndBranding = {
  primaryColor?: string;
  logo?: string;
  logoDarkMode?: string;
  roundedCorners?: boolean;
  visualSwoops?: boolean;
  blurBackground?: boolean;
  darkMode?: "auto" | "light" | "dark";
  showAppIcon?: boolean;
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
  signInMethods?: RowndSignInMethods;
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
  appConfig?: RowndAppConfigInput;
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

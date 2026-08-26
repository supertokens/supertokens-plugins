import type { JSONObject, PluginRouteHandler } from "supertokens-node/types";

export type RowndSignInMethod =
  | {
      /**
       * Enables email passwordless sign-in.
       * @default Disabled when omitted.
       */
      method: "email";
    }
  | {
      /**
       * Enables phone passwordless sign-in.
       * @default Disabled when omitted.
       */
      method: "phone";
    }
  | {
      /**
       * Enables Sign in with Apple.
       * @default Disabled when omitted.
       */
      method: "apple";
      /**
       * Apple Services ID used by the hub Apple sign-in script.
       * @default ""
       */
      clientId?: string;
      /**
       * SuperTokens provider clientType used for browser Apple redirect flows.
       */
      webClientType?: string;
      /**
       * SuperTokens provider clientType used for native iOS Apple auth code exchange.
       */
      iosClientType?: string;
      /**
       * SuperTokens provider clientType used for native Android Apple auth code exchange.
       */
      androidClientType?: string;
    }
  | {
      /**
       * Enables Sign in with Google.
       * @default Disabled when omitted.
       */
      method: "google";
      /**
       * Google web client ID used by the hub and Google scripts.
       * @default ""
       */
      clientId?: string;
      /**
       * Google iOS client ID used by mobile-app flows.
       * @default ""
       */
      iosClientId?: string;
      /**
       * Extra OAuth scopes requested by Google sign-in.
       * @default []
       */
      scopes?: string[];
      /**
       * Enables Rownd's faster Google sign-in prompt for supported email domains.
       * @default "enabled"
       */
      signInFasterWithGoogle?: "enabled" | "disabled";
      /**
       * Google One Tap prompt settings.
       * @default autoPrompt false and 7000ms delay per platform.
       */
      oneTap?: {
        browser?: {
          /**
           * Whether the browser hub should automatically show One Tap.
           * @default false
           */
          autoPrompt?: boolean;
          /**
           * Delay before the browser One Tap prompt is shown, in milliseconds.
           * @default 7000
           */
          delay?: number;
        };
        mobileApp?: {
          /**
           * Whether mobile-app integrations should automatically show One Tap.
           * @default false
           */
          autoPrompt?: boolean;
          /**
           * Delay before the mobile-app One Tap prompt is shown, in milliseconds.
           * @default 7000
           */
          delay?: number;
        };
      };
    }
  | {
      /**
       * Enables guest/instant-user sign-in.
       * @default Disabled when omitted.
       */
      method: "anonymous";
      /**
       * Anonymous sign-in mode. "instant" emits Rownd instant-user config instead of the guest button.
       * @default "guest"
       */
      type?: "guest" | "instant";
      /**
       * Button label for anonymous sign-in.
       * @default "Continue as a guest"
       */
      displayName?: string;
      /**
       * Light-mode icon URL for the anonymous sign-in button.
       * @default Built-in icon.
       */
      iconLightUrl?: string;
      /**
       * Dark-mode icon URL for the anonymous sign-in button.
       * @default iconLightUrl or the built-in icon.
       */
      iconDarkUrl?: string;
    }
  | {
      /**
       * Enables a custom OAuth2 provider under this method key.
       * @default Disabled when omitted.
       */
      method: string;
      /**
       * Provider display name in the sign-in button.
       * @default method
       */
      displayName?: string;
      /**
       * Light-mode provider icon URL for the sign-in button.
       * @default No custom icon.
       */
      iconLightUrl?: string;
      /**
       * Dark-mode provider icon URL for the sign-in button.
       * @default iconLightUrl or no custom icon.
       */
      iconDarkUrl?: string;
      /** Additional provider-specific config retained for future Rownd-compatible options. */
      [key: string]: unknown;
    };

export type RowndBranding = {
  /**
   * Primary hub color in light mode.
   * @default "#5b5bd6"
   */
  primaryColor?: string;
  /**
   * Primary hub color in dark mode.
   * @default "#c8aaff"
   */
  primaryColorDarkMode?: string;
  /**
   * Light-mode logo URL.
   * @default appConfig.icon
   */
  logo?: string;
  /**
   * Dark-mode logo URL.
   * @default logo, then appConfig.icon
   */
  logoDarkMode?: string;
  /**
   * Raw Rownd animation asset/config overrides.
   * @default undefined
   */
  animations?: JSONObject;
  /**
   * Whether hub controls use rounded corners.
   * @default true
   */
  roundedCorners?: boolean;
  /**
   * Radius in pixels applied to hub containers and controls. Hub caps it at 30px.
   * @default undefined
   */
  containerBorderRadius?: number;
  /**
   * Floating launcher placement, such as "bottom-left" or "hidden".
   * @default "bottom-left"
   */
  placement?: string;
  /**
   * Hub-specific primary color override.
   * @default primaryColor
   */
  hubPrimaryColor?: string;
  /**
   * Hub background color override.
   * @default undefined
   */
  backgroundColor?: string;
  /**
   * Hub font family override.
   * @default undefined
   */
  fontFamily?: string;
  /**
   * Hides Rownd verification icons in hub UI.
   * @default false
   */
  hideVerificationIcons?: boolean;
  /**
   * Whether decorative swoops are shown on sign-in and wallet screens.
   * @default true
   */
  visualSwoops?: boolean;
  /**
   * Whether modal background blur is enabled.
   * @default true
   */
  blurBackground?: boolean;
  /**
   * Opacity applied to the modal background blur.
   * @default undefined
   */
  blurBackgroundOpacity?: number;
  /**
   * Horizontal launcher offset in pixels.
   * @default undefined
   */
  offsetX?: number;
  /**
   * Vertical launcher offset in pixels.
   * @default undefined
   */
  offsetY?: number;
  /**
   * Raw CSS variable/property overrides consumed by Rownd hub.
   * @default undefined
   */
  propertyOverrides?: JSONObject;
  /**
   * Hub color mode.
   * @default "auto"
   */
  darkMode?: "auto" | "light" | "dark";
  /**
   * Whether the app icon/logo appears inside sign-in and profile modals.
   * @default false
   */
  showAppIcon?: boolean;
  /**
   * Raw CSS snippets injected into the hub document.
   * @default []
   */
  customStyles?: {
    /** CSS text injected into a style tag. */
    content: string;
  }[];
  /**
   * Raw script snippets injected into the hub document.
   * @default []
   */
  customScripts?: {
    /** Script MIME type. */
    type?: string;
    /** Script text injected into a script tag. */
    content: string;
  }[];
};

export type RowndLegal = {
  /**
   * Company name shown in legal copy.
   * @default appConfig.name
   */
  companyName?: string;
  /**
   * Privacy policy link shown in legal/footer components.
   * @default ""
   */
  privacyPolicyUrl?: string;
  /**
   * Terms and conditions link shown in legal/footer components.
   * @default ""
   */
  termsConditionsUrl?: string;
  /**
   * Support address used in error and profile support links.
   * @default Rownd support email.
   */
  supportEmail?: string;
};

export type RowndAuthConfig = {
  /**
   * Requires passwordless sign-in to complete on the originating device for supported Hub UI flows.
   * @default false
   */
  enforceSameDevicePasswordlessSignIn?: boolean;
  /**
   * Whether the hub should preselect the user's previous sign-in method.
   * @default true
   */
  rememberSignInMethod?: boolean;
  /**
   * Enables separate sign-in/sign-up intent flows.
   * @default false
   */
  useExplicitSignUpFlow?: boolean;
  /**
   * Allows new users to authenticate before completing verification.
   * @default false
   */
  allowUnverifiedUsers?: boolean;
  /**
   * Verification email customization.
   * @default Rownd/SuperTokens email defaults.
   */
  email?: {
    fromAddress?: string;
    image?: string;
    subject?: string;
    callToActionText?: string;
    verifyTemplate?: string;
    customContent?: string;
    customClosingContent?: string;
  };
  /**
   * Mobile app install/interstitial customization for magic links.
   * @default Rownd hub built-in mobile copy.
   */
  mobile?: {
    title?: string;
    image?: string;
    callToActionText?: string;
    hyperlinkText?: string;
    hyperlinkRedirectUrl?: string;
    customContent?: string;
  };
  /**
   * Method to use first for explicit sign-up.
   * @default The only visible ordered method, when there is exactly one.
   */
  primarySignUpMethod?: string;
  /**
   * Preferred identifier input when no auth order is provided.
   * @default First ordered input, then "email".
   */
  preferredMethod?: string;
  /**
   * Per-platform sign-in button/input ordering.
   * @default Rownd hub's built-in method order.
   */
  order?: {
    /**
     * Browser/default ordering. Each entry names an auth method and whether it renders as a button or input.
     * @default undefined
     */
    default?: {
      /** Whether the method renders as a button or identifier input. */
      type: "button" | "input";
      /** Sign-in method key, for example email, phone, google, apple, anonymous, or a custom provider key. */
      name: string;
      /**
       * Hides the method from the initial sign-up view; sign-in flows can still show it.
       * @default false
       */
      hidden?: boolean;
    }[];
    /**
     * iOS webview ordering.
     * @default default
     */
    ios?: {
      /** Whether the method renders as a button or identifier input. */
      type: "button" | "input";
      /** Sign-in method key, for example email, phone, google, apple, anonymous, or a custom provider key. */
      name: string;
      /**
       * Hides the method from the initial sign-up view; sign-in flows can still show it.
       * @default false
       */
      hidden?: boolean;
    }[];
    /**
     * Android webview ordering.
     * @default default
     */
    android?: {
      /** Whether the method renders as a button or identifier input. */
      type: "button" | "input";
      /** Sign-in method key, for example email, phone, google, apple, anonymous, or a custom provider key. */
      name: string;
      /**
       * Hides the method from the initial sign-up view; sign-in flows can still show it.
       * @default false
       */
      hidden?: boolean;
    }[];
  };
  /**
   * Extra fields collected during sign-in/sign-up.
   * @default []
   */
  additionalFields?: {
    /** User data key posted with the collected value. */
    name: string;
    /** Input renderer type, for example input, text, tel, email, or select. */
    type: string;
    /** Label shown next to the field. */
    label: string;
    /**
     * Placeholder shown for text-like inputs.
     * @default undefined
     */
    placeholder?: string;
    /**
     * Select/radio choices. For option-based fields, the first option is the default when no value is provided.
     * @default First option value.
     */
    options: {
      /** Submitted value for this option. */
      value: string;
      /** Label shown to the user for this option. */
      label: string;
    }[];
  }[];
};

export type RowndProfileConfig = {
  /**
   * Controls which account identifiers/sign-in methods are shown in the profile account section.
   * @default All visible user-facing account fields.
   */
  accountInformation?: {
    /**
     * Per-method visibility.
     * @default Each method enabled when omitted.
     */
    methods?: Record<
      string,
      {
        /**
         * Whether the method/account identifier is visible.
         * @default true
         */
        enabled?: boolean;
      }
    >;
  };
  /**
   * Shows the personal information profile section.
   * @default true
   */
  personalInformation?: {
    /**
     * Whether the section is visible.
     * @default true
     */
    enabled?: boolean;
  };
  /**
   * Shows the preferences/support profile section.
   * @default true
   */
  preferences?: {
    /**
     * Whether the section is visible.
     * @default true
     */
    enabled?: boolean;
  };
  /**
   * Shows the sign-out button in the profile modal.
   * @default true
   */
  signOutButton?: {
    /**
     * Whether the button is visible.
     * @default true
     */
    enabled?: boolean;
  };
  /**
   * Shows the delete-account action in preferences.
   * @default false
   */
  deleteAccountButton?: {
    /**
     * Whether the delete-account action is visible.
     * @default false
     */
    enabled?: boolean;
  };
  /**
   * Shows the add sign-in methods action in the profile modal.
   * @default true
   */
  addSignInMethodsButton?: {
    /** Whether the button is visible. */
    enabled?: boolean;
  };
};

export type RowndCustomContent = {
  /**
   * Text overrides for the sign-in modal.
   * @default Rownd hub built-in copy.
   */
  signInModal?: {
    /**
     * Main modal title. Can be overridden per requestSignIn call.
     * @default Rownd hub built-in title.
     */
    title?: string;
    /**
     * Main modal subtitle.
     * @default Rownd hub built-in subtitle.
     */
    subtitle?: string;
    /**
     * Title when explicit sign-in intent is active.
     * @default Rownd hub built-in sign-in title.
     */
    signInTitle?: string;
    /**
     * Title when explicit sign-up intent is active.
     * @default Rownd hub built-in sign-up title.
     */
    signUpTitle?: string;
    /**
     * Subtitle when explicit sign-in intent is active.
     * @default Rownd hub built-in sign-in subtitle.
     */
    signInSubtitle?: string;
    /**
     * Subtitle when explicit sign-up intent is active.
     * @default Rownd hub built-in sign-up subtitle.
     */
    signUpSubtitle?: string;
    /**
     * Explicit sign-in CTA text.
     * @default Rownd hub built-in sign-in button text.
     */
    signInButton?: string;
    /**
     * Explicit sign-up CTA text.
     * @default Rownd hub built-in sign-up button text.
     */
    signUpButton?: string;
  };
  /**
   * Profile modal text overrides.
   * @default Rownd hub built-in profile copy.
   */
  profileModal?: {
    /**
     * Profile modal title.
     * @default "Your profile"
     */
    title?: string;
  };
  /**
   * Verification modal text overrides.
   * @default Rownd hub built-in verification copy.
   */
  verificationModal?: {
    /**
     * Verification modal title.
     * @default Rownd hub built-in verification title.
     */
    title?: string;
    /**
     * Verification modal subtitle.
     * @default Rownd hub built-in verification subtitle.
     */
    subtitle?: string;
  };
  /**
   * Sign-in failure modal text overrides.
   * @default Rownd hub built-in error copy.
   */
  signInFailureModal?: {
    /**
     * Message shown when sign-in fails.
     * @default Rownd hub built-in error copy.
     */
    failureMessage?: string;
  };
  /**
   * No-account modal text overrides.
   * @default Rownd hub built-in copy.
   */
  noAccountMessage?: {
    /** No-account modal title. */
    title?: string;
  };
  /**
   * Raw mobile custom content config consumed by Rownd hub.
   * @default undefined
   */
  mobile?: JSONObject;
};

export type RowndAppConfigInput = {
  /**
   * Rownd app ID returned by the app-config endpoint.
   * @default ""
   */
  id?: string;
  /**
   * App display name used in the hub UI and legal fallback copy.
   * @default SuperTokens appInfo.appName
   */
  name?: string;
  /**
   * App icon URL used as the fallback logo/favicon.
   * @default ""
   */
  icon?: string;
  /**
   * User profile fields that can verify a user.
   * @default Rownd hub defaults.
   */
  userVerificationFields?: string[];
  /**
   * Visual customization for the hub UI.
   * @default Defaults documented in RowndBranding.
   */
  branding?: RowndBranding;
  /**
   * Native/web app capability metadata from Rownd.
   * @default undefined
   */
  capabilities?: JSONObject;
  /**
   * Browser/web app config from Rownd.
   * @default undefined
   */
  web?: JSONObject;
  /**
   * Bottom sheet config from Rownd.
   * @default undefined
   */
  bottomSheet?: JSONObject;
  /**
   * Rownd profile storage version metadata.
   * @default undefined
   */
  profileStorageVersion?: string;
  /**
   * Allowed web origins metadata from Rownd hub config.
   * @default undefined
   */
  allowedWebOrigins?: string[];
  /**
   * Legal links and support contact shown in hub flows.
   * @default Defaults documented in RowndLegal.
   */
  legal?: RowndLegal;
  /**
   * Copy overrides for hub modals.
   * @default Rownd hub built-in copy.
   */
  customContent?: RowndCustomContent;
  /**
   * Profile modal feature visibility.
   * @default Defaults documented in RowndProfileConfig.
   */
  profile?: RowndProfileConfig;
  /**
   * Authentication flow options.
   * @default Defaults documented in RowndAuthConfig.
   */
  auth?: RowndAuthConfig;
  /**
   * Enabled sign-in methods.
   * @default []
   */
  signInMethods?: RowndSignInMethod[];
};

export type RowndSubBrandConfigInput = RowndAppConfigInput & {
  variant: {
    id: string;
    name?: string;
    config?: JSONObject;
  };
};

export type RowndPluginDynamicConfig = {
  clientDomains?: RowndClientDomains;
  crossDeviceConfirmationBypass?: {
    allowedRedirectPaths: string[];
  };
  /** Optional field schema override. If omitted, DEFAULT_ROWND_SCHEMA is used. */
  schema?: RowndSchema;
  /** Optional app configuration served by GET /plugin/rownd/app-config. */
  appConfig?: RowndAppConfigInput;
  /** Optional app configs keyed by Rownd application variant ID. */
  subBrands?: Record<string, RowndSubBrandConfigInput>;
  emailChange?: {
    /**
     * Positive, finite maximum age in seconds for a native SuperTokens session
     * to initiate a verified sign-in email change.
     * @default 600
     */
    maxSessionAgeSeconds?: number;
  };
};

export type RowndConfigResolverContext = {
  tenantId?: string;
  request?: Parameters<PluginRouteHandler["handler"]>[0];
  userContext: Record<string, unknown>;
};

export interface RowndPluginConfig extends RowndPluginDynamicConfig {
  rowndAppKey?: string;
  rowndAppSecret?: string;
  /**
   * Disables Rownd user and session migration. This must be enabled when
   * rowndAppKey or rowndAppSecret is omitted.
   * @default false
   */
  disableRowndUserMigration?: boolean;
  enableDebugLogs?: boolean;
  telemetry?: RowndTelemetryConfig;
  /** Resolves request/tenant-specific fields. Returned fields override static dynamic fields. */
  resolveConfig?: (
    context: RowndConfigResolverContext,
  ) => RowndPluginDynamicConfig | Promise<RowndPluginDynamicConfig>;
}

/**
 * Compatibility metadata accepted in profile update request bodies.
 * These values select client routing behavior; they do not grant permission to
 * change or verify an email address.
 */
export interface RowndEmailChangeRequestContext {
  rowndDisplayContext?: "browser" | "mobile_app" | "customer_web_view";
  rowndClientDomain?: string;
  /** Indicates that the native container can complete email verification. */
  rowndNativeEmailVerification?: boolean;
}

export type RowndClientDomains = {
  mobile?: string;
  browser?: string;
} & Record<string, string>;

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
  /** Preserves the Rownd profile shape used by compatibility endpoints and claims. */
  original_rownd_user?: RowndUser;
  /** Legacy account-wide pointer to the canonical Passwordless email recipe user. */
  rownd_email_recipe_user_id?: string;
  /** Selects the canonical Passwordless email recipe user independently for each tenant. */
  rownd_email_recipe_user_ids?: Record<string, string>;
  /** Prevents a successfully imported Rownd user from being migrated again. */
  rownd_migration_complete?: boolean;
  /** Tracks verified profile changes until they commit or are safely reconciled. */
  rownd_pending_verification?: Array<{
    /** Correlates the pending operation with the verification link that completes it. */
    id: string;
    /** Identifies the profile field being verified; currently only email is supported. */
    field: string;
    /** Stores the proposed field value that must match the verified value. */
    value: string;
    /** Records when the operation started for diagnostics and lifecycle checks. */
    created_at: string;
    /** Scopes verification and credential changes to the initiating tenant. */
    tenantId?: string;
    /** Distinguishes replacing an email method from adding the account's first one. */
    purpose?: "UPDATE_PASSWORDLESS" | "ADD_PASSWORDLESS";
    /** Binds completion to the exact session that initiated the profile change. */
    initiatingSessionHandle?: string;
    /** Identifies the existing recipe user used as the EmailVerification subject. */
    verificationRecipeUserId?: string;
    /** Separates an awaiting-verification operation from durable credential cleanup. */
    status?: "PENDING" | "COMMITTING";
    /** Identifies the verified Passwordless method that cleanup must make canonical. */
    targetCanonicalRecipeUserId?: string;
    /** Lists superseded Passwordless methods that durable cleanup must remove from the tenant. */
    cleanupRecipeUserIds?: string[];
  }>;
  /** Allows application metadata to coexist with the plugin's reserved Rownd fields. */
  [key: string]: unknown;
};

export interface MigrationResponse {
  status: "OK" | "ERROR";
  message?: string;
}

export interface RowndPluginNormalisedConfig {
  rowndAppKey: string;
  rowndAppSecret?: string;
  disableRowndUserMigration: boolean;
  enableDebugLogs?: boolean;
  clientDomains?: RowndClientDomains;
  crossDeviceConfirmationBypass?: {
    allowedRedirectPaths: string[];
  };
  telemetry?: RowndTelemetryConfig;
  schema?: RowndSchema;
  appConfig?: RowndAppConfigInput;
  subBrands?: Record<string, RowndSubBrandConfigInput>;
  emailChange: {
    maxSessionAgeSeconds: number;
  };
  resolveConfig?: RowndPluginConfig["resolveConfig"];
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
        isPrimary?: boolean;
        tenantIds?: string[];
      }
    | {
        recipeId: "thirdparty";
        thirdPartyId: string;
        thirdPartyUserId: string;
        email: string;
        isVerified: boolean;
        isPrimary?: boolean;
        tenantIds?: string[];
      }
    | {
        recipeId: "passwordless";
        email?: string;
        phoneNumber?: string;
        isVerified: boolean;
        isPrimary?: boolean;
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
  include_in_session_claims?: boolean;
  session_claim_name?: string;
};

export type RowndSchema = Record<string, RowndSchemaField>;

import { defaultTranslationsTenantEnrollment } from "./translations";

export type SuperTokensPluginTenantEnrollmentPluginConfig = {};

export type OverrideableTenantFunctionImplementation = {
  withSignUpBlockedRedirect: (callback: () => Promise<void>) => Promise<void>;
};

export type TranslationKeys = keyof (typeof defaultTranslationsTenantEnrollment)["en"];

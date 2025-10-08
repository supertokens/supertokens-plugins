import { MultiFactorAuthPreBuiltUI } from "supertokens-auth-react/recipe/multifactorauth/prebuiltui";

import { defaultTranslationsSecurity } from "./translations";

export type SuperTokensPluginProfileSecurityConfig = undefined;

export type TranslationKeys =
  | keyof (typeof defaultTranslationsSecurity)["en"]
  | keyof (typeof MultiFactorAuthPreBuiltUI.languageTranslations)["en"];

export type ProfileDetails = Record<string, string | number | boolean | null | undefined>;
export type AccountDetails = {
  emails: string[];
  phoneNumbers: string[];
  connectedAccounts: ConnectedAccount[];
};

export type ConnectedAccount = {
  provider: string;
  email: string;
};

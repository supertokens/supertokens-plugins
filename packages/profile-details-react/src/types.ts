import { BaseInput, FormFieldType } from "@shared/ui";

import { defaultTranslationsCommonDetails } from "./translations";

export type SuperTokensPluginProfileDetailsConfig = undefined;

export type SuperTokensPluginProfileDetailsImplementation = {
  componentMap: (componentMap: FormInputComponentMap) => FormInputComponentMap;
};

export type FormInputComponentMap = Record<FormFieldType, React.FC<BaseInput<any>>>;
export type TranslationKeys = keyof (typeof defaultTranslationsCommonDetails)["en"];

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

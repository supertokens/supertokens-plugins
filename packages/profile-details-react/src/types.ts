import { BaseInput, FormFieldType, FormFieldValue } from "@shared/ui";
import { BaseFormField } from "@supertokens-plugins/profile-details-shared";

import { defaultTranslationsCommonDetails } from "./translations";

export type SuperTokensPluginProfileDetailsConfig = undefined;
export type SuperTokensPluginProfileDetailsNormalisedConfig = undefined;

export type SuperTokensPluginProfileDetailsImplementation = {
  fieldInputComponentMap: (componentMap: FormInputComponentMap) => FormInputComponentMap;
  fieldViewComponentMap: (componentMap: FormViewComponentMap) => FormViewComponentMap;
};

export type TranslationKeys = keyof (typeof defaultTranslationsCommonDetails)["en"];
export type FieldViewComponentProps<T extends FormFieldValue = FormFieldValue> = {
  value: T;
  className?: string;
  options?: BaseFormField["options"];
};
export type FormInputComponentMap = Record<FormFieldType, React.FC<BaseInput<any>>>;
export type FormViewComponentMap = Omit<Record<FormFieldType, React.FC<FieldViewComponentProps<any>>>, "password">;

export type ProfileDetails = Record<string, string | number | boolean | null | undefined>;
export type AccountDetails = {
  emails: string[];
  phoneNumbers: string[];
  connectedAccounts: ConnectedAccount[];
  timeJoined: number;
};

export type ConnectedAccount = {
  provider: string;
  email: string;
};

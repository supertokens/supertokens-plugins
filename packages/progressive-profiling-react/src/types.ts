import { BaseInput, FormFieldType } from "@shared/ui";

import { defaultTranslationsProgressiveProfiling } from "./translations";

export type SuperTokensPluginProfileProgressiveProfilingConfig = undefined;

export type SuperTokensPluginProfileProgressiveProfilingImplementation = {
  componentMap: (componentMap: FormInputComponentMap) => FormInputComponentMap;
};

export type TranslationKeys = keyof (typeof defaultTranslationsProgressiveProfiling)["en"];
export type FormInputComponentMap = Record<FormFieldType, React.FC<BaseInput<any>>>;

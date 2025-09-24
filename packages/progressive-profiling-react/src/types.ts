import { BaseInput, FormFieldType } from "@shared/ui";
import { ProfileFormData } from "@supertokens-plugins/progressive-profiling-shared";

import { defaultTranslationsProgressiveProfiling } from "./translations";

export type SuperTokensPluginProfileProgressiveProfilingConfig = {
  setupPagePath?: string;
  requireSetup?: boolean;
  showStartSection?: boolean;
  showEndSection?: boolean;
  onSuccess?: (data: ProfileFormData) => Promise<void> | undefined;
};

export type SuperTokensPluginProfileProgressiveProfilingNormalisedConfig = {
  setupPagePath: string;
  requireSetup: boolean;
  showStartSection: boolean;
  showEndSection: boolean;
  onSuccess?: (data: ProfileFormData) => Promise<void> | undefined;
};

export type SuperTokensPluginProfileProgressiveProfilingImplementation = {
  componentMap: () => FormInputComponentMap;
};

export type TranslationKeys = keyof (typeof defaultTranslationsProgressiveProfiling)["en"];
export type FormInputComponentMap = Record<FormFieldType, React.FC<BaseInput<any>>>;

import type { BaseFormField, BaseFormSection, BaseProfile } from "@supertokens-plugins/profile-details-shared";

export type SuperTokensPluginProfileDetailsConfig =
  | {
      sections?: BaseFormSection[];
      registerSectionsForProgressiveProfiling?: boolean;
    }
  | undefined;

export type SuperTokensPluginProfileDetailsImplementation = {
  thirdPartyFieldMap: (originalImplementation: ThirdPartyFieldMap) => ThirdPartyFieldMap;
};

export type SuperTokensPluginProfileDetailsNormalisedConfig = {
  sections: BaseFormSection[];
  registerSectionsForProgressiveProfiling: boolean;
};

export type ThirdPartyFieldMap = (
  providerId: string,
  field: BaseFormField & { sectionId: string },
  rawUserInfoFromProvider: any,
  profile: BaseProfile
) => BaseProfile[string];

import type { BaseFormField, BaseFormSection, BaseProfile } from "@supertokens-plugins/profile-details-shared";

export type SuperTokensPluginProfileDetailsConfig =
  | {
      sections?: BaseFormSection[];
    }
  | undefined;

export type SuperTokensPluginProfileDetailsImplementation = {
  thirdPartyFieldMap: (originalImplementation: ThirdPartyFieldMap) => ThirdPartyFieldMap;
};

export type SuperTokensPluginProfileDetailsNormalisedConfig = {
  sections: BaseFormSection[];
};

export type ThirdPartyFieldMap = (
  providerId: string,
  field: BaseFormField & { sectionId: string },
  rawUserInfoFromProvider: any,
  profile: BaseProfile,
) => BaseProfile[string];

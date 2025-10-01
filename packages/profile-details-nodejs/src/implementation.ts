import { SuperTokensPluginProfileDetailsNormalisedConfig } from "./types";
import { METADATA_PROFILE_KEY } from "./constants";
import { pluginUserMetadata } from "@shared/nodejs";
import {
  BaseFormField,
  BaseFormFieldPayload,
  BaseProfile,
  BaseFormSection,
} from "@supertokens-plugins/profile-details-shared";
import { FormFieldValue } from "@shared/ui";
import { SessionContainerInterface } from "supertokens-node/recipe/session/types";

export class Implementation {
  static instance: Implementation | undefined;

  protected sections: BaseFormSection[] = [];

  static init(pluginConfig: SuperTokensPluginProfileDetailsNormalisedConfig): Implementation {
    if (Implementation.instance) {
      return Implementation.instance;
    }
    Implementation.instance = new Implementation(pluginConfig);

    return Implementation.instance;
  }

  static getInstanceOrThrow(): Implementation {
    if (!Implementation.instance) {
      throw new Error("Implementation instance not found. Make sure you have initialized the plugin.");
    }

    return Implementation.instance;
  }

  static reset(): void {
    Implementation.instance = undefined;
  }

  constructor(pluginConfig: SuperTokensPluginProfileDetailsNormalisedConfig) {
    this.sections = pluginConfig.sections;
  }

  defaultStorageHandlerGet = async function (
    this: Implementation,
    userId: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    session: SessionContainerInterface,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    userContext?: Record<string, any>
  ): Promise<{
    profile: Record<string, FormFieldValue>;
  }> {
    const metadataHandler = pluginUserMetadata<{ profile: Record<string, FormFieldValue> }>(METADATA_PROFILE_KEY);
    return await metadataHandler.get(userId);
  };

  defaultStorageHandlerSet = async function (
    this: Implementation,
    userId: string,
    payload: {
      profile: Record<string, FormFieldValue>;
    },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    session: SessionContainerInterface,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    userContext?: Record<string, any>
  ): Promise<void> {
    const metadataHandler = pluginUserMetadata<{ profile: Record<string, FormFieldValue> }>(METADATA_PROFILE_KEY);
    await metadataHandler.set(userId, payload);
  };

  getPluginFormFields = function (
    this: Implementation,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    session: SessionContainerInterface,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    userContext?: Record<string, any>
  ): (BaseFormField & { sectionId: string })[] {
    return this.sections.flatMap((section) =>
      section.fields.map((f: BaseFormField) => ({ ...f, sectionId: section.id }))
    );
  };

  getFieldValueFromThirdPartyUserInfo = function (
    this: Implementation,
    providerId: string,
    field: BaseFormField & { sectionId: string },
    rawUserInfoFromProvider: any,
    profile: BaseProfile
  ): BaseProfile[string] {
    // only override if the profile doesn't have a value for this field
    if (profile[field.id]) return undefined;

    if (field.id === "firstName") {
      return (
        rawUserInfoFromProvider?.name ??
        rawUserInfoFromProvider?.user?.rawUserInfoFromProvider?.user?.name ??
        rawUserInfoFromProvider?.given_name ??
        rawUserInfoFromProvider?.first_name
      );
    } else if (field.id === "lastName") {
      return (
        rawUserInfoFromProvider?.user?.lastName ??
        rawUserInfoFromProvider?.family_name ??
        rawUserInfoFromProvider?.last_name
      );
    } else if (field.id === "avatar") {
      return rawUserInfoFromProvider?.user?.avatar_url ?? rawUserInfoFromProvider?.picture;
    } else if (field.id === "facebookUrl") {
      return rawUserInfoFromProvider?.user?.facebook_url ?? rawUserInfoFromProvider?.facebook;
    }

    return undefined;
  };

  getProfile = async function (
    this: Implementation,
    userId: string,
    session: SessionContainerInterface,
    userContext?: Record<string, any>
  ): Promise<BaseProfile> {
    const userMetadata = await this.defaultStorageHandlerGet(userId, session, userContext);
    let profile = userMetadata?.profile as BaseProfile;
    if (!userMetadata) {
      profile = this.buildProfile([], {}, session, userContext);
      await this.defaultStorageHandlerSet(userId, { profile }, session, userContext);
    }

    return profile;
  };

  updateProfile = async function (
    this: Implementation,
    userId: string,
    payload: BaseFormFieldPayload[],
    session: SessionContainerInterface,
    userContext?: Record<string, any>
  ): Promise<void> {
    const existingProfile = await this.getProfile(userId, session, userContext);
    const profile = this.buildProfile(payload, existingProfile, session, userContext);

    await this.defaultStorageHandlerSet(
      userId,
      {
        profile: {
          ...existingProfile,
          ...profile,
        },
      },
      session,
      userContext
    );
  };

  buildProfile = function (
    this: Implementation,
    formData: BaseFormFieldPayload[],
    existingProfile: BaseProfile,
    session: SessionContainerInterface,
    userContext?: Record<string, any>
  ): BaseProfile {
    return this.getPluginFormFields(session, userContext).reduce(
      (acc, field) => {
        return {
          ...acc,
          [field.id]:
            formData.find((d) => d.fieldId === field.id)?.value ?? existingProfile?.[field.id] ?? field.default,
        };
      },
      { ...existingProfile }
    );
  };

  buildFormData = function (
    this: Implementation,
    profile: BaseProfile,
    session: SessionContainerInterface,
    userContext?: Record<string, any>
  ): BaseFormFieldPayload[] {
    return this.getPluginFormFields(session, userContext).map((field) => ({
      sectionId: field.sectionId,
      fieldId: field.id,
      value: profile[field.id] ?? field.default,
    }));
  };

  getSections = function (
    this: Implementation,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    session: SessionContainerInterface,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    userContext?: Record<string, any>
  ): BaseFormSection[] {
    return this.sections.map((section) => ({
      ...section,
      fields: section.fields.map(({ ...field }) => field),
    }));
  };
}

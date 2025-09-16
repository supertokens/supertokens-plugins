import type { BaseProfile, BaseField, BaseFormFieldPayload } from "@supertokens-plugins/profile-details-shared";

export const buildProfile = (
  pluginFields: BaseField[],
  formData: BaseFormFieldPayload[],
  existingProfile: BaseProfile,
): BaseProfile => {
  return pluginFields.reduce(
    (acc, field) => {
      return {
        ...acc,
        [field.id]: formData.find((d) => d.fieldId === field.id)?.value ?? existingProfile?.[field.id] ?? field.default,
      };
    },
    { ...existingProfile },
  );
};

export const buildFormData = (
  pluginFields: (BaseField & { sectionId: string })[],
  profile: BaseProfile,
): BaseFormFieldPayload[] => {
  return pluginFields.map((field) => ({
    sectionId: field.sectionId,
    fieldId: field.id,
    value: profile[field.id] ?? field.default,
  }));
};

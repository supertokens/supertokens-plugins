import { BaseFormField, BaseProfile } from "@supertokens-plugins/profile-details-shared";

export const defaultThirdPartyFieldMap = (
  providerId: string,
  field: BaseFormField & { sectionId: string },
  rawUserInfoFromProvider: any,
  profile: BaseProfile,
) => {
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

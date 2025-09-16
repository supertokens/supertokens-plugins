import { Button, FormInput, usePrettyAction } from "@shared/ui";
import {
  BaseFormSection,
  BaseFormField,
  BaseFormFieldPayload,
  BaseProfile,
} from "@supertokens-plugins/profile-details-shared";
import classNames from "classnames/bind";
import { useCallback, useEffect, useState } from "react";
import { User } from "supertokens-web-js/types";

import { usePluginContext } from "../../plugin";
import { FormInputComponentMap } from "../../types";

import style from "./details-section.module.css";

const cx = classNames.bind(style);

const FieldValue = ({ field, value }: { field: BaseFormField; value: any }) => {
  const { t } = usePluginContext();

  if (value === null || value === undefined || value === "") {
    return <span className={cx("supertokens-plugin-profile-details-empty")}>{t("PL_CD_NOT_PROVIDED")}</span>;
  }

  switch (field.type) {
    case "boolean":
      return value ? t("PL_CD_YES") : t("PL_CD_NO");
    case "multiselect":
      if (Array.isArray(value)) {
        return value.length > 0 ? value.join(", ") : t("PL_CD_NONE_SELECTED");
      }
      return t("PL_CD_NONE_SELECTED");
    case "select":
      return field.options?.find((opt) => opt.value === value)?.label ?? value;
    case "image-url":
      return value ? (
        <div className={cx("supertokens-plugin-profile-details-image-preview")}>
          <img
            src={value}
            alt={t("PL_CD_IMAGE_ALT")}
            className={cx("supertokens-plugin-profile-details-image-thumb")}
          />
          <span>{value}</span>
        </div>
      ) : (
        t("PL_CD_NO_IMAGE")
      );
    case "url":
      return value ? (
        <a
          href={value}
          target="_blank"
          rel="noopener noreferrer"
          className={cx("supertokens-plugin-profile-details-link")}>
          {value}
        </a>
      ) : (
        t("PL_CD_NO_URL")
      );
    case "email":
      return value ? (
        <a href={`mailto:${value}`} className={cx("supertokens-plugin-profile-details-link")}>
          {value}
        </a>
      ) : (
        t("PL_CD_NO_EMAIL")
      );
    case "phone":
      return value ? (
        <a href={`tel:${value}`} className={cx("supertokens-plugin-profile-details-link")}>
          {value}
        </a>
      ) : (
        t("PL_CD_NO_PHONE")
      );
    default:
      return value;
  }
};

export const DetailsSectionContent = ({
  onSubmit,
  onFetch,
  section,
  componentMap,
}: {
  section: BaseFormSection;
  onSubmit: (data: BaseFormFieldPayload[]) => Promise<any>;
  onFetch: () => Promise<{ profile: Record<string, any>; user: User }>;
  componentMap: FormInputComponentMap;
}) => {
  const { t } = usePluginContext();

  const [isEditing, setIsEditing] = useState(false);

  // Dynamic profile details based on section fields
  const [profileDetails, setProfileDetails] = useState<BaseProfile>(() => {
    return section.fields.reduce(
      (acc, field) => {
        acc[field.id] = field.default ?? "";
        return acc;
      },
      {} as Record<string, any>,
    );
  });
  const [editingProfileDetails, setEditingProfileDetails] = useState<Record<string, any>>(profileDetails);

  const loadDetails = usePrettyAction(
    async () => {
      const details = await onFetch();
      // Only update fields that exist in the current section
      const updatedProfile = { ...profileDetails };
      section.fields.forEach((field) => {
        if (Object.prototype.hasOwnProperty.call(details.profile, field.id)) {
          updatedProfile[field.id] = details.profile[field.id];
        }
      });
      setProfileDetails(updatedProfile);
    },
    [onFetch, section.fields],
    { errorMessage: t("PL_CD_SECTION_DETAILS_ERROR_FETCHING_DETAILS") },
  );

  const handleInputChange = useCallback(
    (field: string, value: any) => {
      setEditingProfileDetails({
        ...editingProfileDetails,
        [field]: value,
      });
    },
    [editingProfileDetails],
  );

  const toggleEditing = useCallback(() => {
    setIsEditing(!isEditing);
    setEditingProfileDetails(profileDetails);
  }, [isEditing, profileDetails]);

  const handleFormSubmit = useCallback(async () => {
    const data: BaseFormFieldPayload[] = [];
    Object.entries(editingProfileDetails).map(([key, value]) => {
      data.push({
        sectionId: section.id,
        fieldId: key,
        value: value.toString(),
      });
    });

    setProfileDetails(editingProfileDetails);

    try {
      await onSubmit(data);
      setIsEditing(false);
    } catch (error) {
      console.error(error);
    }
  }, [editingProfileDetails, onSubmit]);

  useEffect(() => {
    loadDetails();
  }, []);

  return (
    <div className={cx("supertokens-plugin-profile-details-section")}>
      <div className={cx("supertokens-plugin-profile-details-header")}>
        <h3>{section.label}</h3>
        {section.description ? <p>{section.description}</p> : null}
        <Button
          onClick={toggleEditing}
          variant="neutral"
          className={cx("supertokens-plugin-profile-details-edit-button")}>
          {isEditing ? t("PL_CD_SECTION_DETAILS_CANCEL_BUTTON") : t("PL_CD_SECTION_DETAILS_EDIT_BUTTON")}
        </Button>
      </div>

      {isEditing ? (
        <form className={cx("supertokens-plugin-profile-details-edit-form")}>
          {section.fields
            .sort((a, b) => (a.order || 0) - (b.order || 0))
            .map((field) => (
              <FormInput
                key={field.id}
                value={editingProfileDetails[field.id]}
                onChange={(value) => handleInputChange(field.id, value)}
                componentMap={componentMap}
                {...field}
              />
            ))}

          <div className={cx("supertokens-plugin-profile-details-form-actions")}>
            <Button onClick={handleFormSubmit}>{t("PL_CD_SECTION_DETAILS_SAVE_BUTTON")}</Button>
          </div>
        </form>
      ) : (
        <div>
          <section className={cx("supertokens-plugin-profile-details-group")}>
            {section.fields
              .sort((a, b) => (a.order || 0) - (b.order || 0))
              .map((field) => {
                const value = profileDetails[field.id];
                return (
                  <div key={field.id} className={cx("supertokens-plugin-profile-details-item")}>
                    <span className={cx("supertokens-plugin-profile-details-label")}>{field.label}</span>
                    <span className={cx("supertokens-plugin-profile-details-value")}>
                      <FieldValue field={field} value={value} />
                    </span>
                  </div>
                );
              })}
          </section>
        </div>
      )}
    </div>
  );
};

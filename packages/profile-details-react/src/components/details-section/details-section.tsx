import { usePrettyAction } from "@shared/ui";
import { BaseFormSection, BaseFormFieldPayload, BaseProfile } from "@supertokens-plugins/profile-details-shared";
import classNames from "classnames/bind";
import { useCallback, useEffect, useState } from "react";
import { User } from "supertokens-web-js/types";

import { usePluginContext } from "../../plugin";

import style from "./details-section.module.css";
import { SectionEdit } from "./section-edit";
import { SectionView } from "./section-view";

const cx = classNames.bind(style);

export const DetailsSectionContent = ({
  onSubmit,
  onFetch,
  section,
}: {
  section: BaseFormSection;
  onSubmit: (data: BaseFormFieldPayload[]) => Promise<any>;
  onFetch: () => Promise<{ profile: Record<string, any>; user: User }>;
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

  const toggleEditing = useCallback(() => {
    setIsEditing(!isEditing);
  }, [isEditing]);

  const handleFormSubmit = useCallback(
    async (data: BaseFormFieldPayload[]) => {
      try {
        await onSubmit(data);

        setProfileDetails(
          data.reduce(
            (acc, item) => {
              acc[item.fieldId] = item.value;
              return acc;
            },
            {} as Record<string, any>,
          ),
        );

        setIsEditing(false);
      } catch (error) {
        console.error(error);
      }
    },
    [onSubmit],
  );

  useEffect(() => {
    loadDetails();
  }, []);

  return (
    <div className={cx("supertokens-plugin-profile-details-section")}>
      <div className={cx("supertokens-plugin-profile-details-header")}>
        <h3>{section.label}</h3>
        {section.description ? <p>{section.description}</p> : null}
      </div>

      {isEditing ? (
        <SectionEdit
          id={section.id}
          fields={section.fields}
          values={profileDetails}
          onSubmit={handleFormSubmit}
          onCancel={toggleEditing}
        />
      ) : (
        <SectionView fields={section.fields} values={profileDetails} onEdit={toggleEditing} />
      )}
    </div>
  );
};

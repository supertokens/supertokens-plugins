import { Button, FormInput } from "@shared/ui";
import { BaseFormFieldPayload } from "@supertokens-plugins/profile-details-shared";
import classNames from "classnames/bind";
import { useState, useCallback } from "react";

import { usePluginContext } from "../../plugin";

import style from "./details-section.module.css";

const cx = classNames.bind(style);

export const SectionEdit = ({ id, fields, values, onSubmit, onCancel }) => {
  const { t, fieldInputComponentMap } = usePluginContext();

  const [editingProfileDetails, setEditingProfileDetails] = useState<Record<string, any>>(values);

  const handleInputChange = useCallback(
    (field: string, value: any) => {
      setEditingProfileDetails({
        ...editingProfileDetails,
        [field]: value,
      });
    },
    [editingProfileDetails],
  );

  const handleSubmit = useCallback(async () => {
    const data: BaseFormFieldPayload[] = [];
    Object.entries(editingProfileDetails).map(([key, value]) => {
      data.push({
        sectionId: id,
        fieldId: key,
        value: value,
      });
    });

    await onSubmit(data);
  }, [id, editingProfileDetails, onSubmit]);

  return (
    <section className={cx("supertokens-plugin-profile-details-group")}>
      <form className={cx("supertokens-plugin-profile-details-edit-form")}>
        {fields
          .sort((a, b) => (a.order || 0) - (b.order || 0))
          .map((field) => (
            <div key={field.id} className={cx("supertokens-plugin-profile-details-item")}>
              <span className={cx("supertokens-plugin-profile-details-label")}>
                {field.label}
                {field.required ? <span className={cx("supertokens-plugin-profile-details-required")}>*</span> : null}
              </span>
              <span className={cx("supertokens-plugin-profile-details-value")}>
                <FormInput
                  key={field.id}
                  value={values[field.id]}
                  onChange={(value) => handleInputChange(field.id, value)}
                  componentMap={fieldInputComponentMap}
                  {...field}
                  label={undefined}
                />
              </span>
            </div>
          ))}

        <div className={cx("supertokens-plugin-profile-details-actions")}>
          <Button appearance="outlined" variant="neutral" size="small" onClick={handleSubmit}>
            {t("PL_CD_SECTION_DETAILS_CANCEL_BUTTON")}
          </Button>
          <Button variant="brand" size="small" onClick={handleSubmit}>
            {t("PL_CD_SECTION_DETAILS_SAVE_BUTTON")}
          </Button>
        </div>
      </form>
    </section>
  );
};

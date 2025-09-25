import { Button } from "@shared/ui";
import classNames from "classnames/bind";

import { usePluginContext } from "../../plugin";

import style from "./details-section.module.css";
import { FieldView } from "./field-view-components";

const cx = classNames.bind(style);

export const SectionView = ({ fields, values, onEdit }) => {
  const { t, fieldViewComponentMap } = usePluginContext();

  return (
    <section className={cx("supertokens-plugin-profile-details-group")}>
      {fields
        .sort((a, b) => (a.order || 0) - (b.order || 0))
        .map((field) => {
          const value = values[field.id];
          return (
            <div key={field.id} className={cx("supertokens-plugin-profile-details-item")}>
              <span className={cx("supertokens-plugin-profile-details-label")}>
                {field.label}
                {field.required ? <span className={cx("supertokens-plugin-profile-details-required")}>*</span> : null}
              </span>

              <span className={cx("supertokens-plugin-profile-details-value")}>
                <FieldView
                  type={field.type}
                  value={value}
                  componentMap={fieldViewComponentMap}
                  options={field.options}
                />
              </span>
            </div>
          );
        })}

      <div className={cx("supertokens-plugin-profile-details-actions")}>
        <Button variant="brand" size="small" onClick={onEdit}>
          {t("PL_CD_SECTION_DETAILS_EDIT_BUTTON")}
        </Button>
      </div>
    </section>
  );
};

import { Button } from "@shared/ui";
import { BaseFormField } from "@supertokens-plugins/profile-details-shared";
import classNames from "classnames/bind";

import { usePluginContext } from "../../plugin";

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
    case "toggle":
      return value ? t("PL_CD_ENABLED") : t("PL_CD_DISABLED");
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

export const SectionView = ({ fields, values, onEdit }) => {
  const { t } = usePluginContext();

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
                <FieldValue field={field} value={value} />
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

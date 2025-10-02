import { FormFieldValue } from "@shared/ui";
import classNames from "classnames/bind";
import { useMemo } from "react";

import { usePluginContext } from "../../plugin";
import { FieldViewComponentProps, FormViewComponentMap } from "../../types";

import style from "./details-section.module.css";

const cx = classNames.bind(style);

export const BooleanFieldViewComponent = ({ value, className }: FieldViewComponentProps<boolean>) => {
  const { t } = usePluginContext();
  const isValueDefined = value !== undefined && value !== null;
  return (
    <span className={cx("supertokens-plugin-profile-field-view", className)}>
      {isValueDefined && (value ? t("PL_CD_YES") : t("PL_CD_NO"))}
      {!isValueDefined && (
        <span className={cx("supertokens-plugin-profile-details-empty")}>{t("PL_CD_NOT_PROVIDED")}</span>
      )}
    </span>
  );
};

export const ToggleFieldViewComponent = ({ value, className }: FieldViewComponentProps<boolean>) => {
  const { t } = usePluginContext();
  const isValueDefined = value !== undefined && value !== null;
  return (
    <span className={cx("supertokens-plugin-profile-field-view", className)}>
      {isValueDefined && (value ? t("PL_CD_ENABLED") : t("PL_CD_DISABLED"))}
      {!isValueDefined && (
        <span className={cx("supertokens-plugin-profile-details-empty")}>{t("PL_CD_NOT_PROVIDED")}</span>
      )}
    </span>
  );
};

export const MultiselectFieldViewComponent = ({ value, className, options }: FieldViewComponentProps<string[]>) => {
  const { t } = usePluginContext();

  const valueLabels = useMemo(() => {
    const _value = Array.isArray(value) ? value : [];
    return _value
      .map((v) => {
        const option = options?.find((opt) => opt.value === v);
        return option?.label ?? v;
      })
      .join(", ")
      .trim();
  }, [value, options]);

  return (
    <span className={cx("supertokens-plugin-profile-field-view", className)}>
      {valueLabels}
      {!valueLabels && (
        <span className={cx("supertokens-plugin-profile-details-empty")}>{t("PL_CD_NONE_SELECTED")}</span>
      )}
    </span>
  );
};

export const SelectFieldViewComponent = ({ value, className, options }: FieldViewComponentProps<string>) => {
  const { t } = usePluginContext();

  const valueLabel = useMemo(() => {
    const option = options?.find((opt) => opt.value === value);
    return option?.label ?? value;
  }, [value, options]);

  return (
    <span className={cx("supertokens-plugin-profile-field-view", className)}>
      {valueLabel}
      {!valueLabel && (
        <span className={cx("supertokens-plugin-profile-details-empty")}>{t("PL_CD_NONE_SELECTED")}</span>
      )}
    </span>
  );
};

export const ImageUrlFieldViewComponent = ({ value, className }: FieldViewComponentProps<string>) => {
  const { t } = usePluginContext();

  return (
    <span className={cx("supertokens-plugin-profile-field-view", className)}>
      {value && (
        <div className={cx("supertokens-plugin-profile-details-image-preview")}>
          <img
            src={value}
            alt={t("PL_CD_IMAGE_ALT")}
            className={cx("supertokens-plugin-profile-details-image-thumb")}
          />
          <span>{value}</span>
        </div>
      )}
      {!value && <span className={cx("supertokens-plugin-profile-details-empty")}>{t("PL_CD_NO_IMAGE")}</span>}
    </span>
  );
};

export const UrlFieldViewComponent = ({ value, className }: FieldViewComponentProps<string>) => {
  const { t } = usePluginContext();

  return (
    <span className={cx("supertokens-plugin-profile-field-view", className)}>
      {value && (
        <a
          href={value}
          target="_blank"
          rel="noopener noreferrer"
          className={cx("supertokens-plugin-profile-details-link")}>
          {value}
        </a>
      )}
      {!value && <span className={cx("supertokens-plugin-profile-details-empty")}>{t("PL_CD_NO_URL")}</span>}
    </span>
  );
};

export const EmailFieldViewComponent = ({ value, className }: FieldViewComponentProps<string>) => {
  const { t } = usePluginContext();

  return (
    <span className={cx("supertokens-plugin-profile-field-view", className)}>
      {value && (
        <a href={`mailto:${value}`} className={cx("supertokens-plugin-profile-details-link")}>
          {value}
        </a>
      )}
      {!value && <span className={cx("supertokens-plugin-profile-details-empty")}>{t("PL_CD_NO_EMAIL")}</span>}
    </span>
  );
};

export const PhoneFieldViewComponent = ({ value, className }: FieldViewComponentProps<string>) => {
  const { t } = usePluginContext();

  return (
    <span className={cx("supertokens-plugin-profile-field-view", className)}>
      {value && (
        <a href={`tel:${value}`} className={cx("supertokens-plugin-profile-details-link")}>
          {value}
        </a>
      )}
      {!value && <span className={cx("supertokens-plugin-profile-details-empty")}>{t("PL_CD_NO_PHONE")}</span>}
    </span>
  );
};

export const DefaultFieldViewComponent = ({ value, className }: FieldViewComponentProps) => {
  const { t } = usePluginContext();

  return (
    <span className={cx("supertokens-plugin-profile-field-view", className)}>
      {value}
      {!value && <span className={cx("supertokens-plugin-profile-details-empty")}>{t("PL_CD_NOT_PROVIDED")}</span>}
    </span>
  );
};

export const DateFieldViewComponent = ({ value, className }: FieldViewComponentProps<string>) => {
  const { t } = usePluginContext();

  return (
    <span className={cx("supertokens-plugin-profile-field-view", className)}>
      {value && new Date(value).toLocaleDateString()}
      {!value && <span className={cx("supertokens-plugin-profile-details-empty")}>{t("PL_CD_NOT_PROVIDED")}</span>}
    </span>
  );
};

export const FieldView = ({
  value,
  componentMap,
  className,
  type,
  options,
}: FieldViewComponentProps<FormFieldValue> & {
  type: keyof FormViewComponentMap;
  componentMap: FormViewComponentMap;
}) => {
  const FieldComponent = useMemo(() => componentMap[type] || DefaultFieldViewComponent, [componentMap, type]);

  return <FieldComponent value={value} className={className} options={options} />;
};

import classNames from "classnames/bind";

import style from "./form-item.module.css";

const cx = classNames.bind(style);

export const FormRow = ({ label, children, required }: { label: string; children: any; required?: boolean }) => {
  return (
    <div className={cx("supertokens-plugin-profile-security-item")}>
      <span className={cx("supertokens-plugin-profile-security-label")}>
        {label}
        {required && <span className={cx("supertokens-plugin-profile-security-required")}>*</span>}
      </span>
      <span className={cx("supertokens-plugin-profile-security-value")}>{children}</span>
    </div>
  );
};

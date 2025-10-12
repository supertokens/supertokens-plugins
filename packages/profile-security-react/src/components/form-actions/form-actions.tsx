import classNames from "classnames/bind";

import style from "./form-actions.module.css";

const cx = classNames.bind(style);

export const FormActions = ({ children }: { children: any }) => {
  return <div className={cx("supertokens-plugin-profile-security-form-actions")}>{children}</div>;
};

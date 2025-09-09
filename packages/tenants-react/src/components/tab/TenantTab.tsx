import classNames from "classnames/bind";
import React from "react";

import style from "./tenant-tab.module.scss";

const cx = classNames.bind(style);

type TenantTabProps = {
  description: string;
  children: React.ReactNode;
};

export const TenantTab: React.FC<TenantTabProps> = ({ description, children }) => {
  return (
    <div>
      <div className={cx("tabDescription")}>{description}</div>
      <div className={cx("tabChildrenWrapper")}>{children}</div>
    </div>
  );
};

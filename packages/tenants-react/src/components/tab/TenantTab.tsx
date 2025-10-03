import { Card } from "@shared/ui";
import classNames from "classnames/bind";
import React from "react";

import style from "./tenant-tab.module.scss";

const cx = classNames.bind(style);

type TenantTabProps = {
  description: string;
  descriptionComponent?: React.ReactNode;
  children: React.ReactNode;
};

export const TenantTab: React.FC<TenantTabProps> = ({ description, descriptionComponent, children }) => {
  return (
    <Card className={cx("tenantTabCard")}>
      <div slot="header" className={cx("tabDescription")}>
        <div className={cx("tabDescriptionText")}>{description}</div>
        {descriptionComponent && <div>{descriptionComponent}</div>}
      </div>
      <div className={cx("tabChildrenWrapper")}>{children}</div>
    </Card>
  );
};

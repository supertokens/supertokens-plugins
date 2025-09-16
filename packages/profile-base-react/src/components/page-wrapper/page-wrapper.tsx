import classNames from "classnames/bind";
import { ReactNode } from "react";

import style from "./page-wrapper.module.css";

const cx = classNames.bind(style);

export const ProfilePageWrapper = ({ children, style }: { children: ReactNode; style?: React.CSSProperties }) => {
  return (
    <div className={cx("page-wrapper")} style={style}>
      {children}
    </div>
  );
};

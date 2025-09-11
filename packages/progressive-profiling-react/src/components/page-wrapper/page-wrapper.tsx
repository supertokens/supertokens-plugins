import classNames from "classnames/bind";
import { ReactNode } from "react";

import styles from "./page-wrapper.module.css";

const cx = classNames.bind(styles);

export const PageWrapper = ({ children, style }: { children: ReactNode; style?: React.CSSProperties }) => {
  return (
    <div className={cx("page-wrapper")} style={style}>
      {children}
    </div>
  );
};

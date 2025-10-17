import classNames from "classnames/bind";
import React from "react";

import styles from "./error.module.scss";

const cx = classNames.bind(styles);

type ErrorMessageProps = {
  message: string;
};

export const ErrorMessage: React.FC<ErrorMessageProps> = ({ message }) => {
  return <div className={cx("errorMessageWrapper")}>{message}</div>;
};

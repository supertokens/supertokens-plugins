import React from "react";
import classNames from "classnames/bind";
import { useToast } from "./toast-context";
import { Toast } from "./toast";
import style from "./toast.module.css";

const cx = classNames.bind(style);

export const ToastContainer = () => {
  const { toasts } = useToast();

  if (toasts.length === 0) {
    return null;
  }

  return (
    <div className={cx("st-toast-container")}>
      {toasts.map((toast) => (
        <Toast key={toast.id} {...toast} />
      ))}
    </div>
  );
};

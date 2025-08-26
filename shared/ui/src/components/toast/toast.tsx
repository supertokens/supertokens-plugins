import React, { useEffect, useState } from "react";
import classNames from "classnames/bind";
import style from "./toast.module.css";
import { Callout } from "../callout";
import { BaseWaVariant, HTMLElementProps } from "../types";

const cx = classNames.bind(style);

interface ToastProps extends HTMLElementProps {
  id?: string;
  variant: BaseWaVariant;
  message: string;
  duration?: number;
}

export const Toast = (props: ToastProps) => {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    setIsVisible(true);
  }, []);

  const getIcon = () => {
    switch (props.variant) {
      case "success":
        return "circle-check";
      case "danger":
        return "circle-exclamation";
      case "warning":
        return "triangle-exclamation";
      // case 'info':
      //   return 'circle-info';
      default:
        return "gear";
    }
  };

  return (
    <Callout
      {...props}
      className={cx("st-toast", props.className, {
        "st-toast--visible": isVisible,
      })}
      icon={getIcon()}
    >
      {props.message}
    </Callout>
  );
};

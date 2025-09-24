import React, { useEffect, useState } from "react";
import classNames from "classnames/bind";
import style from "./toast.module.css";
import { Callout } from "../callout";
import { BaseWaVariant, HTMLElementProps } from "../types";
import { Button } from "../button";
import { useToast } from "./toast-context";

const cx = classNames.bind(style);

interface ToastProps extends HTMLElementProps {
  id: string;
  variant?: "success" | "warning" | "danger";
  message: string;
  duration?: number;
}

export const Toast = (props: ToastProps) => {
  const [isVisible, setIsVisible] = useState(false);

  const { removeToast } = useToast();

  useEffect(() => {
    setIsVisible(true);
  }, []);

  const getIcon = () => {
    switch (props.variant) {
      case "success":
        return "circle-check";
      case "danger":
        return "triangle-exclamation";
      case "warning":
        return "triangle-exclamation";
      default:
        return "circle-info";
    }
  };

  return (
    <Callout
      {...props}
      className={cx("st-toast", props.className, {
        "st-toast--visible": isVisible,
      })}
      variant={"neutral"}>
      <span className={cx("st-toast-icon", props.variant)}>
        <wa-icon name={getIcon()} variant="regular"></wa-icon>
      </span>

      {props.message}

      <Button
        variant="neutral"
        size="xsmall"
        onClick={() => removeToast(props.id)}
        appearance="plain"
        className={cx("st-toast-close")}>
        <wa-icon name="times" label="Close"></wa-icon>
      </Button>
    </Callout>
  );
};

import classNames from "classnames/bind";
import { useEffect } from "react";
import styles from "./icon.module.scss";
import { useWebComponent } from "../utils";
import { HTMLElementProps } from "../types";
import { IconManager } from "./icon-manager";

const cx = classNames.bind(styles);

export interface IconProps extends HTMLElementProps {
  name?: string;
  family?: string;
  variant?: string;
  fixedWidth?: false;
  src?: string;
  label?: string;
  library?: string;
}

export const Icon = (_props: IconProps) => {
  const { isDefined, props } = useWebComponent({
    name: "wa-icon",
    className: cx("st-icon"),
    props: _props,
    importCallback: () => import("@awesome.me/webawesome/dist/components/icon/icon.js"),
  });

  // Initialize bundled icons when component mounts
  useEffect(() => {
    if (_props.library === "bundled") {
      IconManager.initialize().catch(console.error);
    }
  }, [_props.library]);

  if (!isDefined) return null;

  return <wa-icon {...props}></wa-icon>;
};

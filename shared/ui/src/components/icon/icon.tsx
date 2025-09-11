import classNames from "classnames/bind";
import styles from "./icon.module.scss";
import { useWebComponent } from "../utils";
import { HTMLElementProps } from "../types";

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

  if (!isDefined) return null;

  return <wa-icon {...props}></wa-icon>;
};

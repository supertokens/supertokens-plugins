import classNames from "classnames/bind";
import { useEffect, useState } from "react";
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
  console.log("[Icon] Component rendering with props:", _props);

  const { isDefined, props } = useWebComponent({
    name: "wa-icon",
    className: cx("st-icon"),
    props: _props,
    importCallback: () => import("@awesome.me/webawesome/dist/components/icon/icon.js"),
  });

  console.log("[Icon] isDefined:", isDefined);
  console.log("[Icon] Final props being passed to wa-icon:", props);

  if (!isDefined) {
    console.log("[Icon] Not rendering - wa-icon not defined yet");
    return null;
  }

  console.log("[Icon] Rendering wa-icon");
  return <wa-icon {...props}></wa-icon>;
};

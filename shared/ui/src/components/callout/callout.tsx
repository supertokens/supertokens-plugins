import React from "react";
import classNames from "classnames/bind";
import style from "./callout.module.css";
import { useWebComponent } from "../utils";
import { BaseWaAppearance, BaseWaSize, BaseWaVariant, HTMLElementProps } from "../types";

const cx = classNames.bind(style);

interface CalloutProps extends HTMLElementProps {
  children?: React.ReactNode;
  variant?: BaseWaVariant;
  size?: BaseWaSize;
  appearance?: BaseWaAppearance;
  icon?: string;
}

export const Callout = (_props: CalloutProps) => {
  const { isDefined, props } = useWebComponent({
    components: [
      {
        name: "wa-callout",
        importCallback: () => import("@awesome.me/webawesome/dist/components/callout/callout.js"),
      },
      // { name: 'wa-icon', importCallback: () => import('@awesome.me/webawesome/dist/components/icon/icon.js') },
    ],
    props: _props,
    className: cx("st-callout"),
  });

  if (!isDefined) return null;

  return (
    <wa-callout {...props}>
      {props.children}
      {!!_props.icon && <wa-icon slot="icon" name={_props.icon} variant="regular" />}
    </wa-callout>
  );
};

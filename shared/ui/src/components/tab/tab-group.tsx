import classNames from "classnames/bind";
import styles from "./tab.module.scss";
import { useWebComponent } from "../utils";
import { BaseWaProps, HTMLElementProps } from "../types";

const cx = classNames.bind(styles);

export interface TabGroupProps extends HTMLElementProps, Pick<BaseWaProps, "size"> {
  active?: string;
  placement?: "top" | "bottom" | "start" | "end";
  activation?: "auto" | "manual";
  noScrollControls?: boolean;
  children?: React.ReactNode;
}

export const TabGroup = (_props: TabGroupProps) => {
  const { isDefined, props } = useWebComponent({
    name: "wa-tab-group",
    className: cx("st-tab-group"),
    props: _props,
    importCallback: () => import("@awesome.me/webawesome/dist/components/tab-group/tab-group.js"),
  });

  if (!isDefined) return null;

  return <wa-tab-group {...props}>{props.children}</wa-tab-group>;
};

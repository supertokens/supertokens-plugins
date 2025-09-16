import classNames from "classnames/bind";
import styles from "./tab.module.scss";
import { useWebComponent } from "../utils";
import { HTMLElementProps } from "../types";

const cx = classNames.bind(styles);

export interface TabProps extends HTMLElementProps {
  children?: React.ReactNode;
  panel?: string;
  disabled?: boolean;
}

export const Tab = (_props: TabProps) => {
  const { isDefined, props } = useWebComponent({
    name: "wa-tab",
    className: cx("st-tab"),
    props: _props,
    importCallback: () => import("@awesome.me/webawesome/dist/components/tab/tab.js"),
  });

  if (!isDefined) return null;

  return <wa-tab {...props}>{props.children}</wa-tab>;
};

import classNames from "classnames/bind";
import styles from "./tab.module.scss";
import { useWebComponent } from "../utils";
import { HTMLElementProps } from "../types";

const cx = classNames.bind(styles);

export interface TabPanelProps extends HTMLElementProps {
  children?: React.ReactNode;
  name?: string;
  active?: boolean;
}

export const TabPanel = (_props: TabPanelProps) => {
  const { isDefined, props } = useWebComponent({
    name: "wa-tab-panel",
    className: cx("st-tab-panel"),
    props: _props,
    importCallback: () => import("@awesome.me/webawesome/dist/components/tab-panel/tab-panel.js"),
  });

  if (!isDefined) return null;

  return <wa-tab-panel {...props}>{props.children}</wa-tab-panel>;
};

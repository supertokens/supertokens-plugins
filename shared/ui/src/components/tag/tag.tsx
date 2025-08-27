import classNames from "classnames/bind";
import styles from "./tag.module.css";
import { useWebComponent } from "../utils";
import { HTMLElementProps, BaseWaProps } from "../types";

const cx = classNames.bind(styles);

export interface TagProps extends HTMLElementProps {
  variant: "brand" | "neutral" | "success" | "warning" | "danger";
  /** The tag's visual appearance. */
  appearance: "accent" | "outlined accent" | "filled" | "outlined" | "outlined filled";
  /** The tag's size. */
  size: "xsmall" | "small" | "medium" | "large";
  children: React.ReactNode;
}

export const Tag = (props: TagProps) => {
  const { isDefined, props: computedProps } = useWebComponent({
    components: [
      {
        name: "wa-tag",
        importCallback: () => import("@awesome.me/webawesome/dist/components/tag/tag.js"),
      },
    ],
    props,
    className: cx("st-tag"),
  });

  if (!isDefined) return null;

  return <wa-tag {...computedProps}>{props.children}</wa-tag>;
};

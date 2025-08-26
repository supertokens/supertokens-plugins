import classNames from "classnames/bind";
import styles from "./button.module.css";
import { useWebComponent } from "../utils";
import { BaseWaProps, HTMLElementProps } from "../types";

const cx = classNames.bind(styles);

type ButtonProps = BaseWaProps &
  HTMLElementProps &
  Partial<{
    disabled: boolean;
    children: React.ReactNode;
    loading: boolean;
    onClick: () => void;
    type: string;
    title: string;
    href: string;
    target: string;
    download: string;
    rel: string;
    name: string;
    value: string;
    form: string;
    formAction: string;
    formEnctype: string;
    formMethod: string;
    formNoValidate: boolean;
  }>;

export const Button = (_props: ButtonProps) => {
  const { isDefined, props } = useWebComponent({
    name: "wa-button",
    className: cx("st-button"),
    props: _props,
    importCallback: () =>
      import("@awesome.me/webawesome/dist/components/button/button.js"),
  });

  if (!isDefined) return null;

  return <wa-button {...props}>{props.children}</wa-button>;
};

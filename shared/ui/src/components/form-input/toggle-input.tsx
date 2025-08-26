import React from "react";
import classNames from "classnames/bind";
import styles from "./form-input.module.css";
import { BaseInput } from "./types";
import { useWebComponent } from "../utils";
import { BaseWaProps } from "../types";

const cx = classNames.bind(styles);

interface ToggleInputProps
  extends BaseInput<boolean>,
    Pick<BaseWaProps, "size"> {
  checked?: boolean;
  name?: string;
}

export const ToggleInput = (_props: ToggleInputProps) => {
  const {
    isDefined,
    props: { value, onChange, ...props },
  } = useWebComponent({
    components: [
      {
        name: "wa-switch",
        importCallback: () =>
          import("@awesome.me/webawesome/dist/components/switch/switch.js"),
      },
    ],
    className: cx("st-input"),
    props: _props,
  });

  const onInput = (e: any) => {
    onChange(e.target.checked);
  };
  const computedProps = {
    ...(props.error ? { withHint: true } : {}),
    ...(value ? { checked: true } : {}),
    onInput,
  };

  if (!isDefined) return null;

  return (
    <wa-switch {...props} {...computedProps}>
      {props.label}
      {!!props.error && (
        <div slot="hint" className={cx("st-input-error")}>
          {props.error}
        </div>
      )}
    </wa-switch>
  );
};

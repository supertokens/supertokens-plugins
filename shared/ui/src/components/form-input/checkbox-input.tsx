import React from "react";
import classNames from "classnames/bind";
import style from "./form-input.module.css";
import { BaseInput } from "./types";
import { useWebComponent } from "../utils";
import { BaseWaProps } from "../types";

const cx = classNames.bind(style);

interface CheckboxInputProps extends BaseInput<boolean>, Pick<BaseWaProps, "size"> {
  name?: string;
  checked?: boolean;
}

export const CheckboxInput = (_props: CheckboxInputProps) => {
  const {
    isDefined,
    props: { value, onChange, ...props },
  } = useWebComponent({
    components: [
      {
        name: "wa-checkbox",
        importCallback: () => import("@awesome.me/webawesome/dist/components/checkbox/checkbox.js"),
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
    <wa-checkbox {...props} {...computedProps}>
      {props.label}
      {!!props.error && (
        <div slot="hint" className={cx("st-input-error")}>
          {props.error}
        </div>
      )}
    </wa-checkbox>
  );
};

import React from "react";
import classNames from "classnames/bind";
import style from "./form-input.module.css";
import { BaseInput } from "./types";
import { useWebComponent } from "../utils";
import { BaseWaSize } from "../types";

const cx = classNames.bind(style);

interface SelectInputProps extends BaseInput<string> {
  size?: BaseWaSize;
  appearance?: "filled" | "outlined" | "plain";
  options: { label: string; value: string }[];
  name?: string;
}

export const SelectInput = (_props: SelectInputProps) => {
  const {
    isDefined,
    props: { value, onChange, options, ...props },
  } = useWebComponent({
    components: [
      {
        name: "wa-select",
        importCallback: () =>
          import("@awesome.me/webawesome/dist/components/select/select.js"),
      },
      {
        name: "wa-option",
        importCallback: () =>
          import("@awesome.me/webawesome/dist/components/option/option.js"),
      },
    ],
    className: cx("st-input"),
    props: _props,
  });

  const onInput = (e: any) => {
    onChange(e.target.value);
  };
  const computedProps = {
    ...(props.error ? { withHint: true } : {}),
    onInput,
  };

  if (!isDefined) return null;

  return (
    <wa-select {...props} {...computedProps}>
      {options.map((option) => (
        <wa-option
          key={option.value}
          value={option.value}
          {...(value === option.value ? { selected: true } : {})}
        >
          {option.label}
        </wa-option>
      ))}
      {!!props.error && (
        <div slot="hint" className={cx("st-input-error")}>
          {props.error}
        </div>
      )}
    </wa-select>
  );
};

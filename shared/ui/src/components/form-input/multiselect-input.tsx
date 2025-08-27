import React from "react";
import classNames from "classnames/bind";
import style from "./form-input.module.css";
import { BaseInput } from "./types";
import { useWebComponent } from "../utils";
import { BaseWaProps } from "../types";

const cx = classNames.bind(style);

interface MultiSelectInputProps extends BaseInput<string[]>, Pick<BaseWaProps, "size" | "appearance"> {
  options: { label: string; value: string }[];
}

export const MultiSelectInput = (_props: MultiSelectInputProps) => {
  const {
    isDefined,
    props: { value, onChange, ...props },
  } = useWebComponent({
    components: [
      {
        name: "wa-select",
        importCallback: () => import("@awesome.me/webawesome/dist/components/select/select.js"),
      },
      {
        name: "wa-option",
        importCallback: () => import("@awesome.me/webawesome/dist/components/option/option.js"),
      },
    ],
    className: cx("st-input"),
    props: _props,
  });

  const computedProps = {
    ...(props.error ? { withHint: true } : {}),
    onInput: onChange,
  };

  if (!isDefined) return null;

  return (
    <wa-select {...props} {...computedProps} multiple>
      {props.options.map((option, index) => (
        <wa-option key={index} value={option.value} {...(value?.includes(option.value) ? { selected: true } : {})}>
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

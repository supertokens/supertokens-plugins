import React from "react";
import classNames from "classnames/bind";
import style from "./form-input.module.css";
import { BaseInput } from "./types";
import { useWebComponent } from "../utils";
import { BaseWaProps } from "../types";

const cx = classNames.bind(style);

interface NumberInputProps
  extends BaseInput<number | "">,
    Pick<BaseWaProps, "size" | "appearance"> {
  name?: string;
  readonly?: boolean;
  autofocus?: boolean;
  min?: number;
  max?: number;
  step?: number;
}

export const NumberInput = (_props: NumberInputProps) => {
  const {
    isDefined,
    props: { onChange, ...props },
  } = useWebComponent({
    components: [
      {
        name: "wa-input",
        importCallback: () =>
          import("@awesome.me/webawesome/dist/components/input/input.js"),
      },
    ],
    className: cx("st-input"),
    props: _props,
  });

  const onInput = (e: any) => {
    const value = e.target.value;
    if (value === "") {
      onChange("");
    } else {
      const numValue = parseFloat(value);
      if (!isNaN(numValue)) {
        onChange(numValue);
      }
    }
  };
  const computedProps = {
    ...(props.error ? { withHint: true } : {}),
    onInput,
  };

  if (!isDefined) return null;

  return (
    <wa-input {...props} {...computedProps} type="number">
      {!!props.error && (
        <div slot="hint" className={cx("st-input-error")}>
          {props.error}
        </div>
      )}
    </wa-input>
  );
};

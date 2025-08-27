import React from "react";
import classNames from "classnames/bind";
import style from "./form-input.module.css";
import { BaseInput } from "./types";
import { useWebComponent } from "../utils";
import { BaseWaSize } from "../types";

const cx = classNames.bind(style);

interface TextInputProps extends BaseInput<string> {
  size?: BaseWaSize;
  appearance?: "filled" | "outlined" | "plain";
  name?: string;
  readonly?: boolean;
  form?: string;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  autofocus?: boolean;
  type?: "text" | "email" | "url" | "tel";
}

export const TextInput = (_props: TextInputProps) => {
  const {
    isDefined,
    props: { onChange, ...props },
  } = useWebComponent({
    components: [
      {
        name: "wa-input",
        importCallback: () => import("@awesome.me/webawesome/dist/components/input/input.js"),
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
    <wa-input {...props} {...computedProps}>
      {!!props.error && (
        <div slot="hint" className={cx("st-input-error")}>
          {props.error}
        </div>
      )}
    </wa-input>
  );
};

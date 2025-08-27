import React from "react";
import classNames from "classnames/bind";
import style from "./form-input.module.css";
import { BaseInput } from "./types";
import { useWebComponent } from "../utils";
import { BaseWaProps } from "../types";

const cx = classNames.bind(style);

interface TextareaInputProps extends BaseInput<string>, Pick<BaseWaProps, "size" | "appearance"> {
  name?: string;
  rows?: number;
  resize?: boolean;
  readonly?: boolean;
  minlength?: number;
  maxlength?: number;
  autofocus?: boolean;
}

export const TextareaInput = (_props: TextareaInputProps) => {
  const {
    isDefined,
    props: { onChange, ...props },
  } = useWebComponent({
    components: [
      {
        name: "wa-textarea",
        importCallback: () => import("@awesome.me/webawesome/dist/components/textarea/textarea.js"),
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
    <wa-textarea {...props} {...computedProps}>
      {!!props.error && (
        <div slot="hint" className={cx("st-input-error")}>
          {props.error}
        </div>
      )}
    </wa-textarea>
  );
};

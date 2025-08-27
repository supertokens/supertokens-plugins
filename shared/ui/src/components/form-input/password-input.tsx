import React from "react";
import style from "./form-input.module.css";
import { BaseInput } from "./types";

import classNames from "classnames/bind";
import { useWebComponent } from "../utils";
import { BaseWaProps } from "../types";

const cx = classNames.bind(style);

interface PasswordInputProps extends BaseInput<string>, Pick<BaseWaProps, "size" | "appearance"> {
  name?: string;
  readonly?: boolean;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  autofocus?: boolean;
}

export const PasswordInput = (_props: PasswordInputProps) => {
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
    <wa-input {...props} {...computedProps} type="password" password-toggle>
      {!!props.error && (
        <div slot="hint" className={cx("st-input-error")}>
          {props.error}
        </div>
      )}
    </wa-input>
  );
};

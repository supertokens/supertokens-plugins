import React from "react";
import classNames from "classnames/bind";
import style from "./form-input.module.css";
import { BaseInput } from "./types";
import { useWebComponent } from "../utils";
import { BaseWaProps } from "../types";

const cx = classNames.bind(style);

interface DateInputProps extends BaseInput<string>, Pick<BaseWaProps, "size" | "appearance"> {
  name?: string;
  readonly?: boolean;
  autofocus?: boolean;
}

export const DateInput: React.FC<DateInputProps> = (_props) => {
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
    <wa-input {...props} {...computedProps} type="date">
      {!!props.error && (
        <div slot="hint" className={cx("st-input-error")}>
          {props.error}
        </div>
      )}
    </wa-input>
  );
};

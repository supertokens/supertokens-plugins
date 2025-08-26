import classNames from "classnames/bind";
import styles from "./card.module.css";
import { useWebComponent } from "../utils";
import { HTMLElementProps, BaseWaAppearance } from "../types";

const cx = classNames.bind(styles);

type CardProps = HTMLElementProps & {
  appearance?: BaseWaAppearance;
  children?: React.ReactNode;
  title?: string;
  description?: string;
};

export const Card = (_props: CardProps) => {
  const { isDefined, props } = useWebComponent({
    components: [
      {
        name: "wa-card",
        importCallback: () =>
          import("@awesome.me/webawesome/dist/components/card/card.js"),
      },
    ],
    props: _props,
    className: cx("st-card"),
  });

  if (!isDefined) return null;

  return (
    <wa-card {...props}>
      {props.title || props.description ? (
        <div slot="header">
          {props.title ? <h2 style={{ margin: 0 }}>{props.title}</h2> : null}
          {props.title && props.description ? <br /> : null}
          {props.description ? (
            <p style={{ margin: 0 }}>{props.description}</p>
          ) : null}
        </div>
      ) : null}

      {props.children}
    </wa-card>
  );
};

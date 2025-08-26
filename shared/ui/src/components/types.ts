export type BaseWaAppearance =
  | "accent"
  | "filled"
  | "outlined"
  | "outlined filled"
  | "plain"
  | "";
export type BaseWaSize = "xsmall" | "small" | "medium" | "large";
export type BaseWaVariant =
  | "brand"
  | "neutral"
  | "success"
  | "warning"
  | "danger";

export type BaseWaProps = {
  variant?: BaseWaVariant;
  size?: BaseWaSize;
  appearance?: BaseWaAppearance;
};

export interface HTMLElementProps {
  className?: string;
  style?: React.CSSProperties;
}

import React from "react";
import "@awesome.me/webawesome/dist/styles/themes/default.css";
import "../../theme/theme.css";
import cx from "classnames";

export interface ThemeProviderProps {
  children: any;
  className?: string;
}

export const ThemeProvider = ({ children, className }: ThemeProviderProps) => {
  return (
    <div
      data-fa-kit-code="38c11e3f20"
      className={cx("plugin-profile", className)}
    >
      {children}
    </div>
  );
};

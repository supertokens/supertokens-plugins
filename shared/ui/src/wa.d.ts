import * as React from "react";
import { TagProps } from "./components/tag/tag";
import "@awesome.me/webawesome/dist/components/button/button.d.ts";

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "wa-tag": TagProps;
    }
  }
}

interface PersonInfoProps
  extends React.DetailedHTMLProps<
    React.HTMLAttributes<HTMLElement>,
    HTMLElement
  > {
  heading: string;
  subHeading: string;
  size?: string;
}

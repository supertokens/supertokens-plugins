import { Card } from "@shared/ui";
import classNames from "classnames/bind";

import style from "./no-access.module.scss";
const cx = classNames.bind(style);

type NoAccessProps = {
  headerText: string;
  descriptionComponent: React.ReactNode;
  useDangerAccent?: boolean;
};

export const NoAccess: React.FC<NoAccessProps> = ({ headerText, descriptionComponent, useDangerAccent = false }) => {
  return (
    <Card className={cx("noAccessMessageContainer")}>
      <div className={cx("header")}>{headerText}</div>
      <div className={cx("messageContainer", { danger: useDangerAccent })}>{descriptionComponent}</div>
    </Card>
  );
};

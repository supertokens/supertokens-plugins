import { Card } from "@shared/ui";
import classNames from "classnames/bind";
import { useMemo } from "react";

import style from "./list-card.module.css";

const cx = classNames.bind(style);

export const ListCard = ({
  title,
  children,
  FooterComponent,
}: {
  title?: string;
  children: any;
  FooterComponent?: React.ReactElement<typeof ListCardFooter>;
}) => {
  return (
    <Card title={title} className={cx("supertokens-plugin-list-card")}>
      {children.length && (
        <div
          className={cx("supertokens-plugin-list-card-container", {
            "supertokens-plugin-list-card-container-no-title": !title,
          })}>
          {children}
        </div>
      )}

      {FooterComponent}
    </Card>
  );
};

export function ListCardFooter({ children }: { children: React.ReactNode }) {
  return <div className={cx("supertokens-plugin-list-card-footer")}>{children}</div>;
}

export const ListCardItemActions = ({ children }: { children: React.ReactNode }) => {
  return <div className={cx("supertokens-plugin-list-card-item-actions")}>{children}</div>;
};

export const ListCardItem = ({
  children,
  ActionsComponent,
}: {
  children: any;
  ActionsComponent?: React.ReactElement<typeof ListCardItemActions>;
}) => {
  return (
    <div className={cx("supertokens-plugin-list-card-item")}>
      {children}
      {ActionsComponent}
    </div>
  );
};

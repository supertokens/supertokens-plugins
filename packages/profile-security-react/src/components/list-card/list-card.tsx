import { Card } from "@shared/ui";
import classNames from "classnames/bind";
import { useMemo } from "react";

import style from "./list-card.module.css";

const cx = classNames.bind(style);

export const ListCard = ({ title, children }: { title?: string; children: any }) => {
  const footerChild = useMemo(() => {
    if (!children) {
      return undefined;
    }

    if (children?.type === ListCardFooter) {
      return children;
    }

    if (Array.isArray(children)) {
      return children.find((child) => child?.type === ListCardFooter);
    }

    return undefined;
  }, [children]);

  const restChildren = useMemo(() => {
    if (Array.isArray(children)) {
      return children.filter((child) => child?.type !== ListCardFooter);
    }

    if (children?.type !== ListCardFooter) {
      return children;
    }

    return [];
  }, [children]);

  return (
    <Card title={title} className={cx("supertokens-plugin-list-card")}>
      {Boolean(restChildren.length) && (
        <div
          className={cx("supertokens-plugin-list-card-container", {
            "supertokens-plugin-list-card-container-no-title": !title,
          })}>
          {restChildren}
        </div>
      )}

      {footerChild}
    </Card>
  );
};

export function ListCardFooter({ children }: { children: React.ReactNode }) {
  return <div className={cx("supertokens-plugin-list-card-footer")}>{children}</div>;
}

export const ListCardItemActions = ({ children }: { children: React.ReactNode }) => {
  return <div className={cx("supertokens-plugin-list-card-item-actions")}>{children}</div>;
};

export const ListCardItem = ({ children }: { children: any }) => {
  const actionsChild = useMemo(() => {
    if (children?.type === ListCardItemActions) {
      return children;
    }

    if (Array.isArray(children)) {
      return children.find((child) => child?.type === ListCardItemActions);
    }

    return undefined;
  }, [children]);

  const contentChildren = useMemo(() => {
    if (Array.isArray(children)) {
      return children.filter((child) => child?.type !== ListCardItemActions);
    }
    if (children?.type !== ListCardItemActions) {
      return children;
    }

    return undefined;
  }, [children]);

  return (
    <div className={cx("supertokens-plugin-list-card-item")}>
      {contentChildren}
      {actionsChild}
    </div>
  );
};

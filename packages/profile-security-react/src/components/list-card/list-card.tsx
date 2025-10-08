import { Card } from "@shared/ui";
import classNames from "classnames/bind";

import style from "./list-card.module.css";

const cx = classNames.bind(style);

export const ListCard = ({ title, items, FooterComponent }: { title?: string; items: any[]; FooterComponent: any }) => {
  return (
    <Card title={title} className={cx("supertokens-plugin-list-card")}>
      <div
        className={cx("supertokens-plugin-list-card-container", {
          "supertokens-plugin-list-card-container-no-title": !title,
        })}>
        {items.map((item, index) => (
          <div key={index} className={cx("supertokens-plugin-list-card-item")}>
            {<item.Content />}

            {item.Actions && <div className={cx("supertokens-plugin-list-card-item-actions")}>{<item.Actions />}</div>}
          </div>
        ))}
      </div>

      {FooterComponent && <div className={cx("supertokens-plugin-list-card-footer")}>{<FooterComponent />}</div>}
    </Card>
  );
};

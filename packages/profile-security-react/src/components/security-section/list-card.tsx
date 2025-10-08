import { Button, Card, SelectInput } from "@shared/ui";
import classNames from "classnames/bind";

import style from "./security-section.module.css";

const cx = classNames.bind(style);

export const ListCard = ({ title, items, FooterComponent }: { title?: string; items: any[]; FooterComponent: any }) => {
  return (
    <Card title={title} className={cx("supertokens-plugin-profile-security-list")}>
      <div
        className={cx("supertokens-plugin-profile-security-list-container", {
          "supertokens-plugin-profile-security-list-container-no-title": !title,
        })}>
        {items.map((item, index) => (
          <div key={index} className={cx("supertokens-plugin-profile-security-list-item")}>
            {<item.Content />}

            {item.Actions && (
              <div className={cx("supertokens-plugin-profile-security-list-item-actions")}>{<item.Actions />}</div>
            )}
          </div>
        ))}
      </div>

      {FooterComponent && (
        <div className={cx("supertokens-plugin-profile-security-list-footer")}>{<FooterComponent />}</div>
      )}
    </Card>
  );
};

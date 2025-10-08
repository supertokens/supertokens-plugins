import { Card } from "@shared/ui";
import classNames from "classnames/bind";

import { usePluginContext } from "../../plugin";

import style from "./tenant-card.module.scss";
const cx = classNames.bind(style);

export const AwaitingApprovalMessage = () => {
  const { t } = usePluginContext();

  return (
    <Card className={cx("awaitingApprovalMessageContainer")}>
      <div className={cx("header")}>{t("PL_TB_CREATE_TENANT_AWAITING_APPROVAL_HEADER")}</div>
      <div className={cx("messageContainer")}>
        <div>
          {t("PL_TB_CREATE_TENANT_AWAITING_APPROVAL_MESSAGE")}{" "}
          <b>{t("PL_TB_CREATE_TENANT_AWAITING_APPROVAL_MESSAGE_HIGHLIGHT")}</b>
        </div>
      </div>
    </Card>
  );
};

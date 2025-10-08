import { Button } from "@shared/ui";
import classNames from "classnames/bind";

import { usePluginContext } from "../../plugin";

import style from "./requests.module.scss";

const cx = classNames.bind(style);

type ActionProps = {
  onAccept: () => Promise<void>;
  onDecline: () => Promise<void>;
};

export const Action: React.FC<ActionProps> = ({ onAccept, onDecline }) => {
  const { t } = usePluginContext();

  return (
    <div className={cx("actionWrapper")}>
      <Button variant="brand" appearance="outlined" size="small" onClick={onAccept}>
        {t("PL_TB_TENANTS_REQUESTS_ACCEPT_BUTTON_TEXT")}
      </Button>
      <Button variant="neutral" appearance="outlined" size="small" onClick={onDecline}>
        {t("PL_TB_TENANTS_REQUESTS_DECLINE_BUTTON_TEXT")}
      </Button>
    </div>
  );
};

import { Button, Card } from "@shared/ui";
import classNames from "classnames/bind";
import { signOut } from "supertokens-auth-react/recipe/session";

import { usePluginContext } from "../../plugin";

import style from "./tenant-card.module.scss";
const cx = classNames.bind(style);

type AwaitingApprovalMessageProps = {
  headerText: string;
  messageContent: React.ReactNode;
  hideLogoutButton?: boolean;
  useDangerAccent?: boolean;
};

export const AwaitingApprovalMessage: React.FC<AwaitingApprovalMessageProps> = ({
  headerText,
  messageContent,
  hideLogoutButton = false,
  useDangerAccent = false,
}) => {
  const { t } = usePluginContext();

  const onLogOutClick = async () => {
    await signOut();
    window.location.assign("/");
  };

  return (
    <Card className={cx("awaitingApprovalMessageContainer")}>
      <div className={cx("header")}>{headerText}</div>
      <div className={cx("messageContainer", { danger: useDangerAccent })}>{messageContent}</div>
      {!hideLogoutButton && (
        <div className={cx("logoutBtnContainer")}>
          <Button onClick={onLogOutClick} variant="brand" appearance="accent">
            {t("PL_TB_LOGOUT_TEXT")}
          </Button>
        </div>
      )}
    </Card>
  );
};

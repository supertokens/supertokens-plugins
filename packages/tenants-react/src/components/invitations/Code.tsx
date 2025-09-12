import { Button, usePrettyAction, TextInput, Icon } from "@shared/ui";
import classNames from "classnames/bind";
import { useState } from "react";

import { usePluginContext } from "../../plugin";
import { Copy } from "../icons/Copy";
import { Eye } from "../icons/Eye";

import style from "./code.module.scss";

const cx = classNames.bind(style);

type CodeProps = {
  code: string;
  tenantId: string;
};

export const Code: React.FC<CodeProps> = ({ code, tenantId }) => {
  const { t } = usePluginContext();
  const [showRawCode, setShowRawCode] = useState(false);

  const handleCodeCopyClick = usePrettyAction(
    async () => {
      const origin = window.location.origin;
      const urlToCopy = `${origin}/user/invite/accept?tenantid=${encodeURIComponent(tenantId)}&code=${encodeURIComponent(
        code,
      )}`;
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          await navigator.clipboard.writeText(urlToCopy);
          return;
        }
      } catch (_) {
        throw new Error("Clipboard not supported by browser");
      }
    },
    [code, tenantId],
    {
      errorMessage: "Failed to copy invitation link, please try again",
      successMessage: "Invitation link copied!",
    },
  );

  return (
    <div className={cx("codeWrapper")}>
      {showRawCode ? (
        <div className={cx("rawCodeContainer")}>
          <div className={cx("textContainer")}>{code}</div>
          <Button variant="neutral" appearance="plain" onClick={() => setShowRawCode(false)}>
            <Icon name="xmark" label="Hide Code" />
          </Button>
        </div>
      ) : (
        <Button appearance="filled" variant="brand" onClick={() => setShowRawCode(true)}>
          <div className={cx("viewCodeButtonWrapper")}>
            <Eye label="View Code" />
            <div>{t("PL_TB_VIEW_CODE_TEXT")}</div>
          </div>
        </Button>
      )}
      <Button appearance="filled" variant="neutral" onClick={handleCodeCopyClick}>
        <Copy label="Copy Invite Link" />
      </Button>
    </div>
  );
};

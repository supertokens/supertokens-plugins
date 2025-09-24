import React from "react";
import { Card } from "@shared/ui";
import classNames from "classnames/bind";

import style from "./tenant.module.scss";

const cx = classNames.bind(style);

type TenantMessageCardProps = {
  header: string;
  message: React.ReactNode;
};

export function TenantMessageCard({ header, message }: TenantMessageCardProps): React.ReactElement | null {
  return (
    <Card className="awaitingApprovalMessageContainer">
      <div
        className="header"
        style={{
          fontWeight: 700,
          fontSize: "28px",
          lineHeight: "36px",
          letterSpacing: "-0.12px",
          color: "var(--neutral-color-neutral-12)",
          margin: "0 0 16px 0",
        }}>
        {header}
      </div>
      <div
        className="messageContainer"
        style={{
          boxShadow: "0px 1.5px 2px 0px rgba(0, 0, 0, 0.133) inset",
          border: "1px solid var(--neutral-color-neutral-6)",
          backgroundColor: "#f9f9f8",
          borderRadius: "var(--plugin-spacing-lg)",
          padding: "14px",
          fontWeight: 400,
          fontSize: "14px",
          lineHeight: "20px",
          letterSpacing: "0px",
        }}>
        {message}
      </div>
    </Card>
  );
}

import React from "react";

type TenantTabProps = {
  description: string;
  children: React.ReactNode;
};

export const TenantTab: React.FC<TenantTabProps> = ({ description, children }) => {
  return (
    <div>
      <div>{description}</div>
      <div>{children}</div>
    </div>
  );
};

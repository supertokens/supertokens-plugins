import classNames from "classnames/bind";

import style from "./table.module.scss";

const cx = classNames.bind(style);

type TableProps = {
  emailComponentTitle?: string;
  extraComponentTitle?: string;
  // Optional widths. Accept any valid CSS width (%, px, fr not supported here).
  emailWidth?: string;
  extraWidth?: string;
  columns: {
    emailComponent: React.ReactNode;
    extraComponent?: React.ReactNode;
  }[];
};

export const TenantUsersTable: React.FC<TableProps> = ({
  emailComponentTitle = "Email",
  extraComponentTitle = undefined,
  emailWidth,
  extraWidth,
  columns,
}) => {
  return (
    <div
      className={cx("tableContainer")}
      style={
        {
          // These CSS variables are used by SCSS with fallbacks.
          ...(emailWidth ? ({ ["--email-col-width" as any]: emailWidth } as any) : {}),
          ...(extraWidth ? ({ ["--extra-col-width" as any]: extraWidth } as any) : {}),
        } as any
      }>
      <div data-supertokens="table-head" className={cx("tableHead")}>
        <div className={cx("emailHeader")}>{emailComponentTitle}</div>
        {extraComponentTitle && <div className={cx("extraHeader")}>{extraComponentTitle}</div>}
      </div>
      <div data-supertokens="table-columns" className={cx("tableColumns")}>
        {columns.map((column) => (
          <div key={null} className={cx("tableColumn")}>
            <div data-supertokens="email-component" className={cx("emailComponentWrapper")}>
              {column.emailComponent}
            </div>
            {column.extraComponent && (
              <div data-supertokens="extra-component" className={cx("extraComponentWrapper")}>
                {column.extraComponent}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

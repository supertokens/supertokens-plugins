import classNames from "classnames/bind";

import style from "./table.module.scss";

const cx = classNames.bind(style);

type TableProps = {
  emailComponentTitle?: string;
  extraComponentTitle?: string;
  columns: {
    emailComponent: React.ReactNode;
    extraComponent?: React.ReactNode;
  }[];
};

export const TenantTable: React.FC<TableProps> = ({
  emailComponentTitle = "Email",
  extraComponentTitle = "Role",
  columns,
}) => {
  return (
    <div className={cx("tableContainer")}>
      <div data-supertokens="table-head" className={cx("tableHead")}>
        <div className={cx("emailHeader")}>{emailComponentTitle}</div>
        <div className={cx("extraHeader")}>{extraComponentTitle}</div>
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

type TableProps = {
  columns: {
    emailComponent: React.ReactNode;
    extraComponent?: React.ReactNode;
  }[];
};

export const TenantTable: React.FC<TableProps> = ({ columns }) => {
  return (
    <div>
      <div data-supertokens="table-head">
        <div>Email</div>
        <div>Role</div>
      </div>
      <div data-supertokens="table-columns">
        {columns.map((column) => {
          <div>
            <div data-supertokens="email-component">{column.emailComponent}</div>
            {column.extraComponent && <div data-supertokens="extra-component">{column.extraComponent}</div>}
          </div>;
        })}
      </div>
    </div>
  );
};

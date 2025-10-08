import classNames from "classnames/bind";

import style from "./empty.module.scss";

const cx = classNames.bind(style);

type NoUsersProps = {
  text: string;
};

export const NoUsers: React.FC<NoUsersProps> = ({ text }) => {
  return (
    <div className={cx("tenantDetailsNoUsers")}>
      <div className="icon"></div>
      <div className="text">{text}</div>
    </div>
  );
};

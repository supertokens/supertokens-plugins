import classNames from "classnames/bind";

import style from "./details.module.scss";

const cx = classNames.bind(style);

type UserDetailsProps = {
  email: string;
};

export const UserDetails: React.FC<UserDetailsProps> = ({ email }) => {
  return (
    <div className={cx("userRow")}>
      <div className={cx("userAvatar")}>{email.charAt(0).toUpperCase() || "U"}</div>
      <div className={cx("userEmail")}>{email}</div>
    </div>
  );
};

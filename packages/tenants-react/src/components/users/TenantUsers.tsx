import classNames from "classnames/bind";
import { useCallback, useEffect, useState } from "react";
import { User } from "supertokens-web-js/types";

import { usePluginContext } from "../../plugin";
import { TenantTable } from "../table/TenantTable";

import style from "./details.module.scss";

// import { BaseFormSection } from '@supertokens-plugin-profile/common-details-shared';

const cx = classNames.bind(style);

type TenantUsersProps = {
  onFetch: () => Promise<{ users: User[] }>;
};

export const TenantUsers: React.FC<TenantUsersProps> = ({ onFetch }) => {
  const { t } = usePluginContext();
  const [users, setUsers] = useState<User[]>([]);

  const loadDetails = useCallback(async () => {
    const details = await onFetch();
    setUsers(details.users);
  }, [onFetch]);

  useEffect(() => {
    loadDetails();
  }, [loadDetails]);

  return (
    <div className={cx("tenantDetailsSection")}>
      <div className={cx("tenantDetailsContent")}>
        {users.length > 0 ? (
          <div className={cx("tenantDetailsUsers")}>
            <TenantTable
              columns={users.map((user) => ({
                emailComponent: (
                  <div className={cx("userRow")}>
                    <div className={cx("userAvatar")}>{user.emails[0]?.charAt(0).toUpperCase() || "U"}</div>
                    <div className={cx("userEmail")}>{user.emails[0]}</div>
                  </div>
                ),
              }))}
            />
          </div>
        ) : (
          <div className={cx("tenantDetailsNoUsers")}>
            <div className="icon"></div>
            <div className="text">{t("PL_TB_NO_USERS_FOUND_TEXT")}</div>
          </div>
        )}
      </div>
    </div>
  );
};

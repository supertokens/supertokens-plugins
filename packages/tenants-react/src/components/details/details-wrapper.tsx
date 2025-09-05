import classNames from "classnames/bind";
import { useCallback, useEffect, useState } from "react";
import { User } from "supertokens-web-js/types";

import style from "./details.module.scss";

// import { BaseFormSection } from '@supertokens-plugin-profile/common-details-shared';

const cx = classNames.bind(style);

export const DetailsWrapper = ({ section, onFetch }: { section: any; onFetch: () => Promise<{ users: User[] }> }) => {
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
      <div className={cx("tenantDetailsHeader")}>
        <h3>{section.label}</h3>
        <p>{section.description}</p>
      </div>

      <div className={cx("tenantDetailsContent")}>
        {users.length > 0 ? (
          <div className={cx("tenantDetailsUsers")}>
            {users.map((user) => (
              <div key={user.id} className={cx("userRow")}>
                <div className={cx("userAvatar")}>{user.emails[0]?.charAt(0).toUpperCase() || "U"}</div>
                <div className={cx("userEmail")}>{user.emails[0]}</div>
              </div>
            ))}
          </div>
        ) : (
          <div className={cx("tenantDetailsNoUsers")}>
            <p>No users found</p>
          </div>
        )}
      </div>
    </div>
  );
};

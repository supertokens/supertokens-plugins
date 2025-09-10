import classNames from "classnames/bind";
import { useCallback, useEffect, useMemo, useState } from "react";
import Session from "supertokens-auth-react/recipe/session";
import { User } from "supertokens-web-js/types";

import { ROLES } from "../../../../../shared/tenants/src/roles";
import { SelectInput } from "../../../../../shared/ui/src/components";
import { logDebugMessage } from "../../logger";
import { usePluginContext } from "../../plugin";
import { TenantTable } from "../table/TenantTable";

import style from "./details.module.scss";

// import { BaseFormSection } from '@supertokens-plugin-profile/common-details-shared';

const cx = classNames.bind(style);

type UserWithRole = { roles: string[] } & User;

type TenantUsersProps = {
  onFetch: () => Promise<{ users: UserWithRole[] }>;
};

export const TenantUsers: React.FC<TenantUsersProps> = ({ onFetch }) => {
  const { t } = usePluginContext();
  const [users, setUsers] = useState<UserWithRole[]>([]);
  const [userId, setUserId] = useState<string | null>(null);
  const [currentUserDetails, setCurrentUserDetails] = useState<UserWithRole | null>(null);
  const isCurrentUserAdmin = useMemo(() => currentUserDetails?.roles.includes(ROLES.ADMIN), [currentUserDetails]);

  const loadDetails = useCallback(async () => {
    const details = await onFetch();
    // Show the users that have a valid role
    setUsers(details.users.filter((user) => user.roles.length !== 0));

    const userIdFromSession = await Session.getUserId();
    setUserId(userIdFromSession);

    // determine if the current user is admin or not.
    const currentUserDetailsWithRole = details.users.find((user) => user.id === userIdFromSession);
    setCurrentUserDetails(currentUserDetailsWithRole ?? null);
  }, [onFetch]);

  useEffect(() => {
    loadDetails();
  }, [loadDetails]);

  const availableRoles = [
    {
      label: "Admin",
      value: ROLES.ADMIN,
    },
    {
      label: "Member",
      value: ROLES.MEMBER,
    },
  ];

  const getExtraComponent = useCallback(
    (user: { roles: string[] } & User) => {
      // It's safe to assume that they would have one role
      const currentRole = user.roles[0] ?? ROLES.MEMBER;

      const handleRoleChange = (newValue) => {
        logDebugMessage(`Changing role for user to: ${newValue}`);
      };

      return (
        <div>
          <div className="role--input">
            <SelectInput
              id="role-select"
              value={currentRole}
              onChange={(e: any) => handleRoleChange(e.target.value)}
              options={availableRoles}
              disabled={!isCurrentUserAdmin}
            />
          </div>
        </div>
      );
    },
    [isCurrentUserAdmin],
  );

  if (!userId) {
    return <div>Loading....</div>;
  }

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
                extraComponent: getExtraComponent(user),
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

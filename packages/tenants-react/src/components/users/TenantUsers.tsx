import classNames from "classnames/bind";
import { useCallback, useEffect, useMemo, useState } from "react";
import Session from "supertokens-auth-react/recipe/session";
import { User } from "supertokens-web-js/types";

import { ROLES } from "../../../../../shared/tenants/src/roles";
import { SelectInput } from "../../../../../shared/ui/src/components";
import { usePrettyAction } from "../../../../../shared/ui/src/hooks";
import { logDebugMessage } from "../../logger";
import { usePluginContext } from "../../plugin";
import { UserWithRole } from "../../types";
import { RemoveInvitation } from "../invitations/RemoveInvitation";
import { TenantUsersTable } from "../table/TenantTable";

import { NoUsers } from "./NoUsers";
import { UserDetails } from "./UserDetails";
import style from "./users.module.scss";

const cx = classNames.bind(style);

// import { BaseFormSection } from '@supertokens-plugin-profile/common-details-shared';

type TenantUsersProps = {
  users: UserWithRole[];
  onRoleChange: (userId: string, role: string) => Promise<boolean>;
  onUserRemove: (userId: string) => Promise<boolean>;
};

export const TenantUsers: React.FC<TenantUsersProps> = ({ users, onRoleChange, onUserRemove }) => {
  const { t } = usePluginContext();
  const [userId, setUserId] = useState<string | null>(null);
  const [currentUserDetails, setCurrentUserDetails] = useState<UserWithRole | null>(null);
  const isCurrentUserAdmin = useMemo(() => currentUserDetails?.roles.includes(ROLES.ADMIN), [currentUserDetails]);
  const [isRoleChanging, setRoleChanging] = useState(false);

  useEffect(() => {
    (async () => {
      const userIdFromSession = await Session.getUserId();
      setUserId(userIdFromSession);

      // determine if the current user is admin or not.
      const currentUserDetailsWithRole = users.find((user) => user.id === userIdFromSession);
      setCurrentUserDetails(currentUserDetailsWithRole ?? null);
    })();
  }, [users]);

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

  const handleRoleChange = usePrettyAction(
    async (userId: string, newValue: string) => {
      logDebugMessage(`Changing role for user to: ${newValue}`);
      setRoleChanging(true);

      const wasChanged = await onRoleChange(userId, newValue);
      setRoleChanging(false);
      if (!wasChanged) {
        throw new Error("Failed to change role");
      }
    },
    [onRoleChange],
    { errorMessage: "Failed to change role" },
  );

  const handleUserRemove = usePrettyAction(
    async (userId: string) => {
      logDebugMessage(`Removing user from tenant: ${userId}`);
      onUserRemove(userId);
    },
    [onUserRemove],
    { errorMessage: "Failed to remove user" },
  );

  const getExtraComponent = useCallback(
    (user: { roles: string[] } & User) => {
      // It's safe to assume that they would have one role
      const currentRole = user.roles[0] ?? ROLES.MEMBER;

      const getRoleChangeWrapper = (userId: string) => {
        return async (newValue: string) => {
          return await handleRoleChange(userId, newValue);
        };
      };

      return (
        <div className={cx("userExtraComponent")}>
          <div className="role--input">
            <SelectInput
              id="role-select"
              value={currentRole}
              onChange={(e: any) => getRoleChangeWrapper(user.id)(e)}
              options={availableRoles}
              disabled={!isCurrentUserAdmin || isRoleChanging}
            />
          </div>
          <div>
            <RemoveInvitation
              onRemove={() => handleUserRemove(user.id)}
              disabled={currentUserDetails!.id === user.id}
            />
          </div>
        </div>
      );
    },
    [isCurrentUserAdmin, isRoleChanging, handleRoleChange, handleUserRemove, currentUserDetails],
  );

  if (!userId) {
    return <div>{t("PL_TB_TENANTS_LOADING_MESSAGE")}</div>;
  }

  return users.length > 0 ? (
    <TenantUsersTable
      emailComponentTitle={`Users (${users.length})`}
      columns={users.map((user) => ({
        emailComponent: <UserDetails email={user.emails[0]!} />,
        extraComponent: getExtraComponent(user),
      }))}
    />
  ) : null;
};

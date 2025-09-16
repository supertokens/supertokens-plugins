import classNames from "classnames/bind";
import { useCallback, useEffect, useMemo, useState } from "react";
import Session from "supertokens-auth-react/recipe/session";
import { User } from "supertokens-web-js/types";

import { ROLES } from "../../../../../shared/tenants/src/roles";
import { SelectInput } from "../../../../../shared/ui/src/components";
import { usePrettyAction } from "../../../../../shared/ui/src/hooks";
import { logDebugMessage } from "../../logger";
import { usePluginContext } from "../../plugin";
import { RemoveInvitation } from "../invitations/RemoveInvitation";
import { TenantUsersTable } from "../table/TenantTable";

import { NoUsers } from "./NoUsers";
import { UserDetails } from "./UserDetails";
import style from "./users.module.scss";

const cx = classNames.bind(style);

// import { BaseFormSection } from '@supertokens-plugin-profile/common-details-shared';

type UserWithRole = { roles: string[] } & User;

type TenantUsersProps = {
  onFetch: () => Promise<{ users: UserWithRole[] }>;
  onRoleChange: (userId: string, role: string) => Promise<boolean>;
  onUserRemove: (userId: string) => Promise<boolean>;
};

export const TenantUsers: React.FC<TenantUsersProps> = ({ onFetch, onRoleChange, onUserRemove }) => {
  const { t } = usePluginContext();
  const [users, setUsers] = useState<UserWithRole[]>([]);
  const [userId, setUserId] = useState<string | null>(null);
  const [currentUserDetails, setCurrentUserDetails] = useState<UserWithRole | null>(null);
  const isCurrentUserAdmin = useMemo(() => currentUserDetails?.roles.includes(ROLES.ADMIN), [currentUserDetails]);
  const [isRoleChanging, setRoleChanging] = useState(false);

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
      const wasRemoved = await onUserRemove(userId);

      // Update the list of users if it was successful.
      if (wasRemoved) {
        setUsers((currenUsers) => currenUsers.filter((user) => user.id !== userId));
      }
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
    return <div>Loading....</div>;
  }

  return (
    <div>
      {users.length > 0 ? (
        <div>
          <TenantUsersTable
            extraComponentTitle="Role"
            columns={users.map((user) => ({
              emailComponent: <UserDetails email={user.emails[0]!} />,
              extraComponent: getExtraComponent(user),
            }))}
          />
        </div>
      ) : (
        <NoUsers text={t("PL_TB_NO_USERS_FOUND_TEXT")} />
      )}
    </div>
  );
};

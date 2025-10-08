import { InviteeDetails } from "@shared/tenants";
import classNames from "classnames/bind";

import { usePluginContext } from "../../plugin";
import { TenantUsersTable } from "../table/TenantTable";
import { NoUsers } from "../users/NoUsers";
import { UserDetails } from "../users/UserDetails";

import { Code } from "./Code";
import style from "./invited-users.module.scss";
import { RemoveInvitation } from "./RemoveInvitation";

const cx = classNames.bind(style);

export type InvitedUsersProps = {
  onRemove: (email: string) => Promise<void>;
  invitations: InviteeDetails[];
  tenantId: string;
};

export const InvitedUsers: React.FC<InvitedUsersProps> = ({ onRemove, invitations, tenantId }) => {
  const { t } = usePluginContext();

  const getExtraComponent = (invitation: InviteeDetails) => {
    return (
      <div className={cx("viewCodeWrapper")}>
        <Code code={invitation.code} tenantId={tenantId} />
        <RemoveInvitation onRemove={() => onRemove(invitation.email)} />
      </div>
    );
  };

  return invitations.length > 0 ? (
    <TenantUsersTable
      emailComponentTitle={`Pending Invites (${invitations.length})`}
      columns={invitations.map((user) => ({
        emailComponent: <UserDetails email={user.email} avatarVariant="invite" />,
        extraComponent: getExtraComponent(user),
      }))}
    />
  ) : null;
};

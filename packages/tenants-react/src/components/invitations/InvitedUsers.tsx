import { InviteeDetails } from "@shared/tenants";

import { usePluginContext } from "../../plugin";
import { TenantUsersTable } from "../table/TenantTable";
import { NoUsers } from "../users/NoUsers";
import { UserDetails } from "../users/UserDetails";

import { RemoveInvitation } from "./RemoveInvitation";

export type InvitedUsersProps = {
  onRemove: (email: string) => Promise<void>;
  invitations: InviteeDetails[];
};

export const InvitedUsers: React.FC<InvitedUsersProps> = ({ onRemove, invitations }) => {
  const { t } = usePluginContext();

  const getExtraComponent = (invitation: InviteeDetails) => {
    return (
      <div>
        <RemoveInvitation onRemove={() => onRemove(invitation.email)} />
      </div>
    );
  };

  return (
    <div>
      {invitations.length > 0 ? (
        <div>
          <TenantUsersTable
            columns={invitations.map((user) => ({
              emailComponent: <UserDetails email={user.email} />,
              extraComponent: getExtraComponent(user),
            }))}
          />
        </div>
      ) : (
        <NoUsers text={t("PL_TB_NO_INVITATIONS_FOUND_TEXT")} />
      )}
    </div>
  );
};

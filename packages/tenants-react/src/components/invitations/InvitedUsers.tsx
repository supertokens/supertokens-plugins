import { InviteeDetails } from "@shared/tenants";

import { usePluginContext } from "../../plugin";
import { TenantUsersTable } from "../table/TenantTable";
import { NoUsers } from "../users/NoUsers";
import { UserDetails } from "../users/UserDetails";

export type InvitedUsersProps = {
  selectedTenantId: string;
  invitations: InviteeDetails[];
};

export const InvitedUsers: React.FC<InvitedUsersProps> = ({ selectedTenantId, invitations }) => {
  const { t } = usePluginContext();

  return (
    <div>
      {invitations.length > 0 ? (
        <div>
          <TenantUsersTable
            columns={invitations.map((user) => ({
              emailComponent: <UserDetails email={user.email} />,
              //   extraComponent: getExtraComponent(user),
            }))}
          />
        </div>
      ) : (
        <NoUsers text={t("PL_TB_NO_INVITATIONS_FOUND_TEXT")} />
      )}
    </div>
  );
};

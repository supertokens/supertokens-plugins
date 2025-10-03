import { Button, SelectInput, TextInput, usePrettyAction } from "@shared/ui";
import classNames from "classnames/bind";
import { useEffect, useState } from "react";

import { ROLES } from "../../../../../shared/tenants/src/roles";
import { usePluginContext } from "../../plugin";

import style from "./add-invitation.module.scss";

const cx = classNames.bind(style);

export type AddInvitationProps = {
  onCreate: (email: string, role: string) => Promise<void>;
};

export const AddInvitation: React.FC<AddInvitationProps> = ({ onCreate }) => {
  const { t } = usePluginContext();
  const [inviteEmail, setInviteEmail] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [inviteeRole, setInviteeRole] = useState<string>(ROLES.MEMBER);

  const handleAddInvite = usePrettyAction(
    async () => {
      setIsSubmitting(true);
      try {
        await onCreate(inviteEmail, inviteeRole);
      } finally {
        setIsSubmitting(false);
      }
      setInviteEmail("");
    },
    [onCreate, inviteEmail, inviteeRole],
    {
      errorMessage: "Failed to add invite, please try again",
      onSuccess: async () => {
        // Clear the email input
        setInviteEmail("");
        setInviteeRole(ROLES.MEMBER);
      },
    },
  );

  return (
    <div className={cx("addInvitationWrapper")}>
      <div className={cx("emailInputWrapper")}>
        <TextInput
          id="invitee-email"
          type="email"
          placeholder="Enter email"
          size="medium"
          value={inviteEmail}
          onChange={(e: any) => setInviteEmail(e)}
          required
          disabled={isSubmitting}
        />
      </div>
      <div className={cx("remainingWrapper")}>
        <SelectInput
          id="invitation-role-select"
          value={inviteeRole}
          onChange={(e: any) => setInviteeRole(e.target.value)}
          name="Tenant Switcher"
          options={[
            {
              value: ROLES.MEMBER,
              label: "Member",
            },
            {
              value: ROLES.ADMIN,
              label: "Admin",
            },
          ]}
          disabled={isSubmitting}
        />
        <Button
          appearance="filled"
          variant="brand"
          disabled={isSubmitting || inviteEmail.trim().length === 0}
          onClick={handleAddInvite}>
          {t("PL_TB_ADD_INVITE_BUTTON_TEXT")}
        </Button>
      </div>
    </div>
  );
};

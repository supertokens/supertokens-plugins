import { Button, TextInput, usePrettyAction } from "@shared/ui";
import classNames from "classnames/bind";
import { useEffect, useState } from "react";

import { usePluginContext } from "../../plugin";

import style from "./add-invitation.module.scss";

const cx = classNames.bind(style);

export type AddInvitationProps = {
  onCreate: (email: string, tenantId: string) => Promise<void>;
  selectedTenantId: string;
};

export const AddInvitation: React.FC<AddInvitationProps> = ({ onCreate, selectedTenantId }) => {
  const { t } = usePluginContext();
  const [inviteEmail, setInviteEmail] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleAddInvite = usePrettyAction(
    async () => {
      setIsSubmitting(true);
      await onCreate(inviteEmail, selectedTenantId);
      setIsSubmitting(false);
      setInviteEmail("");
    },
    [onCreate, inviteEmail, selectedTenantId],
    { errorMessage: "Failed to add invite, please try again" },
  );

  return (
    <div className={cx("addInvitationWrapper")}>
      <TextInput
        id="invitee-email"
        type="email"
        placeholder="Enter email"
        value={inviteEmail}
        onChange={(e: any) => setInviteEmail(e)}
        className=""
        required
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
  );
};

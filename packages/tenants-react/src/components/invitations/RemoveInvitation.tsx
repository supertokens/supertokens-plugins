import { Button } from "@shared/ui";

import { Trash } from "../icons/Trash";

type RemoveInvitationProps = {
  onRemove: () => Promise<void>;
  disabled?: boolean;
};

export const RemoveInvitation: React.FC<RemoveInvitationProps> = ({ onRemove, disabled = false }) => {
  return (
    <div>
      <Button appearance="filled" variant="danger" onClick={onRemove} disabled={disabled}>
        <Trash label="Remove Invitation" />
      </Button>
    </div>
  );
};

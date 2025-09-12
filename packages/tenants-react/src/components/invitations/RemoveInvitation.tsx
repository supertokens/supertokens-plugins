import { Button } from "@shared/ui";

import { Trash } from "../icons/Trash";

type RemoveInvitationProps = {
  onRemove: () => Promise<void>;
};

export const RemoveInvitation: React.FC<RemoveInvitationProps> = ({ onRemove }) => {
  return (
    <div>
      <Button appearance="filled" variant="danger" onClick={onRemove}>
        <Trash label="Remove Invitation" />
      </Button>
    </div>
  );
};

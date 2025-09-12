import { Icon } from "@shared/ui";

type TrashProps = {
  label?: string;
};

export const Trash: React.FC<TrashProps> = ({ label }) => {
  // TODO: Update with the actual icon
  return <Icon name="xmark" label={label} />;
};

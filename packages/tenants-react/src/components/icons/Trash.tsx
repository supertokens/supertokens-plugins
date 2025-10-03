import { Icon } from "@shared/ui";

type TrashProps = {
  label?: string;
};

export const Trash: React.FC<TrashProps> = ({ label }) => {
  return <Icon name="trash" library="bundled" />;
};

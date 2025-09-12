import { Icon } from "@shared/ui";

type CopyProps = {
  label?: string;
};

export const Copy: React.FC<CopyProps> = ({ label }) => {
  // TODO: Update with the actual icon
  return <Icon name="copy" label={label} />;
};

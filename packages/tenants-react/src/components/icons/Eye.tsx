import { Icon } from "@shared/ui";

type EyeProps = {
  label?: string;
};

export const Eye: React.FC<EyeProps> = ({ label }) => {
  // TODO: Update with the actual icon
  return <Icon name="eye" label={label} />;
};

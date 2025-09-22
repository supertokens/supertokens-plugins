import { Icon } from "@shared/ui";

type CopyProps = {
  label?: string;
};

export const Copy: React.FC<CopyProps> = ({ label }) => {
  return <Icon name="copy" label={label} library="bundled" />;
};

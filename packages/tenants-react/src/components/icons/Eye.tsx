import {  Icon } from "@shared/ui";

type EyeProps = {
  label?: string;
};

export const Eye: React.FC<EyeProps> = ({ label }) => {
  return <Icon name="eye-open" label={label} library="bundled" />;
};

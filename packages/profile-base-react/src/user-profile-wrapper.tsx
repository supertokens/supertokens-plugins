import { ToastProvider, ToastContainer } from "@shared/ui";

import { ProfileSections } from "./components";
import { usePluginContext } from "./plugin";

export const UserProfileWrapper = () => {
  const { getSections } = usePluginContext();

  const sections = getSections();

  return (
    <ToastProvider withFlash>
      <ProfileSections sections={sections} />
      <ToastContainer />
    </ToastProvider>
  );
};

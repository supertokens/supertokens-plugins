import { ProfileSections } from "./components";
import { ToastProvider, ToastContainer } from "@shared/ui";
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

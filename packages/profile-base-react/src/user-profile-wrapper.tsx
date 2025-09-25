import { ToastProvider, ToastContainer } from "@shared/ui";
import { useCallback, useEffect, useState } from "react";

import { ProfileSections } from "./components";
import { usePluginContext } from "./plugin";
import { SuperTokensPluginProfileSection } from "./types";

export const UserProfileWrapper = () => {
  const { getSections, getOnLoadHandlers } = usePluginContext();

  const [sections, setSections] = useState<SuperTokensPluginProfileSection[]>([]);
  const loadSections = useCallback(() => {
    const _sections = getSections().sort((a, b) => a.order - b.order);
    setSections(_sections);
  }, []);

  useEffect(() => {
    Promise.all(getOnLoadHandlers().map((handler) => handler())).then(loadSections);
  }, []);

  return (
    <ToastProvider withFlash>
      <ProfileSections sections={sections} />
      <ToastContainer />
    </ToastProvider>
  );
};

import { ToastProvider, ToastContainer } from "@shared/ui";

import { SecurityDetailsSection } from "./components";

export const SecuritySectionWrapper = () => {
  return (
    <ToastProvider>
      <SecurityDetailsSection />
      <ToastContainer />
    </ToastProvider>
  );
};

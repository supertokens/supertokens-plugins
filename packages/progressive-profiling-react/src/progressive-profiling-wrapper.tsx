import { ToastContainer, ToastProvider } from "@shared/ui";
import { FormSection, ProfileFormData } from "@supertokens-plugins/progressive-profiling-shared";
import { useCallback, useEffect, useState } from "react";

import { ProgressiveProfilingForm } from "./components";
import { usePluginContext } from "./plugin";
import { AuthPage } from "supertokens-auth-react/ui";

export const ProgressiveProfilingWrapper = () => {
  const { api, componentMap, t, pluginConfig } = usePluginContext();

  const [isLoading, setIsLoading] = useState(true);
  const [isSuccess, setIsSuccess] = useState(false);

  const [sections, setSections] = useState<FormSection[]>([]);
  const [data, setData] = useState<ProfileFormData>([]);

  const loadSections = useCallback(async () => {
    setIsLoading(true);
    let response: Awaited<ReturnType<typeof api.getSections>>;
    try {
      response = await api.getSections();
    } finally {
      setIsLoading(false);
    }

    if (response.status === "OK") {
      setSections(response.sections);
    }

    return response;
  }, []);

  const loadProfile = useCallback(async () => {
    setIsLoading(true);
    let response: Awaited<ReturnType<typeof api.getProfile>>;
    try {
      response = await api.getProfile();
    } finally {
      setIsLoading(false);
    }

    if (response.status === "OK") {
      setData(response.data);
    }

    return response;
  }, []);

  const onSubmit = useCallback(async (data: ProfileFormData) => {
    setIsLoading(true);
    let response: Awaited<ReturnType<typeof api.updateProfile>>;
    try {
      response = await api.updateProfile({ data });
    } finally {
      setIsLoading(false);
    }

    return response;
  }, []);

  const onSuccess = useCallback(async () => {
    await pluginConfig.onSuccess?.(data);
    setIsSuccess(true);
  }, []);

  useEffect(() => {
    loadSections();
    loadProfile();
  }, []);

  // make sure we don't render the form if there are no sections
  if (!sections.length) {
    return null;
  }

  // The loading string below should never actually appear on screen, but we need to provide a component to prevent the AuthPage from loading unnecessary components.
  return (
    <ToastProvider>
      {isSuccess && (
        <div style={{ display: "none" }}>
          <AuthPage preBuiltUIList={[]}>
            <>Loading...</>
          </AuthPage>
        </div>
      )}
      <ProgressiveProfilingForm
        sections={sections}
        data={data}
        onSubmit={onSubmit}
        isLoading={isLoading}
        loadProfile={loadProfile}
        loadSections={loadSections}
        onSuccess={onSuccess}
        componentMap={componentMap}
      />
      <ToastContainer />
    </ToastProvider>
  );
};

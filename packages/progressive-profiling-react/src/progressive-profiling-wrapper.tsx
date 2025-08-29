import { ToastContainer, ToastProvider } from "@shared/ui";
import { FormSection, ProfileFormData } from "@supertokens-plugins/progressive-profiling-shared";
import { useCallback, useEffect, useState } from "react";

import { ProgressiveProfilingForm } from "./components";
import { usePluginContext } from "./plugin";

export const ProgressiveProfilingWrapper = () => {
  const { api, componentMap, t, pluginConfig } = usePluginContext();

  const [isLoading, setIsLoading] = useState(true);
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
      const isComplete = response.sections.every((section) => section.completed);
      if (isComplete) {
        await pluginConfig.onSuccess(data);
      }

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

  useEffect(() => {
    loadSections();
    loadProfile();
  }, []);

  return (
    <ToastProvider>
      <ProgressiveProfilingForm
        sections={sections}
        data={data}
        onSubmit={onSubmit}
        isLoading={isLoading}
        loadProfile={loadProfile}
        loadSections={loadSections}
        onSuccess={pluginConfig.onSuccess}
        componentMap={componentMap}
      />
      <ToastContainer />
    </ToastProvider>
  );
};

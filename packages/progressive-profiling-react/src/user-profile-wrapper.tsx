import { ToastContainer, ToastProvider } from "@shared/ui";
import { FormSection, ProfileFormData } from "@supertokens-plugins/progressive-profiling-shared";
import { useCallback, useEffect, useState } from "react";

import { ProfilingCard } from "./components";
import { usePluginContext } from "./plugin";

export const UserProfileWrapper = () => {
  const { api, componentMap, t } = usePluginContext();

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
    console.log("onSuccess");
    // window.location.href = "/";
  }, []);

  useEffect(() => {
    loadSections();
    loadProfile();
  }, []);

  if (sections.length === 0) {
    return <div>{t("PL_PP_NO_SECTIONS")}</div>; // add empty state and/or redirect
  }

  return (
    <ToastProvider>
      <ProfilingCard
        sections={sections}
        data={data}
        onSubmit={onSubmit}
        isLoading={isLoading}
        fetchFormData={loadProfile}
        onSuccess={onSuccess}
        componentMap={componentMap}
      />
      <ToastContainer />
    </ToastProvider>
  );
};

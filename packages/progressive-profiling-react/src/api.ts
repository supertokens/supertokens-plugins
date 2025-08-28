import { getQuerier } from "@shared/react";
import { FormSection, ProfileFormData } from "@supertokens-plugins/progressive-profiling-shared";

export const getApi = (querier: ReturnType<typeof getQuerier>) => {
  const getSections = async () => {
    return await querier.get<{ status: "OK"; sections: FormSection[] } | { status: "ERROR"; message: string }>(
      "/sections",
      {
        withSession: true,
      },
    );
  };

  const getProfile = async () => {
    return await querier.get<{ status: "OK"; data: ProfileFormData } | { status: "ERROR"; message: string }>(
      "/profile",
      { withSession: true },
    );
  };

  const updateProfile = async (payload: { data: ProfileFormData }) => {
    return await querier.post<{ status: "OK" } | { status: "ERROR"; message: string }>("/profile", payload, {
      withSession: true,
    });
  };

  return {
    getProfile,
    updateProfile,
    getSections,
  };
};

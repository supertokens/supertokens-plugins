import { getQuerier, QuerierError } from "@shared/react";
import { FormSection, ProfileFormData } from "@supertokens-plugins/progressive-profiling-shared";

export const getApi = (querier: ReturnType<typeof getQuerier>) => {
  const getSections = async () => {
    try {
      return await querier.get<{ status: "OK"; sections: FormSection[] } | { status: "ERROR"; message: string }>(
        "/sections",
        {
          withSession: true,
        },
      );
    } catch (error) {
      if (error instanceof QuerierError) {
        return error.payload;
      }

      throw error;
    }
  };

  const getProfile = async () => {
    try {
      return await querier.get<{ status: "OK"; data: ProfileFormData } | { status: "ERROR"; message: string }>(
        "/profile",
        {
          withSession: true,
        },
      );
    } catch (error) {
      if (error instanceof QuerierError) {
        return error.payload;
      }

      throw error;
    }
  };

  const updateProfile = async (payload: { data: ProfileFormData }) => {
    try {
      return await querier.post<
        | { status: "OK" }
        | { status: "ERROR"; message: string }
        | { status: "INVALID_FIELDS"; errors: { id: string; error: string }[] }
      >("/profile", payload, {
        withSession: true,
      });
    } catch (error) {
      if (error instanceof QuerierError) {
        return error.payload;
      }

      throw error;
    }
  };

  return {
    getProfile,
    updateProfile,
    getSections,
  };
};

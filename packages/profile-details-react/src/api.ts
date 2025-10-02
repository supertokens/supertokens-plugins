import { getQuerier } from "@shared/react";
import { BaseFormFieldPayload, BaseFormSection } from "@supertokens-plugins/profile-details-shared";
import { User } from "supertokens-web-js/types";

import { ProfileDetails } from "./types";

export const getApi = (querier: ReturnType<typeof getQuerier>) => {
  const getDetails = async () => {
    return await querier.get<
      { status: "OK"; profile: ProfileDetails; user: User } | { status: "ERROR"; message: string }
    >("/profile", {
      withSession: true,
    });
  };

  const updateProfile = async (payload: { data: BaseFormFieldPayload[] }) => {
    return await querier.post<{ status: "OK"; profile: ProfileDetails } | { status: "ERROR"; message: string }>(
      "/profile",
      payload,
      {
        withSession: true,
      },
    );
  };

  const getSections = async () => {
    return await querier.get<{ status: "OK"; sections: BaseFormSection[] }>("/sections", {
      withSession: true,
    });
  };

  return {
    getDetails,
    updateProfile,
    getSections,
  };
};

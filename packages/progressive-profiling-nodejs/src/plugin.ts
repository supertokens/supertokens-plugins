import { SuperTokensPlugin } from "supertokens-node/types";
import { SessionContainerInterface } from "supertokens-node/recipe/session/types";
import { BooleanClaim } from "supertokens-node/recipe/session/claims";

import { pluginUserMetadata, withRequestHandler } from "@shared/nodejs";
import { createPluginInitFunction } from "@shared/js";
import { ProfileFormData } from "@supertokens-plugins/progressive-profiling-shared";

import {
  FormSection,
  SuperTokensPluginProfileProgressiveProfilingConfig,
  RegisterSection,
  UserMetadataConfig,
} from "./types";
import { HANDLE_BASE_PATH, PLUGIN_ID, METADATA_KEY, PLUGIN_SDK_VERSION } from "./constants";
import { enableDebugLogs, logDebugMessage } from "./logger";

const isSectionCompleted = (section: FormSection, data: ProfileFormData) => {
  return section.fields.reduce((acc, field) => {
    const value = data.find((d) => d.fieldId === field.id)?.value;
    if (field.required && value === undefined) {
      return acc && false;
    }

    return acc && true;
  }, true);
};

const areAllSectionsCompleted = (sections: FormSection[], profileConfig?: UserMetadataConfig) => {
  return sections.reduce((acc, section) => {
    return acc && (profileConfig?.sectionCompleted?.[section.id] ?? false);
  }, true);
};

export const init = createPluginInitFunction<SuperTokensPlugin, SuperTokensPluginProfileProgressiveProfilingConfig>(
  () => {
    const metadata = pluginUserMetadata<{ profileConfig?: UserMetadataConfig }>(METADATA_KEY);

    const existingSections: (FormSection & { registererId: string })[] = [];

    const existingRegistererHandlers: Record<string, Pick<Parameters<RegisterSection>[0], "set" | "get">> = {};

    const registerSection: RegisterSection = ({ registererId, sections, set, get }) => {
      const registrableSections = sections
        .filter((section) => {
          const existingSection = existingSections.find((s) => s.id === section.id);
          if (existingSection) {
            logDebugMessage(
              `Profile plugin section with id "${section.id}" already registered by "${existingSection.registererId}". Skipping...`,
            );
            return false;
          }

          return true;
        })
        .map((section) => ({
          ...section,
          registererId,
        }));

      existingSections.push(...registrableSections);
      existingRegistererHandlers[registererId] = { set, get };
    };

    const getSections = () => {
      return existingSections;
    };

    const setSectionValues = async (session: SessionContainerInterface, data: ProfileFormData) => {
      const userId = session.getUserId();
      if (!userId) {
        throw new Error("User not found");
      }

      const sections = getSections();

      const sectionIdToRegistererIdMap = sections.reduce(
        (acc, section) => {
          return { ...acc, [section.id]: section.registererId };
        },
        {} as Record<string, string>,
      );

      const sectionsById = sections.reduce(
        (acc, section) => {
          return { ...acc, [section.id]: section };
        },
        {} as Record<string, FormSection>,
      );

      const dataBySectionId = data.reduce(
        (acc, row) => {
          return { ...acc, [row.sectionId]: [...(acc[row.sectionId] ?? []), row] };
        },
        {} as Record<string, ProfileFormData[number][]>,
      );

      const dataByRegistererId = data.reduce(
        (acc, row) => {
          const registererId = sectionIdToRegistererIdMap[row.sectionId];
          if (registererId) {
            return { ...acc, [registererId]: [...(acc[registererId] ?? []), row] };
          }
          return acc;
        },
        {} as Record<string, ProfileFormData[number][]>,
      );

      const validationErrors: { id: string; error: string }[] = [];
      for (const row of data) {
        const field = sectionsById[row.sectionId]?.fields.find((f) => f.id === row.fieldId);
        if (!field) {
          validationErrors.push({
            id: row.fieldId,
            error: `Field with id "${row.fieldId}" not found`,
          });
          continue;
        }

        if (field.required && row.value === undefined) {
          validationErrors.push({
            id: field.id,
            error: `Field value for field "${field.id}" is required`,
          });
          continue;
        }

        const validationError = await field.validation?.(row.value);
        if (validationError) {
          validationErrors.push({ id: field.id, error: validationError });
        }
      }

      const updatedData: ProfileFormData = [];
      for (const registererId of Object.keys(dataByRegistererId)) {
        const sectionHandlers = existingRegistererHandlers[registererId];
        if (!sectionHandlers) {
          continue;
        }
        const sectionData = dataByRegistererId[registererId];
        if (!sectionData) {
          continue;
        }

        await sectionHandlers.set(sectionData, session);
        // get all the data from the storage, since data could be updated from other places or updated partially
        const data = await sectionHandlers.get(session);
        updatedData.push(...data);
      }

      // do it like this to have a unique list of sections to update
      const sectionsToUpdate = Object.keys(dataBySectionId)
        .map((sectionId) => sections.find((s) => s.id === sectionId))
        .filter((s) => s !== undefined);
      const sectionsCompleted: Record<string, boolean> = {};
      for (const section of sectionsToUpdate) {
        sectionsCompleted[section.id] = isSectionCompleted(
          section,
          updatedData.filter((d) => d.sectionId === section.id),
        );
      }

      const userMetadata = await metadata.get(userId);
      const newUserMetadata = {
        ...userMetadata,
        profileConfig: {
          ...userMetadata?.profileConfig,
          sectionCompleted: {
            ...(userMetadata?.profileConfig?.sectionCompleted ?? {}),
            ...sectionsCompleted,
          },
        },
      };
      await metadata.set(userId, newUserMetadata);

      // refresh the claim to make sure the frontend has the latest value
      // but only if all sections are completed
      const allSectionsCompleted = areAllSectionsCompleted(getSections(), newUserMetadata?.profileConfig);
      if (allSectionsCompleted) {
        await session.fetchAndSetClaim(ProgressiveProfilingCompletedClaim);
      }

      return { status: "OK" };
    };

    const getSectionValues = async (session: SessionContainerInterface) => {
      const userId = session.getUserId();
      if (!userId) {
        throw new Error("User not found");
      }

      const sections = getSections();

      const sectionsByRegistererId = sections.reduce(
        (acc, section) => {
          return { ...acc, [section.registererId]: section };
        },
        {} as Record<string, FormSection>,
      );

      const data: ProfileFormData = [];
      for (const registererId of Object.keys(sectionsByRegistererId)) {
        const sectionHandlers = existingRegistererHandlers[registererId];
        if (!sectionHandlers) {
          continue;
        }

        const sectionData = await sectionHandlers.get(session);
        data.push(...sectionData);
      }

      return data;
    };

    const ProgressiveProfilingCompletedClaim = new BooleanClaim({
      key: `${PLUGIN_ID}-completed`,
      fetchValue: async (userId) => {
        const userMetadata = await metadata.get(userId);
        return areAllSectionsCompleted(getSections(), userMetadata?.profileConfig);
      },
    });

    return {
      id: PLUGIN_ID,
      compatibleSDKVersions: PLUGIN_SDK_VERSION,
      init: (config) => {
        if (config.debug) {
          enableDebugLogs();
        }
      },
      routeHandlers() {
        return {
          status: "OK",
          routeHandlers: [
            {
              path: HANDLE_BASE_PATH + "/sections",
              method: "get",
              verifySessionOptions: {
                sessionRequired: true,
                overrideGlobalClaimValidators: (globalValidators) => {
                  // we should not check if the profile is completed here, because we want to allow users to access the profile page even if they haven't completed the profile
                  return globalValidators.filter(
                    (validator) => validator.id !== ProgressiveProfilingCompletedClaim.key,
                  );
                },
              },
              handler: withRequestHandler(async (req, res, session, userContext) => {
                if (!session) {
                  throw new Error("Session not found");
                }

                const userId = session.getUserId(userContext);
                if (!userId) {
                  throw new Error("User not found");
                }

                const userMetadata = await metadata.get(userId);

                // map the sections to a json serializable value
                const sections = getSections().map((section) => ({
                  id: section.id,
                  label: section.label,
                  description: section.description,
                  completed: userMetadata?.profileConfig?.sectionCompleted?.[section.id] ?? false,
                  fields: section.fields.map((field) => {
                    return {
                      id: field.id,
                      label: field.label,
                      type: field.type,
                      required: field.required,
                      defaultValue: field.defaultValue,
                      placeholder: field.placeholder,
                      description: field.description,
                      options: field.options,
                    };
                  }),
                }));

                return { status: "OK", sections };
              }),
            },
            {
              path: HANDLE_BASE_PATH + "/profile",
              method: "post",
              verifySessionOptions: {
                sessionRequired: true,
                overrideGlobalClaimValidators: (globalValidators) => {
                  // we should not check if the profile is completed here, because we want to allow users to access the profile page even if they haven't completed the profile
                  return globalValidators.filter(
                    (validator) => validator.id !== ProgressiveProfilingCompletedClaim.key,
                  );
                },
              },
              handler: withRequestHandler(async (req, res, session, userContext) => {
                if (!session) {
                  return { status: "ERROR", message: "Session not found" };
                }

                const userId = session.getUserId(userContext);
                if (!userId) {
                  return { status: "ERROR", message: "User not found" };
                }

                const payload: { data: ProfileFormData } = await req.getJSONBody();

                return setSectionValues(session, payload.data);
              }),
            },
            {
              path: HANDLE_BASE_PATH + "/profile",
              method: "get",
              verifySessionOptions: {
                sessionRequired: true,
                overrideGlobalClaimValidators: (globalValidators) => {
                  // we should not check if the profile is completed here, because we want to allow users to access the profile page even if they haven't completed the profile
                  return globalValidators.filter(
                    (validator) => validator.id !== ProgressiveProfilingCompletedClaim.key,
                  );
                },
              },
              handler: withRequestHandler(async (req, res, session, userContext) => {
                if (!session) {
                  throw new Error("Session not found");
                }

                const userId = session.getUserId(userContext);
                if (!userId) {
                  throw new Error("User not found");
                }

                const fieldValues = await getSectionValues(session);

                return { status: "OK", data: fieldValues };
              }),
            },
          ],
        };
      },
      overrideMap: {
        session: {
          functions: (originalImplementation) => {
            return {
              ...originalImplementation,
              getGlobalClaimValidators: async function (input) {
                return [
                  ...(await originalImplementation.getGlobalClaimValidators(input)),
                  ProgressiveProfilingCompletedClaim.validators.isTrue(),
                ];
              },
              createNewSession: async (input) => {
                input.accessTokenPayload = {
                  ...input.accessTokenPayload,
                  ...(await ProgressiveProfilingCompletedClaim.build(
                    input.userId,
                    input.recipeUserId,
                    input.tenantId,
                    input.accessTokenPayload,
                    input.userContext,
                  )),
                };

                return originalImplementation.createNewSession(input);
              },
            };
          },
        },
      },
      exports: {
        metadata,
        registerSection,
        getSections,
        setSectionValues,
        getSectionValues,
      },
    };
  },
);

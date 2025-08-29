import { SuperTokensPlugin } from "supertokens-node/types";

import { pluginUserMetadata, withRequestHandler } from "@shared/nodejs";
import { createPluginInitFunction } from "@shared/js";
import { ProfileFormData } from "@supertokens-plugins/progressive-profiling-shared";

import {
  SuperTokensPluginProfileProgressiveProfilingConfig,
  UserMetadataConfig,
  SuperTokensPluginProfileProgressiveProfilingNormalisedConfig,
} from "./types";
import { HANDLE_BASE_PATH, PLUGIN_ID, METADATA_KEY, PLUGIN_SDK_VERSION } from "./constants";
import { enableDebugLogs } from "./logger";
import { ProgressiveProfilingService } from "./progressive-profiling-service";

export const init = createPluginInitFunction<
  SuperTokensPlugin,
  SuperTokensPluginProfileProgressiveProfilingConfig,
  ProgressiveProfilingService,
  SuperTokensPluginProfileProgressiveProfilingNormalisedConfig
>(
  (_, implementation) => {
    const metadata = pluginUserMetadata<{ profileConfig?: UserMetadataConfig }>(METADATA_KEY);

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
                    (validator) => validator.id !== ProgressiveProfilingService.ProgressiveProfilingCompletedClaim.key
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
                const sections = implementation.getSections().map((section) => ({
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
                    (validator) => validator.id !== ProgressiveProfilingService.ProgressiveProfilingCompletedClaim.key
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

                return implementation.setSectionValues(session, payload.data);
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
                    (validator) => validator.id !== ProgressiveProfilingService.ProgressiveProfilingCompletedClaim.key
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

                const fieldValues = await implementation.getSectionValues(session);

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
                  ProgressiveProfilingService.ProgressiveProfilingCompletedClaim.validators.isTrue(),
                ];
              },
              createNewSession: async (input) => {
                input.accessTokenPayload = {
                  ...input.accessTokenPayload,
                  ...(await ProgressiveProfilingService.ProgressiveProfilingCompletedClaim.build(
                    input.userId,
                    input.recipeUserId,
                    input.tenantId,
                    input.accessTokenPayload,
                    input.userContext
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
        registerSection: implementation.registerSection,
        getSections: implementation.getSections,
        setSectionValues: implementation.setSectionValues,
        getSectionValues: implementation.getSectionValues,
      },
    };
  },

  (config) => new ProgressiveProfilingService(config)
);

import { SuperTokensPlugin } from "supertokens-node/types";

import { pluginUserMetadata, withRequestHandler } from "@shared/nodejs";
import { createPluginInitFunction } from "@shared/js";
import { ProfileFormData } from "@supertokens-plugins/progressive-profiling-shared";

import {
  SuperTokensPluginProfileProgressiveProfilingConfig,
  UserMetadataConfig,
  SuperTokensPluginProfileProgressiveProfilingNormalisedConfig,
} from "./types";
import { HANDLE_BASE_PATH, PLUGIN_ID, METADATA_KEY, PLUGIN_SDK_VERSION, DEFAULT_SECTIONS } from "./constants";
import { enableDebugLogs } from "./logger";
import { Implementation } from "./implementation";

export const init = createPluginInitFunction<
  SuperTokensPlugin,
  SuperTokensPluginProfileProgressiveProfilingConfig,
  Implementation,
  SuperTokensPluginProfileProgressiveProfilingNormalisedConfig
>(
  (pluginConfig, implementation) => {
    const metadata = pluginUserMetadata<{ profileConfig?: UserMetadataConfig }>(METADATA_KEY);

    if (pluginConfig.sections.length > 0) {
      const defaultFields = pluginConfig.sections
        .map((section) =>
          section.fields.map((field) => ({
            id: field.id,
            defaultValue: field.defaultValue,
            sectionId: section.id,
          })),
        )
        .flat();

      const defaultRegistrator = implementation.getDefaultRegistrator(defaultFields);
      implementation.registerSections({
        registratorId: "default",
        sections: pluginConfig.sections,
        set: defaultRegistrator.set,
        get: defaultRegistrator.get,
      });
    }

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
                    (validator) => validator.id !== Implementation.ProgressiveProfilingCompletedClaim.key,
                  );
                },
              },
              handler: withRequestHandler(async (req, res, session, userContext) => {
                if (!session) {
                  throw new Error("Session not found");
                }

                return implementation.getUserSections(session, userContext);
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
                    (validator) => validator.id !== Implementation.ProgressiveProfilingCompletedClaim.key,
                  );
                },
              },
              handler: withRequestHandler(async (req, res, session, userContext) => {
                if (!session) {
                  throw new Error("Session not found");
                }

                const payload: { data: ProfileFormData } = await req.getJSONBody();

                return implementation.setSectionValues(session, payload.data, userContext);
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
                    (validator) => validator.id !== Implementation.ProgressiveProfilingCompletedClaim.key,
                  );
                },
              },
              handler: withRequestHandler(async (req, res, session, userContext) => {
                if (!session) {
                  throw new Error("Session not found");
                }

                return implementation.getSectionValues(session, userContext);
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
                  Implementation.ProgressiveProfilingCompletedClaim.validators.isTrue(),
                ];
              },
              createNewSession: async (input) => {
                input.accessTokenPayload = {
                  ...input.accessTokenPayload,
                  ...(await Implementation.ProgressiveProfilingCompletedClaim.build(
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
        registerSections: implementation.registerSections,
        getSections: implementation.getSections,
        setSectionValues: implementation.setSectionValues,
        getSectionValues: implementation.getSectionValues,
      },
    };
  },

  (config) => Implementation.init(config),
  (config) => {
    return {
      ...config,
      sections:
        config.sections?.map((section) => ({
          ...section,
          completed: undefined, // make sure the sections are not marked as completed by default
        })) ?? DEFAULT_SECTIONS,
    };
  },
);

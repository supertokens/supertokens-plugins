/* eslint-disable indent */ // buggy linting for the originalImplementation conditional signInUpPOST
import { SuperTokensPlugin } from "supertokens-node/types";
import { SessionContainerInterface } from "supertokens-node/recipe/session/types";
import {
  PLUGIN_ID,
  PLUGIN_SDK_VERSION,
  HANDLE_BASE_PATH,
  SUPERTOKENS_PLUGIN_PROGRESSIVE_PROFILING_ID,
  DEFAULT_REGISTER_SECTIONS_FOR_PROGRESSIVE_PROFILING,
} from "./constants";
import { getUser } from "supertokens-node";
import { withRequestHandler } from "@shared/nodejs";
import { createPluginInitFunction } from "@shared/js";
import { SuperTokensPluginProfileDetailsConfig, SuperTokensPluginProfileDetailsNormalisedConfig } from "./types";
import type { BaseFormFieldPayload } from "@supertokens-plugins/profile-details-shared";
import { BASE_FORM_SECTIONS } from "@supertokens-plugins/profile-details-shared";
import { enableDebugLogs, logDebugMessage } from "./logger";
import { Implementation } from "./implementation";

export const init = createPluginInitFunction<
  SuperTokensPlugin,
  SuperTokensPluginProfileDetailsConfig,
  Implementation,
  SuperTokensPluginProfileDetailsNormalisedConfig
>(
  (pluginConfig, implementation) => {
    return {
      id: PLUGIN_ID,
      compatibleSDKVersions: PLUGIN_SDK_VERSION,
      overrideMap: {
        thirdparty: {
          apis(originalImplementation) {
            return {
              ...originalImplementation,
              signInUpPOST: originalImplementation?.signInUpPOST
                ? async (input) => {
                    const signUpResult = await originalImplementation!.signInUpPOST!(input);

                    if (signUpResult.status !== "OK") {
                      return signUpResult;
                    }

                    const providerId = signUpResult.user.loginMethods.find(
                      (method) =>
                        method.recipeUserId.getAsString() === signUpResult.session.getRecipeUserId().getAsString(),
                    )?.thirdParty?.id;

                    if (!providerId) {
                      throw new Error("Provider ID not found. This should not have happened.");
                    }

                    const profile = await implementation.getProfile(
                      signUpResult.user.id,
                      signUpResult.session,
                      input.userContext,
                    );

                    const providerUserInfo = signUpResult.rawUserInfoFromProvider?.fromUserInfoAPI ?? {};

                    const updatedFields = implementation
                      .getPluginFormFields(signUpResult.session, input.userContext)
                      .reduce((acc, field) => {
                        if (profile[field.id]) return acc;

                        const value = implementation.getFieldValueFromThirdPartyUserInfo(
                          providerId,
                          field,
                          providerUserInfo,
                          profile,
                        );
                        if (typeof value === "undefined") return acc;

                        return [
                          ...acc,
                          {
                            sectionId: field.sectionId,
                            fieldId: field.id,
                            value,
                          },
                        ];
                      }, [] as BaseFormFieldPayload[]);

                    if (updatedFields.length > 0) {
                      await implementation.updateProfile(
                        signUpResult.user.id,
                        updatedFields,
                        signUpResult.session,
                        input.userContext,
                      );
                    }

                    return signUpResult;
                  }
                : undefined,
            };
          },
        },
      },
      init: (config, plugins) => {
        if (config.debug) {
          enableDebugLogs();
        }

        const progressiveProfilingRegisterSections = plugins.find(
          (plugin: any) => plugin.id === SUPERTOKENS_PLUGIN_PROGRESSIVE_PROFILING_ID,
        )?.exports?.registerSections;
        if (pluginConfig.registerSectionsForProgressiveProfiling && progressiveProfilingRegisterSections) {
          logDebugMessage("Progressive profiling plugin found. Adding common details profile plugin.");

          progressiveProfilingRegisterSections({
            storageHandlerId: PLUGIN_ID,
            sections: pluginConfig.sections.map((section) => ({
              ...section,
              fields: section.fields.map(({ ...field }) => ({
                ...field,
                required: field.required ?? false,
              })),
            })),
            get: async (session: SessionContainerInterface, userContext?: Record<string, any>) => {
              if (!session) {
                throw new Error("Session not found");
              }

              const profile = await implementation.getProfile(session.getUserId(), session, userContext);
              return implementation.buildFormData(profile, session, userContext);
            },
            set: async (
              formData: BaseFormFieldPayload[],
              session: SessionContainerInterface,
              userContext?: Record<string, any>,
            ) => {
              if (!session) {
                throw new Error("Session not found");
              }

              const userId = session.getUserId();
              await implementation.updateProfile(userId, formData, session, userContext);
            },
          });
        }
      },
      routeHandlers: () => {
        return {
          status: "OK",
          routeHandlers: [
            {
              path: HANDLE_BASE_PATH + "/sections",
              method: "get",
              verifySessionOptions: {
                sessionRequired: true,
              },
              handler: withRequestHandler(async (req, res, session, userContext) => {
                if (!session) {
                  throw new Error("Session not found");
                }

                const userId = session!.getUserId();
                if (!userId) {
                  return { status: "ERROR", message: "User not found" };
                }

                return {
                  status: "OK",
                  sections: implementation.getSections(session!, userContext),
                };
              }),
            },
            {
              path: HANDLE_BASE_PATH + "/profile",
              method: "post",
              verifySessionOptions: {
                sessionRequired: true,
              },
              handler: withRequestHandler(async (req, res, session, userContext) => {
                if (!session) {
                  throw new Error("Session not found");
                }

                const userId = session!.getUserId();
                if (!userId) {
                  return { status: "ERROR", message: "User not found" };
                }

                const payload = await req.getJSONBody();

                await implementation.updateProfile(userId, payload.data || [], session!, userContext);

                return { status: "OK", profile: payload };
              }),
            },
            {
              path: HANDLE_BASE_PATH + "/profile",
              method: "get",
              verifySessionOptions: {
                sessionRequired: true,
              },
              handler: withRequestHandler(async (req, res, session, userContext) => {
                if (!session) {
                  throw new Error("Session not found");
                }

                const userId = session!.getUserId();
                if (!userId) {
                  return { status: "ERROR", message: "User not found" };
                }

                const user = await getUser(userId, userContext);
                if (!user) {
                  return { status: "ERROR", message: "User not found" };
                }

                const profile = await implementation.getProfile(userId, session!, userContext);

                return {
                  status: "OK",
                  profile,
                  user: user.toJson(),
                };
              }),
            },
          ],
        };
      },
    };
  },
  (config) => Implementation.init(config),
  (config) => ({
    sections: config?.sections ?? BASE_FORM_SECTIONS,
    registerSectionsForProgressiveProfiling:
      config?.registerSectionsForProgressiveProfiling ?? DEFAULT_REGISTER_SECTIONS_FOR_PROGRESSIVE_PROFILING,
  }),
);

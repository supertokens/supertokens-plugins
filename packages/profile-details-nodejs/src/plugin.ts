import { SuperTokensPlugin } from "supertokens-node/types";
import { SessionContainerInterface } from "supertokens-node/recipe/session/types";
import { PLUGIN_ID, PLUGIN_SDK_VERSION, HANDLE_BASE_PATH, METADATA_KEY } from "./constants";
import { getUser } from "supertokens-node";
import { pluginUserMetadata, withRequestHandler } from "@shared/nodejs";
import { createPluginInitFunction } from "@shared/js";
import {
  SuperTokensPluginProfileDetailsConfig,
  SuperTokensPluginProfileDetailsImplementation,
  SuperTokensPluginProfileDetailsNormalisedConfig,
} from "./types";
import { buildFormData, buildProfile } from "./utils";
import type { BaseFormField, BaseFormFieldPayload, BaseProfile } from "@supertokens-plugins/profile-details-shared";
import { BASE_FORM_SECTIONS } from "@supertokens-plugins/profile-details-shared";
import { defaultThirdPartyFieldMap } from "./utils";
import { enableDebugLogs, logDebugMessage } from "./logger";

// todo: feedback: have more exposed apis from the sdk - can't list users, cant get a user by email (or other fields), etc.
export const init = createPluginInitFunction<
  SuperTokensPlugin,
  SuperTokensPluginProfileDetailsConfig,
  SuperTokensPluginProfileDetailsImplementation,
  SuperTokensPluginProfileDetailsNormalisedConfig
>(
  (pluginConfig, implementation) => {
    const thirdPartyFieldMap = implementation.thirdPartyFieldMap(defaultThirdPartyFieldMap);

    const metadata = pluginUserMetadata<{ profile: BaseProfile }>(METADATA_KEY);

    const pluginFormFields = pluginConfig.sections.flatMap((section) =>
      section.fields.map((f: BaseFormField) => ({ ...f, sectionId: section.id })),
    );

    const updateProfile = async (userId: string, payload: BaseFormFieldPayload[]) => {
      const userMetadata = await metadata.get(userId);

      const profile = buildProfile(pluginFormFields, payload, userMetadata?.profile || {});

      await metadata.set(userId, {
        profile: {
          ...(userMetadata?.profile || {}),
          ...profile,
        },
      });
    };

    return {
      id: PLUGIN_ID,
      compatibleSDKVersions: PLUGIN_SDK_VERSION,
      overrideMap: {
        thirdparty: {
          functions(originalImplementation) {
            return {
              ...originalImplementation,
              signInUp: async (input) => {
                const signUpResult = await originalImplementation.signInUp(input);
                if (!thirdPartyFieldMap) {
                  return signUpResult;
                }

                if (signUpResult.status !== "OK") {
                  return signUpResult;
                }

                const providerId = signUpResult.user.loginMethods.find(
                  (method) => method.recipeUserId.getAsString() === signUpResult.recipeUserId.getAsString(),
                )?.thirdParty?.id;

                if (!providerId) {
                  throw new Error("Provider ID not found. This should not have happened.");
                }

                const userMetadata = await metadata.get(signUpResult.user.id);
                const profile = userMetadata?.profile ?? ({} as BaseProfile);

                const updatedFields = pluginFormFields.reduce((acc, field) => {
                  if (profile[field.id]) return acc;

                  const value = thirdPartyFieldMap(
                    providerId,
                    field,
                    input.rawUserInfoFromProvider?.fromUserInfoAPI,
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
                  await updateProfile(signUpResult.user.id, updatedFields);
                }

                return signUpResult;
              },
            };
          },
        },
      },
      init: (config, plugins) => {
        if (config.debug) {
          enableDebugLogs();
        }

        const progressiveProfilingPlugin = plugins.find(
          (plugin: any) => plugin.id === "supertokens-plugin-progressive-profiling",
        );
        if (progressiveProfilingPlugin?.exports?.registerSections) {
          logDebugMessage("Progressive profiling plugin found. Adding common details profile plugin.");

          const progressiveProfilingRegisterSections = progressiveProfilingPlugin.exports.registerSections;

          progressiveProfilingRegisterSections({
            registratorId: PLUGIN_ID,
            sections: pluginConfig.sections.map((section) => ({
              ...section,
              fields: section.fields.map(({ ...field }) => ({
                ...field,
                required: field.required ?? false,
              })),
            })),
            get: async (session: SessionContainerInterface) => {
              if (!session) {
                throw new Error("Session not found");
              }

              const userMetadata = await metadata.get(session.getUserId());
              const formData = buildFormData(pluginFormFields, userMetadata?.profile ?? {});

              return formData;
            },
            set: async (formData: BaseFormFieldPayload[], session: SessionContainerInterface) => {
              if (!session) {
                throw new Error("Session not found");
              }

              const userId = session.getUserId();
              await updateProfile(userId, formData);
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
                // not needed, since it doesn't use user data
                // also, this has to always return, as registering a section happens only at init and there is no session there
                sessionRequired: false,
              },
              handler: withRequestHandler(async () => {
                return {
                  status: "OK",
                  sections: pluginConfig.sections.map((section) => ({
                    ...section,
                    fields: section.fields.map(({ ...field }) => field),
                  })),
                };
              }),
            },
            {
              path: HANDLE_BASE_PATH + "/profile",
              method: "post",
              verifySessionOptions: {
                sessionRequired: true,
              },
              handler: withRequestHandler(async (req, res, session) => {
                const userId = session!.getUserId();
                if (!userId) {
                  return { status: "ERROR", message: "User not found" };
                }

                const payload = await req.getJSONBody();

                await updateProfile(userId, payload.data || []);

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
                const userId = session!.getUserId();
                if (!userId) {
                  return { status: "ERROR", message: "User not found" };
                }

                const user = await getUser(userId, userContext);
                if (!user) {
                  return { status: "ERROR", message: "User not found" };
                }

                const userMetadata = await metadata.get(userId);
                let profile = userMetadata?.profile as BaseProfile;
                if (!userMetadata) {
                  profile = buildProfile(pluginFormFields, [], {});
                  await metadata.set(userId, { profile });
                }

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
  {
    thirdPartyFieldMap: (originalImplementation) => originalImplementation,
  },
  (config) => ({
    sections: config?.sections ?? BASE_FORM_SECTIONS,
  }),
);

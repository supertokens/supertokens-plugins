import {
  RegisterSections,
  FormSection,
  SuperTokensPluginProfileProgressiveProfilingNormalisedConfig,
  UserMetadataConfig,
} from "./types";
import { logDebugMessage } from "./logger";
import { FormField, FormFieldValue, ProfileFormData } from "@supertokens-plugins/progressive-profiling-shared";
import { SessionContainerInterface } from "supertokens-node/recipe/session/types";
import { BooleanClaim } from "supertokens-node/recipe/session/claims";
import { PLUGIN_ID, METADATA_KEY, METADATA_PROFILE_KEY } from "./constants";
import { pluginUserMetadata } from "@shared/nodejs";
import { BasePluginImplementation, groupBy, indexBy, mapBy } from "@shared/js";

export class Implementation extends BasePluginImplementation<SuperTokensPluginProfileProgressiveProfilingNormalisedConfig> {
  protected existingSections: (FormSection & { registratorId: string })[] = [];
  protected existingRegistratorHandlers: Record<string, Pick<Parameters<RegisterSections>[0], "set" | "get">> = {};
  protected metadata = pluginUserMetadata<{ profileConfig?: UserMetadataConfig }>(METADATA_KEY);

  static ProgressiveProfilingCompletedClaim: BooleanClaim;

  constructor(pluginConfig: SuperTokensPluginProfileProgressiveProfilingNormalisedConfig) {
    super(pluginConfig);

    Implementation.ProgressiveProfilingCompletedClaim = new BooleanClaim({
      key: `${PLUGIN_ID}-completed`,
      fetchValue: async (userId, recipeUserId, tenantId, currentPayload, userContext) => {
        const userMetadata = await this.metadata.get(userId);
        return this.areAllSectionsCompleted(
          // can't pass session here because it's not available in the params or a way of getting it
          undefined as unknown as SessionContainerInterface,
          userMetadata?.profileConfig,
          userContext,
        );
      },
    });
  }

  // todo make sure the implementation is the same as in the profile plugin (when it will be implement in the new repo - maybe part of a shared library or exported from the plugin itself ?)
  getDefaultRegistrator = function (
    this: Implementation,
    pluginFormFields: (Pick<FormField, "id" | "defaultValue"> & { sectionId: string })[],
  ) {
    const metadata = pluginUserMetadata<{ profile: Record<string, FormFieldValue> }>(METADATA_PROFILE_KEY);

    return {
      get: async (session: SessionContainerInterface, userContext?: Record<string, any>) => {
        const userMetadata = await metadata.get(session.getUserId(userContext), userContext);
        const existingProfile = userMetadata?.profile || {};

        const data = pluginFormFields.map((field) => ({
          sectionId: field.sectionId,
          fieldId: field.id,
          value: existingProfile[field.id] ?? field.defaultValue,
        }));

        return data;
      },
      set: async (formData: ProfileFormData, session: SessionContainerInterface, userContext?: Record<string, any>) => {
        const userId = session.getUserId(userContext);
        const userMetadata = await metadata.get(userId, userContext);
        const existingProfile = userMetadata?.profile || {};

        const profile = pluginFormFields.reduce(
          (acc, field) => {
            const newValue = formData.find((d) => d.fieldId === field.id)?.value;
            const existingValue = existingProfile?.[field.id];
            return {
              ...acc,
              [field.id]: newValue ?? existingValue ?? field.defaultValue,
            };
          },
          { ...existingProfile },
        );

        await metadata.set(
          userId,
          {
            profile: {
              ...(userMetadata?.profile || {}),
              ...profile,
            },
          },
          userContext,
        );
      },
    };
  };

  registerSections: RegisterSections = function (this: Implementation, { registratorId, sections, set, get }) {
    const registrableSections = sections
      .filter((section) => {
        const existingSection = this.existingSections.find((s) => s.id === section.id);
        if (existingSection) {
          logDebugMessage(
            `Profile plugin section with id "${section.id}" already registered by "${existingSection.registratorId}". Skipping...`,
          );
          return false;
        }

        if (!registratorId) {
          logDebugMessage(`Profile plugin section with id "${section.id}" has no registrator id. Skipping...`);
          return false;
        }

        return true;
      })
      .map((section) => ({
        ...section,
        registratorId,
      }));

    this.existingSections.push(...registrableSections);
    this.existingRegistratorHandlers[registratorId] = { set, get };
  };

  getSections = function (
    this: Implementation,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    session?: SessionContainerInterface,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    userContext?: Record<string, any>,
  ) {
    return this.existingSections;
  };

  getUserSections = async function (
    this: Implementation,
    session: SessionContainerInterface,
    userContext?: Record<string, any>,
  ) {
    const userMetadata = await this.metadata.get(session.getUserId(userContext), userContext);

    // map the sections to a json serializable value
    const sections = this.getSections(session, userContext).map((section) => ({
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
  };

  setSectionValues = async function (
    this: Implementation,
    session: SessionContainerInterface,
    data: ProfileFormData,
    userContext?: Record<string, any>,
  ) {
    const userId = session.getUserId(userContext);

    const sections = this.getSections(session, userContext);
    const sectionsById = indexBy(sections, "id");
    const sectionIdToRegistratorIdMap = mapBy(sections, "id", (section) => section.registratorId);
    const dataBySectionId = groupBy(data, "sectionId");
    const dataByRegistratorId = groupBy(data, (row) => sectionIdToRegistratorIdMap[row.sectionId]);

    // validate the data
    const validationErrors = data.reduce(
      (acc, row) => {
        const field = sectionsById[row.sectionId]?.fields.find((f) => f.id === row.fieldId);
        if (!field) {
          return [
            ...acc,
            {
              id: row.fieldId,
              error: `Field with id "${row.fieldId}" not found`,
            },
          ];
        }

        const fieldError = this.validateField(session, field, row.value, userContext);
        if (fieldError) {
          const fieldErrors = Array.isArray(fieldError) ? fieldError : [fieldError];
          return [...acc, ...fieldErrors.map((error) => ({ id: field.id, error }))];
        }

        return acc;
      },
      [] as { id: string; error: string }[],
    );

    logDebugMessage(`Validated data. ${validationErrors.length} errors found.`);

    if (validationErrors.length > 0) {
      return { status: "INVALID_FIELDS", errors: validationErrors };
    }

    // store the data by registrator
    const updatedData: ProfileFormData = [];
    for (const [registratorId, sectionData] of Object.entries(dataByRegistratorId)) {
      if (!this.existingRegistratorHandlers[registratorId]) {
        logDebugMessage(`Registrator with id "${registratorId}" not found. Skipping storing data...`);
        continue;
      }

      logDebugMessage(`Storing data for registrator "${registratorId}". ${sectionData.length} fields to store.`);

      const registrator = this.existingRegistratorHandlers[registratorId];
      await registrator.set(sectionData, session, userContext);
      // get fresh data from the storage, since it could be updated from other places or updated partially
      const data = await registrator.get(session, userContext);
      updatedData.push(...data);
    }

    // check sections that are completed after updating the data
    const sectionsToUpdate = Object.keys(dataBySectionId)
      .map((sectionId) => sections.find((s) => s.id === sectionId))
      .filter((section) => section !== undefined);
    const sectionsCompleted: Record<string, boolean> = {};
    for (const section of sectionsToUpdate) {
      const sectionData = updatedData.filter((d) => d.sectionId === section.id);
      sectionsCompleted[section.id] = await this.isSectionCompleted(session, section, sectionData, userContext);
    }
    logDebugMessage(`Sections completed: ${JSON.stringify(sectionsCompleted)}`);

    // update the user metadata with the new sections completed status
    const userMetadata = await this.metadata.get(userId, userContext);
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
    await this.metadata.set(userId, newUserMetadata, userContext);

    // refresh the claim to make sure the frontend has the latest value
    // but only if all sections are completed
    const allSectionsCompleted = this.areAllSectionsCompleted(session, newUserMetadata?.profileConfig, userContext);
    if (allSectionsCompleted) {
      await session.fetchAndSetClaim(Implementation.ProgressiveProfilingCompletedClaim, userContext);
    }

    return { status: "OK" };
  };

  getSectionValues = async function (
    this: Implementation,
    session: SessionContainerInterface,
    userContext?: Record<string, any>,
  ) {
    const sections = this.getSections(session, userContext);
    const sectionsByRegistratorId = indexBy(sections, "registratorId");

    const data: ProfileFormData = [];
    for (const registratorId of Object.keys(sectionsByRegistratorId)) {
      const registrator = this.existingRegistratorHandlers[registratorId];
      if (!registrator) {
        continue;
      }

      const sectionData = await registrator.get(session, userContext);
      data.push(...sectionData);
    }

    return { status: "OK", data };
  };

  validateField = function (
    this: Implementation,
    session: SessionContainerInterface,
    field: FormField,
    value: FormFieldValue,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    userContext?: Record<string, any>,
  ): string | string[] | undefined {
    if (field.required && (value === undefined || (typeof value === "string" && value.trim() === ""))) {
      return `The "${field.label}" field is required`;
    }

    return undefined;
  };

  isSectionCompleted = async function (
    this: Implementation,
    session: SessionContainerInterface,
    section: FormSection,
    data: ProfileFormData,
    userContext?: Record<string, any>,
  ) {
    const valuesByFieldId = mapBy(data, "fieldId", (row) => row.value);
    return section.fields.every(
      (field) => this.validateField(session, field, valuesByFieldId[field.id], userContext) === undefined,
    );
  };

  areAllSectionsCompleted = function (
    this: Implementation,
    session: SessionContainerInterface,
    profileConfig?: UserMetadataConfig,
    userContext?: Record<string, any>,
  ) {
    return this.getSections(session, userContext).every(
      (section) => profileConfig?.sectionCompleted?.[section.id] ?? false,
    );
  };
}

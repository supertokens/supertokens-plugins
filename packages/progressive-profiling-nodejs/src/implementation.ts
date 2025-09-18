import { RegisterSections, FormSection, UserMetadataConfig } from "./types";
import { logDebugMessage } from "./logger";
import { FormField, FormFieldValue, ProfileFormData } from "@supertokens-plugins/progressive-profiling-shared";
import { SessionContainerInterface } from "supertokens-node/recipe/session/types";
import { BooleanClaim } from "supertokens-node/recipe/session/claims";
import { PLUGIN_ID, METADATA_KEY, METADATA_PROFILE_KEY } from "./constants";
import { pluginUserMetadata } from "@shared/nodejs";
import { groupBy, indexBy, mapBy } from "@shared/js";

export class Implementation {
  static instance: Implementation | undefined;

  protected existingSections: (FormSection & { storageHandlerId: string })[] = [];
  protected existingStorageHandlers: Record<string, Pick<Parameters<RegisterSections>[0], "set" | "get">> = {};
  protected metadata = pluginUserMetadata<{ profileConfig?: UserMetadataConfig }>(METADATA_KEY);

  static ProgressiveProfilingCompletedClaim: BooleanClaim;

  static init(): Implementation {
    if (Implementation.instance) {
      return Implementation.instance;
    }
    Implementation.instance = new Implementation();

    return Implementation.instance;
  }

  static getInstanceOrThrow(): Implementation {
    if (!Implementation.instance) {
      throw new Error("Implementation instance not found. Make sure you have initialized the plugin.");
    }

    return Implementation.instance;
  }

  static reset(): void {
    Implementation.instance = undefined;
  }

  constructor() {
    Implementation.ProgressiveProfilingCompletedClaim = new BooleanClaim({
      key: `${PLUGIN_ID}-completed`,
      fetchValue: async (userId) => {
        const implementation = Implementation.getInstanceOrThrow();
        const userMetadata = await implementation.metadata.get(userId);
        return implementation.existingSections.every(
          (section) => userMetadata?.profileConfig?.sectionsCompleted?.[section.id] ?? false,
        );
      },
    });
  }

  defaultStorageHandlerGetFields = async function (
    this: Implementation,
    pluginFormFields: (Pick<FormField, "id" | "defaultValue"> & { sectionId: string })[],
    session: SessionContainerInterface,
    userContext?: Record<string, any>,
  ): Promise<ProfileFormData> {
    const metadata = pluginUserMetadata<{ profile: Record<string, FormFieldValue> }>(METADATA_PROFILE_KEY);

    const userMetadata = await metadata.get(session.getUserId(userContext), userContext);
    const existingProfile = userMetadata?.profile || {};

    const data = pluginFormFields.map((field) => ({
      sectionId: field.sectionId,
      fieldId: field.id,
      value: existingProfile[field.id] ?? field.defaultValue,
    }));

    return data;
  };

  defaultStorageHandlerSetFields = async function (
    this: Implementation,
    pluginFormFields: (Pick<FormField, "id" | "defaultValue"> & { sectionId: string })[],
    formData: ProfileFormData,
    session: SessionContainerInterface,
    userContext?: Record<string, any>,
  ): Promise<void> {
    const metadata = pluginUserMetadata<{ profile: Record<string, FormFieldValue> }>(METADATA_PROFILE_KEY);

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
  };

  registerSections: RegisterSections = function (this: Implementation, { storageHandlerId, sections, set, get }) {
    const registrableSections = sections
      .filter((section) => {
        const existingSection = this.existingSections.find((s) => s.id === section.id);
        if (existingSection) {
          logDebugMessage(
            `Profile plugin section with id "${section.id}" already registered by "${existingSection.storageHandlerId}". Skipping...`,
          );
          return false;
        }

        if (!storageHandlerId) {
          logDebugMessage(`Profile plugin section with id "${section.id}" has no storage handler id. Skipping...`);
          return false;
        }

        return true;
      })
      .map((section) => ({
        ...section,
        storageHandlerId,
      }));

    this.existingSections.push(...registrableSections);
    this.existingStorageHandlers[storageHandlerId] = { set, get };
  };

  getAllSections = function (
    this: Implementation,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    session?: SessionContainerInterface,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    userContext?: Record<string, any>,
  ) {
    return this.existingSections;
  };

  getSessionUserSections = async function (
    this: Implementation,
    session: SessionContainerInterface,
    userContext?: Record<string, any>,
  ) {
    const userMetadata = await this.metadata.get(session.getUserId(userContext), userContext);

    // map the sections to a json serializable value
    const sections = this.getAllSections(session, userContext).map((section) => ({
      id: section.id,
      label: section.label,
      description: section.description,
      completed: userMetadata?.profileConfig?.sectionsCompleted?.[section.id] ?? false,
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

    const sections = this.getAllSections(session, userContext);
    const sectionsById = indexBy(sections, "id");
    const sectionIdToStorageHandlerIdMap = mapBy(sections, "id", (section) => section.storageHandlerId);
    const dataBySectionId = groupBy(data, "sectionId");
    const dataByStorageHandlerId = groupBy(data, (row) => sectionIdToStorageHandlerIdMap[row.sectionId]);

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

    // store the data by storage handler
    const updatedData: ProfileFormData = [];
    for (const [storageHandlerId, sectionData] of Object.entries(dataByStorageHandlerId)) {
      if (!this.existingStorageHandlers[storageHandlerId]) {
        logDebugMessage(`Storage handler with id "${storageHandlerId}" not found. Skipping storing data...`);
        continue;
      }

      logDebugMessage(`Storing data for storage handler "${storageHandlerId}". ${sectionData.length} fields to store.`);

      const storageHandler = this.existingStorageHandlers[storageHandlerId];
      await storageHandler.set(sectionData, session, userContext);
      // get fresh data from the storage, since it could be updated from other places or updated partially
      const data = await storageHandler.get(session, userContext);
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
        sectionsCompleted: {
          ...(userMetadata?.profileConfig?.sectionsCompleted ?? {}),
          ...sectionsCompleted,
        },
      },
    };
    await this.metadata.set(userId, newUserMetadata, userContext);

    // refresh the claim to make sure the frontend has the latest value
    // but only if all sections are completed
    const allSectionsCompleted = this.getAllSections(session, userContext).every(
      (section) => newUserMetadata?.profileConfig?.sectionsCompleted?.[section.id] ?? false,
    );
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
    const sections = this.getAllSections(session, userContext);
    const sectionsByStorageHandlerId = indexBy(sections, "storageHandlerId");

    const data: ProfileFormData = [];
    for (const storageHandlerId of Object.keys(sectionsByStorageHandlerId)) {
      const storageHandler = this.existingStorageHandlers[storageHandlerId];
      if (!storageHandler) {
        continue;
      }

      const sectionData = await storageHandler.get(session, userContext);
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
}

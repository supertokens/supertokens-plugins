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
import { PLUGIN_ID, METADATA_KEY } from "./constants";
import { pluginUserMetadata } from "@shared/nodejs";
import { groupBy, indexBy, mapBy } from "@shared/js";

export class ProgressiveProfilingService {
  protected existingSections: (FormSection & { registratorId: string })[] = [];
  protected existingRegistratorHandlers: Record<string, Pick<Parameters<RegisterSections>[0], "set" | "get">> = {};
  protected metadata = pluginUserMetadata<{ profileConfig?: UserMetadataConfig }>(METADATA_KEY);

  static ProgressiveProfilingCompletedClaim: BooleanClaim;

  static areAllSectionsCompleted = (sections: FormSection[], profileConfig?: UserMetadataConfig) => {
    return sections.every((section) => profileConfig?.sectionCompleted?.[section.id] ?? false);
  };

  constructor(protected pluginConfig: SuperTokensPluginProfileProgressiveProfilingNormalisedConfig) {
    ProgressiveProfilingService.ProgressiveProfilingCompletedClaim = new BooleanClaim({
      key: `${PLUGIN_ID}-completed`,
      fetchValue: async (userId) => {
        const userMetadata = await this.metadata.get(userId);
        return ProgressiveProfilingService.areAllSectionsCompleted(this.getSections(), userMetadata?.profileConfig);
      },
    });
  }

  registerSections: RegisterSections = function (
    this: ProgressiveProfilingService,
    { registratorId, sections, set, get },
  ) {
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

  getSections = function (this: ProgressiveProfilingService) {
    return this.existingSections;
  };

  setSectionValues = async function (
    this: ProgressiveProfilingService,
    session: SessionContainerInterface,
    data: ProfileFormData,
    userContext?: Record<string, any>,
  ) {
    const userId = session.getUserId();
    if (!userId) {
      throw new Error("User not found");
    }

    const sections = this.getSections();
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

        const fieldError = this.validateField(field, row.value, userContext);
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
      sectionsCompleted[section.id] = await this.isSectionCompleted(section, sectionData, userContext);
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
    const allSectionsCompleted = ProgressiveProfilingService.areAllSectionsCompleted(
      this.getSections(),
      newUserMetadata?.profileConfig,
    );
    if (allSectionsCompleted) {
      await session.fetchAndSetClaim(ProgressiveProfilingService.ProgressiveProfilingCompletedClaim, userContext);
    }

    return { status: "OK" };
  };

  getSectionValues = async function (
    this: ProgressiveProfilingService,
    session: SessionContainerInterface,
    userContext?: Record<string, any>,
  ) {
    const userId = session.getUserId();
    if (!userId) {
      throw new Error("User not found");
    }

    const sections = this.getSections();

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

    return data;
  };

  validateField = function (
    this: ProgressiveProfilingService,
    field: FormField,
    value: FormFieldValue,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    userContext?: Record<string, any>, // might be needed for overrides so we have to have the param until we use interfaces
  ): string | string[] | undefined {
    if (field.required && (value === undefined || (typeof value === "string" && value.trim() === ""))) {
      return `The "${field.label}" field is required`;
    }

    return undefined;
  };

  isSectionCompleted = async function (
    this: ProgressiveProfilingService,
    section: FormSection,
    data: ProfileFormData,
    userContext?: Record<string, any>,
  ) {
    const valuesByFieldId = mapBy(data, "fieldId", (row) => row.value);
    return section.fields.every(
      (field) => this.validateField(field, valuesByFieldId[field.id], userContext) === undefined,
    );
  };
}

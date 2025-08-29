import {
  RegisterSection,
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
  protected existingRegistratorHandlers: Record<string, Pick<Parameters<RegisterSection>[0], "set" | "get">> = {};
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

  registerSection: RegisterSection = function (
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
  ) {
    const userId = session.getUserId();
    if (!userId) {
      throw new Error("User not found");
    }

    const sections = this.getSections();

    const sectionsById = indexBy(sections, "id");
    const dataBySectionId = groupBy(data, "sectionId");
    const dataByRegistratorId = groupBy(data, (row) => sectionIdToRegistratorIdMap[row.sectionId]);
    const sectionIdToRegistratorIdMap = mapBy(sections, "id", (section) => section.registratorId);

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

      const fieldError = this.validateField(field, row.value);

      if (fieldError) {
        validationErrors.push({ id: field.id, error: fieldError });
      }
    }

    if (validationErrors.length > 0) {
      return { status: "INVALID_FIELDS", errors: validationErrors };
    }

    const updatedData: ProfileFormData = [];
    for (const registratorId of Object.keys(dataByRegistratorId)) {
      const sectionHandlers = this.existingRegistratorHandlers[registratorId];
      if (!sectionHandlers) {
        continue;
      }
      const sectionData = dataByRegistratorId[registratorId];
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
      sectionsCompleted[section.id] = await this.isSectionCompleted(
        section,
        updatedData.filter((d) => d.sectionId === section.id),
      );
    }

    const userMetadata = await this.metadata.get(userId);
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
    await this.metadata.set(userId, newUserMetadata);

    // refresh the claim to make sure the frontend has the latest value
    // but only if all sections are completed
    const allSectionsCompleted = ProgressiveProfilingService.areAllSectionsCompleted(
      this.getSections(),
      newUserMetadata?.profileConfig,
    );
    if (allSectionsCompleted) {
      await session.fetchAndSetClaim(ProgressiveProfilingService.ProgressiveProfilingCompletedClaim);
    }

    return { status: "OK" };
  };

  getSectionValues = async function (this: ProgressiveProfilingService, session: SessionContainerInterface) {
    const userId = session.getUserId();
    if (!userId) {
      throw new Error("User not found");
    }

    const sections = this.getSections();

    const sectionsByRegistratorId = indexBy(sections, "registratorId");

    const data: ProfileFormData = [];
    for (const registratorId of Object.keys(sectionsByRegistratorId)) {
      const sectionHandlers = this.existingRegistratorHandlers[registratorId];
      if (!sectionHandlers) {
        continue;
      }

      const sectionData = await sectionHandlers.get(session);
      data.push(...sectionData);
    }

    return data;
  };

  validateField = function (
    this: ProgressiveProfilingService,
    field: FormField,
    value: FormFieldValue,
  ): string | undefined {
    if (field.required && (value === undefined || (typeof value === "string" && value.trim() === ""))) {
      return `The "${field.label}" field is required`;
    }

    return undefined;
  };

  isSectionCompleted = async function (this: ProgressiveProfilingService, section: FormSection, data: ProfileFormData) {
    const valuesByFieldId = mapBy(data, "fieldId", (row) => row.value);
    return section.fields.every((field) => this.validateField(field, valuesByFieldId[field.id]) === undefined);
  };
}

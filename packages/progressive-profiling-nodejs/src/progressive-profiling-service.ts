import {
  RegisterSection,
  FormSection,
  SuperTokensPluginProfileProgressiveProfilingNormalisedConfig,
  UserMetadataConfig,
} from "./types";
import { logDebugMessage } from "./logger";
import { ProfileFormData } from "@supertokens-plugins/progressive-profiling-shared";
import { SessionContainerInterface } from "supertokens-node/recipe/session/types";
import { BooleanClaim } from "supertokens-node/recipe/session/claims";
import { PLUGIN_ID, METADATA_KEY } from "./constants";
import { pluginUserMetadata } from "@shared/nodejs";

export class ProgressiveProfilingService {
  protected existingSections: (FormSection & { registratorId: string })[] = [];
  protected existingRegistratorHandlers: Record<string, Pick<Parameters<RegisterSection>[0], "set" | "get">> = {};
  protected metadata = pluginUserMetadata<{ profileConfig?: UserMetadataConfig }>(METADATA_KEY);

  static ProgressiveProfilingCompletedClaim: BooleanClaim;

  static isSectionCompleted = function (section: FormSection, data: ProfileFormData) {
    return section.fields.reduce((acc, field) => {
      const value = data.find((d) => d.fieldId === field.id)?.value;
      if (field.required && value === undefined) {
        return acc && false;
      }

      return acc && true;
    }, true);
  };

  static areAllSectionsCompleted = function (sections: FormSection[], profileConfig?: UserMetadataConfig) {
    return sections.reduce((acc, section) => {
      return acc && (profileConfig?.sectionCompleted?.[section.id] ?? false);
    }, true);
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

    const sectionIdToRegistratorIdMap = sections.reduce(
      (acc, section) => {
        return { ...acc, [section.id]: section.registratorId };
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

    const dataByRegistratorId = data.reduce(
      (acc, row) => {
        const registratorId = sectionIdToRegistratorIdMap[row.sectionId];
        if (registratorId) {
          return { ...acc, [registratorId]: [...(acc[registratorId] ?? []), row] };
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
      sectionsCompleted[section.id] = ProgressiveProfilingService.isSectionCompleted(
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

    const sectionsByRegistratorId = sections.reduce(
      (acc, section) => {
        return { ...acc, [section.registratorId]: section };
      },
      {} as Record<string, FormSection>,
    );

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
}

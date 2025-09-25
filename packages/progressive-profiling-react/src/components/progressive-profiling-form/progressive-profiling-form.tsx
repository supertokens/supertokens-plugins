import { groupBy } from "@shared/js";
import { Button, FormInput, FormFieldValue, Card, usePrettyAction } from "@shared/ui";
import { FormSection, ProfileFormData } from "@supertokens-plugins/progressive-profiling-shared";
import classNames from "classnames/bind";
import { useCallback, useEffect, useMemo, useState } from "react";

import { usePluginContext } from "../../plugin";
import { FormInputComponentMap } from "../../types";
import Session from "supertokens-auth-react/recipe/session";

import styles from "./progressive-profiling-form.module.css";

const cx = classNames.bind(styles);

interface ProgressiveProfilingFormProps {
  sections: FormSection[];
  data: ProfileFormData;
  onSubmit: (
    data: ProfileFormData,
  ) => Promise<
    | { status: "OK" }
    | { status: "ERROR"; message: string }
    | { status: "INVALID_FIELDS"; errors: { id: string; error: string }[] }
  >;
  onSuccess: (data: ProfileFormData) => Promise<void> | void;
  isLoading: boolean;
  loadProfile: () => Promise<{ status: "OK"; data: ProfileFormData } | { status: "ERROR"; message: string }>;
  loadSections: () => Promise<{ status: "OK"; data: FormSection[] } | { status: "ERROR"; message: string }>;
  componentMap: FormInputComponentMap;
}

export const ProgressiveProfilingForm = ({
  data,
  onSubmit,
  onSuccess,
  isLoading,
  sections: formSections,
  loadProfile,
  loadSections,
  ...props
}: ProgressiveProfilingFormProps) => {
  const { t, pluginConfig, ProgressiveProfilingCompletedClaim } = usePluginContext();
  const [fieldErrors, setFieldErrors] = useState<Record<string, { id: string; error: string }[]>>({});

  const sections = useMemo(() => {
    return [
      ...(pluginConfig.showStartSection
        ? [
            {
              id: "profile-start",
              label: t("PL_PP_SECTION_PROFILE_START_LABEL"),
              description: t("PL_PP_SECTION_PROFILE_START_DESCRIPTION", {
                steps: (formSections.length + 2).toString(),
              }),
              completed: false,
              fields: [],
            },
          ]
        : []),
      ...formSections,
      ...(pluginConfig.showEndSection
        ? [
            {
              id: "profile-end",
              label: t("PL_PP_SECTION_PROFILE_END_LABEL"),
              description: t("PL_PP_SECTION_PROFILE_END_DESCRIPTION"),
              completed: false,
              fields: [],
            },
          ]
        : []),
    ];
  }, [formSections, pluginConfig.showStartSection, pluginConfig.showEndSection]);

  const startingSectionIndex = useMemo(() => {
    const completedSectionIndexes = formSections
      .map((section, index) => (section.completed ? index : null))
      .filter((index) => index !== null);

    // if no sections are completed, or all of them are completed, return the first section
    if (!completedSectionIndexes.length || completedSectionIndexes.length === formSections.length) {
      return 0;
    }

    // the index of the first not completed section (the user hasn't completed all the sections)
    const nextFormSectionIndex = completedSectionIndexes[completedSectionIndexes.length - 1]! + 1;
    return nextFormSectionIndex + (pluginConfig.showStartSection ? 1 : 0); // account for the start section
  }, [formSections, pluginConfig.showStartSection]);

  const [activeSectionIndex, setActiveSectionIndex] = useState(startingSectionIndex);
  const [profileDetails, setProfileDetails] = useState<Record<string, FormFieldValue>>({});

  const currentSection = sections[activeSectionIndex];
  const isLastSection = activeSectionIndex === sections.length - 1;
  const isFirstSection = activeSectionIndex === 0;

  const moveToSection = useCallback(
    (sectionIndex: number) => {
      if (sectionIndex < 0) {
        return;
      }
      if (sectionIndex >= sections.length) {
        return;
      }

      setActiveSectionIndex(sectionIndex);
    },
    [sections],
  );

  const isSectionEnabled = useCallback(
    (sectionIndex: number) => {
      // first section is always enabled
      if (sectionIndex === 0 && pluginConfig.showStartSection) {
        return true;
      }

      // active section is always enabled
      if (sectionIndex === activeSectionIndex) {
        return true;
      }

      // last section is enabled if all form sections are completed
      if (sectionIndex === sections.length - 1 && pluginConfig.showEndSection) {
        return formSections.every((section) => section.completed);
      }

      // other sections are enabled if they are completed
      return sections[sectionIndex]?.completed ?? false;
    },
    [sections, activeSectionIndex, formSections, pluginConfig],
  );

  const handleSubmit = usePrettyAction(async () => {
    setFieldErrors({});

    if (!currentSection) {
      return;
    }

    if (currentSection.id === "profile-start") {
      moveToSection(activeSectionIndex + 1);
      return;
    }

    if (currentSection.id !== "profile-end") {
      // only send the current section fields
      const sectionData = currentSection.fields.map((field) => {
        return { sectionId: currentSection.id, fieldId: field.id, value: profileDetails[field.id] };
      });
      const result = await onSubmit(sectionData);
      if (result.status === "INVALID_FIELDS") {
        setFieldErrors(groupBy(result.errors, "id"));
        throw new Error("Some fields are invalid");
      } else if (result.status === "OK") {
        if (!isLastSection) {
          moveToSection(activeSectionIndex + 1);
          // load the sections to get the updated section states (it's fine to be deferred)
          void loadSections();
          return;
        }
      } else {
        throw new Error("Could not save the details");
      }
    }

    if (currentSection.id === "profile-end" || isLastSection) {
      const claimValidationErrors = await Session.validateClaims({
        overrideGlobalClaimValidators: () => [ProgressiveProfilingCompletedClaim.validators.isTrue()],
      });
      const isComplete = claimValidationErrors.length === 0;
      if (isComplete) {
        const data: ProfileFormData = Object.entries(profileDetails).map(([key, value]) => {
          const sectionId = sections.find((section) => section.fields.some((field) => field.id === key))?.id;
          if (!sectionId) {
            throw new Error(`Section not found for field ${key}`);
          }
          return { sectionId, fieldId: key, value: value };
        });

        await onSuccess(data);
        return;
      } else {
        throw new Error("All sections must be completed to submit the form");
      }
    }
  }, [
    onSuccess,
    onSubmit,
    loadSections,
    moveToSection,
    activeSectionIndex,
    profileDetails,
    currentSection,
    isLastSection,
  ]);

  const handleInputChange = useCallback((field: string, value: any) => {
    setProfileDetails((prev) => ({
      ...prev,
      [field]: value,
    }));
  }, []);

  useEffect(() => {
    setProfileDetails(
      data.reduce(
        (acc, item) => {
          acc[item.fieldId] = item.value;
          return acc;
        },
        {} as Record<string, FormFieldValue>,
      ),
    );
  }, [data]);

  if (!formSections?.length) {
    return <Card description={t("PL_PP_NO_SECTIONS")} />;
  }

  if (!currentSection) {
    return <Card description={t("PL_PP_PROFILE_SETUP_NOT_AVAILABLE")} />;
  }

  return (
    <div className={cx("progressive-profiling-form")}>
      <div className={cx("progressive-profiling-form-bullets")}>
        {sections.map((section, index) => {
          const isEnabled = isSectionEnabled(index);
          return (
            <div
              key={section.id}
              className={cx("progressive-profiling-form-bullet", {
                active: index === activeSectionIndex,
                disabled: !isEnabled,
              })}
              aria-disabled={!isEnabled}
              onClick={() => isEnabled && moveToSection(index)}>
              {index + 1}
            </div>
          );
        })}
      </div>

      <Card title={currentSection.label} description={currentSection.description}>
        <form className={cx("progressive-profiling-form-form")}>
          {isLoading && <div className={cx("progressive-profiling-form-loading")}>{t("PL_PP_LOADING")}</div>}

          {currentSection.fields.map((field) => (
            <FormInput
              key={field.id}
              value={profileDetails[field.id]}
              onChange={(value) => handleInputChange(field.id, value)}
              componentMap={props.componentMap}
              error={fieldErrors[field.id]?.map((error) => error.error).join("\n")}
              {...field}
            />
          ))}

          <Button variant="brand" onClick={handleSubmit}>
            {isFirstSection && t("PL_PP_SECTION_NEXT_BUTTON")}
            {isLastSection && t("PL_PP_SECTION_COMPLETE_BUTTON")}
            {!isFirstSection && !isLastSection && t("PL_PP_SECTION_SAVE_AND_NEXT_BUTTON")}
          </Button>
        </form>
      </Card>
    </div>
  );
};

import { Button, FormInput, FormFieldValue, Card } from "@shared/ui";
import { FormSection, ProfileFormData } from "@supertokens-plugins/progressive-profiling-shared";
import classNames from "classnames/bind";
import { useCallback, useEffect, useMemo, useState } from "react";

import { usePluginContext } from "../../plugin";
import { FormInputComponentMap } from "../../types";

import styles from "./progressive-profiling-form.module.css";

const cx = classNames.bind(styles);

interface ProgressiveProfilingFormProps {
  sections: FormSection[];
  data: ProfileFormData;
  onSubmit: (data: ProfileFormData) => Promise<{ status: "OK" } | { status: "ERROR"; message: string }>;
  onSuccess: (data: ProfileFormData) => Promise<void>;
  isLoading: boolean;
  fetchFormData: () => Promise<{ status: "OK"; data: ProfileFormData } | { status: "ERROR"; message: string }>;
  componentMap: FormInputComponentMap;
}

export const ProgressiveProfilingForm = ({
  data,
  onSubmit,
  onSuccess,
  isLoading,
  ...props
}: ProgressiveProfilingFormProps) => {
  const { t } = usePluginContext();

  const sections = useMemo(() => {
    return [
      {
        id: "profile-start",
        label: t("PL_PP_SECTION_PROFILE_START_LABEL"),
        description: t("PL_PP_SECTION_PROFILE_START_DESCRIPTION", { steps: (props.sections.length + 2).toString() }),
        completed: false,
        fields: [],
      },
      ...props.sections,
      {
        id: "profile-end",
        label: t("PL_PP_SECTION_PROFILE_END_LABEL"),
        description: t("PL_PP_SECTION_PROFILE_END_DESCRIPTION"),
        completed: false,
        fields: [],
      },
    ];
  }, [props.sections]);

  const startingSectionIndex = useMemo(() => {
    const notCompletedSectionIndexes = sections
      .map((section, index) => (section.completed ? index : null))
      .filter((index) => index !== null);

    // if no sections are completed, or all of them are completed, return the first section
    if (notCompletedSectionIndexes.length === 2 || notCompletedSectionIndexes.length === sections.length) {
      return 0;
    }

    // otherwise return the index of the first not completed section - it means the user hasn't completed all thsection
    return notCompletedSectionIndexes[1] || 0; // return the first section index as a default
  }, [sections]);

  const [activeSectionIndex, setActiveSectionIndex] = useState(startingSectionIndex);
  const [profileDetails, setProfileDetails] = useState<Record<string, FormFieldValue>>({});

  const isLastSection = activeSectionIndex === sections.length - 1;

  const currentSection = useMemo(() => {
    if (activeSectionIndex === -1) {
      return null;
    }

    return sections[activeSectionIndex];
  }, [sections, activeSectionIndex]);

  const moveToNextSection = useCallback(
    (currentSectionIndex: number) => {
      if (currentSectionIndex === -1) {
        return;
      }
      if (currentSectionIndex === sections.length - 1) {
        return;
      }

      setActiveSectionIndex(currentSectionIndex + 1);
    },
    [sections],
  );

  const moveToSection = useCallback(
    (sectionIndex: number) => {
      if (sectionIndex < 0) {
        return;
      }
      if (sectionIndex >= sections.length) {
        return;
      }
      if (!isSectionEnabled(sectionIndex)) {
        return;
      }

      setActiveSectionIndex(sectionIndex);
    },
    [sections],
  );

  const moveToNextSectionEnabled = useMemo(() => {
    const isComplete = sections.slice(1, -1).every((section) => section.completed);
    return (isComplete && activeSectionIndex === sections.length - 1) || activeSectionIndex < sections.length - 1;
  }, [activeSectionIndex, sections]);

  const moveToNextSectionLabel = useMemo(() => {
    if (activeSectionIndex === 0) {
      return t("PL_PP_SECTION_NEXT_BUTTON");
    }
    if (activeSectionIndex === sections.length - 1) {
      return t("PL_PP_SECTION_COMPLETE_BUTTON");
    }
    return t("PL_PP_SECTION_SAVE_AND_NEXT_BUTTON");
  }, [sections, activeSectionIndex]);

  const isSectionEnabled = useCallback(
    (sectionIndex: number) => {
      if (sectionIndex === 0) {
        return true;
      }

      if (sectionIndex === sections.length - 1) {
        return sections.slice(1, -1).every((section) => section.completed);
      }

      return sections[sectionIndex]?.completed ?? false;
    },
    [sections],
  );

  const handleSubmit = useCallback(async () => {
    if (!currentSection) {
      return;
    }

    if (currentSection.id === "profile-start") {
      moveToNextSection(activeSectionIndex);
      return;
    }

    const data: ProfileFormData = Object.entries(profileDetails).map(([key, value]) => {
      return { sectionId: currentSection.id, fieldId: key, value: value };
    });

    const result = await onSubmit(data);
    if (result.status === "ERROR") {
      console.error(result);
    } else if (isLastSection && result.status === "OK") {
      await onSuccess(data);
    } else {
      moveToNextSection(activeSectionIndex);
    }
  }, [currentSection, isLastSection, onSubmit, onSuccess, moveToNextSection, activeSectionIndex, profileDetails]);

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

  if (isLoading) {
    return <Card description={t("PL_PP_LOADING")} />;
  }

  if (!currentSection) {
    return <Card description={t("PL_PP_PROFILE_SETUP_NOT_AVAILABLE")} />;
  }

  return (
    <div>
      <div className={cx("progressive-profiling-form-bullets")}>
        {sections.map((section, index) => (
          <div
            key={section.id}
            className={cx("progressive-profiling-form-bullet", {
              active: index === activeSectionIndex,
              disabled: !isSectionEnabled(index),
            })}
            onClick={() => moveToSection(index)}>
            {index + 1}
          </div>
        ))}
      </div>

      <Card title={currentSection.label} description={currentSection.description}>
        <form className={cx("progressive-profiling-form-form")}>
          {currentSection.fields.map((field) => (
            <FormInput
              key={field.id}
              value={profileDetails[field.id]}
              onChange={(value) => handleInputChange(field.id, value)}
              componentMap={props.componentMap}
              {...field}
            />
          ))}

          <Button variant="brand" onClick={handleSubmit} disabled={!moveToNextSectionEnabled}>
            {moveToNextSectionLabel}
          </Button>
        </form>
      </Card>
    </div>
  );
};

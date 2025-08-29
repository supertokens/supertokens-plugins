import { groupBy } from "@shared/js";
import { Button, FormInput, FormFieldValue, Card, usePrettyAction, useToast } from "@shared/ui";
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
  onSubmit: (
    data: ProfileFormData,
  ) => Promise<
    | { status: "OK" }
    | { status: "ERROR"; message: string }
    | { status: "INVALID_FIELDS"; errors: { id: string; error: string }[] }
  >;
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
  sections: formSections,
  ...props
}: ProgressiveProfilingFormProps) => {
  const { t } = usePluginContext();
  const [fieldErrors, setFieldErrors] = useState<Record<string, { id: string; error: string }[]>>({});

  const sections = useMemo(() => {
    return [
      {
        id: "profile-start",
        label: t("PL_PP_SECTION_PROFILE_START_LABEL"),
        description: t("PL_PP_SECTION_PROFILE_START_DESCRIPTION", { steps: (formSections.length + 2).toString() }),
        completed: false,
        fields: [],
      },
      ...formSections,
      {
        id: "profile-end",
        label: t("PL_PP_SECTION_PROFILE_END_LABEL"),
        description: t("PL_PP_SECTION_PROFILE_END_DESCRIPTION"),
        completed: false,
        fields: [],
      },
    ];
  }, [formSections]);

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

  const moveToNextSection = useCallback(
    (currentSectionIndex: number) => {
      moveToSection(currentSectionIndex + 1);
    },
    [moveToSection],
  );

  const isSectionEnabled = useCallback(
    (sectionIndex: number) => {
      // first section is always enabled
      if (sectionIndex === 0) {
        return true;
      }

      // active section is always enabled
      if (sectionIndex === activeSectionIndex) {
        return true;
      }

      // last section is enabled if all form sections are completed
      if (sectionIndex === sections.length - 1) {
        return formSections.every((section) => section.completed);
      }

      // other sections are enabled if they are completed
      return sections[sectionIndex]?.completed ?? false;
    },
    [sections, activeSectionIndex, formSections],
  );

  const handleSubmit = usePrettyAction(async () => {
    setFieldErrors({});

    if (!currentSection) {
      return;
    }

    if (currentSection.id === "profile-start") {
      moveToNextSection(activeSectionIndex);
      return;
    }

    if (currentSection.id === "profile-end") {
      const isComplete = formSections.every((section) => section.completed);
      if (isComplete) {
        const data: ProfileFormData = Object.entries(profileDetails).map(([key, value]) => {
          return { sectionId: currentSection.id, fieldId: key, value: value };
        });
        await onSuccess(data);
      } else {
        throw new Error("All sections must be completed to submit the form");
      }
    }

    // only send the current section fields
    const sectionData = currentSection.fields.map((field) => {
      return { sectionId: currentSection.id, fieldId: field.id, value: profileDetails[field.id] };
    });

    const result = await onSubmit(sectionData);
    if (result.status === "INVALID_FIELDS") {
      setFieldErrors(groupBy(result.errors, "id"));
      throw new Error("Some fields are invalid");
    } else if (result.status === "OK") {
      moveToNextSection(activeSectionIndex);
    } else {
      throw new Error("Could not submit the data");
    }
  }, [onSuccess, moveToNextSection, activeSectionIndex, profileDetails, currentSection]);

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

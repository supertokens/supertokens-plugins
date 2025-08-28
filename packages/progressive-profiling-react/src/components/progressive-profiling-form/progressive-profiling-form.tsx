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
        completed: true,
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
    const index = sections.findIndex((section) => !section.completed);
    return index === -1 ? 0 : index;
  }, [sections]);

  const [activeSectionIndex, setActiveSectionIndex] = useState(startingSectionIndex);
  const [editingProfileDetails, setEditingProfileDetails] = useState<Record<string, FormFieldValue>>({});

  const isComplete = useMemo(() => {
    return sections.every((section) => section.completed);
  }, [sections]);

  const isLastSection = useMemo(() => {
    return activeSectionIndex === sections.length - 1;
  }, [activeSectionIndex, sections]);

  const currentSection = useMemo(() => {
    if (activeSectionIndex === -1) {
      return null;
    }

    return sections[activeSectionIndex];
  }, [sections, activeSectionIndex]);

  useEffect(() => {
    setEditingProfileDetails(
      data.reduce(
        (acc, item) => {
          acc[item.fieldId] = item.value;
          return acc;
        },
        {} as Record<string, FormFieldValue>,
      ),
    );
  }, [data]);

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
    return (isComplete && activeSectionIndex === sections.length - 1) || activeSectionIndex < sections.length - 1;
  }, [isComplete, activeSectionIndex, sections]);

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
      const section = sections[sectionIndex - 1];
      if (!section) {
        return true;
      } // the first section is always enabled

      return section.completed;
    },
    [sections],
  );

  const handleSubmit = useCallback(async () => {
    if (!currentSection) {
      return;
    }

    const data: ProfileFormData = Object.entries(editingProfileDetails).map(([key, value]) => {
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
  }, [
    currentSection,
    isLastSection,
    onSubmit,
    onSuccess,
    moveToNextSection,
    activeSectionIndex,
    editingProfileDetails,
  ]);

  const handleInputChange = useCallback(
    (field: string, value: any) => {
      setEditingProfileDetails({
        ...editingProfileDetails,
        [field]: value,
      });
    },
    [editingProfileDetails],
  );

  useEffect(() => {
    if (isComplete) {
      onSuccess(data);
    }
  }, []);

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
              value={editingProfileDetails[field.id]}
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

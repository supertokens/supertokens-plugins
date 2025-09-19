import { Button, useHashParam } from "@shared/ui";
import classNames from "classnames/bind";
import React, { useCallback, useMemo, useState } from "react";

import style from "./profile-sections.module.css";

const cx = classNames.bind(style);

export const ProfileSections = ({
  sections,
}: {
  sections: {
    id: string;
    title: string | React.JSX.Element;
    component: () => React.JSX.Element;
  }[];
}) => {
  const hashParam = useHashParam();

  const [activeIndex, setActiveIndex] = useState(() => {
    const sectionId = hashParam.get();

    if (!sectionId) {
      return 0;
    }

    const sectionIndex = sections.findIndex((section) => section.id === sectionId);
    return sectionIndex >= 0 ? sectionIndex : 0;
  });

  const changeSection = useCallback(
    (index: number) => {
      if (!sections?.[index]?.id) {
        return;
      }
      if (activeIndex === index) {
        return;
      }

      setActiveIndex(index);

      hashParam.set(sections[index].id);
    },
    [activeIndex, sections],
  );

  const ActiveSectionComponent = useMemo(
    () => sections[activeIndex]?.component || (() => null),
    [sections, activeIndex],
  );

  return (
    <div className={cx("profile-sections")}>
      <div className={cx("profile-sidebar")}>
        {sections.map((section, idx) => (
          <Button
            key={section.id}
            className={cx("profile-sidebar-item")}
            variant={activeIndex === idx ? "brand" : "neutral"}
            appearance={activeIndex === idx ? "filled" : "plain"}
            onClick={() => changeSection(idx)}>
            {section.title}
          </Button>
        ))}
      </div>

      <div className={cx("profile-divider")} />

      <div className={cx("profile-content")}>
        <ActiveSectionComponent />
      </div>
    </div>
  );
};

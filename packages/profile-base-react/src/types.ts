import React from "react";

export type SuperTokensPluginProfileConfig = {
  profilePagePath?: string;
  sections?: SuperTokensPluginProfileSection[];
};

export type SuperTokensPluginProfileNormalisedConfig = Required<SuperTokensPluginProfileConfig>;

export type SuperTokensPluginProfileSection = {
  id: string;
  title: string;
  // this is needed to allow controlling the order of the sections, because in some cases the registration order is not the same as the order of the sections because of async initializations
  order: number;
  icon?: () => React.JSX.Element;
  component: () => React.JSX.Element;
};

export type Section = Omit<SuperTokensPluginProfileSection, "order"> & {
  order?: number;
};
export type RegisterSection = (sectionBuilder: () => Promise<Section | Section[]>) => void;

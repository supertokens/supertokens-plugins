/* eslint-disable react/jsx-no-literals */
import { ProfileSections } from "./profile-sections";

import type { Meta, StoryObj } from "@storybook/react";

// More on how to set up stories at: https://storybook.js.org/docs/writing-stories#default-export
const meta = {
  title: "ProfileBase/ProfileSections",
  component: ProfileSections,
  parameters: {
    // Optional parameter to center the component in the Canvas. More info: https://storybook.js.org/docs/configure/story-layout
    layout: "centered",
  },
  // More on argTypes: https://storybook.js.org/docs/api/argtypes
  argTypes: {},
} satisfies Meta<typeof ProfileSections>;

export default meta;
type Story = StoryObj<typeof meta>;

// More on writing stories with args: https://storybook.js.org/docs/writing-stories/args
export const WithoutSections: Story = {
  args: {
    sections: [],
  },
};

export const WithSections: Story = {
  args: {
    sections: [
      {
        id: "section1",
        title: "Section 1",
        component: () => <div>Section 1</div>,
      },
      {
        id: "section2",
        title: "Section 1",
        component: () => <div>Section 1</div>,
      },
    ],
  },
};

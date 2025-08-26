import type { Meta, StoryObj } from "@storybook/react";
import { Tag } from "./tag";
import { ThemeProvider } from "../theme-provider/theme-provider";

const meta: Meta<typeof Tag> = {
  component: Tag,
  title: "Component/Tag",
  parameters: {
    layout: "centered",
  },
  decorators: [
    (Story) => (
      <ThemeProvider>
        <Story />
      </ThemeProvider>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof Tag>;

export const Default: Story = {
  args: {
    children: "Tag",
  },
};

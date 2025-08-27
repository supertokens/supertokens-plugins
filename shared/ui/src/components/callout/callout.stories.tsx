import type { Meta, StoryObj } from "@storybook/react";
import { ThemeProvider } from "../theme-provider/theme-provider";
import { Callout } from "./callout";

const meta: Meta<typeof Callout> = {
  component: Callout,
  title: "Component/Callout",
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
type Story = StoryObj<typeof Callout>;

export const Default: Story = {
  args: {
    children: "This is a callout!",
  },
};

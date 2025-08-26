import type { Meta, StoryObj } from "@storybook/react";
import { Button } from "./button";
import { ThemeProvider } from "../theme-provider/theme-provider";

const meta: Meta<typeof Button> = {
  component: Button,
  title: "Component/Button",
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
type Story = StoryObj<typeof Button>;

export const Default: Story = {
  args: {
    children: "Button",
  },
};

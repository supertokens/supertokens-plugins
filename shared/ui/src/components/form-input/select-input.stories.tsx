import type { Meta, StoryObj } from "@storybook/react";
import { SelectInput } from "./select-input";
import { ThemeProvider } from "../theme-provider/theme-provider";

const meta: Meta<typeof SelectInput> = {
  component: SelectInput,
  title: "Component/Input/Select",
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
type Story = StoryObj<typeof SelectInput>;

export const Default: Story = {
  args: {
    label: "Example label",
    options: [
      { label: "Option 1", value: "1" },
      { label: "Option 2", value: "2" },
      { label: "Option 3", value: "3" },
    ],
  },
};

export const WithError: Story = {
  args: {
    label: "Example label",
    error: "This is an error",
    options: [
      { label: "Option 1", value: "1" },
      { label: "Option 2", value: "2" },
      { label: "Option 3", value: "3" },
    ],
  },
};

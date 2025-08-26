import type { Meta, StoryObj } from "@storybook/react";
import { ThemeProvider } from "../theme-provider/theme-provider";
import { TextInput } from "./text-input";

const meta: Meta<typeof TextInput> = {
  component: TextInput,
  title: "Component/Input/Text",
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
type Story = StoryObj<typeof TextInput>;

export const Default: Story = {
  args: {
    label: "Example label",
  },
};

export const WithError: Story = {
  args: {
    label: "Example label",
    error: "This is an error",
  },
};

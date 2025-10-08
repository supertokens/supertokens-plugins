import type { Meta, StoryObj } from "@storybook/react";
import { TabGroup } from "./tab-group";
import { Tab } from "./tab";
import { TabPanel } from "./tab-panel";
import { ThemeProvider } from "../theme-provider/theme-provider";

const meta: Meta<typeof TabGroup> = {
  component: TabGroup,
  title: "Component/TabGroup",
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
type Story = StoryObj<typeof TabGroup>;

export const Default: Story = {
  args: {
    active: "general",
    placement: "top",
    activation: "auto",
    size: "medium",
    noScrollControls: true,
  },
  render: (args) => (
    <TabGroup {...args}>
      <Tab panel="general">General</Tab>
      <Tab panel="billing">Billing</Tab>
      <Tab panel="security">Security</Tab>

      <TabPanel name="general" active>
        General content goes here.
      </TabPanel>
      <TabPanel name="billing">Billing content goes here.</TabPanel>
      <TabPanel name="security">Security content goes here.</TabPanel>
    </TabGroup>
  ),
};

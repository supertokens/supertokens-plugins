import type { Meta, StoryObj } from "@storybook/react";
import { Card } from "./card";
import { ThemeProvider } from "../theme-provider/theme-provider";

const meta: Meta<typeof Card> = {
  component: Card,
  title: "Component/Card",
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
type Story = StoryObj<typeof Card>;

export const Default: Story = {
  args: {
    children: "The lazy dog jumps over the quick brown fox.",
  },
};

export const WithHeader: Story = {
  args: {
    children: (
      <>
        <div slot="header">Title</div>
        The lazy dog jumps over the quick brown fox.
      </>
    ),
  },
};

export const WithFooter: Story = {
  args: {
    children: (
      <>
        The lazy dog jumps over the quick brown fox.
        <div slot="footer">Footer</div>
      </>
    ),
  },
};

export const WithHeaderAndFooter: Story = {
  args: {
    children: (
      <>
        <div slot="header">Title</div>
        The lazy dog jumps over the quick brown fox.
        <div slot="footer">Footer</div>
      </>
    ),
  },
};

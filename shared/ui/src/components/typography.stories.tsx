import type { Meta, StoryObj } from "@storybook/react";
import { ThemeProvider } from "./theme-provider/theme-provider";

const TypographyComponent = (
  props: React.HTMLAttributes<HTMLParagraphElement>
) => (
  <>
    <style>{`.typo-row { display: flex; flex-direction: row; align-items: center; gap: 1rem; }`}</style>
    <div className="typo-row">
      <h1>H1</h1>
      <h1 {...props}></h1>
    </div>
    <div className="typo-row">
      <h2>H2</h2>
      <h2 {...props}></h2>
    </div>
    <div className="typo-row">
      <h3>H3</h3>
      <h3 {...props}></h3>
    </div>
    <div className="typo-row">
      <h4>H4</h4>
      <h4 {...props}></h4>
    </div>
    <div className="typo-row">
      <h5>H5</h5>
      <h5 {...props}></h5>
    </div>
    <div className="typo-row">
      <h6>H6</h6>
      <h6 {...props}></h6>
    </div>
    <div className="typo-row">
      <p>Paragraph</p>
      <p {...props}></p>
    </div>
    <div className="typo-row">
      <span>Span</span>
      <span {...props}></span>
    </div>
  </>
);
const meta: Meta<typeof TypographyComponent> = {
  component: TypographyComponent,
  title: "Component/Common/Typography",
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
type Story = StoryObj<typeof TypographyComponent>;

export const Default: Story = {
  args: {
    children: "The quick brown fox jumps over the lazy dog",
  },
};

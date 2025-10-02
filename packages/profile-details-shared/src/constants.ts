import type { BaseFormSection } from "./types";

export const BASE_FORM_SECTIONS: BaseFormSection[] = [
  {
    id: "personal-details",
    label: "Private",
    description: "Your personal details.",
    fields: [
      {
        id: "firstName",
        label: "First Name",
        placeholder: "First Name",
        required: true,
        type: "string",
      },
      {
        id: "lastName",
        label: "Last Name",
        placeholder: "Last Name",
        required: true,
        type: "string",
      },
      {
        id: "avatar",
        label: "Avatar URL",
        placeholder: "https://placehold.co/150x150.jpg",
        required: true,
        type: "image-url",
      },
    ],
  },
];

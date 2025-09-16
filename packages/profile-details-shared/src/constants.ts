import type { BaseFormSection } from "./types";

export const BASE_FORM_SECTIONS: BaseFormSection[] = [
  {
    id: "personal-details",
    label: "Private",
    description: "Your personal details. These details are only visible to you.",
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
        id: "address",
        label: "Address",
        placeholder: "Address",
        required: false,
        type: "text",
      },
      {
        id: "gender",
        label: "Gender",
        placeholder: "Select Gender",
        required: false,
        type: "select",
        options: [
          {
            label: "Male",
            value: "male",
          },
          {
            label: "Female",
            value: "female",
          },
          {
            label: "Other",
            value: "other",
          },
        ],
      },
    ],
  },
  {
    id: "public-details",
    label: "Public",
    description: "Your public details. These details are visible to everyone.",
    fields: [
      {
        id: "public-name",
        label: "Public Name",
        placeholder: "Public Name",
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
      {
        id: "facebookUrl",
        label: "Facebook URL",
        placeholder: "https://www.facebook.com/your-profile",
        required: false,
        type: "url",
      },
      {
        id: "linkedinUrl",
        label: "LinkedIn URL",
        placeholder: "https://www.linkedin.com/in/your-profile",
        required: false,
        type: "url",
      },
      {
        id: "interests",
        label: "Interests",
        placeholder: "Select Interests",
        required: false,
        type: "multiselect",
        options: [
          {
            label: "Reading",
            value: "reading",
          },
          {
            label: "Writing",
            value: "writing",
          },
          {
            label: "Coding",
            value: "coding",
          },
          {
            label: "Pl",
            value: "pl",
          },
        ],
      },
      {
        id: "isPublic",
        label: "Is Public",
        placeholder: "Is Public",
        required: false,
        type: "toggle",
      },
      {
        id: "dateOfBirth",
        label: "Date of Birth",
        placeholder: "Date of Birth",
        required: false,
        type: "date",
      },
      {
        id: "hourlyRate",
        label: "Hourly Rate (USD)",
        placeholder: "Hourly Rate (USD)",
        required: false,
        type: "number",
      },
      {
        id: "hasChildren",
        label: "Has Children",
        placeholder: "Has Children",
        required: false,
        type: "boolean",
      },
    ],
  },
];

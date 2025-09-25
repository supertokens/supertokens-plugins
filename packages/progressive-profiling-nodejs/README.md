# SuperTokens Plugin Progressive Profiling

Add progressive profiling functionality to your SuperTokens Node.js backend.
This plugin provides APIs and session management for step-by-step user profile collection, allowing you to gather user information gradually through customizable forms and field types.

## Installation

```bash
npm install @supertokens-plugins/progressive-profiling-nodejs
```

## Quick Start

### Backend Configuration

Initialize the plugin in your SuperTokens backend configuration:

```typescript
import SuperTokens from "supertokens-node";
import ProgressiveProfilingPlugin from "@supertokens-plugins/progressive-profiling-nodejs";

SuperTokens.init({
  appInfo: {
    // your app info
  },
  recipeList: [
    // your recipes (Session recipe is required)
  ],
  experimental: {
    plugins: [
      ProgressiveProfilingPlugin.init({
        sections: [
          {
            id: "basic-info",
            label: "Basic Information",
            description: "Tell us about yourself",
            fields: [
              {
                id: "firstName",
                label: "First Name",
                type: "string",
                required: true,
                placeholder: "Enter your first name",
              },
              {
                id: "lastName",
                label: "Last Name",
                type: "string",
                required: true,
                placeholder: "Enter your last name",
              },
              {
                id: "company",
                label: "Company",
                type: "string",
                required: false,
                placeholder: "Enter your company name",
              },
            ],
          },
          {
            id: "preferences",
            label: "Preferences",
            description: "Customize your experience",
            fields: [
              {
                id: "notifications",
                label: "Email Notifications",
                type: "boolean",
                required: false,
                defaultValue: true,
              },
              {
                id: "theme",
                label: "Preferred Theme",
                type: "select",
                required: false,
                options: [
                  { value: "light", label: "Light" },
                  { value: "dark", label: "Dark" },
                  { value: "auto", label: "Auto" },
                ],
                defaultValue: "auto",
              },
            ],
          },
        ],
      }),
    ],
  },
});
```

> [!IMPORTANT]  
> You also have to install and configure the frontend plugin for the complete progressive profiling experience.

## API Endpoints

The plugin automatically exposes these protected endpoints:

### Get Profile Sections

- **GET** `/plugin/supertokens-plugin-progressive-profiling/sections`
- **Authentication**: Session required
- **Response**:
  ```json
  {
    "status": "OK",
    "sections": [
      {
        "id": "basic-info",
        "label": "Basic Information",
        "description": "Tell us about yourself",
        "completed": false,
        "fields": [
          {
            "id": "firstName",
            "label": "First Name",
            "type": "string",
            "required": true,
            "placeholder": "Enter your first name"
          }
        ]
      }
    ]
  }
  ```

### Get Profile Data

- **GET** `/plugin/supertokens-plugin-progressive-profiling/profile`
- **Authentication**: Session required
- **Response**:
  ```json
  {
    "status": "OK",
    "data": [
      {
        "sectionId": "basic-info",
        "fieldId": "firstName",
        "value": "John"
      },
      {
        "sectionId": "basic-info",
        "fieldId": "lastName",
        "value": "Doe"
      }
    ]
  }
  ```

### Update Profile Data

- **POST** `/plugin/supertokens-plugin-progressive-profiling/profile`
- **Authentication**: Session required
- **Body**:
  ```json
  {
    "data": [
      {
        "sectionId": "basic-info",
        "fieldId": "firstName",
        "value": "John"
      },
      {
        "sectionId": "basic-info",
        "fieldId": "lastName",
        "value": "Doe"
      }
    ]
  }
  ```
- **Success Response**:
  ```json
  {
    "status": "OK"
  }
  ```
- **Validation Error Response**:
  ```json
  {
    "status": "INVALID_FIELDS",
    "errors": [
      {
        "id": "firstName",
        "error": "The \"First Name\" field is required"
      }
    ]
  }
  ```

## Configuration Options

| Option     | Type            | Default | Description                                   |
| ---------- | --------------- | ------- | --------------------------------------------- |
| `sections` | `FormSection[]` | `[]`    | Array of form sections with fields to collect |

### Form Section Structure

```typescript
type FormSection = {
  id: string; // Unique identifier for the section
  label: string; // Display label for the section
  description?: string; // Optional description text
  fields: FormField[]; // Array of fields in this section
};
```

### Form Field Structure

```typescript
type FormField = {
  id: string; // Unique identifier for the field
  label: string; // Display label for the field
  type: FormFieldType; // Field input type (see supported types below)
  required?: boolean; // Whether the field is required (default: false)
  defaultValue?: FormFieldValue; // Default value for the field
  placeholder?: string; // Placeholder text for input
  description?: string; // Optional description text
  options?: SelectOption[]; // Options for select/multiselect fields
};
```

## Supported Field Types

The plugin supports various field types for flexible form creation:

| Field Type    | Description                  | Value Type                 |
| ------------- | ---------------------------- | -------------------------- |
| `string`      | Single-line text input       | `string`                   |
| `text`        | Multi-line text area         | `string`                   |
| `number`      | Numeric input                | `number`                   |
| `boolean`     | Checkbox input               | `boolean`                  |
| `toggle`      | Toggle switch                | `boolean`                  |
| `email`       | Email input with validation  | `string`                   |
| `phone`       | Phone number input           | `string`                   |
| `date`        | Date picker                  | `string` (ISO date format) |
| `select`      | Dropdown selection           | `string`                   |
| `multiselect` | Multiple selection dropdown  | `string[]`                 |
| `password`    | Password input               | `string`                   |
| `url`         | URL input with validation    | `string`                   |
| `image-url`   | Image URL input with preview | `string`                   |

## Plugin Functions

### registerSections

Register additional form sections programmatically:

```typescript
import { registerSections } from "@supertokens-plugins/progressive-profiling-nodejs";

registerSections({
  storageHandlerId: "custom-storage",
  sections: [
    {
      id: "advanced-settings",
      label: "Advanced Settings",
      fields: [
        {
          id: "apiKey",
          label: "API Key",
          type: "password",
          required: true,
        },
      ],
    },
  ],
  set: async (data, session, userContext) => {
    // Custom storage logic for saving profile data
    const userId = session.getUserId(userContext);
    await customDatabase.saveUserProfile(userId, data);
  },
  get: async (session, userContext) => {
    // Custom storage logic for retrieving profile data
    const userId = session.getUserId(userContext);
    return await customDatabase.getUserProfile(userId);
  },
});
```

### getSectionValues

Get profile data for a the session user:

```typescript
import { getSectionValues } from "@supertokens-plugins/progressive-profiling-nodejs";

// In your API handler
const profileData = await getSectionValues({
  session,
  userContext,
});

console.log("User profile:", profileData);
```

### setSectionValues

Update profile data for a specific user:

```typescript
import { setSectionValues } from "@supertokens-plugins/progressive-profiling-nodejs";

// In your API handler
const result = await setSectionValues({
  session,
  data: [
    {
      sectionId: "basic-info",
      fieldId: "firstName",
      value: "John",
    },
  ],
  userContext,
});

if (result.status === "INVALID_FIELDS") {
  console.error("Validation errors:", result.errors);
}
```

### getAllSections

Get all registered sections:

```typescript
import { getAllSections } from "@supertokens-plugins/progressive-profiling-nodejs";

const sections = await ProgressiveProfilingPlugin.getAllSections({
  session,
  userContext,
});

console.log("Available sections:", sections);
```

## Custom Storage Handlers

By default, the user profile data is handled by the user metadata through the `defaultStorageHandlerSetFields` and `defaultStorageHandlerGetFields` methods. These are used whenever sections are added through the plugin config. These methods can also be overriden in order to make use of your own storage system (database, files, third-parties, etc).

You can also implement custom storage logic for different sections:

```typescript
import { registerSections } from "@supertokens-plugins/progressive-profiling-nodejs";

// Example: Store user preferences in a separate database
registerSections({
  storageHandlerId: "preferences-db",
  sections: [
    {
      id: "user-preferences",
      label: "User Preferences",
      fields: [
        { id: "theme", label: "Theme", type: "select", options: [...] },
        { id: "language", label: "Language", type: "select", options: [...] },
      ],
    },
  ],
  set: async (data, session, userContext) => {
    const userId = session.getUserId(userContext);
    const preferences = {};

    for (const item of data) {
      preferences[item.fieldId] = item.value;
    }

    await preferencesDatabase.updateUserPreferences(userId, preferences);
  },
  get: async (session, userContext) => {
    const userId = session.getUserId(userContext);
    const preferences = await preferencesDatabase.getUserPreferences(userId);

    return Object.entries(preferences).map(([fieldId, value]) => ({
      sectionId: "user-preferences",
      fieldId,
      value,
    }));
  },
});
```

## Validation

The plugin provides built-in validation for form fields:

### Built-in Validation Rules

- **Required Fields**: Automatically validates that required fields are not empty
- **Field Type Validation**: Ensures values match the expected field type

### Custom Validation

You can extend and customise validation by overriding the `registerSections` implementation method.

## Error Handling

By default, the plugin returns the following standardized error responses:

```typescript
// Missing required field
{
  "status": "INVALID_FIELDS",
  "errors": [
    {
      "id": "firstName",
      "error": "The \"First Name\" field is required" // "First Name" is the label of the field that encountered the error
    }
  ]
}

// Field not found
{
  "status": "INVALID_FIELDS",
  "errors": [
    {
      "id": "unknownField",
      "error": "Field with id \"unknownField\" not found"
    }
  ]
}

// Server errors
{
  "status": "ERROR",
  "message": "Internal server error"
}
```

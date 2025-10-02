# SuperTokens Plugin Profile Details

Add profile details management to your SuperTokens Node.js backend.
This plugin provides APIs for managing user profile information with customizable form fields, automatic third-party data integration, and seamless integration with progressive profiling.

## Installation

```bash
npm install @supertokens-plugins/profile-details-nodejs
```

## Quick Start

### Backend Configuration

Initialize the plugin in your SuperTokens backend configuration:

```typescript
import SuperTokens from "supertokens-node";
import ProfileDetailsPlugin from "@supertokens-plugins/profile-details-nodejs";

SuperTokens.init({
  appInfo: {
    // your app info
  },
  recipeList: [
    // your recipes (Session recipe is required)
  ],
  experimental: {
    plugins: [
      ProfileDetailsPlugin.init({
        sections: [
          {
            id: "personal-details",
            label: "Personal Information",
            description: "Your personal details",
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
            ],
          },
        ],
        registerSectionsForProgressiveProfiling: true, // Optional: defaults to true
      }),
    ],
  },
});
```

> [!IMPORTANT]  
> You also have to install and configure the frontend plugin for the complete profile details experience.

## API Endpoints

The plugin automatically exposes these protected endpoints:

### Get Profile Sections

- **GET** `/plugin/supertokens-plugin-profile-details/sections`
- **Authentication**: Session required
- **Response**:
  ```json
  {
    "status": "OK",
    "sections": [
      {
        "id": "personal-details",
        "label": "Personal Information",
        "description": "Your personal details",
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

- **GET** `/plugin/supertokens-plugin-profile-details/profile`
- **Authentication**: Session required
- **Response**:
  ```json
  {
    "status": "OK",
    "profile": {
      "firstName": "John",
      "lastName": "Doe",
      "avatar": "https://example.com/avatar.jpg",
      "company": "Acme Corp"
    },
    "user": {
      "id": "user123",
      "emails": ["john@example.com"],
      "timeJoined": 1640995200000
    }
  }
  ```

### Update Profile Data

- **POST** `/plugin/supertokens-plugin-profile-details/profile`
- **Authentication**: Session required
- **Body**:
  ```json
  {
    "data": [
      {
        "sectionId": "personal-details",
        "fieldId": "firstName",
        "value": "John"
      },
      {
        "sectionId": "personal-details",
        "fieldId": "lastName",
        "value": "Doe"
      }
    ]
  }
  ```
- **Success Response**:
  ```json
  {
    "status": "OK",
    "profile": {
      "data": [
        {
          "sectionId": "personal-details",
          "fieldId": "firstName",
          "value": "John"
        },
        {
          "sectionId": "personal-details",
          "fieldId": "lastName",
          "value": "Doe"
        }
      ]
    }
  }
  ```

## Configuration Options

| Option                                    | Type            | Default | Description                                                        |
| ----------------------------------------- | --------------- | ------- | ------------------------------------------------------------------ |
| `sections`                                | `FormSection[]` | `[]`    | Array of form sections with fields to collect                      |
| `registerSectionsForProgressiveProfiling` | `boolean`       | `true`  | Whether to register sections with the progressive profiling plugin |

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

## Third-Party Integration

The plugin automatically integrates with third-party authentication providers to populate profile fields:

### Automatic Field Mapping

When users sign in with third-party providers (Google, GitHub, etc.), the plugin automatically maps provider data to profile fields (if the fields are configured):

- **firstName**: Maps from `name`, `given_name`, or `first_name`
- **lastName**: Maps from `family_name` or `last_name`
- **avatar**: Maps from `picture` or `avatar_url`

### Custom Field Mapping

You can customize how third-party data is mapped to your profile fields by overriding the implementation method `getFieldValueFromThirdPartyUserInfo`.

## Progressive Profiling Integration

The plugin seamlessly integrates with the progressive profiling plugin:

### Automatic Registration

When `registerSectionsForProgressiveProfiling` is enabled (default), the plugin automatically registers all configured.

## Default Profile Sections

The plugin comes with a default section if no sections are configured:

```typescript
{
  id: "personal-details",
  label: "Private",
  description: "Your personal details.",
  fields: [
    {
      id: "firstName",
      label: "First Name",
      type: "string",
      required: true,
    },
    {
      id: "lastName",
      label: "Last Name",
      type: "string",
      required: true,
    },
    {
      id: "avatar",
      label: "Avatar URL",
      type: "image-url",
      required: true,
    },
  ],
}
```

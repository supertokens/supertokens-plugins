# SuperTokens Plugin Profile Details

Add profile details management to your SuperTokens React application.
This plugin provides a user profile interface with customizable form fields, account information display.

## Installation

```bash
npm install @supertokens-plugins/profile-details-react
```

## Quick Start

### Frontend Configuration

Initialize the plugin in your SuperTokens frontend configuration:

```typescript
import SuperTokens from "supertokens-auth-react";
import ProfileBasePlugin from "@supertokens-plugins/profile-base-react";
import ProfileDetailsPlugin from "@supertokens-plugins/profile-details-react";

SuperTokens.init({
  appInfo: {
    // your app info
  },
  recipeList: [
    // your recipes
  ],
  experimental: {
    plugins: [
      // Profile base plugin is required
      ProfileBasePlugin.init(),
      ProfileDetailsPlugin.init(),
    ],
  },
});
```

> [!IMPORTANT]  
> You also have to install and configure the backend plugin `@supertokens-plugins/profile-details-nodejs` and the profile base plugin `@supertokens-plugins/profile-base-react`.

## Profile Details Interface

The plugin automatically registers with the profile base plugin to provide:

- **Account Section**: Displays user account information including emails, phone numbers, connected accounts, and join date
- **Dynamic Detail Sections**: Configurable form sections based on backend configuration
- **Field Types Support**: Comprehensive support for various input and display field types

## Supported Field Types

The plugin supports various overridable field types for flexible form creation and display:

| Field Type    | Description                  |
| ------------- | ---------------------------- |
| `string`      | Single-line text input       |
| `text`        | Multi-line text area         |
| `number`      | Numeric input                |
| `boolean`     | Checkbox input               |
| `toggle`      | Toggle switch                |
| `email`       | Email input with validation  |
| `phone`       | Phone number input           |
| `date`        | Date picker                  |
| `select`      | Dropdown selection           |
| `multiselect` | Multiple selection dropdown  |
| `password`    | Password input               |
| `url`         | URL input with validation    |
| `image-url`   | Image URL input with preview |

## Hooks and Utilities

### usePluginContext Hook

Access plugin functionality and API methods:

```typescript
import { usePluginContext } from "@supertokens-plugins/profile-details-react";

function MyProfileComponent() {
  const { api, pluginConfig, t, fieldInputComponentMap, fieldViewComponentMap } = usePluginContext();

  const handleGetDetails = async () => {
    try {
      const response = await api.getDetails();
      if (response.status === "OK") {
        console.log("Profile data:", response.profile);
        console.log("User data:", response.user);
      }
    } catch (error) {
      console.error("Failed to fetch profile:", error);
    }
  };

  return (
    <div>
      <h2>{t("PL_CD_SECTION_ACCOUNT_LABEL")}</h2>
      <button onClick={handleGetDetails}>Load Profile Details</button>
    </div>
  );
}
```

### API Methods

The plugin provides these API methods through the `usePluginContext` hook:

#### getDetails

Retrieve the current user's profile and account details:

```typescript
const { api } = usePluginContext();

// Get current profile and user details
const result = await api.getDetails();
if (result.status === "OK") {
  console.log("Profile data:", result.profile);
  console.log("User data:", result.user);
} else {
  console.error("Error:", result.message);
}
```

#### updateProfile

Update the user's profile data:

```typescript
const { api } = usePluginContext();

// Update profile with form field data
const profileData = [
  {
    sectionId: "personal-info",
    fieldId: "company",
    value: "Acme Corp",
  },
  {
    sectionId: "personal-info",
    fieldId: "job-title",
    value: "Software Engineer",
  },
];

const result = await api.updateProfile({ data: profileData });
if (result.status === "OK") {
  console.log("Profile updated successfully:", result.profile);
} else {
  console.error("Error:", result.message);
}
```

#### getSections

Get the configured form sections from the backend:

```typescript
const { api } = usePluginContext();

// Get form sections configuration
const result = await api.getSections();
if (result.status === "OK") {
  console.log("Form sections:", result.sections);
} else {
  console.error("Error fetching sections");
}
```

## Component Customization

### Custom Field Components

Override default field input and view components:

```typescript
import ProfileDetailsPlugin from "@supertokens-plugins/profile-details-react";
import { CustomStringInput, CustomStringView } from "./your-custom-components";

SuperTokens.init({
  // ... other config
  experimental: {
    plugins: [
      ProfileDetailsPlugin.init({
        override: (oI) => ({
          ...oI,
          fieldInputComponentMap: (originalMap) => ({
            ...originalMap,
            string: CustomStringInput,
          }),
          fieldViewComponentMap: (originalMap) => ({
            ...originalMap,
            string: CustomStringView,
          }),
        }),
      }),
    ],
  },
});
```

## Integration with Profile Base Plugin

This plugin automatically integrates with the profile base plugin by:

1. **Registering Account Section**: Adds an "Account" section showing user account details
2. **Dynamic Section Registration**: Fetches and registers additional sections from the backend
3. **Navigation**: Works with the profile base plugin's sidebar navigation

## Account Information Display

The account section automatically displays:

- **Email Addresses**: All verified email addresses associated with the account
- **Phone Numbers**: All verified phone numbers (if using Passwordless recipe)
- **Connected Accounts**: Third-party provider connections (Google, GitHub, etc.)
- **Join Date**: When the user first registered

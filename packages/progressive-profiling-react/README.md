# SuperTokens Plugin Progressive Profiling

Add progressive profiling functionality to your SuperTokens React application.
This plugin provides a step-by-step user profile collection system with customizable forms and field types, allowing you to gather user information gradually.

## Installation

```bash
npm install @supertokens-plugins/progressive-profiling-react
```

## Quick Start

### Frontend Configuration

Initialize the plugin in your SuperTokens frontend configuration:

```typescript
import SuperTokens from "supertokens-auth-react";
import ProgressiveProfilingPlugin from "@supertokens-plugins/progressive-profiling-react";

SuperTokens.init({
  appInfo: {
    // your app info
  },
  recipeList: [
    // your recipes
  ],
  experimental: {
    plugins: [
      ProgressiveProfilingPlugin.init({
        setupPagePath: "/user/setup", // Optional: defaults to "/user/setup"
        requireSetup: true, // Optional: defaults to true
        showStartSection: true, // Optional: defaults to true
        showEndSection: true, // Optional: defaults to true
        onSuccess: async (data) => {
          // Optional: callback after successful profile completion
          console.log("Profile completed:", data);
        },
      }),
    ],
  },
});
```

> [!IMPORTANT]  
> You also have to install and configure the backend plugin.

## Profile Setup Interface

The plugin provides a complete progressive profiling interface accessible at `/user/setup` (or your custom path). This page includes:

- **Multi-step Forms**: Breaks profile collection into manageable sections
- **Dynamic Field Types**: Supports various input types (text, email, phone, date, select, etc.)
- **Progress Tracking**: Visual progress indicators for multi-step flows
- **Validation**: Client-side and server-side form validation
- **Session Protection**: Automatically enforces profile completion through session claims

## Configuration Options

| Option             | Type                                                    | Default         | Description                                                    |
| ------------------ | ------------------------------------------------------- | --------------- | -------------------------------------------------------------- |
| `setupPagePath`    | string                                                  | `"/user/setup"` | Path to the profile setup page                                 |
| `requireSetup`     | boolean                                                 | `true`          | Whether to enforce profile completion through claim validation |
| `showStartSection` | boolean                                                 | `true`          | Show introductory section before forms                         |
| `showEndSection`   | boolean                                                 | `true`          | Show completion section after forms                            |
| `onSuccess`        | `(data: ProfileFormData) => Promise<void> \| undefined` | `undefined`     | Callback executed after successful completion                  |

## Supported Field Types

The plugin supports various field types for flexible form creation:

| Field Type    | Description                  | Component                   |
| ------------- | ---------------------------- | --------------------------- |
| `string`      | Single-line text input       | `StringFieldComponent`      |
| `text`        | Multi-line text area         | `TextFieldComponent`        |
| `number`      | Numeric input                | `NumberFieldComponent`      |
| `boolean`     | Checkbox input               | `BooleanFieldComponent`     |
| `toggle`      | Toggle switch                | `ToggleInput`               |
| `email`       | Email input with validation  | `EmailFieldComponent`       |
| `phone`       | Phone number input           | `PhoneFieldComponent`       |
| `date`        | Date picker                  | `DateFieldComponent`        |
| `select`      | Dropdown selection           | `SelectFieldComponent`      |
| `multiselect` | Multiple selection dropdown  | `MultiselectFieldComponent` |
| `password`    | Password input               | `PasswordFieldComponent`    |
| `url`         | URL input with validation    | `UrlFieldComponent`         |
| `image-url`   | Image URL input with preview | `ImageUrlFieldComponent`    |

## Hooks and Utilities

### usePluginContext Hook

Access exposed plugin functionality in your custom components:

```typescript
import { usePluginContext } from "@supertokens-plugins/progressive-profiling-react";

function MyProfileComponent() {
  const { api, pluginConfig, t, ProgressiveProfilingCompletedClaim } = usePluginContext();

  const handleGetProfile = async () => {
    try {
      const response = await api.getProfile();
      if (response.status === "OK") {
        console.log("Current profile data:", response.data);
      }
    } catch (error) {
      console.error("Failed to fetch profile:", error);
    }
  };

  return (
    <div>
      <h2>{t("PL_PP_SECTION_PROFILE_START_LABEL")}</h2>
      <button onClick={handleGetProfile}>Load Profile</button>
    </div>
  );
}
```

### API Methods

The plugin provides these API methods through the `usePluginContext` hook:

#### getProfile

Retrieve the current user's profile data:

```typescript
const { api } = usePluginContext();

// Get current profile
const result = await api.getProfile();
if (result.status === "OK") {
  console.log("Profile data:", result.data);
} else {
  console.error("Error:", result.message);
}
```

#### updateProfile

Update the user's profile data:

```typescript
const { api } = usePluginContext();

// Update profile
const profileData = [
  {
    sectionId: "some-section-id",
    fieldId: "some-field-id",
    value: "Acme Corp",
  },
];

const result = await api.updateProfile({ data: profileData });
if (result.status === "OK") {
  console.log("Profile updated successfully");
} else if (result.status === "INVALID_FIELDS") {
  console.error("Validation errors:", result.errors);
} else {
  console.error("Error:", result.message);
}
```

#### getSections

Get the configured form sections:

```typescript
const { api } = usePluginContext();

// Get form sections
const result = await api.getSections();
if (result.status === "OK") {
  console.log("Form sections:", result.sections);
} else {
  console.error("Error:", result.message);
}
```

## Custom Components

### UserProfileWrapper

Use the `UserProfileWrapper` component to add progressive profiling to any part of your application:

```typescript
import { UserProfileWrapper } from "@supertokens-plugins/progressive-profiling-react";

function MyApp() {
  return (
    <div>
      <UserProfileWrapper>
        {/* Your app content */}
      </UserProfileWrapper>
    </div>
  );
}
```

## Session Claims Integration

The plugin automatically integrates with SuperTokens session claims to enforce profile completion:

- When `requireSetup` is `true`, users will be redirected to the setup page until their profile is complete
- The `ProgressiveProfilingCompletedClaim` tracks completion status
- Session validation automatically checks the claim on protected routes
- Once the profile is complete and `requireSetup` is ste to `true`, the user will be redirected through according to the `getRedirectionURL` implementation/override. This is done by rendering the `AuthPage` directly in plugin.

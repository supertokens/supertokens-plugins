# SuperTokens Plugin Base Profile

Create a comprehensive user profile interface for your SuperTokens React application.
This plugin provides a foundational profile page with a sectioned layout that other profile-related plugins can extend and customize.

## Installation

```bash
npm install @supertokens-plugins/base-profile-react
```

## Quick Start

### Frontend Configuration

Initialize the plugin in your SuperTokens frontend configuration:

```typescript
import SuperTokens from "supertokens-auth-react";
import BaseProfilePlugin from "@supertokens-plugins/base-profile-react";

SuperTokens.init({
  appInfo: {
    // your app info
  },
  recipeList: [
    // your recipes
  ],
  experimental: {
    plugins: [
      BaseProfilePlugin.init({
        profilePagePath: "/user/profile", // Optional: defaults to "/user/profile"
        sections: [
          // Optional: initial sections
          {
            id: "basic-info",
            title: "Basic Information",
            component: () => <div>Basic user information goes here</div>,
          },
        ],
      }),
    ],
  },
});
```

## Profile Interface

The plugin provides a complete user profile interface accessible at `/user/profile` (configurable). This page includes:

- **Session Protection**: Automatically protected with `SessionAuth`
- **Sectioned Layout**: Clean sidebar navigation with content area
- **Hash-Based Navigation**: URL hash navigation for direct section linking
- **Extensible Architecture**: Other plugins can register additional sections

## Configuration Options

| Option            | Type                                | Default             | Description                           |
| ----------------- | ----------------------------------- | ------------------- | ------------------------------------- |
| `profilePagePath` | string                              | `"/user/profile"`   | Path where the profile page is served |
| `sections`        | `SuperTokensPluginProfileSection[]` | `[]`                | Initial profile sections to display   |

## Section Structure

Each profile section follows this structure:

```typescript
type SuperTokensPluginProfileSection = {
  id: string; // Unique identifier
  title: string; // Display name in sidebar
  order: number; // Display order (auto-assigned if not provided)
  icon?: () => React.JSX.Element; // Optional sidebar icon
  component: () => React.JSX.Element; // Section content component
};
```

## Hooks and Utilities

### usePluginContext Hook

Access plugin functionality and register new sections:

```typescript
import { usePluginContext } from "@supertokens-plugins/base-profile-react";

function MyProfileComponent() {
  const { getSections, registerSection, pluginConfig, t } = usePluginContext();

  const currentSections = getSections();
  
  // Register a new section dynamically
  const addCustomSection = async () => {
    await registerSection(async () => ({
      id: "custom-section",
      title: "Custom Settings",
      icon: () => <SettingsIcon />,
      component: () => <CustomSettingsComponent />,
    }));
  };

  return (
    <div>
      <h2>Profile Management</h2>
      <p>Current sections: {currentSections.length}</p>
      <button onClick={addCustomSection}>Add Custom Section</button>
    </div>
  );
}
```

## Profile Components

### UserProfileWrapper

Use the profile wrapper in your own components:

```typescript
import { UserProfileWrapper } from "@supertokens-plugins/base-profile-react";
import { ThemeProvider } from "@shared/ui";

function CustomProfilePage() {
  return (
    <ThemeProvider>
      <div className="my-custom-layout">
        <header>My App Header</header>
        <main>
          <UserProfileWrapper />
        </main>
      </div>
    </ThemeProvider>
  );
}
```

## Integration with Other Plugins

This plugin serves as a foundation for other profile-related plugins:

```typescript
// Example: Security plugin registering its section
import BaseProfilePlugin from "@supertokens-plugins/base-profile-react";
import SecurityPlugin from "@supertokens-plugins/security-react";

SuperTokens.init({
  // ... other config
  experimental: {
    plugins: [
      BaseProfilePlugin.init({
        profilePagePath: "/dashboard/profile",
      }),
      SecurityPlugin.init({
        // Security plugin will automatically register its sections
        // with the base profile plugin
      }),
    ],
  },
});
```
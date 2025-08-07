# SuperTokens Plugins

A collection of official plugins that extend [SuperTokens](https://supertokens.com) functionality with additional functionalities.

## Overview

This repository contains plugins that enhance the authentication flows exposed by SuperTokens.
Each plugin is designed to work seamlessly with SuperTokens recipes and can be easily integrated into both frontend and backend applications.

## Available Plugins

### CAPTCHA Plugin

Protect your authentication endpoints from automated attacks with CAPTCHA verification.

- **[@supertokens-plugin/captcha-nodejs](./packages/captcha-nodejs)** - Backend CAPTCHA validation for Node.js applications
- **[@supertokens-plugin/captcha-react](./packages/captcha-react)** - Frontend CAPTCHA integration for React applications

## Quick Start

### Installation

Each plugin usually consists of separate packages for frontend and backend based on specific languages/frameworks:

```bash
# Backend (Node.js)
npm install @supertokens-plugin/captcha/nodejs

# Frontend (React)
npm install @supertokens-plugin/captcha/react
```

### Basic Usage

**1. Initialize the plugin in the backend:**

```typescript
import SuperTokens from "supertokens-node";
import CaptchaPlugin from "@supertokens-plugin/captcha-nodejs";

SuperTokens.init({
  // ... your SuperTokens config
  plugins: [
    CaptchaPlugin.init({
      type: "reCAPTCHAv3",
      captcha: {
        secretKey: "your-secret-key",
      },
    }),
  ],
});
```

**2. Initialize the plugin in the frontend:**

```typescript
import SuperTokens from "supertokens-auth-react";
import CaptchaPlugin from "@supertokens-plugin/captcha-react";

SuperTokens.init({
  // ... your SuperTokens config
  plugins: [
    CaptchaPlugin.init({
      type: "reCAPTCHAv3",
      captcha: {
        sitekey: "your-site-key",
      },
    }),
  ],
});
```

## Development

This repository uses [Turbo](https://turbo.build) for efficient monorepo management and [npm workspaces](https://docs.npmjs.com/cli/v7/using-npm/workspaces) for dependency management.

### Prerequisites

- Node.js >= 18
- npm >= 10

### Setup

1. Clone the repository:

```bash
git clone https://github.com/supertokens/supertokens-plugins.git
cd supertokens-plugins
```

2. Install dependencies:

```bash
npm install
```

3. Generate a new plugin/package:

```bash
TODO: Add turbo generator command
```

### Working with Individual Packages

You can also run commands for specific packages:

```bash
# Build only the Node.js CAPTCHA plugin
npm run build --workspace=@supertokens-plugin/captcha-nodejs

# Test only the React CAPTCHA plugin
npm run test --workspace=@supertokens-plugin/captcha-react

# Lint a specific package
npm run lint --workspace=@supertokens-plugin/captcha-react
```

### Project Structure

```
supertokens-plugins/
├── packages/                                  # Plugin packages
│   ├── <plugin>-<language/framework>/         # Language/framework specific plugin
├── shared/                                    # Shared configurations, libraries and utilities
├── package.json               # Root package configuration
├── turbo.json                 # Turbo configuration
└── README.md                  # This file
```

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.

## Support

- 📖 [Documentation](https://supertokens.com/docs)
- 💬 [Discord Community](https://supertokens.com/discord)
- 🐛 [GitHub Issues](https://github.com/supertokens/supertokens-plugins/issues)

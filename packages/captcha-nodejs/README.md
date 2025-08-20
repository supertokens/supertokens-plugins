# SuperTokens Plugin Captcha

Add CAPTCHA verification to SuperTokens authentication flows.
This plugin integrates with **reCAPTCHA v2**, **reCAPTCHA v3**, and **Cloudflare Turnstile** to protect authentication endpoints from automated attacks.

## Installation

```bash
npm install @supertokens-plugins/captcha-nodejs
```

## Quick Start

Initialize the plugin in your SuperTokens backend configuration:

```typescript
import SuperTokens from "supertokens-node";
import CaptchaPlugin from "@supertokens-plugins/captcha-nodejs";

SuperTokens.init({
  supertokens: {
    connectionURI: "...",
  },
  appInfo: {
    // your app info
  },
  recipeList: [
    // your recipes
  ],
  plugins: [
    CaptchaPlugin.init({
      type: "reCAPTCHAv3", // or "reCAPTCHAv2" or "turnstile"
      captcha: {
        secretKey: "your-secret-key",
      },
    }),
  ],
});
```

> [!IMPORTANT]  
> You also have to install and configure the frontend plugin.

## Protected Flows

The plugin automatically protects these authentication flows:

| Recipe          | Authentication Flow        | API Function                     |
| --------------- | -------------------------- | -------------------------------- |
| `EmailPassword` | User sign in               | `signInPOST`                     |
| `EmailPassword` | User registration          | `signUpPOST`                     |
| `EmailPassword` | Password reset request     | `generatePasswordResetTokenPOST` |
| `EmailPassword` | Password reset submission  | `passwordResetPOST`              |
| `Passwordless`  | Generate verification code | `createCodePOST`                 |
| `Passwordless`  | Verify code and sign in    | `consumeCodePOST`                |

## Customization

### Conditional Validation

Control when CAPTCHA validation occurs using the `shouldValidate` function:

```typescript
import { ShouldValidate } from "@supertokens-plugins/captcha-nodejs";

const shouldValidate: ShouldValidate = (api, input) => {
  // Only require CAPTCHA for sign up
  if (api === "signUpPOST") {
    return true;
  }

  // Check request headers for suspicious activity
  if (api === "signInPOST") {
    const userAgent = input.options.req.getHeaderValue("user-agent");
    return !userAgent || userAgent.includes("bot");
  }

  return false;
};
```

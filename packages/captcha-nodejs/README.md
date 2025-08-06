# SuperTokens Plugin Captcha

Add CAPTCHA verification to SuperTokens authentication flows.
This plugin integrates with **reCAPTCHA v2**, **reCAPTCHA v3**, and **Cloudflare Turnstile** to protect authentication endpoints from automated attacks.

## Installation

```bash
npm install supertokens-plugin-captcha
```

## Quick Start

### Backend Configuration

Initialize the plugin in your SuperTokens backend configuration:

```typescript
import SuperTokens from "supertokens-node";
import CaptchaPlugin from "supertokens-plugin-captcha/backend";

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

### Frontend Configuration

Initialize the plugin in your SuperTokens frontend configuration:

```typescript
import SuperTokens from "supertokens-auth-react";
import CaptchaPlugin from "supertokens-plugin-captcha/frontend";

SuperTokens.init({
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
        sitekey: "your-site-key",
        // Additional configuration based on the captcha provider
      },
    }),
  ],
});
```

## Protected Flows

The plugin automatically protects these authentication flows:

| Recipe          | Authentication Flow        | Forms                                                                                  | Pre-API Hook Action         | Backend API Function             |
| --------------- | -------------------------- | -------------------------------------------------------------------------------------- | --------------------------- | -------------------------------- |
| `EmailPassword` | User sign in               | `EmailPasswordSignInForm`                                                              | `EMAIL_PASSWORD_SIGN_IN`    | `signInPOST`                     |
| `EmailPassword` | User registration          | `EmailPasswordSignUpForm`                                                              | `EMAIL_PASSWORD_SIGN_UP`    | `signUpPOST`                     |
| `EmailPassword` | Password reset request     | `EmailPasswordResetPasswordEmail`                                                      | `SEND_RESET_PASSWORD_EMAIL` | `generatePasswordResetTokenPOST` |
| `EmailPassword` | Password reset submission  | `EmailPasswordSubmitNewPassword`                                                       | `SUBMIT_NEW_PASSWORD`       | `passwordResetPOST`              |
| `Passwordless`  | Generate verification code | `PasswordlessEmailForm` and `PasswordlessPhoneForm` and `PasswordlessEmailOrPhoneForm` | `PASSWORDLESS_CREATE_CODE`  | `createCodePOST`                 |
| `Passwordless`  | Verify code and sign in    | `PasswordlessUserInputForm`                                                            | `PASSWORDLESS_CONSUME_CODE` | `consumeCodePOST`                |

## Customization

### Backend: Conditional Validation

Control when CAPTCHA validation occurs using the `shouldValidate` function:

```typescript
import { ShouldValidate } from "supertokens-plugin-captcha/backend";

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

### Frontend: Custom Input Container

Create a custom component to control CAPTCHA rendering:

```typescript
import { forwardRef, useCallback, useEffect } from 'react';
import {
  CaptchInputContainerProps,
  captchaStore,
  useCaptchaInputContainerId,
} from 'supertokens-plugin-captcha/frontend';

const CustomCaptchaContainer = forwardRef<
  HTMLDivElement,
  CaptchInputContainerProps
>((props, ref) => {
  const { form, ...rest } = props;
  const { loadAndRender, containerId } = useCaptcha();

  useEffect(() => {
    // Captcha will apply/render only for the EmailPasswordSignUpForm
    // and the EmailPasswordSignInForm
    if (
      form === 'EmailPasswordSignUpForm' ||
      form === 'EmailPasswordResetPasswordEmail'
    ) {
      loadAndRender();
    }
  }, [form]);

  return (
    <div ref={ref} id={containerId} className="captcha-container" {...rest} />
  );
});
```

## Hooks and Utilities

### useCaptcha Hook

Monitor CAPTCHA state in your components:

```typescript
import { useCaptcha } from 'supertokens-plugin-captcha/frontend';

function MyComponent() {
  const captcha = useCaptcha();

  if (captcha.state === 'loading') {
    return <div>Loading CAPTCHA...</div>;
  }

  if (captcha.state === 'error') {
    return <div>Error: {captcha.error}</div>;
  }

  return <div>CAPTCHA ready</div>;
}
```

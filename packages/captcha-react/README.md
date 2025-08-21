# SuperTokens Plugin Captcha

Add CAPTCHA verification to SuperTokens authentication flows.
This plugin integrates with **reCAPTCHA v2**, **reCAPTCHA v3**, and **Cloudflare Turnstile** to protect authentication endpoints from automated attacks.

## Installation

```bash
npm install @supertokens-plugins/captcha-react
```

## Quick Start

### Frontend Configuration

Initialize the plugin in your SuperTokens frontend configuration:

```typescript
import SuperTokens from "supertokens-auth-react";
import CaptchaPlugin from "@supertokens-plugins/captcha-react";

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

> [!IMPORTANT]  
> You also have to install and configure the backend plugin.

## Protected Flows

The plugin automatically protects these authentication flows:

| Recipe          | Authentication Flow        | Forms                                                                                  | Pre-API Hook Action         |
| --------------- | -------------------------- | -------------------------------------------------------------------------------------- | --------------------------- |
| `EmailPassword` | User sign in               | `EmailPasswordSignInForm`                                                              | `EMAIL_PASSWORD_SIGN_IN`    |
| `EmailPassword` | User registration          | `EmailPasswordSignUpForm`                                                              | `EMAIL_PASSWORD_SIGN_UP`    |
| `EmailPassword` | Password reset request     | `EmailPasswordResetPasswordEmail`                                                      | `SEND_RESET_PASSWORD_EMAIL` |
| `EmailPassword` | Password reset submission  | `EmailPasswordSubmitNewPassword`                                                       | `SUBMIT_NEW_PASSWORD`       |
| `Passwordless`  | Generate verification code | `PasswordlessEmailForm` and `PasswordlessPhoneForm` and `PasswordlessEmailOrPhoneForm` | `PASSWORDLESS_CREATE_CODE`  |
| `Passwordless`  | Verify code and sign in    | `PasswordlessUserInputForm`                                                            | `PASSWORDLESS_CONSUME_CODE` |

## Customization

### Conditional Validation

Create a custom component to control CAPTCHA rendering:

```typescript
import { forwardRef, useCallback, useEffect } from "react";
import {
  CaptchInputContainerProps,
  captchaStore,
  useCaptchaInputContainerId,
} from "@supertokens-plugins/captcha-react";

const CustomCaptchaContainer = forwardRef<HTMLDivElement, CaptchInputContainerProps>((props, ref) => {
  const { form, ...rest } = props;
  const { loadAndRender, containerId } = useCaptcha();

  useEffect(() => {
    // Captcha will apply/render only for the EmailPasswordSignUpForm
    // and the EmailPasswordSignInForm
    if (form === "EmailPasswordSignUpForm" || form === "EmailPasswordResetPasswordEmail") {
      loadAndRender();
    }
  }, [form]);

  return <div ref={ref} id={containerId} className="captcha-container" {...rest} />;
});
```

## Hooks and Utilities

### useCaptcha Hook

Monitor CAPTCHA state in your components:

```typescript
import { useCaptcha } from "@supertokens-plugins/captcha-react";

function MyComponent() {
  const captcha = useCaptcha();

  if (captcha.state === "loading") {
    return <div>Loading CAPTCHA...</div>;
  }

  if (captcha.state === "error") {
    return <div>Error: {captcha.error}</div>;
  }

  return <div>CAPTCHA ready</div>;
}
```

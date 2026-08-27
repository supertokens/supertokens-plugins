# App configuration

The Rownd migration plugin's `appConfig` controls the Rownd Hub's branding,
authentication UI, profile UI, legal links, and text overrides. Configure it on
the backend through `RowndMigrationPlugin.init`.

This document describes the camel-case plugin configuration. The plugin converts
these values to the Rownd-compatible configuration consumed by the Hub.

## Plugin initialization

The plugin requires the SuperTokens `Session`, `UserMetadata`, `AccountLinking`,
and `EmailVerification` recipes. Add `Passwordless` for email or phone sign-in
and `ThirdParty` for social providers, anonymous users, or custom OAuth sign-in.

```ts
import RowndMigrationPlugin, {
  type RowndAppConfigInput,
} from "@supertokens-plugins/rownd-nodejs";
import SuperTokens from "supertokens-node";
import AccountLinking from "supertokens-node/recipe/accountlinking";
import EmailVerification from "supertokens-node/recipe/emailverification";
import Passwordless from "supertokens-node/recipe/passwordless";
import Session from "supertokens-node/recipe/session";
import UserMetadata from "supertokens-node/recipe/usermetadata";

const appConfig = {
  id: process.env.ROWND_APP_ID!,
  name: "Example app",
  signInMethods: [{ method: "email" }],
  branding: {
    primaryColor: "#5b5bd6",
    darkMode: "auto",
  },
  profile: {
    personalInformation: { enabled: true },
    preferences: { enabled: true },
    signOutButton: { enabled: true },
    deleteAccountButton: { enabled: false },
  },
} satisfies RowndAppConfigInput;

SuperTokens.init({
  supertokens: {
    connectionURI: process.env.SUPERTOKENS_CONNECTION_URI!,
    apiKey: process.env.SUPERTOKENS_API_KEY,
  },
  appInfo: {
    appName: "Example app",
    apiDomain: "https://api.example.com",
    websiteDomain: "https://example.com",
    apiBasePath: "/auth",
    websiteBasePath: "/auth",
  },
  recipeList: [
    AccountLinking.init(),
    EmailVerification.init({ mode: "OPTIONAL" }),
    Passwordless.init({
      contactMethod: "EMAIL",
      flowType: "USER_INPUT_CODE_AND_MAGIC_LINK",
    }),
    Session.init(),
    UserMetadata.init(),
  ],
  experimental: {
    plugins: [
      RowndMigrationPlugin.init({
        rowndAppKey: process.env.ROWND_APP_KEY!,
        rowndAppSecret: process.env.ROWND_APP_SECRET!,
        appConfig,
      }),
    ],
  },
});
```

Use `satisfies RowndAppConfigInput` to validate the configuration and expose
field documentation in TypeScript editors.

## Top-level fields

### `id`

Type: `string`

Rownd app ID returned by the app-config endpoint. Defaults to an empty string.
This is separate from the plugin's `rowndAppKey` credential.

### `name`

Type: `string`

App display name used in Hub UI and as the fallback company name in legal copy.
Defaults to `appInfo.appName`.

### `icon`

Type: `string`

App icon URL used as the final fallback image in Hub UI. It does not replace the
document favicon. Defaults to an empty string.

### `userVerificationFields`

Type: `string[]`

Profile fields that can verify a user, commonly `email` and `phone_number`.

### `signInMethods`

Type: `RowndSignInMethod[]`

Sign-in methods exposed by the Hub. Omitted methods are disabled. See
[Sign-in methods](#sign-in-methods).

### `branding`

Type: `RowndBranding`

Visual Hub configuration. See [Branding](#branding).

### `legal`

Type: `RowndLegal`

Legal links and support contact information. See [Legal](#legal).

### `auth`

Type: `RowndAuthConfig`

Authentication flow and UI configuration. See [Authentication](#authentication).

### `profile`

Type: `RowndProfileConfig`

Profile UI visibility configuration. See [Profile](#profile).

### `customContent`

Type: `RowndCustomContent`

Text overrides for Hub screens. See [Custom content](#custom-content).

### Compatibility metadata

These fields preserve metadata used by existing Rownd integrations. They are not
general-purpose Hub customization APIs:

- `capabilities?: Record<string, unknown>`: native and web capability metadata.
- `web?: Record<string, unknown>`: browser application metadata.
- `bottomSheet?: Record<string, unknown>`: bottom-sheet metadata.
- `profileStorageVersion?: string`: profile storage version metadata.
- `allowedWebOrigins?: string[]`: allowed web-origin metadata.

## Sign-in methods

Every entry requires `method`.

### Email

```ts
signInMethods: [{ method: "email" }];
```

Enables email passwordless sign-in. The backend must initialize the SuperTokens
`Passwordless` recipe with an email-compatible contact method.

### Phone

```ts
signInMethods: [{ method: "phone" }];
```

Enables phone passwordless sign-in. The backend must initialize the SuperTokens
`Passwordless` recipe with a phone-compatible contact method.

### Apple

```ts
{
  method: 'apple',
  clientId: 'com.example.web',
  webClientType: 'web',
  iosClientType: 'ios',
  androidClientType: 'android',
}
```

- `clientId?: string`: Apple Services ID used by the Hub.
- `webClientType?: string`: SuperTokens provider client type for browser flows.
- `iosClientType?: string`: provider client type for native iOS flows.
- `androidClientType?: string`: provider client type for native Android flows.

The backend must initialize the SuperTokens `ThirdParty` recipe with matching
provider clients.

### Google

```ts
{
  method: 'google',
  clientId: 'web-client-id',
  iosClientId: 'ios-client-id',
  scopes: ['openid', 'email', 'profile'],
  signInFasterWithGoogle: 'enabled',
  oneTap: {
    browser: { autoPrompt: false, delay: 7000 },
    mobileApp: { autoPrompt: false, delay: 7000 },
  },
}
```

- `clientId?: string`: Google web client ID.
- `iosClientId?: string`: Google iOS client ID.
- `scopes?: string[]`: additional OAuth scopes; defaults to `[]`.
- `signInFasterWithGoogle?: "enabled" | "disabled"`: emitted as compatibility
  data but not currently consumed by the Hub.
- `oneTap.browser.autoPrompt?: boolean`: defaults to `false`.
- `oneTap.browser.delay?: number`: milliseconds; defaults to `7000`.
- `oneTap.mobileApp.autoPrompt?: boolean`: retained as compatibility data but not
  currently read by the Hub. Defaults to `false`.
- `oneTap.mobileApp.delay?: number`: retained as compatibility data but not
  currently read by the Hub. Defaults to `7000` milliseconds.

The backend must initialize the SuperTokens `ThirdParty` recipe with matching
provider clients.

### Anonymous or guest

```ts
{
  method: 'anonymous',
  type: 'guest',
  displayName: 'Continue as a guest',
  iconLightUrl: 'https://example.com/guest-light.svg',
  iconDarkUrl: 'https://example.com/guest-dark.svg',
}
```

- `type?: "guest" | "instant"`: defaults to `"guest"`. `"instant"` creates an
  instant-user flow rather than displaying a guest button.
- `displayName?: string`: defaults to `"Continue as a guest"`.
- `iconLightUrl?: string`: light-mode button icon.
- `iconDarkUrl?: string`: dark-mode icon; falls back to `iconLightUrl`.

### Custom OAuth provider

```ts
{
  method: 'oauth2_github',
  displayName: 'Continue with GitHub',
  iconLightUrl: 'https://example.com/github.svg',
  iconDarkUrl: 'https://example.com/github-dark.svg',
}
```

Prefix the provider key configured in the SuperTokens `ThirdParty` recipe with
`oauth2_`. The current app-config mapping supports `displayName`,
`iconLightUrl`, and `iconDarkUrl`; additional typed properties are not emitted.

## Branding

```ts
branding: {
  primaryColor: '#5b5bd6',
  primaryColorDarkMode: '#c8aaff',
  logo: 'https://example.com/logo.svg',
  logoDarkMode: 'https://example.com/logo-dark.svg',
  roundedCorners: true,
  containerBorderRadius: 12,
  placement: 'bottom-left',
  hubPrimaryColor: '#5b5bd6',
  backgroundColor: '#ffffff', // Compatibility field; currently not applied.
  fontFamily: 'Inter, sans-serif', // Compatibility field; currently not applied.
  hideVerificationIcons: false,
  visualSwoops: true,
  blurBackground: true,
  blurBackgroundOpacity: 0.5,
  offsetX: 16,
  offsetY: 16,
  darkMode: 'auto',
  showAppIcon: false,
}
```

- `primaryColor?: string`: light-mode primary color. Defaults to `#5b5bd6`.
- `primaryColorDarkMode?: string`: dark-mode primary color. Defaults to
  `#c8aaff`.
- `logo?: string`: light-mode logo URL. Falls back to `icon`.
- `logoDarkMode?: string`: dark-mode logo URL. The current Hub falls back
  directly to `icon` when this is omitted.
- `animations?: { loading?: string }`: loading-animation override. Other keys
  are not currently consumed by the Hub.
- `roundedCorners?: boolean`: defaults to `true`.
- `containerBorderRadius?: number`: radius in pixels; the Hub caps it at 30px.
- `placement?: string`: launcher placement such as `bottom-left` or `hidden`.
  Defaults to `bottom-left`.
- `hubPrimaryColor?: string`: Hub-specific primary color override. Defaults to
  `primaryColor`.
- `backgroundColor?: string`: compatibility metadata emitted by the plugin but
  not currently applied by the Hub.
- `fontFamily?: string`: compatibility metadata emitted by the plugin but not
  currently applied by the Hub.
- `hideVerificationIcons?: boolean`: defaults to `false`.
- `visualSwoops?: boolean`: defaults to `true`.
- `blurBackground?: boolean`: defaults to `true`.
- `blurBackgroundOpacity?: number`: backdrop blur radius in pixels. Despite the
  compatibility field name, this value does not control opacity.
- `offsetX?: number`: horizontal launcher offset in pixels.
- `offsetY?: number`: vertical launcher offset in pixels.
- `propertyOverrides?: Record<string, string>`: low-level CSS variable and
  property overrides consumed by the Hub. Values must be strings despite the
  plugin's broader JSON type.
- `darkMode?: "auto" | "light" | "dark"`: defaults to `"auto"`. The plugin
  type and Hub currently disagree on forced-mode values: `"auto"` works, but
  typed `"dark"` does not force dark mode. Avoid forced-mode configuration until
  the contracts are aligned.
- `showAppIcon?: boolean`: shows the logo in sign-in and profile modals.
  Defaults to `false`.
- `customStyles?: { content: string }[]`: raw CSS injected into the Hub.
- `customScripts?: { type?: string; content: string }[]`: raw scripts injected
  into the Hub.

Treat `customStyles`, `customScripts`, and `propertyOverrides` as advanced
escape hatches. They depend on Hub implementation details and can require updates
when the UI changes. Only load trusted content.

### Accessible text-button colors

Filled buttons use the primary color as their background, while text buttons use
it as their text color. A light primary color can therefore pass contrast checks
on filled buttons but fail on text buttons. Override a specific control instead
of changing the global primary color:

```ts
branding: {
  primaryColor: '#f4c542',
  customStyles: [
    {
      content: `
        .rph-login__button-different-method.rph-button-text {
          color: #6b5100 !important;
        }
      `,
    },
  ],
}
```

Validate custom foreground and background combinations against WCAG contrast
requirements in both light and dark modes.

## Legal

```ts
legal: {
  companyName: 'Example, Inc.',
  privacyPolicyUrl: 'https://example.com/privacy',
  termsConditionsUrl: 'https://example.com/terms',
  supportEmail: 'support@example.com',
}
```

- `companyName?: string`: company name shown in legal copy. Defaults to `name`.
- `privacyPolicyUrl?: string`: privacy policy URL. Defaults to an empty string.
- `termsConditionsUrl?: string`: terms URL. Defaults to an empty string.
- `supportEmail?: string`: address used in support links. Set it explicitly;
  some views fall back to `support@rownd.io`, while the no-account contact link
  currently has no fallback.

## Authentication

```ts
auth: {
  rememberSignInMethod: true,
  useExplicitSignUpFlow: false,
  allowUnverifiedUsers: false,
  primarySignUpMethod: 'email',
  preferredMethod: 'email',
}
```

- `rememberSignInMethod?: boolean`: preselects a user's previous method. Defaults
  to `true`.
- `useExplicitSignUpFlow?: boolean`: separates sign-in and sign-up intent flows.
  Defaults to `false`. When enabled, the plugin's Passwordless create-code and
  consume-code HTTP overrides require `intent: "sign_in" | "sign_up"`; missing
  or invalid intent returns `GENERAL_ERROR`. `sign_in` accepts only the tenant's
  canonical email, so a retired email returns `SIGN_IN_UP_NOT_ALLOWED` with
  reason `No existing account found` before a code is sent. `sign_up` may reuse
  the email after cleanup succeeds. Direct Passwordless SDK calls bypass these
  HTTP overrides.
- `allowUnverifiedUsers?: boolean`: allows users to close the passwordless
  waiting or verification UI. It does not alter backend verification or session
  policy. Defaults to `false`.
- `primarySignUpMethod?: string`: method used first for explicit sign-up.
- `preferredMethod?: string`: preferred identifier input when no explicit order
  is configured.

### Authentication order

`order` controls method ordering by platform:

```ts
auth: {
  order: {
    default: [
      { type: 'input', name: 'email' },
      { type: 'button', name: 'google' },
    ],
    ios: [
      { type: 'button', name: 'apple' },
      { type: 'input', name: 'email' },
    ],
    android: [
      { type: 'button', name: 'google' },
      { type: 'input', name: 'email', hidden: true },
    ],
  },
}
```

Each item accepts:

- `type: "button" | "input"`: how the method is rendered.
- `name: string`: sign-in method key.
- `hidden?: boolean`: hides the method from the initial sign-up view while
  allowing sign-in flows to display it. Defaults to `false`.

`ios` and `android` fall back to `default` when omitted.

### Additional fields

`additionalFields` collects extra values during sign-in or sign-up:

```ts
auth: {
  additionalFields: [
    {
      name: 'department',
      type: 'select',
      label: 'Department',
      placeholder: 'Select a department',
      options: [
        { value: 'engineering', label: 'Engineering' },
        { value: 'sales', label: 'Sales' },
      ],
    },
  ],
}
```

Each field accepts `name`, `type`, `label`, an optional `placeholder`, and
`options`. For option-based fields, the first option is the default when no value
is provided.

### Verification email

```ts
auth: {
  email: {
    fromAddress: 'no-reply@example.com',
    image: 'https://example.com/email-logo.png',
    subject: 'Verify your email',
    callToActionText: 'Verify email',
    verifyTemplate: '...',
    customContent: '...',
    customClosingContent: '...',
  },
}
```

These fields are present in the compatibility type and generated app config, but
the current plugin and Hub do not apply them. Configure email content through the
relevant SuperTokens recipe's `emailDelivery` option. These fields do not
customize the verification screen displayed by the Hub.

### Mobile magic-link screen

```ts
auth: {
  mobile: {
    title: 'Open Example app',
    image: 'https://example.com/app-icon.png',
    callToActionText: 'Open app',
    hyperlinkText: 'Continue in browser',
    hyperlinkRedirectUrl: 'https://example.com',
    customContent: '...',
  },
}
```

These fields are present in the compatibility type and generated app config, but
the current Hub does not consume them.

## Profile

```ts
profile: {
  accountInformation: {
    methods: {
      email: { enabled: true },
      phone_number: { enabled: false },
      google_id: { enabled: true },
    },
  },
  personalInformation: { enabled: true },
  preferences: { enabled: true },
  signOutButton: { enabled: true },
  deleteAccountButton: { enabled: false },
  addSignInMethodsButton: { enabled: true },
}
```

- `accountInformation.methods`: visibility by profile schema field key, such as
  `email`, `phone_number`, `google_id`, or `apple_id`. Keys default to enabled.
- `personalInformation.enabled`: shows the personal-information section.
  Defaults to `true`.
- `preferences.enabled`: shows the preferences and support section. Defaults to
  `true`.
- `signOutButton.enabled`: shows the built-in sign-out button. Defaults to
  `true`.
- `deleteAccountButton.enabled`: shows account deletion inside Preferences.
  Defaults to `false`.
- `addSignInMethodsButton.enabled`: shows the action for adding sign-in methods.
  Defaults to `true`.

The built-in delete-account action is rendered inside Preferences. Setting
`preferences.enabled` to `false` hides that entry point even when
`deleteAccountButton.enabled` is `true`. Use a custom deletion entry point if the
application must hide Preferences while retaining self-service deletion.

Visibility options only control the built-in UI. They do not disable the
corresponding SDK or backend operations.

## Custom content

Custom-content values are plain text unless stated otherwise. The Hub escapes
HTML in these strings and does not render Markdown.

### Sign-in modal

```ts
customContent: {
  signInModal: {
    title: 'Welcome',
    subtitle: 'Sign in to continue',
    signInTitle: 'Welcome back',
    signUpTitle: 'Create an account',
    signInSubtitle: 'Sign in to your account',
    signUpSubtitle: 'Create your account to continue',
    signInButton: 'Sign in',
    signUpButton: 'Sign up',
  },
}
```

The request that opens sign-in can override the main title.

### Profile modal

```ts
customContent: {
  profileModal: {
    title: 'Your profile',
  },
}
```

### Verification modal

```ts
customContent: {
  verificationModal: {
    title: 'Verify your email <strong><u>on this device</u></strong> to finish',
    subtitle:
      'Please click the link in the message we just sent to <strong>{{userIdentifier}}</strong> to verify and finish.',
  },
}
```

`title` replaces the passwordless magic-link waiting heading. It does not change
the separate email-verification callback page. `subtitle` replaces the message
below that heading. The built-in content remains in use when either field is
omitted.

These two fields support the attribute-free inline tags `<strong>`, `<em>`, and
`<u>`. They can be nested. Other HTML, Markdown, tag attributes, and malformed
markup are displayed literally rather than interpreted. The Hub never executes
markup from these fields.

Use `{{identifier}}` for the localized identifier type (`email` or `phone
number`) and `{{userIdentifier}}` for the submitted email address or phone
number. Interpolated values are always rendered as text.

### Sign-in failure modal

```ts
customContent: {
  signInFailureModal: {
    failureMessage: 'We could not sign you in. Please try again.',
  },
}
```

### No-account modal

```ts
customContent: {
  noAccountMessage: {
    title: 'No account was found',
  },
}
```

### Mobile custom content

`customContent.mobile?: Record<string, unknown>` preserves raw Rownd mobile
custom-content configuration. Prefer documented native SDK options for new
integrations.

## Sub-brands

Pass sub-brand configurations alongside `appConfig` in the plugin configuration:

```ts
RowndMigrationPlugin.init({
  rowndAppKey: process.env.ROWND_APP_KEY!,
  rowndAppSecret: process.env.ROWND_APP_SECRET!,
  appConfig,
  subBrands: {
    enterprise: {
      ...appConfig,
      name: "Example Enterprise",
      branding: {
        primaryColor: "#17324d",
      },
      variant: {
        id: "enterprise",
        name: "Enterprise",
      },
    },
  },
});
```

Each sub-brand accepts the same app-config fields plus a required `variant.id`,
an optional `variant.name`, and optional raw `variant.config` compatibility data.

## Related plugin configuration

These `RowndMigrationPlugin.init` options are related to the Hub but live outside
`appConfig`:

- `schema`: defines user profile fields and their visibility.
- `clientDomains`: maps browser, mobile, and custom client names to link origins.
- `crossDeviceConfirmationBypass`: allows selected server-created magic links to
  bypass cross-device confirmation after frontend validation.
- `enableDebugLogs`: enables plugin debug logging.
- `disableRowndUserMigration`: keeps compatibility endpoints active after Rownd
  migration is disabled.
- `telemetry`: configures optional migration telemetry.

See the `@supertokens-plugins/rownd-nodejs` package README for endpoint and
migration details.

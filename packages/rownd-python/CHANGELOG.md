# @supertokens-plugins/rownd-python

## 0.1.7

### Patch Changes

- Fix migration and email verification

## 0.1.7

### Patch Changes

- Secure email changes, support third-party and phone-only accounts, and fix Rownd identity reconciliation
- Require `context.rowndNativeEmailVerification: true` for mobile email changes; unsupported clients receive HTTP 426
- Require custom verification delivery to preserve `token` and `rowndPendingVerificationId`

## 0.1.6

### Patch Changes

- Enforce limitations on cross device sign in

## 0.1.5

### Patch Changes

- Fix default account linking setup

## 0.1.4

### Patch Changes

- Include appVariantId in the session payload

## 0.1.3

### Patch Changes

- Handle tenant id and add OTP overrides

## 0.1.2

### Patch Changes

- Fix the OAuth flow for passwordless and handle users without email address

## 0.1.1

### Patch Changes

- Fix readme instructions

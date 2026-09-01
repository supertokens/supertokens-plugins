# @supertokens-plugins/rownd-python

## 0.2.0

### Minor Changes

- Fix migrate race conditions and port rownd-nodejs changes
- a9af441: Add an opt-in email credential retirement mode so operators can prevent authentication through previously replaced Passwordless email aliases while durable email-change completion remains unavailable without Core metadata compare-and-swap. Guard mode disables email-change start and completion, so pending changes must be drained and all workers upgraded before rollout. Direct SuperTokens SDK calls outside plugin-owned APIs remain out of scope.

### Patch Changes

- a5150ef: Report the current package version in plugin metadata

## Unreleased

### Patch Changes

- Recover simultaneous E006 passwordless email import races
- Ignore custom claims that conflict with JWT, SuperTokens, Rownd, or authoritative OAuth claims
- Reject malformed custom session claim names with their schema field path

## 0.1.13

### Patch Changes

- Pass context to prevent extra core calls

## 0.1.12

### Patch Changes

- Handle concurrent Rownd migrations

## 0.1.11

### Patch Changes

- Match email verification check against the node plugin
- Prevent concurrent migrations from misidentifying externalized user IDs or rolling back shared reconciliation state

## 0.1.10

### Patch Changes

- Fix account linking during migrate

## 0.1.9

### Patch Changes

- Fix fetch rownd user
- Preserve previous Passwordless emails as tenant-scoped login aliases and report pending email verification
- Refresh Rownd session claims after automatic linking during Passwordless and third-party sign-in
- Resolve compatibility metadata across linked identities and apply profile writes to the primary user

## 0.1.8

### Patch Changes

- Fix rownd token validation

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

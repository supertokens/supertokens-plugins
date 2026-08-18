# @supertokens-plugins/rownd-nodejs

## 0.6.10

### Patch Changes

- Safely resolve linked user metadata

## 0.6.9

### Patch Changes

- Use primary user id in metadata updates

## 0.6.8

### Patch Changes

- Fix email update flows

## 0.6.7

### Patch Changes

- Support email changes for thirdparty users and fix the import flow

## 0.6.6

### Patch Changes

- Preserve previous Passwordless emails as linked login methods and report pending email verification

## 0.6.5

### Patch Changes

- Add option to enforce passwordless sign in on the same device

## 0.6.4

### Patch Changes

- Fix default account linking

## 0.6.3

### Patch Changes

- Add appVariantId in the session payload

## 0.6.2

### Patch Changes

- Add overrides for the otp flow

## 0.6.1

### Patch Changes

- Add the ability to disable the migration endpoint

## 0.6.0

### Minor Changes

- Support migrating, importing, and creating Rownd users in non-public SuperTokens tenants.

## 0.5.1

### Patch Changes

- Handle apple/google users that do not have an email address

## 0.5.0

### Minor Changes

- 5c39e4b: Adds compatibility endpoints to match the functionality of the Rownd api
- Add a client domains config option to account for mobile deep linking and local dev

## 0.3.0

### Patch Changes

- Add functionality to bypass magic link cross device confirmation
- Fix instant user conversion so that it does not depend on the in-built email verification process
- Fix instant user compat
- Fix the user migration endpoint
- Fix anonymous login
- Skip running migration if the Rownd user does not exist

## 0.3.0

### Minor Changes

- 5c39e4b: Adds compatibility endpoints to match the functionality of the Rownd api

## 0.3.0-beta.0

### Minor Changes

- 5c39e4b: Adds compatibility endpoints to match the functionality of the Rownd api

## 0.2.1

### Patch Changes

- Re-build

## 0.2.0

### Minor Changes

- 3e9754a: feat: add rownd user migration plugin

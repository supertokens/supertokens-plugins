# @supertokens-plugins/rownd-nodejs

## 1.0.0

### Major Changes

- Validate Rownd sessions against a SuperTokens hosted keyset

## 0.7.13

### Patch Changes

- Allow explicit sign in from unverified accounts

## 0.7.12

### Patch Changes

- Reduce the number of requests during the migration call

## 0.7.11

### Patch Changes

- Allow explicit sign in for unverified accounts

## 0.7.10

### Patch Changes

- Refactor the reconciliation process

## Unreleased

- Retry transient Apple signing-key fetch failures during `/auth/signinup` with bounded backoff, without repeating the OAuth code exchange.
- Repair eligible missing credentials, token-authorized email verification, and added or replaced provider identities on repeat `/migrate` calls. Native canonical emails and pending contact changes remain authoritative.
- Accept exactly empty optional email, phone, Google, and Apple fields as absent; validate authenticated profiles before migration writes.
- Reuse ID discovery snapshots for provider checkpoints, deduplicate reads, and parallelize independent historical checks while preserving revocation recovery.

## 0.7.9

### Patch Changes

- Fix how the passwordless email is resolved

## 0.7.8

### Patch Changes

- Fix import reconciliation

## 0.7.7

### Patch Changes

- Fix reconciliation for phone login

## 0.7.6

### Patch Changes

- Reconcile users during migration

## 0.7.5

### Patch Changes

- Extend migration telemetry

## 0.7.4

### Patch Changes

- Add option to bypass email verification

## 0.7.3

### Patch Changes

- 0f866c9: Recover when simultaneous lazy migrations race to import the same new Rownd user.
- Allow more permissive account linking

## 0.7.2

### Patch Changes

- Take into account intent in the login flow and fix email updates

## 0.7.1

### Patch Changes

- Recover from incomplete email update flows

## 0.7.0

### Minor Changes

- 7806fb9: Support tenant-scoped dynamic Rownd configuration.

### Patch Changes

- Support tenant specific config

## 0.6.14

### Patch Changes

- Fix Passwordless email replacement and explicit sign-in
- fea92a7: Replace confirmed Passwordless email methods tenant-safely and enforce explicit Passwordless sign-in intent.

## 0.6.13

### Patch Changes

- Pass context to prevent extra core requests

## 0.6.12

### Patch Changes

- Handle concurrent Rownd migrations

## 0.6.11

### Patch Changes

- Fix account linking during migration
- Link verified Rownd email methods to existing third-party users during migration
- Prevent concurrent migrations from misidentifying externalized user IDs or rolling back shared reconciliation state

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

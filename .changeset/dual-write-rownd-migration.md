---
"@supertokens-plugins/rownd-nodejs": minor
---

Allow Rownd user and session migration in `metadataMode: "dual-write"`. After each credentialed migration request or `reconcileUser` call that may change an owner, the plugin republishes the owner's compatibility presentation to its SDK-visible user ID. It skips owners the offline canonical copy would refuse and logs the reason. A skipped or failed republish never fails the migration. Canonical mode still requires migration to be disabled. Compatibility mode is unchanged.

---
"@supertokens-plugins/rownd-nodejs": minor
---

Add an opt-in `metadataMode: "canonical"` for deployments whose metadata has been consolidated at the SDK-visible user ID. Presentation reads use that single address instead of discovering mappings and merging aliases; compatibility remains the default and is unchanged.

Canonical mode requires Rownd user migration to be disabled, reserves `rownd_profile_authority:*` and `rownd_app_variants` metadata keys, and disables automatic account linking. Reverting to compatibility requires resynchronizing legacy metadata.

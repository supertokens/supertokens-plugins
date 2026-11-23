---
"@supertokens-plugins/rownd-nodejs": minor
---

Add opt-in `metadataMode: "dual-write"` to prepare for canonical metadata. Reads stay in compatibility mode, and presentation writes are mirrored to the SDK-visible user ID. Drain writers and verify parity before switching to canonical. Dual-write requires Rownd user migration to be disabled and rejects writes to internal or canonical-reserved fields and null identity values. Compatibility remains the default and is unchanged.

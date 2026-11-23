---
"@supertokens-plugins/rownd-nodejs": minor
---

Add an opt-in `metadataMode: "dual-write"` that allows moving to canonical metadata without a drift window. Reads stay identical to compatibility mode. Presentation-affecting plugin writes are also applied to the SDK-visible user ID, in the shape that canonical mode reads, so published owners stay equal until the switch. Like canonical mode, dual-write requires Rownd user migration to be disabled and rejects writes to internal or canonical-reserved fields. Compatibility remains the default and is unchanged.

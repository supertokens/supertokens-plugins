---
"@supertokens-plugins/squadup-nodejs": patch
---

Pass through SquadUp event and ticket metadata without enforcing field schemas or converting IDs. Retain only structural checks required to traverse attendees and tickets, plus QR/PDF visibility filtering. This fixes successful SquadUp lookups incorrectly returning 502 for numeric IDs, missing metadata, or changing upstream field types. Response types now represent arbitrary JSON metadata.

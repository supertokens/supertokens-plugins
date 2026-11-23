---
"@supertokens-plugins/rownd-nodejs": patch
---

Avoid metadata writes for empty or activity-only public metadata patches, duplicate profile reads after non-email updates, and unused compatibility metadata reads for OAuth userinfo scopes.

Empty/activity-only metadata patches no longer invoke metadata-write overrides. OAuth userinfo without exact `email`, `phone`, or `profile` scopes no longer invokes unused metadata-read overrides.
